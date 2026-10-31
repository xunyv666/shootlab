/* ============================================================
 * bgm.js — 舒缓背景音乐（现场合成，不带音频文件）
 *
 * 为什么不用 mp3：
 *   项目要能整个文件夹拷走就用，外挂一个音乐文件既占体积，
 *   又有版权问题。这里用 Web Audio 现场合成一段极简的和弦铺底：
 *   Cmaj7 → Am7 → Fmaj7 → G6 循环，正弦波 + 低通 + 延迟，
 *   音量压得很低，只做「不安静」的作用，不抢讲解。
 *
 * 只在乎两件事：够柔和、能一键关掉。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  /* 四个和弦，每个是频率（Hz）列表。用中低音区，听感才「铺」得下来 */
  var CHORDS = [
    [130.81, 164.81, 196.00, 246.94],   // Cmaj7  C3 E3 G3 B3
    [110.00, 130.81, 164.81, 196.00],   // Am7    A2 C3 E3 G3
    [ 87.31, 130.81, 174.61, 220.00],   // Fmaj7  F2 C3 F3 A3
    [ 98.00, 123.47, 146.83, 196.00]    // G6     G2 B2 D3 G3
  ];
  var BEAT = 7.2;      // 每个和弦持续 7.2 秒，慢一点才不催人

  var ctx = null, master = null, timer = 0, idx = 0, on = false, vol = 0.052;
  var FADER = 0.9;     /* master 是总推子，固定值；音量靠 vol 控制，别两处相乘 */

  function ensure() {
    if (ctx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch (e) { return false; }

    master = ctx.createGain();
    master.gain.value = 0;

    /* 低通把高频毛刺削掉，只剩暖暖的一层 */
    var lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.4;

    /* 一点点延迟，听起来像在小房间里放，而不是贴着耳朵 */
    var dly = ctx.createDelay();
    dly.delayTime.value = 0.42;
    var fb = ctx.createGain();
    fb.gain.value = 0.22;
    var wet = ctx.createGain();
    wet.gain.value = 0.28;

    master.connect(lp);
    lp.connect(ctx.destination);
    lp.connect(dly);
    dly.connect(fb);
    fb.connect(dly);
    dly.connect(wet);
    wet.connect(ctx.destination);
    return true;
  }

  function playChord(ci, when) {
    if (!ctx) return;
    var notes = CHORDS[ci % CHORDS.length];
    var t0 = when || ctx.currentTime;

    notes.forEach(function (f, i) {
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      /* 高音声部弱一点，避免盖过中低频的「底」 */
      var peak = vol * (i === 0 ? 1 : 0.62 - i * 0.06);
      osc.type = i === 0 ? 'sine' : 'triangle';
      osc.frequency.value = f;
      /* 轻微失谐：两个振荡器完全同频会听出电子味 */
      osc.detune.value = (i % 2 ? 4 : -3);

      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + BEAT * 0.35);
      g.gain.linearRampToValueAtTime(peak * 0.72, t0 + BEAT * 0.75);
      g.gain.linearRampToValueAtTime(0.0001, t0 + BEAT + 0.6);

      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(t0 + BEAT + 0.8);
    });
  }

  function loop() {
    playChord(idx++);
  }

  function start() {
    if (on) return;
    if (!ensure()) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    on = true;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value || 0.0001, ctx.currentTime);
    master.gain.linearRampToValueAtTime(FADER, ctx.currentTime + 2.2);   // 淡入
    idx = 0;
    loop();
    timer = setInterval(loop, BEAT * 1000);
  }

  function stop() {
    if (!on) return;
    on = false;
    clearInterval(timer);
    timer = 0;
    if (!ctx) return;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 1.1);  // 淡出
  }

  BB.Bgm = {
    start: start,
    stop: stop,
    toggle: function () { on ? stop() : start(); return on; },
    isOn: function () { return on; },
    /* 导出视频时把音乐一起录进去用 */
    get context() { return ctx; },
    get node() { return master; }
  };
})(window.BB);
