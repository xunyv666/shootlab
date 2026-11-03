/* ============================================================
 * overlay.js  —  骨骼点绘制层
 * 现在用程序化骨骼「演」一遍投篮动作，方便无视频也能演示；
 * 臧子涵接好 MediaPipe 后，调用 Overlay.setFrame(landmarks) 即可
 * 直接覆盖绘制真实结果，本文件其余逻辑不用改。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var cv, ctx, w = 0, h = 0, dpr = 1;
  var realFrame = null;          // 真实骨骼点（33 点，归一化坐标）
  var lastT = 0, lastShow = true;
  /* 实验模式：整段视频的逐帧骨骼（离线用 MediaPipe 提好，前端按时间取帧回放） */
  var bundle = null, bundleFps = 30, bundleSide = 'r';
  var COLOR = '#f97316';
  var COLOR_SOFT = 'rgba(249,115,22,0.35)';
  /* 空闲态：还没选视频时画布全空。以前这里默认跑一段程序化骨骼"演示"，
     看着像上个年代的教学 flash，而且是假的 —— 干脆不画。 */
  var idle = true;

  /* 关键姿态：p=0 准备 → 0.32 最低点 → 0.62 出手 → 0.80 随球 → 1 复位 */
  var KEYS = [
    { p: 0.00, j: { ankle: [0.34, 0.88], knee: [0.37, 0.69], hip: [0.38, 0.50], sh: [0.38, 0.30], elbow: [0.43, 0.40], wrist: [0.47, 0.31], head: [0.39, 0.20] } },
    { p: 0.32, j: { ankle: [0.34, 0.88], knee: [0.40, 0.72], hip: [0.38, 0.56], sh: [0.38, 0.36], elbow: [0.42, 0.46], wrist: [0.44, 0.37], head: [0.39, 0.26] } },
    { p: 0.62, j: { ankle: [0.34, 0.84], knee: [0.37, 0.62], hip: [0.38, 0.44], sh: [0.38, 0.24], elbow: [0.45, 0.20], wrist: [0.55, 0.12], head: [0.39, 0.15] } },
    { p: 0.80, j: { ankle: [0.34, 0.85], knee: [0.37, 0.63], hip: [0.38, 0.45], sh: [0.38, 0.25], elbow: [0.46, 0.19], wrist: [0.57, 0.15], head: [0.39, 0.16] } },
    { p: 1.00, j: { ankle: [0.34, 0.88], knee: [0.37, 0.69], hip: [0.38, 0.50], sh: [0.38, 0.30], elbow: [0.43, 0.40], wrist: [0.47, 0.31], head: [0.39, 0.20] } }
  ];
  var RELEASE_P = 0.62;

  function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

  function poseAt(p) {
    var i = 0;
    while (i < KEYS.length - 2 && p > KEYS[i + 1].p) i++;
    var a = KEYS[i], b = KEYS[i + 1];
    var t = (p - a.p) / (b.p - a.p || 1);
    t = Math.max(0, Math.min(1, t));
    var e = easeInOut(t);
    var out = {};
    Object.keys(a.j).forEach(function (k) {
      out[k] = [
        a.j[k][0] + (b.j[k][0] - a.j[k][0]) * e,
        a.j[k][1] + (b.j[k][1] - a.j[k][1]) * e
      ];
    });
    return out;
  }

  function resize() {
    if (!cv) return;
    var rect = cv.getBoundingClientRect();
    if (!rect.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width; h = rect.height;
    // 注意：改 canvas.width 会清空画面，所以必须重绘一次
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint();
  }

  /* 视频的画面比例。竖屏视频放进横向舞台时浏览器会留黑边（object-fit: contain），
     骨骼点是按「视频画面」归一化到 0~1 的，如果直接乘整块画布宽高，
     横向会被拉伸成两倍宽 —— 骨架看着有，但完全对不上人。
     所以先算出视频实际显示的那块矩形，再往里映射。 */
  var vidAspect = 0;
  var box = { x: 0, y: 0, w: 0, h: 0 };

  function computeBox() {
    if (!vidAspect || !w) { box.x = 0; box.y = 0; box.w = w; box.h = h; return; }
    var stageA = w / h, bw, bh;
    if (vidAspect > stageA) { bw = w; bh = w / vidAspect; }
    else { bh = h; bw = h * vidAspect; }
    box.x = (w - bw) / 2; box.y = (h - bh) / 2; box.w = bw; box.h = bh;
  }

  function sx(v) { return box.x + v * box.w; }
  function sy(v) { return box.y + v * box.h; }

  /* 鼠标位置 → 视频画面归一化坐标。标定篮筐要用：
     舞台比视频宽时两侧有黑边，直接按画布宽高换算会偏一大截。 */
  function clientToNorm(clientX, clientY) {
    if (!cv || !w) return null;
    var rect = cv.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    computeBox();
    if (!box.w || !box.h) return null;
    var nx = ((clientX - rect.left) * (w / rect.width) - box.x) / box.w;
    var ny = ((clientY - rect.top) * (h / rect.height) - box.y) / box.h;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;   // 点在黑边上，不算
    return [nx, ny];
  }

  function line(a, b, color, width, dash) {
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash(dash || []);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.moveTo(sx(a[0]), sy(a[1]));
    ctx.lineTo(sx(b[0]), sy(b[1]));
    ctx.stroke();
    ctx.restore();
  }

  function joint(p, color, r) {
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(sx(p[0]), sy(p[1]), r, 0, Math.PI * 2);
    ctx.fill();
  }

  /* 场地参照：地面线 + 篮筐 */
  function drawCourt() {
    var gy = sy(0.90);
    var g = ctx.createLinearGradient(0, gy, w, gy);
    g.addColorStop(0, 'rgba(120,130,145,0.05)');
    g.addColorStop(1, 'rgba(120,130,145,0.16)');
    ctx.fillStyle = g;
    ctx.fillRect(0, gy, w, h - gy);
    ctx.strokeStyle = 'rgba(120,130,145,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, gy + 0.5);
    ctx.lineTo(w, gy + 0.5);
    ctx.stroke();

    // 篮筐
    var rx = sx(0.90), ry = sy(0.30), rw = sx(0.045), rh = sy(0.018);
    ctx.strokeStyle = 'rgba(80,90,105,0.55)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(rx, ry, rw, rh, 0, 0, Math.PI * 2);
    ctx.stroke();
    // 网
    ctx.strokeStyle = 'rgba(120,130,145,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx - rw, ry);
    ctx.lineTo(rx - rw * 0.55, ry + sy(0.055));
    ctx.moveTo(rx + rw, ry);
    ctx.lineTo(rx + rw * 0.55, ry + sy(0.055));
    ctx.moveTo(rx - rw * 0.55, ry + sy(0.055));
    ctx.lineTo(rx + rw * 0.55, ry + sy(0.055));
    ctx.stroke();
  }

  function drawSkeleton(pose, p) {
    var body = COLOR;
    // 后腿（左移一点，制造前后腿的立体感）
    var off = 0.026;
    line([pose.hip[0] - off, pose.hip[1]], [pose.knee[0] - off, pose.knee[1]], 'rgba(249,115,22,0.28)', 4.5);
    line([pose.knee[0] - off, pose.knee[1]], [pose.ankle[0] - off, pose.ankle[1]], 'rgba(249,115,22,0.28)', 4.5);
    // 躯干
    line(pose.hip, pose.sh, body, 5);
    // 前腿
    line(pose.hip, pose.knee, COLOR_SOFT, 5);
    line(pose.knee, pose.ankle, COLOR_SOFT, 5);
    // 颈
    line(pose.sh, [pose.head[0], pose.head[1] + 0.034], body, 4.5);
    // 投篮臂
    line(pose.sh, pose.elbow, body, 5);
    line(pose.elbow, pose.wrist, body, 5);
    // 非投篮臂（示意，稍短）
    line(pose.sh, [pose.sh[0] - 0.045, pose.sh[1] + 0.10], COLOR_SOFT, 4);
    line([pose.sh[0] - 0.045, pose.sh[1] + 0.10], [pose.sh[0] - 0.03, pose.sh[1] + 0.19], COLOR_SOFT, 4);

    joint(pose.sh, body, 4);
    joint(pose.hip, body, 4);
    joint(pose.knee, COLOR_SOFT, 3.5);
    joint(pose.ankle, COLOR_SOFT, 3.5);
    joint(pose.elbow, body, 4);
    joint(pose.wrist, body, 4.5);

    // 头
    ctx.beginPath();
    ctx.fillStyle = 'rgba(249,115,22,0.18)';
    ctx.strokeStyle = body;
    ctx.lineWidth = 3;
    ctx.arc(sx(pose.head[0]), sy(pose.head[1]), sy(0.038), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 出手角标注（仅在出手前后）：水平参考线 + 前臂延长线 + 夹角圆弧
    if (p > 0.5 && p < 0.8) {
      var alpha = p < RELEASE_P ? (p - 0.5) / 0.12 : 1 - (p - RELEASE_P) / 0.18;
      alpha = Math.max(0, Math.min(1, alpha));
      ctx.save();
      ctx.globalAlpha = alpha;
      var vx = pose.wrist[0], vy = pose.wrist[1];
      var dx = pose.wrist[0] - pose.elbow[0];
      var dy = pose.wrist[1] - pose.elbow[1];
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      line([vx, vy], [vx + 0.13, vy], 'rgba(37,99,235,0.45)', 1.5, [4, 4]);
      line([vx, vy], [vx + dx / len * 0.13, vy + dy / len * 0.13], 'rgba(37,99,235,0.7)', 1.5, [4, 4]);
      var ang = Math.atan2(-dy, dx);
      if (ang > 0.05) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(37,99,235,0.85)';
        ctx.lineWidth = 1.5;
        ctx.arc(sx(vx), sy(vy), sy(0.055), 0, -ang, true);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.fillStyle = '#9dc0ff';
      ctx.font = '600 12px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillText('出手角', sx(vx) + 8, sy(vy) + 20);
      ctx.restore();
    }
  }

  function drawBall(p, pose) {
    var bx, by, r = Math.max(6, sx(0.016));
    if (p < RELEASE_P) {
      bx = pose.wrist[0] + 0.022;
      by = pose.wrist[1] - 0.030;
    } else {
      var k = (p - RELEASE_P) / (1 - RELEASE_P);
      k = Math.min(1, k * 0.72);
      var x0 = 0.595, y0 = 0.088, x1 = 0.90, y1 = 0.30;
      bx = x0 + (x1 - x0) * k;
      by = y0 + (y1 - y0) * k * k + 0.075 * Math.sin(Math.PI * k) - 0.075 * k * k;
      ctx.save();
      ctx.globalAlpha = 0.25;
      for (var i = 1; i <= 3; i++) {
        var kk = Math.max(0, k - i * 0.06);
        var tx = x0 + (x1 - x0) * kk;
        var ty = y0 + (y1 - y0) * kk * kk + 0.075 * Math.sin(Math.PI * kk) - 0.075 * kk * kk;
        ctx.beginPath();
        ctx.fillStyle = COLOR;
        ctx.arc(sx(tx), sy(ty), r * (1 - i * 0.18), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.beginPath();
    ctx.fillStyle = '#f97316';
    ctx.arc(sx(bx), sy(by), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(120,53,15,0.6)';
    ctx.lineWidth = 1;
    ctx.arc(sx(bx), sy(by), r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx(bx) - r, sy(by));
    ctx.lineTo(sx(bx) + r, sy(by));
    ctx.moveTo(sx(bx), sy(by) - r);
    ctx.lineTo(sx(bx), sy(by) + r);
    ctx.stroke();
  }

  /* 真实 33 点绘制（MediaPipe 接入） */
  function drawRealFrame(lm) {
    var pairs = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
      [23, 25], [25, 27], [24, 26], [26, 28]];
    ctx.save();
    ctx.strokeStyle = COLOR;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    pairs.forEach(function (p) {
      if (!lm[p[0]] || !lm[p[1]]) return;
      ctx.beginPath();
      ctx.moveTo(sx(lm[p[0]].x), sy(lm[p[0]].y));
      ctx.lineTo(sx(lm[p[1]].x), sy(lm[p[1]].y));
      ctx.stroke();
    });
    ctx.restore();
    [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28].forEach(function (i) {
      if (!lm[i]) return;
      joint([lm[i].x, lm[i].y], '#f97316', 3.5);
    });
  }

  /* 骨骼包：每帧 33 点扁平数组 [x0,y0,x1,y1,...]，比对象数组省 60% 体积 */
  /* 投篮手一侧画实，另一侧淡一点。
     投篮时球会挡住远侧手臂，MediaPipe 有时会把那只手甩到身体外面；
     两条一样粗的线会看成「骨架歪了」，淡一点就自然多了。 */
  var NEAR_PAIRS = [[11, 12], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
  var ARM_R = [[12, 14], [14, 16]];
  var ARM_L = [[11, 13], [13, 15]];
  var JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

  function seg(f, a, b, color, width) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.moveTo(sx(f[a * 2]), sy(f[a * 2 + 1]));
    ctx.lineTo(sx(f[b * 2]), sy(f[b * 2 + 1]));
    ctx.stroke();
  }

  /* 竖屏视频的内容区只有 300px 宽，固定 4.2px 线宽画出来像一坨；
     按内容区宽度缩放，横屏和竖屏看起来才一样细。 */
  function boneScale() {
    return Math.max(0.5, Math.min(1, box.w / 420));
  }

  function drawFlat(f) {
    var near = bundleSide === 'l' ? ARM_L : ARM_R;
    var far = bundleSide === 'l' ? ARM_R : ARM_L;
    var k = boneScale();
    ctx.save();
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 5 * k;
    NEAR_PAIRS.forEach(function (p) { seg(f, p[0], p[1], COLOR, 4.2 * k); });
    near.forEach(function (p) { seg(f, p[0], p[1], COLOR, 4.6 * k); });
    far.forEach(function (p) { seg(f, p[0], p[1], 'rgba(249,115,22,0.42)', 3 * k); });
    ctx.restore();
    var farJ = (bundleSide === 'l' ? [14, 16] : [13, 15]);
    JOINTS.forEach(function (i) {
      var isFar = farJ.indexOf(i) >= 0;
      joint([f[i * 2], f[i * 2 + 1]], isFar ? 'rgba(249,115,22,0.45)' : COLOR,
        (isFar ? 2.6 : 3.6) * k);
    });
  }

  function render(t, videoHasFrame) {
    lastT = t;
    lastShow = videoHasFrame;
    if (!w) resize();
    paint();
  }

  /* 外部绘制钩子：标准火柴人模板要在同一块画布、同一套坐标里叠加，
     自己再开一块 canvas 一定会错位。 */
  var extraDraw = null;

  function paint() {
    if (!ctx || !w) return;
    computeBox();
    ctx.clearRect(0, 0, w, h);
    if (window.__boxDebug) {
      ctx.save();
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
      ctx.restore();
    }
    if (!lastShow) return;
    if (idle) return;

    /* 实验模式优先：有真实骨骼包就直接画，不再画示意场地/球 */
    if (bundle && bundle.length) {
      var i = Math.round(lastT * bundleFps);
      i = Math.max(0, Math.min(bundle.length - 1, i));
      drawFlat(bundle[i]);
      if (extraDraw) extraDraw(ctx, box, bundle[i], bundleSide, lastT);
      return;
    }

    drawCourt();
    if (realFrame) {
      drawRealFrame(realFrame);
      return;
    }
    var cycle = BB.data.cycle;
    var p = (lastT % cycle) / cycle;
    var pose = poseAt(p);
    drawSkeleton(pose, p);
    drawBall(p, pose);
  }

  BB.Overlay = {
    mount: function (canvasEl) {
      cv = canvasEl;
      ctx = cv.getContext('2d');
      resize();
      window.addEventListener('resize', resize);
      if (window.ResizeObserver) new ResizeObserver(resize).observe(cv);
    },
    render: render,
    resize: resize,
    clientToNorm: clientToNorm,
    setFrame: function (landmarks) { realFrame = landmarks || null; },
    /* 挂载整段骨骼包（离线提取），之后渲染按时间自动取帧 */
    setBundle: function (b, fps, side) {
      bundle = (b && b.pts) ? b.pts : null;
      bundleFps = fps || 30;
      bundleSide = side === 'l' ? 'l' : 'r';
      paint();
    },
    clearBundle: function () { bundle = null; vidAspect = 0; paint(); },
    /* 空闲态开关：没挂骨骼就不画任何东西 */
    setIdle: function (v) { idle = !!v; paint(); },
    isIdle: function () { return idle; },
    /* 传入视频宽高比，骨骼才会落在实际画面里而不是整块画布上 */
    setVideoAspect: function (a) { vidAspect = a || 0; paint(); },
    hasBundle: function () { return !!bundle; },
    /* 叠加绘制回调：签名 (ctx, box, 当前帧骨骼, 投篮手侧) */
    onDraw: function (fn) { extraDraw = fn || null; paint(); },
    clear: function () { realFrame = null; bundle = null; if (ctx) ctx.clearRect(0, 0, w, h); }
  };
})(window.BB);
