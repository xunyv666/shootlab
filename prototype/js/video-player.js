/* ============================================================
 * video-player.js  —  视频控制模块（万忆）
 * 提供：上传 / 播放 / 暂停 / 逐帧 / 拖动进度 / 变速
 * 两种模式：
 *   demo —— 无视频时用虚拟时间轴驱动，保证原型随时可演示
 *   real —— 真实 <video> 播放
 * 对外接口（app.js 只依赖这 6 个方法 + onTime/onState 回调）：
 *   mount(videoEl) / loadFile(file) / toggle() / step(n) / seek(ratio) / setSpeed(x)
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var P = {
    mode: 'demo',
    playing: false,
    speed: 1,
    t: 0,              // 当前时间（秒，demo 模式为虚拟时间）
    duration: 8.4,     // demo 模式时长；real 模式取 video.duration
    fps: 30,
    video: null,
    rafId: null,
    lastTs: 0,
    _timeCbs: [],
    _stateCbs: []
  };

  function emitTime() {
    P._timeCbs.forEach(function (cb) {
      cb(P.t, P.duration, P.playing, P.mode);
    });
  }
  function emitState() {
    P._stateCbs.forEach(function (cb) { cb(P.playing, P.mode); });
  }

  /* ---------- 演示模式：虚拟时间轴 ---------- */
  function loop(ts) {
    if (!P.playing) return;
    if (!P.lastTs) P.lastTs = ts;
    var dt = (ts - P.lastTs) / 1000;
    P.lastTs = ts;
    P.t += dt * P.speed;
    if (P.t >= P.duration) {
      P.t = P.duration;
      P.playing = false;
      emitTime();
      emitState();
      return;
    }
    emitTime();
    P.rafId = requestAnimationFrame(loop);
  }

  function play() {
    if (P.mode === 'idle') { emitState(); return; }
    if (P.mode === 'real') {
      P.video.play().catch(function () { /* 浏览器可能拒绝自动播放 */ });
      P.playing = true;
    } else {
      if (P.t >= P.duration - 0.01) P.t = 0;
      P.playing = true;
      P.lastTs = 0;
      P.rafId = requestAnimationFrame(loop);
    }
    emitState();
  }

  function pause() {
    P.playing = false;
    if (P.rafId) { cancelAnimationFrame(P.rafId); P.rafId = null; }
    if (P.mode === 'real' && P.video) P.video.pause();
    emitState();
  }

  function toggle() { P.playing ? pause() : play(); }

  /* 逐帧：dir = +1 / -1 */
  function step(dir) {
    pause();
    var delta = dir / P.fps * 1.0;
    var next = Math.max(0, Math.min(P.duration, P.t + delta));
    seekTime(next);
  }

  function seekTime(sec) {
    P.t = Math.max(0, Math.min(P.duration, sec));
    if (P.mode === 'real' && P.video) P.video.currentTime = P.t;
    emitTime();
  }

  /* ratio 0~1 */
  function seek(ratio) { seekTime(ratio * P.duration); }

  function setSpeed(x) {
    P.speed = x;
    if (P.mode === 'real' && P.video) P.video.playbackRate = x;
  }

  /* ---------- 真实视频 ---------- */
  function loadFile(file) {
    if (!file || !P.video) return;
    loadUrl(URL.createObjectURL(file));
  }

  /* 直接给一个地址（实验样本、示例片段都用它） */
  function loadUrl(url) {
    if (!P.video) return;
    P.video.src = url;
    P.mode = 'real';
    P.t = 0;
    P.playing = false;
    P.video.onloadedmetadata = function () {
      P.duration = P.video.duration || 1;
      emitTime();
      emitState();
    };
    P.video.onended = function () { P.playing = false; emitState(); };
    /* timeupdate 只做低频同步，逐帧精度靠 seek 回调 */
    P.video.ontimeupdate = function () {
      if (!P.playing) return;
      P.t = P.video.currentTime;
      emitTime();
    };
    P.video.onplay = function () { P.playing = true; emitState(); };
    P.video.onpause = function () { P.playing = false; emitState(); };
    emitState();
  }

  /* 回到「还没选视频」的空闲态：时间轴归零，不播任何东西 */
  function setIdle() {
    pause();
    P.mode = 'idle';
    P.t = 0;
    P.duration = 0;
    if (P.video) {
      try { P.video.removeAttribute('src'); P.video.load(); } catch (e) { /* 忽略 */ }
    }
    emitTime();
    emitState();
  }

  function mount(videoEl) {
    P.video = videoEl;
    P.mode = 'idle';
    P.duration = 0;
    if (videoEl) {
      videoEl.addEventListener('seeked', function () {
        P.t = videoEl.currentTime;
        emitTime();
      });
    }
    emitTime();
  }

  BB.VideoPlayer = {
    mount: mount,
    loadFile: loadFile,
    loadUrl: loadUrl,
    setIdle: setIdle,
    play: play,
    pause: pause,
    toggle: toggle,
    step: step,
    seek: seek,
    seekTime: seekTime,
    setSpeed: setSpeed,
    onTime: function (cb) { P._timeCbs.push(cb); },
    onState: function (cb) { P._stateCbs.push(cb); },
    get state() { return P; }
  };
})(window.BB);
