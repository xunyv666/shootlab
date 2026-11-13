/* ============================================================
 * pushup.js — 俯卧撑界面层
 * 只负责视频、时间轴、指标卡、记录表和画布；算法在 pushup-engine.js。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var P = {
    inited: false, visible: false, video: null, overlay: null, octx: null,
    chart: null, cctx: null, url: null, res: null, duration: 0, playing: false,
    raf: 0, speed: 1, analysisId: 0, analysisAbort: null, chartT: -1, anRatio: 0,
    activeRep: null, resizeObs: null, lastFile: null
  };
  var BONES = [[11, 13], [13, 15], [11, 23], [23, 27], [12, 14], [14, 16], [12, 24], [24, 28], [23, 24], [11, 12]];

  function esc(s) { return String(s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function round(v, d) { var p = Math.pow(10, d || 0); return Math.round(v * p) / p; }
  function fmtTime(t) { if (t == null || !isFinite(t)) return '—'; var m = Math.floor(t / 60), s = t % 60; return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s.toFixed(2) : s.toFixed(2)); }
  function fmtNum(v, d, unit) { return v == null || !isFinite(v) ? '<span class="na">—</span>' : round(v, d) + (unit || ''); }
  function fitCanvas(canvas, ctx) {
    if (!canvas || !ctx) return null;
    var r = canvas.getBoundingClientRect(); if (!r.width || !r.height) return null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.round(r.width), h = Math.round(r.height);
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { w: w, h: h };
  }
  function videoBox(w, h) {
    var a = (P.res && P.res.meta.videoAspect) || (P.video && P.video.videoWidth ? P.video.videoWidth / P.video.videoHeight : 0);
    if (!a) return { x: 0, y: 0, w: w, h: h };
    var sa = w / h, bw = sa < a ? w : h * a, bh = sa < a ? w / a : h;
    return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
  }
  function metricCard(o) {
    var val = o.value == null ? '<span class="na">—</span>' : o.value + (o.unit ? '<small>' + esc(o.unit) + '</small>' : '');
    return '<div class="metric' + (o.value == null ? ' is-empty' : '') + '"><div class="m-top"><span class="m-name">' + esc(o.name) + '</span>' + (o.tag ? '<span class="m-delta">' + esc(o.tag) + '</span>' : '') + '</div><div class="m-val">' + val + '</div><div class="m-sub">' + (o.sub || '') + '</div>' + (o.bar == null ? '' : '<div class="m-bar"><i style="width:' + Math.max(0, Math.min(100, o.bar)) + '%"></i></div>') + '</div>';
  }
  function renderMetrics(res) {
    var el = $('pushupMetrics'); if (!el) return;
    if (!res) { el.innerHTML = metricCard({ name: '总次数', sub: '分析后显示完整动作次数' }) + metricCard({ name: '标准次数', sub: '下放深度和躯干同时达标' }) + metricCard({ name: '每分钟次数', sub: '按动作结束时间间隔计算' }) + metricCard({ name: '标准度', sub: '深度与身体直线度加权' }); return; }
    var s = res.stats;
    el.innerHTML = metricCard({ name: '总次数', value: s.count, unit: '次', tag: '本段', sub: '有效动作 · ' + fmtNum(s.activeSeconds, 1, 's') }) +
      metricCard({ name: '标准次数', value: s.standardCount, unit: '次', tag: '达标', sub: s.count ? Math.round(s.standardCount / s.count * 100) + '% 动作达标' : '暂无完整动作' }) +
      metricCard({ name: '每分钟次数', value: s.cadence, unit: '次/分', tag: '节奏', sub: '按完整动作间隔计算' }) +
      metricCard({ name: '标准度', value: s.formScore, unit: '分', tag: s.formScore >= 85 ? '很好' : s.formScore >= 65 ? '一般' : '需调整', sub: '深度 ' + fmtNum(s.avgDepth, 0, ' · 直线 ' + (s.avgLine == null ? '—' : s.avgLine) + ' 分'), bar: s.formScore });
  }
  function renderSummary(res) {
    var el = $('pushupSummary'); if (!el) return;
    if (!res) { el.innerHTML = '<div class="card-head"><h2>本段小结</h2><span class="sub">还没有数据</span></div><div class="pushup-sum-body"><p class="pushup-verdict">上传一段侧面俯卧撑视频，这里会给出次数、深度和躯干稳定性。</p><ul class="pushup-warn"><li>手腕、肘、肩、髋、踝全程入镜。</li><li>下放到肘角约 90° 再推起，完整周期才计数。</li><li>手机固定，避免镜头移动被误判成塌腰。</li></ul></div>'; return; }
    var s = res.stats, verdict = s.count === 0 ? '还没有找到完整屈肘周期，先确认拍摄角度和身体关键点都在画面里。' : s.formScore >= 85 ? '动作整体稳定，保持下放深度，继续控制节奏。' : s.formScore >= 65 ? '次数已经识别出来了，优先把下放深度和躯干直线做稳。' : '动作波动较大，建议放慢速度，先保证身体成一条线再增加次数。';
    var warns = (res.meta.warnings || []).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('');
    el.innerHTML = '<div class="card-head"><h2>本段小结</h2><span class="sub">' + s.count + ' 次完整动作</span></div><div class="sum-grid pushup-sum-grid"><div class="sum-cell"><b>' + s.count + '</b><span>总次数</span><i>完整周期</i></div><div class="sum-cell"><b>' + s.standardCount + '</b><span>标准次数</span><i>深度 + 直线</i></div><div class="sum-cell"><b>' + fmtNum(s.avgDepth, 0) + '</b><span>深度分</span><i>越高越充分</i></div><div class="sum-cell"><b>' + fmtNum(s.formScore, 0) + '</b><span>标准度</span><i>综合评分</i></div></div><div class="pushup-sum-body"><p class="pushup-verdict">' + esc(verdict) + '</p>' + (warns ? '<ul class="pushup-warn">' + warns + '</ul>' : '') + '</div>';
  }
  function renderLog(res) {
    var card = $('pushupLogCard'), rows = $('pushupLogRows'); if (!card || !rows) return;
    if (!res) { card.hidden = true; return; }
    card.hidden = false; $('pushupLogSub').textContent = res.reps.length + ' 次';
    rows.innerHTML = res.reps.map(function (r, i) { return '<tr data-i="' + i + '" class="' + (r.standard ? 'rep-good' : 'rep-warn') + '"><td class="c-idx">' + (i + 1) + '</td><td>' + fmtTime(r.t) + '</td><td>' + fmtNum(r.depthAngle, 0, '°') + '</td><td>' + fmtNum(r.bodyAngle, 0, '°') + '</td><td class="c-score"><b>' + r.score + '</b></td></tr>'; }).join('');
    rows.querySelectorAll('tr').forEach(function (tr) { tr.addEventListener('click', function () { var r = res.reps[+tr.dataset.i]; if (r) seekTime(r.bottom); }); });
  }
  function nearestFrame(t) {
    if (!P.res || !P.res.frames || !P.res.frames.length) return null;
    var best = P.res.frames[0]; for (var i = 1; i < P.res.frames.length; i++) if (Math.abs(P.res.frames[i].t - t) < Math.abs(best.t - t)) best = P.res.frames[i]; return best;
  }
  function drawOverlay(t) {
    var s = fitCanvas(P.overlay, P.octx); if (!s) return;
    var ctx = P.octx; ctx.clearRect(0, 0, s.w, s.h); var f = nearestFrame(t); if (!f || !f.pts) return;
    var b = videoBox(s.w, s.h); function pt(k) { return { x: b.x + f.pts[k * 3] * b.w, y: b.y + f.pts[k * 3 + 1] * b.h }; }
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#f97316';
    BONES.forEach(function (bone) { var a = pt(bone[0]), c = pt(bone[1]); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke(); });
    [11, 13, 15, 23, 27, 12, 14, 16, 24, 28].forEach(function (k) { var p = pt(k); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#f97316'; ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2); ctx.fill(); });
    if (f.arm != null) { ctx.fillStyle = 'rgba(17,24,39,.82)'; ctx.font = '12px system-ui'; ctx.fillText('肘角 ' + Math.round(f.arm) + '° · 躯干 ' + Math.round(f.body || 0) + '°', b.x + 12, b.y + 22); }
  }
  function drawChart(t) {
    var s = fitCanvas(P.chart, P.cctx); if (!s) return; var ctx = P.cctx; ctx.clearRect(0, 0, s.w, s.h);
    var fs = P.res && P.res.frames ? P.res.frames.filter(function (f) { return f.arm != null; }) : [];
    ctx.strokeStyle = '#edf0f5'; ctx.lineWidth = 1; for (var y = 24; y < s.h - 20; y += (s.h - 44) / 4) { ctx.beginPath(); ctx.moveTo(34, y); ctx.lineTo(s.w - 12, y); ctx.stroke(); }
    if (!fs.length) { ctx.fillStyle = '#97a0ad'; ctx.font = '13px system-ui'; ctx.fillText('分析后显示肘角与躯干曲线', 22, s.h / 2); return; }
    var dur = P.duration || fs[fs.length - 1].t || 1, x = function (v) { return 34 + v / dur * (s.w - 46); }, yArm = function (v) { return 20 + (180 - Math.max(40, Math.min(180, v))) / 140 * (s.h - 48); }, yBody = function (v) { return 20 + (190 - Math.max(80, Math.min(190, v))) / 110 * (s.h - 48); };
    function line(key, color, yfn) { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); var started = false; fs.forEach(function (f) { var v = f[key]; if (v == null) { started = false; return; } if (!started) { ctx.moveTo(x(f.t), yfn(v)); started = true; } else ctx.lineTo(x(f.t), yfn(v)); }); ctx.stroke(); }
    line('arm', '#f97316', yArm); line('body', '#2563eb', yBody);
    (P.res.reps || []).forEach(function (r) { ctx.strokeStyle = 'rgba(22,163,74,.25)'; ctx.beginPath(); ctx.moveTo(x(r.t), 12); ctx.lineTo(x(r.t), s.h - 20); ctx.stroke(); });
    if (t != null) { ctx.strokeStyle = '#111827'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x(t), 10); ctx.lineTo(x(t), s.h - 18); ctx.stroke(); }
    ctx.fillStyle = '#f97316'; ctx.fillRect(38, s.h - 12, 16, 3); ctx.fillStyle = '#4b78d0'; ctx.fillRect(116, s.h - 12, 16, 3); ctx.fillStyle = '#697386'; ctx.font = '11px system-ui'; ctx.fillText('肘角', 58, s.h - 9); ctx.fillText('躯干角', 136, s.h - 9);
  }
  function updateFromVideo() {
    if (!P.video) return; var t = P.video.currentTime || 0, dur = P.duration || P.video.duration || 0, ratio = dur ? t / dur : 0;
    var fill = $('pushupTrackFill'), head = $('pushupTrackHead'); if (fill) fill.style.width = ratio * 100 + '%'; if (head) head.style.left = ratio * 100 + '%';
    var tl = $('pushupTime'); if (tl) tl.textContent = t.toFixed(2) + 's'; var fb = $('pushupFrameBadge'); if (fb) fb.textContent = fmtTime(t) + ' / 第 ' + Math.round(t * ((P.res && P.res.meta.fps) || 24)) + ' 帧';
    var near = null, passed = 0; if (P.res) P.res.reps.forEach(function (r, i) { if (Math.abs(r.t - t) <= 0.28) near = i; if (r.t <= t + 0.001) passed++; });
    var liveRep = $('pushupLiveRep'), liveVals = $('pushupLiveVals'); if (liveRep) { liveRep.textContent = near == null ? '已完成 ' + passed + ' 次' : '第 ' + (near + 1) + ' 次'; liveRep.classList.toggle('hit', near != null); } if (liveVals) { var f = nearestFrame(t); liveVals.innerHTML = f && f.arm != null ? '肘角 <b>' + Math.round(f.arm) + '°</b> · 躯干 <b>' + Math.round(f.body) + '°</b>' : '当前帧 <b>—</b>'; }
    drawOverlay(t); if (Math.abs(t - P.chartT) > 0.08) { P.chartT = t; drawChart(t); }
  }
  function loop() { if (!P.playing) return; updateFromVideo(); P.raf = requestAnimationFrame(loop); }
  function play() { if (P.video) P.video.play().catch(function () {}); }
  function pause() { P.playing = false; if (P.raf) { cancelAnimationFrame(P.raf); P.raf = 0; } if (P.video && !P.video.paused) P.video.pause(); }
  function toggle() { if (!P.video) return; P.video.paused ? play() : pause(); }
  function seekTime(t) { if (!P.video) return; var dur = P.duration || P.video.duration || 0; P.video.currentTime = Math.max(0, Math.min(dur, t)); updateFromVideo(); }
  function step(dir) { if (!P.video) return; pause(); seekTime((P.video.currentTime || 0) + dir / ((P.res && P.res.meta.fps) || 24)); }
  function showAnalyse(ratio, title, text) { var box = $('pushupAnalysing'); if (box) box.hidden = false; var p = Math.max(0, Math.min(1, ratio)); P.anRatio = Math.max(P.anRatio, p); var bar = $('pushupAnBar'); if (bar) { bar.style.width = Math.round(P.anRatio * 100) + '%'; bar.classList.remove('is-error'); } var pct = $('pushupAnPct'); if (pct) pct.textContent = Math.round(P.anRatio * 100) + '%'; var tt = $('pushupAnTitle'); if (tt) tt.textContent = title || '正在分析'; var tx = $('pushupAnText'); if (tx && text) tx.textContent = text; }
  function showError(msg) { showAnalyse(1, '没分析成功', msg); var bar = $('pushupAnBar'); if (bar) bar.classList.add('is-error'); var pct = $('pushupAnPct'); if (pct) pct.textContent = ''; var badge = $('pushupBadge'); if (badge) { badge.textContent = '分析失败'; badge.classList.remove('real'); } }
  function applyResult(res) {
    P.res = res; P.duration = res.meta.duration || P.video.duration || 0; $('pushupAnalysing').hidden = true; var badge = $('pushupBadge'); badge.textContent = '已分析'; badge.classList.add('real'); $('pushupChangeBtn').hidden = false; $('pushupStage').classList.add('has-video'); $('pushupDrop').hidden = true;
    ['pushupTrack', 'pushupControls', 'pushupShortcut', 'pushupLive', 'pushupFrameBadge'].forEach(function (id) { var el = $(id); if (el) el.hidden = false; }); var chip = $('pushupStageChip'); chip.hidden = false; chip.textContent = res.stats.count + ' 次 · 标准度 ' + (res.stats.formScore == null ? '—' : res.stats.formScore); renderMetrics(res); renderSummary(res); renderLog(res); renderMarks(); drawChart(0); updateFromVideo();
    if (P.visible) requestAnimationFrame(function () { drawChart(0); drawOverlay(0); });
  }
  function resetForNew() { P.res = null; P.duration = 0; P.chartT = -1; P.anRatio = 0; P.activeRep = null; pause(); $('pushupDrop').hidden = true; ['pushupTrack', 'pushupControls', 'pushupShortcut', 'pushupLive', 'pushupFrameBadge', 'pushupLogCard', 'pushupStageChip'].forEach(function (id) { var el = $(id); if (el) el.hidden = true; }); $('pushupStage').classList.add('has-video'); renderMetrics(null); renderSummary(null); drawChart(null); drawOverlay(0); }
  function startAnalyze(file) {
    if (!file || !/^video\//.test(file.type || '')) return; P.lastFile = file; var id = ++P.analysisId; if (P.analysisAbort) P.analysisAbort.abort(); var abort = new AbortController(); P.analysisAbort = abort; if (P.url) URL.revokeObjectURL(P.url); P.url = URL.createObjectURL(file); resetForNew(); showAnalyse(0.01, '正在读取视频…', '正在加载姿态模型…'); var v = P.video; v.src = P.url; v.load(); var started = false; var start = function () { if (started || id !== P.analysisId) return; started = true; if (!v.videoWidth) { showError('浏览器读不出这个视频的画面，建议使用 MP4/H.264 或 WebM。'); return; } var E = BB.PushUpEngine; if (!E || !E.analyze) { showError('分析引擎没有加载起来，刷新页面再试。'); return; } E.analyze(v, { source: '本地上传', subject: (file.name || '俯卧撑视频').replace(/\.[^.]+$/, ''), signal: abort.signal, onProgress: function (text, ratio) { if (id === P.analysisId) showAnalyse(ratio, '正在分析', text); } }).then(function (res) { if (id === P.analysisId) applyResult(res); }).catch(function (err) { if (id === P.analysisId) showError(String(err && err.message ? err.message : err)); }); }; if (v.readyState >= 1 && v.videoWidth) start(); else v.addEventListener('loadedmetadata', start, { once: true }); setTimeout(function () { if (v.readyState >= 1 && v.videoWidth) start(); }, 1500); }
  function renderMarks() { var marks = $('pushupTrackMarks'); if (!marks) return; marks.innerHTML = P.res ? P.res.reps.map(function (r) { return '<i style="left:' + (P.duration ? r.t / P.duration * 100 : 0) + '%"></i>'; }).join('') : ''; }
  function bindEvents() {
    var v = P.video, stage = $('pushupStage');
    $('pushupFile').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; e.target.value = ''; startAnalyze(f); }); $('pushupChangeBtn').addEventListener('click', function () { $('pushupFile').click(); });
    ['dragenter', 'dragover'].forEach(function (ev) { stage.addEventListener(ev, function (e) { e.preventDefault(); stage.classList.add('dragging'); }); }); ['dragleave', 'drop'].forEach(function (ev) { stage.addEventListener(ev, function (e) { e.preventDefault(); stage.classList.remove('dragging'); }); }); stage.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) startAnalyze(f); });
    v.addEventListener('loadedmetadata', function () { if (isFinite(v.duration)) P.duration = v.duration; }); v.addEventListener('timeupdate', function () { if (!P.playing) updateFromVideo(); }); v.addEventListener('seeked', updateFromVideo); v.addEventListener('play', function () { P.playing = true; $('pushupBtnPlay').textContent = '❙❙'; P.raf = P.raf || requestAnimationFrame(loop); }); v.addEventListener('pause', function () { P.playing = false; $('pushupBtnPlay').textContent = '▶'; if (P.raf) { cancelAnimationFrame(P.raf); P.raf = 0; } updateFromVideo(); }); v.addEventListener('ended', function () { P.playing = false; $('pushupBtnPlay').textContent = '▶'; updateFromVideo(); });
    $('pushupBtnPlay').addEventListener('click', toggle); $('pushupBtnPrev').addEventListener('click', function () { step(-1); }); $('pushupBtnNext').addEventListener('click', function () { step(1); }); var speeds = $('pushupSpeeds'); speeds.innerHTML = [0.25, 0.5, 1, 1.5].map(function (s) { return '<button class="speed' + (s === 1 ? ' active' : '') + '" data-speed="' + s + '">' + s + '×</button>'; }).join(''); speeds.querySelectorAll('.speed').forEach(function (b) { b.addEventListener('click', function () { speeds.querySelectorAll('.speed').forEach(function (x) { x.classList.remove('active'); }); b.classList.add('active'); P.speed = +b.dataset.speed; v.playbackRate = P.speed; }); });
    $('pushupTrack').addEventListener('click', function (e) { var r = this.getBoundingClientRect(); seekTime((e.clientX - r.left) / r.width * (P.duration || 0)); });
  }
  function init() { if (P.inited) return; P.video = $('pushupVideo'); if (!P.video) return; P.overlay = $('pushupOverlay'); P.chart = $('pushupChart'); P.octx = P.overlay.getContext('2d'); P.cctx = P.chart.getContext('2d'); bindEvents(); renderMetrics(null); renderSummary(null); drawChart(null); P.inited = true; }
  function onShow() { P.visible = true; requestAnimationFrame(function () { drawChart(P.video ? P.video.currentTime : 0); drawOverlay(P.video ? P.video.currentTime : 0); updateFromVideo(); }); }
  function onHide() { P.visible = false; pause(); }
  BB.PushUp = { init: init, onShow: onShow, onHide: onHide, toggle: toggle, step: step, pause: pause, seekTime: seekTime };
})(window.BB);
