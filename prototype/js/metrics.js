/* ============================================================
 * metrics.js  —  指标计算（臧子涵）
 * 1) 由 MediaPipe 的 33 个骨骼点计算关节夹角、出手角、出手高度
 * 2) 把原始指标映射为 0-100 的雷达分值
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';
  var D = BB.data;

  /* ---------- 几何计算 ---------- */
  /* 三点夹角（返回角度，点 b 为顶点），输入为 {x,y} 或 {x,y,z} */
  function angleAt(a, b, c) {
    var v1 = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
    var v2 = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };
    var dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
    var m1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y + v1.z * v1.z);
    var m2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y + v2.z * v2.z);
    if (!m1 || !m2) return 0;
    var cos = Math.max(-1, Math.min(1, dot / (m1 * m2)));
    return Math.acos(cos) * 180 / Math.PI;
  }

  /* 线段与竖直方向的夹角（出手角：前臂 - 竖直） */
  function angleFromVertical(a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    return Math.abs(Math.atan2(dx, -dy) * 180 / Math.PI);
  }

  /* 由骨骼点计算一次出手的核心指标（MediaPipe 索引见注释） */
  function computeFromLandmarks(lm, opts) {
    opts = opts || {};
    var scale = opts.scale || 1;          // 像素 -> 厘米 换算
    var L = {
      shoulder: lm[12], elbow: lm[14], wrist: lm[16], index: lm[20],
      hip: lm[24], knee: lm[26], ankle: lm[28], shoulderL: lm[11]
    };
    var releaseAngle = angleFromVertical(L.elbow, L.wrist);
    var elbowAngle = angleAt(L.shoulder, L.elbow, L.wrist);
    var kneeFlex = angleAt(L.hip, L.knee, L.ankle);
    var torsoLean = Math.abs(90 - angleFromVertical(L.hip, L.shoulder));
    return {
      heightCm: +(opts.heightCm || 180),
      releaseAngle: +releaseAngle.toFixed(1),
      elbowAngle: +elbowAngle.toFixed(0),
      releaseHeight: +(opts.releaseHeightCm || (1 - L.wrist.y) * 300 * scale).toFixed(0),
      jumpHeight: +(opts.jumpHeightCm || 0),
      torsoLean: +torsoLean.toFixed(1),
      releaseTime: +(opts.releaseTime || 0),
      followHold: +(opts.followHold || 0),
      kneeFlex: +kneeFlex.toFixed(0)
    };
  }

  /* ---------- 把原始值换算成「可比较的值」 ----------
     两种换算：
       ratio  —— 除以身高。绝对值（比如出手点 205cm）对不同身高的人没有可比性，
                 库里 241cm 是因为他 188cm，不是因为他比 180cm 的人更"高"。
       dynamic —— 目标随出手条件变。出手角用 Brancazio 最优角公式，
                 出手点越低，需要的弧线越高（θ = 45° + ½·atan((篮筐高−出手点高)/距离)）。
                 用统一区间会把"低出手点 + 大角度"这种正确补偿判成错。 */
  function dimValue(dim, raw) {
    if (raw == null) return null;
    if (dim.ratio) {
      var v = raw[dim.raw], h = raw[dim.ratio];
      if (v == null || !h) return null;
      return v / h;
    }
    return raw[dim.raw];
  }

  function dimIdeal(dim, raw) {
    if (dim.dynamic === 'brancazio') {
      var rh = raw && raw.releaseHeight;
      if (rh == null) return dim.ideal;
      var dist = D.RAW_DIST || 4.6;
      var opt = 45 + 0.5 * Math.atan2((D.HOOP_H || 3.05) - rh / 100, dist) * 180 / Math.PI;
      return [opt - 2.5, opt + 2.5];
    }
    return dim.ideal;
  }

  /* ---------- 原始值 -> 0~100 分值 ---------- */
  function rangeScore(v, ideal, tol) {
    /* 识别不到的量（比如球被挡住、出手角没算出来）不下判断：
       给中性 70 分，界面上那一格显示「—」，不要因为缺数据把整张雷达拖垮 */
    if (v == null || isNaN(v)) return 70;
    var mid = (ideal[0] + ideal[1]) / 2;
    var half = (ideal[1] - ideal[0]) / 2;
    var d = Math.abs(v - mid);
    if (d <= half) return 88 + 10 * (1 - (d / (half || 1)) * 0.6);
    return Math.max(18, 88 * Math.exp(-(d - half) / tol));
  }

  /* 原始值 -> 雷达分值对象 {releaseAngle: 82, ...} */
  function radarOf(raw) {
    var out = {};
    D.DIMS.forEach(function (dim) {
      var v = dimValue(dim, raw);
      var id = dimIdeal(dim, raw);
      out[dim.key] = Math.round(rangeScore(v, id, dim.tol));
    });
    return out;
  }

  /* 综合评分：八维加权 */
  var WEIGHTS = {
    releaseAngle: 1.3, elbowAlign: 1.2, releaseHeight: 1.0, jump: 0.8,
    balance: 1.1, tempo: 0.9, followThrough: 0.9, legDrive: 0.8
  };

  function overall(radar) {
    var sum = 0, w = 0;
    Object.keys(WEIGHTS).forEach(function (k) {
      sum += (radar[k] || 0) * WEIGHTS[k];
      w += WEIGHTS[k];
    });
    return Math.round(sum / w);
  }

  /* 多次出手聚合：先算原始指标均值与波动，
     综合分 = 各次得分均值 − 0.55 × 标准差
     （既惩罚平均值偏低，也惩罚动作不稳定，这才是教练真正会看的东西） */
  function meanOf(arr) {
    return arr.reduce(function (a, b) { return a + b; }, 0) / (arr.length || 1);
  }
  function sdOf(arr) {
    var m = meanOf(arr);
    return Math.sqrt(meanOf(arr.map(function (v) { return (v - m) * (v - m); })));
  }

  function average(shots) {
    if (!shots.length) return { raw: null, radar: null, score: 0, rawSd: {}, radarSd: {} };
    var keys = Object.keys(shots[0].raw);
    var raw = {}, rawSd = {};
    keys.forEach(function (k) {
      /* null 是「没测出来」，不能当 0 参与平均：
         7 次里 0 次测到出手角时，平均值会算成 0.0，
         界面上就显示"出手角度 0.0°"，看着像测了个零度出来。 */
      var vals = shots.map(function (s) { return s.raw[k]; })
        .filter(function (v) { return v != null && !isNaN(v); });
      raw[k] = vals.length ? +(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length).toFixed(2) : null;
      rawSd[k] = vals.length > 1 ? +sdOf(vals).toFixed(2) : null;
    });
    var radars = shots.map(function (s) { return radarOf(s.raw); });
    var radar = {}, radarSd = {};
    D.DIMS.forEach(function (dim) {
      var vals = radars.map(function (r) { return r[dim.key]; });
      var m = meanOf(vals), sd = sdOf(vals);
      radar[dim.key] = Math.max(10, Math.round(m - sd * 0.55));
      radarSd[dim.key] = Math.round(sd);
    });
    return { raw: raw, radar: radar, score: overall(radar), rawSd: rawSd, radarSd: radarSd };
  }

  /* 稳定性：八维分值的标准差（越小越稳） */
  function consistency(shots) {
    if (shots.length < 2) return 100;
    var radars = shots.map(function (s) { return radarOf(s.raw); });
    var total = 0;
    D.DIMS.forEach(function (dim) {
      var vals = radars.map(function (r) { return r[dim.key]; });
      var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      var varr = vals.reduce(function (a, v) { return a + (v - mean) * (v - mean); }, 0) / vals.length;
      total += Math.sqrt(varr);
    });
    var avgSd = total / D.DIMS.length;
    return Math.max(20, Math.round(100 - avgSd * 2.2));
  }

  /* ---------- 模拟一次出手（演示用：在上一次基础上小幅进步 + 抖动） ---------- */
  function simulateNext(existing) {
    var TARGET = {
      releaseAngle: 49.5, elbowAngle: 165, releaseHeight: 242, jumpHeight: 41,
      torsoLean: 5.8, releaseTime: 1.03, followHold: 1.05, kneeFlex: 113
    };
    var NOISE = {
      releaseAngle: 1.5, elbowAngle: 2.4, releaseHeight: 2.2, jumpHeight: 1.6,
      torsoLean: 0.6, releaseTime: 0.05, followHold: 0.06, kneeFlex: 2.6
    };
    var last = existing.length ? existing[existing.length - 1].raw : {
      releaseAngle: 44, elbowAngle: 150, releaseHeight: 228, jumpHeight: 33,
      torsoLean: 10.5, releaseTime: 1.25, followHold: 0.88, kneeFlex: 99
    };
    var raw = { heightCm: last.heightCm || 182 };
    Object.keys(TARGET).forEach(function (k) {
      var v = last[k] + (TARGET[k] - last[k]) * 0.2 + (Math.random() - 0.5) * 2 * NOISE[k];
      raw[k] = +v.toFixed(2);
    });
    var score = overall(radarOf(raw));
    return {
      id: existing.length + 1,
      tRel: 0,
      made: score > 80 && Math.random() > 0.28,
      raw: raw,
      simulated: true
    };
  }

  BB.metrics = {
    angleAt: angleAt,
    angleFromVertical: angleFromVertical,
    computeFromLandmarks: computeFromLandmarks,
    dimValue: dimValue,
    dimIdeal: dimIdeal,
    rangeScore: rangeScore,
    radarOf: radarOf,
    overall: overall,
    average: average,
    consistency: consistency,
    simulateNext: simulateNext
  };
})(window.BB);
