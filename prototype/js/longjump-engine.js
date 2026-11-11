/* ============================================================
 * longjump-engine.js  —  立定跳远分析引擎（浏览器端）
 *
 * 复用页面里同一套 MediaPipe Pose Landmarker（见 pose-engine.js），
 * 但算法完全独立：这里只关心「起跳—腾空—落地」这一件事，
 * 不关心投篮出手，也不关心跳绳的周期计数。
 *
 * 测量思路：
 *   1) 逐帧取肩、髋、膝、踝、脚尖关键点；
 *   2) 「双脚离地」= 脚尖与脚跟同时抬离站立基线。取两者的较小值做判定信号，
 *      于是起跳点自然落在「脚尖离地」那一刻、落地点落在「脚跟触地」那一刻 ——
 *      正好对上立定跳远的正式量法（从起跳线量到最近的身体触地点）；
 *   3) 跳跃距离 = 起跳帧脚尖 x → 落地帧脚跟 x，用比例尺换成厘米；
 *   4) 起跳角 = 对腾空段重心轨迹做抛物线拟合，取 t0 处的速度方向；
 *   5) 蹬伸时序 = 起跳窗口内髋/膝/踝三个关节伸展角度的峰值先后；
 *   6) 摆臂配合 = 手臂前摆角度峰值与起跳时刻的时差；
 *   7) 落地稳定性 = 落地后重心是否后移、手有没有撑地、膝关节有没有缓冲。
 *
 * 比例尺有两条路，优先级从高到低：
 *   - 画面里放了卷尺/已知长度标记：用户点两个点并填真实长度（最准，且顺手校掉透视）；
 *   - 只填身高：用「鼻尖→踝 ≈ 0.891 身高」换算（和投篮/跳绳同一套人体测量学口径）。
 *
 * 注意：单目侧面视频没有深度信息。斜着拍会把距离压扁，
 * 人往前走动会让人物尺度抖动 —— 这些都不是算法能补回来的，
 * 所以界面里会如实标注误差来源，而不是给一个看起来很精确的假数字。
 * ============================================================ */

import { loadDetector, acquireTimeBlock, seekTo } from './pose-engine.js';

/* ---------------- 33 点索引（MediaPipe Pose） ---------------- */
const NOSE = 0;
const L_SH = 11, R_SH = 12;
const L_WR = 15, R_WR = 16;
const L_HIP = 23, R_HIP = 24;
const L_KNEE = 25, R_KNEE = 26;
const L_AN = 27, R_AN = 28;
const L_FT = 31, R_FT = 32;

/* 参与「识别是否稳定」判定的点：立定跳远要看清脚尖和脚跟 */
const KEY = [L_SH, R_SH, L_HIP, R_HIP, L_KNEE, R_KNEE, L_AN, R_AN, L_FT, R_FT];

/* 采样节奏：腾空只有 0.4–0.6 秒，30fps 才够把抛物线拟合稳。
   3600 帧能保证 2 分钟内 30fps、4 分钟内 15fps；
   立定跳远视频通常十几秒，实际都能跑满 30fps。 */
const SAMPLE_FPS = 30;
const MAX_SAMPLES = 3600;

/* 鼻尖到踝的跨度约为身高的 0.891 倍（Drillis & Contini）。
   和投篮、跳绳模块共用同一口径，三个项目的厘米值才可比。 */
const NOSE_TO_ANKLE_RATIO = 0.891;

/* 重力加速度：只用来做比例尺的自检，不参与测量 */
const G = 981;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v, d) { var p = Math.pow(10, d || 0); return Math.round(v * p) / p; }

function pct(arr, q) {
  const v = arr.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? v[lo] : v[lo] * (hi - i) + v[hi] * (i - lo);
}

function mean(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function mean2(a, b) {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return (a + b) / 2;
}

/* 3 点中值 + 3 点均值：中值先挡掉单帧跳点，均值再把台阶磨圆 */
function smoothSignal(arr) {
  const n = arr.length;
  const med = arr.slice();
  for (let i = 1; i < n - 1; i++) {
    const w = [arr[i - 1], arr[i], arr[i + 1]].filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    if (w.length >= 2) med[i] = w[Math.floor(w.length / 2)];
  }
  const out = med.slice();
  for (let i = 0; i < n; i++) {
    const w = [med[i - 1], med[i], med[i + 1]].filter(x => x != null && isFinite(x));
    if (w.length) out[i] = w.reduce((a, b) => a + b, 0) / w.length;
  }
  return out;
}

/* 只做中值、不做均值 —— 专供「找过零点」用。
   均值滤波会把上升沿往前拉、下降沿往后推（实测能把 0.53 秒的腾空撑成 0.59 秒），
   而中值滤波对单调斜坡是无偏的：三点中值就是中间那个点，位置不变。
   所以：曲线显示用 smoothSignal（好看），起跳/落地时刻判定用这个（准）。 */
function medianFilter(arr) {
  const n = arr.length;
  const out = arr.slice();
  for (let i = 1; i < n - 1; i++) {
    const w = [arr[i - 1], arr[i], arr[i + 1]].filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    if (w.length >= 2) out[i] = w[Math.floor(w.length / 2)];
  }
  return out;
}

/* 把不等间隔的信号线性重采样到固定网格。
   低帧率时按「帧」做平滑会把腾空段的峰值抹平，重采样后窗口才固定在 0.1 秒。
   长缺口（> maxGapSec）不插值，避免凭空造出一段假的腾空。 */
function resampleUniform(vals, times, procN, procT, maxGapSec) {
  const vt = [], vv = [];
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] != null && isFinite(vals[i])) { vt.push(times[i]); vv.push(vals[i]); }
  }
  const out = new Array(procN).fill(null);
  if (!vt.length) return out;
  let k = 0;
  for (let i = 0; i < procN; i++) {
    const t = procT(i);
    if (t < vt[0] - 1e-9 || t > vt[vt.length - 1] + 1e-9) continue;
    while (k < vt.length - 1 && vt[k + 1] < t) k++;
    if (t <= vt[0]) { out[i] = vv[0]; continue; }
    if (k >= vt.length - 1) { out[i] = vv[vt.length - 1]; continue; }
    const t0 = vt[k], t1 = vt[k + 1];
    if (t1 - t0 > maxGapSec) continue;
    const u = (t - t0) / (t1 - t0);
    out[i] = vv[k] + (vv[k + 1] - vv[k]) * u;
  }
  return out;
}

