/* ============================================================
 * rope-engine.js  —  跳绳计数分析引擎（浏览器端）
 *
 * 复用页面里同一套 MediaPipe Pose Landmarker（见 pose-engine.js），
 * 但算法完全独立：这里只关心「身体纵向周期」，不关心投篮出手。
 *
 * 计数思路（原创实现，未复制任何第三方项目代码）：
 *   1) 逐帧取肩、髋、踝关键点；
 *   2) 用「肩髋中点」的纵向位移作为主信号，脚踝离地作为辅助证据；
 *   3) 以站立时的身体跨度为尺，把信号归一化成「身体比例」，抵消身高/机位远近；
 *   4) 状态机找完整的「离地 → 最高点 → 落地」周期，带最小间隔约束防重复计数；
 *   5) 由周期序列算次数、每分钟次数、跳高、节奏一致性、断绳区间。
 *
 * 参考过公开项目的「思路」（例如用肩髋纵向波形计数的做法），
 * 但没有复制其代码；阈值、状态机、归一化方式和输出结构都是为本项目重写的。
 * 第三方依赖 MediaPipe 的许可见 README / docs/跳绳计数方案.md。
 * ============================================================ */

import { loadDetector, acquireTimeBlock, seekTo } from './pose-engine.js';

/* 33 点索引（MediaPipe Pose） */
const L_SH = 11, R_SH = 12, L_HIP = 23, R_HIP = 24;
const L_AN = 27, R_AN = 28;
const KEY = [L_SH, R_SH, L_HIP, R_HIP, L_AN, R_AN];

/* 采样节奏：跳绳是 2–3Hz 的周期动作，20–30fps 足够夹住峰值。
   上限必须够长：1200 帧时，2 分钟的视频只剩 10fps、3 分钟只剩 6.7fps，
   快速连跳会成片漏计（实测 3 分钟 120 次/分只数出 1/4）。
   3600 帧能保证 2 分钟内 30fps、3 分钟内 20fps、4 分钟内 15fps。 */
const SAMPLE_FPS = 30;
const MAX_SAMPLES = 3600;

/* 身体尺度：鼻尖到踝的跨度约为身高的 0.891 倍（Drillis & Contini）。
   和投篮模块用同一套人体测量学口径，两个项目的身高换算才可比。 */
const NOSE_TO_ANKLE_RATIO = 0.891;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v, d) { var p = Math.pow(10, d || 0); return Math.round(v * p) / p; }

/* 分位数：和 pose-engine 的口径一致，空数组返回 null */
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

function stdev(arr) {
  const m = mean(arr);
  if (m == null) return null;
  const v = arr.filter(x => x != null && isFinite(x));
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
}

/* 3 点中值 + 3 点均值：中值先挡掉单帧跳点，均值再把台阶磨圆。
   跳绳峰值只有几厘米，原始 landmark 抖动很容易把它淹掉。 */
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

/* 滚动中位数。
   人会在固定机位里前后走动、镜头也会慢慢漂，全局基线会被这些慢变化带偏：
   站得离镜头近一点，整段信号就整体平移，原来卡在基线上的阈值就失效了。
   减掉 2.5 秒尺度的慢趋势后，信号回到「每次起跳绕 0 上下」的形态，
   阈值和身高/机位/走动距离都无关。 */
function rollingMedian(arr, win) {
  const n = arr.length;
  const half = Math.max(1, Math.floor(win / 2));
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const w = [];
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      const v = arr[j];
      if (v != null && isFinite(v)) w.push(v);
    }
    if (!w.length) continue;
    w.sort((a, b) => a - b);
    const m = w.length;
    out[i] = m % 2 ? w[(m - 1) / 2] : (w[m / 2 - 1] + w[m / 2]) / 2;
  }
  return out;
}

