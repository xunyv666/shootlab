/* ============================================================
 * coach.js — 教练讲解层
 *
 * 干什么：拿一次分析结果，把它拆成 6 段「讲解镜头」。
 *   每段定格在动作的某个关键瞬间，在画面上画圈、画角度弧、画参考线，
 *   同时用旁白把这一处的实测数字和该改的地方说清楚。
 *
 * 为什么不用现成模板念稿：
 *   念稿会把「膝角 112°」这种数字漏掉，也不看用户实际做了什么。
 *   这里的每句话都由当次的 raw 指标现算，好在哪儿、差在哪儿都是比出来的。
 *
 * 依赖：res（pose-engine.analyze 的返回）、res.bundle 逐帧骨骼、BB.data.DIMS
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var S = {
    open: false,
    res: null,
    raw: null,
    segs: [],
    idx: 0,
    voice: true,
    raf: 0,
    phase: 0,
    phaseT0: 0,
    segEnd: 0,
    segT0: 0,
    needTalk: true,
    auto: true,
    epoch: 0,
    busy: false,
    rec: null,
    comp: null
  };

  var cv, ctx, video, stage;
  var box = { x: 0, y: 0, w: 0, h: 0 };
  var dpr = 1;

  var C = {
    neu: '#f97316',      // 中性：只做指示
    ok: '#22c55e',       // 达标
    bad: '#ef4444',      // 要改
    ink: 'rgba(8,11,17,.86)',
    white: '#ffffff'
  };

  /* MediaPipe 关键点 */
  var L_SH = 11, R_SH = 12, L_EL = 13, R_EL = 14, L_WR = 15, R_WR = 16,
      L_HP = 23, R_HP = 24, L_KN = 25, R_KN = 26, L_AN = 27, R_AN = 28;

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { return (v == null || isNaN(v)) ? '—' : (Math.round(v * 10) / 10) + (d == null ? '' : d); }

  /* ============ 骨架取帧 ============ */
  function frameAt(t) {
    var b = S.res && S.res.bundle;
    if (!b || !b.length) return null;
    var fps = S.res.meta.fps || 30;
    var i = clamp(Math.round(t * fps), 0, b.length - 1);
    return b[i];
  }
  function P(f, i) {
    if (!f) return null;
    var x = f[i * 2], y = f[i * 2 + 1];
    if (x == null || y == null) return null;
    return [x, y];
  }

  /* ============ 坐标映射：归一化 -> 画布像素 ============ */
  function fit() {
    if (!stage || !video) return;
    var r = stage.getBoundingClientRect();
    var W = r.width, H = r.height;
    if (!W || !H) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var vw = video.videoWidth || 16, vh = video.videoHeight || 9;
    var a = vw / vh, b = W / H;
    if (a > b) { box.w = W; box.h = W / a; box.x = 0; box.y = (H - box.h) / 2; }
    else { box.h = H; box.w = H * a; box.x = (W - box.w) / 2; box.y = 0; }
  }
  function X(nx) { return box.x + nx * box.w; }
  function Y(ny) { return box.y + ny * box.h; }

  /* ============ 绘制原语 ============ */
  function txt(s, x, y, color, size, align) {
    ctx.font = '600 ' + (size || 14) + 'px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(6,9,14,.9)';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color || C.neu;
    ctx.fillText(s, x, y);
  }

  function ring(nx, ny, rpx, prog, color, label, side) {
    if (nx == null) return;
    var x = X(nx), y = Y(ny), R = rpx * (0.42 + 0.58 * prog);
    ctx.save();
    ctx.globalAlpha = 0.25 + 0.75 * prog;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();
    // 十字准心，指得比圈更准
    if (prog > 0.5) {
      ctx.globalAlpha = (prog - 0.5) * 2;
      ctx.lineWidth = 1.6;
      var k = R * 0.34;
      ctx.beginPath();
      ctx.moveTo(x - R - k, y); ctx.lineTo(x - R + k, y);
      ctx.moveTo(x + R - k, y); ctx.lineTo(x + R + k, y);
      ctx.moveTo(x, y - R - k); ctx.lineTo(x, y - R + k);
      ctx.moveTo(x, y + R - k); ctx.lineTo(x, y + R + k);
      ctx.stroke();
    }
    ctx.restore();
    if (label) {
      /* 标签统一放圈的正上方：放右边会和角度弧的数值撞在一起 */
      txt(label, x, y - R - 12, color, 13, 'center');
    }
  }

  /* 在 b 点画 a-b-c 的夹角弧，弧长随 prog 生长 */
  function arcAngle(pa, pb, pc, prog, color, label, rpx) {
    if (!pa || !pb || !pc) return;
    var bx = X(pb[0]), by = Y(pb[1]);
    var ax = X(pa[0]), ay = Y(pa[1]);
    var cx = X(pc[0]), cy = Y(pc[1]);
    var a1 = Math.atan2(ay - by, ax - bx);
    var a2 = Math.atan2(cy - by, cx - bx);
    var d = a2 - a1;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    var R = rpx || box.w * 0.055;

    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.arc(bx, by, R, a1, a1 + d * prog, d < 0);
    ctx.stroke();
    // 两条边轻描一下，让人知道弧夹的是哪两个方向
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a1) * R * 1.5, by + Math.sin(a1) * R * 1.5);
    ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a2) * R * 1.5, by + Math.sin(a2) * R * 1.5);
    ctx.stroke();
    ctx.restore();

    if (label && prog > 0.55) {
      var mid = a1 + d / 2;
      var lx = bx + Math.cos(mid) * (R + 16);
      var ly = by + Math.sin(mid) * (R + 16);
      txt(label, lx, ly, color, 13.5, 'center');
    }
  }

  function hline(ny, nx0, nx1, prog, color, label) {
    var y = Y(ny);
    var x0 = X(nx0), x1 = X(nx0 + (nx1 - nx0) * prog);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.setLineDash([7, 5]);
    ctx.globalAlpha = 0.95;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    // 两端加小竖臂，看起来像一条「标注线」而不是随便一道虚线
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x0, y - 5); ctx.lineTo(x0, y + 5);
    ctx.moveTo(x1, y - 5); ctx.lineTo(x1, y + 5);
    ctx.stroke();
    ctx.restore();
    /* 标签放左端「下方」：这一段肘部的角度数值就在线的上方，挤在一起看不清 */
    if (label) txt(label, x0 + 4, y + 13, color, 13, 'left');
  }

  function vline(nx, ny0, ny1, prog, color, label) {
    var x = X(nx);
    var y0 = Y(ny0), y1 = Y(ny0 + (ny1 - ny0) * prog);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.setLineDash([7, 5]);
    ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.restore();
    if (label) txt(label, x + 7, (y0 + y1) / 2, color, 13, 'left');
  }

  /* 垂直尺寸标注：两端带横臂 */
  function dimV(nx, ny0, ny1, prog, color, label) {
    var x = X(nx);
    var y0 = Y(ny0), y1 = Y(ny0 + (ny1 - ny0) * prog);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y0); ctx.lineTo(x, y1);
    ctx.moveTo(x - 7, y0); ctx.lineTo(x + 7, y0);
    ctx.moveTo(x - 7, y1); ctx.lineTo(x + 7, y1);
    ctx.stroke();
    ctx.restore();
    if (label) txt(label, x + 11, (y0 + y1) / 2, color, 13, 'left');
  }

  function arrow(nx0, ny0, nx1, ny1, prog, color, label) {
    var x0 = X(nx0), y0 = Y(ny0);
    var x1 = X(nx0 + (nx1 - nx0) * prog), y1 = Y(ny0 + (ny1 - ny0) * prog);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    var a = Math.atan2(y1 - y0, x1 - x0);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - Math.cos(a - 0.42) * 11, y1 - Math.sin(a - 0.42) * 11);
    ctx.lineTo(x1 - Math.cos(a + 0.42) * 11, y1 - Math.sin(a + 0.42) * 11);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    if (label) txt(label, x1 + 8, y1 - 10, color, 13, 'left');
  }

  /* 球轨迹：点连成折线，末端标角度 */
  function traj(pts, prog, color, label) {
    if (!pts || pts.length < 2) return;
    var n = Math.max(2, Math.round(pts.length * prog));
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.6;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var x = X(pts[i][0]), y = Y(pts[i][1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
    var last = pts[n - 1];
    if (label) txt(label, X(last[0]) + 9, Y(last[1]) - 8, color, 13, 'left');
  }

  /* 人体尺度参照：髋到踝的像素长度。
     用固定半径画圈，人一远圈就比整个人还大 —— 必须跟着人的实际大小缩放。 */
  function refPx(f, side) {
    var HP = side === 'l' ? L_HP : R_HP, AN = side === 'l' ? L_AN : R_AN;
    var hp = P(f, HP), an = P(f, AN);
    var v = (hp && an) ? Math.abs(an[1] - hp[1]) * box.h : 0;
    if (v < 12) {
      var sh = P(f, side === 'l' ? L_SH : R_SH);
      if (sh && hp) v = Math.abs(sh[1] - hp[1]) * box.h * 2;
    }
    return v > 12 ? v : box.h * 0.18;
  }

  /* ============ 目标区间（与 metrics.js 的 DIMS 同源） ============ */
  function dim(key) {
    var D = BB.data && BB.data.DIMS;
    if (!D) return null;
    for (var i = 0; i < D.length; i++) if (D[i].key === key) return D[i];
    return null;
  }
  /* 出手角的目标区间要按出手点个性化算 —— Brancazio 公式 */
  function angleIdeal(raw) {
    var rh = raw && raw.releaseHeight;
    var d = (BB.data && BB.data.RAW_DIST) || 4.6;
    var hoop = (BB.data && BB.data.HOOP_H) || 3.05;
    if (rh == null) return [45, 52];
    var opt = 45 + 0.5 * Math.atan2(hoop - rh / 100, d) * 180 / Math.PI;
    return [opt - 2.5, opt + 2.5];
  }
  function inRange(v, r) { return v != null && v >= r[0] && v <= r[1]; }
  function judge(v, r) {
    if (v == null) return 'none';
    if (inRange(v, r)) return 'ok';
    return v < r[0] ? 'low' : 'high';
  }
  function rng(r, unit, fix) {
    var f = fix == null ? 0 : fix;
    return r[0].toFixed(f) + '–' + r[1].toFixed(f) + (unit || '');
  }

  /* 一段视频里可能检出好几次「抬手」，但只有球跟得住的那次才算真出手。
     讲错一次比不讲更糟，所以先按可信度挑一次出来。 */
  function pickShot(res) {
    var shots = res.shots || [];
    var best = shots[0], bs = -1, bi = 0;
    shots.forEach(function (s, i) {
      var sc = 0;
      if (s.ball && s.ball.ok) sc += 3;
      var r = s.raw || {};
      /* 出手瞬间肘角还弯着，说明那一帧根本不是投篮，是运球或者拿球 */
      if (r.elbowAngle != null && r.elbowAngle < 100) sc -= 4;
      ['elbowAngle', 'releaseHeight', 'jumpHeight', 'kneeFlex', 'torsoLean', 'followHold'].forEach(function (k) {
        if (r[k] != null) sc += 0.5;
      });
      if (r.releaseAngle != null) sc += 1;
      if (sc > bs) { bs = sc; best = s; bi = i; }
    });
    return { shot: best, idx: bi, score: bs };
  }

  /* ============ 讲解脚本 ============ */
  function build(res, shot, shotIdx, label) {
    S.shot = shot;
    var raw = shot.raw || {};
    S.raw = raw;
    var rel = shot.tAbs;
    var dip = rel - (raw.releaseTime && raw.releaseTime > 0.15 ? raw.releaseTime : 0.75);
    if (dip < 0.05) dip = Math.max(0.02, rel - 0.4);
    var H = raw.heightCm || 178;
    var side = res.meta.side === 'l' ? 'l' : 'r';
    var SH = side === 'r' ? R_SH : L_SH, EL = side === 'r' ? R_EL : L_EL,
        WR = side === 'r' ? R_WR : L_WR, HP = side === 'r' ? R_HP : L_HP,
        KN = side === 'r' ? R_KN : L_KN, AN = side === 'r' ? R_AN : L_AN;
    var dur = res.meta.duration || 3;
    var segs = [];

    var relH = raw.releaseHeight, jump = raw.jumpHeight, elbow = raw.elbowAngle,
        knee = raw.kneeFlex, lean = raw.torsoLean, hold = raw.followHold,
        relT = raw.releaseTime, rAngle = raw.releaseAngle;
    var relR = relH && H ? relH / H : null;
    var jumpR = jump != null && H ? jump / H : null;

    var DI = dim('releaseHeight') ? dim('releaseHeight').ideal : [1.15, 1.30];
    var JI = dim('jump') ? dim('jump').ideal : [0.10, 0.22];
    var EI = dim('elbowAlign') ? dim('elbowAlign').ideal : [152, 172];
    var BI = dim('balance') ? dim('balance').ideal : [3, 8];
    var AI = angleIdeal(raw);

    /* —— 1 站位 —— */
    var leanJ = judge(lean, BI);
    var leanTxt = lean == null ? '这一步没能看清躯干角度'
      : leanJ === 'ok' ? '躯干前倾 <b>' + num(lean) + '°</b>，正好落在 3–8° 的窗口里，重心压得住'
      : leanJ === 'high' ? '躯干前倾 <s>' + num(lean) + '°</s>，比 3–8° 多了，出手时上身会往前送'
      : lean < 0 ? '躯干是<s>后仰 ' + num(-lean) + '°</s>，重心落在脚跟，出手时身体在往后躲'
      : '躯干几乎立直（<s>' + num(lean) + '°</s>），下盘的力量传不上来';
    segs.push({
      t0: Math.max(0, rel - 1.55), t1: Math.max(0.1, rel - 1.05),
      title: '站位与重心', brief: '脚、髋、肩是不是一条线',
      text: '先看站定这一下。' + leanTxt + '。',
      plain: '先看站定这一下。' + strip(leanTxt) + '。',
      marks: function (f, pg) {
        var R = refPx(f, side);
        var sh = P(f, SH), hp = P(f, HP), an = P(f, AN);
        if (sh && hp) vline((sh[0] + hp[0]) / 2, hp[1], sh[1] - 0.02 * pg, pg, leanJ === 'ok' ? C.ok : C.neu, '躯干');
        if (hp) ring(hp[0], hp[1], R * 0.30, pg, C.neu, '髋');   // 这一段没有角度数值，留着字更清楚
        if (an) hline(an[1], Math.max(0.01, an[0] - 0.16), an[0] + 0.10, pg, C.neu, '');
      }
    });

    /* —— 2 下蹲 —— */
    var KI = [100, 120];
    var kJ = judge(knee, KI);
    var kTxt = knee == null ? '这一帧膝盖没识别到'
      : kJ === 'ok' ? '下蹲到 <b>' + num(knee) + '°</b>，蓄力够了'
      : kJ === 'high' ? '膝盖只弯到 <s>' + num(knee) + '°</s>，蹲得不够深（100–120° 才有蓄力），力量基本靠手臂出'
      : '膝盖弯到 <b>' + num(knee) + '°</b>，比 100–120° 蹲得更低，蓄力足但出手会慢半拍';
    segs.push({
      t0: Math.max(0, dip - 0.35), t1: Math.min(dur - 0.05, dip + 0.25),
      title: '下蹲蓄力', brief: '膝盖弯到多少度',
      text: kTxt + '。',
      plain: strip(kTxt) + '。',
      marks: function (f, pg) {
        var R = refPx(f, side);
        var hp = P(f, HP), kn = P(f, KN), an = P(f, AN);
        var col = kJ === 'ok' ? C.ok : (kJ === 'none' ? C.neu : C.bad);
        if (kn) ring(kn[0], kn[1], R * 0.34, pg, col, '');
        if (hp && kn && an) arcAngle(hp, kn, an, pg, col, '膝 ' + num(knee) + '°', R * 0.62);
      }
    });

    /* —— 3 起跳 —— */
    var jJ = judge(jumpR, JI);
    /* 下蹲到底到出手的时长。人一多、机位一远，膝角曲线会抖，
       dip 有可能落在出手帧本身，算出来是 0 秒 —— 那是没测出来，不是节奏快。 */
    var rTJ = (relT == null || relT < 0.15 || relT > 2.5) ? null : relT;
    var tJ = rTJ == null ? 'none' : (rTJ >= 0.32 && rTJ <= 0.62 ? 'ok' : (rTJ < 0.32 ? 'fast' : 'slow'));
    var jTxt = jumpR == null ? '起跳高度这次没测出来 —— 多半是脚被画面边缘切掉，或者人离镜头太远'
      : jJ === 'ok' ? '起跳 <b>' + num(jump) + 'cm</b>，是身高的 ' + jumpR.toFixed(2) + ' 倍（0.10–0.22 都算正常），脚下是有力的'
      : jJ === 'low' ? '起跳只有 <s>' + num(jump) + 'cm</s>，属于颠投。省力但抗干扰差，有人扑上来就会变形'
      : '起跳 <b>' + num(jump) + 'cm</b>，跳得比常规高，落地缓冲要跟上';
    var tTxt = tJ === 'none' ? ''
      : tJ === 'ok' ? '从蹲到底到出手 <b>' + num(rTJ, 's') + '</b>，节奏正好'
      : tJ === 'fast' ? '从蹲到底到出手只有 <b>' + num(rTJ, 's') + '</b>，偏快，下盘还没蹬完球就走了'
      : '从蹲到底到出手用了 <b>' + num(rTJ, 's') + '</b>，偏慢，防守容易跟上';
    segs.push({
      t0: Math.min(dur - 0.05, Math.max(0, rel - 0.42)), t1: Math.min(dur - 0.02, rel - 0.05),
      title: '起跳与发力', brief: '脚下给不给力、节奏快慢',
      text: jTxt + (tTxt ? '。' + tTxt : '') + '。',
      plain: strip(jTxt) + (tTxt ? '。' + strip(tTxt) : '') + '。',
      marks: function (f, pg) {
        var R = refPx(f, side);
        var an = P(f, AN), kn = P(f, KN);
        if (an && kn) dimV(an[0] + 0.06, an[1], kn[1], pg, jJ === 'ok' ? C.ok : C.neu, jump == null ? '' : '起跳 ' + num(jump) + 'cm');
        if (an) ring(an[0], an[1], R * 0.24, pg, C.neu, '');
      }
    });

    /* —— 4 出手：整段的核心 —— */
    var eJ = judge(elbow, EI);
    var rJ = judge(relR, DI);
    var aJ = judge(rAngle, AI);
    var eTxt = elbow == null ? ''
      : eJ === 'ok' ? '出手时肘角 <b>' + num(elbow) + '°</b>，手臂基本送直'
      : eJ === 'low' ? '出手时肘角只有 <s>' + num(elbow) + '°</s>，手没送直，球是「推」出去的不是「弹」出去的'
      : '出手时肘角 <b>' + num(elbow) + '°</b>，偏直，手腕的拨球空间被压掉了';
    var rTxt = relR == null ? ''
      : rJ === 'ok' ? '出手点在 <b>' + num(relH) + 'cm</b>，是身高的 <b>' + relR.toFixed(2) + ' 倍</b>（1.15–1.30 倍算正常）'
      : rJ === 'low' ? '出手点 <s>' + num(relH) + 'cm</s>，只有身高的 ' + relR.toFixed(2) + ' 倍，偏低，容易被封'
      : '出手点 <b>' + num(relH) + 'cm</b>，' + relR.toFixed(2) + ' 倍身高，很高';
    var aTxt = rAngle == null
      ? '这次球的飞行轨迹没跟住，出手角算不出来 —— 机位太近或者球出画太快都会这样'
      : aJ === 'ok' ? '出手角 <b>' + num(rAngle) + '°</b>，按你的出手点算目标是 ' + rng(AI, '°', 1) + '，正好在窗口里'
      : aJ === 'low' ? '出手角 <s>' + num(rAngle) + '°</s>，低于按你出手点算的 ' + rng(AI, '°', 1) + '，弧度平，容错小'
      : '出手角 <b>' + num(rAngle) + '°</b>，高于 ' + rng(AI, '°', 1) + '，弧度偏高，需要更多力';
    segs.push({
      t0: Math.min(dur - 0.05, Math.max(0, rel - 0.12)), t1: Math.min(dur - 0.01, rel + 0.12),
      title: '出手瞬间', brief: '肘角、出手点、出手角',
      text: [eTxt, rTxt, aTxt].filter(Boolean).join('。') + '。',
      plain: strip([eTxt, rTxt, aTxt].filter(Boolean).join('。')) + '。',
      marks: function (f, pg) {
        var R = refPx(f, side);
        var sh = P(f, SH), el = P(f, EL), wr = P(f, WR);
        if (el) ring(el[0], el[1], R * 0.26, pg, eJ === 'ok' ? C.ok : C.bad, '');
        if (sh && el && wr) arcAngle(sh, el, wr, pg, eJ === 'ok' ? C.ok : C.bad, '肘 ' + num(elbow) + '°', R * 0.46);
        if (wr) hline(wr[1], Math.max(0.02, wr[0] - 0.10), wr[0], pg, C.neu,
          relH == null ? '出手点' : '出手点 ' + num(relH) + 'cm');
        var bt = (S.shot && S.shot.ball) || res.meta.ballTrack;
        if (bt && bt.ok && bt.track && bt.track.length > 2) {
          var tp = bt.track.map(function (p) { return [p[1] / (video.videoWidth || 1), p[2] / (video.videoHeight || 1)]; });
          traj(tp, pg, aJ === 'ok' ? C.ok : C.neu, num(rAngle) + '°');
        }
      }
    });

    /* —— 5 随球 —— */
    var HI = [0.35, 1.2];
    /* hold 精度只有一帧（约 0.03s），0 表示「没数到」，不是「立刻收手」 */
    var holdOK = hold != null && hold > 0.05;
    var hJ = holdOK ? judge(hold, HI) : 'none';
    var hTxt = !holdOK ? '随球这一项没能测出来：出手后手腕没有明显停在最高点，可能是一出手就往下收了，也可能是识别抖动'
      : hJ === 'ok' ? '出手后手型保持了 <b>' + num(hold, 's') + '</b>，压腕是做完的'
      : '出手后只保持了 <s>' + num(hold, 's') + '</s>，手收得太早，球容易短';
    segs.push({
      t0: Math.min(dur - 0.06, rel + 0.08), t1: Math.min(dur - 0.01, rel + 0.62),
      title: '随球手型', brief: '出手后手腕停多久',
      text: hTxt + '。',
      plain: strip(hTxt) + '。',
      marks: function (f, pg) {
        var R = refPx(f, side);
        var wr = P(f, WR), el = P(f, EL);
        if (wr) ring(wr[0], wr[1], R * 0.26, pg, hJ === 'ok' ? C.ok : C.bad, '压腕');
        if (wr && el) arrow(el[0], el[1], wr[0] + (wr[0] - el[0]) * 0.7, wr[1] + (wr[1] - el[1]) * 0.7, pg,
          hJ === 'ok' ? C.ok : C.neu, '');
      }
    });

    /* —— 6 总结：只挑一条最该改的 —— */
    var cands = [];
    if (kJ !== 'ok' && kJ !== 'none') {
      cands.push({
        k: 'legDrive', s: 1.2,
        t: kJ === 'high'
          ? '下蹲：膝盖只到 ' + num(knee) + '°，先把蹲做深到 100–120°'
          : '下蹲：膝盖弯到 ' + num(knee) + '°，比需要低，收到 100–120° 出手会更快'
      });
    }
    if (eJ !== 'ok' && eJ !== 'none') {
      cands.push({
        k: 'elbowAlign', s: 1.2,
        t: eJ === 'low' ? '出手时肘角 ' + num(elbow) + '°，把手臂送直到 152–172°'
          : '出手时肘角 ' + num(elbow) + '°，偏直，留一点屈肘再接压腕'
      });
    }
    if (aJ !== 'ok' && aJ !== 'none') cands.push({ k: 'releaseAngle', s: 1.3, t: '出手角 ' + num(rAngle) + '°，往 ' + rng(AI, '°', 1) + ' 调' });
    if (holdOK && hJ !== 'ok') cands.push({ k: 'followThrough', s: 0.9, t: '随球只保持 ' + num(hold, 's') + '，压完腕再收手' });
    if (rJ !== 'ok' && rJ !== 'none') cands.push({ k: 'releaseHeight', s: 1.0, t: '出手点 ' + relR.toFixed(2) + ' 倍身高，偏' + (rJ === 'low' ? '低' : '高') });
    if (jJ !== 'ok' && jJ !== 'none') cands.push({ k: 'jump', s: 0.8, t: '起跳 ' + num(jump) + 'cm，下肢要主动蹬' });
    if (leanJ !== 'ok' && leanJ !== 'none') {
      cands.push({
        k: 'balance', s: 1.1,
        t: lean < 0 ? '躯干后仰 ' + num(-lean) + '°，把重心压回前脚掌'
          : '躯干前倾 ' + num(lean) + '°，收一点回来'
      });
    }
    cands.sort(function (a, b) { return b.s - a.s; });

    var radar = null;
    try { radar = BB.Metrics && BB.Metrics.radarOf ? BB.Metrics.radarOf(raw) : null; } catch (e) { radar = null; }
    var score = null;
    if (radar && BB.Metrics.overall) { try { score = BB.Metrics.overall(radar); } catch (e) { score = null; } }

    var top = cands[0];
    var goodCount = 6 - cands.length;
    var sumTxt = (score != null ? '这一球综合 <b>' + score + '</b> 分。' : '')
      + (top ? '如果只改一处，就改这个：<b>' + top.t + '</b>。' : '<em>八项都在窗口里，这一球没什么可挑的。</em>')
      + (cands.length > 1 ? ' 其次是' + cands[1].t + '。' : '');
    segs.push({
      t0: Math.min(dur - 0.05, rel + 0.3), t1: Math.min(dur, rel + 0.9),
      title: '只改一处', brief: top ? '优先级最高的一项' : '这场没有明显短板',
      text: sumTxt,
      plain: strip(sumTxt),
      marks: function (f, pg) {
        var R = refPx(f, side);
        var sh = P(f, SH), hp = P(f, HP), el = P(f, EL), kn = P(f, KN);
        if (kn && top && /下蹲/.test(top.t)) ring(kn[0], kn[1], R * 0.40, pg, C.bad, '');
        else if (el && top && /肘角/.test(top.t)) ring(el[0], el[1], R * 0.36, pg, C.bad, '');
        else if (sh && hp && top && /躯干/.test(top.t)) {
          vline((sh[0] + hp[0]) / 2, hp[1], sh[1], pg, C.bad, '');
        }
      }
    });

    /* 素材本身不够好时，开场就把话说在前面。
       用户听到「你出手点只有 1.12 倍身高」会当成事实，
       但如果人只有 200 像素高，这个数很可能差十几厘米。 */
    if (res.meta.smallSubject && segs[0]) {
      segs[0].text = '先说清楚：这段视频里人只有 <b>' + res.meta.subjectPx + '</b> 像素高，'
        + '厘米类的数字（出手点、起跳）误差会比较大，方向可以参考，具体数值别较真。'
        + segs[0].text;
      segs[0].plain = strip(segs[0].text);

      /* 素材不合格时不给「只改一处」的结论。
         基于一串误差十几厘米的数字排出来的优先级，是在骗人。 */
      var last = segs[segs.length - 1];
      last.title = '重拍建议';
      last.brief = '素材决定上限';
      last.text = '这段素材太小，具体的优先级我不下结论。想让我讲得准，按这三点重拍：'
        + '<b>手机放侧面</b>（垂直于投篮方向）、<b>离人 4–6 米</b>让人占满画面高度的一半以上、'
        + '<b>从准备到落地完整入镜</b>，最好是 10–20 秒的单个回合。';
      last.plain = strip(last.text);
      last.marks = function (f, pg) {
        var R = refPx(f, side);
        var an = P(f, AN);
        if (an) hline(an[1], Math.max(0.02, an[0] - 0.2), Math.min(0.98, an[0] + 0.2), pg, C.neu, '脚别出画');
        if (an) ring(an[0], an[1], R * 0.3, pg, C.neu, '');
      };
    }

    /* 每段记住自己属于哪次出手：右侧列表要按出手分组，
       用户点「第 3 次」时也得知道跳到哪 */
    segs.forEach(function (g) {
      g.shot = shotIdx;
      g.shotLabel = label || '';
    });
    return segs;
  }

  /* 一次视频里多次出手时，全部都讲 —— 用户要的是「每次出手都有讲解」。
     每段仍然只讲这一次的数字，不会串。 */
  function buildAll(res) {
    var out = [];
    (res.shots || []).forEach(function (sh, i) {
      out = out.concat(build(res, sh, i, '第 ' + (i + 1) + ' 次'));
    });
    return out;
  }

  function strip(s) {
    return String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }

  /* ============ 渲染 ============ */
  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    var seg = S.segs[S.idx];
    if (!seg) return;
    var f = frameAt(video.currentTime);
    var pg = S.phase;
    if (seg.marks) {
      try { seg.marks(f, pg); } catch (e) { /* 单帧缺关键点时静默跳过 */ }
    }
  }

  /* ============ 语音 ============ */
  var utter = null;
  var speakTid = 0;
  function speak(text, cb) {
    if (!S.voice || !('speechSynthesis' in window)) {
      /* 关掉语音不等于跳过 —— 字幕还要留够读的时间，按字数估 */
      speakTid = setTimeout(function () { cb && cb(); }, Math.max(1500, text.length * 115));
      return;
    }
    try { window.speechSynthesis.cancel(); } catch (e) {}
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    /* 讲得慢一点、音高软一点。1.06 的语速配上数字，听起来像教练在催；
       0.92 更像在旁边跟你说话。 */
    u.rate = 0.92;
    u.pitch = 1.05;
    var v = pickVoice();
    if (v) u.voice = v;
    var done = false;
    var fin = function () {
      if (done) return;
      done = true;
      clearTimeout(speakTid);
      cb && cb();
    };
    // onend 在部分浏览器会不触发，按字数估个上限兜底
    speakTid = setTimeout(fin, 1600 + text.length * 260);
    u.onend = fin;
    u.onerror = fin;
    utter = u;
    window.speechSynthesis.speak(u);
  }
  /* 浏览器里的中文音色差别很大。优先挑名字像女声的，
     没有就用第一个中文音色 —— 不要随机，否则每次进来说话的人都不一样。 */
  var voiceCache = null, voicePicked = false;
  function pickVoice() {
    if (voicePicked) return voiceCache;
    if (!('speechSynthesis' in window)) return null;
    var list = window.speechSynthesis.getVoices() || [];
    if (!list.length) return null;      // 还没加载好，下次再挑
    voicePicked = true;
    var zh = list.filter(function (v) { return /zh|cmn|Chinese/i.test((v.lang || '') + ' ' + (v.name || '')); });
    if (!zh.length) return (voiceCache = null);
    var soft = ['Xiaoxiao', 'Xiaoyi', '晓晓', '晓伊', 'Huihui', '慧慧', 'Yaoyao', '瑶瑶',
      'Tingting', '婷婷', 'Sinji', 'Female', '女'];
    for (var i = 0; i < soft.length; i++) {
      for (var j = 0; j < zh.length; j++) {
        if (zh[j].name.indexOf(soft[i]) >= 0) { voiceCache = zh[j]; return voiceCache; }
      }
    }
    voiceCache = zh[0];
    return voiceCache;
  }

  function stopSpeak() {
    clearTimeout(speakTid);       // 兜底定时器必须一起清：否则手动切段后被它推着连跳
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }

  /* ============ 播放流程 ============ */
  function showSub(seg) {
    var el = $('coachSub');
    if (!el) return;
    el.innerHTML = seg.text;
    el.classList.add('show');
  }

  function markSide() {
    var items = document.querySelectorAll('.coach-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('on', i === S.idx);
      items[i].classList.toggle('done', i < S.idx);
    }
    var dots = document.querySelectorAll('.coach-steps i');
    for (var j = 0; j < dots.length; j++) {
      dots[j].classList.toggle('on', j === S.idx);
      dots[j].classList.toggle('done', j < S.idx);
    }
    var cur = document.querySelector('.coach-item.on');
    if (cur && cur.scrollIntoView) {
      try { cur.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    }
  }

  function tick() {
    var now = performance.now();
    S.phase = clamp((now - S.phaseT0) / 900, 0, 1);
    draw();

    if (S.needTalk) {
      /* 跳段后 currentTime 要等 seek 才能真正到 seg.t0。
         这期间 currentTime 还是旧位置（比 segEnd 大），
         直接判 reached 会立刻跳到下一段 —— 必须确认已经 seek 到位。 */
      var cur = video.currentTime;
      var arrived = cur >= S.segT0 - 0.09 && cur <= S.segEnd + 0.4;
      var reached = arrived && cur >= S.segEnd - 0.03;
      var timeout = now - S.phaseT0 > 2800;
      if (reached || timeout) {
        S.needTalk = false;
        try { video.pause(); } catch (e) {}
        var seg = S.segs[S.idx];
        if (S.auto) {
          var ep = S.epoch;
          speak(seg.plain, function () {
            if (ep !== S.epoch || !S.open || !S.auto) return;
            setTimeout(function () {
              if (ep !== S.epoch || !S.open || !S.auto) return;
              if (S.idx + 1 < S.segs.length) goto(S.idx + 1);
              else finish();
            }, 260);
          });
        }
      }
    }
    if (S.open) S.raf = requestAnimationFrame(tick);
  }

  function goto(i) {
    if (!S.segs.length) return;
    i = clamp(i, 0, S.segs.length - 1);
    S.epoch = (S.epoch || 0) + 1;   // 每次切段作废上一段还没跑完的回调
    S.idx = i;
    var seg = S.segs[i];
    S.phase = 0;
    S.phaseT0 = performance.now();
    S.segT0 = seg.t0;
    S.segEnd = seg.t1;       // 段内播放到这个时刻就停下来说话
    S.needTalk = true;
    S.auto = true;
    markSide();
    showSub(seg);
    stopSpeak();
    try {
      /* 对齐到骨骼采样帧：bundle 的采样率比视频帧率稀，
         不对齐的话画面停在 A 帧、骨架却取到 B 帧，圈画会「飘」 */
      var fps = (S.res && S.res.meta.fps) || 30;
      var qi = Math.round(seg.t0 * fps) / fps;
      video.currentTime = Math.max(0, Math.min((video.duration || 99) - 0.05, qi));
      video.playbackRate = 0.45;
      video.play().catch(function () {});
    } catch (e) {}
    var btn = $('coachReplay');
    if (btn) btn.disabled = i === 0;
  }

  function finish() {
    S.auto = false;
    stopSpeak();
    var el = $('coachSub');
    if (el) {
      el.innerHTML = '讲解完了。想重看哪一段，点右边任意一条就行；想自己拖时间轴，按「自由播放」。';
      el.classList.add('show');
    }
    var dots = document.querySelectorAll('.coach-steps i');
    for (var j = 0; j < dots.length; j++) { dots[j].classList.add('done'); }
  }

  /* ============ 打开 / 关闭 ============ */
  function renderSide() {
    var box2 = $('coachList');
    if (!box2) return;
    box2.innerHTML = '';
    var last = -1;
    S.segs.forEach(function (s, i) {
      /* 多次出手时分个组，不然 30 段并列，找不到「第 3 次」在哪 */
      if (s.shot !== last) {
        last = s.shot;
        if (s.shotLabel && S.scope === 'all') {
          var sh = S.res && S.res.shots && S.res.shots[s.shot];
          var h = document.createElement('div');
          h.className = 'coach-group';
          h.innerHTML = '<b>' + s.shotLabel + '</b>' +
            (sh && sh.tAbs != null ? '<span>' + sh.tAbs.toFixed(2) + 's</span>' : '') +
            (sh && sh.made === true ? '<em>命中</em>' : sh && sh.made === false ? '<em class="miss">未中</em>' : '');
          box2.appendChild(h);
        }
      }
      var d = document.createElement('div');
      d.className = 'coach-item';
      d.setAttribute('data-i', i);
      d.innerHTML = '<span class="n">' + (i + 1) + '</span><span class="tx"><b>' + s.title + '</b><span>' + s.brief + '</span></span>';
      d.addEventListener('click', function () { goto(i); });
      box2.appendChild(d);
    });
    var steps = $('coachSteps');
    if (steps) {
      steps.innerHTML = '';
      /* 段数太多时圆点会挤成一条灰线，不如不显示 */
      if (S.segs.length <= 14) S.segs.forEach(function () { steps.appendChild(document.createElement('i')); });
    }
  }

  function open(res) {
    if (!res || !res.shots || !res.shots.length) return;
    S.res = res;
    /* 多次出手默认全部讲一遍 —— 用户要的是「每次出手都有讲解」 */
    S.scope = res.shots.length > 1 ? 'all' : 'one';
    S.segs = S.scope === 'all' ? buildAll(res) : build(res, pickShot(res).shot, 0, '');
    if (!S.segs.length) return;

    var layer = $('coachLayer');
    var v = $('coachVideo');
    layer.hidden = false;
    S.open = true;

    var src = res.meta.video;
    if (v.getAttribute('data-src') !== src) {
      v.setAttribute('data-src', src);
      v.src = src;
    }
    video = v;
    stage = $('coachStage');
    cv = $('coachCanvas');
    ctx = cv.getContext('2d');

    var meta = $('coachMeta');
    if (meta) {
      var bits = [res.meta.subject || '我的视频'];
      if (res.meta.heightCm) bits.push('按 ' + res.meta.heightCm + 'cm 换算');
      if (S.scope === 'all') {
        bits.push('逐次讲解 ' + res.shots.length + ' 次出手');
      } else {
        var sh = S.shot || res.shots[0];
        bits.push('出手 ' + (sh.tAbs != null ? sh.tAbs.toFixed(2) + 's' : ''));
        if (res.shots.length > 1) bits.push('（' + res.shots.length + ' 次里挑了最可信的一次）');
      }
      meta.textContent = bits.join(' · ');
      var sc = $('coachScope');
      if (sc) {
        sc.hidden = res.shots.length < 2;
        sc.textContent = S.scope === 'all'
          ? '只看最可信的一次'
          : '讲全部 ' + res.shots.length + ' 次';
      }
    }

    var boot = function () {
      fit();
      renderSide();
      if (BB.Bgm) { BB.Bgm.start(); syncBgmBtn(); }
      S.idx = 0;
      goto(0);
      S.raf = requestAnimationFrame(tick);
      layer.classList.add('show');
    };
    if (v.readyState >= 1) setTimeout(boot, 30);
    else v.addEventListener('loadedmetadata', function () { setTimeout(boot, 30); }, { once: true });
  }

  function close() {
    S.open = false;
    S.auto = false;
    stopSpeak();
    if (BB.Bgm) BB.Bgm.stop();
    cancelAnimationFrame(S.raf);
    try { video && video.pause(); } catch (e) {}
    var layer = $('coachLayer');
    if (layer) {
      layer.classList.remove('show');
      setTimeout(function () { layer.hidden = true; }, 200);
    }
  }

  function syncBgmBtn() {
    var b = $('coachBgm');
    if (!b || !BB.Bgm) return;
    var on = BB.Bgm.isOn();
    b.classList.toggle('off', !on);
    var t = b.querySelector('span:last-child');
    if (t) t.textContent = on ? '音乐开' : '音乐关';
  }

  /* ============ 导出：composite 到一块画布再录 ============ */
  function exportVideo() {
    var btn = $('coachExport');
    if (btn) { btn.disabled = true; btn.textContent = '录制中…'; }
    var W = Math.round(box.w), H = Math.round(box.h);
    if (!W || !H) { if (btn) { btn.disabled = false; btn.textContent = '导出讲解视频'; } return; }

    var comp = document.createElement('canvas');
    comp.width = W; comp.height = H;
    var cx = comp.getContext('2d');
    S.comp = { cv: comp, ctx: cx };

    var stream = comp.captureStream(30);
    var mime = 'video/webm;codecs=vp9';
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported(mime)) mime = 'video/webm';
    var chunks = [];
    var rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4e6 }); }
    catch (e) {
      S.comp = null;
      if (btn) { btn.disabled = false; btn.textContent = '导出讲解视频'; }
      return;
    }
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      S.comp = null;
      var blob = new Blob(chunks, { type: 'video/webm' });
      var u = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = u;
      a.download = '投篮讲解_' + Date.now() + '.webm';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
      if (btn) { btn.disabled = false; btn.textContent = '导出讲解视频'; }
    };
    rec.start();

    // 合成循环：视频画面 + 圈画 + 字幕都压到同一块画布
    var compRaf = function () {
      if (!S.comp) return;
      var vw = video.videoWidth, vh = video.videoHeight;
      if (vw) {
        cx.drawImage(video, 0, 0, W, H);
      } else {
        cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
      }
      // 把圈画层按比例贴上去
      cx.drawImage(cv, 0, 0, cv.width, cv.height, 0, 0, W, H);
      drawSubOn(cx, S.segs[S.idx], W, H);
      if (S.comp) requestAnimationFrame(compRaf);
    };
    requestAnimationFrame(compRaf);

    // 从头讲一遍，讲完自动停
    S.idx = -1;
    var v0 = S.voice;
    S.voice = false;                  // 录制时不出声，避免和播放抢语音
    goto(0);
    var guard = setInterval(function () {
      if (!S.open) { clearInterval(guard); rec.state !== 'inactive' && rec.stop(); return; }
      if (S.idx >= S.segs.length - 1 && !S.auto) {
        clearInterval(guard);
        setTimeout(function () {
          S.voice = v0;
          if (rec.state !== 'inactive') rec.stop();
        }, 1200);
      }
    }, 400);
  }

  function drawSubOn(cx, seg, W, H) {
    if (!seg) return;
    var t = seg.plain;
    if (!t) return;
    var fs = Math.max(14, Math.round(W / 46));   // 之前按 W/34，三行字幕占了画面三分之一
    cx.font = '600 ' + fs + 'px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    var maxW = W * 0.84;
    var lines = wrap(cx, t, maxW);
    var lh = fs * 1.55;
    var tw = 0, i;
    for (i = 0; i < lines.length; i++) tw = Math.max(tw, cx.measureText(lines[i]).width);
    var pad = fs * 0.85;
    var bw = tw + pad * 2;                    // 框宽 = 文字宽 + 内边距，框和字用同一组坐标
    var bh = lines.length * lh + pad * 0.7;
    var bx = (W - bw) / 2;
    var by = H - bh - fs * 1.1;
    cx.fillStyle = 'rgba(8,11,17,.84)';
    roundRect(cx, bx, by, bw, bh, 12);
    cx.fill();
    cx.fillStyle = '#eef2f8';
    cx.textAlign = 'left';
    cx.textBaseline = 'top';
    for (i = 0; i < lines.length; i++) {
      cx.fillText(lines[i], bx + pad, by + pad * 0.38 + i * lh);
    }
  }
  function wrap(cx, text, maxW) {
    var out = [], line = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (cx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; }
      else line += ch;
    }
    if (line) out.push(line);
    return out.slice(0, 4);
  }
  function roundRect(cx, x, y, w, h, r) {
    cx.beginPath();
    cx.moveTo(x + r, y);
    cx.arcTo(x + w, y, x + w, y + h, r);
    cx.arcTo(x + w, y + h, x, y + h, r);
    cx.arcTo(x, y + h, x, y, r);
    cx.arcTo(x, y, x + w, y, r);
    cx.closePath();
  }

  /* ============ 绑定 ============ */
  function bind() {
    var layer = $('coachLayer');
    if (!layer || layer.getAttribute('data-bound')) return;
    layer.setAttribute('data-bound', '1');

    $('coachClose').addEventListener('click', close);
    $('coachReplay').addEventListener('click', function () {
      S.idx = -1;
      goto(0);
    });
    $('coachVoice').addEventListener('click', function () {
      S.voice = !S.voice;
      this.classList.toggle('off', !S.voice);
      this.querySelector('span:last-child').textContent = S.voice ? '语音开' : '语音关';
      if (!S.voice) stopSpeak();
    });
    var free = $('coachFree');
    free.addEventListener('click', function () {
      S.auto = false;
      stopSpeak();
      video.playbackRate = 1;
      video.play().catch(function () {});
      var el = $('coachSub');
      if (el) { el.innerHTML = '自由播放：圈画仍然跟着动作走，但不再逐段讲解了。'; el.classList.add('show'); }
    });
    var nx = $('coachNext');
    if (nx) nx.addEventListener('click', function () {
      if (S.idx + 1 < S.segs.length) goto(S.idx + 1); else finish();
    });
    var ex = $('coachExport');
    if (ex) ex.addEventListener('click', exportVideo);

    var sc = $('coachScope');
    if (sc) sc.addEventListener('click', function () {
      if (!S.res) return;
      S.scope = S.scope === 'all' ? 'one' : 'all';
      S.segs = S.scope === 'all' ? buildAll(S.res) : build(S.res, pickShot(S.res).shot, 0, '');
      var meta = $('coachMeta');
      if (meta) {
        var bits = [S.res.meta.subject || '我的视频'];
        if (S.res.meta.heightCm) bits.push('按 ' + S.res.meta.heightCm + 'cm 换算');
        bits.push(S.scope === 'all'
          ? '逐次讲解 ' + S.res.shots.length + ' 次出手'
          : '只讲最可信的一次');
        meta.textContent = bits.join(' · ');
      }
      sc.textContent = S.scope === 'all'
        ? '只看最可信的一次'
        : '讲全部 ' + S.res.shots.length + ' 次';
      renderSide();
      S.idx = 0;
      goto(0);
    });

    var bgmBtn = $('coachBgm');
    if (bgmBtn) bgmBtn.addEventListener('click', function () {
      if (!BB.Bgm) return;
      BB.Bgm.toggle();
      syncBgmBtn();
    });

    document.addEventListener('keydown', function (e) {
      if (!S.open) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') goto(S.idx + 1);
      if (e.key === 'ArrowLeft') goto(S.idx - 1);
    });
    window.addEventListener('resize', function () { if (S.open) { fit(); draw(); } });
  }

  BB.Coach = {
    open: function (res) { bind(); open(res); },
    close: close,
    isOpen: function () { return S.open; }
  };

})(window.BB);
