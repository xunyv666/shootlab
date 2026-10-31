/* ============================================================
 * ghost.js — 标准投篮火柴人模板（叠加在你的视频上做对照）
 *
 * 为什么是「算出来的」而不是一张图：
 *   网上的标准姿势图都是某个身高、某个角度的真人，贴到你的视频上
 *   既对不上比例也对不上位置。这里按人体测量学比例（Drillis & Contini）
 *   现算一副骨架：身高从你画面里现量，站位对齐你的髋，手臂角度由指标区间反解。
 *
 * 画的是「出手那一瞬间」的姿势，不是下蹲蓄力那一瞬间 —— 因为你要对照的是
 * 出手点高不高、肘有没有伸直，这些只在出手帧才成立。
 *   肘角 162°（DIMS elbowAlign 中值）· 躯干前倾 5.5°（balance 中值）
 *   出手点 1.22×身高（releaseHeight 中值）· 起跳高度由前三项反解
 *
 * 正面视角：两条腿、两条臂都分开画。侧视角虽然更「专业」，但画出来
 * 四肢重叠成一根棍，用户根本没法跟自己对位。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  /* 人体测量学比例（Drillis & Contini，按身高归一化） */
  var R = {
    shank: 0.246,    // 膝 → 踝
    thigh: 0.245,    // 髋 → 膝
    torso: 0.288,    // 髋 → 肩
    upper: 0.186,    // 肩 → 肘
    fore: 0.146,     // 肘 → 腕
    headR: 0.062,
    ankleH: 0.039    // 踝关节离地（脚背厚度）
  };

  /* 站姿宽度，同样按身高归一化 */
  var W = { ank: 0.105, knee: 0.092, hip: 0.075, sh: 0.112 };

  var DEG = Math.PI / 180;

  var P = {
    on: false,
    knee: 114,          // 蓄力时的膝角（只用于说明，不参与骨架构图）
    kneeAtRelease: 168, // 出手瞬间腿基本伸直
    elbow: 162,
    lean: 5.5,
    jump: 0.08,
    releaseR: 1.225
  };

  /* 目标区间的中值：模板跟着指标定义走，定义改了模板自动跟着改 */
  function applyFromDims() {
    var D = BB.data && BB.data.DIMS;
    if (!D) return;
    var get = function (k) {
      for (var i = 0; i < D.length; i++) if (D[i].key === k) return D[i];
      return null;
    };
    var leg = get('legDrive'), el = get('elbowAlign'), bal = get('balance'), rh = get('releaseHeight');
    if (leg) P.knee = (leg.ideal[0] + leg.ideal[1]) / 2;
    if (el) P.elbow = (el.ideal[0] + el.ideal[1]) / 2;
    if (bal) P.lean = (bal.ideal[0] + bal.ideal[1]) / 2;
    if (rh) P.releaseR = (rh.ideal[0] + rh.ideal[1]) / 2;
    var jp = get('jump');
    if (jp) P.jump = (jp.ideal[0] + jp.ideal[1]) / 2;
  }

  /* ---------- 由参数生成骨架（单位：身高；原点在地面中线，y 朝上） ---------- */
  function build(p) {
    p = p || P;

    var th = p.kneeAtRelease * DEG;
    /* 髋比踝高多少：余弦定理。膝角越小，髋越低 */
    var d = Math.sqrt(R.thigh * R.thigh + R.shank * R.shank
      - 2 * R.thigh * R.shank * Math.cos(th));

    var lean = p.lean * DEG;
    var bend = (180 - p.elbow) * DEG;

    /* 上臂外展一点才像人（完全垂直就是根棍子）。取 6°，高度损失可忽略 */
    var a = 6 * DEG;

    /* 站着不跳时手腕离地多高；跟目标出手点的差额，就是这一投需要跳多高 */
    var stand = R.ankleH + d + Math.cos(lean) * R.torso
      + R.upper * Math.cos(a) + R.fore * Math.cos(a - bend);
    var jump = p.releaseR - stand;
    if (!isFinite(jump)) jump = p.jump;
    jump = Math.max(0.012, Math.min(0.24, jump));

    var yAnk = jump + R.ankleH;
    var yHip = yAnk + d;
    var ySh = yHip + Math.cos(lean) * R.torso;
    var dxSh = Math.sin(lean) * R.torso;

    /* 膝盖高度取髋踝中点略高，正面看才像「屈膝」而不是「折腿」 */
    var yKnee = yAnk + d * 0.53;

    var o = {
      hipC: { x: 0, y: yHip },
      shC: { x: dxSh, y: ySh },
      hipL: { x: -W.hip, y: yHip },
      hipR: { x: W.hip, y: yHip },
      shL: { x: dxSh - W.sh, y: ySh },
      shR: { x: dxSh + W.sh, y: ySh },
      kneeL: { x: -W.knee, y: yKnee },
      kneeR: { x: W.knee, y: yKnee },
      ankL: { x: -W.ank, y: yAnk },
      ankR: { x: W.ank, y: yAnk }
    };

    /* 投篮臂：上臂外展 a，前臂向内折回来，腕落在头顶右前方 */
    o.elbR = { x: o.shR.x + R.upper * Math.sin(a), y: o.shR.y + R.upper * Math.cos(a) };
    o.wriR = {
      x: o.elbR.x + R.fore * Math.sin(a - bend),
      y: o.elbR.y + R.fore * Math.cos(a - bend)
    };

    /* 非投篮手：上臂近乎竖直、前臂再向内折，指尖托在球侧下方 */
    var ga = -8 * DEG, gb = 28 * DEG;
    o.elbL = { x: o.shL.x + R.upper * Math.sin(ga), y: o.shL.y + R.upper * Math.cos(ga) };
    o.wriL = { x: o.elbL.x + R.fore * Math.sin(gb), y: o.elbL.y + R.fore * Math.cos(gb) };

    /* 头：脖子一段 + 圆 */
    o.neck = { x: dxSh + 0.006, y: ySh + 0.05 };
    o.head = { x: dxSh + 0.01, y: ySh + 0.115 };

    o.refY = yHip;          // 绘制时以髋为锚点，人跳起来也不会飘
    o.jump = jump;
    o.releaseR = o.wriR.y;  // 实际算出来的出手点（身高倍数）
    o.nominal = p.releaseR;
    return o;
  }

  /* ---------- 绘制 ---------- */
  var L_HIP = 23, R_HIP = 24, L_AN = 27, R_AN = 28;
  var COL = '#22c55e';

  function render(ctx, box, frame, side, meta) {
    if (!P.on || !frame || !box || !box.w) return;

    var hl = frame[L_HIP * 2], hr = frame[R_HIP * 2];
    if (hl == null || hr == null) return;
    var hipX = (frame[L_HIP * 2] + frame[R_HIP * 2]) / 2;
    var hipY = (frame[L_HIP * 2 + 1] + frame[R_HIP * 2 + 1]) / 2;
    var anY = (frame[L_AN * 2 + 1] + frame[R_AN * 2 + 1]) / 2;
    var noseY = frame[1];
    if (noseY == null || anY == null) return;

    /* 身高像素用「鼻尖→踝 / 0.891」：这个跨度跟机位角度无关，
       侧身、正面都一样准。髋宽只在正对镜头时才可用，不做主判据。 */
    var hpx = ((anY - noseY) * box.h) / 0.891;
    if (!isFinite(hpx) || hpx < 30) return;

    var g = build(P);
    var ox = box.x + hipX * box.w;
    var oy = box.y + hipY * box.h;
    var X = function (x) { return ox + x * hpx; };
    var Y = function (y) { return oy - (y - g.refY) * hpx; };

    /* 线宽跟着「人在画面里多大」走：人只有几十像素时 1px 根本看不见 */
    var k = Math.max(0.9, Math.min(2.6, hpx / 110));

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = COL;

    var line = function (a, b, alpha, w) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = (w || 2.4) * k;
      ctx.beginPath();
      ctx.moveTo(X(a.x), Y(a.y));
      ctx.lineTo(X(b.x), Y(b.y));
      ctx.stroke();
    };

    /* 躯干 + 肩轴 + 髋轴：这三条撑起身形，没有它们四肢就是散的 */
    ctx.setLineDash([]);
    line(g.hipC, g.shC, 0.85, 2.8);
    line(g.hipL, g.hipR, 0.8, 2.4);
    line(g.shL, g.shR, 0.9, 2.6);

    /* 两条腿 */
    line(g.hipL, g.kneeL, 0.85, 2.6);
    line(g.kneeL, g.ankL, 0.85, 2.6);
    line(g.hipR, g.kneeR, 0.55, 2.2);
    line(g.kneeR, g.ankR, 0.55, 2.2);

    /* 投篮臂：实线、最粗，这是要看的那条 */
    line(g.shR, g.elbR, 0.95, 3.1);
    line(g.elbR, g.wriR, 0.95, 3.1);

    /* 非投篮手：虚线 + 淡，看得见但不抢眼 */
    ctx.setLineDash([6 * k, 4 * k]);
    line(g.shL, g.elbL, 0.42, 2.0);
    line(g.elbL, g.wriL, 0.42, 2.0);
    ctx.setLineDash([]);

    /* 脖子 + 头 */
    line(g.shC, g.neck, 0.8, 2.4);
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 2.4 * k;
    ctx.beginPath();
    ctx.arc(X(g.head.x), Y(g.head.y), R.headR * hpx, 0, Math.PI * 2);
    ctx.stroke();

    /* 关节圈 */
    [g.ankL, g.ankR, g.kneeL, g.kneeR, g.hipL, g.hipR, g.shL, g.shR, g.elbR, g.wriR, g.wriL]
      .forEach(function (p) {
        ctx.beginPath();
        ctx.arc(X(p.x), Y(p.y), 2.4 * k, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        ctx.globalAlpha = 0.75;
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.stroke();
      });

    /* 出手点横线：一眼看出「标准比你高还是低」 */
    var ry = Y(g.wriR.y);
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([5 * k, 5 * k]);
    ctx.lineWidth = 1.5 * k;
    ctx.beginPath();
    ctx.moveTo(X(-0.20), ry);
    ctx.lineTo(X(0.24), ry);
    ctx.stroke();

    /* 文字：只标一个，画面里字多了就看不清人 */
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.font = '600 ' + Math.round(11.5 * k) + 'px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(6,14,10,.85)';
    var label = '标准出手点 ' + g.releaseR.toFixed(2) + '×身高';
    var lx = X(0.24) + 5 * k;
    ctx.strokeText(label, lx, ry);
    ctx.fillStyle = COL;
    ctx.fillText(label, lx, ry);

    ctx.restore();
  }

  BB.Ghost = {
    params: P,
    build: build,
    render: render,
    applyFromDims: applyFromDims,
    set: function (v) { P.on = !!v; if (BB.Overlay) BB.Overlay.resize(); },
    toggle: function () { P.on = !P.on; if (BB.Overlay) BB.Overlay.resize(); return P.on; },
    isOn: function () { return P.on; },
    /* 说明用：让界面能如实写出这个模板是按什么生成的（数字都是现算的，不是写死的） */
    describe: function () {
      var g = build(P);
      /* 这一行是单行显示的，写长了会被裁掉 —— 所以标签都缩到最短 */
      return '出手点 ' + g.releaseR.toFixed(2) + '× · 肘角 ' + Math.round(P.elbow)
        + '° · 躯干 ' + P.lean.toFixed(1) + '° · 起跳 ' + g.jump.toFixed(2) + '×';
    }
  };
})(window.BB);
