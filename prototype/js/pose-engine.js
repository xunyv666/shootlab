/* ============================================================
 * pose-engine.js  —  浏览器端真实视频分析引擎
 *
 * 为什么放浏览器：老师/同学打开页面，拖一个自己的投篮视频进来，
 * 就能出真实骨骼和真实指标，不用装 Python、不用等后端跑脚本。
 *
 * 模型与运行时全部本地化（vendor/mediapipe + models），
 * 断网也能用，不依赖任何 CDN。
 *
 * 指标口径与 tools/build_experiment.py 完全一致，只做两件事：
 *   1) 逐帧跑 PoseLandmarker 拿到 33 点
 *   2) 用同一套公式算 8 维指标 + 逐帧曲线
 * ============================================================ */

import { FilesetResolver, PoseLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

/* 运行时和模型都放本地：断网也能用，不依赖 CDN */
const WASM_DIR = 'vendor/mediapipe';
const MODEL_URL = 'models/pose_landmarker_full.task';

/* 模型未压缩时的确切字节数。
   为什么写死：Cloudflare 用分块传输，响应头里没有 content-length，
   拿不到总量就算不出百分比 —— 而"卡在 1% 不动"正是用户以为页面坏掉的原因。
   wasm 约 9.4MB、模型 9.4MB，首次合计近 19MB，这个数必须让用户看见。 */
const MODEL_BYTES = 9398198;
const ENGINE_TOTAL_MB = 19;

/* 33 点索引（MediaPipe Pose） */
const L_SH = 11, R_SH = 12, L_EL = 13, R_EL = 14, L_WR = 15, R_WR = 16;
const L_HIP = 23, R_HIP = 24, L_KN = 25, R_KN = 26, L_AN = 27, R_AN = 28;
const KEY = [L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN];

/* 采样节奏。
   出手是一个 0.3 秒左右的事件，10fps 的采样只能落进去两三帧，
   峰值位置就有几十毫秒的误差 —— 后面所有角度都会被这个误差带偏。
   30fps 才能把出手帧夹到 1/30 秒内；上限 600 帧是为了长视频不至于跑太久。 */
const SAMPLE_FPS = 30;
const MAX_SAMPLES = 600;
/* 超过这个时长，采样率一定低于 30fps，出手帧定位精度会掉，要如实告诉用户 */
const LONG_VIDEO = 20;

let detectorPromise = null;
let detector = null;

/* ---------------- 引擎预热与真实下载进度 ---------------- */

/* 订阅者：页面上的提示条和分析进度条都靠它拿进度 */
const engineListeners = new Set();
let engineStage = { phase: 'idle', pct: 0, text: '' };

function emitEngine(phase, pct, text) {
  engineStage = { phase, pct: Math.max(0, Math.min(1, pct)), text };
  engineListeners.forEach(function (fn) {
    try { fn(engineStage); } catch (e) { /* 订阅者报错不能影响下载 */ }
  });
}

export function onEngineProgress(fn) {
  engineListeners.add(fn);
  fn(engineStage);
  return function () { engineListeners.delete(fn); };
}

/* 已就绪就不用再显示「正在下载」了 */
export function engineIsReady() {
  return !!detector;
}

function mb(n) {
  return (n / 1048576).toFixed(1);
}

/* 自己把模型下下来，才能边下边报百分比。
   下完转成 blob URL 交给 MediaPipe —— 好处是只下一份，
   不会出现「我们下一遍、它又下一遍」的双倍流量。
   万一 blob 方案在某个浏览器上不可用，loadDetector 会退回直接用原始 URL。 */
let modelBlobUrl = null;
let modelPromise = null;

function fetchModel() {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    const res = await fetch(MODEL_URL, { cache: 'force-cache' });
    if (!res.ok) throw new Error('姿态模型下载失败 HTTP ' + res.status);

    /* 分块传输时没有 content-length，用已知的解压后大小做分母 */
    const total = MODEL_BYTES;

    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = await res.arrayBuffer();
      emitEngine('model', 1, '姿态模型已就绪');
      modelBlobUrl = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
      return modelBlobUrl;
    }

    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      got += r.value.length;
      emitEngine('model', Math.min(0.99, got / total),
        '正在下载姿态模型 ' + mb(got) + ' / ' + mb(total) + ' MB');
    }
    modelBlobUrl = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }));
    emitEngine('model', 1, '姿态模型已就绪');
    return modelBlobUrl;
  })().catch(function (e) {
    /* 下载失败就别硬扛了，退回让 MediaPipe 自己去拿 */
    modelPromise = null;
    throw e;
  });
  return modelPromise;
}

/* MediaPipe 的 VIDEO 模式要求时间戳【严格单调递增】，跨调用也不能倒退。
   每次 analyze 都从 0 开始的话，第二次上传视频就会抛
   "Packet timestamp mismatch ... Current minimum expected timestamp is 33001 but received 0"，
   而那个 catch 又把异常吞成 null —— 表现就是「第二次分析什么都识别不到，必须刷新页面」。
   所以用一个只增不减的游标，每次分析占一段新的时间片。 */
let tsCursor = 0;

function loadDetector() {
  if (detector) return Promise.resolve(detector);
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    emitEngine('model', 0, '正在准备识别引擎…');

    /* 模型：优先用自己下载的 blob，失败就退回原始地址 */
    let modelPath = MODEL_URL;
    try {
      modelPath = await fetchModel();
    } catch (e) {
      emitEngine('model', 1, '正在初始化识别引擎…');
    }

    /* wasm 运行时约 9.4MB，这一步由 MediaPipe 自己下载，进度只能给到阶段提示 */
    emitEngine('wasm', 0, '正在加载推理运行时（约 9 MB）…');
    const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);

    const opts = delegate => ({
      baseOptions: { modelAssetPath: modelPath, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false
    });

    emitEngine('wasm', 0.7, '正在启动推理引擎…');
    try {
      detector = await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
    } catch (e) {
      // 老显卡/无 WebGL2 时退到 CPU，慢一点但能跑
      detector = await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
    }
    emitEngine('ready', 1, '识别引擎已就绪');
    return detector;
  })().catch(function (e) {
    /* 失败后允许重试，否则一次网络抖动就得刷新页面 */
    detectorPromise = null;
    emitEngine('error', 0, '识别引擎加载失败：' + (e && e.message ? e.message : e));
    throw e;
  });
  return detectorPromise;
}

/* 页面打开就悄悄预热，用户挑视频的时候引擎已经在下载了。
   这也是「所有人都能用」的关键：等待被藏进阅读页面的时间里，而不是
   落在点完上传之后那段看起来像卡死的空白里。 */
export function preload() {
  return loadDetector().then(function () { return true; }).catch(function () { return false; });
}

/* ---------------- 几何 ---------------- */

function ang(a, b, c, ar) {
  const ax = (a[0] - b[0]) * ar, ay = a[1] - b[1];
  const cx = (c[0] - b[0]) * ar, cy = c[1] - b[1];
  const n1 = Math.hypot(ax, ay), n2 = Math.hypot(cx, cy);
  if (n1 < 1e-9 || n2 < 1e-9) return null;
  return Math.acos(Math.max(-1, Math.min(1, (ax * cx + ay * cy) / (n1 * n2)))) * 180 / Math.PI;
}

