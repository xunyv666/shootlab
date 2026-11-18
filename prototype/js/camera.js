/* ============================================================
 * camera.js — 摄像头实时模式（预览 + 逐帧姿态推理 + 录制）
 *
 * 设计取舍：
 *   1) 不另起一套分析算法。实时只负责「取景 + 骨架 + 计数」，
 *      停止时把录到的片段做成一个 File 交给各模块现有的 startAnalyze，
 *      所以最终报告和上传视频完全一致，不会出现两套口径。
 *   2) 推理复用 pose-engine 的 PoseLandmarker（VIDEO 模式），
 *      逐帧 detectForVideo。时间戳从 acquireTimeBlock 统一领，
 *      因为 VIDEO 模式要求跨调用单调递增。
 *   3) 录制用 MediaRecorder。它产出的 webm 头里没有 Duration，
 *      video.duration 会是 Infinity，各引擎会判「时长无效」。
 *      所以提供 warmDuration()，让模块在分析前先把时长逼出来。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var BONES = [
    [11, 13], [13, 15], [11, 23], [23, 27], [15, 17], [15, 19], [15, 21],
    [12, 14], [14, 16], [12, 24], [24, 28], [16, 18], [16, 20], [16, 22],
    [23, 24], [11, 12], [27, 31], [28, 32], [25, 27], [26, 28]
  ];
  var JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

  /* 每个模块的视频元素 / 覆盖层 / 舞台，以及停止后把片段交给谁 */
  var MODULES = {
    basketball: { video: 'video', overlay: 'overlay', stage: 'stage', load: function (f) { BB.Basketball.loadFile(f); } },
    rope: { video: 'ropeVideo', overlay: 'ropeOverlay', stage: 'ropeStage', load: function (f) { BB.Rope.loadFile(f); } },
    pushup: { video: 'pushupVideo', overlay: 'pushupOverlay', stage: 'pushupStage', load: function (f) { BB.PushUp.loadFile(f); } },
    longjump: { video: 'ljVideo', overlay: 'ljOverlay', stage: 'ljStage', load: function (f) { BB.LongJump.loadFile(f); } }
  };

  var S = {
    active: false, busy: false, key: null, stream: null, video: null, ctx: null, stage: null,
    detector: null, tsBase: 0, frameNo: 0, timer: 0, loopTimer: 0,
    startedAt: 0, lastDetect: 0, targetFps: 18,
    rec: null, chunks: [], mime: '', recStartedAt: 0, blob: null,
    live: null, hud: null, facing: 'user', mirror: true, lastStatus: '', lastStats: null
  };

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && BB.PoseEngine && BB.PoseEngine.loadDetector);
  }

  function setStatus(text) {
    if (!S.hud || text === S.lastStatus) return;
    S.lastStatus = text;
    var el = S.hud.querySelector('.camhud-hint');
    if (el) el.textContent = text;
  }

  /* ---------------- 骨架绘制 ---------------- */

  function fitCanvas(canvas, ctx) {
    if (!canvas || !ctx) return null;
    var r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(r.width), h = Math.round(r.height);
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: w, h: h };
  }

  /* 视频是 object-fit: contain，四周会有黑边，归一化坐标要落到真实画面框里 */
  function videoBox(w, h) {
    var vw = S.video.videoWidth || 0, vh = S.video.videoHeight || 0;
    if (!vw || !vh) return { x: 0, y: 0, w: w, h: h };
    var a = vw / vh, sa = w / h;
    var bw = sa < a ? w : h * a, bh = sa < a ? w / a : h;
    return { x: (w - bw) / 2, y: (h - bh) / 2, w: bw, h: bh };
  }

  function drawSkeleton(pts) {
    var s = fitCanvas($(MODULES[S.key].overlay), S.ctx);
    if (!s) return;
    var ctx = S.ctx;
    ctx.clearRect(0, 0, s.w, s.h);
    if (!pts) return;
    var b = videoBox(s.w, s.h);
    var fx = S.mirror ? function (x) { return 1 - x; } : function (x) { return x; };
    function pt(k) {
      return { x: b.x + fx(pts[k * 3]) * b.w, y: b.y + pts[k * 3 + 1] * b.h, v: pts[k * 3 + 2] };
    }
    ctx.lineCap = 'round';
    BONES.forEach(function (bone) {
      var a = pt(bone[0]), c = pt(bone[1]);
      if (a.v < 0.3 || c.v < 0.3) return;
      ctx.strokeStyle = 'rgba(249,115,22,.92)';
      ctx.lineWidth = 3.2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
    });
    JOINTS.forEach(function (k) {
      var p = pt(k);
      if (p.v < 0.3) return;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f97316';
      ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
    });
  }

  /* ---------------- HUD ---------------- */

  function buildHud() {
    var stage = S.stage;
    var hud = document.createElement('div');
    hud.className = 'camhud';
    hud.innerHTML =
      '<div class="camhud-top">' +
        '<span class="camhud-rec"><i></i><b class="camhud-time">00:00</b></span>' +
        '<button class="camhud-stop" type="button">结束并分析</button>' +
      '</div>' +
      '<div class="camhud-main">' +
        '<div class="camhud-num"><b>0</b><span class="camhud-unit">次</span></div>' +
        '<p class="camhud-hint">正在打开摄像头…</p>' +
      '</div>';
    stage.appendChild(hud);
    hud.querySelector('.camhud-stop').addEventListener('click', function () { stop(true); });
    return hud;
  }

  function updateHud(stats, seconds) {
    if (!S.hud) return;
    var num = S.hud.querySelector('.camhud-num b');
    var unit = S.hud.querySelector('.camhud-unit');
    var time = S.hud.querySelector('.camhud-time');
    if (num && stats) num.textContent = stats.value;
    if (unit && stats) unit.textContent = stats.unit || '';
    if (time) time.textContent = fmtClock(seconds);
    if (stats && stats.hint) setStatus(stats.hint);
  }

  function fmtClock(sec) {
    var s = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(s / 60);
    return (m < 10 ? '0' + m : m) + ':' + (s % 60 < 10 ? '0' + (s % 60) : s % 60);
  }

  /* ---------------- 推理循环 ---------------- */

  function nextTs() {
    /* 每次会话领一大块时间片，块内自己按 50ms 递增 */
    return S.tsBase + (S.frameNo++) * 50;
  }

  function poseToPoints(lm) {
    var out = new Array(33 * 3);
    for (var i = 0; i < 33; i++) {
      var p = lm[i] || {};
      out[i * 3] = Number.isFinite(p.x) ? p.x : 0;
      out[i * 3 + 1] = Number.isFinite(p.y) ? p.y : 0;
      out[i * 3 + 2] = Number.isFinite(p.visibility) ? p.visibility : 1;
    }
    return out;
  }

  /* 推理用定时器而不是 requestAnimationFrame：
     rAF 在窗口被遮挡/最小化/离屏时会被浏览器降到 1fps 甚至暂停，
     而摄像头会话本来就应该稳定产出帧；画面绘制也不依赖垂直同步。 */
  function tick() {
    if (!S.active) return;
    S.ticks = (S.ticks || 0) + 1;
    if (document.hidden && !S.force) { S.hiddenSkips = (S.hiddenSkips || 0) + 1; return; }
    var now = performance.now();
    if (now - S.lastDetect < 1000 / S.targetFps) return;
    S.lastDetect = now;

    var lm = null;
    try {
      var res = S.detector.detectForVideo(S.video, nextTs());
      lm = res && res.landmarks && res.landmarks[0];
    } catch (e) {
      /* 单帧失败不该中断整段练习，累计失败太多才提示 */
      S.errCount = (S.errCount || 0) + 1;
      S.lastErr = String(e && e.message ? e.message : e);
      S.failCount = (S.failCount || 0) + 1;
      if (S.failCount === 30) setStatus('识别不稳定，建议关掉其他占用显卡的程序');
      return;
    }
    S.failCount = 0;
    S.detects = (S.detects || 0) + 1;

    var pts = lm ? poseToPoints(lm) : null;
    var t = (now - S.startedAt) / 1000;
    drawSkeleton(pts);

    if (S.live) {
      S.live.push(pts, t);
      if (now - (S.lastHud || 0) > 120) {
        S.lastHud = now;
        S.lastStats = S.live.stats();
        updateHud(S.lastStats, t);
      }
    }
  }

  /* ---------------- 录制 ---------------- */

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    var list = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4'];
    for (var i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) { /* 忽略 */ }
    }
    return '';
  }

  function startRecorder(stream) {
    S.mime = pickMime();
    if (!S.mime) return null;
    try {
      var rec = new MediaRecorder(stream, { mimeType: S.mime, videoBitsPerSecond: 2500000 });
      S.chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) S.chunks.push(e.data); };
      rec.start(1000);
      return rec;
    } catch (e) {
      S.recErr = String(e && e.message ? e.message : e);
      return null;
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitFirstFrame(video) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (done) return; done = true; resolve(); };
      try {
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(finish);
      } catch (e) { /* 忽略 */ }
      setTimeout(finish, 1200);
    });
  }

  function tryStartRec() {
    if (!S.active || S.rec || !S.stream) return;
    S.rec = startRecorder(S.stream);
    S.hadRec = !!S.rec;
    if (!S.rec && (S.recTries = (S.recTries || 0) + 1) < 4) {
      S.recTimer = setTimeout(tryStartRec, 600);
    }
  }

  function stopRecorder() {
    return new Promise(function (resolve) {
      var rec = S.rec;
      S.rec = null;
      if (!rec || rec.state === 'inactive') return resolve(null);
      rec.onstop = function () {
        S.lastChunks = S.chunks.length;
        var blob = S.chunks.length ? new Blob(S.chunks, { type: S.mime || 'video/webm' }) : null;
        S.chunks = [];
        resolve(blob);
      };
      try { rec.stop(); } catch (e) { resolve(null); }
    });
  }

  /* ---------------- 对外：开始 / 停止 ---------------- */

  async function start(key) {
    if (S.active || S.busy) return;
    var cfg = MODULES[key];
    if (!cfg) throw new Error('未知模块：' + key);
    if (!supported()) throw new Error('这个浏览器不支持摄像头，或者识别引擎还没加载好');

    var video = $(cfg.video), overlay = $(cfg.overlay), stage = $(cfg.stage);
    if (!video || !overlay || !stage) throw new Error('页面结构不完整，刷新后再试');

    S.busy = true;
    S.recErr = ''; S.lastChunks = 0; S.hadRec = false;
    S.key = key; S.video = video; S.stage = stage;
    S.ctx = overlay.getContext('2d');
    S.mirror = true;

    /* HUD 先出来，用户能看到「正在打开摄像头」而不是一片空白 */
    if (stage.querySelector('.camhud')) stage.querySelector('.camhud').remove();
    S.hud = buildHud();
    stage.classList.add('is-cam');
    setStatus('正在请求摄像头权限…');

    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: S.facing,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 }
        }
      });
      S.stream = stream;
      setStatus('正在加载识别引擎…（首次约 19MB，之后本机缓存）');
      S.detector = await BB.PoseEngine.loadDetector();

      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      /* 必须先让 <video> 可见：.stage 默认 display:none，
         隐藏元素上 play() 的 Promise 可能永远不 resolve，摄像头就起不来。 */
      stage.classList.add('has-video');
      await Promise.race([
        video.play().catch(function () { /* 自动播放被拦时下面再试 */ }),
        new Promise(function (r) { setTimeout(r, 1500); })
      ]);
      if (video.paused) { try { await video.play(); } catch (e) { /* 忽略 */ } }

      S.tsBase = BB.PoseEngine.acquireTimeBlock(200000, 50);
      S.frameNo = 0;
      S.startedAt = performance.now();
      S.lastDetect = 0;
      S.failCount = 0;
      S.active = true;

      S.live = BB.Live ? BB.Live.create(key) : null;

      /* 等第一帧真正上屏再开录制：requestVideoFrameCallback 是「已经有帧了」的准确信号。
         摄像头刚出流时轨道还没产出帧，这时 MediaRecorder.start() 会抛
         「There was an error starting the MediaRecorder」。
         录制与推理解耦，推理失败不影响录像。 */
      await waitFirstFrame(video);
      /* 首帧回调可能在几十毫秒内就返回，那时轨道还没真正开始产数据，
         直接 start() 会抛「There was an error starting the MediaRecorder」。
         实测 800ms 之后启动稳定，失败再重试几次。 */
      for (var attempt = 0; attempt < 5 && S.active; attempt++) {
        await sleep(attempt === 0 ? 800 : 500);
        if (S.rec) break;
        S.rec = startRecorder(stream);
        S.recTries = attempt + 1;
        if (S.rec) { S.hadRec = true; break; }
      }

      setStatus('站到画面里，保持全身可见');
      S.timer = setInterval(tick, Math.max(30, Math.round(1000 / S.targetFps)));
      S.loopTimer = setInterval(function () {
        if (!S.active) return;
        updateHud(S.lastStats || (S.live ? S.live.stats() : null), (performance.now() - S.startedAt) / 1000);
      }, 500);
    } catch (err) {
      await stop(false);
      var msg = String(err && err.message ? err.message : err);
      if (/NotAllowed|Permission/i.test(msg)) msg = '摄像头权限被拒绝。浏览器地址栏左侧的图标里允许摄像头后重试。';
      else if (/NotFound|Devices/i.test(msg)) msg = '没有找到可用的摄像头。';
      else if (/NotReadable|TrackStart/i.test(msg)) msg = '摄像头被其他程序占用了（会议软件、相机 App），关掉再试。';
      throw new Error(msg);
    } finally {
      S.busy = false;
    }
  }

  /**
   * 停止摄像头。analyze=true 时把录到的片段交给模块现有的分析入口。
   * @returns {Promise<File|null>}
   */
  async function stop(analyze) {
    if (!S.active && !S.stream) return null;
    S.active = false;
    if (S.timer) { clearInterval(S.timer); S.timer = 0; }
    if (S.recTimer) { clearTimeout(S.recTimer); S.recTimer = 0; }
    if (S.loopTimer) { clearInterval(S.loopTimer); S.loopTimer = 0; }

    var elapsed = S.startedAt ? (performance.now() - S.startedAt) / 1000 : 0;
    var blob = await stopRecorder();

    if (S.stream) {
      S.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* 忽略 */ } });
      S.stream = null;
    }
    if (S.video) {
      try { S.video.pause(); } catch (e) { /* 忽略 */ }
      S.video.srcObject = null;
    }
    if (S.hud) { S.hud.remove(); S.hud = null; }
    if (S.stage) { S.stage.classList.remove('is-cam'); }
    if (S.ctx) { S.ctx.clearRect(0, 0, 9999, 9999); }
    S.lastStatus = '';

    var file = null;
    if (blob && blob.size > 0) {
      var ext = /mp4/.test(S.mime) ? 'mp4' : 'webm';
      file = new File([blob], '摄像头-' + stamp() + '.' + ext, { type: blob.type || 'video/webm' });
    }

    var key = S.key;
    S.live = null;
    S.key = null;
    S.lastStop = { active: S.active, stream: !!S.stream, elapsed: +elapsed.toFixed(1), blobSize: blob ? blob.size : 0, mime: S.mime, type: file ? file.type : '', key: key, analyze: !!analyze, hadRec: !!S.hadRec, recErr: S.recErr || '', chunks: S.lastChunks || 0 };

    if (analyze && !file) {
      showCamError('这次没录到画面（录制器启动失败），只能实时看数。刷新页面再试一次通常就好了。', key);
      return null;
    }

    /* 录像明显不正常（几十 KB 级别）说明几乎没有帧，交给引擎只会卡住等元数据。
       真摄像头 10 秒至少是几百 KB。 */
    if (analyze && file && file.size < 80000) {
      showCamError('这段录像只有 ' + Math.round(file.size / 1024) + 'KB，画面帧太少，没法分析。检查摄像头是否被别的程序占用后重试。', key);
      return null;
    }

    if (analyze && file && MODULES[key] && MODULES[key].load) {
      /* 太短的片段分析不出东西，直接提示而不是让引擎报「没有识别到人体」 */
      if (elapsed < 2.5) {
        throw new Error('录到的片段只有 ' + elapsed.toFixed(1) + ' 秒，太短了，至少练 3 秒再结束。');
      }
      try {
        MODULES[key].load(file);
      } catch (e) {
        S.lastStop.loadError = String(e && e.message ? e.message : e);
        throw e;
      }
      return file;
    }
    return file;
  }

  /* 摄像头失败时把空态放回来，并在按钮下面写清楚原因 */
  function showCamError(msg, key) {
    if (S.stage) S.stage.classList.remove('has-video');
    var host = document.querySelector('[data-cam="' + (key || S.key || '') + '"]');
    if (!host || !host.parentNode) return;
    var hint = host.parentNode.querySelector('.cam-err');
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'cam-err';
      host.parentNode.insertBefore(hint, host.nextSibling);
    }
    hint.textContent = msg;
  }

  function stamp() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /**
   * 让 <video> 算出真实时长。
   *
   * MediaRecorder 录出来的 webm 头部不写 Duration，video.duration 会是 Infinity，
   * 各引擎都会判「视频时长无效」。跳到极远位置再跳回来，Chromium 会重新扫一遍
   * 整个文件并填上正确的 duration。
   *
   * 对普通文件（duration 已经是有限值）是零开销的空操作。
   */
  function warmDuration(video) {
    return new Promise(function (resolve) {
      if (!video) return resolve();
      if (isFinite(video.duration) && video.duration > 0) return resolve();
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        try { video.removeEventListener('timeupdate', onTime); } catch (e) { /* 忽略 */ }
        try { video.currentTime = 0; } catch (e) { /* 忽略 */ }
        setTimeout(resolve, 60);
      };
      var onTime = function () { if (isFinite(video.duration)) finish(); };
      video.addEventListener('timeupdate', onTime);
      try { video.currentTime = 1e101; } catch (e) { finish(); }
      setTimeout(finish, 2500);
    });
  }

  function isActive() { return S.active; }

  /* 把空态里的「开摄像头练」按钮接上 */
  function attach() {
    document.querySelectorAll('[data-cam]').forEach(function (btn) {
      if (btn.dataset.camBound) return;
      btn.dataset.camBound = '1';
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-cam');
        btn.disabled = true;
        start(key).catch(function (err) {
          var hint = btn.parentNode && btn.parentNode.querySelector('.cam-err');
          if (!hint) {
            hint = document.createElement('p');
            hint.className = 'cam-err';
            btn.parentNode.insertBefore(hint, btn.nextSibling);
          }
          hint.textContent = String(err && err.message ? err.message : err);
        }).then(function () { btn.disabled = false; });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach);
  } else {
    attach();
  }

  BB.Camera = {
    supported: supported,
    start: start,
    stop: stop,
    isActive: isActive,
    /* 自检用：离屏/后台窗口里 document.hidden 为真，会跳过推理。
       自动化测试需要强制跑帧，线上不要调这个。 */
    setForce: function (v) { S.force = !!v; },
    debug: function () {
      var tr = S.stream && S.stream.getVideoTracks ? S.stream.getVideoTracks()[0] : null;
      return {
        vw: S.video ? S.video.videoWidth : -1, vh: S.video ? S.video.videoHeight : -1,
        paused: S.video ? S.video.paused : null, ready: S.video ? S.video.readyState : -1,
        track: tr ? (tr.readyState + '/' + tr.muted + '/' + tr.enabled) : 'none',
        recState: S.rec ? S.rec.state : 'none', recTries: S.recTries || 0,
        lastStop: S.lastStop || null, ticks: S.ticks || 0, hiddenSkips: S.hiddenSkips || 0, detects: S.detects || 0, errors: S.errCount || 0, lastError: S.lastErr || '', fps: S.targetFps };
    },
    warmDuration: warmDuration,
    attach: attach,
    MODULES: MODULES
  };
})(window.BB);
