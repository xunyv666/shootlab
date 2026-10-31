/* ============================================================
 * suggestion.js  —  建议匹配逻辑（杜星延）
 * 思路：把「用户均值」与「球星基准」在 8 个维度上做差，
 *       按差距从大到小排序，取前 2 个作为主问题，
 *       再按差距档位（明显/轻度/达标）匹配不同强度的文案。
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var D = BB.data;

  /*
   * 档次判定：不写死绝对数值，而是以「本人 8 项差距的平均值」为基准做相对判定。
   * 理由：和不同球星比，绝对差距大小差别很大；相对判定才能始终挑出「最该练的项」。
   *   gap 明显低于平均 → 差距明显（红）
   *   接近平均        → 需要优化（黄）
   *   明显高于平均    → 相对较好（绿）
   */
  function assignTones(items) {
    if (!items.length) return items;
    var mean = items.reduce(function (a, b) { return a + b.gap; }, 0) / items.length;
    items.forEach(function (g) {
      if (g.gap <= mean - 5) {
        g.tone = { key: 'bad', label: '差距明显', cls: 'tone-bad' };
      } else if (g.gap >= mean + 5) {
        g.tone = { key: 'good', label: '相对较好', cls: 'tone-good' };
      } else {
        g.tone = { key: 'warn', label: '需要优化', cls: 'tone-warn' };
      }
    });
    return items;
  }

  /* 生成每个维度的对比数据
     注意：这里不能直接取 raw[dim.raw]。
     · 高度类指标比的是「÷身高」，库里 241cm 是因为他 188cm，不比 180cm 的人更高
     · 出手角的目标是个性化的，出手点低的人需要更大角度，统一区间会误判 */
  function buildGaps(avg, starRaw) {
    var starRadar = BB.metrics.radarOf(starRaw);
    var items = D.DIMS.map(function (dim) {
      var u = BB.metrics.dimValue(dim, avg.raw);
      var s = BB.metrics.dimValue(dim, starRaw);
      var userScore = avg.radar[dim.key];
      var starScore = starRadar[dim.key];
      var gap = userScore - starScore;
      return {
        key: dim.key,
        name: dim.name,
        unit: dim.unit,
        rawName: dim.raw,
        ratio: !!dim.ratio,
        dynamic: dim.dynamic,
        src: dim.src,
        ideal: BB.metrics.dimIdeal(dim, avg.raw),
        baseIdeal: dim.ideal,
        u: u, s: s,
        spread: bbSd(dim, avg),
        userScore: userScore,
        starScore: starScore,
        gap: gap,
        tone: null
      };
    }).sort(function (a, b) { return a.gap - b.gap; });
    return assignTones(items);
  }

  /* 波动值也要按同一口径换算，否则比值维度的 ±sd 会变成 ±30 厘米那种荒谬数字 */
  function bbSd(dim, avg) {
    if (!avg.rawSd) return 0;
    if (dim.ratio) {
      var h = avg.raw && avg.raw.heightCm;
      return h ? avg.rawSd[dim.raw] / h : 0;
    }
    return avg.rawSd[dim.raw] || 0;
  }

  /* 数据依据：一句人话把数字讲清楚（含波动情况） */
  function evidence(g, starName) {
    var unit = unitOf(g);
    var diff = Math.abs((g.u || 0) - (g.s || 0));
    var base = g.name + '均值 ' + fmtV(g.u, g) + unit + '，' + starName + '为 ' + fmtV(g.s, g) + unit +
      '（相差 ' + fmtV(diff, g) + unit + '）';
    var inIdeal = g.u >= g.ideal[0] && g.u <= g.ideal[1];
    var band = (g.dynamic === 'brancazio' ? '个人目标区间 ' : '参考区间 ') +
      fmtV(g.ideal[0], g) + '–' + fmtV(g.ideal[1], g) + unit;
    if (!inIdeal) {
      base += '，已' + (g.u < g.ideal[0] ? '低于' : '超出') + band;
    } else {
      base += '，落在' + band + '内';
    }
    // 出手角的目标是算出来的，得说明依据，否则读者不知道这个区间凭什么
    if (g.dynamic === 'brancazio') base += '（按出手点算出）';
    // 波动大的时候补一句，解释为什么「数值看着还行、分数却低」
    if (g.spread > 0) {
      base += '；不过多次出手上下浮动 ±' + fmtV(g.spread, g) + unit;
      if (g.spread >= (g.ideal[1] - g.ideal[0]) * 0.5) {
        base += '，动作还不够稳定，这一项主要扣在「一致性」上';
      }
    }
    return base + '。';
  }

  function unitOf(g) {
    return g.ratio ? '×身高' : (g.unit === '分' ? '' : g.unit);
  }

  function fmtV(v, g) {
    if (v == null || isNaN(v)) return '—';
    if (g && g.ratio) return (+v).toFixed(2);
    return Math.abs(v) >= 100 ? Math.round(v) : (Math.round(v * 10) / 10);
  }

  function fmt(v) {
    return Math.abs(v) >= 100 ? Math.round(v) : (Math.round(v * 10) / 10);
  }

  /* ---------- 库里原话引用块（知识层） ---------- */
  /* 每条建议都能挂回大师课里库里本人的原话，点击可跳到视频对应秒数 */
  function quoteHTML(dimKey, compact) {
    var K = BB.Knowledge;
    if (!K) return '';
    var q = K.quoteFor(dimKey);
    if (!q) return '';
    var tc = K.timecode(q.t);
    if (compact) {
      return '<p class="adv-quote" data-quote-t="' + q.t + '" title="点击播放库里这一段">' +
        '<span class="q-mark">库里</span>「' + q.zh + '」' +
        '<span class="q-link">▶ ' + tc + '</span></p>';
    }
    return '<div class="quote-box" data-quote-t="' + q.t + '">' +
        '<div class="q-head">' +
          '<span class="q-badge">库里原话</span>' +
          '<span class="q-time">' + tc + '</span>' +
          '<span class="q-play">▶ 看这段</span>' +
        '</div>' +
        '<p class="q-zh">「' + q.zh + '」</p>' +
        '<p class="q-en">' + q.en + '</p>' +
        (q.note ? '<p class="q-note">' + q.note + '</p>' : '') +
      '</div>';
  }

  /* 主分析入口 */
  function analyze(shots, star) {
    var avg = BB.metrics.average(shots);
    var gaps = buildGaps(avg, star.raw);
    // 主建议取「差距明显 / 需要优化」里最靠前的两项；若全部达标则仍给出最接近的两项
    var weak = gaps.filter(function (g) { return g.tone.key !== 'good'; });
    var top = (weak.length ? weak : gaps).slice(0, 2);
    var strong = gaps.slice().sort(function (a, b) { return b.gap - a.gap; })[0];
    var known = shots.filter(function (s) { return s.made === true || s.made === false; });
    var made = known.filter(function (s) { return s.made; }).length;

    return {
      avg: avg,
      gaps: gaps,
      top: top,
      weakCount: weak.length,
      strongest: strong,
      /* 视频里判不出球是否进筐，命中率就必须显示「—」，
         否则 null 会被当成未中，算出一个假的 0% */
      hasResult: known.length > 0,
      hitRate: known.length ? Math.round(made / known.length * 100) : null,
      made: made,
      total: known.length,
      /* 标题上的「基于最近 N 次出手」要用实际出手数，不能用 known.length ——
         视频里判不出进不进的时候 known 是 0，会显示成「近 0 次出手」。 */
      shotCount: shots.length,
      /* 一次出手谈不上「稳定性」，返回 null 让界面显示「—」而不是谎报 100 */
      consistency: shots.length >= 2 ? BB.metrics.consistency(shots) : null,
      star: star
    };
  }

  /* 渲染右侧主建议卡 */
  function renderCard(el, res) {
    var starName = res.star.name;
    var t1 = res.top[0];
    var t2 = res.top[1];
    var adv1 = D.ADVICE[t1.key];
    var adv2 = t2 ? D.ADVICE[t2.key] : null;

    el.innerHTML =
      '<div class="card-head">' +
        '<h2>调整建议</h2>' +
        '<span class="sub">共 ' + res.shotCount + ' 次出手 · 对比 ' + starName + '</span>' +
      '</div>' +
      '<div class="suggest-body">' +
        '<div class="suggest-main">' +
          '<div class="suggest-tag ' + t1.tone.cls + '">' + t1.tone.label + ' · 第 1 优先</div>' +
          '<h3>' + adv1.title + '</h3>' +
          '<p class="suggest-why">' + evidence(t1, starName) + '</p>' +
          '<div class="compare-strip">' +
            '<div class="cs-item"><span>你的均值</span><b>' + fmtV(t1.u, t1) + unitOf(t1) + '</b></div>' +
            '<div class="cs-item"><span>' + starName + '</span><b>' + fmtV(t1.s, t1) + unitOf(t1) + '</b></div>' +
            '<div class="cs-item"><span>差值</span><b class="' + (t1.gap < 0 ? 'neg' : 'pos') + '">' +
              (t1.gap > 0 ? '+' : '') + Math.round(t1.gap) + ' 分</b></div>' +
          '</div>' +
          '<div class="suggest-block"><h4>怎么改</h4><p>' + adv1.fix + '</p></div>' +
          '<div class="suggest-block"><h4>训练动作</h4><p>' + adv1.drill + '</p></div>' +
          '<div class="cue">口令提示 · ' + adv1.cue + '</div>' +
          quoteHTML(t1.key) +
        '</div>' +
        (adv2 ?
        '<div class="suggest-side">' +
          '<div class="suggest-tag ' + t2.tone.cls + '">' + t2.tone.label + ' · 第 2 优先</div>' +
          '<h3 class="sm">' + adv2.title + '</h3>' +
          '<p class="suggest-why sm">' + evidence(t2, starName) + '</p>' +
          '<div class="suggest-block"><h4>怎么改</h4><p>' + adv2.fix + '</p></div>' +
          '<div class="cue sm">口令提示 · ' + adv2.cue + '</div>' +
        '</div>' : '') +
      '</div>' +
      '<div class="suggest-foot">' +
        '<div class="foot-left">' +
          (res.hasResult
            ? '<span class="dot good"></span>命中率 <b>' + res.hitRate + '%</b>（' + res.made + '/' + res.total + '）'
            : '<span class="dot gray"></span>命中率 <b>—</b>（本段视频无法判定球是否进筐）') +
          '<span class="sep"></span>' +
          '<span class="dot blue"></span>动作稳定性 <b>' +
            (res.consistency == null ? '—' : res.consistency) + '</b>' +
          '<span class="sep"></span>' +
          '<span class="dot gray"></span>当前最接近 ' + starName + ' 的维度：<b>' + res.strongest.name + '</b>' +
        '</div>' +
        '<button class="btn btn-ghost" id="btnAllAdvice">查看完整建议（8 项）</button>' +
      '</div>';
  }

  /* 弹窗：八维全量建议 */
  function renderModal(el, res) {
    var starName = res.star.name;
    var rows = res.gaps.map(function (g) {
      var adv = D.ADVICE[g.key];
      var pct = Math.max(4, Math.min(100, (g.userScore / 100) * 100));
      var sPct = Math.max(4, Math.min(100, (g.starScore / 100) * 100));
      return '<div class="adv-row">' +
        '<div class="adv-top">' +
          '<span class="adv-name">' + g.name + '</span>' +
          '<span class="adv-tag ' + g.tone.cls + '">' + g.tone.label + '</span>' +
          '<span class="adv-gap">' + (g.gap > 0 ? '+' : '') + Math.round(g.gap) + '</span>' +
        '</div>' +
        '<div class="adv-bars">' +
          '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
          '<div class="bar star"><i style="width:' + sPct + '%"></i></div>' +
        '</div>' +
        '<p class="adv-desc">' + evidence(g, starName) + '</p>' +
        '<p class="adv-fix"><b>建议：</b>' + adv.fix + '</p>' +
        '<p class="adv-drill"><b>训练：</b>' + adv.drill + '</p>' +
        quoteHTML(g.key, true) +
      '</div>';
    }).join('');

    el.innerHTML =
      '<div class="modal-panel">' +
        '<div class="modal-head">' +
          '<div>' +
            '<h3>完整动作诊断报告</h3>' +
            '<p class="sub">8 个维度逐项对比 · 深色条为你，浅色条为 ' + starName + ' 基准</p>' +
          '</div>' +
          '<button class="modal-close" id="modalClose" aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="modal-body">' + rows + '</div>' +
        '<div class="modal-foot">' +
          '<span class="sub">数据来源：本次训练 ' + res.shotCount + ' 次出手，综合评分 <b>' + res.avg.score + '</b></span>' +
          '<button class="btn btn-primary" id="modalOk">我知道了</button>' +
        '</div>' +
      '</div>';
  }

  BB.Suggestion = {
    analyze: analyze,
    renderCard: renderCard,
    renderModal: renderModal
  };
})(window.BB);