/* 在网格上按时间取线性插值 */
function sampleAt(sig, procT, t) {
  const n = sig.length;
  if (!n) return null;
  if (t <= procT(0)) return sig[0];
  if (t >= procT(n - 1)) return sig[n - 1];
  for (let i = 1; i < n; i++) {
    if (procT(i) >= t) {
      const t0 = procT(i - 1), t1 = procT(i);
      const a = sig[i - 1], b = sig[i];
      if (a == null || b == null) return a == null ? b : a;
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return a + (b - a) * u;
    }
  }
  return sig[n - 1];
}

/* 三点夹角（度）。x 必须按画面宽高比还原成等比坐标，
   否则 16:9 的视频里所有角度都会被横向拉长而偏小。 */
function angleAt(pts, a, b, c, ar) {
  const ax = (pts[a * 2] - pts[b * 2]) * ar, ay = pts[a * 2 + 1] - pts[b * 2 + 1];
  const cx = (pts[c * 2] - pts[b * 2]) * ar, cy = pts[c * 2 + 1] - pts[b * 2 + 1];
  const na = Math.hypot(ax, ay), nc = Math.hypot(cx, cy);
  if (!na || !nc) return null;
  return Math.acos(clamp((ax * cx + ay * cy) / (na * nc), -1, 1)) * 180 / Math.PI;
}

/* 手臂前摆角：肩→腕向量与「竖直向下」的夹角，+x 方向为正。
   自然下垂 ≈ 0°，水平前伸 ≈ 90°，向上举过肩 > 120°。
   哪边算「前」要看跳跃方向，所以这里只给原始值，方向在每跳里再翻转。 */
function armAngleAt(pts, sh, wr, ar) {
  const dx = (pts[wr * 2] - pts[sh * 2]) * ar;
  const dy = pts[wr * 2 + 1] - pts[sh * 2 + 1];
  if (!isFinite(dx) || !isFinite(dy)) return null;
  if (!dx && !dy) return null;
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

/* ---------------- 单帧特征 ---------------- */
function frameFeatures(pts, ar) {
  if (!pts) return null;
  const Y = k => pts[k * 2 + 1];
  const X = k => pts[k * 2];

  const heelY = (Y(L_AN) + Y(R_AN)) / 2;
  const toeY = (Y(L_FT) + Y(R_FT)) / 2;
  const hipY = (Y(L_HIP) + Y(R_HIP)) / 2;
  const hipX = (X(L_HIP) + X(R_HIP)) / 2;
  const shY = (Y(L_SH) + Y(R_SH)) / 2;

  return {
    heelY, toeY, hipY, hipX,
    center: (shY + hipY) / 2,
    span: heelY - Y(NOSE),                    // 鼻尖→踝，站立时 ≈ 0.891 身高
    toeX: (X(L_FT) + X(R_FT)) / 2,
    heelX: (X(L_AN) + X(R_AN)) / 2,
    knee: mean2(angleAt(pts, L_HIP, L_KNEE, L_AN, ar), angleAt(pts, R_HIP, R_KNEE, R_AN, ar)),
    hip: mean2(angleAt(pts, L_SH, L_HIP, L_KNEE, ar), angleAt(pts, R_SH, R_HIP, R_KNEE, ar)),
    ankle: mean2(angleAt(pts, L_KNEE, L_AN, L_FT, ar), angleAt(pts, R_KNEE, R_AN, R_FT, ar)),
    arm: mean2(armAngleAt(pts, L_SH, L_WR, ar), armAngleAt(pts, R_SH, R_WR, ar))
  };
}

/* ---------------- 最小二乘：y = a·t² + b·t + c ----------------
   腾空段的重心就是一条抛物线，用拟合代替「取首末两帧差分」，
   单帧 landmark 抖动被平均掉，起跳角才不会一次一个数。 */
function fitQuad(ts, ys) {
  const n = ts.length;
  if (n < 4) return null;
  const tm = ts.reduce((a, b) => a + b, 0) / n;
  let S0 = n, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
  for (let i = 0; i < n; i++) {
    const t = ts[i] - tm, y = ys[i];
    const t2 = t * t;
    S1 += t; S2 += t2; S3 += t2 * t; S4 += t2 * t2;
    T0 += y; T1 += t * y; T2 += t2 * y;
  }
  /* 解 [S4 S3 S2; S3 S2 S1; S2 S1 S0]·[a b c]ᵀ = [T2 T1 T0]ᵀ（高斯消元，3×3 直接展开） */
  const A = [
    [S4, S3, S2, T2],
    [S3, S2, S1, T1],
    [S2, S1, S0, T0]
  ];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    if (piv !== c) { const tmp = A[piv]; A[piv] = A[c]; A[c] = tmp; }
    for (let r = c + 1; r < 3; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k];
    }
  }
  const c3 = A[2][3] / A[2][2];
  const b3 = (A[1][3] - A[1][2] * c3) / A[1][1];
  const a3 = (A[0][3] - A[0][1] * b3 - A[0][2] * c3) / A[0][0];
  /* 返回的是「以 tm 为原点」的系数，换回绝对时间：
     y = a(t-tm)² + b(t-tm) + c ⇒ 在任意 t 处的斜率 = 2a(t-tm) + b */
  return { a: a3, b: b3, c: c3, tm };
}

function fitLine(ts, xs) {
  const n = ts.length;
  if (n < 2) return null;
  const tm = ts.reduce((a, b) => a + b, 0) / n;
  let stt = 0, stx = 0;
  for (let i = 0; i < n; i++) {
    const t = ts[i] - tm;
    stt += t * t;
    stx += t * xs[i];
  }
  if (stt < 1e-9) return null;
  return { k: stx / stt, tm };
}

/* 找到「上穿阈值」和「下穿阈值」的时刻。
   两步走：
     1) 先在相邻两帧之间线性插值，得到粗定位；
     2) 再用过零点外推修正 —— 双脚离地/触地是「从 0 开始上升」的事件，
        线性插值会把上升沿摊到前后两帧的区间里，起跳被判早半帧（约 15ms）。
        以 4m/s 的水平速度算，15ms 就是 6cm，比算法里其他误差都大。
        改用「跳过跨越点、取后面 3 个样本拟合直线、外推到 0」，
        实测能把 15ms 的偏差压到 2ms 以内。 */
