/* ============================================================
 * rope.js  —  跳绳计数界面层
 *
 * 只做「接线」：视频播放、进度、指标卡、记录表、节奏曲线、骨骼叠加。
 * 识别与计数算法在 rope-engine.js（ES 模块）里。
 *
 * 对外接口（app.js 用）：
 *   init() / onShow() / onHide() / toggle() / step(n) / pause()
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var R = {
    inited: false,
    visible: false,
    video: null,
    overlay: null,
    octx: null,
    chart: null,
    cctx: null,
    url: null,
    res: null,
    duration: 0,
    playing: false,
    raf: 0,
    speed: 1,
    activeJump: null,
    chartT: -1,
    anRatio: 0,
    analyzing: false,
    lastFile: null,
    resizeObs: null,
    chartObs: null
  };

  /* 和 app.js 同口径：用户输入进 innerHTML 前必须转义 */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function round(v, d) {
    var p = Math.pow(10, d || 0);
    return Math.round(v * p) / p;
  }

  function fmtTime(t) {
    if (t == null || !isFinite(t)) return '—';
    var m = Math.floor(t / 60);
    var s = t % 60;
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s.toFixed(2) : s.toFixed(2));
  }

  function fmtNum(v, d, unit) {
    if (v == null || !isFinite(v)) return '<span class="na">—</span>';
    return round(v, d) + (unit || '');
  }

  function height() {
    var el = $('ropeHeight');
    var v = el ? parseFloat(el.value) : 170;
    if (!isFinite(v)) v = 170;
    return Math.max(100, Math.min(225, v));
  }

  /* ---------------- 画布尺寸 ---------------- */

  function fitCanvas(canvas, ctx) {
    if (!canvas || !ctx) return null;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(rect.width), h = Math.round(rect.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h, dpr: dpr };
  }

  /* 视频画面在舞台里的实际显示矩形（object-fit: contain 会留黑边） */
  function videoBox(w, h) {
    var v = R.video;
    var aspect = (R.res && R.res.meta.videoAspect) || (v && v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 0);
    if (!aspect || !w || !h) return { x: 0, y: 0, w: w, h: h };
    var stageA = w / h;
    var bw, bh;
    if (aspect > stageA) { bw = w; bh = w / aspect; }
    else { bh = h; bw = h * aspect; }
    return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
  }

  /* ---------------- 指标卡 ---------------- */

  function rhythmLabel(score) {
    if (score == null) return '—';
    if (score >= 85) return '很稳';
    if (score >= 70) return '比较稳';
    if (score >= 50) return '一般';
    return '偏乱';
  }

  function metricCard(o) {
    var val = o.value == null
      ? '<span class="na">—</span>'
      : o.value + (o.unit ? '<small>' + esc(o.unit) + '</small>' : '');
    return '<div class="metric' + (o.value == null ? ' is-empty' : '') + '">' +
      '<div class="m-top"><span class="m-name">' + esc(o.name) + '</span>' +
      (o.tag ? '<span class="m-delta">' + esc(o.tag) + '</span>' : '') + '</div>' +
      '<div class="m-val">' + val + '</div>' +
      '<div class="m-sub">' + (o.sub || '') + '</div>' +
      (o.bar != null ? '<div class="m-bar"><i style="width:' + Math.max(0, Math.min(100, o.bar)) + '%"></i></div>' : '') +
      '</div>';
  }

  function renderMetrics(res) {
    var box = $('ropeMetrics');
    if (!box) return;

    if (!res) {
      box.innerHTML =
        metricCard({ name: '总次数', value: null, sub: '分析后显示有效起跳次数' }) +
        metricCard({ name: '每分钟次数', value: null, sub: '按起跳间隔计算' }) +
        metricCard({ name: '平均跳高', value: null, sub: '脚踝离地高度，按身高换算' }) +
        metricCard({ name: '节奏一致性', value: null, sub: '间隔越均匀，分数越高' });
      return;
    }

    var s = res.stats;
    box.innerHTML =
      metricCard({
        name: '总次数', value: s.count, unit: '次', tag: '本段',
        sub: '有效起跳 · 活跃 ' + fmtNum(s.activeSeconds, 1, 's')
      }) +
      metricCard({
        name: '每分钟次数', value: s.cadence, unit: '次/分', tag: '节奏',
        sub: '整体 ' + fmtNum(s.overallCadence, 0, ' 次/分') + ' · 中位间隔 ' + fmtNum(s.medianInterval, 2, 's')
      }) +
      metricCard({
        name: '平均跳高', value: s.avgHeight, unit: 'cm', tag: '平均',
        sub: '中位 ' + fmtNum(s.medianHeight, 1, 'cm') + ' · 脚踝离地'
      }) +
      metricCard({
        name: '节奏一致性', value: s.rhythmScore, unit: '分', tag: rhythmLabel(s.rhythmScore),
        sub: '间隔波动 ' + (s.cv == null ? '—' : round(s.cv * 100, 1) + '%') + ' · 越稳越高',
        bar: s.rhythmScore
      });
  }

  /* ---------------- 本段小结 ---------------- */

  function renderSummary(res) {
    var box = $('ropeSummary');
    if (!box) return;

    if (!res) {
      box.innerHTML =
        '<div class="card-head"><h2>本段小结</h2><span class="sub">还没有数据</span></div>' +
        '<div class="rope-sum-body">' +
        '<p class="rope-verdict">上传一段跳绳视频，这里会给出次数、节奏和断绳位置。</p>' +
        '<ul class="rope-warn">' +
        '<li>固定机位，手机别手持跟拍。</li>' +
        '<li>头顶到脚踝都要在画面里，人物占画面高度一半以上。</li>' +
        '<li>跳绳离地 3–10cm，远景里只有几个像素，测不出来。</li>' +
        '</ul></div>';
      return;
    }

    var s = res.stats;
    var verdict;
    if (s.rhythmScore == null) verdict = '有效起跳间隔太少，节奏分样本不够；至少需要 3 个完整间隔。';
    else if (s.rhythmScore >= 85) verdict = '节奏很稳，间隔几乎一致，保持这个速度。';
    else if (s.rhythmScore >= 70) verdict = '整体节奏不错，注意后半段别抢拍。';
    else if (s.rhythmScore >= 50) verdict = '节奏有起伏，先用慢速跳把间隔压稳，再加速度。';
    else verdict = '间隔波动较大，建议先降低速度，保证每次起跳高度一致。';

    if (s.avgHeight != null && s.avgHeight < 3) {
      verdict += ' 跳高偏低，绳子可能容易绊脚；可以稍微抬高一点。';
    } else if (s.avgHeight != null && s.avgHeight > 15) {
      verdict += ' 跳高偏高，落地冲击会更大；跳绳通常 3–8cm 就够过绳。';
    }

    var breaks = res.breaks || [];
    var breakHtml = '';
    if (breaks.length) {
      breakHtml = '<div class="rope-break-list"><b>断绳 / 幅度骤降</b>' +
        breaks.slice(0, 6).map(function (b) {
          return '<button class="rope-break-item" data-t="' + b.t0 + '">' +
            '<span>' + esc(b.label) + '</span><i>' + fmtTime(b.t0) + ' – ' + fmtTime(b.t1) + '</i></button>';
        }).join('') +
        (breaks.length > 6 ? '<p class="rope-more">还有 ' + (breaks.length - 6) + ' 处，见时间轴上的浅色区间。</p>' : '') +
        '</div>';
    }

    var warns = (res.meta.warnings || []).map(function (w) {
      return '<li>' + esc(w) + '</li>';
    }).join('');

    box.innerHTML =
      '<div class="card-head"><h2>本段小结</h2><span class="sub">' +
      fmtNum(s.activeSeconds, 1, 's') + ' 内 ' + s.count + ' 次</span></div>' +
      '<div class="sum-grid rope-sum-grid">' +
      '<div class="sum-cell"><b>' + s.count + '</b><span>总次数</span><i>有效起跳</i></div>' +
      '<div class="sum-cell"><b>' + fmtNum(s.cadence, 0) + '</b><span>次/分</span><i>中位节奏</i></div>' +
      '<div class="sum-cell"><b>' + fmtNum(s.avgHeight, 1) + '</b><span>cm</span><i>平均跳高</i></div>' +
      '<div class="sum-cell"><b>' + fmtNum(s.breakCount, 0) + '</b><span>处</span><i>断绳 / 骤降</i></div>' +
      '</div>' +
      '<div class="rope-sum-body">' +
      '<p class="rope-verdict">' + esc(verdict) + '</p>' +
      breakHtml +
      (warns ? '<ul class="rope-warn">' + warns + '</ul>' : '') +
      '</div>';

    box.querySelectorAll('.rope-break-item').forEach(function (b) {
      b.addEventListener('click', function () {
        seekTime(parseFloat(b.getAttribute('data-t')) || 0);
      });
    });
  }

  /* ---------------- 跳跃记录 ---------------- */

  function renderLog(res) {
    var card = $('ropeLogCard');
    var rows = $('ropeLogRows');
    var sub = $('ropeLogSub');
    if (!card || !rows) return;

    if (!res || !res.jumps.length) {
      card.hidden = true;
      rows.innerHTML = '';
      return;
    }

    card.hidden = false;
    if (sub) sub.textContent = '共 ' + res.jumps.length + ' 次 · 点击跳到那一次';

    var breakGap = Math.max(0.9, (res.stats.medianInterval || 0.55) * 2.0);
    rows.innerHTML = res.jumps.map(function (j, i) {
      var note = j.low ? '<span class="tag-low">幅度偏低</span>'
        : (j.interval != null && j.interval > breakGap ? '<span class="tag-gap">停顿后</span>' : '');
      return '<tr data-idx="' + i + '" data-t="' + j.t + '">' +
        '<td class="c-idx">' + (i + 1) + '</td>' +
        '<td>' + fmtTime(j.t) + '</td>' +
        '<td>' + (j.interval == null ? '<span class="na">—</span>' : '+' + j.interval.toFixed(2) + 's') + '</td>' +
        '<td>' + (j.heightCm == null ? '<span class="na">—</span>' : j.heightCm.toFixed(1) + ' <span class="u">cm</span>') + '</td>' +
        '<td>' + note + '</td>' +
        '</tr>';
    }).join('');

    rows.querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () {
        seekTime(parseFloat(tr.getAttribute('data-t')) || 0);
      });
    });
  }

  function setActiveJump(idx) {
    if (R.activeJump === idx) return;
    R.activeJump = idx;
    var rows = $('ropeLogRows');
    if (rows) {
      rows.querySelectorAll('tr').forEach(function (tr) {
        tr.classList.toggle('active', +tr.getAttribute('data-idx') === idx);
      });
      if (idx != null) {
        var cur = rows.querySelector('tr[data-idx="' + idx + '"]');
        if (cur && cur.scrollIntoView) {
          try { cur.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 老浏览器忽略 */ }
        }
      }
    }
  }

  /* ---------------- 时间轴 ---------------- */

  function renderMarks(res) {
    var box = $('ropeTrackMarks');
    if (!box) return;
    if (!res || !R.duration) { box.innerHTML = ''; return; }

    var html = '';
    (res.breaks || []).forEach(function (b) {
      var l = Math.max(0, Math.min(100, b.t0 / R.duration * 100));
      var r = Math.max(l, Math.min(100, b.t1 / R.duration * 100));
      html += '<span class="rope-break-band ' + (b.type === 'low' ? 'is-low' : '') +
        '" style="left:' + l + '%;width:' + (r - l) + '%"></span>';
    });
    res.jumps.forEach(function (j, i) {
      var l = Math.max(0, Math.min(100, j.t / R.duration * 100));
      html += '<i class="mark ' + (j.low ? 'jump-low' : 'jump') + '" style="left:' + l + '%" title="第 ' + (i + 1) + ' 次 · ' + fmtTime(j.t) + '"></i>';
    });
    box.innerHTML = html;
  }

  /* ---------------- 节奏曲线 ---------------- */

  function drawChart(playT) {
    var cv = R.chart;
    var ctx = R.cctx;
    if (!cv || !ctx) return;
    var fit = fitCanvas(cv, ctx);
    if (!fit) return;
    var w = fit.w, h = fit.h;

    ctx.clearRect(0, 0, w, h);

    if (!R.res || !R.res.curve || !R.res.curve.length) {
      ctx.fillStyle = '#aab3c0';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('分析后这里会显示跳绳的纵向节奏曲线', w / 2, h / 2);
      return;
    }

    var pad = { l: 36, r: 14, t: 16, b: 24 };
    var iw = Math.max(10, w - pad.l - pad.r);
    var ih = Math.max(10, h - pad.t - pad.b);
    var dur = R.duration || 1;

    var curve = R.res.curve;
    var maxV = 0;
    for (var i = 0; i < curve.length; i++) {
      var v = curve[i][1];
      if (v != null && v > maxV) maxV = v;
    }
    var thr = (R.res.meta && R.res.meta.threshold) || 0.01;
    maxV = Math.max(maxV, thr * 1.4, 0.02) * 1.12;

    function X(t) { return pad.l + Math.max(0, Math.min(1, t / dur)) * iw; }
    function Y(v) { return pad.t + (1 - Math.max(0, Math.min(1, v / maxV))) * ih; }

    /* 横向网格 + 刻度 */
    ctx.strokeStyle = '#eef1f5';
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#aab3c0';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (var g = 0; g <= 2; g++) {
      var val = maxV * g / 2;
      var y = Y(val);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillText((val * 100).toFixed(1) + '%', pad.l - 5, y);
    }

    /* 断绳区间底色 */
    (R.res.breaks || []).forEach(function (b) {
      var x0 = X(b.t0), x1 = X(b.t1);
      ctx.fillStyle = b.type === 'low' ? 'rgba(220,38,38,.06)' : 'rgba(217,119,6,.07)';
      ctx.fillRect(x0, pad.t, Math.max(1, x1 - x0), ih);
    });

    /* 起跳阈值 */
    var ty = Y(thr);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(249,115,22,.45)';
    ctx.beginPath();
    ctx.moveTo(pad.l, ty);
    ctx.lineTo(w - pad.r, ty);
    ctx.stroke();
    ctx.restore();

    /* 主信号 */
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    var started = false;
    for (var j = 0; j < curve.length; j++) {
      var t = curve[j][0];
      var s = curve[j][1];
      if (s == null) { started = false; continue; }
      var x = X(t), yy = Y(s);
      if (!started) { ctx.moveTo(x, yy); started = true; }
      else ctx.lineTo(x, yy);
    }
    ctx.stroke();

    /* 每次起跳的峰值 */
    R.res.jumps.forEach(function (jump) {
      var x = X(jump.t);
      var y = Y(jump.amp);
      ctx.beginPath();
      ctx.fillStyle = jump.low ? '#d97706' : '#ea580c';
      ctx.arc(x, y, jump.low ? 2.4 : 3, 0, Math.PI * 2);
      ctx.fill();
    });

    /* 当前播放位置 */
    if (playT != null && isFinite(playT)) {
      var px = X(playT);
      ctx.strokeStyle = 'rgba(23,27,35,.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, pad.t);
      ctx.lineTo(px, pad.t + ih);
      ctx.stroke();
    }

    /* 轴标签 */
    ctx.fillStyle = '#aab3c0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('身体比例', pad.l, 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(fmtTime(dur), w - pad.r, h - 4);
    ctx.textAlign = 'left';
    ctx.fillText('0:00', pad.l, h - 4);
  }

  /* ---------------- 骨骼叠加 ---------------- */

  var BONES = [
    [11, 12], [11, 23], [12, 24], [23, 24],
    [11, 13], [13, 15], [12, 14], [14, 16],
    [23, 25], [25, 27], [24, 26], [26, 28],
    [11, 0], [12, 0]
  ];

  function drawOverlay(t) {
    var cv = R.overlay, ctx = R.octx;
    if (!cv || !ctx) return;
    var fit = fitCanvas(cv, ctx);
    if (!fit) return;
    var w = fit.w, h = fit.h;
    ctx.clearRect(0, 0, w, h);
    if (!R.res || !R.res.bundle || !R.res.bundle.length) return;

    var box = videoBox(w, h);
    var dur = R.duration || 1;
    var idx = Math.round(Math.max(0, Math.min(1, t / dur)) * (R.res.bundle.length - 1));
    var src = R.res.frameSrc && R.res.frameSrc[idx];
    if (src === 'none') return;

    var pts = R.res.bundle[idx];
    function px(k) { return box.x + pts[k * 2] * box.w; }
    function py(k) { return box.y + pts[k * 2 + 1] * box.h; }

    /* 站立脚踝参考线：让「跳起来多少」有个视觉参照 */
    var baseY = box.y + (R.res.meta.ankleBaseline || 0) * box.h;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(249,115,22,.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(box.x + 4, baseY);
    ctx.lineTo(box.x + box.w - 4, baseY);
    ctx.stroke();
    ctx.restore();

    /* 骨架 */
    ctx.strokeStyle = 'rgba(249,115,22,.92)';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    BONES.forEach(function (b) {
      ctx.beginPath();
      ctx.moveTo(px(b[0]), py(b[0]));
      ctx.lineTo(px(b[1]), py(b[1]));
      ctx.stroke();
    });
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(234,88,12,.9)';
    ctx.lineWidth = 1.6;
    for (var k = 0; k < 33; k++) {
      if (k === 0 || k === 11 || k === 12 || k === 13 || k === 14 || k === 15 || k === 16 ||
        k === 23 || k === 24 || k === 25 || k === 26 || k === 27 || k === 28) {
        ctx.beginPath();
        ctx.arc(px(k), py(k), 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    /* 当前这次起跳：髋部画个圈 + 标次数 */
    if (R.activeJump != null && R.res.jumps[R.activeJump]) {
      var j = R.res.jumps[R.activeJump];
      var hx = (px(23) + px(24)) / 2;
      var hy = (py(23) + py(24)) / 2;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(249,115,22,.9)';
      ctx.lineWidth = 2;
      ctx.arc(hx, hy, 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(23,27,35,.72)';
      var label = '第 ' + (R.activeJump + 1) + ' 跳';
      ctx.font = '600 12px system-ui, sans-serif';
      var tw = ctx.measureText(label).width;
      ctx.fillRect(hx + 22, hy - 24, tw + 14, 20);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, hx + 29, hy - 14);
    }
  }

  /* ---------------- 播放与时间轴联动 ---------------- */

  function updateFromVideo() {
    var v = R.video;
    if (!v) return;
    var t = v.currentTime || 0;
    var dur = R.duration || v.duration || 0;
    var ratio = dur ? t / dur : 0;

    var fill = $('ropeTrackFill'), head = $('ropeTrackHead');
    if (fill) fill.style.width = (ratio * 100) + '%';
    if (head) head.style.left = (ratio * 100) + '%';

    var tl = $('ropeTime');
    if (tl) tl.textContent = t.toFixed(2) + 's';

    var fb = $('ropeFrameBadge');
    if (fb) {
      var fps = (R.res && R.res.meta.fps) || 30;
      fb.textContent = fmtTime(t) + ' / 第 ' + Math.round(t * fps) + ' 帧';
    }

    var lt = $('ropeLiveT');
    if (lt) lt.textContent = t.toFixed(2) + 's';

    var near = null;
    if (R.res && R.res.jumps && R.res.jumps.length) {
      var jumps = R.res.jumps;
      for (var i = 0; i < jumps.length; i++) {
        if (Math.abs(jumps[i].t - t) <= 0.28) { near = i; break; }
      }
      var passed = 0;
      for (var k = 0; k < jumps.length; k++) if (jumps[k].t <= t + 0.001) passed++;
      var jl = $('ropeLiveJump');
      var jv = $('ropeLiveVals');
      if (jl) {
        jl.textContent = near != null ? '第 ' + (near + 1) + ' 次' : '已跳 ' + passed + ' 次';
        jl.classList.toggle('hit', near != null);
      }
      if (jv) {
        jv.innerHTML = near != null
          ? '跳高 <b>' + (jumps[near].heightCm == null ? '—' : jumps[near].heightCm.toFixed(1) + ' cm') + '</b>'
          : '本次 <b>—</b>';
      }
      setActiveJump(near);
    }

    drawOverlay(t);
    if (Math.abs(t - R.chartT) > 0.08) {
      R.chartT = t;
      drawChart(t);
    }
  }

  function loop() {
    if (!R.playing) return;
    updateFromVideo();
    R.raf = requestAnimationFrame(loop);
  }

  function play() {
    if (!R.video) return;
    R.video.play().catch(function () { /* 浏览器可能拒绝自动播放 */ });
  }

  function pause() {
    R.playing = false;
    if (R.raf) { cancelAnimationFrame(R.raf); R.raf = 0; }
    if (R.video && !R.video.paused) R.video.pause();
  }

  function toggle() {
    if (!R.video) return;
    if (R.video.paused) play();
    else pause();
  }

  function step(dir) {
    if (!R.video) return;
    pause();
    var fps = (R.res && R.res.meta.fps) || 30;
    seekTime((R.video.currentTime || 0) + dir / fps);
  }

  function seekTime(t) {
    if (!R.video) return;
    var dur = R.duration || R.video.duration || 0;
    R.video.currentTime = Math.max(0, Math.min(dur, t));
    updateFromVideo();
  }

  function seekRatio(r) {
    var dur = R.duration || (R.video && R.video.duration) || 0;
    seekTime(Math.max(0, Math.min(1, r)) * dur);
  }

  /* ---------------- 分析进度 ---------------- */

  function resetAnalyseBar() { R.anRatio = 0; }

  function showAnalyse(ratio, title, text) {
    var panel = $('ropeAnalysing');
    if (panel) panel.hidden = false;
    var tt = $('ropeAnTitle');
    if (tt) tt.textContent = title || '正在分析';
    var r = Math.max(0, Math.min(1, ratio));
    if (r > R.anRatio) R.anRatio = r;
    var bar = $('ropeAnBar');
    if (bar) {
      bar.classList.remove('is-error');
      bar.style.width = Math.round(R.anRatio * 100) + '%';
    }
    var pct = $('ropeAnPct');
    if (pct) pct.textContent = Math.round(R.anRatio * 100) + '%';
    if (text) {
      var tx = $('ropeAnText');
      if (tx) tx.textContent = text;
    }
  }

  function showAnalyseError(msg) {
    var panel = $('ropeAnalysing');
    if (panel) panel.hidden = false;
    var tt = $('ropeAnTitle');
    if (tt) tt.textContent = '没分析成功';
    var bar = $('ropeAnBar');
    if (bar) { bar.style.width = '100%'; bar.classList.add('is-error'); }
    var pct = $('ropeAnPct');
    if (pct) pct.textContent = '';
    var tx = $('ropeAnText');
    if (tx) tx.innerHTML = esc(msg) + '<br><span class="an-hint">换一段固定机位、全身入镜、光线充足的视频再试一次</span>';
    var badge = $('ropeBadge');
    if (badge) { badge.textContent = '分析失败'; badge.classList.remove('real'); }
  }

  /* ---------------- 结果应用 ---------------- */

  function renderAll() {
    renderMetrics(R.res);
    renderSummary(R.res);
    renderLog(R.res);
    renderMarks(R.res);
    drawChart(R.video ? R.video.currentTime : 0);
    updateFromVideo();
  }

  function applyResult(res) {
    R.res = res;
    R.duration = res.meta.duration || R.video.duration || 0;
    R.analyzing = false;

    var panel = $('ropeAnalysing');
    if (panel) panel.hidden = true;
    var badge = $('ropeBadge');
    if (badge) { badge.textContent = '已分析'; badge.classList.add('real'); }
    var change = $('ropeChangeBtn');
    if (change) change.hidden = false;

    var stage = $('ropeStage');
    if (stage) stage.classList.add('has-video');
    var drop = $('ropeDrop');
    if (drop) drop.hidden = true;

    ['ropeTrack', 'ropeControls', 'ropeShortcut', 'ropeLive'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = false;
    });
    var chip = $('ropeStageChip');
    if (chip) {
      chip.hidden = false;
      chip.textContent = res.stats.count + ' 次 · ' + (res.stats.cadence == null ? '—' : res.stats.cadence) + ' 次/分';
    }
    var fb = $('ropeFrameBadge');
    if (fb) fb.hidden = false;

    renderAll();

    try { R.video.currentTime = 0; } catch (e) { /* 忽略 */ }
    updateFromVideo();
    /* 分析期间用户可能已经切到别的项目：只有还停在跳绳页才主动重绘 */
    if (R.visible) {
      requestAnimationFrame(function () {
        drawChart(0);
        drawOverlay(0);
      });
    }
  }

  function resetForNew() {
    R.res = null;
    R.duration = 0;
    R.activeJump = null;
    R.chartT = -1;
    R.anRatio = 0;
    pause();

    var stage = $('ropeStage');
    if (stage) stage.classList.add('has-video');
    var drop = $('ropeDrop');
    if (drop) drop.hidden = true;
    ['ropeTrack', 'ropeControls', 'ropeShortcut', 'ropeLive'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = true;
    });
    var log = $('ropeLogCard');
    if (log) log.hidden = true;
    var fb = $('ropeFrameBadge');
    if (fb) fb.hidden = true;
    var chip = $('ropeStageChip');
    if (chip) chip.hidden = true;
    var marks = $('ropeTrackMarks');
    if (marks) marks.innerHTML = '';
    var badge = $('ropeBadge');
    if (badge) { badge.textContent = '分析中'; badge.classList.remove('real'); }
    var change = $('ropeChangeBtn');
    if (change) change.hidden = false;

    renderMetrics(null);
    renderSummary(null);
    drawChart(null);
    drawOverlay(0);
  }

  function startAnalyze(file) {
    if (!file) return;
    if (!/^video\//.test(file.type || '')) return;
    R.lastFile = file;
    /* 每次分析领一个号：用户连续换视频时，旧分析晚到的结果不能覆盖新结果 */
    var myId = (R.analysisId || 0) + 1;
    R.analysisId = myId;
    /* 同时通知旧分析停手，别让它继续读已经被换掉的 <video> */
    if (R.analysisAbort) R.analysisAbort.abort();
    var abort = new AbortController();
    R.analysisAbort = abort;

    if (R.url) { URL.revokeObjectURL(R.url); R.url = null; }
    R.url = URL.createObjectURL(file);

    resetForNew();
    showAnalyse(0.01, '正在读取视频…', '正在加载姿态模型…');

    var v = R.video;
    v.src = R.url;
    try { v.load(); } catch (e) { /* 忽略 */ }

    var started = false;
    var start = function () {
      if (started || myId !== R.analysisId) return;
      started = true;
      if (!v.videoWidth) {
        showAnalyseError('浏览器读不出这个视频的画面，可能是编码不支持（建议 MP4/H.264 或 WebM）。');
        return;
      }
      var E = BB.RopeEngine;
      if (!E || !E.analyze) {
        showAnalyseError(location.protocol === 'file:'
          ? '分析引擎没加载起来：你是双击打开的 html，浏览器不允许这种打开方式加载模块。用线上版打开就行。'
          : '分析引擎没有加载起来（js/rope-engine.js 没取到），刷新一次页面再试。');
        return;
      }
      R.analyzing = true;
      resetAnalyseBar();
      E.analyze(v, {
        heightCm: height(),
        subject: (file.name || '跳绳视频').replace(/\.[^.]+$/, ''),
        source: '本地上传',
        signal: abort.signal,
        onProgress: function (text, ratio) {
          if (myId !== R.analysisId) return;
          showAnalyse(ratio, '正在分析', text);
        }
      }).then(function (res) {
        if (myId !== R.analysisId) return;
        res.meta.video = R.url;
        applyResult(res);
      }).catch(function (err) {
        if (myId !== R.analysisId) return;
        R.analyzing = false;
        showAnalyseError(String(err && err.message ? err.message : err));
      });
    };

    if (v.readyState >= 1 && v.videoWidth) start();
    else v.addEventListener('loadedmetadata', start, { once: true });
    setTimeout(function () { if (v.readyState >= 1 && v.videoWidth) start(); }, 1500);
  }

  /* 改身高不重跑模型：所有厘米值都按同一把尺线性缩放 */
  function rescaleHeights(newH) {
    var res = R.res;
    if (!res) return;
    var oldH = res.meta.heightCm || 170;
    if (!oldH || !newH || Math.abs(newH - oldH) < 0.01) return;
    var k = newH / oldH;
    res.jumps.forEach(function (j) {
      if (j.heightCm != null) j.heightCm = round(j.heightCm * k, 1);
    });
    var heights = res.jumps.map(function (j) { return j.heightCm; }).filter(function (v) { return v != null; });
    var sum = heights.reduce(function (a, b) { return a + b; }, 0);
    res.stats.avgHeight = heights.length ? round(sum / heights.length, 1) : null;
    var sorted = heights.slice().sort(function (a, b) { return a - b; });
    res.stats.medianHeight = sorted.length
      ? round(sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2, 1)
      : null;
    res.meta.heightCm = newH;
    res.meta.cmPerUnit = round((res.meta.cmPerUnit || 0) * k, 2);
    renderMetrics(res);
    renderSummary(res);
    renderLog(res);
    updateFromVideo();
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    var v = R.video;

    v.addEventListener('loadedmetadata', function () {
      if (v.duration && isFinite(v.duration)) R.duration = v.duration;
    });
    v.addEventListener('timeupdate', function () { if (!R.playing) updateFromVideo(); });
    v.addEventListener('seeked', updateFromVideo);
    v.addEventListener('play', function () {
      R.playing = true;
      var b = $('ropeBtnPlay');
      if (b) { b.innerHTML = '❙❙'; b.classList.add('is-playing'); }
      if (!R.raf) R.raf = requestAnimationFrame(loop);
    });
    v.addEventListener('pause', function () {
      R.playing = false;
      if (R.raf) { cancelAnimationFrame(R.raf); R.raf = 0; }
      var b = $('ropeBtnPlay');
      if (b) { b.innerHTML = '▶'; b.classList.remove('is-playing'); }
      updateFromVideo();
    });
    v.addEventListener('ended', function () {
      R.playing = false;
      var b = $('ropeBtnPlay');
      if (b) { b.innerHTML = '▶'; b.classList.remove('is-playing'); }
      updateFromVideo();
    });

    var file = $('ropeFile');
    if (file) file.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      /* 清空 value：同一个文件改完再选一次也会触发 change */
      e.target.value = '';
      startAnalyze(f);
    });
    var changeBtn = $('ropeChangeBtn');
    if (changeBtn) changeBtn.addEventListener('click', function () { file.click(); });

    var stage = $('ropeStage');
    if (stage) {
      ['dragenter', 'dragover'].forEach(function (ev) {
        stage.addEventListener(ev, function (e) {
          e.preventDefault();
          stage.classList.add('dragging');
        });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        stage.addEventListener(ev, function (e) {
          e.preventDefault();
          if (ev === 'dragleave' && stage.contains(e.relatedTarget)) return;
          stage.classList.remove('dragging');
        });
      });
      stage.addEventListener('drop', function (e) {
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) startAnalyze(f);
      });
    }

    var playBtn = $('ropeBtnPlay');
    if (playBtn) playBtn.addEventListener('click', toggle);
    var prev = $('ropeBtnPrev');
    if (prev) prev.addEventListener('click', function () { step(-1); });
    var next = $('ropeBtnNext');
    if (next) next.addEventListener('click', function () { step(1); });

    var speeds = $('ropeSpeeds');
    if (speeds) {
      speeds.innerHTML = [0.25, 0.5, 1, 1.5].map(function (s) {
        return '<button class="speed' + (s === 1 ? ' active' : '') + '" data-speed="' + s + '">' + s + '×</button>';
      }).join('');
      speeds.querySelectorAll('.speed').forEach(function (b) {
        b.addEventListener('click', function () {
          speeds.querySelectorAll('.speed').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          R.speed = +b.dataset.speed;
          v.playbackRate = R.speed;
        });
      });
    }

    var track = $('ropeTrack');
    if (track) track.addEventListener('click', function (e) {
      var rect = this.getBoundingClientRect();
      if (!rect.width) return;
      seekRatio((e.clientX - rect.left) / rect.width);
    });

    var h = $('ropeHeight');
    if (h) h.addEventListener('change', function () { rescaleHeights(height()); });

    window.addEventListener('resize', function () {
      if (!R.visible) return;
      drawChart(R.video ? R.video.currentTime : 0);
      drawOverlay(R.video ? R.video.currentTime : 0);
    });

    if (window.ResizeObserver) {
      R.resizeObs = new ResizeObserver(function () {
        if (!R.visible) return;
        drawOverlay(R.video ? R.video.currentTime : 0);
      });
      if (stage) R.resizeObs.observe(stage);

      var wrap = R.chart && R.chart.parentNode;
      R.chartObs = new ResizeObserver(function () {
        if (!R.visible) return;
        drawChart(R.video ? R.video.currentTime : 0);
      });
      if (wrap) R.chartObs.observe(wrap);
    }
  }

  function initEngineHint() {
    var hint = $('ropeHint');
    if (location.protocol === 'file:') {
      if (hint) {
        hint.hidden = false;
        hint.classList.add('is-file');
        hint.innerHTML = '双击打开的 html 加载不了分析引擎（浏览器不允许），这不是网站坏了。换成线上地址就能用。';
      }
      return;
    }

    var E = BB.PoseEngine;
    if (!E || !E.onEngineProgress) return;

    E.onEngineProgress(function (s) {
      var overall = s.phase === 'model' ? 0.5 * s.pct : 0.5 + 0.5 * s.pct;

      if (R.analyzing && s.phase !== 'ready' && s.phase !== 'error') {
        showAnalyse(0.02 + 0.46 * overall, '正在准备识别引擎', s.text);
        return;
      }
      if (!hint) return;
      if (s.phase === 'ready' || s.phase === 'idle') { hint.hidden = true; return; }
      if (s.phase === 'error') {
        hint.hidden = false;
        hint.textContent = '识别引擎没加载成功，选中视频时会自动重试';
        return;
      }
      hint.hidden = false;
      hint.innerHTML = s.text + ' · <b>' + Math.round(overall * 100) + '%</b>'
        + '<br>首次使用需下载约 19MB 识别引擎，之后缓存在本机';
    });
  }

  /* ---------------- 对外接口 ---------------- */

  function init() {
    if (R.inited) return;
    R.video = $('ropeVideo');
    if (!R.video) return;
    R.overlay = $('ropeOverlay');
    R.chart = $('ropeChart');
    R.octx = R.overlay ? R.overlay.getContext('2d') : null;
    R.cctx = R.chart ? R.chart.getContext('2d') : null;

    bindEvents();
    initEngineHint();
    renderMetrics(null);
    renderSummary(null);
    drawChart(null);
    R.inited = true;
  }

  function onShow() {
    R.visible = true;
    requestAnimationFrame(function () {
      drawChart(R.video ? R.video.currentTime : 0);
      drawOverlay(R.video ? R.video.currentTime : 0);
      updateFromVideo();
    });
  }

  function onHide() {
    R.visible = false;
    pause();
  }

  BB.Rope = {
    init: init,
    onShow: onShow,
    onHide: onHide,
    toggle: toggle,
    step: step,
    pause: pause,
    seekTime: seekTime
  };
})(window.BB);