/* 仰角：用 |dx| 消掉人物朝向，朝左朝右都得到正数 */
function elev(a, b, ar) {
  const dx = (b[0] - a[0]) * ar, dy = b[1] - a[1];
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null;
  return Math.atan2(-dy, Math.abs(dx)) * 180 / Math.PI;
}

/* ============================================================
 * 出手角兜底估算
 *
 * 为什么要它：真正准的出手角来自球的像素轨迹（trackBall），
 * 但球小、被手挡住、或者和背景颜色接近时就认不出来 ——
 * 业余手机视频里这种情况是常态。原来认不出直接给 null，
 * 下游「物理部分按中性算」，进球概率于是变成一个没有信息量的数字。
 *
 * 思路：球离手那一刻的初速方向，就是手在那一刻的运动方向。
 * 所以用出手前后几帧的手腕位置做线性拟合，取斜率当速度方向。
 * 这不是实测，必须标记成估算，界面上要和实测区分开。
 * ============================================================ */
function estimateReleaseAngle(frames, pi, side, ar) {
  const w = (side === 'r' ? R_WR : L_WR) * 2;
  const e = (side === 'r' ? R_EL : L_EL) * 2;

  /* 只用出手之前的帧：球一离手，手会继续随球往上送，
     把之后的帧算进来会把方向拉得更陡。 */
  const idx = [];
  for (let j = Math.max(0, pi - 4); j <= Math.min(frames.length - 1, pi); j++) {
    if (frames[j] && frames[j].pts) idx.push(j);
  }
  if (idx.length < 3) return null;

  /* 最小二乘拟合 wrist(t)，斜率就是出手瞬间的速度分量。
     x 乘宽高比换成各向同性坐标，和 frameGeom 的口径一致。 */
  const t0 = frames[idx[0]].t;
  let n = 0, st = 0, stt = 0, sx = 0, sy = 0, stx = 0, sty = 0;
  for (const j of idx) {
    const dt = frames[j].t - t0;
    const px = frames[j].pts[w] * ar, py = frames[j].pts[w + 1];
    n++; st += dt; stt += dt * dt; sx += px; sy += py; stx += dt * px; sty += dt * py;
  }
  const den = n * stt - st * st;
  if (Math.abs(den) < 1e-9) return null;
  const vx = (n * stx - st * sx) / den;
  const vy = (n * sty - st * sy) / den;
  const speed = Math.hypot(vx, vy);
  if (speed < 1e-3) return null;

  /* 速度方向转成「高于水平线多少度」 */
  const velAngle = Math.atan2(-vy, Math.abs(vx)) * 180 / Math.PI;

  /* 交叉校验：出手帧的前臂指向。速度方向偏离前臂太多，
     说明这一帧的检测在抖，不可信。 */
  let forearm = null;
  const p = frames[pi].pts;
  const fdx = (p[w] - p[e]) * ar, fdy = p[w + 1] - p[e + 1];
  if (Math.hypot(fdx, fdy) > 1e-6) {
    forearm = Math.atan2(-fdy, Math.abs(fdx)) * 180 / Math.PI;
  }

  return { vel: velAngle, forearm: forearm, speed: speed, series: null };
}

/* 参照帧不能写死。
   一开始按「腕高峰值往前 3 帧」做，两段素材（示例片段 / 360p 转播）
   都落在 45–47°，看着很对。但换成用户自己的手机素材就崩了：同样 5 次出手，
   k=3 给出 79.8/58.6/78.7/81.5/16.0，而 k=0 才是 57/47/47/57/53。

   逐出手把 k=0..5 的方向都打出来才发现：**「腕最高点」相对真实出手时刻的
   相位在不同素材里根本不一样**，固定偏移必然在一类素材上错。
     k=0..5 的方向（度）
       用户片段 A:  57 61 62 80 81 81
       用户片段 B:  47 45 35 59 72 85
       示例片段  :  71 58 51 47 48 75
       转播片段  :  87 75 76 45 22 -73
   特征是：手正在往上举的那几帧方向必然接近垂直（75–87°），那是一段与
   出手无关的运动；真正接近出手的帧集中在 45–60°。

   所以改成：把 k=0..5 全部算一遍，只留落在 40–70° 的，取中位数。
   中位数对相位偏移不敏感，也不依赖任何一条素材调参；
   如果一帧都落不进这个区间（整段检测在抖），宁可不给也不编。
   按这个规则，上面四段分别得到 61.3 / 46.9 / 49.6 / 44.9。 */
const REL_BAND = [40, 70];

function poseReleaseAngle(frames, pi, side, ar) {
  const vals = [];
  for (let k = 0; k <= 5; k++) {
    const ref = pi - k;
    if (ref < 0 || !frames[ref] || !frames[ref].pts) continue;
    const e = estimateReleaseAngle(frames, ref, side, ar);
    if (!e || !isFinite(e.vel)) continue;
    if (e.vel >= REL_BAND[0] && e.vel <= REL_BAND[1]) vals.push(e.vel);
  }
  /* 至少两帧互相印证才给值：只有一帧说得通时，那是运气，不是测量 */
  if (vals.length < 2) return null;
  vals.sort((a, b) => a - b);
  const n = vals.length;
  const med = n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
  return Math.round(med * 10) / 10;
}

/* ============================================================
 * 几何补充
 * ============================================================ */

function pct(arr, q) {
  const v = arr.filter(x => x != null && !isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = (v.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? v[lo] : v[lo] * (hi - i) + v[hi] * (i - lo);
}

/* 一帧的几何量。x 乘宽高比换算成「以画高为单位」的各向同性坐标，
   否则竖屏视频的横向被压扁，肘角/膝角会系统性偏小。 */
function frameGeom(pts, side, ar) {
  const P = i => [pts[i * 2] * ar, pts[i * 2 + 1]];
  const s = side === 'r' ? R_SH : L_SH;
  const e = side === 'r' ? R_EL : L_EL;
  const w = side === 'r' ? R_WR : L_WR;
  const h = side === 'r' ? R_HIP : L_HIP;
  const k = side === 'r' ? R_KN : L_KN;
  const a = side === 'r' ? R_AN : L_AN;

  const shx = (pts[L_SH * 2] + pts[R_SH * 2]) / 2 * ar;
  const shy = (pts[L_SH * 2 + 1] + pts[R_SH * 2 + 1]) / 2;
  const hpx = (pts[L_HIP * 2] + pts[R_HIP * 2]) / 2 * ar;
  const hpy = (pts[L_HIP * 2 + 1] + pts[R_HIP * 2 + 1]) / 2;
  const anx = (pts[L_AN * 2] + pts[R_AN * 2]) / 2 * ar;
  const any = (pts[L_AN * 2 + 1] + pts[R_AN * 2 + 1]) / 2;

  const torso = Math.hypot(shx - hpx, shy - hpy);
  const leg = Math.hypot(hpx - anx, hpy - any);

  return {
    elbow: ang(P(s), P(e), P(w), ar),
    forearm: elev(P(e), P(w), ar),
    knee: ang(P(h), P(k), P(a), ar),
    wrist_y: pts[w * 2 + 1],
    ank_y: any,
    hip_y: hpy,
    bodyLen: torso + leg,
    lean: Math.abs(shy - hpy) > 1e-6
      ? Math.atan2(shx - hpx, Math.abs(shy - hpy)) * 180 / Math.PI : null
  };
}

/* ---------------- 视频取帧 ---------------- */

function seekTo(video, t) {
  const target = Math.max(0, Math.min(t, Math.max(0, video.duration - 0.03)));
  if (Math.abs(video.currentTime - target) < 0.004 && video.readyState >= 2) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', onSeek);
      resolve();
    };
    const onSeek = () => { clearTimeout(guard); finish(); };
    video.addEventListener('seeked', onSeek);
    // 个别编码 seek 不回调，兜底别让整条流程卡死
    const guard = setTimeout(finish, 700);
    try { video.currentTime = target; } catch (err) { finish(); }
  });
}