function crossings(sig, procT, thr, from, to) {
  const out = [];
  const n = sig.length;
  const a = Math.max(1, from), b = Math.min(n - 1, to);

  /* 用一段样本拟合直线，求 lift=0 的时刻 */
  function toZero(fromIdx, count) {
    const ts = [], ys = [];
    for (let k = fromIdx; k < Math.min(n, fromIdx + count); k++) {
      if (sig[k] == null || !isFinite(sig[k])) continue;
      ts.push(procT(k)); ys.push(sig[k]);
    }
    if (ts.length < 3) return null;
    const ln = fitLine(ts, ys);
    if (!ln || Math.abs(ln.k) < 1e-6) return null;
    const ym = ys.reduce((x, y) => x + y, 0) / ys.length;
    const t0 = ln.tm - ym / ln.k;
    return isFinite(t0) ? t0 : null;
  }

  for (let i = a; i <= b; i++) {
    const p = sig[i - 1], c = sig[i];
    if (p == null || c == null) continue;
    const up = p <= thr && c > thr;
    const down = p > thr && c <= thr;
    if (!up && !down) continue;

    const u = Math.abs(c - p) < 1e-9 ? 0 : (thr - p) / (c - p);
    let t = procT(i - 1) + u * (procT(i) - procT(i - 1));

    /* 上升沿：跨越点本身被插值抬高过，跳过它，用后面 3 个样本外推；
       下降沿：同理，用跨越点之前 3 个样本外推。 */
    const ref = up ? toZero(i + 1, 3) : toZero(i - 3, 3);
    if (ref != null && Math.abs(ref - t) < 0.10) t = ref;

    out.push({ i, t, up });
  }
  return out;
}

/* ---------------- 主流程 ---------------- */

/**
 * @param video 已设好 src、loadedmetadata 已触发的 <video>
 * @param opt {heightCm, subject, source, ruler, onProgress(text, ratio), signal}
 *   ruler: {p0:[x,y], p1:[x,y], lenCm} 归一化坐标，两点之间的真实长度
 */
