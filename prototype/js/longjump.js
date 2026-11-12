/* ============================================================
 * longjump.js  —  立定跳远界面层
 *
 * 只做「接线」：视频播放、时间轴、指标卡、跳跃记录、起跳时序曲线、
 * 骨骼与起跳线叠加、标尺两点校准。
 * 识别与测量算法在 longjump-engine.js（ES 模块）里。
 *
 * 对外接口（app.js 用）：
 *   init() / onShow() / onHide() / toggle() / step(n) / pause()
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var J = {
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
    sel: 0,             // 当前展示第几跳（默认主跳）
    near: null,         // 播放位置落在哪一跳附近
    chartT: -1,
    anRatio: 0,
    analyzing: false,
    lastFile: null,
    ruler: null,        // { p0, p1 } 校准中的临时点
    hoverPt: null,      // 标尺校准时的橡皮筋终点
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

  /* 距离：1 米以上用米，不到 1 米用厘米 —— 「0.86 m」不如「86 cm」直观 */
  function fmtDist(cm) {
    if (cm == null || !isFinite(cm)) return '<span class="na">—</span>';
    return cm >= 100 ? round(cm / 100, 2) + '<small>m</small>' : round(cm, 0) + '<small>cm</small>';
  }

  function fmtDistText(cm) {
    if (cm == null || !isFinite(cm)) return '—';
    return cm >= 100 ? round(cm / 100, 2) + ' m' : round(cm, 0) + ' cm';
  }

  function height() {
    var el = $('ljHeight');
    var v = el ? parseFloat(el.value) : 175;
    if (!isFinite(v)) v = 175;
    return Math.max(100, Math.min(225, v));
  }

  function jumps() { return (J.res && J.res.jumps) ? J.res.jumps : []; }

  function currentJump() {
    var arr = jumps();
    if (!arr.length) return null;
    if (arr[J.sel]) return arr[J.sel];
    return arr[J.res.primary] || arr[0];
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
    var v = J.video;
    var aspect = (J.res && J.res.meta.videoAspect) || (v && v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 0);
    if (!aspect || !w || !h) return { x: 0, y: 0, w: w, h: h };
    var stageA = w / h;
    var bw, bh;
    if (aspect > stageA) { bw = w; bh = w / aspect; }
    else { bh = h; bw = h * aspect; }
    return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
  }

  /* ---------------- 指标卡 ---------------- */

  function distLabel(score) {
    if (score == null) return '—';
    if (score >= 80) return '优秀';
    if (score >= 60) return '良好';
    if (score >= 40) return '一般';
    return '偏近';
  }

  function angleLabel(a) {
    if (a == null) return '—';
    if (a < 28) return '偏平';
    if (a < 32) return '略低';
    if (a <= 45) return '合理';
    return '偏陡';
  }

  function flightLabel(d) {
    if (d == null) return '—';
    if (d < 0.36) return '偏短';
    if (d <= 0.62) return '正常';
    return '较长';
  }

  function scoreLabel(s) {
    if (s == null) return '—';
    if (s >= 85) return '很好';
    if (s >= 70) return '不错';
    if (s >= 55) return '及格';
    return '待改';
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

  function renderMetrics() {
    var box = $('ljMetrics');
    if (!box) return;

    var j = currentJump();
    if (!j) {
      box.innerHTML =
        metricCard({ name: '跳跃距离', value: null, sub: '起跳脚尖到落地脚跟' }) +
        metricCard({ name: '起跳角', value: null, sub: '重心速度与水平面的夹角' }) +
        metricCard({ name: '腾空时间', value: null, sub: '脚尖离地到脚跟触地' }) +
        metricCard({ name: '综合评分', value: null, sub: '距离 / 角度 / 时序 / 摆臂 / 落地' });
      return;
    }

    var s = j.scores || {};
    var ratio = (j.distCm != null && J.res.meta.heightCm) ? j.distCm / J.res.meta.heightCm : null;

    box.innerHTML =
      metricCard({
        name: '跳跃距离', value: j.distCm == null ? null : (j.distCm >= 100 ? round(j.distCm / 100, 2) : round(j.distCm, 0)),
        unit: j.distCm != null && j.distCm >= 100 ? 'm' : 'cm',
        tag: distLabel(s.dist),
        sub: '距离 / 身高 ' + fmtNum(ratio, 2) + ' · 第 ' + j.id + ' 跳'
      }) +
      metricCard({
        name: '起跳角', value: j.takeoffAngle, unit: '°', tag: angleLabel(j.takeoffAngle),
        sub: '理想 32–45° · 偏平跳不高，偏陡丢水平速度'
      }) +
      metricCard({
        name: '腾空时间', value: j.dur == null ? null : round(j.dur, 2), unit: 's', tag: flightLabel(j.dur),
        sub: '最高点 ' + fmtNum(j.flightHCm, 0, 'cm') + ' · 下蹲 ' + fmtNum(j.crouchCm, 0, 'cm')
      }) +
      metricCard({
        name: '综合评分', value: j.score, unit: '分', tag: scoreLabel(j.score),
        sub: '距离 40% · 角度/时序/摆臂/落地 各 15%',
        bar: j.score
      });
  }

  /* ---------------- 本段小结 ---------------- */

  function advice(j) {
    var s = j.scores || {};
    var weak = null, weakV = 999;
    [['dist', s.dist], ['angle', s.angle], ['ext', s.ext], ['arm', s.arm], ['land', s.land]].forEach(function (p) {
      if (p[1] == null) return;
      if (p[1] < weakV) { weakV = p[1]; weak = p[0]; }
    });

    if (weak === 'dist') return '距离是最直接的短板。先看下蹲够不够深、摆臂有没有甩起来 —— 只靠小腿蹬，跳不远。';
    if (weak === 'angle') {
      return j.takeoffAngle != null && j.takeoffAngle < 32
        ? '起跳角偏平，重心往前冲得多、往上抬得少。起跳前把胸口立起来一点，蹬伸方向更朝上。'
        : '起跳角偏陡，高度有了但水平速度被吃掉。蹬地时身体别太直，顺势往前送。';
    }
    if (weak === 'ext') {
      /* 三个峰值挤在一帧里的时候，任何「顺序」都是编出来的。
         与其报一个可能是错的结论，不如直接说清分辨率不够。 */
      if (j.extTie) {
        return '髋、膝、踝的伸展峰值几乎同时出现（间隔 ' + Math.round(j.extSpread || 0) +
          'ms，小于 30fps 的一帧）。这个分辨率下分不出先后，所以这里不下顺序结论 —— 想看清三段发力，用 60fps 或慢动作重拍一次。';
      }
      return j.extOk
        ? '蹬伸顺序对了（髋→膝→踝），但三段挤得太近，等于一起伸。慢动作里把「先展髋、再蹬膝、最后压踝」分开做。'
        : '蹬伸顺序是「' + (j.extOrder || '—') + '」，标准是髋→膝→踝。膝比髋早，力量没经过髋就被用掉了，这是跳不远最常见的原因。';
    }
    if (weak === 'arm') {
      var lag = j.armLag;
      if (j.armAmp != null && j.armAmp < 40) return '几乎没有摆臂。立定跳远里手臂能贡献一成以上的距离，先练「后摆到位、前摆到底」。';
      if (lag != null && lag > 0) return '手臂前摆比起跳晚了 ' + Math.round(lag) + 'ms，人都离地了才甩手，力量用不上。让摆臂和蹬地在同一拍上。';
      return '手臂前摆比起跳早了 ' + Math.round(Math.abs(lag || 0)) + 'ms，摆完才蹬地，动量没接上。把摆臂压到最后一下再放。';
    }
    if (weak === 'land') {
      if (j.handTouch) return '落地后手撑地了。撑地的位置会成为丈量点，成绩按最靠后的触地点算 —— 这一跳会被判得更近。';
      if (j.backCm != null && j.backCm > 3) return '落地后重心后移了 ' + round(j.backCm, 0) + 'cm，成绩同样按最靠后的触地点算。落地时把髋往前送、膝盖主动缓冲。';
      return '落地缓冲不够（最低膝角 ' + round(j.minKnee || 0, 0) + '°），冲击全给了关节。落地别锁膝。';
    }
    return '各项都在合理区间，继续打磨起跳的爆发力。';
  }

  function renderSummary() {
    var box = $('ljSummary');
    if (!box) return;

    if (!J.res || !jumps().length) {
      box.innerHTML =
        '<div class="card-head"><h2>本段小结</h2><span class="sub">还没有数据</span></div>' +
        '<div class="lj-sum-body">' +
        '<p class="lj-verdict">上传一段立定跳远视频，这里会给出距离、起跳角、蹬伸时序和落地评价。</p>' +
        '<ul class="lj-warn">' +
        '<li>正侧面机位，镜头垂直对着跳跃方向。</li>' +
        '<li>起跳线和落地区都要在画面里，脚不能出画。</li>' +
        '<li>地面放一把卷尺，用「标尺校准」点两点，距离才准。</li>' +
        '</ul></div>';
      return;
    }

    var j = currentJump();
    var st = J.res.stats || {};
    var meta = J.res.meta;
    var ratio = (j.distCm != null && meta.heightCm) ? j.distCm / meta.heightCm : null;

    var details = [];
    details.push(['蹬伸顺序', j.extTie
      ? '几乎同时 · 采样精度内分不出先后'
      : (j.extOrder ? (j.extOk ? j.extOrder + ' ✓' : j.extOrder + ' ✗') : '—')]);
    if (j.ext && j.ext.length === 3) {
      details.push(['各关节峰值', j.ext.map(function (e) {
        return e.name + ' ' + (e.tRel >= 0 ? '+' : '') + Math.round(e.tRel) + 'ms';
      }).join(' · ') + (j.extTie ? '（差值在采样误差内）' : '')]);
    }
    details.push(['摆臂时差', j.armLag == null ? '—'
      : (j.armLag >= 0 ? '晚 ' : '早 ') + Math.abs(Math.round(j.armLag)) + 'ms（相对起跳）']);
    details.push(['最低膝角', j.minKnee == null ? '—' : round(j.minKnee, 0) + '°（落地缓冲）']);
    details.push(['落地后移', j.backCm == null ? '—'
      : (j.backCm > 0 ? '后退 ' + round(j.backCm, 0) + 'cm' : '前送 ' + round(-j.backCm, 0) + 'cm')]);

    var detailHtml = '<div class="lj-detail">' + details.map(function (d) {
      return '<div class="lj-detail-row"><span>' + esc(d[0]) + '</span><b>' + esc(d[1]) + '</b></div>';
    }).join('') + '</div>';

    var scaleTxt = meta.scaleMethod === 'ruler'
      ? '标尺 ' + round(meta.ruler.lenCm, 0) + 'cm'
      : '身高 ' + round(meta.heightCm, 0) + 'cm';
    var scaleWarn = meta.scaleMethod === 'ruler' ? '' :
      '<p class="lj-scale-note">比例尺来自身高换算。地面放一把卷尺再点「标尺校准」，距离能再准一截。</p>';

    var warns = (meta.warnings || []).map(function (w) {
      return '<li>' + esc(w) + '</li>';
    }).join('');

    box.innerHTML =
      '<div class="card-head"><h2>本段小结</h2><span class="sub">共 ' + jumps().length + ' 跳 · 最远 ' +
      fmtDistText(st.bestDist) + '</span></div>' +
      '<div class="sum-grid lj-sum-grid">' +
      '<div class="sum-cell"><b>' + fmtNum(ratio, 2) + '</b><span>倍身高</span><i>距离 / 身高</i></div>' +
      '<div class="sum-cell"><b>' + fmtNum(j.crouchCm, 0) + '</b><span>cm</span><i>起跳前下蹲</i></div>' +
      '<div class="sum-cell"><b>' + fmtNum(j.flightHCm, 0) + '</b><span>cm</span><i>腾空最高点</i></div>' +
      '<div class="sum-cell"><b>' + fmtNum(j.backCm == null ? null : Math.max(0, j.backCm), 0) + '</b><span>cm</span><i>落地后移</i></div>' +
      '</div>' +
      '<div class="lj-sum-body">' +
      '<p class="lj-verdict">' + esc(advice(j)) + '</p>' +
      detailHtml +
      '<p class="lj-scale-line">比例尺：' + esc(scaleTxt) + ' · 第 ' + j.id + ' 跳</p>' +
      scaleWarn +
      (warns ? '<ul class="lj-warn">' + warns + '</ul>' : '') +
      '</div>';
  }

  /* ---------------- 跳跃记录 ---------------- */

  function renderLog() {
    var card = $('ljLogCard');
    var rows = $('ljLogRows');
    var sub = $('ljLogSub');
    if (!card || !rows) return;

    var arr = jumps();
    if (!arr.length) {
      card.hidden = true;
      rows.innerHTML = '';
      return;
    }

    card.hidden = false;
    if (sub) sub.textContent = '共 ' + arr.length + ' 跳 · 点击跳到那一跳';

    rows.innerHTML = arr.map(function (j, i) {
      var note = '';
      if (i === J.res.primary) note += '<span class="tag-best">主跳</span>';
      if (j.handTouch) note += '<span class="tag-low">手撑地</span>';
      else if (j.backCm != null && j.backCm > 3) note += '<span class="tag-low">后退</span>';
      if (j.extTie) note += '<span class="tag-gap">同时</span>';
      else if (!j.extOk && j.extOrder) note += '<span class="tag-gap">顺序</span>';
      return '<tr data-idx="' + i + '" data-t="' + j.t0 + '">' +
        '<td class="c-idx">' + (i + 1) + '</td>' +
        '<td>' + (j.distCm == null ? '<span class="na">—</span>' : fmtDistText(j.distCm)) + '</td>' +
        '<td>' + (j.dur == null ? '<span class="na">—</span>' : j.dur.toFixed(2) + ' <span class="u">s</span>') + '</td>' +
        '<td>' + (j.takeoffAngle == null ? '<span class="na">—</span>' : j.takeoffAngle.toFixed(1) + ' <span class="u">°</span>') + '</td>' +
        '<td class="c-score">' + (j.score == null ? '<span class="na">—</span>' : j.score) + '</td>' +
        '<td>' + note + '</td>' +
        '</tr>';
    }).join('');

    rows.querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () {
        J.sel = +tr.getAttribute('data-idx');
        seekTime(parseFloat(tr.getAttribute('data-t')) || 0);
        renderMetrics();
        renderSummary();
        drawChart();
        setActiveRow(J.sel);
      });
    });
    setActiveRow(J.sel);
  }

  function setActiveRow(idx) {
    var rows = $('ljLogRows');
    if (!rows) return;
    rows.querySelectorAll('tr').forEach(function (tr) {
      tr.classList.toggle('active', +tr.getAttribute('data-idx') === idx);
    });
  }

  /* ---------------- 时间轴 ---------------- */

  function renderMarks() {
    var box = $('ljTrackMarks');
    if (!box) return;
    if (!J.res || !J.duration) { box.innerHTML = ''; return; }

    var html = '';
    jumps().forEach(function (j, i) {
      var l = Math.max(0, Math.min(100, j.t0 / J.duration * 100));
      var r = Math.max(l, Math.min(100, j.t1 / J.duration * 100));
      /* 腾空区间画成一条浅色带，起跳点再点一个标记 */
      html += '<span class="lj-flight-band" style="left:' + l + '%;width:' + (r - l) + '%"></span>';
      html += '<i class="mark lj-jump' + (i === J.res.primary ? ' is-best' : '') + '" style="left:' + l +
        '%" title="第 ' + (i + 1) + ' 跳 · ' + fmtTime(j.t0) + ' · ' + fmtDistText(j.distCm) + '"></i>';
    });
    box.innerHTML = html;
  }

  /* ---------------- 起跳时序曲线 ---------------- */

  var C_HIP = '#f97316', C_KNEE = '#16a34a', C_ANKLE = '#2563eb', C_ARM = '#94a3b8';

  function drawChart() {
    var cv = J.chart;
    var ctx = J.cctx;
    if (!cv || !ctx) return;
    var fit = fitCanvas(cv, ctx);
    if (!fit) return;
    var w = fit.w, h = fit.h;

    ctx.clearRect(0, 0, w, h);

    var j = currentJump();
    if (!j || !j.timing || !j.timing.length) {
      ctx.fillStyle = '#aab3c0';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('分析后这里会显示起跳前后髋 / 膝 / 踝的伸展时序', w / 2, h / 2);
      return;
    }

    var pad = { l: 34, r: 12, t: 14, b: 22 };
    var iw = Math.max(10, w - pad.l - pad.r);
    var ih = Math.max(10, h - pad.t - pad.b);

    /* x 轴固定成「起跳前 1 秒 → 起跳后 0.6 秒」，不同视频之间可直接对比 */
    var xMin = -1000, xMax = 600;
    var yMin = -40, yMax = 190;

    function X(ms) { return pad.l + (ms - xMin) / (xMax - xMin) * iw; }
    function Y(deg) { return pad.t + (1 - (deg - yMin) / (yMax - yMin)) * ih; }

    /* 腾空区间底色 */
    ctx.fillStyle = 'rgba(249,115,22,.06)';
    ctx.fillRect(X(0), pad.t, Math.max(1, X(j.dur * 1000) - X(0)), ih);

    /* 横向网格 */
    ctx.strokeStyle = '#eef1f5';
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#aab3c0';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [0, 45, 90, 135, 180].forEach(function (deg) {
      var y = Y(deg);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillText(deg + '°', pad.l - 5, y);
    });

    /* 起跳时刻 */
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(23,27,35,.32)';
    ctx.beginPath();
    ctx.moveTo(X(0), pad.t);
    ctx.lineTo(X(0), pad.t + ih);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#8b94a3';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('起跳', X(0), pad.t + 1);

    /* 四条曲线：下标 1..4 = 髋 / 膝 / 踝 / 手臂 */
    var series = [[1, C_HIP, 2], [2, C_KNEE, 2], [3, C_ANKLE, 2], [4, C_ARM, 1.4]];
    series.forEach(function (s) {
      var col = s[0], color = s[1], lw = s[2];
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      var started = false;
      for (var i = 0; i < j.timing.length; i++) {
        var row = j.timing[i];
        var v = row[col];
        if (v == null) { started = false; continue; }
        var x = X(row[0]), y = Y(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    /* 三个关节的伸展峰值：圈出来，让「谁先谁后」一眼可见 */
    (j.ext || []).forEach(function (e) {
      var idx = e.name === '髋' ? 1 : (e.name === '膝' ? 2 : 3);
      var color = idx === 1 ? C_HIP : (idx === 2 ? C_KNEE : C_ANKLE);
      var x = X(e.tRel), y = Y(e.angle);
      ctx.beginPath();
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    /* 轴标签 */
    ctx.fillStyle = '#aab3c0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('关节伸展角', pad.l, 1);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('第 ' + j.id + ' 跳 · 起跳前后', w - pad.r, h - 3);
    ctx.textAlign = 'left';
    ctx.fillText('-1.0s', pad.l, h - 3);
    ctx.textAlign = 'center';
    ctx.fillText('0', X(0), h - 3);
    ctx.textAlign = 'right';
    ctx.fillText('+0.6s', w - pad.r - 60, h - 3);
  }

  /* ---------------- 骨骼与起跳线叠加 ---------------- */

  var BONES = [
    [11, 12], [11, 23], [12, 24], [23, 24],
    [11, 13], [13, 15], [12, 14], [14, 16],
    [23, 25], [25, 27], [24, 26], [26, 28],
    [27, 31], [28, 32],
    [11, 0], [12, 0]
  ];

  function drawOverlay(t) {
    var cv = J.overlay, ctx = J.octx;
    if (!cv || !ctx) return;
    var fit = fitCanvas(cv, ctx);
    if (!fit) return;
    var w = fit.w, h = fit.h;
    ctx.clearRect(0, 0, w, h);

    var box = videoBox(w, h);

    /* ---- 标尺 ---- */
    var ruler = (J.res && J.res.meta.ruler) || null;
    if (ruler && ruler.p0 && ruler.p1) {
      drawRulerLine(ctx, box, ruler.p0, ruler.p1, round(ruler.lenCm, 0) + 'cm');
    }
    if (J.ruler && J.ruler.p0) {
      /* 校准中：已点的第一端 + 跟随鼠标的橡皮筋 */
      var p1 = J.ruler.p1 || J.hoverPt || J.ruler.p0;
      drawRulerLine(ctx, box, J.ruler.p0, p1, J.ruler.p1 ? '…' : '');
      dot(ctx, box, J.ruler.p0, '#f97316');
    }

    if (!J.res || !J.res.bundle || !J.res.bundle.length) return;

    var dur = J.duration || 1;
    var idx = Math.round(Math.max(0, Math.min(1, t / dur)) * (J.res.bundle.length - 1));
    var src = J.res.frameSrc && J.res.frameSrc[idx];
    if (src === 'none') return;

    var pts = J.res.bundle[idx];
    function px(k) { return box.x + pts[k * 2] * box.w; }
    function py(k) { return box.y + pts[k * 2 + 1] * box.h; }

    /* ---- 起跳线 / 落地线 / 距离标注 ---- */
    var j = currentJump();
    if (j && j.x0 != null && j.x1 != null) {
      var groundY = box.y + (J.res.meta.heelBaseline || 0.9) * box.h;
      var xa = box.x + j.x0 * box.w;
      var xb = box.x + j.x1 * box.w;
      var top = Math.max(box.y + 4, groundY - box.h * 0.30);

      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(249,115,22,.85)';
      ctx.beginPath();
      ctx.moveTo(xa, top); ctx.lineTo(xa, groundY + 8);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(22,163,74,.85)';
      ctx.beginPath();
      ctx.moveTo(xb, top); ctx.lineTo(xb, groundY + 8);
      ctx.stroke();
      ctx.restore();

      /* 距离箭头画在地面下方 */
      var ay = Math.min(box.y + box.h - 10, groundY + 18);
      ctx.strokeStyle = 'rgba(23,27,35,.55)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(xa, ay);
      ctx.lineTo(xb, ay);
      ctx.stroke();
      [[xa, 1], [xb, -1]].forEach(function (p) {
        ctx.beginPath();
        ctx.moveTo(p[0], ay);
        ctx.lineTo(p[0] + 5 * p[1], ay - 3.5);
        ctx.lineTo(p[0] + 5 * p[1], ay + 3.5);
        ctx.closePath();
        ctx.fillStyle = 'rgba(23,27,35,.55)';
        ctx.fill();
      });

      var label = fmtDistText(j.distCm);
      ctx.font = '600 12px system-ui, sans-serif';
      var tw = ctx.measureText(label).width;
      var mx = (xa + xb) / 2;
      ctx.fillStyle = 'rgba(23,27,35,.78)';
      ctx.beginPath();
      roundRect(ctx, mx - tw / 2 - 7, ay - 21, tw + 14, 17, 5);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, ay - 12.5);

      /* 起跳点 / 落地点 */
      dot(ctx, box, [j.x0, (J.res.meta.toeBaseline || 0.97)], '#f97316');
      dot(ctx, box, [j.x1, (J.res.meta.heelBaseline || 0.9)], '#16a34a');
    }

    /* ---- 骨架 ---- */
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
    [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32].forEach(function (k) {
      ctx.beginPath();
      ctx.arc(px(k), py(k), 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  function dot(ctx, box, p, color) {
    var x = box.x + p[0] * box.w;
    var y = box.y + p[1] * box.h;
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  function drawRulerLine(ctx, box, p0, p1, label) {
    var x0 = box.x + p0[0] * box.w, y0 = box.y + p0[1] * box.h;
    var x1 = box.x + p1[0] * box.w, y1 = box.y + p1[1] * box.h;

    ctx.save();
    ctx.strokeStyle = 'rgba(37,99,235,.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    /* 两端画小方块，方便确认点的是不是卷尺的头 */
    [[x0, y0], [x1, y1]].forEach(function (p) {
      ctx.beginPath();
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(37,99,235,.95)';
      ctx.lineWidth = 2;
      ctx.rect(p[0] - 4, p[1] - 4, 8, 8);
      ctx.fill();
      ctx.stroke();
    });
    ctx.restore();

    if (label) {
      ctx.font = '600 11px system-ui, sans-serif';
      var tw = ctx.measureText(label).width;
      var mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      ctx.fillStyle = 'rgba(37,99,235,.88)';
      ctx.beginPath();
      roundRect(ctx, mx - tw / 2 - 6, my - 18, tw + 12, 16, 4);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, my - 10);
    }
  }

  /* ---------------- 播放与时间轴联动 ---------------- */

  function updateFromVideo() {
    var v = J.video;
    if (!v) return;
    var t = v.currentTime || 0;
    var dur = J.duration || v.duration || 0;
    var ratio = dur ? t / dur : 0;

    var fill = $('ljTrackFill'), head = $('ljTrackHead');
    if (fill) fill.style.width = (ratio * 100) + '%';
    if (head) head.style.left = (ratio * 100) + '%';

    var tl = $('ljTime');
    if (tl) tl.textContent = t.toFixed(2) + 's';

    var fb = $('ljFrameBadge');
    if (fb) {
      var fps = (J.res && J.res.meta.fps) || 30;
      fb.textContent = fmtTime(t) + ' / 第 ' + Math.round(t * fps) + ' 帧';
    }

    var lt = $('ljLiveT');
    if (lt) lt.textContent = t.toFixed(2) + 's';

    var arr = jumps();
    var near = null;
    if (arr.length) {
      for (var i = 0; i < arr.length; i++) {
        if (t >= arr[i].t0 - 0.15 && t <= arr[i].t1 + 0.15) { near = i; break; }
      }
      var passed = 0;
      for (var k = 0; k < arr.length; k++) if (arr[k].t0 <= t + 0.001) passed++;
      var jl = $('ljLiveJump');
      var jv = $('ljLiveVals');
      if (jl) {
        jl.textContent = near != null ? '第 ' + (near + 1) + ' 跳' : '已跳 ' + passed + ' 跳';
        jl.classList.toggle('hit', near != null);
      }
      if (jv) {
        var jj = near != null ? arr[near] : null;
        jv.innerHTML = jj
          ? '距离 <b>' + fmtDistText(jj.distCm) + '</b> · 起跳角 <b>' + (jj.takeoffAngle == null ? '—' : jj.takeoffAngle.toFixed(1) + '°') + '</b>'
          : '本次 <b>—</b>';
      }
      /* 播放到某一跳时，指标卡跟着切到那一跳 */
      if (near !== J.near) {
        J.near = near;
        if (near != null) {
          J.sel = near;
          renderMetrics();
          renderSummary();
          drawChart();
          setActiveRow(near);
        }
      }
    }

    drawOverlay(t);
    if (Math.abs(t - J.chartT) > 0.08) {
      J.chartT = t;
    }
  }

  function loop() {
    if (!J.playing) return;
    updateFromVideo();
    J.raf = requestAnimationFrame(loop);
  }

  function play() {
    if (!J.video) return;
    J.video.play().catch(function () { /* 浏览器可能拒绝自动播放 */ });
  }

  function pause() {
    J.playing = false;
    if (J.raf) { cancelAnimationFrame(J.raf); J.raf = 0; }
    if (J.video && !J.video.paused) J.video.pause();
  }

  function toggle() {
    if (!J.video) return;
    if (J.video.paused) play();
    else pause();
  }

  function step(dir) {
    if (!J.video) return;
    pause();
    var fps = (J.res && J.res.meta.fps) || 30;
    seekTime((J.video.currentTime || 0) + dir / fps);
  }

  function seekTime(t) {
    if (!J.video) return;
    var dur = J.duration || J.video.duration || 0;
    J.video.currentTime = Math.max(0, Math.min(dur, t));
    updateFromVideo();
  }

  function seekRatio(r) {
    var dur = J.duration || (J.video && J.video.duration) || 0;
    seekTime(Math.max(0, Math.min(1, r)) * dur);
  }

  /* ---------------- 标尺校准 ---------------- */

  function normPoint(e) {
    var cv = J.overlay;
    if (!cv) return null;
    var rect = cv.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var box = videoBox(rect.width, rect.height);
    if (!box.w || !box.h) return null;
    var u = (e.clientX - rect.left - box.x) / box.w;
    var v = (e.clientY - rect.top - box.y) / box.h;
    if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) return null;
    return [Math.max(0, Math.min(1, u)), Math.max(0, Math.min(1, v))];
  }

  function setRulerMode(on) {
    var bar = $('ljRulerBar');
    var tip = $('ljRulerTip');
    var stage = $('ljStage');
    if (on) {
      J.ruler = { p0: null, p1: null };
      J.hoverPt = null;
      if (bar) bar.hidden = false;
      if (tip) tip.textContent = '点画面里卷尺的左端（或任意已知长度的两端）';
      if (stage) stage.classList.add('is-ruler');
    } else {
      J.ruler = null;
      J.hoverPt = null;
      if (bar) bar.hidden = true;
      if (stage) stage.classList.remove('is-ruler');
    }
    drawOverlay(J.video ? J.video.currentTime : 0);
  }

  function applyRuler(p0, p1) {
    var el = $('ljRulerLen');
    var len = el ? parseFloat(el.value) : 100;
    if (!isFinite(len) || len <= 0) len = 100;
    if (!J.res) return;
    J.res.meta.ruler = { p0: p0, p1: p1, lenCm: len };
    BB.LongJumpEngine.applyScale(J.res);
    J.sel = J.res.primary >= 0 ? J.res.primary : 0;
    renderMetrics();
    renderSummary();
    renderLog();
    renderMarks();
    drawChart();
    drawOverlay(J.video ? J.video.currentTime : 0);
    var badge = $('ljBadge');
    if (badge) badge.textContent = '已校准';
  }

  /* 改身高：比例尺优先用标尺，没标尺才按身高重算。都不重跑模型 */
  function reScale() {
    if (!J.res) return;
    J.res.meta.heightCm = height();
    BB.LongJumpEngine.applyScale(J.res);
    renderMetrics();
    renderSummary();
    renderLog();
    drawChart();
    drawOverlay(J.video ? J.video.currentTime : 0);
  }

  /* ---------------- 分析进度 ---------------- */

  function showAnalyse(ratio, title, text) {
    var panel = $('ljAnalysing');
    if (panel) panel.hidden = false;
    var tt = $('ljAnTitle');
    if (tt) tt.textContent = title || '正在分析';
    var r = Math.max(0, Math.min(1, ratio));
    if (r > J.anRatio) J.anRatio = r;
    var bar = $('ljAnBar');
    if (bar) {
      bar.classList.remove('is-error');
      bar.style.width = Math.round(J.anRatio * 100) + '%';
    }
    var pct = $('ljAnPct');
    if (pct) pct.textContent = Math.round(J.anRatio * 100) + '%';
    if (text) {
      var tx = $('ljAnText');
      if (tx) tx.textContent = text;
    }
  }

  function showAnalyseError(msg) {
    var panel = $('ljAnalysing');
    if (panel) panel.hidden = false;
    var tt = $('ljAnTitle');
    if (tt) tt.textContent = '没分析成功';
    var bar = $('ljAnBar');
    if (bar) { bar.style.width = '100%'; bar.classList.add('is-error'); }
    var pct = $('ljAnPct');
    if (pct) pct.textContent = '';
    var tx = $('ljAnText');
    if (tx) tx.innerHTML = esc(msg) + '<br><span class="an-hint">换一段正侧面、全身入镜、起跳线和落地区都在画面里的视频再试一次</span>';
    var badge = $('ljBadge');
    if (badge) { badge.textContent = '分析失败'; badge.classList.remove('real'); }
  }

  /* ---------------- 结果应用 ---------------- */

  function renderAll() {
    renderMetrics();
    renderSummary();
    renderLog();
    renderMarks();
    drawChart();
    updateFromVideo();
  }

  function applyResult(res) {
    J.res = res;
    J.duration = res.meta.duration || J.video.duration || 0;
    J.analyzing = false;
    J.sel = res.primary >= 0 ? res.primary : 0;
    J.near = null;
    J.chartT = -1;

    var panel = $('ljAnalysing');
    if (panel) panel.hidden = true;
    var badge = $('ljBadge');
    if (badge) { badge.textContent = '已分析'; badge.classList.add('real'); }
    var change = $('ljChangeBtn');
    if (change) change.hidden = false;
    var rulerBtn = $('ljRulerBtn');
    if (rulerBtn) rulerBtn.hidden = false;

    var stage = $('ljStage');
    if (stage) stage.classList.add('has-video');
    var drop = $('ljDrop');
    if (drop) drop.hidden = true;

    ['ljTrack', 'ljControls', 'ljShortcut', 'ljLive'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = false;
    });
    var chip = $('ljStageChip');
    if (chip) {
      chip.hidden = false;
      var best = res.stats.bestDist;
      chip.textContent = res.stats.count + ' 跳 · 最远 ' + fmtDistText(best);
    }
    var fb = $('ljFrameBadge');
    if (fb) fb.hidden = false;

    renderAll();

    try { J.video.currentTime = Math.max(0, res.jumps[res.primary] ? res.jumps[res.primary].t0 - 0.6 : 0); } catch (e) { /* 忽略 */ }
    updateFromVideo();
    if (J.visible) {
      requestAnimationFrame(function () {
        drawChart();
        drawOverlay(J.video.currentTime || 0);
      });
    }
  }

  function resetForNew() {
    J.res = null;
    J.duration = 0;
    J.sel = 0;
    J.near = null;
    J.chartT = -1;
    J.anRatio = 0;
    pause();
    setRulerMode(false);

    var stage = $('ljStage');
    if (stage) stage.classList.add('has-video');
    var drop = $('ljDrop');
    if (drop) drop.hidden = true;
    ['ljTrack', 'ljControls', 'ljShortcut', 'ljLive'].forEach(function (id) {
      var el = $(id);
      if (el) el.hidden = true;
    });
    var log = $('ljLogCard');
    if (log) log.hidden = true;
    var fb = $('ljFrameBadge');
    if (fb) fb.hidden = true;
    var chip = $('ljStageChip');
    if (chip) chip.hidden = true;
    var marks = $('ljTrackMarks');
    if (marks) marks.innerHTML = '';
    var badge = $('ljBadge');
    if (badge) { badge.textContent = '分析中'; badge.classList.remove('real'); }
    var change = $('ljChangeBtn');
    if (change) change.hidden = false;
    var rulerBtn = $('ljRulerBtn');
    if (rulerBtn) rulerBtn.hidden = true;

    renderMetrics();
    renderSummary();
    drawChart();
    drawOverlay(0);
  }

  function startAnalyze(file) {
    if (!file) return;
    if (!/^video\//.test(file.type || '')) return;
    J.lastFile = file;
    var myId = (J.analysisId || 0) + 1;
    J.analysisId = myId;
    if (J.analysisAbort) J.analysisAbort.abort();
    var abort = new AbortController();
    J.analysisAbort = abort;

    if (J.url) { URL.revokeObjectURL(J.url); J.url = null; }
    J.url = URL.createObjectURL(file);

    resetForNew();
    showAnalyse(0.01, '正在读取视频…', '正在加载姿态模型…');

    var v = J.video;
    v.src = J.url;
    try { v.load(); } catch (e) { /* 忽略 */ }

    var started = false;
    var start = function () {
      if (started || myId !== J.analysisId) return;
      started = true;
      if (!v.videoWidth) {
        showAnalyseError('浏览器读不出这个视频的画面，可能是编码不支持（建议 MP4/H.264 或 WebM）。');
        return;
      }
      var E = BB.LongJumpEngine;
      if (!E || !E.analyze) {
        showAnalyseError(location.protocol === 'file:'
          ? '分析引擎没加载起来：你是双击打开的 html，浏览器不允许这种打开方式加载模块。用线上版或本地服务器打开就行。'
          : '分析引擎没有加载起来（js/longjump-engine.js 没取到），刷新一次页面再试。');
        return;
      }
      J.analyzing = true;
      J.anRatio = 0;
      E.analyze(v, {
        heightCm: height(),
        subject: (file.name || '立定跳远').replace(/\.[^.]+$/, ''),
        source: '本地上传',
        signal: abort.signal,
        onProgress: function (text, ratio) {
          if (myId !== J.analysisId) return;
          showAnalyse(ratio, '正在分析', text);
        }
      }).then(function (res) {
        if (myId !== J.analysisId) return;
        res.meta.video = J.url;
        applyResult(res);
      }).catch(function (err) {
        if (myId !== J.analysisId) return;
        J.analyzing = false;
        showAnalyseError(String(err && err.message ? err.message : err));
      });
    };

    if (v.readyState >= 1 && v.videoWidth) start();
    else v.addEventListener('loadedmetadata', start, { once: true });
    setTimeout(function () { if (v.readyState >= 1 && v.videoWidth) start(); }, 1500);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    var v = J.video;

    v.addEventListener('loadedmetadata', function () {
      if (v.duration && isFinite(v.duration)) J.duration = v.duration;
    });
    v.addEventListener('timeupdate', function () { if (!J.playing) updateFromVideo(); });
    v.addEventListener('seeked', updateFromVideo);
    v.addEventListener('play', function () {
      J.playing = true;
      var b = $('ljBtnPlay');
      if (b) { b.innerHTML = '❙❙'; b.classList.add('is-playing'); }
      if (!J.raf) J.raf = requestAnimationFrame(loop);
    });
    v.addEventListener('pause', function () {
      J.playing = false;
      if (J.raf) { cancelAnimationFrame(J.raf); J.raf = 0; }
      var b = $('ljBtnPlay');
      if (b) { b.innerHTML = '▶'; b.classList.remove('is-playing'); }
      updateFromVideo();
    });
    v.addEventListener('ended', function () {
      J.playing = false;
      var b = $('ljBtnPlay');
      if (b) { b.innerHTML = '▶'; b.classList.remove('is-playing'); }
      updateFromVideo();
    });

    var file = $('ljFile');
    if (file) file.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      startAnalyze(f);
    });
    var changeBtn = $('ljChangeBtn');
    if (changeBtn) changeBtn.addEventListener('click', function () { file.click(); });

    var stage = $('ljStage');
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

      /* 标尺校准：两次点击定一条已知长度 */
      stage.addEventListener('click', function (e) {
        if (!J.ruler) return;
        var p = normPoint(e);
        if (!p) return;
        var tip = $('ljRulerTip');
        if (!J.ruler.p0) {
          J.ruler.p0 = p;
          J.hoverPt = p;
          if (tip) tip.textContent = '再点另一端';
          drawOverlay(J.video ? J.video.currentTime : 0);
          return;
        }
        J.ruler.p1 = p;
        applyRuler(J.ruler.p0, p);
        setRulerMode(false);
      });

      stage.addEventListener('mousemove', function (e) {
        if (!J.ruler || !J.ruler.p0) return;
        var p = normPoint(e);
        if (!p) return;
        J.hoverPt = p;
        drawOverlay(J.video ? J.video.currentTime : 0);
      });
    }

    var rulerBtn = $('ljRulerBtn');
    if (rulerBtn) rulerBtn.addEventListener('click', function () {
      if (!J.res) return;
      pause();
      setRulerMode(true);
    });
    var rulerCancel = $('ljRulerCancel');
    if (rulerCancel) rulerCancel.addEventListener('click', function () { setRulerMode(false); });
    var rulerLen = $('ljRulerLen');
    if (rulerLen) rulerLen.addEventListener('change', function () {
      /* 改长度就地重算，不用重新点两个点 */
      var r = J.res && J.res.meta.ruler;
      if (!r || !r.p0 || !r.p1) return;
      applyRuler(r.p0, r.p1);
    });

    var playBtn = $('ljBtnPlay');
    if (playBtn) playBtn.addEventListener('click', toggle);
    var prev = $('ljBtnPrev');
    if (prev) prev.addEventListener('click', function () { step(-1); });
    var next = $('ljBtnNext');
    if (next) next.addEventListener('click', function () { step(1); });

    var speeds = $('ljSpeeds');
    if (speeds) {
      speeds.innerHTML = [0.25, 0.5, 1, 1.5].map(function (s) {
        return '<button class="speed' + (s === 1 ? ' active' : '') + '" data-speed="' + s + '">' + s + '×</button>';
      }).join('');
      speeds.querySelectorAll('.speed').forEach(function (b) {
        b.addEventListener('click', function () {
          speeds.querySelectorAll('.speed').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          J.speed = +b.dataset.speed;
          v.playbackRate = J.speed;
        });
      });
    }

    var track = $('ljTrack');
    if (track) track.addEventListener('click', function (e) {
      var rect = this.getBoundingClientRect();
      if (!rect.width) return;
      seekRatio((e.clientX - rect.left) / rect.width);
    });

    var h = $('ljHeight');
    if (h) h.addEventListener('change', reScale);

    window.addEventListener('resize', function () {
      if (!J.visible) return;
      drawChart();
      drawOverlay(J.video ? J.video.currentTime : 0);
    });

    if (window.ResizeObserver) {
      J.resizeObs = new ResizeObserver(function () {
        if (!J.visible) return;
        drawOverlay(J.video ? J.video.currentTime : 0);
      });
      if (stage) J.resizeObs.observe(stage);

      var wrap = J.chart && J.chart.parentNode;
      J.chartObs = new ResizeObserver(function () {
        if (!J.visible) return;
        drawChart();
      });
      if (wrap) J.chartObs.observe(wrap);
    }
  }

  function initEngineHint() {
    var hint = $('ljHint');
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

      if (J.analyzing && s.phase !== 'ready' && s.phase !== 'error') {
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
    if (J.inited) return;
    J.video = $('ljVideo');
    if (!J.video) return;
    J.overlay = $('ljOverlay');
    J.chart = $('ljChart');
    J.octx = J.overlay ? J.overlay.getContext('2d') : null;
    J.cctx = J.chart ? J.chart.getContext('2d') : null;

    bindEvents();
    initEngineHint();
    renderMetrics();
    renderSummary();
    drawChart();
    J.inited = true;
  }

  function onShow() {
    J.visible = true;
    requestAnimationFrame(function () {
      drawChart();
      drawOverlay(J.video ? J.video.currentTime : 0);
      updateFromVideo();
    });
  }

  function onHide() {
    J.visible = false;
    pause();
    if (J.ruler) setRulerMode(false);
  }

  BB.LongJump = {
    init: init,
    onShow: onShow,
    onHide: onHide,
    toggle: toggle,
    step: step,
    pause: pause,
    seekTime: seekTime,
    /* 排版自检入口：把一份离线分析结果直接喂给界面。
       没有视频文件时也能检查指标卡 / 曲线 / 叠加层的排版。 */
    preview: function (res) { J.duration = res.meta.duration || 0; applyResult(res); }
  };
})(window.BB);