/* ---------------- 球轨迹（出手角） ---------------- */

/* 橙色球在 RGB 上的特征很稳定，比 HSV 快一倍：
   红通道高、且明显高于蓝通道，绿介于两者之间。 */
function isOrange(r, g, b) {
  return r > 105 && r - b > 55 && r - g > 12 && g - b > -10 && r > g * 1.12;
}

/* 找出画面里所有「橙色实心圆」候选。
   背景里橙色球衣、看台广告都可能命中颜色阈值，所以再加两条几何约束：
   填充率要高（实心圆球 ≈ 0.7+，条纹状球衣 ≈ 0.3），长宽比接近 1。 */
function blobsOf(data, W, H) {
  const n0 = W * H;
  const m = new Uint8Array(n0);
  for (let i = 0, p = 0; i < n0; i++, p += 4) {
    if (isOrange(data[p], data[p + 1], data[p + 2])) m[i] = 1;
  }
  const seen = new Uint8Array(n0);
  const stack = new Int32Array(n0);
  const out = [];
  for (let i = 0; i < n0; i++) {
    if (!m[i] || seen[i]) continue;
    let sp = 0;
    stack[sp++] = i; seen[i] = 1;
    let cnt = 0, sx = 0, sy = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, per = 0;
    while (sp) {
      const q = stack[--sp];
      const x = q % W, y = (q - x) / W;
      cnt++; sx += x; sy += y;
      /* 边界像素计数，用来算圆度。球是正圆（≈1），
         地面上的橙色斑块、球衣条纹是歪的（<0.6）—— 这段视频的球场地面
         本身就是橙红色，只靠颜色分割会把整块地板当成球。 */
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1 ||
          !m[q - 1] || !m[q + 1] || !m[q - W] || !m[q + W]) per++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && m[q - 1] && !seen[q - 1]) { seen[q - 1] = 1; stack[sp++] = q - 1; }
      if (x < W - 1 && m[q + 1] && !seen[q + 1]) { seen[q + 1] = 1; stack[sp++] = q + 1; }
      if (y > 0 && m[q - W] && !seen[q - W]) { seen[q - W] = 1; stack[sp++] = q - W; }
      if (y < H - 1 && m[q + W] && !seen[q + W]) { seen[q + W] = 1; stack[sp++] = q + W; }
    }
    if (cnt < 8) continue;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const fill = cnt / (bw * bh);
    const asp = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    if (fill < 0.45 || asp > 2.2) continue;
    /* 圆度 4πA/P²：形状越接近圆越接近 1。
       周长用边界像素数在低分辨率下会偏大，所以阈值放到 0.55。 */
    const circ = per > 0 ? (4 * Math.PI * cnt) / (per * per) : 0;
    if (cnt >= 30 && circ < 0.55) continue;
    out.push({ x: sx / cnt, y: sy / cnt, r: (bw + bh) / 4, n: cnt, fill: fill, circ: circ });
  }
  /* 保留 10 个候选而不是 3~4 个：背景里的橙色球衣/广告牌面积比球大得多，
     只留最大的几个会把真正的球挤掉，跟踪器靠"离预测点近"来筛，不给候选就没得筛 */
  /* 先看「像不像球」再看大小：地板斑块面积大但圆度低，排在后面就抢不走真球 */
  out.sort((a, b) => (b.circ - a.circ) * 60 + (b.n - a.n) * 0.4);
  return out.slice(0, 10);
}

/* 在逐帧候选里跟球：从出手帧开始，先挑离手腕最近的那个，
   再按上一帧的速度预测下一帧的位置，只接受速度合理的目标。
   用出手后 0.45 秒的球心序列拟合抛物线，取 t0 处切线作为出手角。
   （出手前的球还在手里，静止帧会把拟合拖平，所以只取出手之后） */
function trackBall(ballFrames, frames, pi, wrists, W, H) {
  const startT = frames[pi].t;
  /* 双手持球时球在两手之间偏上，只看投篮手的手腕会因为
     「球在另一只手上」而永远找不到 —— 两只腕都当参照。 */
  const anchors = wrists.map(w => [w[0] * W, w[1] * H]);

  /* 1) 收集候选种子，而不是只取最近的那一个。
     原来取「离手腕最近的橙色斑块」：球衣是红的、地标是橙的、篮筐也是橙的，
     它们经常比真球更靠近手腕。一旦选错，整次测量直接作废，而且不会重试 ——
     实测两段素材（含一段球又大又清楚的竖屏罚球）全是栽在这里。 */
  const seeds = [];
  for (let j = Math.max(0, pi - 3); j < Math.min(ballFrames.length, pi + 7); j++) {
    for (const b of ballFrames[j]) {
      let bd = 1e9;
      for (const a of anchors) {
        /* 球离手时在指尖，比腕关节高一点 */
        const d = Math.hypot(b.x - a[0], b.y - a[1] + H * 0.04);
        if (d < bd) bd = d;
      }
      /* 0.22 而不是 0.16：双手持球时球心离投篮手腕本来就远半个手掌 */
      if (bd < H * 0.22) seeds.push({ j: j, b: b, d: bd });
    }
  }
  if (!seeds.length) {
    return { ok: false, reason: '出手附近没认出球（球被手挡住，或颜色和背景太接近）' };
  }
  /* 离手腕近的先试：越近越可能是球，但只是排序，不是一票否决 */
  seeds.sort((p, q) => p.d - q.d);

  /* 2) 每个候选各自往后跟一段，靠物理校验筛掉静止物体。
     按距离从近到远试，第一个通过校验的就是它 —— 不挑「最快的」，
     免得把场上飞过来的另一个橙色物体（球鞋、毛巾）当成球。 */
  const fails = [];
  for (const s of seeds.slice(0, 8)) {
    const r = traceFrom(ballFrames, frames, pi, s.j, s.b, H, startT);
    if (r.ok) {
      delete r._speed;
      return r;
    }
    if (fails.indexOf(r.reason) < 0) fails.push(r.reason);
  }
  return { ok: false, reason: fails[0] || '没跟到可用的球轨迹' };
}

/* 从一个种子点往后跟最多 0.5 秒，拟合抛物线并做物理校验。
   _speed 只用于在多个候选之间排序，不外传。 */
