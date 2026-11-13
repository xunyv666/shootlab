/* ============================================================
 * pushup-engine.js — 俯卧撑动作分析引擎（浏览器端）
 *
 * 复用 pose-engine 的 MediaPipe 检测器。输入侧面视频，按肘角的
 * 「伸直 → 弯曲 → 伸直」周期计数，并用躯干直线度给出动作质量。
 * ============================================================ */

import { loadDetector, acquireTimeBlock, seekTo } from './pose-engine.js';

const L_SH = 11, R_SH = 12;
const L_EL = 13, R_EL = 14;
const L_WR = 15, R_WR = 16;
const L_HIP = 23, R_HIP = 24;
const L_AN = 27, R_AN = 28;
const KEY = [L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP, L_AN, R_AN];
const SAMPLE_FPS = 24;
const MAX_SAMPLES = 1800;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v, d) { const p = Math.pow(10, d || 0); return Math.round(v * p) / p; }
function mean(a) {
  const v = a.filter(x => x != null && isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}
function median(a) {
  const v = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
  if (!v.length) return null;
  const i = (v.length - 1) / 2;
  return i % 1 ? (v[Math.floor(i)] + v[Math.ceil(i)]) / 2 : v[i];
}
function smooth(a) {
  return a.map((_, i) => median(a.slice(Math.max(0, i - 1), Math.min(a.length, i + 2))));
}
function point(pts, k) {
  const i = k * 3;
  return pts && pts.length >= i + 2 ? { x: pts[i], y: pts[i + 1], v: pts[i + 2] == null ? 1 : pts[i + 2] } : null;
}
function angle(a, b, c) {
  if (!a || !b || !c) return null;
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const den = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (!den) return null;
  return Math.acos(clamp((abx * cbx + aby * cby) / den, -1, 1)) * 180 / Math.PI;
}
function visibility(pts, side) {
  return KEY.filter(k => (k % 2) === side).map(k => {
    const p = point(pts, k); return p ? p.v : 0;
  }).reduce((a, b) => a + b, 0);
}
function measure(pts) {
  if (!pts) return null;
  const side = visibility(pts, 1) >= visibility(pts, 0) ? 1 : 0;
  const sh = point(pts, side ? R_SH : L_SH);
  const el = point(pts, side ? R_EL : L_EL);
  const wr = point(pts, side ? R_WR : L_WR);
  const hip = point(pts, side ? R_HIP : L_HIP);
  const an = point(pts, side ? R_AN : L_AN);
  const arm = angle(sh, el, wr);
  const body = angle(sh, hip, an);
  if (arm == null || body == null) return null;
  return { arm, body, side };
}
function poseToPoints(lm) {
  const out = new Array(33 * 3).fill(0);
  for (let i = 0; i < 33; i++) {
    const p = lm[i] || {};
    out[i * 3] = Number.isFinite(p.x) ? p.x : 0;
    out[i * 3 + 1] = Number.isFinite(p.y) ? p.y : 0;
    out[i * 3 + 2] = Number.isFinite(p.visibility) ? p.visibility : 1;
  }
  return out;
}

/**
 * 纯数据分析入口，便于离线校验。frames: [{t, pts}]，pts 为 x/y/visibility 三元组。
 */
export function analyzeLandmarks(frames, opt = {}) {
  const input = (frames || []).filter(f => f && f.pts && isFinite(f.t));
  const measured = input.map(f => ({ t: f.t, pts: f.pts, m: measure(f.pts) }));
  const arm = smooth(measured.map(f => f.m ? f.m.arm : null));
  const body = smooth(measured.map(f => f.m ? f.m.body : null));
  measured.forEach((f, i) => { f.arm = arm[i]; f.body = body[i]; });

  const reps = [];
  let downStart = null;
  let bottom = null;
  for (let i = 0; i < measured.length; i++) {
    const f = measured[i];
    if (f.arm == null) continue;
    if (downStart == null && f.arm <= 120) {
      downStart = i;
      bottom = i;
    } else if (downStart != null && f.arm < measured[bottom].arm) {
      bottom = i;
    }
    if (downStart != null && f.arm >= 145) {
      const start = downStart;
      const duration = f.t - measured[start].t;
      if (duration >= 0.20 && duration <= 4.0 && (!reps.length || f.t - reps[reps.length - 1].t >= 0.25)) {
        const minArm = measured[bottom].arm;
        const depthScore = clamp((125 - minArm) / 0.55, 0, 100);
        const bodyVals = measured.slice(start, i + 1).map(x => x.body);
        const lineAngle = mean(bodyVals);
        const lineScore = lineAngle == null ? null : clamp(100 - Math.abs(180 - lineAngle) * 3.0, 0, 100);
        const score = lineScore == null ? Math.round(depthScore) : Math.round(depthScore * 0.55 + lineScore * 0.45);
        reps.push({
          t: f.t,
          start: measured[start].t,
          bottom: measured[bottom].t,
          end: f.t,
          depthAngle: round(minArm, 1),
          bodyAngle: lineAngle == null ? null : round(lineAngle, 1),
          depthScore: Math.round(depthScore),
          lineScore: lineScore == null ? null : Math.round(lineScore),
          score,
          standard: depthScore >= 45 && (lineScore == null || lineScore >= 45)
        });
      }
      downStart = null;
      bottom = null;
    }
  }

  const intervals = reps.slice(1).map((r, i) => r.t - reps[i].t).filter(v => v > 0.25 && v < 10);
  const medInterval = median(intervals);
  const cadence = medInterval ? Math.round(60 / medInterval) : null;
  const avgDepth = mean(reps.map(r => r.depthScore));
  const avgLine = mean(reps.map(r => r.lineScore));
  const formScore = reps.length ? Math.round(mean(reps.map(r => r.score))) : null;
  const warnings = [];
  if (!measured.some(f => f.m)) warnings.push('没有识别到完整人体，请使用侧面、全身入镜的视频。');
  if (reps.length === 0 && measured.some(f => f.m)) warnings.push('没有找到完整的屈肘周期，建议把肩、髋、踝和手腕都拍进画面。');
  if (measured.filter(f => f.m).length < Math.max(5, input.length * 0.35)) warnings.push('有效姿态帧偏少，光线或遮挡可能影响结果。');

  return {
    meta: Object.assign({ duration: input.length ? input[input.length - 1].t : 0, warnings }, opt),
    stats: {
      count: reps.length,
      standardCount: reps.filter(r => r.standard).length,
      cadence,
      avgDepth: avgDepth == null ? null : Math.round(avgDepth),
      avgLine: avgLine == null ? null : Math.round(avgLine),
      formScore,
      activeSeconds: reps.length > 1 ? round(reps[reps.length - 1].t - reps[0].t, 1) : 0
    },
    reps,
    frames: measured.map(f => ({ t: f.t, pts: f.pts, arm: f.arm, body: f.body }))
  };
}

export async function analyze(video, opt = {}) {
  const onProgress = opt.onProgress || (() => {});
  const signal = opt.signal;
  const stop = () => { if (signal && signal.aborted) throw new Error('分析已取消'); };
  onProgress('正在加载姿态模型…', 0.02);
  const det = await loadDetector();
  stop();
  const dur = video.duration;
  if (!isFinite(dur) || dur <= 0) throw new Error('视频时长无效，可能是编码不被浏览器支持');
  if (!video.videoWidth || !video.videoHeight) throw new Error('浏览器读不出这个视频的画面，建议使用 MP4/H.264 或 WebM');
  const n = Math.max(24, Math.min(MAX_SAMPLES, Math.round(dur * SAMPLE_FPS)));
  const step = dur / Math.max(1, n - 1);
  const stepMs = Math.max(4, Math.round(step * 1000));
  const tsBase = acquireTimeBlock(n, Math.max(40, stepMs));
  const frames = [];
  for (let i = 0; i < n; i++) {
    stop();
    const t = Math.min(dur, i * step);
    await seekTo(video, t);
    let lm = null;
    try {
      const result = det.detectForVideo(video, tsBase + i * stepMs);
      lm = result && result.landmarks && result.landmarks[0];
    } catch (e) { lm = null; }
    frames.push({ t, pts: lm ? poseToPoints(lm) : null });
    if (i % 4 === 0 || i === n - 1) onProgress('正在识别第 ' + (i + 1) + ' / ' + n + ' 帧…', 0.05 + i / Math.max(1, n - 1) * 0.9);
  }
  return analyzeLandmarks(frames, {
    duration: dur,
    fps: 1 / step,
    videoAspect: video.videoWidth / video.videoHeight,
    source: opt.source || '本地上传',
    subject: opt.subject || '俯卧撑视频'
  });
}