export async function analyze(video, opt = {}) {
  const onProgress = opt.onProgress || (() => {});
  const heightCm = opt.heightCm || 170;
  const signal = opt.signal;
  const throwIfAborted = () => {
    if (signal && signal.aborted) throw new Error('分析已取消');
  };

  onProgress('正在加载姿态模型…', 0.02);
  const det = await loadDetector();
  throwIfAborted();

  const dur = video.duration;
  if (!isFinite(dur) || dur <= 0) throw new Error('视频时长无效，可能是编码不被浏览器支持');
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) throw new Error('浏览器读不出这个视频的画面，可能是编码不支持（建议 MP4/H.264 或 WebM）');
  const ar = vw / vh;

  const n = Math.max(24, Math.min(MAX_SAMPLES, Math.round(dur * SAMPLE_FPS)));
  const step = dur / Math.max(1, n - 1);
  const sampleFps = 1 / step;

  /* 和投篮/跳绳共用同一个检测器，时间戳必须从统一游标分配 */
  const stepMs = Math.max(4, Math.round(step * 1000));
  const tsBase = acquireTimeBlock(n, Math.max(40, stepMs));

  /* 人物太小会检测不到：先整帧，失败再围绕上次髋部位置裁剪放大。
     立定跳远要求全身入镜，裁剪窗口取 0.66，尽量把脚尖也框进来。 */
  const cropCanvas = document.createElement('canvas');
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
  const CROP_W = 0.66, CROP_H = 0.66;
  const DEF_CX = 0.5, DEF_CY = 0.6;
  cropCanvas.width = Math.round(vw * CROP_W);
  cropCanvas.height = Math.round(vh * CROP_H);
  let trackCx = null, trackCy = null;

  function cropRegionOf(cx, cy) {
    return {
      x: Math.max(0, Math.min(1 - CROP_W, cx - CROP_W / 2)),
      y: Math.max(0, Math.min(1 - CROP_H, cy - CROP_H / 2)),
      w: CROP_W, h: CROP_H
    };
  }

  function tryCrop(ts, region) {
    try {
      cropCtx.drawImage(video, region.x * vw, region.y * vh, region.w * vw, region.h * vh,
        0, 0, cropCanvas.width, cropCanvas.height);
      const r = det.detectForVideo(cropCanvas, ts);
      return r && r.landmarks && r.landmarks[0];
    } catch (e) { return null; }
  }

  function detectOnce(t, i) {
    const ts = tsBase + i * stepMs;
    let tsOff = 0;
    const nextTs = () => ts + (tsOff++);

    let res = null;
    try { res = det.detectForVideo(video, nextTs()); } catch (e) { res = null; }
    let l = res && res.landmarks && res.landmarks[0];
    let src = 'full';
    let region = null;

    if (!l) {
      if (trackCx != null) {
        region = cropRegionOf(trackCx, trackCy);
        l = tryCrop(nextTs(), region);
        if (l) src = 'crop';
      }
      if (!l) {
        region = cropRegionOf(DEF_CX, DEF_CY);
        l = tryCrop(nextTs(), region);
        if (l) src = 'crop';
      }
    }

    if (!l) return { t, pts: null, src: 'none' };

    let flat = new Array(66);
    if (src === 'crop' && region) {
      for (let k = 0; k < 33; k++) {
        flat[k * 2] = region.x + l[k].x * region.w;
        flat[k * 2 + 1] = region.y + l[k].y * region.h;
      }
    } else {
      for (let k = 0; k < 33; k++) {
        flat[k * 2] = l[k].x;
        flat[k * 2 + 1] = l[k].y;
      }
    }

    trackCx = (flat[L_HIP * 2] + flat[R_HIP * 2]) / 2;
    trackCy = (flat[L_HIP * 2 + 1] + flat[R_HIP * 2 + 1]) / 2;

    const vis = Math.min.apply(null, KEY.map(k => (l[k].visibility == null ? 1 : l[k].visibility)));
    const footVis = Math.min(
      l[L_AN].visibility == null ? 1 : l[L_AN].visibility,
      l[R_AN].visibility == null ? 1 : l[R_AN].visibility,
      l[L_FT].visibility == null ? 1 : l[L_FT].visibility,
      l[R_FT].visibility == null ? 1 : l[R_FT].visibility
    );
    return { t, pts: flat, src, vis, footVis };
  }

  const frames = [];
  for (let i = 0; i < n; i++) {
    throwIfAborted();
    const t = i * step;
    await seekTo(video, t);
    throwIfAborted();
    frames.push(detectOnce(t, i));
    if (i % 2 === 0) onProgress('正在逐帧识别人体骨骼… ' + (i + 1) + '/' + n, 0.05 + 0.7 * (i + 1) / n);
    await new Promise(r => setTimeout(r, 0));
  }

  const okFrames = frames.filter(f => f.pts);
  if (okFrames.length < 8) {
    throw new Error('没有识别到稳定的人体：请用侧面机位、全身入镜、光线充足的视频');
  }

  onProgress('正在提取起跳与落地…', 0.78);

  const F = frames.map(f => (f.pts ? frameFeatures(f.pts, ar) : null));
  const col = k => F.map(s => (s == null ? null : s[k]));

  const span = col('span');
  const heelY = col('heelY');
  const toeY = col('toeY');

  /* 站立尺度：取跨度的 85 分位。跳跃时腿会收，中位数会把尺子定短 */
  const spanStand = pct(span.filter(v => v != null && v > 0.04), 0.85);
  if (!spanStand) throw new Error('没能测出身体尺度：请确保头顶到脚尖都在画面里');

  /* 站立基线：y 越大越靠下。取 70 分位而不是最大值，
     避免一次深蹲（髋部下沉）把基线拉低。脚尖/脚跟各用各的基线。 */
  const heelBase = pct(heelY, 0.70);
  const toeBase = pct(toeY, 0.70);
  if (heelBase == null || toeBase == null) throw new Error('没能定位脚部基线，请换一段机位固定的视频');

  /* 离地量：除以站立跨度归一化成「身体比例」，
     这样 1.5 米的小孩和 1.9 米的大人、远景和近景，阈值可以共用一套 */
  const heelLiftRaw = heelY.map(v => (v == null ? null : (heelBase - v) / spanStand));
  const toeLiftRaw = toeY.map(v => (v == null ? null : (toeBase - v) / spanStand));

  /* 统一重采样到 30Hz：平滑窗口才固定成 0.1 秒，
     低帧率视频不会因为「一帧跨过整个腾空段」而把峰值抹平 */
  const PROC_FPS = 30;
  const procN = Math.max(8, Math.round(dur * PROC_FPS) + 1);
  const procT = i => Math.min(dur, i / PROC_FPS);
  const times = frames.map(f => f.t);

  const heelRaw = resampleUniform(heelLiftRaw, times, procN, procT, 0.35);
  const toeRaw = resampleUniform(toeLiftRaw, times, procN, procT, 0.35);
  /* 显示用（中值+均值，曲线好看）；判定用（只中值，过零点不偏） */
  const heelLift = smoothSignal(heelRaw);
  const toeLift = smoothSignal(toeRaw);
  const heelDet = medianFilter(heelRaw);
  const toeDet = medianFilter(toeRaw);

  /* 双脚离地 = 脚尖和脚跟都抬起来了。
     取较小值，于是：
       - 起跳沿 = 脚尖离地那一刻（脚跟先起、脚尖最后走）；
       - 落地沿 = 脚跟触地那一刻（脚跟先落）。
     这正好对上立定跳远「从起跳线量到最近触地点」的正式量法。 */
  const lift = [];
  const liftDetRaw = [];
  for (let i = 0; i < procN; i++) {
    const a = toeLift[i], b = heelLift[i];
    lift.push(a == null || b == null ? null : Math.min(a, b));
    const ad = toeDet[i], bd = heelDet[i];
    liftDetRaw.push(ad == null || bd == null ? null : Math.min(ad, bd));
  }
  /* 判定用的信号只过中值，不过均值：保住过零点的时间精度 */
  const liftDet = medianFilter(liftDetRaw);

  /* 噪声地板：二阶差分中位数 ≈ 1.65σ。
     阈值至少要是噪声的 3 倍，否则「站着不动」也能被切成几十段腾空。 */
  const d2 = [];
  for (let i = 1; i < lift.length - 1; i++) {
    const a = lift[i - 1], b = lift[i], c = lift[i + 1];
    if (a == null || b == null || c == null) continue;
    d2.push(Math.abs(a - 2 * b + c));
  }
  const noiseEst = d2.length ? (pct(d2, 0.5) || 0) / 1.65 : 0;
  const thr = Math.max(0.012, noiseEst * 3.0);

  /* 腾空区间：连续高于阈值的一段，最短 0.16 秒。
     阈值压得很低（约 1.8cm），是为了抓住真正的离地瞬间；
     抬得太高会把起跳沿往后推，距离直接算短。 */
  const cross = crossings(liftDet, procT, thr, 1, liftDet.length - 1);
  const flights = [];
  /* 手工推进指针：信号在阈值附近抖动时会连着出现两个「上穿」，
     跳过去配对下一段，否则同一跳会被切出好几段假的腾空 */
  let ci = 0;
  while (ci < cross.length) {
    if (!cross[ci].up) { ci++; continue; }
    let cj = ci + 1;
    while (cj < cross.length && cross[cj].up) cj++;
    if (cj >= cross.length) break;

    const t0 = cross[ci].t, t1 = cross[cj].t;
    if (t1 - t0 >= 0.16) {
      let peak = null;
      for (let k = cross[ci].i; k <= cross[cj].i; k++) {
        if (lift[k] != null && (peak == null || lift[k] > peak)) peak = lift[k];
      }
      /* 抬得太少的多半是 landmark 抖动，不是真起跳 */
      if (peak != null && peak >= thr * 2) flights.push({ t0, t1, peak });
    }
    ci = cj + 1;
  }

  if (!flights.length) {
    throw new Error('没有识别到完整的腾空段：请确认视频里有立定跳远的起跳动作，且双脚全程在画面内');
  }

  /* ---------------- 每跳的几何与力学 ---------------- */

  const center = smoothSignal(resampleUniform(col('center'), times, procN, procT, 0.35));
  const heelYsig = smoothSignal(resampleUniform(col('heelY'), times, procN, procT, 0.35));
  const hipX = smoothSignal(resampleUniform(col('hipX'), times, procN, procT, 0.35));
  /* 起跳点/落地点要取「那一刻」的位置，不能用均值平滑过的信号：
     均值会把「站住 → 突然加速」这个折角磨圆，取到的位置偏后，距离直接算短。
     中值平滑对折角几乎没有影响。 */
  const toeXs = medianFilter(resampleUniform(col('toeX'), times, procN, procT, 0.35));
  const heelXs = medianFilter(resampleUniform(col('heelX'), times, procN, procT, 0.35));
  const hipAng = smoothSignal(resampleUniform(col('hip'), times, procN, procT, 0.35));
  const kneeAng = smoothSignal(resampleUniform(col('knee'), times, procN, procT, 0.35));
  const ankleAng = smoothSignal(resampleUniform(col('ankle'), times, procN, procT, 0.35));
  const armAng = smoothSignal(resampleUniform(col('arm'), times, procN, procT, 0.35));
  const hipYsig = smoothSignal(resampleUniform(col('hipY'), times, procN, procT, 0.35));

  const idxOf = t => clamp(Math.round(t * PROC_FPS), 0, procN - 1);

  const jumps = flights.map((fl, idx) => {
    const i0 = idxOf(fl.t0), i1 = idxOf(fl.t1);

    /* 起跳点 = 脚尖（正式量法从起跳线量），落地点 = 脚跟（最近触地点） */
    const x0 = sampleAt(toeXs, procT, fl.t0);
    const x1 = sampleAt(heelXs, procT, fl.t1);
    const dir = x1 != null && x0 != null && x1 < x0 ? -1 : 1;
    const distN = (x0 == null || x1 == null) ? null : Math.abs(x1 - x0);

    /* 腾空最高点（备用口径）：重心比「起跳那一帧」再抬高多少。
       这个值依赖起跳时刻的精度 —— 起跳沿早判了 30ms，重心还没升到最高点，
       算出来的腾空高度就会偏大。所以优先用下面抛物线拟合出的初速度反算，
       只有拟合失败时才退回这个。 */
    const centerAtTakeoff = center[i0];
    let peakCenter = null;
    for (let k = i0; k <= i1; k++) {
      if (center[k] != null && (peakCenter == null || center[k] < peakCenter)) peakCenter = center[k];
    }
    const flightHn = (peakCenter == null || centerAtTakeoff == null)
      ? null : (centerAtTakeoff - peakCenter) / spanStand;

    /* ---- 起跳角：腾空段重心抛物线拟合，取 t0 处的速度方向 ----
       拟合窗口掐掉首尾各 10%：那两段手脚还在做蹬伸/落地缓冲，
       重心并不完全按抛物线走，混进去会把斜率带偏。 */
    let takeoffAngle = null, impliedG = null, vy0 = null, vx = null;
    const pad = (fl.t1 - fl.t0) * 0.10;
    const ts = [], ys = [], xs = [];
    for (let k = i0; k <= i1; k++) {
      const t = procT(k);
      if (t < fl.t0 + pad || t > fl.t1 - pad) continue;
      if (center[k] == null || hipX[k] == null) continue;
      ts.push(t); ys.push(center[k]); xs.push(hipX[k]);
    }
    const q = fitQuad(ts, ys);
    const ln = fitLine(ts, xs);
    if (q && ln && ts.length >= 5) {
      /* 抛物线是在「归一化 y」上拟合的，斜率要换成真实速度才谈得上角度：
         y 方向 1 个归一化单位 = 1 个画面高度；x 方向 = 1 个画面宽度。
         所以横向速度要乘 ar 才能和纵向比较。 */
      const vyNorm = 2 * q.a * (fl.t0 - q.tm) + q.b;
      const vxNorm = ln.k * ar;
      if (Math.abs(vxNorm) > 1e-6) {
        const ang = Math.atan2(-vyNorm, Math.abs(vxNorm)) * 180 / Math.PI;
        if (isFinite(ang) && ang > -10 && ang < 90) takeoffAngle = round(ang, 1);
      }
      /* 自检：真实重力下抛物线二次项 a 应该 ≈ g/2（换成像素单位后）。
         差太多说明比例尺或机位有问题，后面会据此给出提示。
         y 向下为正，所以 a 是正的；这里不能取反号。 */
      const gy = 2 * q.a * vh;              // 归一化 y/s² → 像素/s²
      const pxPerCm = (spanStand * vh / NOSE_TO_ANKLE_RATIO) / heightCm;
      impliedG = gy / Math.max(1e-6, pxPerCm);
      if (!isFinite(impliedG)) impliedG = null;
      vy0 = -vyNorm; vx = vxNorm;
    }

    /* ---- 起跳前下蹲：起跳前 1.2 秒内髋部最低点 ---- */
    let crouchN = null, crouchT = null;
    const cLo = Math.max(0, i0 - Math.round(PROC_FPS * 1.2));
    let lowHip = null;
    for (let k = cLo; k <= i0; k++) {
      if (hipYsig[k] != null && (lowHip == null || hipYsig[k] > lowHip)) { lowHip = hipYsig[k]; crouchT = procT(k); }
    }
    if (lowHip != null && hipYsig[i0] != null) crouchN = (lowHip - hipYsig[i0]) / spanStand;

    /* ---- 蹬伸时序：髋 / 膝 / 踝伸展角度的峰值先后 ----
       标准动作是「近端到远端」：髋先展开，膝跟上，踝最后蹬直。
       顺序反了（膝比髋早）就是典型的「先伸膝」—— 力量没经过髋，跳不远。

       峰值时刻不能直接取 argmax：30fps 下三个关节的峰值常常落在同一帧，
       取出来就是三个一模一样的数字，顺序全靠数组顺序碰运气。
       所以对峰顶做抛物线插值，把时间细化到亚帧（±8ms 左右）。 */
    const seqFrom = crouchT != null ? crouchT : Math.max(0, fl.t0 - 0.8);
    const seqTo = Math.min(dur, fl.t0 + 0.12);
    const seq = [];
    [['髋', hipAng], ['膝', kneeAng], ['踝', ankleAng]].forEach(function (pair) {
      const name = pair[0], sig = pair[1];
      let best = null, bi = null;
      for (let k = idxOf(seqFrom); k <= idxOf(seqTo); k++) {
        if (sig[k] == null) continue;
        if (best == null || sig[k] > best) { best = sig[k]; bi = k; }
      }
      if (best == null) return;

      let bt = procT(bi);
      /* 三点抛物线插值：y = a·u² + b·u + c，顶点在 u = -b/(2a) */
      if (bi > 0 && bi < procN - 1) {
        const y0 = sig[bi - 1], y1 = sig[bi], y2 = sig[bi + 1];
        if (y0 != null && y2 != null) {
          const den = y0 - 2 * y1 + y2;
          if (Math.abs(den) > 1e-9) {
            const u = 0.5 * (y0 - y2) / den;
            if (u > -1 && u < 1) bt = procT(bi) + u * (procT(bi + 1) - procT(bi));
          }
        }
      }
      seq.push({ name, angle: round(best, 1), t: bt, tRel: round((bt - fl.t0) * 1000, 0) });
    });
    const seqSorted = seq.slice().sort((a, b) => a.t - b.t).map(s => s.name);
    /* 三个峰值挤在 20ms 以内 = 采样精度内分不开。
       这时候硬报一个顺序是编数据，不如老实说「几乎同时」。 */
    const rels = seq.map(s => s.tRel);
    const extSpread = rels.length === 3 ? Math.max.apply(null, rels) - Math.min.apply(null, rels) : null;
    const extTie = extSpread != null && extSpread < 20;
    const seqOk = !extTie && seqSorted.length === 3 && seqSorted.join('') === '髋膝踝';

    /* ---- 摆臂：起跳窗口内手臂前摆角的峰值时刻 ----
       手臂前摆把动量交给身体，峰值应该落在起跳前后一小段内；
       早太多（摆完才蹬）或晚太多（人都飞了才甩手）都用不上力。 */
    let armLag = null, armAmp = null;
    {
      const aLo = Math.max(0, idxOf(fl.t0 - 0.9)), aHi = Math.min(procN - 1, idxOf(fl.t0 + 0.5));
      let best = null, bt = null, lo = null, hi = null;
      for (let k = aLo; k <= aHi; k++) {
        const v = armAng[k] == null ? null : dir * armAng[k];
        if (v == null) continue;
        if (best == null || v > best) { best = v; bt = procT(k); }
        if (lo == null || v < lo) lo = v;
        if (hi == null || v > hi) hi = v;
      }
      if (best != null) {
        armLag = round((bt - fl.t0) * 1000, 0);
        armAmp = round(hi - lo, 1);
      }
    }

    /* ---- 落地：后移、手撑地、膝缓冲 ---- */
    let backN = null, handTouch = false, minKnee = null;
    {
      const bLo = i1, bHi = Math.min(procN - 1, idxOf(fl.t1 + 0.8));
      const hx0 = hipX[i1];
      let hx1 = null;
      for (let k = Math.min(bHi, idxOf(fl.t1 + 0.6)); k >= i1; k--) {
        if (hipX[k] != null) { hx1 = hipX[k]; break; }
      }
      /* 正 = 往起跳方向的反方向退（成绩要被扣），负 = 落地后还往前带了一点。
         注意方向：x 增大 = 往跳跃方向走，所以「后退」是 hx1 < hx0。 */
      if (hx0 != null && hx1 != null) backN = round(dir * (hx0 - hx1), 4);

      const kHi = Math.min(procN - 1, idxOf(fl.t1 + 0.45));
      for (let k = i1; k <= kHi; k++) {
        if (kneeAng[k] != null && (minKnee == null || kneeAng[k] < minKnee)) minKnee = kneeAng[k];
      }

      /* 手撑地 / 扶地：落地后手腕降到接近地面。
         判据只有一条 —— 手腕与脚跟的高差在 0.18 倍身段（约 28cm）以内。
         画面坐标 y 向下为正：手比脚跟「高」算出来是负值，
         所以写的是 > -0.18，而不是 < 0.18 —— 符号写反，手举在头顶也会被判成撑地。
         不用「手低于膝」：深蹲时膝盖本身就很低，那个判据会漏掉真正撑地的动作。
         只查落地之后，否则起跳前的下蹲摆臂会被误判。 */
      const wHi = Math.min(procN - 1, idxOf(fl.t1 + 0.8));
      for (let k = i1; k <= wHi; k++) {
        const fi = clamp(Math.round(procT(k) / step), 0, frames.length - 1);
        const fr = frames[fi];
        const heel = heelYsig[k];
        if (!fr || !fr.pts || heel == null) continue;
        const wrY = (fr.pts[L_WR * 2 + 1] + fr.pts[R_WR * 2 + 1]) / 2;
        if ((wrY - heel) / spanStand > -0.18) { handTouch = true; break; }
      }
    }

    /* ---- 起跳时序曲线：给界面画图用 ----
       窗口取起跳前 1 秒到起跳后 0.6 秒：前面够看到下蹲最深点，
       后面够看到踝关节最后蹬直。角度是无量纲的，不受比例尺影响。 */
    const timing = [];
    const tLo = Math.max(0, fl.t0 - 1.0), tHi = Math.min(dur, fl.t0 + 0.6);
    for (let k = idxOf(tLo); k <= idxOf(tHi); k++) {
      timing.push([
        round((procT(k) - fl.t0) * 1000, 0),
        hipAng[k] == null ? null : round(hipAng[k], 1),
        kneeAng[k] == null ? null : round(kneeAng[k], 1),
        ankleAng[k] == null ? null : round(ankleAng[k], 1),
        armAng[k] == null ? null : round(dir * armAng[k], 1)
      ]);
    }

    return {
      id: idx + 1,
      t0: round(fl.t0, 3),
      t1: round(fl.t1, 3),
      tRel: round(fl.t0 / dur, 4),
      dur: round(fl.t1 - fl.t0, 3),
      x0: x0 == null ? null : round(x0, 5),
      x1: x1 == null ? null : round(x1, 5),
      dir,
      distN: distN == null ? null : round(distN, 5),
      flightHn: flightHn == null ? null : round(flightHn, 4),
      /* 起跳瞬间的竖直速度（归一化 y 单位/秒，向上为正）。
         腾空高度 = v²/(2g)，比「最高点减起跳点」稳得多：
         后者对起跳时刻的判定精度很敏感，前者用的是整段拟合的斜率。 */
      vy0n: vy0 == null ? null : round(vy0, 5),
      crouchN: crouchN == null ? null : round(crouchN, 4),
      backN,
      takeoffAngle,
      impliedG: impliedG == null ? null : round(impliedG, 0),
      ext: seq,
      extOrder: seqSorted.join('→') || null,
      extOk: seqOk,
      extTie: extTie,
      extSpread: extSpread,
      armLag,
      armAmp,
      minKnee: minKnee == null ? null : round(minKnee, 1),
      handTouch,
      timing
    };
  });

  /* ---------------- 诊断 ---------------- */
  const subjectPx = (() => {
    const hs = [];
    for (const s of F) {
      if (!s || !(s.span > 0)) continue;
      hs.push(s.span * vh);
    }
    return hs.length ? Math.round(pct(hs, 0.5)) : 0;
  })();

  const footRatio = okFrames.length
    ? okFrames.filter(f => f.footVis == null || f.footVis > 0.45).length / frames.length
    : 0;

  const warnings = [];
  if (subjectPx > 0 && subjectPx < vh * 0.40) {
    warnings.push('人物只占画面高度 ' + Math.round(subjectPx / vh * 100) + '%，厘米类指标误差会偏大；建议人占画面一半以上。');
  }
  if (footRatio < 0.75) {
    warnings.push('脚尖或脚跟有 ' + Math.round((1 - footRatio) * 100) + '% 的帧没被稳定识别，起跳/落地时刻可能偏，建议让双脚全程留在画面里。');
  }
  if (sampleFps < 20) {
    warnings.push('视频较长，采样率只有 ' + round(sampleFps, 1) + 'fps，起跳时刻的精度会下降；建议只拍这一跳。');
  }
  const gDev = jumps.map(j => j.impliedG).filter(v => v != null && v > 0);
  if (gDev.length) {
    const gm = mean(gDev);
    if (gm < G * 0.55 || gm > G * 1.6) {
      warnings.push('重心抛物线的等效重力是 ' + Math.round(gm) + ' cm/s²（真实值约 981），比例尺可能不准；建议在画面里放一把卷尺做标尺校准。');
    }
  }

  /* ---------------- 显示用数据 ---------------- */
  const curveStep = Math.max(1, Math.ceil(procN / 1800));
  const curve = [];
  for (let i = 0; i < procN; i += curveStep) {
    curve.push([
      round(procT(i), 3),
      lift[i] == null ? null : round(lift[i], 4),
      center[i] == null ? null : round(center[i], 4)
    ]);
  }

  /* 骨骼包：空帧用前一帧补，播放时骨架不闪断 */
  const bundle = [];
  let lastPts = null;
  for (const f of frames) {
    const p = f.pts || lastPts;
    if (p) lastPts = p;
    bundle.push(p ? p.map(v => round(v, 4)) : new Array(66).fill(0.5));
  }

  onProgress('完成', 1);

  const res = {
    meta: {
      subject: opt.subject || '我的立定跳远视频',
      source: opt.source || '本地上传',
      tag: 'longjump',
      video: video.currentSrc || video.src,
      duration: round(dur, 2),
      fps: round(sampleFps, 2),
      sampleFps: round(sampleFps, 2),
      heightCm: heightCm,
      videoAspect: round(ar, 4),
      videoW: vw,
      videoH: vh,
      spanStand: round(spanStand, 4),
      heelBaseline: round(heelBase, 4),
      toeBaseline: round(toeBase, 4),
      threshold: round(thr, 4),
      ruler: opt.ruler || null,
      scaleMethod: opt.ruler ? 'ruler' : 'height',
      subjectPx: subjectPx,
      subjectRatio: vh > 0 ? round(subjectPx / vh, 2) : 0,
      smallSubject: subjectPx > 0 && subjectPx < vh * 0.40,
      footRatio: round(footRatio, 3),
      userVideo: true,
      warnings: warnings
    },
    jumps: jumps,
    curve: curve,
    bundle: bundle,
    detected: okFrames.length,
    total: frames.length,
    frameSrc: frames.map(f => f.src || 'none'),
    stats: {}
  };

  applyScale(res);
  return res;
}