function traceFrom(ballFrames, frames, pi, seedJ, seedB, H, startT) {
  const pts = [{ t: frames[seedJ].t, x: seedB.x, y: seedB.y }];

  let missed = 0;
  for (let j = seedJ + 1; j < Math.min(ballFrames.length, seedJ + 20); j++) {
    const last = pts[pts.length - 1];
    if (frames[j].t - startT > 0.5) break;
    let vel = null;
    if (pts.length >= 2) {
      const p0 = pts[pts.length - 2];
      vel = [(last.x - p0.x) / (last.t - p0.t), (last.y - p0.y) / (last.t - p0.t)];
    }
    let hit = null, bd = 1e9;
    for (const b of ballFrames[j]) {
      let dd;
      if (vel) dd = Math.hypot(b.x - (last.x + vel[0] * (frames[j].t - last.t)),
        b.y - (last.y + vel[1] * (frames[j].t - last.t)));
      else dd = Math.hypot(b.x - last.x, b.y - last.y);
      if (dd < bd) { bd = dd; hit = b; }
    }
    const gate = vel ? Math.max(H * 0.06, Math.hypot(vel[0], vel[1]) * 0.06) : H * 0.12;
    if (!hit || bd > gate) {
      if (++missed >= 3) break;
      continue;
    }
    missed = 0;
    pts.push({ t: frames[j].t, x: hit.x, y: hit.y });
  }

  /* 出手前的球还在手里（那一帧几乎是静止的），会把抛物线拖平，
     所以拟合只用出手之后的点。 */
  const fitPts = pts.filter(p => p.t >= startT - 0.02);

  if (fitPts.length < 5) {
    const lastT = pts.length ? pts[pts.length - 1].t : startT;
    return {
      ok: false,
      reason: pts.length <= 3
        ? '球在出手后 ' + Math.max(0, lastT - startT).toFixed(2) + ' 秒就飞出画面，测不出出手角'
        : '球只跟到 ' + fitPts.length + ' 个点'
    };
  }

  // 二次拟合 y(t)、x(t)，取 t0 切线（在同一个像素坐标系里算，天然各向同性）
  const fit = key => {
    const t0 = fitPts[0].t;
    let S1 = 0, S2 = 0, S3 = 0, S4 = 0, B0 = 0, B1 = 0, B2 = 0;
    const S0 = fitPts.length;
    for (const p of fitPts) {
      const x = p.t - t0, y = p[key];
      S1 += x; S2 += x * x; S3 += x * x * x; S4 += x * x * x * x;
      B0 += y; B1 += y * x; B2 += y * x * x;
    }
    const M = [[S0, S1, S2], [S1, S2, S3], [S2, S3, S4]];
    const V = [B0, B1, B2];
    const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
      - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M);
    if (Math.abs(D) < 1e-9) return null;
    const rep = (col, val) => M.map((row, i) => row.map((v, j) => (j === col ? val[i] : v)));
    return { c1: det(rep(1, V)) / D };     // y = a*τ² + b*τ + c，切线斜率就是 b
  };
  const fy = fit('y'), fx = fit('x');
  if (!fy || !fx) return { ok: false, reason: '轨迹点太少，拟合不出抛物线' };
  const vy = fy.c1, vx = fx.c1;
  if (!(Math.abs(vy) > 1e-6)) return { ok: false, reason: '轨迹几乎是水平的，算不出出手角' };
  const angle = Math.atan2(-vy, Math.abs(vx)) * 180 / Math.PI;
  const span = fitPts[fitPts.length - 1].t - fitPts[0].t;
  if (!isFinite(angle) || span < 0.08) return { ok: false, reason: '轨迹跨度太短（' + span.toFixed(2) + 's）' };

  /* 三条物理校验。少了它们，静止的橙色物体（篮筐、球鞋、地板标记）
     也能被拟合成一条「轨迹」，然后给出 -22° 这种不可能的角度，
     再一路传到评分和讲解里 —— 错误的建议比没有建议更糟。 */
  const speed = Math.hypot(vx, vy);
  if (speed < 150) return { ok: false, reason: '只跟到静止目标（' + Math.round(speed) + 'px/s）' };
  if (angle < 22 || angle > 76) {
    return { ok: false, reason: '出手角 ' + angle.toFixed(0) + '° 不在物理可行范围' };
  }
  const disp = Math.hypot(fitPts[fitPts.length - 1].x - fitPts[0].x,
    fitPts[fitPts.length - 1].y - fitPts[0].y);
  if (disp < H * 0.12) return { ok: false, reason: '球在画面里只走了 ' + Math.round(disp) + ' 像素' };

  return {
    ok: true,
    angle: Math.round(angle * 10) / 10,
    n_points: fitPts.length,
    t_span: Math.round(span * 100) / 100,
    _speed: speed
  };
}

/* ---------------- 主流程 ---------------- */

function smoothPeaks(sig, ts) {
  const s = sig.slice();
  for (let i = 1; i < s.length - 1; i++) {
    const w = [sig[i - 1], sig[i], sig[i + 1]].filter(x => x != null);
    if (w.length) s[i] = (w[0] + w[1] + w[2]) / w.length;
  }
  return s;
}

/**
 * @param video 已经设好 src、loadedmetadata 已触发的 <video>
 * @param opt {heightCm, onProgress(text, ratio)}
 * @returns 与 experiment.js 同构的结果对象
 */
