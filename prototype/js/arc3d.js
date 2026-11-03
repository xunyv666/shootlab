/* ============================================================
 * arc3d.js — 3D 出手轨迹
 *
 * 画的是一条**推算**弹道，不是跟拍到的球：
 *   出手点（身高算出的出手高度）+ 出手角 + 出手距离
 *   → 解出初速度 → 抛物线
 * 公式与「进球概率」用的是同一套（BB.Zone.physics），不另起一套，
 * 否则两个卡片会自相矛盾。
 *
 * 为什么不画实测轨迹：球在这批素材里几乎跟不住（见 MEMORY 里那九段
 * 素材的记录），硬画一条连不上的线就是编数据。所以图上一律标「推算」。
 *
 * 渲染是手写的透视投影，不引 three.js（那要 600KB，占比太大）。
 * ============================================================ */
(function (BB) {
  'use strict';

  var G = 9.8;
  var RIM_H = 3.05;          // 篮筐高度
  var RIM_R = 0.225;         // 篮筐半径
  var BOARD_BACK = 0.375;    // 篮板在筐心后方多远

  var card = null, cv = null, ctx = null;
  var W = 0, H = 0, DPR = 1;
  var model = null;          // 当前这一球的几何数据
  var ghosts = [];           // 同一段视频里其它能解出轨迹的球（淡色对比）
  var lastDist = 4.6;        // 空态时也要按当前距离档位画地面
  var drag = null;

  /* 视角：绕竖轴转 yaw，俯仰 pitch。默认三分之四视角，能看出弧线高度 */
  var VIEWS = {
    iso: { yaw: -0.95, pitch: 0.22 },
    side: { yaw: 0, pitch: 0.06 },
    top: { yaw: -0.95, pitch: 1.02 }
  };
  var view = { yaw: VIEWS.iso.yaw, pitch: VIEWS.iso.pitch };
  var viewName = 'iso';

  /* ---------- 投影 ----------
     先按「焦距 = 1」投一次，再把所有关键点的包围盒缩放铺满画布。
     比手调焦距稳，换距离档位也不用改常数。 */
  function projectUnit(p, cam) {
    var x = p[0] - cam.tx, y = p[1] - cam.ty, z = p[2] - cam.tz;
    var cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
    var x1 = x * cy + z * sy;
    var z1 = -x * sy + z * cy;
    var cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    var y1 = y * cp - z1 * sp;
    var z2 = y * sp + z1 * cp;
    var depth = Math.max(0.4, z2 + cam.r);
    return { x: x1 / depth, y: -y1 / depth, depth: depth };
  }

  function makeCamera(d, relH) {
    return {
      tx: d * 0.5,
      ty: Math.max(1.7, relH * 0.75),
      tz: 0,
      r: d * 1.15 + 4.2      // 相机离场景中心的距离，跟着距离档位走
    };
  }

  /* 把一组世界点铺满画布 */
  function fitAndMake(cam, pts) {
    var pad = 16;
    var minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (var i = 0; i < pts.length; i++) {
      var u = projectUnit(pts[i], cam);
      if (u.x < minx) minx = u.x;
      if (u.x > maxx) maxx = u.x;
      if (u.y < miny) miny = u.y;
      if (u.y > maxy) maxy = u.y;
    }
    var bw = Math.max(1e-6, maxx - minx), bh = Math.max(1e-6, maxy - miny);
    var s = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh);
    var ox = (W - bw * s) / 2 - minx * s;
    var oy = (H - bh * s) / 2 - miny * s;
    return function (p) {
      var u = projectUnit(p, cam);
      return { x: u.x * s + ox, y: u.y * s + oy, depth: u.depth };
    };
  }

  /* ---------- 弹道 ---------- */
  function solve(sh, dist) {
    var raw = (sh && sh.raw) || {};
    var relH = raw.releaseHeight != null ? raw.releaseHeight / 100 : 2.2;
    var ang = raw.releaseAngle;
    if (ang == null) return { ok: false, relH: relH, d: dist };
    var ph = BB.Zone && BB.Zone.physics ? BB.Zone.physics(ang, relH, dist)
      : { ok: false };
    if (!ph.ok) return { ok: false, relH: relH, d: dist, why: ph.why };

    var th = ang * Math.PI / 180;
    var vx = ph.v * Math.cos(th), vy = ph.v * Math.sin(th);
    var tHit = dist / vx;                       // 到筐心的时刻
    var tApex = vy / G;
    var apexY = relH + vy * vy / (2 * G);
    var apexX = vx * tApex;

    /* 只在「出手 → 到筐」之间采样，筐后落地的部分不画，看着乱 */
    var pts = [];
    var N = 64;
    for (var i = 0; i <= N; i++) {
      var t = tHit * i / N;
      pts.push([vx * t, relH + vy * t - 0.5 * G * t * t, 0]);
    }
    return {
      ok: true, d: dist, relH: relH, ang: ang, v: ph.v, entry: ph.entry,
      x0: 0, y0: relH, apexY: apexY, apexX: apexX,
      apexAboveRim: apexY - RIM_H, pts: pts
    };
  }

  /* ---------- 绘制 ---------- */
  function line(a, b, color, w, dash) {
    ctx.beginPath();
    ctx.setLineDash(dash || []);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = w || 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function label(txt, x, y, color, align, size) {
    ctx.font = '500 ' + (size || 11) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    /* 先描一圈白边，标签压在曲线或网格上也能读清 */
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,.92)';
    ctx.lineJoin = 'round';
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = color;
    ctx.fillText(txt, x, y);
  }

  function drawGhosts(P) {
    for (var i = 0; i < ghosts.length; i++) {
      var gp = ghosts[i].pts;
      ctx.beginPath();
      for (var j = 0; j < gp.length; j++) {
        var q = P(gp[j]);
        j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      }
      ctx.strokeStyle = 'rgba(234,88,12,.16)';
      ctx.lineWidth = 1.1;
      ctx.stroke();
    }
  }

  function drawGround(P, m) {
    var d = m ? m.d : 6.75;
    var zr = Math.max(2.4, d * 0.6);
    var i, k;
    /* 横向网格：沿投篮方向每条 1 米 */
    for (i = 0; i <= Math.ceil(d); i++) {
      var x = Math.min(i, d);
      line(P([x, 0, -zr]), P([x, 0, zr]), x === 0 || Math.abs(x - d) < 1e-6 ? '#bcc6d4' : '#e3e8ef', 1);
    }
    /* 纵向两条边 */
    for (k = -1; k <= 1; k += 2) {
      line(P([0, 0, zr * k]), P([d, 0, zr * k]), '#dde3ec', 1);
    }
    /* 地面上那条「投篮距离」 */
    line(P([0, 0, 0]), P([d, 0, 0]), '#e2e8f0', 1, [5, 5]);
  }

  function drawHoop(P, m) {
    var d = m ? m.d : 6.75;
    var xb = d + BOARD_BACK;
    /* 立柱 */
    line(P([xb, 0, 0]), P([xb, RIM_H - 0.05, 0]), '#cbd5e1', 2);
    /* 篮板四角 */
    var corners = [[xb, RIM_H - 0.15, -0.9], [xb, RIM_H - 0.15, 0.9],
                   [xb, RIM_H + 0.9, 0.9], [xb, RIM_H + 0.9, -0.9]];
    ctx.beginPath();
    ctx.moveTo(P(corners[0]).x, P(corners[0]).y);
    for (var i = 1; i < 4; i++) {
      var q = P(corners[i]); ctx.lineTo(q.x, q.y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(203,213,225,.22)';
    ctx.fill();
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    /* 筐：水平面上的圆 */
    ctx.beginPath();
    for (var k = 0; k <= 28; k++) {
      var a = k / 28 * Math.PI * 2;
      var p = P([d + Math.cos(a) * RIM_R, RIM_H, Math.sin(a) * RIM_R]);
      k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    }
    ctx.strokeStyle = '#ea580c';
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }

  function draw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    var m = model && model.ok ? model : null;
    var d = m ? m.d : (lastDist || 4.6);
    var relH = m ? m.relH : 2.05;

    var cam = makeCamera(d, relH);
    /* 让包围盒把篮筐和地面也算进去，否则弧线会顶满、筐被切掉 */
    var key = m ? m.pts.slice() : [];
    /* 其它出手也要进包围盒，否则会画到画布外面去 */
    for (var gi = 0; gi < ghosts.length; gi++) key = key.concat(ghosts[gi].pts);
    var zr = Math.max(2.4, d * 0.6);
    key.push([0, 0, -zr], [0, 0, zr], [d, 0, -zr], [d, 0, zr],
             [d + BOARD_BACK, RIM_H + 0.9, 0]);
    if (!m) key.push([0, relH, 0]);
    var P = fitAndMake(cam, key);

    drawGround(P, { d: d });
    drawHoop(P, { d: d });

    /* 同一段视频里其它能解出的出手：淡色铺在后面。
       单看一条线看不出「这 20 球稳不稳」，叠起来一眼就知道散不散。
       当前这一球没角度时也要画 —— 否则一张空旷的图上写着「10 次出手」，
       却一条线都看不到。 */
    drawGhosts(P);

    if (!m) { drawEmpty(P, d); return; }

    /* 弧线在地面上的影子：没有它，3D 空间感很差 */
    ctx.beginPath();
    for (var i = 0; i < m.pts.length; i++) {
      var sp = P([m.pts[i][0], 0, 0]);
      i ? ctx.lineTo(sp.x, sp.y) : ctx.moveTo(sp.x, sp.y);
    }
    ctx.strokeStyle = '#f1f5f9';
    ctx.lineWidth = 3;
    ctx.stroke();

    /* 弹道 */
    ctx.beginPath();
    for (var j = 0; j < m.pts.length; j++) {
      var q = P(m.pts[j]);
      j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
    }
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.stroke();

    /* 出手点：竖线表示「出手高度」 */
    var base = P([0, 0, 0]), rel = P([0, m.relH, 0]);
    line(base, rel, '#cbd5e1', 1, [3, 3]);
    ctx.beginPath();
    ctx.arc(rel.x, rel.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#f97316';
    ctx.fill();
    label(m.relH.toFixed(2) + ' m', rel.x - 8, rel.y - 9, '#ea580c', 'right');

    /* 最高点 */
    var apex = P([m.apexX, m.apexY, 0]);
    ctx.beginPath();
    ctx.arc(apex.x, apex.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#fdba74';
    ctx.fill();
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 1;
    ctx.stroke();
    label('最高 ' + m.apexY.toFixed(2) + ' m', apex.x, apex.y - 12, '#c2410c');

    /* 距离标尺 */
    var g0 = P([0, 0, 0]), g1 = P([m.d, 0, 0]);
    label(m.d.toFixed(1) + ' m', (g0.x + g1.x) / 2, (g0.y + g1.y) / 2 + 13, '#94a3b8');
    var rimP = P([m.d, RIM_H, 0]);
    var bdP = P([m.d + BOARD_BACK, RIM_H, 0]);
    label('筐高 3.05 m', Math.max(rimP.x, bdP.x) + 14, bdP.y, '#94a3b8', 'left');
  }

  function drawEmpty(P, d) {
    /* 场景照画（地面+篮筐），只缺那条线 —— 全白一片会让人以为图没加载出来。
       提示做成一条带底色的条，压在任何东西上都能读。 */
    var t1 = '这一次出手没有出手角，画不出这一条';
    var t2 = ghosts.length
      ? '淡色的是其它 ' + ghosts.length + ' 次算得出的出手，可以对比着看'
      : '没有出手角就没有初速度，硬画一条曲线就是编的';
    ctx.font = '500 12px system-ui, -apple-system, "Segoe UI", sans-serif';
    var w1 = ctx.measureText(t1).width;
    ctx.font = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';
    var w2 = ctx.measureText(t2).width;
    var bw = Math.min(W - 24, Math.max(w1, w2) + 34);
    var bh = 52;
    var bx = (W - bw) / 2, by = H * 0.3 - bh / 2;

    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 10);
    else ctx.rect(bx, by, bw, bh);
    ctx.fillStyle = 'rgba(255,255,255,.94)';
    ctx.fill();
    ctx.strokeStyle = '#eef1f6';
    ctx.lineWidth = 1;
    ctx.stroke();

    label(t1, W / 2, by + 19, '#7c8696', 'center', 12);
    label(t2, W / 2, by + 36, '#a9b2c0', 'center', 11);
  }

  /* ---------- DOM ---------- */
  function build() {
    card.innerHTML =
      '<div class="card-head">' +
        '<h2>3D 出手轨迹<span class="arc-tag">推算</span></h2>' +
        '<div class="arc-views">' +
          '<button data-v="iso" class="on">3/4</button>' +
          '<button data-v="side">正侧</button>' +
          '<button data-v="top">俯视</button>' +
        '</div>' +
      '</div>' +
      '<div class="arc-canvas-wrap"><canvas class="arc-canvas"></canvas></div>' +
      '<div class="arc-facts"></div>' +
      '<p class="arc-note"></p>';

    cv = card.querySelector('.arc-canvas');
    ctx = cv.getContext('2d');

    card.querySelectorAll('.arc-views button').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.dataset.v); });
    });
    /* 拖乱了双击回默认视角，比记住上一次姿势更符合直觉 */
    cv.addEventListener('dblclick', function () { setView('iso'); });

    cv.addEventListener('pointerdown', function (e) {
      drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', function (e) {
      if (!drag) return;
      view.yaw = drag.yaw + (e.clientX - drag.x) * 0.008;
      view.pitch = Math.max(-0.05, Math.min(1.15, drag.pitch + (e.clientY - drag.y) * 0.006));
      /* 手一拖就不再是预设视角了，按钮别继续亮着骗人 */
      if (viewName) {
        viewName = null;
        card.querySelectorAll('.arc-views button').forEach(function (b) { b.classList.remove('on'); });
      }
      draw();
    });
    cv.addEventListener('pointerup', function () { drag = null; });
    cv.addEventListener('pointercancel', function () { drag = null; });

    window.addEventListener('resize', resize);
    resize();
  }

  function resize() {
    if (!cv) return;
    var r = cv.parentElement.getBoundingClientRect();
    if (!r.width) return;
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.round(r.width);
    H = Math.round(r.height || 208);
    cv.width = W * DPR;
    cv.height = H * DPR;
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    draw();
  }

  function renderFacts(m) {
    var box = card.querySelector('.arc-facts');
    if (!m || !m.ok) { box.innerHTML = ''; return; }
    var f = [
      ['出手角', m.ang.toFixed(1) + '°'],
      ['初速度', m.v.toFixed(1) + ' m/s'],
      ['最高点', m.apexY.toFixed(2) + ' m'],
      ['入筐角', m.entry.toFixed(0) + '°']
    ];
    box.innerHTML = f.map(function (x) {
      return '<div><span>' + x[0] + '</span><b>' + x[1] + '</b></div>';
    }).join('');
  }

  /* ---------- 对外 ---------- */
  function mount(el) {
    card = el;
    if (!card) return;
    build();
  }

  function setView(name) {
    var v = VIEWS[name] || VIEWS.iso;
    view.yaw = v.yaw;
    view.pitch = v.pitch;
    viewName = name;
    if (card) {
      card.querySelectorAll('.arc-views button').forEach(function (b) {
        b.classList.toggle('on', b.dataset.v === name);
      });
    }
    draw();
  }

  /** @param sh   一次出手 { raw: {...} }
   *  @param dist 出手距离（米），跟着「这一球从哪投的」档位走
   *  @param idx  这一球在 all 里的下标（淡色对比时要把自己排除掉）
   *  @param all  这一段视频的全部出手：能解出轨迹的都画成淡色 */
  function update(sh, dist, idx, all) {
    if (!card) return;
    lastDist = dist;
    model = sh ? solve(sh, dist) : null;

    ghosts = [];
    if (all && all.length > 1) {
      for (var i = 0; i < all.length && ghosts.length < 40; i++) {
        if (i === idx) continue;
        var gm = solve(all[i], dist);
        if (gm.ok) ghosts.push(gm);
      }
    }

    card.hidden = !sh;
    if (!sh) return;
    renderFacts(model);
    var note = card.querySelector('.arc-note');
    if (note) {
      var est = sh.raw && sh.raw.releaseAngleSrc === 'pose';
      var bad = sh.raw && sh.raw.angleUnreliable;
      note.innerHTML = '这条线是按出手角和出手点解出来的抛物线，不是从画面里跟拍到的球。'
        + (ghosts.length ? '后面那些淡色弧线是这一段里其它 <b>' + ghosts.length + '</b> 次出手，叠在一起能看出弧线稳不稳。' : '')
        + (bad ? '<b>机位选的是正面，横向位移基本丢失，这一球的角度不可信，别拿它跟别人比。</b>'
          : (est ? '<b>这一次的出手角本身也是估算的（球没认出来，只能按手腕方向推），误差会顺着传进这条曲线。</b>' : ''))
        + '球的实测轨迹要能连续跟住 0.4 秒以上才算，目前的素材大多做不到。';
    }
    /* 空态时也能画出地面和篮筐，让人知道这是什么视角 */
    resize();
  }

  BB.Arc3D = { mount: mount, update: update };
})(window.BB || (window.BB = {}));