/* ============================================================
 * 比例尺 → 厘米 → 评分
 *
 * 算法本身只输出「归一化量」（身体比例、归一化 x），
 * 所有厘米值与评分都在这里一次性算出来。
 * 这样用户改身高、或者重新点标尺校准时，
 * 不需要重跑姿态模型 —— 调 applyScale 就够了。
 * ============================================================ */

/** 由标尺或身高算出「1 个归一化 x / y 单位 = 多少厘米」 */
export function scaleOf(meta) {
  const vw = meta.videoW || 1, vh = meta.videoH || 1;
  const ruler = meta.ruler;
  if (ruler && ruler.p0 && ruler.p1 && ruler.lenCm > 0) {
    const dx = (ruler.p1[0] - ruler.p0[0]) * vw;
    const dy = (ruler.p1[1] - ruler.p0[1]) * vh;
    const px = Math.hypot(dx, dy);
    if (px > 4) {
      const cmPerPx = ruler.lenCm / px;
      return { cmPerPx, cmPerX: cmPerPx * vw, cmPerY: cmPerPx * vh, method: 'ruler' };
    }
  }
  /* 身高法：站立跨度（鼻尖→踝，归一化 y）× 画面高 = 像素，
     再按「跨度 ≈ 0.891 身高」换算成像素/厘米 */
  const spanPx = (meta.spanStand || 0) * vh;
  const cmPerPx = spanPx > 1 ? (meta.heightCm || 170) / (spanPx / NOSE_TO_ANKLE_RATIO) : 0;
  return { cmPerPx, cmPerX: cmPerPx * vw, cmPerY: cmPerPx * vh, method: 'height' };
}

