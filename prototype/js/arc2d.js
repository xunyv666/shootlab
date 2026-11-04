/* ============================================================
 * arc2d.js  —  投篮轨迹 2D 叠加（直接画在视频画面上）
 *
 * 思路和 arc3d.js 不同：那边是按公式推一条 3D 抛物线再转到视角里，
 * 这边直接在画面坐标里落一条曲线 —— 不需要相机内参、不需要解单应、
 * 也不需要把投篮距离量准。
 *
 * 做法（已在真实素材上离线验证过）：
 *   出手角 θ 决定起点切线方向，入筐角 φ 决定终点切线方向，
 *   两条切线的交点就是二次贝塞尔的控制点。
 *   入筐角 φ 由 physics() 用 (θ, 出手高, 水平距离) 反解出来。
 *
 * 为什么这样可信：θ 来自姿态估算，筐位置由用户点选，其余全是几何。
 * 它不假装自己「追到了球」—— 界面上必须标明这是推算值。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var G = 9.8;        // 重力加速度
  var RIM_H = 3.05;   // 标准篮筐高度（米）
  var SHOW_SEC = 2.6; // 一次出手的弧线在画面上停留多久
  var GROW_SEC = 0.65; // 弧线「生长」动画时长

  /* 画面配色：轨迹线用天蓝，和橙色骨骼刻意错开，否则叠在一起分不清 */
  var C_LINE = '56,189,248';   // 天蓝
  var C_HAND = '#f97316';      // 出手点（主题橙，白描边和骨骼区分）
  var C_RIM = '#ef4444';       // 篮筐

  /* ---------------- 纯几何 ---------------- */

  /* 从 (0, relH) 以 angleDeg 抛出、落点在 (dist, RIM_H) 的斜抛。
     返回初速和到达时的速度方向（入筐角，向下为正）。 */
  function physics(angleDeg, relH, dist) {
    var th = angleDeg * Math.PI / 180;
    var ct = Math.cos(th), tt = Math.tan(th);
    var den = ct * ct * 2 * (relH + dist * tt - RIM_H);
    if (!(den > 0) || !(dist > 0)) return null;
    var v2 = G * dist * dist / den;
    if (!(v2 > 0)) return null;
    var v = Math.sqrt(v2);
    var vx = v * ct;
    if (!(vx > 0)) return null;
    var vy = v * Math.sin(th) - G * (dist / vx);
    return { v: v, entry: Math.atan2(-vy, vx) * 180 / Math.PI };
  }

  /* 起点切线 × 终点切线的交点 = 二次贝塞尔的控制点。
     图像坐标系 y 向下，所以「向上」是 -y。 */
  function control(P0, P1, launchDeg, entryDeg) {
    var a = launchDeg * Math.PI / 180;
    var b = entryDeg * Math.PI / 180;
    var d0 = [Math.cos(a), -Math.sin(a)];   // 从出手点朝上朝前
    var d1 = [-Math.cos(b), -Math.sin(b)];  // 从筐心朝回、朝上
    var det = d0[0] * (-d1[1]) - (-d1[0]) * d0[1];
    if (Math.abs(det) < 1e-9) return null;
    var rx = P1[0] - P0[0], ry = P1[1] - P0[1];
    var t = (rx * (-d1[1]) - (-d1[0]) * ry) / det;
    var s = (d0[0] * ry - d0[1] * rx) / det;
    /* 两条射线必须在「往前的方向」上相交，否则这组角度画不出合理弧线 */
    if (!(t > 0) || !(s > 0)) return null;
    return [P0[0] + t * d0[0], P0[1] + t * d0[1]];
  }

  function bezier(P0, C, P1, n) {
    var out = [];
    for (var i = 0; i <= n; i++) {
      var u = i / n, m = 1 - u;
      out.push([
        m * m * P0[0] + 2 * m * u * C[0] + u * u * P1[0],
        m * m * P0[1] + 2 * m * u * C[1] + u * u * P1[1]
      ]);
    }
    return out;
  }

  /* ---------------- 状态 ---------------- */

  var shots = [];      // 出手列表（引擎给的那份）
  var ar = 16 / 9;     // 视频宽高比
  var rim = null;      // 篮筐位置（归一化坐标）
  var dist = 4.6;      // 这一球的水平距离（米）
  var enabled = true;
  var cache = [];      // 预计算好的折线，每项 { t, pts, grade, angle, entry }

  function num(v) { return v == null || isNaN(v) ? null : +v; }

  /* 画面里一次出手都没有可用的起点/角度时，这一条就不画 —— 
     宁可少一条，也不要在屏幕上编一条。 */
  function buildOne(sh) {
    if (!sh || !sh.releasePt || !rim) return null;
    var a = sh.raw || {};
    var angle = num(a.releaseAngle);
    var grade = 'pose';                       // 角度来源
    if (angle == null) { angle = 52; grade = 'none'; }
    else if (a.releaseAngleSrc === 'ball') grade = 'ball';

    /* 出手高度：优先用引擎算好的厘米数；没有就按成人典型值兜底，
       并降级标记 —— 出手高错 20cm 只影响控制点位置，不影响起点和落点。 */
    var relH = num(a.releaseHeight);
    if (relH == null) { relH = 220; grade = grade === 'none' ? 'none' : 'pose'; }
    relH = relH / 100;

    /* 归一化坐标是非等比缩放，角度会失真，所以先换到等比空间
       （X = x*ar，Y = y），几何算完再换回来。 */
    var P0 = [sh.releasePt[0] * ar, sh.releasePt[1]];
    var P1 = [rim[0] * ar, rim[1]];
    var ph = physics(angle, relH, dist);
    if (!ph) return null;
    var C = control(P0, P1, angle, ph.entry);
    if (!C) return null;

    return {
      t: sh.tAbs,
      pts: bezier(P0, C, P1, 96),
      grade: grade,
      angle: angle,
      entry: ph.entry
    };
  }

  function rebuild() {
    cache = [];
    if (!rim || !shots.length) return;
    for (var i = 0; i < shots.length; i++) {
      var b = buildOne(shots[i]);
      if (b) cache.push(b);
    }
  }

  /* ---------------- 对外接口 ---------------- */

  BB.Arc2D = {
    /* 数据变化时调一次：出手列表、视频宽高比、距离 */
    configure: function (opt) {
      opt = opt || {};
      if (opt.shots) shots = opt.shots;
      if (opt.ar) ar = opt.ar;
      if (opt.dist != null) dist = opt.dist;
      if (opt.rim !== undefined) rim = opt.rim;
      if (opt.enabled != null) enabled = !!opt.enabled;
      rebuild();
    },
    setRim: function (p) {
      rim = p ? [p[0], p[1]] : null;
      rebuild();
    },
    setDist: function (d) {
      if (d == null || isNaN(d) || d === dist) return;
      dist = d;
      rebuild();
    },
    getRim: function () { return rim; },
    /* 有几条能画出来 —— 界面用它决定要不要提示「点一下篮筐」 */
    count: function () { return cache.length; },
    clear: function () { cache = []; shots = []; rim = null; },

    /* 供离线核对：给定输入直接把中间量吐出来 */
    _math: { physics: physics, control: control, bezier: bezier },

    /* ---------------- 绘制 ----------------
       挂在 Overlay 的 extraDraw 上，和骨骼同一块画布、同一套坐标，
       所以位置一定对得上。 */
    render: function (ctx, box, t) {
      if (!enabled || !cache.length || !box || !box.w) return;

      /* 找「当前时间之前最近的一次出手」。只画最近这一条，
         不然 20 条弧线全叠在一起会糊成一团。 */
      var cur = null;
      for (var i = 0; i < cache.length; i++) {
        if (cache[i].t <= t + 0.04) cur = cache[i];
        else break;
      }
      if (!cur) return;
      var since = t - cur.t;
      if (since < 0 || since > SHOW_SEC) return;

      var fade = Math.min(1, Math.max(0, (SHOW_SEC - since) / 0.5));
      var grow = Math.min(1, Math.max(0.08, since / GROW_SEC));
      var n = Math.max(2, Math.round(cur.pts.length * grow));

      /* 等比空间 → 画布像素 */
      var px = function (p) { return [box.x + (p[0] / ar) * box.w, box.y + p[1] * box.h]; };

      var all = [];
      for (var k = 0; k < n; k++) all.push(px(cur.pts[k]));
      var P0 = px(cur.pts[0]);
      var P1 = px(cur.pts[cur.pts.length - 1]);

      var grad = ctx.createLinearGradient(P0[0], P0[1], P1[0], P1[1]);
      grad.addColorStop(0, 'rgba(' + C_LINE + ',' + (0.95 * fade) + ')');
      grad.addColorStop(1, 'rgba(' + C_LINE + ',' + (0.55 * fade) + ')');

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      /* 三层叠出光晕：宽而淡 → 中间 → 主线，比单纯加 shadowBlur 更省性能 */
      var layers = [[9, 0.10], [5, 0.22], [2.4, 1]];
      for (var L = 0; L < layers.length; L++) {
        ctx.beginPath();
        ctx.moveTo(all[0][0], all[0][1]);
        for (var j = 1; j < all.length; j++) ctx.lineTo(all[j][0], all[j][1]);
        ctx.strokeStyle = L === layers.length - 1 ? grad
          : 'rgba(' + C_LINE + ',' + (layers[L][1] * fade) + ')';
        ctx.lineWidth = layers[L][0];
        /* 角度没测出来的那条画虚线，一眼能看出它是兜底值 */
        ctx.setLineDash(cur.grade === 'none' ? [7, 6] : []);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      /* 出手点 */
      ctx.beginPath();
      ctx.arc(P0[0], P0[1], 5.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(249,115,22,' + (0.9 * fade) + ')';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.85 * fade) + ')';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      /* 篮筐靶心：只有弧线画到接近终点时才淡入，避免一开始就抢戏 */
      var rimA = Math.min(1, Math.max(0, (grow - 0.55) / 0.3)) * fade;
      if (rimA > 0.02) {
        var r = Math.max(9, box.w * 0.012);
        ctx.beginPath();
        ctx.arc(P1[0], P1[1], r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(239,68,68,' + (0.85 * rimA) + ')';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(P1[0] - r * 1.8, P1[1]); ctx.lineTo(P1[0] + r * 1.8, P1[1]);
        ctx.moveTo(P1[0], P1[1] - r * 1.8); ctx.lineTo(P1[0], P1[1] + r * 1.8);
        ctx.strokeStyle = 'rgba(239,68,68,' + (0.45 * rimA) + ')';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      /* 数值标签：放在弧线最高点上方 */
      var top = all[0];
      for (var q = 1; q < all.length; q++) if (all[q][1] < top[1]) top = all[q];
      var txt = cur.angle.toFixed(0) + '°  ' + dist.toFixed(1) + 'm';
      if (cur.grade === 'none') txt += '  (角度未测出)';
      ctx.font = '600 11px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      var tw = ctx.measureText(txt).width;
      var lx = Math.max(box.x + 6, Math.min(box.x + box.w - tw - 8, top[0] - tw / 2));
      var ly = Math.max(box.y + 16, top[1] - 10);
      ctx.fillStyle = 'rgba(8,12,20,' + (0.55 * fade) + ')';
      ctx.fillRect(lx - 5, ly - 13, tw + 10, 16);
      ctx.fillStyle = 'rgba(255,247,237,' + (0.95 * fade) + ')';
      ctx.fillText(txt, lx, ly);

      ctx.restore();
    }
  };
})(window.BB);