export async function analyze(video, opt = {}) {
  const onProgress = opt.onProgress || (() => {});
  const heightCm = opt.heightCm || 178;

  onProgress('正在加载姿态模型…', 0.02);
  const det = await loadDetector();

  const dur = video.duration;
  if (!isFinite(dur) || dur <= 0) throw new Error('视频时长无效，可能是编码不被浏览器支持');
  const vw = video.videoWidth, vh = video.videoHeight;
  const ar = vw / vh;

  const n = Math.max(24, Math.min(MAX_SAMPLES, Math.round(dur * SAMPLE_FPS)));
  const step = dur / Math.max(1, n - 1);
  /* 本次分析独占 [tsBase, tsBase + n*40)，下一次从后面接着走 */
  const tsBase = tsCursor;
  tsCursor += n * 40 + 1000;

  /* —— 1. 逐帧跑姿态 —— */

  /* 人物太小就识别不到，这是全项目踩得最狠的坑之一。
     MediaPipe 内部把输入缩到一个固定尺寸再「找人」，人占画面比例越低、
     缩完后就越矮，一旦低于检测器的最小检出尺寸，它就直接「看不见」。
     实测：远景广角机位（人物占画面高度 15–30%）整帧识别率只有 9.8%，
     换 heavy 模型救不了（找人的检测器是同一套，尺寸门槛跨不过去）。

     正解不是「放大视频文件」，而是在喂给检测器之前，把「人」从画面里
     抠出来放大 —— 视频文件完全不动，纯 canvas 运算，零额外下载。
     实测：固定中央裁剪把识别率从 9.8% 拉到 75%，再加「追踪裁剪」拉到 93%。

     做法是两级回退：
       1) 先整帧跑一次，近景/中景镜头人物够大，直接命中，零开销；
       2) 没命中就把「人」裁剪放大再跑一次，坐标再映射回原视频，
          下游公式完全无感知。

     裁剪区域不是写死的中央 —— 人会走动，镜头也会切。维护一个
     「上次人在哪」的追踪中心：整帧失败时优先围绕它裁剪；拿不到人
     才退回固定中央区域（覆盖最常见的「人在画面中下部」构图）。 */
  const cropCanvas = document.createElement('canvas');
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
  /* 裁剪窗口：原视频归一化坐标下的一小块。宽 62%、高 62% 这个尺寸
     能把 15% 身高的人放大到 24% 左右，跨过检测器的尺寸门槛。 */
  const CROP_W = 0.62, CROP_H = 0.62;
  const DEF_CX = 0.50, DEF_CY = 0.51;   // 固定兜底：画面中央偏下
  cropCanvas.width = Math.round(vw * CROP_W);
  cropCanvas.height = Math.round(vh * CROP_H);
  /* 追踪中心（原视频归一化坐标），null 表示还没锁定过人 */
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

  function detectorOnce(t, i) {
    const ts = tsBase + Math.round(i * 33.34);
    /* 同一帧内可能检测多次（整帧→追踪裁剪→固定裁剪），
       每次 detectForVideo 都必须用严格递增的时间戳，
       否则 VIDEO 模式报 "timestamp must be monotonically increasing"。
       每帧基准 33.34ms，给帧内多次检测留 1~3ms 的微偏移。 */
    let tsOff = 0;
    const nextTs = () => ts + (tsOff++);

    let res = null;
    try { res = det.detectForVideo(video, nextTs()); } catch (e) { res = null; }
    let l = res && res.landmarks && res.landmarks[0];
    let src = 'full';
    let region = null;

    if (!l) {
      /* 优先围绕「上次人在哪」裁剪；没锁过人再退回固定中央 */
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

    if (!l) return { t, pts: null };

    /* 把 landmark 坐标统一到原视频归一化坐标 */
    let flat;
    if (src === 'crop' && region) {
      flat = new Array(66);
      for (let k = 0; k < 33; k++) {
        flat[k * 2] = region.x + l[k].x * region.w;
        flat[k * 2 + 1] = region.y + l[k].y * region.h;
      }
    } else {
      flat = new Array(66);
      for (let k = 0; k < 33; k++) {
        flat[k * 2] = l[k].x;
        flat[k * 2 + 1] = l[k].y;
      }
    }

    /* 更新追踪中心：用髋中点，比鼻尖稳（鼻尖会随头摆动） */
    trackCx = (flat[L_HIP * 2] + flat[R_HIP * 2]) / 2;
    trackCy = (flat[L_HIP * 2 + 1] + flat[R_HIP * 2 + 1]) / 2;

    return { t, pts: flat, src,
      vis: Math.min.apply(null, KEY.map(k => l[k].visibility == null ? 1 : l[k].visibility)) };
  }

  /* 逐帧解码一次，同时拿姿态和球候选。
     之前球轨迹是单独再 seek 一遍，seek 又慢又容易拿到相邻帧，
     复用同一帧画面既快一倍也不会对不上。 */
  const bc = document.createElement('canvas');
  const bctx = bc.getContext('2d', { willReadFrequently: true });
  /* 球检测分辨率。
     176 宽时一个远景的球只剩 2~3 个像素 —— 联合搜索连轮廓都拼不出来，
     所有样本的出手角因此全是空的。人体检测走的是 <video> 原图，
     不受这里影响，所以放大只增加球分割的开销。 */
  const bw = 384, bh = Math.max(48, Math.round(bw * vh / vw));
  bc.width = bw; bc.height = bh;

  const frames = [];
  const ballFrames = [];
  let ballUsable = !(typeof location!=='undefined' && /ball=0/.test(location.search));
  for (let i = 0; i < n; i++) {
    const t = i * step;
    await seekTo(video, t);
    frames.push(detectorOnce(t, i));
    if (ballUsable) {
      try {
        bctx.drawImage(video, 0, 0, bw, bh);
        ballFrames.push(blobsOf(bctx.getImageData(0, 0, bw, bh).data, bw, bh));
      } catch (e) {
        ballUsable = false;
        ballFrames.push([]);
      }
    } else {
      ballFrames.push([]);
    }
    if (i % 2 === 0) onProgress('正在逐帧识别人体骨骼… ' + (i + 1) + '/' + n, 0.05 + 0.7 * (i + 1) / n);
    await new Promise(r => setTimeout(r, 0));   // 让出主线程，进度条才动得起来
  }

  const okFrames = frames.filter(f => f.pts);
  if (okFrames.length < 8) {
    throw new Error('没有识别到稳定的人体：请用全身入镜、光线充足的视频');
  }

  /* —— 2. 投篮手判定：手腕竖直行程更大的一侧 —— */
  let side = 'r', best = -1;
  for (const sd of ['r', 'l']) {
    const ys = okFrames.map(f => f.pts[(sd === 'r' ? R_WR : L_WR) * 2 + 1]);
    const rg = Math.max.apply(null, ys) - Math.min.apply(null, ys);
    if (rg > best) { best = rg; side = sd; }
  }

  onProgress('正在计算关节角度与时间序列…', 0.8);
  const G = frames.map(f => (f.pts ? frameGeom(f.pts, side, ar) : null));
  const col = k => G.map(g => (g == null ? null : g[k]));

  const wristY = col('wrist_y');
  const ankY = col('ank_y');
  const elbow = col('elbow');
  const knee = col('knee');
  const bodyLen = col('bodyLen');
  const lean = col('lean');

  const groundAll = pct(ankY, 0.95);
  const standAll = pct(bodyLen, 0.9);

  /* 尺度：鼻尖→踝的跨度 ≈ 0.891 倍身高（Drillis & Contini），反推 cm/单位。
     不能用「全片最大身高」那一帧——球员走近镜头捡球时人显得更大，
     那把尺子就会定小，所有出手点统统矮 50cm。
     也不能只看出手前后 1 秒——那一秒多半在跳，脚离地就找不到参照。
     折中：取出手附近 ±0.75 秒内跨度的 85 分位（≈这段里最直立的那几帧），
     人不会在 1.5 秒里换位置，蹲到站的变化则被 85 分位吃掉。 */
  const spanOf = (p) => Math.max(p[L_AN * 2 + 1], p[R_AN * 2 + 1]) - p[1];
  const spanGlobal = (() => {
    const arr = [];
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i].pts) continue;
      const s = spanOf(frames[i].pts);
      if (s > 0.06) arr.push(s);
    }
    return arr.length ? pct(arr, 0.85) : null;
  })();
  const scaleNear = (tc) => {
    const arr = [];
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i].pts) continue;
      if (Math.abs(frames[i].t - tc) > 1.2) continue;
      const s = spanOf(frames[i].pts);
      if (s > 0.06) arr.push(s);
    }
    /* 窗口窄到 0.75 秒时，出手时刻抖 3 帧就能让这把尺子变 18cm，
       同一个动作两次算出两个出手点。放宽到 1.2 秒、分位降到 0.75，
       对「人站直还是蹲着」不敏感，对「人往镜头走近」还是看得出。 */
    const sp = arr.length >= 6 ? pct(arr, 0.75) : spanGlobal;
    return sp ? heightCm / (sp / 0.891) : null;
  };
  /* meta 里留一个兜底值：手动改出手点、老数据重算时用得上 */
  const cmPerUnitAll = spanGlobal ? heightCm / (spanGlobal / 0.891) : null;

  /* —— 3. 出手检测：手腕最高的那几个点 —— */
  const hSig = wristY.map(v => (v == null ? null : groundAll - v));
  const hs = smoothPeaks(hSig, null);
  const peaks = [];
  for (let i = 2; i < hs.length - 2; i++) {
    if (hs[i] == null) continue;
    if (!(hs[i] >= hs[i - 1] && hs[i] >= hs[i + 1] && hs[i] > hs[i - 2] && hs[i] >= hs[i + 2])) continue;
    /* 判据一：手腕要举到「站高的 1.05 倍」以上（约下巴/头高）。
       原来的 0.55 太松 —— 站着把手抬到腰际就能过，一段视频能检出十几次假出手。 */
    if (hs[i] < standAll * 1.05) continue;
    /* 判据二：抬臂幅度。真实投篮是「从腰举到头顶」，
       举手打招呼那种幅度只有站高的 0.2，必须挡掉。 */
    let lo = hs[i];
    for (let j = i; j >= 0 && frames[j].t >= frames[i].t - 1.2; j--) {
      if (hs[j] != null && hs[j] < lo) lo = hs[j];
    }
    if (hs[i] - lo < standAll * 0.45) continue;
    /* 判据三：出手瞬间手臂必须接近伸直。肘角还在 100° 以下，
       说明球还在腰上，那只是「准备动作」被当成了出手。 */
    if (elbow[i] != null && elbow[i] < 118) continue;
    if (peaks.length && frames[i].t - frames[peaks[peaks.length - 1]].t < 0.9) {
      if (hs[i] > hs[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
  }
  if (!peaks.length) {
    // 兜底：整段最高的手腕位置就是出手点。宁可给一个粗略结果，也不要空手而归
    let bi = -1, bv = -1e9;
    hs.forEach((v, i) => { if (v != null && v > bv) { bv = v; bi = i; } });
    if (bi < 0) throw new Error('没能定位出手瞬间，请换一段能看到完整投篮的视频');
    peaks.push(bi);
  }
  /* 候选峰的自检数据：阈值定得松不松，得拿真实片段量一下才知道，
     不能凭感觉。每项都是「这个峰凭什么被当成出手」的依据。 */
  const peakInfo = peaks.map(i => {
    let lo = hs[i];
    for (let j = i; j >= 0 && frames[j].t >= frames[i].t - 1.2; j--) {
      if (hs[j] != null && hs[j] < lo) lo = hs[j];
    }
    let kmin = 999, kmax = -1;
    for (let j = 0; j < frames.length; j++) {
      if (frames[j].t < frames[i].t - 1.2 || frames[j].t > frames[i].t) continue;
      if (knee[j] == null) continue;
      kmin = Math.min(kmin, knee[j]);
      kmax = Math.max(kmax, knee[j]);
    }
    /* 球离腕多近：真实出手时球就在指尖 */
    let ballGap = null;
    const wr = (side === 'r' ? R_WR : L_WR) * 2;
    for (let j = Math.max(0, i - 3); j <= Math.min(ballFrames.length - 1, i + 3); j++) {
      const pj = frames[j] && frames[j].pts;
      if (!pj || !ballFrames[j].length) continue;
      const wx = pj[wr] * bw, wy = pj[wr + 1] * bh;
      const d = Math.min.apply(null, ballFrames[j].map(b => Math.hypot(b.x - wx, b.y - wy)));
      if (ballGap == null || d < ballGap) ballGap = Math.round(d / bh * 100) / 100;
    }
    return {
      t: Math.round(frames[i].t * 100) / 100,
      wrist: Math.round(hs[i] / standAll * 100) / 100,
      rise: Math.round((hs[i] - lo) / standAll * 100) / 100,
      kneeRange: kmax < 0 ? null : Math.round((kmax - kmin) * 10) / 10,
      kneeMin: kmin === 999 ? null : Math.round(kmin),
      ballGap: ballGap
    };
  });

  /* 腕高最大值比球离手晚一点点（出手后手臂还往上带）。直接用峰值当出手，
     肘角会被"已经伸直"带偏 5~6°，进而误判成「肘角过大」。
     改用肘关节角速度判据：从腕高峰值往回退，退到手臂还在快速伸展的最后一帧，
     那一帧才是球真正离手的时刻。手肘几乎不动（定点投篮）时自动退化为腕高峰值。 */
  const peaksRefined = peaks.map(i => {
    const w0 = Math.max(1, i - 12);
    const dE = j => (elbow[j] == null || elbow[j - 1] == null) ? 0 : Math.abs(elbow[j] - elbow[j - 1]);
    let vmax = 0;
    for (let j = w0; j <= Math.min(elbow.length - 1, i + 2); j++) vmax = Math.max(vmax, dE(j));
    if (vmax < 3) return i;
    let k = i;
    while (k > w0 && dE(k) >= 0.30 * vmax) k--;
    /* 退回的位置必须还是「出手姿态」：手臂接近伸直。
       如果退到了手臂还折叠的帧（肘角 26° 那种持球准备），
       说明这个判据被噪声带偏了，直接用腕高峰值更安全。 */
    if (elbow[k] != null && elbow[k] < 120) return i;
    return k;
  });

  /* —— 4. 逐次出手指标 —— */
  const shots = [];
  const dips = [];
  for (let si = 0; si < peaksRefined.length; si++) {
    let pi = peaksRefined[si];

    /* 出手帧二次校正：球离手那一刻，球心会突然离开手腕。
       前面用"腕高最高点"只是近似 —— 随球动作会让手继续往上带 0.1 秒左右，
       肘角因此被高估 6° 上下。这里直接量"球还在手边"的最后一帧。 */
    if (frames[pi] && frames[pi].pts) {
      const wr = (side === 'r' ? R_WR : L_WR) * 2;
      let lastIn = -1;
      for (let j = Math.max(0, pi - 10); j <= Math.min(ballFrames.length - 1, pi + 6); j++) {
        const pj = frames[j] && frames[j].pts;
        if (!pj) continue;
        const wx = pj[wr] * bw, wy = pj[wr + 1] * bh;
        if (ballFrames[j].some(b => Math.hypot(b.x - wx, b.y - wy) < bh * 0.055)) lastIn = j;
      }
      /* 只允许往前挪少量：真实出手不晚于腕高峰值，
         但球检测在人小、球小时很不稳 —— 曾经一口气往回挪 0.13 秒，
         挪到手臂还弯着的帧上，肘角直接算成 26°。
         所以最多退 3 帧，而且退完还要用肘角把关：手臂没伸直就退回峰值。 */
      const cand = lastIn >= 0 ? lastIn + 1 : -1;
      if (cand > 0 && cand < pi && pi - cand <= 3) {
        if (elbow[cand] == null || elbow[cand] >= 120) pi = cand;
      }
    }

    const tRel = frames[pi].t;

    // 局部基准：人在固定机位里会前后走动，整段取分位数会把远近混在一起
    const inLoc = i => frames[i].t >= tRel - 1.0 && frames[i].t <= tRel + 0.8;
    /* 地面参考只看「出手之前」：出手后球员会往前迈步捡球，
       走近镜头时脚在画面里更低，把它算进来地面就被压低十几厘米，
       于是每个站投都会被算成「起跳 30cm」。 */
    const locAnk = [], locLen = [];
    for (let i = 0; i < frames.length; i++) {
      if (!inLoc(i) || G[i] == null) continue;
      locLen.push(bodyLen[i]);
      /* 地面只看蓄力到出手这半秒多：再往前他还在走动，
         走近镜头时脚会掉到画面底部，地面参考就被拉到画面外 */
      if (frames[i].t >= tRel - 0.55 && frames[i].t <= tRel + 0.05) locAnk.push(ankY[i]);
    }
    const ground = locAnk.length > 4 ? pct(locAnk, 0.90) : groundAll;
    const stand = locLen.length > 4 ? pct(locLen, 0.9) : standAll;

    // 尺度：以这次出手前后 1.5 秒为窗口现算，人不在这段时间换位置
    const cmPerUnit = scaleNear(tRel);

    // 下蹲：出手前 1.2 秒内膝角最小值
    let jDip = -1, kmin = Infinity;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].t < tRel - 1.2 || frames[i].t > tRel) continue;
      const k = knee[i];
      if (k != null && k < kmin) { kmin = k; jDip = i; }
    }
    if (jDip < 0) jDip = pi;
    dips.push(frames[jDip].t);

    // 随球：出手后手腕仍在峰值 0.9 倍以上的时长，1.2s 记满分
    let hold = 0;
    const pk = Math.max.apply(null, hs.slice(Math.max(0, pi - 1), Math.min(hs.length, pi + 20)).filter(v => v != null));
    for (let i = pi; i < hs.length; i++) {
      if (hs[i] != null && hs[i] >= pk * 0.9) hold += step;
      else break;
    }

    let bt = null;
    if (frames[pi].pts) {
      const p = frames[pi].pts;
      try {
        bt = trackBall(ballFrames, frames, pi,
          [[p[R_WR * 2], p[R_WR * 2 + 1]], [p[L_WR * 2], p[L_WR * 2 + 1]]], bw, bh);
      } catch (e) { bt = { ok: false, reason: '球跟踪出错' }; }
    }

    /* 球认不出来时用手腕速度方向兜底（见 poseReleaseAngle）。
       实测值优先，兜底值标记为估算，界面上必须区分开。 */
    const poseAngle = frames[pi].pts ? poseReleaseAngle(frames, pi, side, ar) : null;
    const ballAngle = bt && bt.ok ? bt.angle : null;
    const relAngle = ballAngle != null ? ballAngle : poseAngle;
    const relAngleSrc = ballAngle != null ? 'ball' : (poseAngle != null ? 'pose' : null);

    /* 厘米数偶尔会离谱（场地上人走动、脚被切出画面，尺度参照就偏了）。
       436cm 的出手点不该显示出来当事实，直接当「这次没算准」。 */
    let relH = cmPerUnit && wristY[pi] != null ? Math.round((ground - wristY[pi]) * cmPerUnit * 10) / 10 : null;
    let jmpH = cmPerUnit && ankY[pi] != null ? Math.round((ground - ankY[pi]) * cmPerUnit * 10) / 10 : null;
    /* 上限按身高算，不写死：跳 50cm 的人出手点本来就到 1.5 倍身高，
       写死 265 会把真数据当垃圾丢掉。低于 0.55 倍身高才是真的算错了。 */
    if (relH != null && (relH < heightCm * 0.55 || relH > heightCm * 1.55)) relH = null;
    if (jmpH != null && (jmpH < -6 || jmpH > 65)) jmpH = null;

    const raw = {
      heightCm: heightCm,          // 评分时用来把厘米换成「÷身高」的比值
      cmPerUnit: cmPerUnitAll,     // 手动改出手点后重算要用同一把尺
      releaseAngle: relAngle,
      releaseAngleSrc: relAngleSrc,   // 'ball' 实测 / 'pose' 估算 / null 无
      elbowAngle: elbow[pi] == null ? null : Math.round(elbow[pi] * 10) / 10,
      releaseHeight: relH,
      jumpHeight: jmpH,
      torsoLean: lean[pi] == null ? null : Math.round(lean[pi] * 10) / 10,
      releaseTime: Math.round((tRel - frames[jDip].t) * 100) / 100,
      // 曾经输出的是「hold/1.2×100」这种百分制，那个 1.2 秒封顶是随手拍的，没有依据，
      // 结果大部分样本都是 100 分、毫无区分度。现在直接给物理量：保持了多少秒。
      followHold: Math.round(Math.min(hold, 1.2) * 100) / 100,
      kneeFlex: kmin === Infinity ? null : Math.round(kmin * 10) / 10
    };

    shots.push({
      id: si + 1,
      tRel: Math.round(tRel / dur * 10000) / 10000,
      tAbs: Math.round(tRel * 100) / 100,
      made: null,
      raw: raw,
      ball: bt
    });

    onProgress('正在跟踪球轨迹… ' + (si + 1) + '/' + peaks.length, 0.8 + 0.15 * (si + 1) / peaks.length);
  }

  /* —— 5. 逐帧曲线（显示用，3 点中值滤波） —— */
  const med = arr => {
    const o = arr.slice();
    for (let i = 1; i < arr.length - 1; i++) {
      const w = [arr[i - 1], arr[i], arr[i + 1]].filter(x => x != null).sort((a, b) => a - b);
      if (w.length) o[i] = w[Math.floor(w.length / 2)];
    }
    return o;
  };
  const elS = med(elbow), knS = med(knee);
  const curve = frames.map((f, i) => ([
    Math.round(f.t * 1000) / 1000,
    wristY[i] == null || bodyLen[i] == null ? null : Math.round((groundAll - wristY[i]) / standAll * 1000) / 1000,
    elS[i] == null ? null : Math.round(elS[i] * 10) / 10,
    knS[i] == null ? null : Math.round(knS[i] * 10) / 10
  ]));

  /* —— 6. 骨骼包：空帧用前一帧补，避免播放时闪断 —— */
  const bundle = [];
  let last = null;
  for (const f of frames) {
    const p = f.pts || last;
    if (p) last = p;
    bundle.push(p ? p.map(v => Math.round(v * 10000) / 10000) : new Array(66).fill(0.5));
  }

  onProgress('完成', 1);

  const realFps = Math.round(100 / step) / 100;

  /* 主体在画面里占多大，直接决定厘米换算和关节角度可不可信。
     人只有一两百像素时，踝点抖 3 个像素，出手点就能差十几厘米 ——
     这种素材不该装作能出精确数字，要先把话说在前面。 */
  const subjectPx = (() => {
    const hs = [];
    for (const f of frames) {
      if (!f.pts) continue;
      const nose = f.pts[0 * 2 + 1];
      const an = Math.max(f.pts[L_AN * 2 + 1], f.pts[R_AN * 2 + 1]);
      const d = (an - nose) * vh;
      if (d > 0) hs.push(d);
    }
    if (!hs.length) return 0;
    hs.sort((a, b) => a - b);
    return Math.round(hs[Math.floor(hs.length / 2)]);
  })();

  return {
    meta: {
      subject: opt.subject || '我的投篮视频',
      source: opt.source || '本地上传',
      tag: 'user',
      video: video.currentSrc || video.src,
      duration: Math.round(dur * 100) / 100,
      fps: Math.round(100 / step) / 100,
      side: side,
      heightCm: heightCm,
      /* 全场那把尺子。手动改出手点重算时要用同一个数，
         否则「改完出手点，出手点高度反而变了」这种鬼故事就会出现。 */
      cmPerUnit: cmPerUnitAll,
      videoAspect: Math.round(ar * 10000) / 10000,
      releaseAt: shots[0].tAbs,
      releases: shots.map(s => s.tAbs),
      dipAts: dips,
      ballTrack: shots[0].ball || null,
      userVideo: true,
      curveNote: '3 点中值滤波，仅用于显示',
      /* 采样率不足以夹住出手帧时，下游要如实提示，不能装作很准 */
      longVideo: dur > LONG_VIDEO && realFps < 27,
      sampleFps: realFps,
      subjectPx: subjectPx,
      /* 手动改出手点时要重新跟球，球候选和取帧尺寸得留着 */
      ballW: bw, ballH: bh,
      /* 身高不到画面 2/5 时，踝点抖几个像素就能让出手点差十几厘米。
         0.32 放过了一段人占 32% 的素材：球在那段里只有 12 个像素，
         出手角全测不出来，厘米数也偏了 60cm —— 再收紧到 0.40。 */
      smallSubject: subjectPx > 0 && subjectPx < vh * 0.40,
      subjectRatio: vh > 0 ? Math.round(subjectPx / vh * 100) / 100 : 0
    },
    shots: shots,
    curve: curve,
    peakInfo: peakInfo,
    dipAt: dips[0],
    /* 每帧的橙色候选（[x,y,r]）。只在内存里用，不进 dataset.js */
    ballBlobs: ballFrames.map(fs => fs.map(b => [Math.round(b.x), Math.round(b.y), Math.round(b.r)])),
    bundle: bundle,
    detected: okFrames.length,
    total: frames.length,
    /* 诊断用：每帧的姿态来自整帧(full)还是裁剪放大(crop)，
       能一眼看出「人物太小」的视频靠裁剪救回了多少帧。 */
    frameSrc: frames.map(f => f.src || 'none')
  };
}