function scoreDist(distCm, heightCm) {
  if (distCm == null || !heightCm) return null;
  /* 用「距离 ÷ 身高」当无量纲指标：业余 1.0–1.2、校队 1.3、专业 1.45 以上。
     0.55 倍身高以下按 0 分算（那是走了一步，不是跳）。 */
  const r = distCm / heightCm;
  return clamp(Math.round((r - 0.55) / (1.45 - 0.55) * 100), 0, 100);
}

function scoreAngle(a) {
  if (a == null) return null;
  /* 立定跳远的起跳角比纯抛物线最优 45° 低：人腿蹬伸有方向性，
     实测优秀选手集中在 32–45°，取 38° 为峰值。 */
  return clamp(Math.round(100 - Math.abs(a - 38) * 3.6), 0, 100);
}

/** 蹬伸顺序的结论，只有三种：'ok' | 'reversed' | 'tie'
 *  'tie' = 三个峰值挤在采样精度内，分不出先后 —— 这时候不该报顺序。
 *  评分和界面都从这里取结论，避免两边各判一次、说法不一致。 */
export function extVerdict(j) {
  if (!j || !j.ext || j.ext.length < 3) return null;
  if (j.extTie) return 'tie';
  return j.extOk ? 'ok' : 'reversed';
}

function scoreExt(j) {
  const v = extVerdict(j);
  if (v == null) return null;
  /* 三个峰值挤在 20ms 以内：30fps 一帧就有 33ms，这时候谁先谁后本来就分不清。
     按「顺序错了」扣分是冤枉，给满分又是编数据 —— 只能给中性分，
     并在界面上老实说明「采样精度内无法判定」。 */
  if (v === 'tie') return 70;
  if (v === 'reversed') return 55;
  /* 顺序对了还要看间隔：三段挤在 30ms 内等于「一起伸」，
     近端到远端的时序没建立起来，力传不到脚上。 */
  const lags = [];
  for (let i = 1; i < j.ext.length; i++) {
    lags.push(Math.abs(j.ext[i].tRel - j.ext[i - 1].tRel));
  }
  const maxLag = lags.length ? Math.max.apply(null, lags) : 0;
  let s = 100;
  if (maxLag < 25) s -= 25;
  if (maxLag > 260) s -= 20;
  return clamp(s, 0, 100);
}