/* 把不等间隔/低帧率的信号线性重采样到固定网格。
   跳绳腾空段只有 0.15–0.3 秒；12fps 时 3 个采样点就横跨整个腾空段，
   按「帧」做平滑会把峰值直接抹平。重采样到 30Hz 后，平滑窗口才固定在 0.1 秒。
   长缺口（> maxGapSec）不插值，避免凭空造出一个假峰。 */
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

/* 取一帧里几个关键点的纵向位置。所有值都是「视频归一化 y」，向下为正。 */
function frameSignal(pts) {
  if (!pts) return null;
  const shY = (pts[L_SH * 2 + 1] + pts[R_SH * 2 + 1]) / 2;
  const hipY = (pts[L_HIP * 2 + 1] + pts[R_HIP * 2 + 1]) / 2;
  const anY = (pts[L_AN * 2 + 1] + pts[R_AN * 2 + 1]) / 2;
  const noseY = pts[1];
  return {
    center: (shY + hipY) / 2,
    ankle: anY,
    span: anY - noseY,       // 鼻尖→踝，站立时 ≈ 0.891 身高
    torso: hipY - shY
  };
}

/* ---------------- 主流程 ---------------- */

/**
 * @param video 已设好 src、loadedmetadata 已触发的 <video>
 * @param opt {heightCm, subject, source, onProgress(text, ratio)}
 */