export function isReady() { return !!detectorPromise; }

/* ============================================================
 * 手动改出手点
 *
 * 为什么要这个：自动判定靠「手腕举到接近头高」，一个上篮式的抬手、
 * 一次假投、甚至举球过头的调整动作都可能被算成出手。用户看见视频里
 * 明明是第 3.2 秒出手，系统标在 2.8 秒 —— 这时候只能让人自己改。
 *
 * 改的是「哪一帧算出手」，其余所有指标都得跟着重算，
 * 否则肘角还是旧帧的、出手点还是旧帧的，改了个时间戳等于没改。
 * ============================================================ */
export function recomputeShot(opt) {
  const bundle = opt.bundle || [];
  const meta = opt.meta || {};
  const heightCm = opt.heightCm || meta.heightCm || 178;
  const side = meta.side === 'l' ? 'l' : 'r';
  const ar = meta.videoAspect || 1;
  const dur = meta.duration || 1;
  const n = bundle.length;
  if (n < 8) return null;

  const fps = Math.max(1, (n - 1) / dur);
  const tOf = i => i / fps;
  const frames = bundle.map((f, i) => ({ t: tOf(i), pts: f }));
  const G = bundle.map(f => frameGeom(f, side, ar));
  const col = k => G.map(g => (g == null ? null : g[k]));
  const wristY = col('wrist_y'), ankY = col('ank_y'), elbow = col('elbow'), knee = col('knee');
  const bodyLen = col('bodyLen'), lean = col('lean');

  const pi = Math.max(0, Math.min(n - 1, Math.round(opt.t * fps)));
  const tRel = tOf(pi);

  const groundAll = pct(ankY, 0.95);
  const standAll = pct(bodyLen, 0.9);

  const inLoc = i => frames[i].t >= tRel - 1.0 && frames[i].t <= tRel + 0.8;
  /* 同 analyze：地面参考不含出手之后的帧（迈步捡球会把地面压低） */
  const locAnk = [], locLen = [];
  for (let i = 0; i < n; i++) {
    if (!inLoc(i) || G[i] == null) continue;
    locLen.push(bodyLen[i]);
    if (frames[i].t >= tRel - 0.55 && frames[i].t <= tRel + 0.05) locAnk.push(ankY[i]);
  }
  const ground = locAnk.length > 4 ? pct(locAnk, 0.90) : groundAll;
  const stand = locLen.length > 4 ? pct(locLen, 0.9) : standAll;

  /* 尺度：和分析时同一套算法（出手前后 ±0.75s 跨度的 85 分位），
     这样「改完出手点，出手点高度反而变了」这种事不会发生 */
  const spanOf = (p) => Math.max(p[L_AN * 2 + 1], p[R_AN * 2 + 1]) - p[1];
  const cmPerUnit = (() => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      if (!bundle[i]) continue;
      if (Math.abs(frames[i].t - tRel) > 1.2) continue;
      const s = spanOf(bundle[i]);
      if (s > 0.06) arr.push(s);
    }
    let sp = arr.length >= 6 ? pct(arr, 0.75) : null;
    if (sp == null) {
      const all = [];
      for (let i = 0; i < n; i++) if (bundle[i]) { const s = spanOf(bundle[i]); if (s > 0.06) all.push(s); }
      sp = all.length ? pct(all, 0.85) : null;
    }
    return sp ? heightCm / (sp / 0.891) : (meta.cmPerUnit || null);
  })();

  /* 下蹲：出手前 1.2 秒内膝角最小处 */
  let jDip = -1, kmin = Infinity;
  for (let i = 0; i < n; i++) {
    if (frames[i].t < tRel - 1.2 || frames[i].t > tRel) continue;
    if (knee[i] != null && knee[i] < kmin) { kmin = knee[i]; jDip = i; }
  }

  /* 随球：出手后腕高维持峰值 0.9 倍以上的时长 */
  const hSig = wristY.map(v => (v == null ? null : ground - v));
  let hold = 0;
  const win = hSig.slice(Math.max(0, pi - 1), Math.min(n, pi + 20)).filter(v => v != null);
  const pk = win.length ? Math.max.apply(null, win) : null;
  if (pk != null) {
    for (let i = pi; i < n; i++) {
      if (hSig[i] != null && hSig[i] >= pk * 0.9) hold += 1 / fps;
      else break;
    }
  }

  /* 球：有候选就重跟一次，没有就承认测不出 */
  let bt = { ok: false, reason: '这次没有球候选数据' };
  const blobs = opt.ballBlobs;
  const ballW = meta.ballW || 176, ballH = meta.ballH || 99;
  if (blobs && blobs.length === n && bundle[pi]) {
    const bf = blobs.map(list => (list || []).map(a => ({ x: a[0], y: a[1], r: a[2] })));
    try {
      const p0 = bundle[pi];
      bt = trackBall(bf, frames, pi, [
        [p0[R_WR * 2], p0[R_WR * 2 + 1]],
        [p0[L_WR * 2], p0[L_WR * 2 + 1]]
      ], ballW, ballH);
    } catch (e) { bt = { ok: false, reason: '球跟踪出错' }; }
  }

  let relH = cmPerUnit && wristY[pi] != null ? Math.round((ground - wristY[pi]) * cmPerUnit * 10) / 10 : null;
  let jmpH = cmPerUnit && ankY[pi] != null ? Math.round((ground - ankY[pi]) * cmPerUnit * 10) / 10 : null;
  if (relH != null && (relH < 95 || relH > 265)) relH = null;
  if (jmpH != null && (jmpH < -6 || jmpH > 65)) jmpH = null;

  const poseRel = poseReleaseAngle(frames, pi, side, ar);
  return {
    tRel: Math.round(tRel / dur * 10000) / 10000,
    tAbs: Math.round(tRel * 100) / 100,
    ball: bt,
    raw: {
      heightCm: heightCm,
      releaseAngle: bt && bt.ok ? bt.angle : poseRel,
      releaseAngleSrc: bt && bt.ok ? 'ball' : (poseRel != null ? 'pose' : null),
      elbowAngle: elbow[pi] == null ? null : Math.round(elbow[pi] * 10) / 10,
      releaseHeight: relH,
      jumpHeight: jmpH,
      torsoLean: lean[pi] == null ? null : Math.round(lean[pi] * 10) / 10,
      releaseTime: jDip < 0 ? null : Math.round((tRel - frames[jDip].t) * 100) / 100,
      followHold: Math.round(Math.min(hold, 1.2) * 100) / 100,
      kneeFlex: kmin === Infinity ? null : Math.round(kmin * 10) / 10
    },
    dipAt: jDip < 0 ? null : Math.round(frames[jDip].t * 100) / 100
  };
}
