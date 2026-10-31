/* ============================================================
 * progress.js — 累积与自我校准
 *
 * 「让系统自己学」这句话如果只是嘴上说说，就只是个营销词。
 * 这里做的是一件具体的事：
 *
 *   每标一次「进 / 没进」，就把当时的模型概率和真实结果存下来，
 *   攒够样本后用 Platt scaling（一维逻辑回归）校准模型输出。
 *   样本少的时候不许乱学 —— 先验是「不校准」，
 *   权重按样本量向先验收缩，6 次以内不学。
 *
 * 数据只在你自己浏览器里（localStorage），不上传。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var KEY = 'shootlab.progress.v1';
  var MIN_LEARN = 6;      // 少于这个数不校准：3 个样本「学」出来的东西比不学更糟

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function write(arr) {
    try {
      /* 只留最近 500 条：样本再多，校准曲线也不会因为第 501 条变准 */
      localStorage.setItem(KEY, JSON.stringify(arr.slice(-500)));
    } catch (e) { /* 隐私模式写不进去，忽略 */ }
  }

  function logit(p) {
    var q = Math.min(0.98, Math.max(0.02, p));
    return Math.log(q / (1 - q));
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  /* Platt scaling：拟合 p = sigmoid(a·z + b)，z 是模型输出的 logit */
  function fit(data) {
    var n = data.length;
    if (n < MIN_LEARN) return { a: 1, b: 0, n: n, learned: false };

    var a = 1, b = 0;
    var lr = 0.15;
    /* 正则强度随样本量下降：样本越多，越相信数据而不是先验 */
    var lam = 6 / n;
    for (var it = 0; it < 500; it++) {
      var ga = 0, gb = 0;
      for (var i = 0; i < n; i++) {
        var p = sigmoid(a * data[i].z + b);
        ga += (p - data[i].y) * data[i].z;
        gb += (p - data[i].y);
      }
      ga = ga / n + lam * (a - 1);
      gb = gb / n + lam * b;
      a -= lr * ga;
      b -= lr * gb;
      /* 别让校准把概率压成 0/1，那样就失去意义了 */
      a = Math.max(0.25, Math.min(2.5, a));
      b = Math.max(-1.5, Math.min(1.5, b));
    }
    return { a: a, b: b, n: n, learned: true };
  }

  var cache = null;
  function calib() {
    if (!cache) cache = fit(read());
    return cache;
  }

  /* 把模型原始概率换成校准后的概率 */
  function apply(p) {
    var c = calib();
    if (!c.learned) return p;
    return sigmoid(c.a * logit(p) + c.b);
  }

  /* 记一次结果。p0 是当时模型给出的概率 */
  function mark(shot, made, dist) {
    if (!shot || !shot.raw) return null;
    var p0 = 0.5;
    if (BB.Zone) {
      try { p0 = BB.Zone.predict(shot.raw, { dist: dist }).p; } catch (e) { p0 = 0.5; }
    }
    var arr = read();
    arr.push({
      t: Date.now(),
      z: Math.round(logit(p0) * 1000) / 1000,
      y: made ? 1 : 0,
      p0: Math.round(p0 * 1000) / 1000,
      d: dist || null,
      h: shot.raw.heightCm || null
    });
    write(arr);
    cache = null;
    return stats();
  }

  /* 撤销最近一条（点错了要能改） */
  function undo() {
    var arr = read();
    arr.pop();
    write(arr);
    cache = null;
    return stats();
  }

  function stats() {
    var arr = read();
    var c = calib();
    var n = arr.length;
    var made = 0, brier = 0, brierCal = 0;
    arr.forEach(function (r) {
      made += r.y;
      var p = sigmoid(r.z);
      var pc = c.learned ? sigmoid(c.a * r.z + c.b) : p;
      brier += (p - r.y) * (p - r.y);
      brierCal += (pc - r.y) * (pc - r.y);
    });
    return {
      n: n,
      made: made,
      rate: n ? made / n : null,
      brier: n ? brier / n : null,          // 越小越准，0.25 = 纯瞎猜
      brierCal: n ? brierCal / n : null,
      calib: c,
      /* 给界面用的一句话，别让人自己算 */
      note: n === 0 ? '还没有标注过结果'
        : n < MIN_LEARN ? '已记录 ' + n + ' 次，攒到 ' + MIN_LEARN + ' 次才开始校准'
          : '已用 ' + n + ' 次结果校准（样本少时权重偏保守）'
    };
  }

  function clear() {
    write([]);
    cache = null;
    return stats();
  }

  BB.Progress = {
    mark: mark,
    undo: undo,
    stats: stats,
    calib: calib,
    apply: apply,
    clear: clear,
    MIN_LEARN: MIN_LEARN
  };
})(window.BB);