function scoreArm(j) {
  if (j.armLag == null) return null;
  if (j.armAmp != null && j.armAmp < 40) return 40;   // 基本没摆臂
  const lag = Math.abs(j.armLag);
  if (lag <= 120) return 100;
  return clamp(Math.round(100 - (lag - 120) / 4), 20, 100);
}

function scoreLand(j) {
  let s = 100;
  if (j.backCm != null && j.backCm > 3) s -= Math.min(45, Math.round(j.backCm * 1.8));
  if (j.handTouch) s -= 35;
  if (j.minKnee != null) {
    if (j.minKnee > 160) s -= 22;        // 直腿落地，冲击全给关节
    else if (j.minKnee < 70) s -= 10;    // 蹲太深，力量散掉
  }
  return clamp(Math.round(s), 0, 100);
}

/** 把厘米值和评分写回 res（就地修改，返回同一个对象） */
export function applyScale(res) {
  if (!res || !res.meta) return res;
  const sc = scaleOf(res.meta);
  res.meta.cmPerPx = round(sc.cmPerPx, 4);
  res.meta.cmPerX = round(sc.cmPerX, 3);
  res.meta.cmPerY = round(sc.cmPerY, 3);
  res.meta.scaleMethod = sc.method;

  const H = res.meta.heightCm || 170;

  res.jumps.forEach(function (j) {
    j.distCm = j.distN == null ? null : round(j.distN * sc.cmPerX, 1);
    /* 腾空高度优先用拟合初速度反算：h = v_y²/(2g)。
       起跳时刻早判几毫秒时，「最高点减起跳点」会明显偏大，这个不会。 */
    if (j.vy0n != null) {
      const vyCm = j.vy0n * sc.cmPerY;
      j.flightHCm = round(vyCm * vyCm / (2 * G), 1);
    } else {
      j.flightHCm = j.flightHn == null ? null : round(j.flightHn * sc.cmPerY, 1);
    }
    j.crouchCm = j.crouchN == null ? null : round(j.crouchN * sc.cmPerY, 1);
    j.backCm = j.backN == null ? null : round(j.backN * sc.cmPerX, 1);

    /* 距离为负或离谱的值直接判无效，别让它污染平均分 */
    if (j.distCm != null && (j.distCm < 0 || j.distCm > 500)) j.distCm = null;

    const sDist = scoreDist(j.distCm, H);
    const sAngle = scoreAngle(j.takeoffAngle);
    const sExt = scoreExt(j);
    const sArm = scoreArm(j);
    const sLand = scoreLand(j);

    j.scores = { dist: sDist, angle: sAngle, ext: sExt, arm: sArm, land: sLand };

    /* 加权：距离是结果，权重最高；其余是「为什么是这个结果」 */
    const W = [['dist', 0.40], ['angle', 0.15], ['ext', 0.15], ['arm', 0.15], ['land', 0.15]];
    let sum = 0, wsum = 0;
    W.forEach(function (p) {
      const v = j.scores[p[0]];
      if (v == null) return;
      sum += v * p[1];
      wsum += p[1];
    });
    j.score = wsum > 0 ? Math.round(sum / wsum) : null;
  });

  /* 主跳：距离最远的那一次。视频里连跳好几下时，界面默认展示它 */
  let best = -1, bestD = -1;
  res.jumps.forEach(function (j, i) {
    if (j.distCm != null && j.distCm > bestD) { bestD = j.distCm; best = i; }
  });
  res.primary = best;

  const dists = res.jumps.map(j => j.distCm).filter(v => v != null);
  const angles = res.jumps.map(j => j.takeoffAngle).filter(v => v != null);
  const flights = res.jumps.map(j => j.dur).filter(v => v != null);

  res.stats = {
    count: res.jumps.length,
    bestDist: dists.length ? round(Math.max.apply(null, dists), 1) : null,
    avgDist: dists.length ? round(mean(dists), 1) : null,
    bestAngle: angles.length ? round(mean(angles), 1) : null,
    flightTime: flights.length ? round(mean(flights), 3) : null,
    bestScore: best >= 0 ? res.jumps[best].score : null,
    scaleMethod: sc.method,
    cmPerPx: round(sc.cmPerPx, 4)
  };
  return res;
}
