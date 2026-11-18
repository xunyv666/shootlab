/* ============================================================
 * live.js — 实时指标（估算）
 *
 * 只做「边练边看」的即时反馈，判据比离线引擎宽松。
 * 最终报告一律以录下来的片段跑离线引擎为准，这里不参与结算。
 *
 * 接口：BB.Live.create(kind) -> { push(pts, t), stats() }
 *   pts 为 33 个关键点的 x/y/visibility 三元组（归一化坐标）
 *   stats() 返回 { value, unit, hint }
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var L_SH = 11, R_SH = 12, L_EL = 13, R_EL = 14, L_WR = 15, R_WR = 16;
  var L_HIP = 23, R_HIP = 24, L_AN = 27, R_AN = 28;

  function px(pts, k) {
    if (!pts) return null;
    var i = k * 3;
    if (i + 2 >= pts.length) return null;
    return { x: pts[i], y: pts[i + 1], v: pts[i + 2] };
  }
  function mid(pts, a, b) {
    var p = px(pts, a), q = px(pts, b);
    if (!p || !q || p.v < 0.3 || q.v < 0.3) return null;
    return { y: (p.y + q.y) / 2, x: (p.x + q.x) / 2, v: Math.min(p.v, q.v) };
  }
  function angle(a, b, c) {
    if (!a || !b || !c) return null;
    var abx = a.x - b.x, aby = a.y - b.y, cbx = c.x - b.x, cby = c.y - b.y;
    var den = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
    if (!den) return null;
    var v = (abx * cbx + aby * cby) / den;
    return Math.acos(Math.max(-1, Math.min(1, v))) * 180 / Math.PI;
  }
  function pick(a, b) { return a != null ? a : b; }

  /* 取一段时间内的低分位当作「站稳时的基准线」，避免镜头轻微移动就漂 */
  function percentile(arr, q) {
    if (!arr.length) return null;
    var v = arr.slice().sort(function (a, b) { return a - b; });
    var i = (v.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (i - lo);
  }

  /* ---------------- 俯卧撑：肘角周期 ---------------- */
  function pushup() {
    var downStart = null, bottom = null, count = 0, lastT = -9;
    var lastArm = null, lastBody = null;
    return {
      push: function (pts, t) {
        if (!pts) return;
        /* 选可见度更高的那一侧 */
        var lv = [L_SH, L_EL, L_WR, L_HIP, L_AN].reduce(function (s, k) { var p = px(pts, k); return s + (p ? p.v : 0); }, 0);
        var rv = [R_SH, R_EL, R_WR, R_HIP, R_AN].reduce(function (s, k) { var p = px(pts, k); return s + (p ? p.v : 0); }, 0);
        var right = rv >= lv;
        var sh = px(pts, right ? R_SH : L_SH), el = px(pts, right ? R_EL : L_EL), wr = px(pts, right ? R_WR : L_WR);
        var hip = px(pts, right ? R_HIP : L_HIP), an = px(pts, right ? R_AN : L_AN);
        var arm = angle(sh, el, wr), body = angle(sh, hip, an);
        if (arm == null) return;
        lastArm = arm; lastBody = body;
        if (downStart == null && arm <= 120) { downStart = t; bottom = arm; }
        else if (downStart != null && arm < bottom) bottom = arm;
        if (downStart != null && arm >= 145) {
          if (t - downStart >= 0.18 && t - lastT >= 0.25) { count++; lastT = t; }
          downStart = null; bottom = null;
        }
      },
      stats: function () {
        var hint = lastArm == null
          ? '把肩、髋、踝和手腕都放进画面'
          : '肘角 ' + Math.round(lastArm) + '°' + (lastBody != null ? ' · 躯干 ' + Math.round(lastBody) + '°' : '') + (downStart != null ? ' · 下放中' : '');
        return { value: count, unit: '次', hint: hint };
      }
    };
  }

  /* ---------------- 跳绳：纵向周期 ---------------- */
  function rope() {
    var buf = [], count = 0, inAir = false, lastT = -9, floorY = null;
    return {
      push: function (pts, t) {
        var hip = mid(pts, L_HIP, R_HIP);
        if (!hip) return;
        var sig = -hip.y;                     /* 向上为正 */
        buf.push(sig);
        if (buf.length > 90) buf.shift();     /* 约 5 秒窗口 */
        floorY = percentile(buf, 0.15);
        if (floorY == null) return;
        if (!inAir && sig > floorY + 0.010) inAir = true;
        else if (inAir && sig < floorY + 0.004) {
          inAir = false;
          if (t - lastT >= 0.22) { count++; lastT = t; }
        }
      },
      stats: function () {
        return {
          value: count, unit: '次',
          hint: inAir ? '腾空中' : '保持前脚掌起跳，绳过脚下再落地'
        };
      }
    };
  }

  /* ---------------- 立定跳远：起跳 / 落地 ---------------- */
  function longjump() {
    var buf = [], count = 0, phase = 'ground', takeoffT = 0, lastAir = 0, air = 0, floor = null;
    return {
      push: function (pts, t) {
        var an = mid(pts, L_AN, R_AN);
        if (!an) return;
        var sig = -an.y;
        if (phase === 'ground') {
          buf.push(sig);
          if (buf.length > 36) buf.shift();
          floor = percentile(buf, 0.2);
          if (floor != null && sig > floor + 0.045) { phase = 'air'; takeoffT = t; buf = []; }
        } else {
          air = t - takeoffT;
          if (sig < (floor == null ? 0 : floor) + 0.012 && air > 0.15) {
            phase = 'ground'; count++; lastAir = air; air = 0; buf = [];
          }
        }
      },
      stats: function () {
        if (phase === 'air') return { value: count, unit: '跳', hint: '腾空中 ' + air.toFixed(2) + ' s' };
        return {
          value: count, unit: '跳',
          hint: lastAir ? '上一跳腾空 ' + lastAir.toFixed(2) + ' s' : '站好别动，起跳后别松脚'
        };
      }
    };
  }

  /* ---------------- 投篮：出手次数（估算） ---------------- */
  function basketball() {
    var count = 0, lastT = -9, minY = 9, minT = 0, lastWrist = null;
    return {
      push: function (pts, t) {
        var l = px(pts, L_WR), r = px(pts, R_WR);
        if (!l && !r) return;
        /* 取更高的那只手腕（y 更小） */
        var w = (!l || (r && r.y < l.y)) ? r : l;
        if (!w || w.v < 0.3) return;
        lastWrist = w.y;
        /* 手腕到最高点后明显下落 = 一次出手 */
        if (w.y < minY) { minY = w.y; minT = t; }
        if (t - minT > 0.12 && w.y > minY + 0.09 && t - lastT >= 0.8) {
          count++; lastT = t; minY = w.y; minT = t;
        }
        if (t - minT > 2.5) { minY = w.y; minT = t; }   /* 长时间没动，重置高点 */
      },
      stats: function () {
        return {
          value: count, unit: '次',
          hint: lastWrist == null ? '侧面站，让出手的手腕一直在画面里' : '手腕到最高点后下落才计一次'
        };
      }
    };
  }

  var FACTORY = { pushup: pushup, rope: rope, longjump: longjump, basketball: basketball };

  BB.Live = {
    create: function (kind) {
      var f = FACTORY[kind];
      return f ? f() : { push: function () {}, stats: function () { return { value: 0, unit: '', hint: '' }; } };
    }
  };
})(window.BB);