export async function analyze(video, opt = {}) {
  const onProgress = opt.onProgress || (() => {});
  const heightCm = opt.heightCm || 170;
  /* 用户中途换视频时，旧分析必须尽快停手：
     它和新分析共用同一个 <video> 元素，继续跑会把两段画面混在一起 */
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

  /* 和投篮分析共用同一个检测器，时间戳必须从统一游标分配。
     间隔用真实抽帧间隔：长视频降到 10–15fps 时，仍按 33ms 喂时间戳
     会让 MediaPipe 的跟踪器以为帧率没变，平滑强度和实际运动对不上。 */
  const stepMs = Math.max(4, Math.round(step * 1000));
  const tsBase = acquireTimeBlock(n, Math.max(40, stepMs));

  /* 人物太小会检测不到。和投篮模块一样做两级回退：
     先整帧，失败再围绕上次髋部位置裁剪放大。跳绳要求全身入镜，
     所以裁剪窗口取 0.62，尽量把头和脚都框进来。 */
  const cropCanvas = document.createElement('canvas');
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
  const CROP_W = 0.62, CROP_H = 0.62;
  const DEF_CX = 0.5, DEF_CY = 0.55;
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
    const ankleVis = Math.min(l[L_AN].visibility == null ? 1 : l[L_AN].visibility,
      l[R_AN].visibility == null ? 1 : l[R_AN].visibility);
    const shVis = Math.min(l[L_SH].visibility == null ? 1 : l[L_SH].visibility,
      l[R_SH].visibility == null ? 1 : l[R_SH].visibility);
    return { t, pts: flat, src, vis, ankleVis, shVis };
  }

  const frames = [];
  for (let i = 0; i < n; i++) {
    throwIfAborted();
    const t = i * step;
    await seekTo(video, t);
    throwIfAborted();
    frames.push(detectOnce(t, i));
    if (i % 2 === 0) onProgress('正在逐帧识别人体骨骼… ' + (i + 1) + '/' + n, 0.05 + 0.7 * (i + 1) / n);
    await new Promise(r => setTimeout(r, 0));   // 让出主线程，进度条才动得起来
  }

  const okFrames = frames.filter(f => f.pts);
  if (okFrames.length < 8) {
    throw new Error('没有识别到稳定的人体：请用全身入镜、光线充足、人物占画面一半以上的视频');
  }

  onProgress('正在提取纵向节奏…', 0.78);

  const S = frames.map(f => (f.pts ? frameSignal(f.pts) : null));
  const col = k => S.map(s => (s == null ? null : s[k]));

  const center = col('center');
  const ankle = col('ankle');
  const span = col('span');
  const torso = col('torso');

  /* 站立尺度：取跨度的 85 分位。跳跃时腿会收，跨度变小，
     用中位数会把尺子定短；85 分位更接近「站直」的那几帧。 */
  const spanStand = pct(span.filter(v => v != null && v > 0.04), 0.85);
  const torsoStand = pct(torso.filter(v => v != null && v > 0.02), 0.85);
  const scale = spanStand || (torsoStand ? torsoStand * 2.2 : null);
  if (!scale) throw new Error('没能测出身体尺度：请确保头顶到脚踝都在画面里');

  const cmPerUnit = heightCm / (scale / NOSE_TO_ANKLE_RATIO);

  /* 站立基线：y 越大越靠下。跳绳时身体向上，y 变小。
     取 75 分位而不是最大值，避免一次深蹲把基线拉低。 */
  const centerBase = pct(center, 0.75);
  const ankleBase = pct(ankle, 0.78);
  if (centerBase == null || ankleBase == null) throw new Error('没能定位身体纵向基线，请换一段机位固定的视频');

  /* 归一化：除以站立跨度，得到「身体比例」。
     这样 1.5 米的小孩和 1.9 米的大人、远景和近景，阈值可以共用一套。 */
  const liftRaw = center.map(v => (v == null ? null : (centerBase - v) / scale));
  const ankleLiftRaw = ankle.map(v => (v == null ? null : (ankleBase - v) / scale));

  /* 计数用信号统一重采样到 30Hz。
     低采样率时，按「帧」做的 3 点平滑会跨过整个腾空段（12fps 时约 0.25 秒），
     把峰值抹平，长视频会成片漏计。重采样后平滑窗口固定在 0.1 秒。
     重采样同时把 ≤0.35 秒的短缺口线性补齐；长缺口保持 null。 */
  const PROC_FPS = 30;
  const procN = Math.max(8, Math.round(dur * PROC_FPS) + 1);
  const procT = i => Math.min(dur, i / PROC_FPS);
  const times = frames.map(f => f.t);
  const sig = smoothSignal(resampleUniform(liftRaw, times, procN, procT, 0.35));
  const ankleSig = smoothSignal(resampleUniform(ankleLiftRaw, times, procN, procT, 0.35));

  /* 去慢趋势：只保留「每次起跳」这个尺度上的起伏。
     真实素材里人会前后走动、镜头会慢慢漂，全局基线会把站立和起跳的
     差距吃掉 —— 实测 30 秒内漂移 6% 画面高度就能漏计三成。 */
  const trendWin = Math.max(5, Math.round(PROC_FPS * 2.5));
  const sigTrend = rollingMedian(sig, trendWin);
  const sigDet = sig.map((v, i) => (v == null || sigTrend[i] == null ? null : v - sigTrend[i]));

  /* 稳健幅度：用 |去趋势信号| 的 90 分位，而不是原始信号的 95 分位。
     95 分位会被一次特别高的起跳（或一次镜头抖）拉高，阈值跟着抬高，
     后面所有正常起跳都被判成「不够高」。 */
  const devAbs = sigDet.filter(v => v != null && isFinite(v)).map(v => Math.abs(v));
  const amp = pct(devAbs, 0.90);
  if (amp == null || amp <= 0) throw new Error('没有检测到明显的纵向起伏，请确认视频里确实在跳绳');

  /* 估计「静止时的 landmark 抖动」：二阶差分的绝对值。
     动作信号是平滑的，二阶差分很小；噪声的二阶差分约等于 1.65σ。
     用中位数而不是均值，避免把真正的起跳算进噪声里。
     阈值至少要是噪声的 3 倍，否则「站着不动」也能被数出几十次。 */
  const d2 = [];
  for (let i = 1; i < sigDet.length - 1; i++) {
    const a = sigDet[i - 1], b = sigDet[i], c = sigDet[i + 1];
    if (a == null || b == null || c == null) continue;
    d2.push(Math.abs(a - 2 * b + c));
  }
  const noiseEst = d2.length ? (pct(d2, 0.5) || 0) / 1.65 : 0;

  /* ---------------- 峰值检测 ----------------
     不依赖「信号必须先落回 0」：快速连跳时，两次起跳之间脚只着地一两帧，
     采样很可能正好错过，信号不会回到基线。所以改找「有足够突出度的局部峰」：
       - 峰值本身要高于 enter；
       - 峰前/峰后一个窗口内要有明显的低点（突出度），挡掉噪声小鼓包；
       - 峰后必须真的往下掉，说明人已经落地，不是一直举着；
       - 两次峰至少隔 minGap，防止同一次起跳被数两下。
     阈值全部相对「本次分析自己的幅度」定，不写死厘米数：
     跳 2cm 和跳 10cm 的人，用的是同一套相对判据。 */
  const enter = Math.max(0.0035, noiseEst * 3.0, amp * 0.28);
  const minGap = Math.max(2, Math.round(PROC_FPS * 0.18));
  const win = Math.max(2, Math.round(PROC_FPS * 0.30));
  const dropFrames = Math.max(3, Math.round(PROC_FPS * 1.0));

  const cands = [];
  for (let i = 1; i < sigDet.length - 1; i++) {
    const v = sigDet[i];
    if (v == null || !isFinite(v) || v < enter) continue;

    /* 严格局部极大。补洞之后这里只剩「长缺口」两侧的 null，
       遇到 null 直接跳过，避免把上升沿当成峰。 */
    const prev = sigDet[i - 1], next = sigDet[i + 1];
    if (prev == null || next == null) continue;
    if (v < prev || v < next) continue;

    let lo = v;
    for (let j = Math.max(0, i - win); j <= Math.min(sigDet.length - 1, i + win); j++) {
      if (sigDet[j] != null && sigDet[j] < lo) lo = sigDet[j];
    }
    const prom = v - lo;
    if (prom < Math.max(enter * 0.55, amp * 0.16)) continue;

    /* 峰后要往下掉：说明这是一次完整起跳，而不是信号一直挂在高位 */
    let dropped = false;
    const needDrop = Math.max(enter * 0.45, prom * 0.35);
    for (let j = i + 1; j <= Math.min(sigDet.length - 1, i + dropFrames); j++) {
      if (sigDet[j] != null && sigDet[j] <= v - needDrop) { dropped = true; break; }
    }
    if (!dropped) continue;

    /* amp 保留原始抬升值给曲线画点用，peak 是去趋势后的幅度给筛选用 */
    cands.push({ i, t: procT(i), amp: sig[i] == null ? v : sig[i], peak: v, prom: prom });
  }

  if (!cands.length) throw new Error('没有识别到完整的起跳周期：请用固定机位、全身入镜的视频');

  /* 合并过近的候选：0.18 秒内只保留幅度更大的那个 */
  cands.sort((a, b) => a.t - b.t);
  const merged = [];
  for (const c of cands) {
    const last = merged[merged.length - 1];
    if (last && c.t - last.t < minGap / PROC_FPS) {
      if (c.peak > last.peak) merged[merged.length - 1] = c;
    } else {
      merged.push(c);
    }
  }

  /* 幅度太小的候选多半是走路/抖动；但保留「偏低」的，后面标成断绳/幅度骤降 */
  const medPeak = pct(merged.map(c => c.peak), 0.5);
  const minPeak = Math.max(enter * 0.80, medPeak * 0.12);
  const kept = merged.filter(c => c.peak >= minPeak);
  if (!kept.length) throw new Error('检测到的起伏太弱，可能是人物太小或跳绳离地不明显');

  /* 峰值附近的脚踝最高点 = 这次起跳的离地高度。
     主信号是肩髋中点，腿收起时脚踝会比躯干升得更多，所以单独取脚踝。
     基线不能用全片一个固定值：人走近镜头、镜头慢慢漂，都会让「站着」
     在画面里的位置整体移动。改成每次起跳前后 1.5 秒内脚踝的低分位，
     相当于「这一跳附近的地面」。 */
  const jumps = kept.map((c, idx) => {
    let h = null;
    const plo = Math.max(0, c.i - Math.round(PROC_FPS * 0.15));
    const phi = Math.min(ankleSig.length - 1, c.i + Math.round(PROC_FPS * 0.15));
    for (let j = plo; j <= phi; j++) {
      if (ankleSig[j] != null && (h == null || ankleSig[j] > h)) h = ankleSig[j];
    }

    const blo = Math.max(0, c.i - Math.round(PROC_FPS * 1.5));
    const bhi = Math.min(ankleSig.length - 1, c.i + Math.round(PROC_FPS * 1.5));
    const around = [];
    for (let j = blo; j <= bhi; j++) {
      if (ankleSig[j] != null && isFinite(ankleSig[j])) around.push(ankleSig[j]);
    }
    const localBase = around.length >= 3 ? pct(around, 0.25) : ankleBase;

    const heightCm = (h == null || localBase == null) ? null : round((h - localBase) * cmPerUnit, 1);
    return {
      id: idx + 1,
      i: c.i,
      t: round(c.t, 3),
      tRel: round(c.t / dur, 4),
      amp: c.amp,
      peak: c.peak,
      heightCm: heightCm != null && heightCm >= 0 && heightCm <= 60 ? heightCm : null,
      low: false
    };
  });

  /* 间隔、节奏、断绳 */
  const intervals = [];
  for (let i = 1; i < jumps.length; i++) intervals.push(jumps[i].t - jumps[i - 1].t);
  const goodIntervals = intervals.filter(v => v >= 0.18 && v <= 2.5);
  const medInterval = pct(goodIntervals, 0.5);
  const meanInterval = mean(goodIntervals);
  const sdInterval = stdev(goodIntervals);
  const cv = meanInterval && sdInterval != null ? sdInterval / meanInterval : null;

  const medHeight = pct(jumps.map(j => j.heightCm), 0.5);
  jumps.forEach(j => {
    /* 幅度低于本段中位数一半：动作明显变小，标出来但不直接删掉 */
    j.low = medPeak != null && j.peak < medPeak * 0.45;
    delete j.peak;
    j.interval = j.id > 1 ? round(j.t - jumps[j.id - 2].t, 3) : null;
  });

  const breaks = [];
  const breakGap = Math.max(0.9, (medInterval || 0.55) * 2.0);
  for (let i = 1; i < jumps.length; i++) {
    const dt = jumps[i].t - jumps[i - 1].t;
    if (dt > breakGap) {
      breaks.push({
        type: 'gap',
        t0: jumps[i - 1].t,
        t1: jumps[i].t,
        sec: round(dt, 2),
        label: '停顿 ' + round(dt, 1) + 's'
      });
    }
  }
  /* 连续两次以上幅度骤降：可能是断绳后重新起跳，也可能是体力下降 */
  let runStart = -1;
  for (let i = 0; i < jumps.length; i++) {
    if (jumps[i].low) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart >= 2) {
        breaks.push({
          type: 'low',
          t0: jumps[runStart].t,
          t1: jumps[i - 1].t,
          sec: round(jumps[i - 1].t - jumps[runStart].t, 2),
          label: '幅度骤降 ×' + (i - runStart)
        });
      }
      runStart = -1;
    }
  }
  if (runStart >= 0 && jumps.length - runStart >= 2) {
    breaks.push({
      type: 'low',
      t0: jumps[runStart].t,
      t1: jumps[jumps.length - 1].t,
      sec: round(jumps[jumps.length - 1].t - jumps[runStart].t, 2),
      label: '幅度骤降 ×' + (jumps.length - runStart)
    });
  }
  breaks.sort((a, b) => a.t0 - b.t0);

  const first = jumps[0].t, last = jumps[jumps.length - 1].t;
  const activeSpan = last - first;
  const cadence = medInterval ? Math.round(60 / medInterval) : null;
  const overallCadence = activeSpan > 0 ? Math.round((jumps.length - 1) / activeSpan * 60) : null;
  const avgHeight = mean(jumps.map(j => j.heightCm));
  /* 只有一两个间隔时，「一致性」没有统计意义，宁可不给分 */
  const rhythmScore = (cv == null || goodIntervals.length < 3)
    ? null
    : clamp(Math.round(100 - cv * 180 - breaks.length * 1.5), 0, 100);

  /* ---------------- 诊断信息 ---------------- */
  const subjectPx = (() => {
    const hs = [];
    for (const s of S) {
      if (!s || !(s.span > 0)) continue;
      hs.push(s.span * vh);
    }
    return hs.length ? Math.round(pct(hs, 0.5)) : 0;
  })();

  const fullBodyRatio = okFrames.length
    ? okFrames.filter(f => (f.ankleVis == null || f.ankleVis > 0.45) && (f.shVis == null || f.shVis > 0.45)).length / frames.length
    : 0;

  const warnings = [];
  if (subjectPx > 0 && subjectPx < vh * 0.40) {
    warnings.push('人物只占画面高度 ' + Math.round(subjectPx / vh * 100) + '%，跳高换算误差会偏大；建议人占画面一半以上。');
  }
  if (fullBodyRatio < 0.75) {
    warnings.push('脚踝或肩部有 ' + Math.round((1 - fullBodyRatio) * 100) + '% 的帧没被稳定识别，计数可能漏。');
  }
  if (sampleFps < 15) {
    warnings.push('视频较长，采样率只有 ' + round(sampleFps, 1) + 'fps，快速连跳可能漏计；建议分段拍摄。');
  }

  /* ---------------- 显示用数据 ----------------
     曲线和计数用同一份 30Hz 信号，保证曲线上的峰值圆点和波形对齐；
     长视频抽稀到约 1800 点，画布和内存都不用扛几万个点。 */
  const curveStep = Math.max(1, Math.ceil(procN / 1800));
  const curve = [];
  for (let i = 0; i < procN; i += curveStep) {
    curve.push([
      round(procT(i), 3),
      sig[i] == null ? null : round(sig[i], 4),
      ankleSig[i] == null ? null : round(ankleSig[i], 4)
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

  return {
    meta: {
      subject: opt.subject || '我的跳绳视频',
      source: opt.source || '本地上传',
      tag: 'rope',
      video: video.currentSrc || video.src,
      duration: round(dur, 2),
      fps: round(sampleFps, 2),
      sampleFps: round(sampleFps, 2),
      heightCm: heightCm,
      videoAspect: round(ar, 4),
      cmPerUnit: round(cmPerUnit, 2),
      scale: round(scale, 4),
      baseline: round(centerBase, 4),
      ankleBaseline: round(ankleBase, 4),
      threshold: round((pct(sigTrend, 0.5) || 0) + enter, 4),
      subjectPx: subjectPx,
      subjectRatio: vh > 0 ? round(subjectPx / vh, 2) : 0,
      smallSubject: subjectPx > 0 && subjectPx < vh * 0.40,
      fullBodyRatio: round(fullBodyRatio, 3),
      userVideo: true,
      warnings: warnings
    },
    jumps: jumps,
    breaks: breaks,
    curve: curve,
    bundle: bundle,
    detected: okFrames.length,
    total: frames.length,
    frameSrc: frames.map(f => f.src || 'none'),
    stats: {
      count: jumps.length,
      cadence: cadence,
      overallCadence: overallCadence,
      medianInterval: medInterval == null ? null : round(medInterval, 3),
      avgInterval: meanInterval == null ? null : round(meanInterval, 3),
      cv: cv == null ? null : round(cv, 3),
      rhythmScore: rhythmScore,
      avgHeight: avgHeight == null ? null : round(avgHeight, 1),
      medianHeight: medHeight == null ? null : round(medHeight, 1),
      activeSeconds: round(activeSpan, 2),
      breakCount: breaks.length,
      firstAt: round(first, 2),
      lastAt: round(last, 2)
    }
  };
}
