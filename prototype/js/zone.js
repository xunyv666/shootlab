/* ============================================================
 * zone.js — 点位打法 / 打板角度 / 进球概率
 *
 * 三件事放在一起，因为它们回答的是同一个问题：
 *   「在这个位置、用这个姿势，这球该进吗？」
 *
 * 1) 点位地图：从篮下到底角，每个点该打板还是空心、为什么
 * 2) 打板角度：入射角 ≈ 反射角，越正对篮板越稳，掠射角最不可靠
 * 3) 进球概率：先按物理算「这个出手角能不能进」，再按姿势修正
 *
 * 概率是模型估计，不是统计命中率。用户标了结果之后
 * 会用逻辑回归校准（progress.js），界面上永远把这两件事分开写。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var G = 9.81;
  var HOOP_H = 3.05;        // 篮筐高
  var HOOP_R = 0.225;       // 篮圈半径
  var BOARD_OFF = 0.375;    // 篮圈中心到篮板面的水平距离（0.15 + 0.225）
  var BOARD_W = 0.59, BOARD_H = 0.45, BOARD_BOTTOM = 3.05;  // 方框：宽高与下沿高度

  /* ---------------- 1. 点位 ----------------
     距离是「到篮筐中心的水平距离」，单位米。
     打板建议不是拍脑袋：入射角 tan = 水平距离 / 竖直落差，
     正对篮板（0°）入射角最大、反弹最可控；底角几乎掠射，打板后球会横飞。 */
  var SPOTS = [
    {
      id: 'under', name: '篮下', dist: 0.6, ang: 0,
      x: 0, y: 0.6,
      way: '打板 + 高抛',
      aim: '方框上沿偏右',
      why: '正面、距离近，入射角很大（球几乎是「砸」向篮板再落下），容错最高。',
      key: '手腕送到方框上沿，别平推；球下落时几乎垂直入筐。',
      grade: 'A'
    },
    {
      id: 'short45', name: '近距 45°', dist: 1.6, ang: 45,
      x: 1.05, y: 1.05,
      way: '打板',
      aim: '方框上角',
      why: '45° 是打板的黄金角：入射角和反射角都接近 45°，反弹后正好落进球心。',
      key: '瞄方框上角，不是篮板中心。打中心多半会弹到筐前沿。',
      grade: 'A'
    },
    {
      id: 'mid45', name: '中距 45°', dist: 4.0, ang: 45,
      x: 2.83, y: 2.83,
      way: '打板 / 空心都行',
      aim: '方框上角（打板）· 后沿（空心）',
      why: '这个距离打板和空心的难度接近。打板的容错在于篮板会「吃掉」力量误差。',
      key: '想稳就擦板，想练手感就空心。比赛里落后要抢时间，选空心少一次反弹。',
      grade: 'A-'
    },
    {
      id: 'ft', name: '罚球线', dist: 4.6, ang: 0,
      x: 0, y: 4.6,
      way: '空心为主',
      aim: '篮筐后沿',
      why: '正对篮筐、距离固定，打板会多引入一次反弹误差，反而不如直接进。',
      key: '瞄准点放后沿，让球从前沿落进去；弧度按你的出手点算（见指标卡）。',
      grade: 'B+'
    },
    {
      id: 'top3', name: '弧顶三分', dist: 6.75, ang: 0,
      x: 0, y: 6.75,
      way: '空心',
      aim: '篮筐后沿',
      why: '距离远、入射角小，打板需要更大力量并且反弹后的落点极难控制。',
      key: '必须靠下肢发力，出手角比两分高 2–3°；力量从地面来，不是手臂硬推。',
      grade: 'B'
    },
    {
      id: 'corner', name: '底角三分', dist: 6.6, ang: 72,
      x: 6.55, y: 0.4,
      way: '空心（不要打板）',
      aim: '篮筐后沿',
      why: '底角几乎是掠射篮板，入射角很小，打板后球会沿篮板横向飞走 —— 这是最容易被误导的点。',
      key: '底角只能空心。出手角要抬够，因为水平距离远、出手点相对低。',
      grade: 'C+'
    }
  ];

  /* ---------------- 2. 打板入射角 ----------------
     篮板是竖直平面，法线水平指向球场。真正决定打板成不成的，
     是球路在【水平面】里与法线的夹角：
       正面（x≈0）     → 0°，几乎垂直撞板，反弹后原路回来，最可控
       45° 侧翼        → 约 40°，反弹后偏出去，要用方框上角来补
       底角（贴着边线）→ 80° 以上，几乎是擦着篮板飞过去，打板会横向弹走
     （之前按「球路与竖直方向的夹角」算，中距 45° 得到 75°，
       结论正好反了 —— 那个角大反而说明球是砸下来的。） */
  function boardAngle(spot, releaseH) {
    var across = spot.x;                    // 横向偏移（离篮筐正面的距离）
    var front = spot.y + BOARD_OFF;         // 到篮板面的前后距离
    if (front <= 0.02) return null;
    return Math.atan2(Math.abs(across), front) * 180 / Math.PI;
  }

  /* ---------------- 3. 进球概率（物理部分） ----------------
     给定出手角、出手点高度、水平距离，反解「要投进需要多快」。
     投不进的两种物理原因：
       a) 角度太平，无论多快都到不了篮筐高度（分母 <= 0）
       b) 需要的速度离谱（> 16 m/s），说明这个姿势根本发不出这个力
     然后算入筐角：越平，篮筐的「有效开口」越小。 */
  function physics(angleDeg, releaseH, dist) {
    var th = angleDeg * Math.PI / 180;
    var h0 = releaseH;
    var d = dist;
    var den = Math.cos(th) * Math.cos(th) * 2 * (h0 + d * Math.tan(th) - HOOP_H);
    if (den <= 0) {
      return { ok: false, why: '角度太平，这个出手角到不了篮筐高度', score: 0, v: null, entry: null };
    }
    var v2 = G * d * d / den;
    if (!isFinite(v2) || v2 <= 0) {
      return { ok: false, why: '算不出合理的出手速度', score: 0, v: null, entry: null };
    }
    var v = Math.sqrt(v2);
    var vx = v * Math.cos(th);
    var vy = v * Math.sin(th) - G * (d / vx);
    var entry = Math.atan2(-vy, vx) * 180 / Math.PI;   // 入筐时的下倾角

    /* 入筐角只看「够不够陡」。40° 以上是舒服的，25° 以下容错很差。 */
    var eScore = clamp((entry - 20) / 25, 0, 1);

    /* 速度合理性：11–13 m/s 是成年男性正常三分出手的量级 */
    var vScore = v < 7 ? 0.55 : v > 16 ? clamp(1 - (v - 16) / 4, 0, 0.5) : 1;

    return {
      ok: true,
      v: Math.round(v * 10) / 10,
      entry: Math.round(entry * 10) / 10,
      score: eScore * 0.72 + vScore * 0.28,
      why: entry < 30 ? '入筐角只有 ' + Math.round(entry) + '°，弧度偏平，容错小'
        : entry > 55 ? '入筐角 ' + Math.round(entry) + '°，弧度偏陡，需要更多力'
          : '入筐角 ' + Math.round(entry) + '°，是舒服的范围'
    };
  }

  /* ---------------- 4. 姿势部分 ----------------
     八项指标里，真正影响「进不进」的是这几项；
     其余（比如躯干角度）影响的是稳定性，短时间不改命中率，不该硬算进去。 */
  var POSE_W = {
    elbowAngle: 0.34,
    releaseHeight: 0.28,
    releaseAngle: 0.22,
    followHold: 0.10,
    jumpHeight: 0.06
  };

  function poseScore(raw) {
    var D = BB.data && BB.data.DIMS;
    if (!D) return { score: 0.5, parts: [] };
    var parts = [], sum = 0, wsum = 0;
    Object.keys(POSE_W).forEach(function (k) {
      var dim = null;
      for (var i = 0; i < D.length; i++) if (D[i].key === k) dim = D[i];
      if (!dim) return;
      var val = BB.metrics && BB.metrics.dimValue ? BB.metrics.dimValue(dim, raw) : raw[dim.raw];
      var ideal = BB.metrics && BB.metrics.dimIdeal ? BB.metrics.dimIdeal(dim, raw) : dim.ideal;
      if (val == null) return;
      /* 落在区间里给 1，偏离一个 tol 掉到 0.5，两个 tol 归零 */
      var mid = (ideal[0] + ideal[1]) / 2;
      var tol = Math.max(1e-6, dim.tol || (ideal[1] - ideal[0]) / 2);
      var dev = Math.abs(val - mid) / tol;
      var s = clamp(1 - dev * 0.5, 0, 1);
      var w = POSE_W[k];
      sum += s * w; wsum += w;
      parts.push({ k: k, name: dim.name, dev: dev, s: s });
    });
    return { score: wsum ? sum / wsum : 0.5, parts: parts };
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  /* ---------------- 5. 合起来 ---------------- */
  /**
   * @param raw    一次出手的原始指标
   * @param opt    { dist 米，不传按罚球线 4.6 }
   * @returns { p, phys, pose, factors[] }
   */
  function predict(raw, opt) {
    opt = opt || {};
    var dist = opt.dist || (BB.data && BB.data.RAW_DIST) || 4.6;
    var H = raw && raw.heightCm ? raw.heightCm : 178;
    var relH = raw && raw.releaseHeight != null ? raw.releaseHeight / 100 : 2.2;
    var ang = raw && raw.releaseAngle != null ? raw.releaseAngle : null;

    var phys = ang == null
      ? { ok: false, score: 0.5, why: '没测到出手角，物理部分按中性算' }
      : physics(ang, relH, dist);

    var pose = poseScore(raw);

    /* 物理占六成：出手角是唯一有严格物理依据的一项。
       姿势占四成：它决定「能不能重复」，但单次进不进主要看球路。

       但「没测到出手角」时物理分是个恒定的 0.5 —— 再让它占 60% 权重，
       等于把预测硬压回 50%，九次出手全挤在 41–53% 之间，排序毫无意义。
       没有球路的时候就把权重全交给姿势，同时如实标低置信：
       这时候给的不是「进不进」的概率，是「这套动作本身有多像能进」的分。 */
    var scored = ang != null && phys.ok;
    var wz = scored ? 0.4 : 1.0;
    var wp = 1 - wz;
    var z = (phys.score - 0.5) * 2.6 * wp + (pose.score - 0.5) * 2.6 * wz;
    var p0 = sigmoid(z * 0.85);

    /* 只有姿势分时信息量确实少，往 50% 拉一点，但别拉到没有区分度 */
    var conf = scored ? 1 : (ang == null ? 0.72 : 0.8);
    p0 = 0.5 + (p0 - 0.5) * conf;

    var factors = [];
    if (ang != null) {
      factors.push({ t: phys.ok ? phys.why : phys.why, good: phys.ok && phys.score > 0.62 });
    } else {
      factors.push({ t: '出手角没测到 —— 这条是最大的不确定来源', good: false });
    }
    pose.parts.sort(function (a, b) { return b.dev - a.dev; });
    if (pose.parts.length) {
      var worst = pose.parts[0];
      factors.push({
        t: worst.dev < 0.9
          ? '影响命中的几项姿势都在窗口里'
          : worst.name + ' 偏离目标 ' + worst.dev.toFixed(1) + ' 倍容差，是姿势里最拖后腿的一项',
        good: worst.dev < 0.9
      });
    }

    return {
      p: p0,
      dist: dist,
      conf: conf,
      phys: phys,
      pose: pose,
      factors: factors
    };
  }

  /* ---------------- 6. 渲染点位卡 ---------------- */
  var BOARD_W_M = 15, BOARD_D_M = 14;   // 半场 15m 宽、14m 深（含篮下延伸）
  var PAD = 26;

  function svgMap() {
    /* 俯视图：篮筐在底部中间。真实比例，方便判断角度 */
    var W = 300, H = 250;
    var sx = function (x) { return PAD + x / BOARD_W_M * (W - PAD * 2); };
    var sy = function (y) { return H - PAD - y / BOARD_D_M * (H - PAD * 2); };
    var cx = BOARD_W_M / 2;

    var r3 = 6.75 / BOARD_W_M * (W - PAD * 2);
    var parts = [];
    parts.push('<svg viewBox="0 0 ' + W + ' ' + H + '" class="zone-map">');
    parts.push('<defs><linearGradient id="zg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#faf3e8"/><stop offset="1" stop-color="#f3e7d5"/></linearGradient></defs>');
    parts.push('<rect x="' + sx(0) + '" y="' + sy(BOARD_D_M) + '" width="' + (sx(BOARD_W_M) - sx(0)) +
      '" height="' + (sy(0) - sy(BOARD_D_M)) + '" fill="url(#zg)" stroke="#d8c4a4" stroke-width="1.5" rx="3"/>');
    /* 三分线：两侧直线 + 中间弧 */
    var baseL = sx(0.9), baseR = sx(BOARD_W_M - 0.9);
    var hoopY = sy(1.575);
    parts.push('<path d="M' + baseL + ' ' + sy(0) + ' L' + baseL + ' ' + (hoopY - r3) +
      ' A' + r3 + ' ' + r3 + ' 0 0 0 ' + baseR + ' ' + (hoopY - r3) +
      ' L' + baseR + ' ' + sy(0) + '" fill="none" stroke="#c9a06a" stroke-width="1.8"/>');
    /* 罚球圈 */
    var ftR = 1.8 / BOARD_W_M * (W - PAD * 2);
    parts.push('<circle cx="' + sx(cx) + '" cy="' + sy(4.6) + '" r="' + ftR +
      '" fill="none" stroke="#c9a06a" stroke-width="1.2" stroke-dasharray="4 3"/>');
    /* 篮板 + 篮筐 */
    parts.push('<rect x="' + (sx(cx) - 9) + '" y="' + (sy(1.2) - 3) + '" width="18" height="4" fill="#8a6a45" rx="1"/>');
    parts.push('<circle cx="' + sx(cx) + '" cy="' + hoopY + '" r="5.5" fill="none" stroke="#ea580c" stroke-width="2"/>');

    SPOTS.forEach(function (s, i) {
      /* 点位表的 x/y 是「从篮筐起算的偏移」，换算成场地坐标再画 */
      var px = sx(cx + s.x);
      var py = sy(1.575 + s.y);
      parts.push('<g class="zone-dot" data-spot="' + s.id + '">' +
        '<circle cx="' + px + '" cy="' + py + '" r="11" fill="#fff" stroke="#f97316" stroke-width="2"/>' +
        '<text x="' + px + '" y="' + (py + 4) + '" text-anchor="middle" font-size="11" font-weight="700" fill="#c2410c">' +
        (i + 1) + '</text></g>');
    });
    parts.push('</svg>');
    return parts.join('');
  }

  function renderSpot(spot, releaseH) {
    if (!spot) return '';
    var inc = boardAngle(spot, releaseH);
    var incTxt = inc == null ? '' :
      '<div class="zc-inc"><b>入射角 ' + inc.toFixed(0) + '°</b>' +
      (inc <= 20 ? ' 正对篮板，反弹原路回来，最可控'
        : inc <= 48 ? ' 偏斜，要用方框上角把反弹方向「校」回来'
          : ' 接近掠射，打板后会横向弹走 —— 这个点别打板') +
      '</div>';
    return '<div class="zc-detail">' +
      '<div class="zc-head"><b>' + spot.name + '</b><span class="zc-grade g' + spot.grade.replace(/[^A-Z]/g, '') + '">' + spot.grade + '</span></div>' +
      '<div class="zc-row"><span>距离</span><b>' + spot.dist.toFixed(1) + ' m</b></div>' +
      '<div class="zc-row"><span>打不打板</span><b>' + spot.way + '</b></div>' +
      '<div class="zc-row"><span>瞄准</span><b>' + spot.aim + '</b></div>' +
      incTxt +
      '<p class="zc-why">' + spot.why + '</p>' +
      '<p class="zc-key">' + spot.key + '</p>' +
      '</div>';
  }

  function renderCard(el, releaseH) {
    if (!el) return;
    el.innerHTML =
      '<div class="card-head"><h2>点位与打板</h2><span class="sub">点一下位置，看该怎么投</span></div>' +
      '<div class="zone-body">' +
        '<div class="zone-left">' + svgMap() +
          '<p class="zone-tip">俯视图 · 尺寸按 FIBA 标准（三分 6.75m、罚球线 4.6m）</p>' +
        '</div>' +
        '<div class="zone-right" id="zoneDetail">' + renderSpot(SPOTS[1], releaseH) + '</div>' +
      '</div>';

    var detail = el.querySelector('#zoneDetail');
    el.querySelectorAll('.zone-dot').forEach(function (g) {
      g.addEventListener('click', function () {
        el.querySelectorAll('.zone-dot').forEach(function (x) { x.classList.remove('on'); });
        g.classList.add('on');
        var id = g.getAttribute('data-spot');
        var s = SPOTS.filter(function (k) { return k.id === id; })[0];
        detail.innerHTML = renderSpot(s, releaseH);
      });
    });
    var first = el.querySelector('.zone-dot[data-spot="short45"]');
    if (first) first.classList.add('on');
  }

  BB.Zone = {
    SPOTS: SPOTS,
    predict: predict,
    physics: physics,
    boardAngle: boardAngle,
    renderCard: renderCard,
    /* 距离档位：让用户明确「这一球是在哪投的」，概率才有前提 */
    DISTS: [
      { key: 'under', name: '篮下', d: 0.9 },
      { key: 'mid', name: '中距离', d: 4.2 },
      { key: 'ft', name: '罚球线', d: 4.6 },
      { key: 'three', name: '三分线', d: 6.75 }
    ]
  };
})(window.BB);
