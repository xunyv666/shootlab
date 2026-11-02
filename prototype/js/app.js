/* ============================================================
 * app.js  —  主控（我 / 整合）
 * 职责：装配各模块、维护全局状态、渲染指标卡与出手记录、
 *       处理时间轴与逐帧联动、弹窗开合。
 * 其他同学只改自己模块文件，本文件只做「接线」。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var D = BB.data;
  var $ = function (id) { return document.getElementById(id); };
  var state = {
    shots: [], starId: D.activeStar, activeShot: null, res: null, exp: null, url: null,
    cursor: null,        // 播放位置落在哪一次出手附近（null = 不在出手附近）
    dist: 4.6,           // 这一球从多远投的（米）：概率模型的前提
    lastRender: -1
  };

  function star() { return D.STARS[state.starId]; }

  /* 缺失值统一显示成「—」：识别不到的东西宁可留空，也不要编一个数 */
  function num(v, dec, unit) {
    if (v == null || isNaN(v)) return '<span class="na">—</span>';
    return v.toFixed(dec) + (unit || '');
  }

  /* ---------------- 球星选择 ---------------- */
  function renderStars() {
    $('starChips').innerHTML = D.STAR_ORDER.map(function (id) {
      var s = D.STARS[id];
      return '<button class="chip' + (id === state.starId ? ' active' : '') + '" data-star="' + id + '">' +
        '<b>' + s.name + '</b><span>' + s.tag + '</span></button>';
    }).join('');
    $('starChips').querySelectorAll('.chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.starId = btn.dataset.star;
        renderStars();
        updateAll();
      });
    });
  }

  /* ---------------- 指标卡 ----------------
     卡片上同时给两个数：绝对值（厘米，直观）和比值（÷身高，可比）。
     只给厘米的话，180cm 的人和 208cm 的人没法对话；
     只给比值的话，看不出"我跳了多高"。 */
  function renderMetrics() {
    var avg = state.res.avg;
    var st = star();
    /* 游标落在某次出手上时，卡片显示「那一次」的实测值；
       否则显示这段视频的平均值。两套数字不能混在一张卡里还叫同一个名字。 */
    var live = state.cursor != null ? state.shots[state.cursor] : null;
    var src = live ? live.raw : avg.raw;
    var userRadar = live ? BB.metrics.radarOf(live.raw) : avg.radar;
    var starRadar = BB.metrics.radarOf(st.raw);

    $('metrics').innerHTML = D.CARD_KEYS.map(function (key) {
      var dim = D.DIMS.filter(function (d) { return d.key === key; })[0];
      var isRatio = !!dim.ratio;
      var rawUma = src[dim.raw];
      var u = BB.metrics.dimValue(dim, src);              // 参与比较的值
      var s = BB.metrics.dimValue(dim, st.raw);
      var ideal = BB.metrics.dimIdeal(dim, src);
      var gapScore = userRadar[key] - starRadar[key];
      var cls = gapScore < -8 ? 'neg' : (gapScore < 0 ? 'mid' : 'pos');

      if (u == null) {
        return '<div class="metric is-empty' + (live ? ' is-live' : '') + '">' +
          '<div class="m-top"><span class="m-name">' + dim.name + '</span></div>' +
          '<div class="m-val na">—</div>' +
          '<div class="m-sub">' + (live ? '这一次没测到' : '本段视频没测到') + '</div>' +
          '<div class="m-bar"><i style="width:0%"></i></div>' +
        '</div>';
      }

      var dec = isRatio ? 2 : (dim.key === 'tempo' ? 2 : (Math.abs(u) < 100 ? 1 : 0));
      var diff = u - s;
      var mainVal = isRatio ? (rawUma == null ? null : rawUma) : u;
      var mainUnit = isRatio ? 'cm' : dim.unit;

      var sub;
      if (isRatio) {
        sub = u.toFixed(2) + '×身高 · 目标 ' + ideal[0].toFixed(2) + '–' + ideal[1].toFixed(2);
      } else if (dim.dynamic === 'brancazio') {
        sub = '目标 ' + ideal[0].toFixed(1) + '–' + ideal[1].toFixed(1) + dim.unit + ' · 按出手点算';
      } else {
        sub = '目标 ' + ideal[0] + '–' + ideal[1] + dim.unit;
      }
      /* 波动值塞进副行会让它太长被截断，挂到 title 上，鼠标停一下能看到 */
      var sd = (!live && avg.rawSd) ? avg.rawSd[dim.raw] : 0;
      if (sd == null) sd = 0;      // 只测到一次时没有标准差，别让它变成 null.toFixed
      var tip = sd
        ? '多次出手波动 ±' + (isRatio ? (sd / (avg.raw.heightCm || 1)).toFixed(2) : sd.toFixed(dec))
        : '';

      return '<div class="metric' + (live ? ' is-live' : '') + '"' +
        (tip ? ' title="' + tip + '"' : '') + '>' +
        '<div class="m-top">' +
          '<span class="m-name">' + dim.name + '</span>' +
          '<span class="m-delta ' + cls + '">' + (diff > 0 ? '+' : '') +
            (s == null ? '—' : diff.toFixed(dec) + (isRatio ? '×' : dim.unit)) + '</span>' +
        '</div>' +
        '<div class="m-val">' + (mainVal == null ? '—' : mainVal.toFixed(isRatio ? 0 : dec)) +
          '<small>' + mainUnit + '</small></div>' +
        '<div class="m-sub">' + sub + '</div>' +
        '<div class="m-bar"><i style="width:' + userRadar[key] + '%"></i></div>' +
      '</div>';
    }).join('');
  }

  /* ---------------- 进球概率 ---------------- */
  var DISTS = [
    { name: '篮下', d: 0.9 }, { name: '中距', d: 4.2 },
    { name: '罚球线', d: 4.6 }, { name: '三分', d: 6.75 }
  ];

  function renderProb() {
    var card = $('probCard');
    if (!card) return;
    if (!state.shots.length || !BB.Zone) { card.hidden = true; return; }
    card.hidden = false;

    var idx = state.cursor != null ? state.cursor : (state.activeShot != null ? state.activeShot : 0);
    var sh = state.shots[idx] || state.shots[0];
    var pr = BB.Zone.predict(sh.raw, { dist: state.dist });
    var p = BB.Progress ? BB.Progress.apply(pr.p) : pr.p;
    var pct = Math.round(p * 100);
    var col = pct >= 58 ? '#16a34a' : pct >= 34 ? '#f97316' : '#dc2626';
    var C = 2 * Math.PI * 42;   // 半径 42 的周长

    var facts = pr.factors.map(function (f) {
      return '<div class="prob-fact' + (f.good ? ' good' : '') + '"><i></i><span>' + f.t + '</span></div>';
    }).join('');

    var cal = BB.Progress ? BB.Progress.stats() : { n: 0, note: '' };

    card.innerHTML =
      '<div class="prob-top">' +
        '<div class="prob-dial">' +
          '<svg viewBox="0 0 100 100" width="92" height="92">' +
            '<circle cx="50" cy="50" r="42" fill="none" stroke="#eef1f6" stroke-width="9"/>' +
            '<circle cx="50" cy="50" r="42" fill="none" stroke="' + col + '" stroke-width="9" ' +
              'stroke-linecap="round" stroke-dasharray="' + C.toFixed(1) + '" ' +
              'stroke-dashoffset="' + (C * (1 - p)).toFixed(1) + '"/>' +
          '</svg>' +
          '<div class="num"><b style="color:' + col + '">' + pct + '%</b><span>预计命中</span></div>' +
        '</div>' +
        '<div class="prob-meta">' +
          '<h3>第 ' + (idx + 1) + ' 次出手 · ' + state.dist.toFixed(1) + ' m' +
            (pr.conf < 0.8 ? '<span class="prob-lowconf">置信度低</span>' : '') + '</h3>' +
          '<p>' + (pr.phys.ok
            ? '按出手角和出手点反推，需要 ' + pr.phys.v + ' m/s 的初速度，' + pr.phys.why + '。'
            : pr.phys.why + '。') + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="prob-facts">' + facts + '</div>' +
      '<div class="prob-foot">' +
        '<span class="lbl">这一球从哪投的</span>' +
        '<div class="prob-dist">' + DISTS.map(function (d) {
          return '<button class="' + (Math.abs(d.d - state.dist) < 0.01 ? 'on' : '') +
            '" data-d="' + d.d + '">' + d.name + '</button>';
        }).join('') + '</div>' +
        '<span class="prob-calib">' + (cal.n ? cal.note : '') +
          (cal.n >= (BB.Progress ? BB.Progress.MIN_LEARN : 6)
            ? '<br>Brier ' + cal.brier.toFixed(2) + ' → ' + cal.brierCal.toFixed(2) + '（越小越准）' : '') +
        '</span>' +
      '</div>';

    card.querySelectorAll('.prob-dist button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.dist = +btn.dataset.d;
        renderProb();
      });
    });
  }

  /* ---------------- 出手记录表 ---------------- */
  function renderTable() {
    var rows = state.shots.map(function (s, i) {
      var r = BB.metrics.radarOf(s.raw);
      var sc = BB.metrics.overall(r);
      var scCls = sc >= 82 ? 'pos' : (sc >= 70 ? 'mid' : 'neg');
      var cls = [
        state.activeShot === i ? 'active' : '',
        state.cursor === i ? 'cursor' : ''
      ].join(' ').trim();
      return '<tr data-idx="' + i + '"' + (cls ? ' class="' + cls + '"' : '') + '>' +
        '<td class="c-idx">' + (i + 1) + '</td>' +
        '<td>' + num(s.raw.releaseAngle, 1, '<span class="u">°</span>') +
          (s.raw.releaseAngleSrc === 'pose'
            ? '<sup class="est-mark" title="球没被识别出来，这个值是按出手瞬间手腕的运动方向估算的，不是球的实测轨迹">估</sup>'
            : '') + '</td>' +
        '<td class="hide-sm">' + num(s.raw.elbowAngle, 0, '<span class="u">°</span>') + '</td>' +
        '<td class="hide-sm">' + num(s.raw.releaseHeight, 0, '<span class="u">cm</span>') + '</td>' +
        '<td class="c-score"><b class="' + scCls + '">' + sc + '</b></td>' +
        '<td>' + (s.made === null || s.made === undefined
          ? '<span class="tag-unknown">—</span>'
          : (s.made ? '<span class="tag-made">命中</span>' : '<span class="tag-miss">未中</span>')) + '</td>' +
      '</tr>';
    }).join('');

    $('shotRows').innerHTML = rows || '<tr><td colspan="6" class="empty-row">还没有出手记录</td></tr>';
    $('tableSub').textContent = state.shots.length
      ? state.shots.length + ' 次出手 · 点击任意一行跳转视频'
      : '选一段视频后自动生成';
    $('shotRows').querySelectorAll('tr[data-idx]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var idx = +tr.dataset.idx;
        state.activeShot = idx;
        BB.VideoPlayer.seek(state.shots[idx].tRel);
        renderTable();
        renderShotTools();
      });
    });
    renderShotTools();
  }

  /* ---------------- 选中某次出手后的工具条 ---------------- */
  /* 自动判定一定会错几次：抬手、假投、举球过顶都会被当成出手。
     与其让用户「只能看着错」，不如给三个动作：改时刻、标结果、删掉。 */
  function renderShotTools() {
    var bar = $('shotTools');
    if (!bar) return;
    if (state.activeShot == null || !state.shots.length) { bar.hidden = true; return; }
    bar.hidden = false;
    $('stIdx').textContent = state.activeShot + 1;
    var sh = state.shots[state.activeShot];
    var hint = $('stHint');
    if (sh && sh.manual) hint.textContent = '出手点已手动修正';
    else hint.textContent = '';
  }

  function patchShot(idx, patch) {
    var X = state.exp;
    if (!X || idx == null || idx < 0 || idx >= state.shots.length) return;

    /* state.shots 和 exp.shots 是两份视图：前者给界面，后者给讲解和导出。
       改一处不改另一处，就会出现「表格里改了、讲解里还是旧的」。 */
    var oldRel = state.shots[idx].tRel;
    var Xidx = X.shots.findIndex(function (x) { return Math.abs(x.tRel - oldRel) < 1e-6; });

    Object.assign(state.shots[idx], patch);
    if (Xidx >= 0 && patch.raw) {
      X.shots[Xidx].raw = patch.raw;
      X.shots[Xidx].tRel = patch.tRel;
      X.shots[Xidx].tAbs = patch.tAbs;
      X.shots[Xidx].ball = patch.ball || X.shots[Xidx].ball;
    }
    if (Xidx >= 0 && patch.made !== undefined) X.shots[Xidx].made = patch.made;
    /* 「手动修正过」这个标记讲解里也要认，否则文案还会念旧的自动判读 */
    if (Xidx >= 0 && patch.manual) X.shots[Xidx].manual = true;
  }

  function resortShots() {
    var keep = state.shots[state.activeShot];
    state.shots.sort(function (a, b) { return a.tAbs - b.tAbs; });
    state.shots.forEach(function (s, i) { s.id = i + 1; });
    if (state.exp) state.exp.shots.sort(function (a, b) { return a.tAbs - b.tAbs; });
    /* 排序后下标全变了，用对象身份找回选中项 */
    state.activeShot = keep ? state.shots.indexOf(keep) : null;
    if (state.activeShot < 0) state.activeShot = null;
    state.cursor = null;
  }

  function deleteShot(idx) {
    var sh = state.shots[idx];
    if (!sh) return;
    var X = state.exp;
    if (X) {
      var Xidx = X.shots.findIndex(function (x) { return Math.abs(x.tRel - sh.tRel) < 1e-6; });
      if (Xidx >= 0) X.shots.splice(Xidx, 1);
    }
    state.shots.splice(idx, 1);
    state.shots.forEach(function (s, i) { s.id = i + 1; });
    state.activeShot = state.shots.length ? Math.min(idx, state.shots.length - 1) : null;
    state.cursor = null;
    if (!state.shots.length && X) {
      /* 一次都不剩，说明这段视频里没有投篮动作 —— 说清楚，别留一个空看板 */
      X.shots.length = 0;
      state.shots = [];
    }
    updateAll();
  }

  /* ---------------- 播放位置 -> 数据联动 ---------------- */
  /* 用户拖到第 3.2 秒，右边得能对上「视频里这一下」。
     所以游标落在某次出手 0.55 秒内时，指标卡切成那一次的值并打上「此刻」，
     表格同步高亮 —— 同一条时间轴，一套数字。 */
  var lastLiveT = -1;
  function syncPlayhead(t) {
    var bar = $('liveBar');
    if (!state.exp || !state.shots.length) { if (bar) bar.hidden = true; return; }
    if (bar) bar.hidden = false;

    /* 逐帧读数走 30ms 一跳，没必要每一帧都重排 DOM */
    if (Math.abs(t - lastLiveT) < 0.02) return;
    lastLiveT = t;

    $('liveT').textContent = t.toFixed(2) + 's';

    var bi = -1, bd = 1e9;
    state.shots.forEach(function (s, i) {
      var d = Math.abs((s.tAbs == null ? 0 : s.tAbs) - t);
      if (d < bd) { bd = d; bi = i; }
    });
    var near = bd <= 0.55 ? bi : null;
    var badge = $('liveShot');
    if (near != null) {
      var sh = state.shots[near];
      badge.textContent = '第 ' + (near + 1) + ' 次出手 · ' + (sh.tAbs == null ? '' : sh.tAbs.toFixed(2)) + 's';
      badge.classList.toggle('hit', !!sh.made);
    } else {
      badge.textContent = '两次出手之间';
      badge.classList.remove('hit');
    }

    var C = state.exp.curve;
    var vals = '';
    if (C && C.length > 1) {
      var dur = BB.VideoPlayer.state.duration || state.exp.meta.duration || 1;
      var i = Math.round(t / dur * (C.length - 1));
      i = Math.max(0, Math.min(C.length - 1, i));
      var row = C[i] || [];
      /* 「腕高 140% 站高」这种读数没人看得懂，换成「距这次出手还有多久」——
         用户拖时间轴时真正想知道的是「我拖到出手了吗」。 */
      var when = '';
      if (near != null) {
        var dt = t - state.shots[near].tAbs;
        when = dt < -0.05 ? '还有 ' + Math.abs(dt).toFixed(2) + 's'
          : dt > 0.05 ? '已出手 ' + dt.toFixed(2) + 's' : '就在出手';
      } else {
        var nx = null;
        state.shots.forEach(function (s2) {
          var d2 = s2.tAbs - t;
          if (d2 > 0 && (nx == null || d2 < nx)) nx = d2;
        });
        when = nx == null ? '这一段之后没有出手了' : '下一次出手还有 ' + nx.toFixed(2) + 's';
      }
      vals =
        '<span><i>肘角</i><b>' + num(row[2], 0, '°') + '</b></span>' +
        '<span><i>膝角</i><b>' + num(row[3], 0, '°') + '</b></span>' +
        '<span><i>进度</i><b>' + when + '</b></span>';
    }
    $('liveVals').innerHTML = vals;

    if (near !== state.cursor) {
      state.cursor = near;
      if (state.res) renderMetrics();
      $('shotRows').querySelectorAll('tr[data-idx]').forEach(function (tr) {
        tr.classList.toggle('cursor', +tr.dataset.idx === state.cursor);
      });
    }
  }

  /* ---------------- 时间轴标记 ---------------- */
  function renderMarks() {
    $('trackMarks').innerHTML = state.shots.map(function (s, i) {
      return '<i class="mark' + (s.made ? ' made' : '') + '" style="left:' + (s.tRel * 100) + '%" data-idx="' + i + '"></i>';
    }).join('');
  }

  /* ---------------- 真实样本库 ---------------- */
  /* 单个数字本身没有意义，「53° 算高还是低」需要一组真实素材当参照。
     这批数据是 tools/batch_dataset.py 批量跑出来的，口径与单次分析完全一致。 */
  function renderDataset() {
    var Ds = BB.Dataset, body = $('dsBody'), sub = $('dsSub');
    if (!Ds || !body) return;
    var s = Ds.summary || {};
    if (sub) sub.textContent = (s.n || 0) + ' 次出手 · ' + (s.cases || 0) + ' 段素材';
    /* 换成两个「÷身高」的比值：出手点和起跳的绝对厘米数，换个人就不成立了，
       放在这里当参照会误导人 */
    var cells = [
      ['出手角', s.releaseAngle, '°', 1],
      ['出手点/身高', s.releaseRatio, '×', 2],
      ['起跳/身高', s.jumpRatio, '×', 2],
      ['肘角', s.elbowAngle, '°', 0]
    ];
    body.innerHTML = '<div class="ds-grid">' + cells.map(function (c) {
      return '<div class="ds-cell"><span>' + c[0] + '</span><b>' +
        (c[1] == null ? '—' : (+c[1]).toFixed(c[3])) + '<i>' + c[2] + '</i></b></div>';
    }).join('') + '</div>' +
      '<p class="ds-note">来自真实比赛与教学视频的批量分析，和上面这次分析用同一套公式。' +
      '高度类指标已换算成「÷身高」，不同身高的人可以直接比。</p>';
  }

  /* ---------------- 统一定时刷新 ---------------- */
  function updateAll() {
    $('shotCount').textContent = state.shots.length;
    $('starNameLabel').textContent = star().name;

    if (!state.shots.length) {
      if ($('probCard')) $('probCard').hidden = true;
      renderEmptyRight();
      return;
    }

    state.res = BB.Suggestion.analyze(state.shots, star());
    renderMetrics();
    renderProb();
    renderTable();
    renderMarks();
    if (state.exp) {
      BB.Charts.updateExp(state.shots, star(), state.exp.curve, curveMarks());
    } else {
      BB.Charts.update(state.shots, star());
    }
    BB.Suggestion.renderCard($('suggestCard'), state.res);
    var adv = $('btnAllAdvice');
    if (adv) adv.addEventListener('click', openModal);
  }

  /* 还没有数据时的右栏：骨架先摆出来，但每个数都写「—」，
     不要用示例数字占位，否则一眼看不出哪些是真的 */
  function renderEmptyRight() {
    var st = star();
    $('metrics').innerHTML = D.CARD_KEYS.map(function (key) {
      var dim = D.DIMS.filter(function (d) { return d.key === key; })[0];
      var sv = BB.metrics.dimValue(dim, st.raw);
      /* 身高类维度在空态也按「×身高」显示：直接摆 241cm 会让人误以为
         自己也要摸到 241，看不出这是身高带来的差别 */
      var sTxt = sv == null ? '' : (dim.ratio ? sv.toFixed(2) + '×身高' : sv + dim.unit);
      /* 比值的小数位要统一：1.30 不能显示成 1.3，否则和 1.15 一对比像是位数不齐 */
      var rng = dim.ratio
        ? dim.ideal[0].toFixed(2) + '–' + dim.ideal[1].toFixed(2)
        : dim.ideal[0] + '–' + dim.ideal[1];
      var rUnit = dim.ratio ? '×身高' : dim.unit;
      return '<div class="metric is-empty">' +
        '<div class="m-top"><span class="m-name">' + dim.name + '</span></div>' +
        '<div class="m-val na">—</div>' +
        '<div class="m-sub">目标 ' + rng + rUnit + ' · ' + st.name + ' ' + sTxt + '</div>' +
        '<div class="m-bar"><i style="width:0"></i></div>' +
      '</div>';
    }).join('');

    renderTable();
    renderMarks();
    if (BB.Charts.hasLib()) BB.Charts.clear('选一段视频后显示');
    $('suggestCard').innerHTML =
      '<div class="card-head"><h2>调整建议</h2><span class="sub">要先有一段视频</span></div>' +
      '<div class="suggest-empty">' +
        '<p>选一个投篮视频（或点右上角「看示例」），这里会给出按差距排序的改动作建议，' +
        '每一条都能点回库里大师课的原话。</p>' +
      '</div>';
  }

  /* 曲线上的标注：下蹲最低点、每次出手瞬间。
     注意类目轴的坑：传 "2.02" 这种数字字符串，ECharts 会当成数组下标 2，
     标线会跑到最左边。必须传整数下标。 */
  function curveMarks() {
    var c = state.exp.curve;
    var idxNear = function (sec) {
      var best = 0, bd = 1e9;
      for (var i = 0; i < c.length; i++) {
        var d = Math.abs(c[i][0] - sec);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    var rel = state.exp.meta.releases || [state.exp.meta.releaseAt];
    return {
      releases: rel.map(idxNear),
      dipIdx: state.exp.dipAt == null ? null : idxNear(state.exp.dipAt)
    };
  }

  /* ---------------- 库里原话回看 ---------------- */
  /* 建议里每个引用块都带 data-quote-t，点击就跳到大师课对应秒数。
     用事件委托，避免每次重渲染都要重新绑定。 */
  function initQuoteLayer() {
    var layer = $('quoteLayer');
    var v = $('quoteVideo');
    if (!layer || !v) return;

    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-quote-t]') : null;
      if (!el) return;
      openQuoteVideo(+el.dataset.quoteT);
    });

    $('qlClose').addEventListener('click', closeQuoteLayer);
    layer.addEventListener('click', function (e) {
      if (e.target === layer) closeQuoteLayer();
    });
    document.addEventListener('keydown', function (e) {
      if (e.code === 'Escape' && !layer.hidden) closeQuoteLayer();
    });

    /* 视频挂了就说清楚，别让用户对着黑框等 */
    var tip = $('qlTip');
    if (v && tip) {
      v.addEventListener('error', function () {
        tip.hidden = false;
        v.style.display = 'none';
      });
    }
  }

  function openQuoteVideo(t) {
    var K = BB.Knowledge;
    if (!K) return;
    var layer = $('quoteLayer');
    var v = $('quoteVideo');

    /* 找到这一秒对应的原话，用于标题和底部文字 */
    var hit = null;
    Object.keys(K.BY_DIM).forEach(function (key) {
      K.BY_DIM[key].forEach(function (q) {
        if (!hit && Math.abs(q.t - t) < 1) hit = { q: q, dim: key };
      });
    });
    var ch = hit ? K.chapterOf(hit.q.t) : K.chapterOf(t);
    var dimName = '';
    if (hit) {
      var d = D.DIMS.filter(function (x) { return x.key === hit.dim; })[0];
      dimName = d ? d.name : '';
    }

    $('qlTitle').textContent = K.META.title + ' · ' + ch.title;
    $('qlSub').textContent = K.timecode(t) + (dimName ? ' · 对应维度：' + dimName : '');
    $('qlQuote').textContent = hit ? '「' + hit.q.zh + '」  ' + hit.q.en : '';
    $('qlCredit').textContent = '视频来源：' + K.META.credit + '（B 站 ' + K.META.bvid + ' P' + K.META.part + '）';
    /* 兜底：本地视频若因编码/路径加载失败，可直接跳 B 站对应秒数 */
    var bili = $('qlBili');
    if (bili) {
      bili.href = 'https://www.bilibili.com/video/' + K.META.bvid +
        '/?p=' + K.META.part + '&t=' + Math.floor(t);
    }

    /* 先让图层可见，再跳转。
       video 的 src 已写在 HTML 属性里，页面解析时就开始取元数据，
       所以这里只需要等 metadata 就绪后 seek。
       （若改成点开发时才挂 src，本地大文件会出现「一直转圈」）*/
    layer.hidden = false;
    requestAnimationFrame(function () { layer.classList.add('show'); });

    var seekTo = Math.max(0, t - 2.5);   // 提前 2.5 秒，给一点上下文
    var doSeek = function () {
      try { v.currentTime = seekTo; } catch (err) { /* 元数据未就绪时忽略 */ }
      var p = v.play();
      if (p && p.catch) p.catch(function () { /* 自动播放被拦，用户手动点播放即可 */ });
    };

    if (v.readyState >= 1) {
      doSeek();
    } else {
      v.addEventListener('loadedmetadata', doSeek, { once: true });
      try { v.load(); } catch (err) { /* 极老浏览器忽略 */ }
    }
  }

  function closeQuoteLayer() {
    var layer = $('quoteLayer');
    var v = $('quoteVideo');
    if (v) { try { v.pause(); } catch (e) {} }
    layer.classList.remove('show');
    setTimeout(function () { layer.hidden = true; }, 180);
  }

  /* ---------------- 结果落位：示例和用户视频走同一条路径 ---------------- */
  function applyResult(X, opt) {
    opt = opt || {};
    state.exp = X;
    BB.__lastExp = X;   // 调试用：测试脚本要读内部诊断数据
    state.shots = X.shots.map(function (s, i) {
      return { id: i + 1, tRel: s.tRel, tAbs: s.tAbs, made: s.made, raw: s.raw, exp: true };
    });
    state.activeShot = 0;
    state.cursor = null;
    state.lastRender = -1;

    var pts = opt.bundle || (BB.poseBundle && BB.poseBundle[X.meta.tag] ? BB.poseBundle[X.meta.tag].pts : null);
    if (pts) BB.Overlay.setBundle({ pts: pts }, X.meta.fps, X.meta.side);
    else BB.Overlay.clearBundle();
    BB.Overlay.setIdle(!pts);

    if (!opt.alreadyLoaded) BB.VideoPlayer.loadUrl(opt.url || X.meta.video);
    syncVideoAspect();

    $('stage').classList.add('has-video');
    $('drop').hidden = true;
    $('analysing').hidden = true;
    $('stageChip').hidden = false;
    $('frameBadge').hidden = false;
    $('track').hidden = false;
    $('controls').hidden = false;
    $('shortcut').hidden = false;
    if ($('liveBar')) $('liveBar').hidden = false;

    $('stageChip').textContent = (X.meta.userVideo ? '已分析 · ' : '示例样本 · ') + X.meta.subject;
    $('modeBadge').textContent = X.meta.userVideo ? '你的视频' : '示例数据';
    $('modeBadge').classList.add('real');

    var bar = $('expBar');
    if (bar) bar.hidden = false;
    renderExpBar();

    /* 讲解入口：只在「分析的是你的视频」时出现，
       示例样本没有逐帧骨骼包，讲了也是空话 */
    var cta = $('coachCta');
    if (cta) cta.hidden = !(X.meta.userVideo && X.shots && X.shots.length);
    updateAll();

    /* 播到出手前 0.8 秒，让用户直接看到那一下。
       时长要等元数据，轮询几次比固定 setTimeout 稳 */
    var go = function () { BB.VideoPlayer.seekTime(Math.max(0, X.meta.releaseAt - 0.8)); };
    var tryGo = function (n) {
      if (BB.VideoPlayer.state.duration > 1 || n <= 0) { go(); return; }
      setTimeout(function () { tryGo(n - 1); }, 250);
    };
    tryGo(10);
  }

  /* 示例样本：数据是离线用 tools/build_experiment.py 跑出来的，可直接看 */
  function loadSample() {
    var X = BB.Experiment;
    if (!X) return;
    backToIdle(true);
    var h = $('heightInput');
    if (h) h.value = Math.round(X.meta.heightCm || 178);
    applyResult(X);
  }

  /* 视频是竖屏/宽屏都可能，骨骼层要按视频实际画面比例放置 */
  function syncVideoAspect() {
    var v = BB.VideoPlayer.state.video;
    var st = $('stage');
    var use = function () {
      if (!v.videoWidth) return;
      var a = v.videoWidth / v.videoHeight;
      BB.Overlay.setVideoAspect(a);
      /* 手机竖拍占大多数，舞台固定 16:10.4 会让画面缩成中间一条，
         左右全是黑边。这里按视频本身比例给舞台定高（夹在合理范围内）。 */
      st.style.aspectRatio = Math.min(1.7, Math.max(0.68, a)).toFixed(3);
      /* 不把视频宽高比告诉骨骼层，它就按整块画布铺开，骨架会整体偏移 */
      if (BB.Overlay && BB.Overlay.setVideoAspect) BB.Overlay.setVideoAspect(a);
    };
    if (v.videoWidth) use();
    else v.addEventListener('loadedmetadata', use, { once: true });
  }

  function renderExpBar() {
    var X = state.exp, bar = $('expBar');
    if (!X || !bar) return;
    var bt = X.meta.ballTrack;
    var bits = ['<b>' + X.meta.subject + '</b>', X.meta.source];
    if (bt && bt.ok) bits.push('球轨迹 ' + bt.n_points + ' 点');
    else if (X.meta.userVideo) {
      var why = (bt && bt.reason) ? '（' + bt.reason + '）' : '';
      bits.push('未识别到球，出手角留空' + why);
    }
    if (X.detected) bits.push('识别 ' + X.detected + '/' + X.total + ' 帧');
    else bits.push('逐帧 ' + (X.curve ? X.curve.length : 0) + ' 帧');
    bits.push(X.shots.length + ' 次出手');
    if (X.meta.smallSubject) {
      bits.push('<b style="color:#dc2626">人只占画面 ' + X.meta.subjectPx + ' 像素高，厘米类指标误差大，靠近拍会准很多</b>');
    } else if (X.meta.longVideo) {
      bits.push('<b style="color:#d97706">视频偏长，只有 ' + X.meta.sampleFps + 'fps，建议裁到 10–20 秒再传</b>');
    }
    $('expText').innerHTML = bits.join('<span class="exp-sep">·</span>');
  }

  function backToIdle(keepPanel) {
    state.exp = null;
    state.shots = [];
    state.activeShot = null;
    if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }
    $('stage').style.aspectRatio = '';
    BB.Overlay.clearBundle();
    BB.Overlay.setIdle(true);
    BB.Overlay.setVideoAspect(0);
    BB.VideoPlayer.setIdle();
    if (!keepPanel) {
      $('stage').classList.remove('has-video');
      $('drop').hidden = false;
      $('analysing').hidden = true;
      $('stageChip').hidden = true;
      $('frameBadge').hidden = true;
      $('track').hidden = true;
      $('controls').hidden = true;
      $('shortcut').hidden = true;
      $('expBar').hidden = true;
      if ($('coachCta')) $('coachCta').hidden = true;
      if ($('liveBar')) $('liveBar').hidden = true;
      if ($('shotTools')) $('shotTools').hidden = true;
      $('modeBadge').textContent = '等待视频';
      $('modeBadge').classList.remove('real');
    }
    updateAll();
  }

  /* 把选中的那次出手，改成「视频当前这一帧」。
     只改时间戳是没用的：肘角、出手点、下蹲时刻全都要按新的帧重算，
     所以这里走 pose-engine 的 recomputeShot，把整组指标重算一遍。 */
  function setReleasePoint() {
    var E = BB.PoseEngine, X = state.exp;
    var idx = state.activeShot;
    var hint = $('stHint');
    if (!E || !E.recomputeShot || !X || idx == null) return;

    var t = BB.VideoPlayer.state.t;
    var r = E.recomputeShot({
      bundle: X.bundle,
      meta: X.meta,
      heightCm: height(),
      t: t,
      ballBlobs: X.ballBlobs
    });
    if (!r) {
      if (hint) hint.textContent = '这一帧取不到骨骼，换个位置再点';
      return;
    }
    patchShot(idx, {
      tRel: r.tRel, tAbs: r.tAbs, raw: r.raw, ball: r.ball, manual: true
    });
    resortShots();
    updateAll();
    if (hint) {
      hint.textContent = '已改为 ' + r.tAbs.toFixed(2) + 's，指标全部重算'
        + (r.ball && r.ball.ok ? '' : '（球轨迹没跟住，出手角仍为空）');
    }
  }

  /* ---------------- 上传 -> 浏览器里直接跑分析 ---------------- */
  function height() {
    var v = parseInt($('heightInput').value, 10);
    return (v >= 130 && v <= 230) ? v : 178;
  }

  /* 进度条只许往前走。
     引擎预热和逐帧识别是两段独立的上报，范围各自不同，
     直接覆盖会出现「到 50% 又跳回 5%」这种一眼假的动作。 */
  var anRatio = 0;
  function resetAnalyseBar() { anRatio = 0; }

  function showAnalyse(ratio, title, text) {
    $('analysing').hidden = false;
    $('anTitle').textContent = title || '正在分析';
    var r = Math.max(0, Math.min(1, ratio));
    if (r > anRatio) anRatio = r;
    $('anBar').style.width = Math.round(anRatio * 100) + '%';
    $('anPct').textContent = Math.round(anRatio * 100) + '%';
    if (text) $('anText').textContent = text;
  }

  function showAnalyseError(msg) {
    $('analysing').hidden = false;
    $('anTitle').textContent = '没分析成功';
    $('anBar').style.width = '100%';
    $('anBar').classList.add('is-error');
    $('anPct').textContent = '';
    $('anText').innerHTML = msg + '<br><span class="an-hint">换一段全身入镜、光线充足的视频再试一次</span>';
  }

  /* 引擎预热提示 + 把真实下载进度接到进度条上。
     为什么必须有：首次要下近 19MB，没有进度就是一片死寂，
     用户会以为页面坏了直接关掉 —— 这是「别人用不了」的真正原因，
     跟服务器无关，这里根本没有服务器。 */
  function initEngine() {
    var E = BB.PoseEngine;
    if (!E || !E.onEngineProgress) return;
    var hint = $('engineHint');

    E.onEngineProgress(function (s) {
      /* 模型占前一半、运行时占后一半，合起来算总进度 */
      var overall = s.phase === 'model'
        ? 0.5 * s.pct
        : 0.5 + 0.5 * s.pct;

      /* 正在分析：进度条跟着下载走，不要死钉在 1% */
      if (!$('analysing').hidden && s.phase !== 'ready' && s.phase !== 'error') {
        showAnalyse(0.02 + 0.46 * overall, '正在准备识别引擎', s.text);
        return;
      }

      if (!hint) return;
      if (s.phase === 'ready' || s.phase === 'idle') {
        hint.hidden = true;
        return;
      }
      if (s.phase === 'error') {
        hint.hidden = false;
        hint.textContent = '识别引擎没加载成功，选中视频时会自动重试';
        return;
      }
      hint.hidden = false;
      hint.innerHTML = s.text + ' · <b>' + Math.round(overall * 100) + '%</b>'
        + '<br>首次使用需下载约 19MB 识别引擎，之后缓存在本机，打开即用';
    });

    /* 页面一打开就预热：把等待藏进用户阅读页面的时间里 */
    if (E.preload) E.preload();
  }

  function startAnalyze(file) {
    if (!file) return;
    var E = BB.PoseEngine;
    var v = BB.VideoPlayer.state.video;

    if (state.exp) backToIdle(true);
    if (state.url) { URL.revokeObjectURL(state.url); state.url = null; }

    var url = URL.createObjectURL(file);
    state.url = url;

    $('anBar').classList.remove('is-error');
    $('stage').classList.add('has-video');
    $('drop').hidden = true;
    $('stageChip').hidden = true;
    $('track').hidden = true;
    $('controls').hidden = true;
    $('expBar').hidden = true;
    if ($('coachCta')) $('coachCta').hidden = true;
    if ($('liveBar')) $('liveBar').hidden = true;
    if ($('shotTools')) $('shotTools').hidden = true;
    resetAnalyseBar();
    showAnalyse(0.01, '正在读取视频…', '正在加载姿态模型…');

    BB.VideoPlayer.loadUrl(url);
    syncVideoAspect();

    if (!E) {
      showAnalyseError('分析引擎没有加载起来（js/pose-engine.js 是 ES 模块，需要用本地服务器打开页面，不能直接双击 html）。');
      return;
    }

    var started = false;
    var start = function () {
      if (started) return;
      started = true;
      if (!v.videoWidth) {
        showAnalyseError('浏览器读不出这个视频的画面，可能是编码不支持（建议 MP4/H.264 或 WebM）。');
        return;
      }
      E.analyze(v, {
        heightCm: height(),
        subject: file.name.replace(/\.[^.]+$/, ''),
        source: '本地上传',
        onProgress: function (text, ratio) { showAnalyse(ratio, '正在分析', text); }
      }).then(function (res) {
        res.meta.video = url;
        applyResult(res, { alreadyLoaded: true, bundle: res.bundle });
      }).catch(function (err) {
        showAnalyseError(String(err && err.message ? err.message : err));
      });
    };

    if (v.readyState >= 1 && v.videoWidth) start();
    else v.addEventListener('loadedmetadata', start, { once: true });
    setTimeout(function () { if (v.readyState >= 1 && v.videoWidth) start(); }, 1500);
  }

  /* ---------------- 弹窗 ---------------- */
  function openModal() {
    var m = $('modal');
    BB.Suggestion.renderModal(m, state.res);
    m.hidden = false;
    requestAnimationFrame(function () { m.classList.add('show'); });
    $('modalClose').addEventListener('click', closeModal);
    $('modalOk').addEventListener('click', closeModal);
  }
  function closeModal() {
    var m = $('modal');
    m.classList.remove('show');
    setTimeout(function () { m.hidden = true; }, 180);
  }

  /* ---------------- 视频与时间轴 ---------------- */
  function initVideo() {
    BB.VideoPlayer.mount($('video'));
    BB.Overlay.mount($('overlay'));

    BB.VideoPlayer.onTime(function (t, duration, playing) {
      var ratio = duration ? t / duration : 0;
      $('trackFill').style.width = (ratio * 100) + '%';
      $('trackHead').style.left = (ratio * 100) + '%';
      var frame = Math.round(t * D.fps);
      $('frameBadge').textContent = fmtTime(t) + ' / 第 ' + frame + ' 帧';
      $('timeLabel').textContent = t.toFixed(2) + 's';
      // 只有挂上了真实骨骼包才画，空态什么都不画
      BB.Overlay.render(t, BB.Overlay.hasBundle());
      syncPlayhead(t);
    });

    BB.VideoPlayer.onState(function (playing, mode) {
      $('btnPlay').innerHTML = playing ? '❙❙' : '▶';
      $('btnPlay').classList.toggle('is-playing', playing);
    });

    $('btnPlay').addEventListener('click', function () { BB.VideoPlayer.toggle(); });
    $('btnPrev').addEventListener('click', function () { BB.VideoPlayer.step(-1); });
    $('btnNext').addEventListener('click', function () { BB.VideoPlayer.step(1); });

    $('track').addEventListener('click', function (e) {
      var rect = this.getBoundingClientRect();
      BB.VideoPlayer.seek((e.clientX - rect.left) / rect.width);
    });

    $('speeds').innerHTML = [0.25, 0.5, 1].map(function (s) {
      return '<button class="speed' + (s === 1 ? ' active' : '') + '" data-speed="' + s + '">' + s + '×</button>';
    }).join('');
    $('speeds').querySelectorAll('.speed').forEach(function (b) {
      b.addEventListener('click', function () {
        $('speeds').querySelectorAll('.speed').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        BB.VideoPlayer.setSpeed(+b.dataset.speed);
      });
    });

    /* 上传：立刻开始真实分析，不再只是"把视频放出来" */
    $('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';                 // 允许重复选同一个文件
      startAnalyze(f);
    });

    /* 拖拽进舞台也能分析 */
    var stage = $('stage');
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
      if (f && /^video\//.test(f.type || '')) startAnalyze(f);
    });

    /* 标准火柴人模板：叠在同一块画布上，用自己的身高和站位对齐 */
    var bg = $('btnGhost');
    if (bg) bg.addEventListener('click', function () {
      if (!BB.Ghost) return;
      var on = BB.Ghost.toggle();
      bg.classList.toggle('on', on);
      var note = $('ghostNote');
      if (note) {
        note.hidden = !on;
        note.innerHTML = '<b>绿色 = 标准模板</b> ' + BB.Ghost.describe();
      }
    });

    /* 示例样本 */
    var btnExp = $('btnExperiment');
    if (btnExp) btnExp.addEventListener('click', loadSample);
    var btnExpExit = $('expExit');
    if (btnExpExit) btnExpExit.addEventListener('click', function () { backToIdle(); });

    /* 手动改出手点：先拖到球真正离手的那一帧，再点这个按钮 */
    var stSet = $('stSet');
    if (stSet) stSet.addEventListener('click', setReleasePoint);
    var stMade = $('stMade');
    if (stMade) stMade.addEventListener('click', function () {
      if (state.activeShot == null) return;
      patchShot(state.activeShot, { made: true });
      if (BB.Progress) BB.Progress.mark(state.shots[state.activeShot], true, state.dist);
      updateAll();
    });
    var stMiss = $('stMiss');
    if (stMiss) stMiss.addEventListener('click', function () {
      if (state.activeShot == null) return;
      patchShot(state.activeShot, { made: false });
      if (BB.Progress) BB.Progress.mark(state.shots[state.activeShot], false, state.dist);
      updateAll();
    });
    var stDel = $('stDel');
    if (stDel) stDel.addEventListener('click', function () {
      if (state.activeShot == null) return;
      deleteShot(state.activeShot);
    });

    /* 教练讲解 */
    var btnCoach = $('btnCoach');
    if (btnCoach) btnCoach.addEventListener('click', function () {
      if (!state.exp || !BB.Coach) return;
      if (state.exp.meta.userVideo === false) return;
      BB.Coach.open(state.exp);
    });

    /* 改身高后重算高度类指标：只重算厘米换算，不重跑模型 */
    var hi = $('heightInput');
    if (hi) hi.addEventListener('change', function () {
      if (!state.exp) return;
      var k = height() / (state.exp.meta.heightCm || 178);
      state.shots = state.shots.map(function (s) {
        var r = Object.assign({}, s.raw);
        if (r.releaseHeight != null) r.releaseHeight = Math.round(r.releaseHeight * k * 10) / 10;
        if (r.jumpHeight != null) r.jumpHeight = Math.round(r.jumpHeight * k * 10) / 10;
        return { id: s.id, tRel: s.tRel, made: s.made, raw: r, exp: true };
      });
      state.exp.meta.heightCm = height();
      updateAll();
    });

    document.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); BB.VideoPlayer.toggle(); }
      if (e.code === 'ArrowLeft') { e.preventDefault(); BB.VideoPlayer.step(-1); }
      if (e.code === 'ArrowRight') { e.preventDefault(); BB.VideoPlayer.step(1); }
    });
  }

  function fmtTime(t) {
    var m = Math.floor(t / 60);
    var s = t % 60;
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s.toFixed(2) : s.toFixed(2));
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    renderStars();
    initVideo();
    initEngine();
    initQuoteLayer();
    renderDataset();
    if (BB.Zone) {
      BB.Zone.renderCard($('zoneCard'), state.shots.length ? 2.2 : 2.2);
    }
    var ok = BB.Charts.init();
    BB.Overlay.setIdle(true);
    if (BB.Ghost) {
      BB.Ghost.applyFromDims();
      BB.Overlay.onDraw(BB.Ghost.render);
    }
    updateAll();
    if (ok) setTimeout(BB.Charts.resize, 60);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.BB);
