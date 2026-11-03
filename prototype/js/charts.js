/* ============================================================
 * charts.js  —  ECharts 图表模块（杜星延）
 * 1) 雷达图：用户八维能力 vs 球星基准
 * 2) 趋势图：多次出手的综合评分 + 出手角度走势
 * 对外接口：Charts.init() / Charts.update(shots, star) / Charts.resize()
 * ============================================================ */
window.BB = window.BB || {};

(function (BB) {
  'use strict';

  var radar, trend;
  /* 放大层：半屏宽画不下 20 次出手，点会挤成一团，所以单独开一个大图 */
  var zoomEl = null, zoomChart = null, zoomKind = null, zoomView = 'trend';
  /* 最近一次喂进来的数据，放大图重建时要用同一份 */
  var last = { shots: null, star: null, curve: null, marks: null };
  var C_USER = '#f97316';
  var C_STAR = '#2563eb';
  var FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

  function hasLib() { return typeof window.echarts !== 'undefined'; }

  function failHint(el, msg) {
    if (el) el.innerHTML = '<div class="chart-fail">' + msg + '</div>';
  }

  /* ---------------- 雷达图 ---------------- */
  function radarOption(userRadar, starRadar, starName) {
    var D = BB.data.DIMS;
    return {
      animationDuration: 600,
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(255,255,255,0.98)',
        borderColor: '#e8eaee',
        textStyle: { color: '#1a1d24', fontSize: 12 },
        extraCssText: 'box-shadow:0 6px 20px rgba(16,24,40,.10);border-radius:10px;padding:8px 12px;'
      },
      legend: {
        bottom: 0,
        icon: 'roundRect',
        itemWidth: 10, itemHeight: 10, itemGap: 16,
        textStyle: { color: '#5b6472', fontSize: 12, fontFamily: FONT }
      },
      radar: {
        center: ['50%', '47%'],
        radius: '63%',
        splitNumber: 4,
        axisName: {
          color: '#5b6472',
          fontSize: 11.5,
          fontFamily: FONT,
          padding: [2, 4]
        },
        indicator: D.map(function (d) { return { name: d.name, max: 100 }; }),
        splitLine: { lineStyle: { color: '#eceef2' } },
        splitArea: { areaStyle: { color: ['#ffffff', '#fafbfc'] } },
        axisLine: { lineStyle: { color: '#eceef2' } }
      },
      series: [{
        type: 'radar',
        symbolSize: 5,
        data: [
          {
            name: '我的动作',
            value: D.map(function (d) { return userRadar[d.key]; }),
            itemStyle: { color: C_USER },
            lineStyle: { color: C_USER, width: 2.5 },
            areaStyle: { color: 'rgba(249,115,22,0.18)' }
          },
          {
            name: starName + ' 基准',
            value: D.map(function (d) { return starRadar[d.key]; }),
            itemStyle: { color: C_STAR },
            lineStyle: { color: C_STAR, width: 2, type: 'dashed' },
            areaStyle: { color: 'rgba(37,99,235,0.06)' }
          }
        ]
      }]
    };
  }

  /* ---------------- 趋势图 ---------------- */
  function trendOption(shots, starRaw, big) {
    var xs = shots.map(function (s, i) { return '第' + (i + 1) + '次'; });
    var scores = shots.map(function (s) { return BB.metrics.overall(BB.metrics.radarOf(s.raw)); });
    /* 出手角测不出来时是 null。以前直接 toFixed 会抛异常，
       整个重绘中断，图上停在旧内容 —— 视频里大约一半的球是这种情况。
       这里保留 null，线自然断开，那一点就是「这次没测出来」。 */
    var angles = shots.map(function (s) {
      return s.raw.releaseAngle == null ? null : +s.raw.releaseAngle.toFixed(1);
    });
    var starAngle = starRaw.releaseAngle;
    /* 大图给底部滑块留出位置，点也不用再被挤在一起 */
    var fs = big ? 1 : 0;

    return {
      animationDuration: 600,
      grid: big
        ? { left: 58, right: 76, top: 52, bottom: 92 }
        : { left: 42, right: 46, top: 34, bottom: 26 },
      dataZoom: big ? [
        { type: 'inside', zoomOnMouseWheel: true, moveOnMouseWheel: false, moveOnMouseMove: true },
        {
          type: 'slider', height: 20, bottom: 16, borderColor: 'transparent',
          backgroundColor: '#f1f3f6', fillerColor: 'rgba(249,115,22,.12)',
          handleStyle: { color: '#fff', borderColor: '#d7dbe3' },
          moveHandleSize: 4,
          textStyle: { color: '#8b94a3', fontSize: 10 }
        }
      ] : [],
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,0.98)',
        borderColor: '#e8eaee',
        textStyle: { color: '#1a1d24', fontSize: 12 },
        extraCssText: 'box-shadow:0 6px 20px rgba(16,24,40,.10);border-radius:10px;padding:8px 12px;',
        axisPointer: { type: 'line', lineStyle: { color: '#d7dbe3', type: 'dashed' } },
        formatter: function (ps) {
          var idx = ps[0].dataIndex;
          var s = shots[idx];
          return '<b>' + xs[idx] + '</b><br/>' +
            '综合评分：<b>' + scores[idx] + '</b><br/>' +
            '出手角度：<b>' + (angles[idx] == null ? '未测出' : angles[idx] + '°') + '</b>' +
            (angles[idx] == null ? '（球太小，这一球的角度没算出来）' : '（理想 45–52°）') + '<br/>' +
            '结果：' + (s.made ? '<span style="color:#16a34a">命中</span>' : '<span style="color:#94a3b8">未中</span>');
        }
      },
      legend: {
        top: big ? 12 : 0, right: big ? 14 : 4,
        icon: 'roundRect', itemWidth: 10, itemHeight: 10, itemGap: 14,
        textStyle: { color: '#5b6472', fontSize: 12 + fs, fontFamily: FONT }
      },
      xAxis: {
        type: 'category',
        data: xs,
        boundaryGap: false,
        axisLine: { lineStyle: { color: '#e8eaee' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#8b94a3', fontSize: 11 + fs, fontFamily: FONT,
          /* 放大后才把所有「第 N 次」都写出来，窄图里写全会叠字 */
          interval: big ? 0 : 'auto'
        }
      },
      yAxis: [
        {
          type: 'value', min: 30, max: 100, 
          splitLine: { lineStyle: { color: '#f1f3f6' } },
          axisLabel: { color: '#8b94a3', fontSize: 11 + fs }
        },
        {
          type: 'value', min: 35, max: 60, 
          splitLine: { show: false },
          axisLabel: { color: '#8b94a3', fontSize: 11 + fs }
        }
      ],
      series: [
        {
          name: '综合评分',
          type: 'line',
          smooth: true,
          symbol: 'circle',
          symbolSize: 7,
          data: scores,
          itemStyle: { color: C_USER, borderColor: '#fff', borderWidth: 2 },
          lineStyle: { color: C_USER, width: 2.5 },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(249,115,22,0.22)' },
                { offset: 1, color: 'rgba(249,115,22,0.01)' }
              ]
            }
          },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: '#cbd5e1', type: 'dashed', width: 1 },
            label: { formatter: '达标线 80', color: '#94a3b8', fontSize: 10, position: 'insideStartTop' },
            data: [{ yAxis: 80 }]
          }
        },
        {
          name: '出手角度(°)',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          symbol: 'diamond',
          symbolSize: 7,
          data: angles,
          itemStyle: { color: C_STAR, borderColor: '#fff', borderWidth: 2 },
          lineStyle: { color: C_STAR, width: 2, type: [5, 3] },
          markArea: {
            silent: true,
            itemStyle: { color: 'rgba(37,99,235,0.045)' },
            label: { show: false },
            data: [[{ yAxis: 45 }, { yAxis: 52 }]]
          },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: { color: 'rgba(37,99,235,0.55)', type: 'dotted', width: 1.5 },
            label: { formatter: '球星 ' + starAngle + '°', color: C_STAR, fontSize: 10, position: 'insideEndTop' },
            data: [{ yAxis: starAngle }]
          }
        }
      ]
    };
  }

  /* ---------------- 出手时序曲线（实验模式） ----------------
     curve 每一行是 [相对秒, 手腕高度(归一), 肘角, 膝角]，来自真实骨骼序列。
     这张图回答的是「这一次出手，身体各段是怎么配合的」，
     和多次出手的趋势图不是一回事，所以单独一条路径。 */
  function curveOption(curve, marks, big) {
    var ts = curve.map(function (c) { return c[0].toFixed(2); });
    var wrist = curve.map(function (c) { return c[1] == null ? null : +(c[1] * 100).toFixed(1); });
    var elbow = curve.map(function (c) { return c[2]; });
    var knee = curve.map(function (c) { return c[3]; });
    var mk = marks || {};
    var fs = big ? 1 : 0;

    return {
      animationDuration: 500,
      grid: big
        ? { left: 58, right: 76, top: 52, bottom: 92 }
        : { left: 42, right: 46, top: 34, bottom: 26 },
      dataZoom: big ? [
        { type: 'inside', zoomOnMouseWheel: true, moveOnMouseWheel: false, moveOnMouseMove: true },
        {
          type: 'slider', height: 20, bottom: 16, borderColor: 'transparent',
          backgroundColor: '#f1f3f6', fillerColor: 'rgba(249,115,22,.12)',
          handleStyle: { color: '#fff', borderColor: '#d7dbe3' },
          moveHandleSize: 4,
          textStyle: { color: '#8b94a3', fontSize: 10 }
        }
      ] : [],
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,0.98)',
        borderColor: '#e8eaee',
        textStyle: { color: '#1a1d24', fontSize: 12 },
        extraCssText: 'box-shadow:0 6px 20px rgba(16,24,40,.10);border-radius:10px;padding:8px 12px;',
        formatter: function (ps) {
          var i = ps[0].dataIndex;
          return '<b>' + (+ts[i]).toFixed(2) + 's</b><br/>' +
            '手腕高度：<b>' + (wrist[i] == null ? '—' : wrist[i] + '') + '</b>（×身体尺度）<br/>' +
            '肘角：<b>' + (elbow[i] == null ? '—' : elbow[i] + '°') + '</b><br/>' +
            '膝角：<b>' + (knee[i] == null ? '—' : knee[i] + '°') + '</b>';
        }
      },
      legend: {
        top: big ? 12 : 0, right: big ? 14 : 4,
        icon: 'roundRect', itemWidth: 10, itemHeight: 10, itemGap: 12,
        textStyle: { color: '#5b6472', fontSize: 11.5 + fs, fontFamily: FONT }
      },
      xAxis: {
        type: 'category',
        data: ts,
        boundaryGap: false,
        axisLine: { lineStyle: { color: '#e8eaee' } },
        axisTick: { show: false },
        axisLabel: {
          color: '#8b94a3', fontSize: 11 + fs,
          interval: big ? Math.max(1, Math.round(ts.length / 18)) - 1
            : Math.max(1, Math.floor(ts.length / 6)) - 1,
          formatter: function (v) { return (+v).toFixed(1) + 's'; }
        }
      },
      yAxis: [
        {
          type: 'value', name: '角度(°)', nameTextStyle: { color: '#a8b0bd', fontSize: 10 },
          min: 0, max: 190,
          splitLine: { lineStyle: { color: '#f1f3f6' } },
          axisLabel: { color: '#8b94a3', fontSize: 10.5 }
        },
        {
          type: 'value', name: '手腕高', nameTextStyle: { color: '#a8b0bd', fontSize: 10 },
          min: 50, max: 170,
          splitLine: { show: false },
          axisLabel: { color: '#8b94a3', fontSize: 10.5 }
        }
      ],
      series: [
        {
          name: '手腕高度×100',
          type: 'line', yAxisIndex: 1, smooth: true, symbol: 'none',
          data: wrist,
          lineStyle: { color: C_USER, width: 2.6 },
          areaStyle: {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(249,115,22,0.20)' },
                { offset: 1, color: 'rgba(249,115,22,0.01)' }
              ]
            }
          },
          markLine: {
            silent: true, symbol: 'none',
            label: { fontSize: 10, position: 'insideEndTop' },
            data: (function () {
              var arr = [];
              if (mk.dipIdx != null) {
                arr.push({
                  xAxis: mk.dipIdx,
                  lineStyle: { color: 'rgba(16,185,129,0.9)', width: 1.4, type: [4, 4] },
                  label: { formatter: '下蹲', color: '#0f9d76' }
                });
              }
              /* 一段视频里可能有多次出手，每次都标一条竖线 */
              var rel = mk.releases && mk.releases.length ? mk.releases : (mk.releaseIdx == null ? [] : [mk.releaseIdx]);
              rel.forEach(function (i, k) {
                arr.push({
                  xAxis: i,
                  lineStyle: { color: 'rgba(249,115,22,0.95)', width: 2 },
                  label: { formatter: k === 0 ? '出手' : '出手' + (k + 1), color: C_USER }
                });
              });
              return arr;
            })()
          }
        },
        {
          name: '肘角(°)',
          type: 'line', smooth: true, symbol: 'none',
          data: elbow,
          lineStyle: { color: C_STAR, width: 2 }
        },
        {
          name: '膝角(°)',
          type: 'line', smooth: true, symbol: 'none',
          data: knee,
          lineStyle: { color: '#10b981', width: 1.8, type: [5, 3] }
        }
      ]
    };
  }

  /* ---------------- 放大层 ----------------
     卡片里是半屏宽，20 次出手的点会挤在一起，读数根本看不清。
     点「放大」开一层大图，并给趋势图配上滚轮缩放 + 底部滑块。 */
  /* 卡片被实验模式换成时序曲线时，标题要跟着改 —— 不然写着「出手趋势」，
     画的却是手腕/肘/膝，对不上。 */
  function setCardHead(isCurve) {
    var el = document.getElementById('trendChart');
    if (!el) return;
    var card = el.closest('.chart-card');
    if (!card) return;
    var h = card.querySelector('.card-head h2');
    var sub = card.querySelector('.card-head .sub');
    if (h) h.textContent = isCurve ? '出手时序' : '出手趋势';
    if (sub) sub.textContent = isCurve ? '手腕 / 肘 / 膝' : '综合评分 / 出手角度';
  }

  function paintTabs() {
    var tabs = document.getElementById('czTabs');
    if (!tabs) return;
    tabs.querySelectorAll('button').forEach(function (b) {
      /* 没有曲线数据时「动作时序」没有意义，直接不给选 */
      if (b.dataset.view === 'curve') b.hidden = !last.curve;
      b.classList.toggle('on', b.dataset.view === zoomView);
    });
    tabs.hidden = zoomKind !== 'trend';
  }

  function openZoom(kind) {
    zoomEl = zoomEl || document.getElementById('chartZoom');
    if (!zoomEl) return;
    zoomKind = kind;
    /* 从卡片进来时，先看卡片上正在画的那一种 */
    zoomView = (kind === 'trend' && last.curve) ? 'curve' : 'trend';
    var t = document.getElementById('czTitle');
    var s = document.getElementById('czSub');
    if (t) t.textContent = zoomKind === 'radar' ? '动作维度对比'
      : (zoomView === 'curve' ? '动作时序' : '出手趋势');
    if (s) {
      s.textContent = zoomKind === 'radar'
        ? '我 vs 球星基准，八维逐项对比'
        : '滚轮缩放，按住拖动平移';
    }
    paintTabs();
    zoomEl.hidden = false;
    /* 先让它上屏拿到尺寸，再 init —— 在 display:none 里 init 出来是 0×0 */
    requestAnimationFrame(function () {
      zoomEl.classList.add('show');
      requestAnimationFrame(function () { renderZoom(true); });
    });
  }

  function closeZoom() {
    if (!zoomEl || zoomEl.hidden) return;
    zoomEl.classList.remove('show');
    setTimeout(function () { if (zoomEl) zoomEl.hidden = true; }, 180);
  }

  function zoomOption() {
    if (!last.shots) return null;
    var avg = BB.metrics.average(last.shots);
    var starRadar = BB.metrics.radarOf(last.star.raw);
    if (zoomKind === 'radar') {
      var o = radarOption(avg.radar, starRadar, last.star.name);
      o.radar.center = ['50%', '50%'];
      o.radar.radius = '70%';
      o.radar.axisName.fontSize = 13;
      o.legend.bottom = 8;
      o.radar.splitNumber = 5;
      return o;
    }
    if (zoomView === 'curve' && last.curve) return curveOption(last.curve, last.marks, true);
    return trendOption(last.shots, last.star.raw, true);
  }

  /* 不销毁重建，只换 option。
     重建过一次出过问题：滚轮缩放过以后再切视图，旧画布会留在容器里，
     看到的还是上一张图。同一个实例 notMerge 就够了，换雷达/折线也支持。 */
  function renderZoom() {
    var body = document.getElementById('czBody');
    if (!body || !zoomEl || zoomEl.hidden) return;
    if (!hasLib()) { body.innerHTML = '<div class="chart-fail">ECharts 未加载</div>'; return; }
    var o = zoomOption();
    if (!o) { body.innerHTML = '<div class="chart-fail">选一段视频后显示</div>'; return; }
    if (!zoomChart) {
      body.innerHTML = '';
      zoomChart = echarts.init(body);
    }
    zoomChart.setOption(o, true);
    zoomChart.resize();
  }

  function bindZoom() {
    document.querySelectorAll('.zoom-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { openZoom(btn.dataset.chart); });
    });
    zoomEl = document.getElementById('chartZoom');
    if (!zoomEl) return;
    var tabs = document.getElementById('czTabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b || b.hidden) return;
        zoomView = b.dataset.view;
        paintTabs();
        var t = document.getElementById('czTitle');
        if (t) t.textContent = zoomView === 'curve' ? '动作时序' : '出手趋势';
        renderZoom(true);
      });
    }
    var close = document.getElementById('czClose');
    if (close) close.addEventListener('click', closeZoom);
    /* 点面板外面关闭；点图本身不关 */
    zoomEl.addEventListener('click', function (e) {
      if (e.target === zoomEl) closeZoom();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeZoom();
    });
  }

  function init() {
    var rEl = document.getElementById('radarChart');
    var tEl = document.getElementById('trendChart');
    if (!hasLib()) {
      failHint(rEl, 'ECharts 未加载：请确认 vendor/echarts.min.js 存在');
      failHint(tEl, 'ECharts 未加载：请确认 vendor/echarts.min.js 存在');
      return false;
    }
    radar = echarts.init(rEl);
    trend = echarts.init(tEl);
    bindZoom();
    window.addEventListener('resize', function () { resize(); });
    return true;
  }

  function update(shots, star) {
    if (!radar || !trend) return;
    last = { shots: shots, star: star, curve: null, marks: null };
    setCardHead(false);
    var avg = BB.metrics.average(shots);
    var starRadar = BB.metrics.radarOf(star.raw);
    radar.setOption(radarOption(avg.radar, starRadar, star.name), true);
    trend.setOption(trendOption(shots, star.raw), true);
    if (zoomEl && !zoomEl.hidden) renderZoom(false);
  }

  /* 实验模式：雷达照旧，趋势图换成真实出手时序 */
  function updateExp(shots, star, curve, marks) {
    if (!radar || !trend) return;
    var cv = (curve && curve.length) ? curve : null;
    last = { shots: shots, star: star, curve: cv, marks: marks };
    setCardHead(!!cv);
    var avg = BB.metrics.average(shots);
    var starRadar = BB.metrics.radarOf(star.raw);
    radar.setOption(radarOption(avg.radar, starRadar, star.name), true);
    /* 没有骨骼序列就别画一张空坐标轴，退回趋势图 */
    trend.setOption(cv ? curveOption(cv, marks) : trendOption(shots, star.raw), true);
    if (zoomEl && !zoomEl.hidden) renderZoom(false);
  }

  /* 没有数据时不要画假点：两张图都给一句提示，比一条空坐标轴清楚 */
  function clear(msg) {
    if (!radar || !trend) return;
    last = { shots: null, star: null, curve: null, marks: null };
    setCardHead(false);
    if (zoomChart) { zoomChart.dispose(); zoomChart = null; }
    var body = document.getElementById('czBody');
    if (body) body.innerHTML = '';
    closeZoom();
    var o = {
      title: {
        text: msg || '选一段视频后显示',
        left: 'center', top: 'middle',
        textStyle: { color: '#a8b0bd', fontSize: 12, fontWeight: 400 }
      },
      xAxis: { show: false },
      yAxis: { show: false },
      series: []
    };
    radar.setOption(o, true);
    trend.setOption(o, true);
  }

  function resize() {
    if (radar) radar.resize();
    if (trend) trend.resize();
    if (zoomChart && zoomEl && !zoomEl.hidden) zoomChart.resize();
  }

  /* 调试用：确认放大层当前在画哪种视图 */
  function dbg() {
    return { view: zoomView, kind: zoomKind, hasCurve: !!last.curve, hasChart: !!zoomChart };
  }

  BB.Charts = { init: init, update: update, updateExp: updateExp, clear: clear, resize: resize, hasLib: hasLib, __dbg: dbg };
})(window.BB);
