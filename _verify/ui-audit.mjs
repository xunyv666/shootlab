/**
 * UI 美化自检（无头 Edge + CDP，零依赖）
 *
 * 覆盖四个项目界面 × 桌面/窄屏：
 *   1) 收集控制台报错与页面异常；
 *   2) 断言没有横向溢出、面板切换正确；
 *   3) 抽查设计令牌是否真的落到计算样式上；
 *   4) 截图，供人工核对视觉。
 *
 * 用法：node ui-audit.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PY = process.env.PYTHON || 'python';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '_verify', 'shots');
const W = 1440, H = 960;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

async function getWsUrl(port, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await res.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('DevTools endpoint not reachable');
}

function rpc(ws, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = (rpc._id = (rpc._id || 0) + 1);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const onMsg = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data.toString()); } catch { return; }
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify(payload));
  });
}

mkdirSync(OUT, { recursive: true });

const port = await freePort();
const userDir = mkdtempSync(join(tmpdir(), 'edge-ui-'));

const server = spawn(PY, ['tools/serve.py', String(port), 'prototype'], {
  stdio: 'ignore',
  cwd: ROOT
});

const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--no-proxy-server',
  '--proxy-bypass-list=*',
  '--force-device-scale-factor=1',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${port + 1}`,
  `--user-data-dir=${userDir}`,
  'about:blank'
], { stdio: 'ignore' });

let ws;
const problems = [];
const assertions = [];
const push = (name, pass, extra = '') => assertions.push([name + (extra ? ' · ' + extra : ''), !!pass]);

try {
  const wsUrl = await getWsUrl(port + 1);
  ws = new globalThis.WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  const { targetId } = await rpc(ws, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc(ws, 'Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => rpc(ws, m, p, sessionId);

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data.toString()); } catch { return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      problems.push('异常: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      const txt = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      /* 模型/wasm 资源在无头环境加载失败属预期，不算界面问题 */
      if (/wasm|model|task|fetch|Failed to load|WebGL|GPU/i.test(txt)) return;
      problems.push('console.error: ' + txt);
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html#basketball` });

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  };

  const waitFor = async (expr, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await ev(expr)) return true; } catch { /* 上下文切换中 */ }
      await sleep(200);
    }
    return false;
  };

  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name + '.png'), Buffer.from(s.data, 'base64'));
  };

  const setHash = async (h) => {
    await ev(`location.hash = ${JSON.stringify('#' + h)}; void 0`);
    await sleep(800);
  };

  const overflow = async (label) => {
    const d = JSON.parse(await ev(`JSON.stringify({
      docW: document.documentElement.scrollWidth,
      winW: innerWidth,
      culprit: (function(){
        var w = innerWidth, out = [];
        document.querySelectorAll('body *').forEach(function(el){
          var r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > w + 2) {
            var cs = getComputedStyle(el);
            if (cs.position === 'fixed') return;
            out.push(el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0] + ' right=' + Math.round(r.right));
          }
        });
        return out.slice(0, 5);
      })()
    })`));
    push(`${label} 无横向溢出`, d.docW <= d.winW + 1, `doc ${d.docW}/${d.winW}${d.culprit.length ? ' · ' + d.culprit.join(', ') : ''}`);
  };

  /* 空态卡内文字是否被固定比例的视频框裁掉 */
  const fit = async (sel) => ev(`JSON.stringify((function(){
    var stage = document.querySelector('${sel} .stage');
    var drop = stage && stage.querySelector('.drop:not([style*="none"])');
    if (!stage || !drop) return null;
    var s = stage.getBoundingClientRect();
    var kids = Array.from(drop.children).filter(function(el){
      return getComputedStyle(el).display !== 'none';
    });
    var last = kids[kids.length - 1];
    var lr = last ? last.getBoundingClientRect() : null;
    return {
      stageH: Math.round(s.height),
      dropScrollH: drop.scrollHeight,
      dropClientH: drop.clientHeight,
      overflow: drop.scrollHeight - drop.clientHeight,
      lastBottomGap: lr ? Math.round(s.bottom - lr.bottom) : null
    };
  })())`);

  const checkFit = async (sel, label) => {
    const raw = await fit(sel);
    console.log(`FIT ${label} ${raw}`);
    const d = raw ? JSON.parse(raw) : null;
    push(`${label} 空态文字未被裁切`, d && d.lastBottomGap >= 8, raw || 'no drop');
  };

  const ok = await waitFor(`document.readyState==='complete' && !!document.getElementById('bbPane')`);
  if (!ok) throw new Error('页面没加载起来');
  await ev(`document.documentElement.style.scrollBehavior='auto'; void 0`);
  await sleep(1000);

  /* ================= 桌面 1440 ================= */
  await checkFit('#bbPane', '篮球');
  console.log('LEFT ' + await ev(`JSON.stringify((function(){
    var c = document.querySelector('#bbPane .col-left');
    if (!c) return null;
    var r = c.getBoundingClientRect();
    return {
      top: Math.round(r.top), h: Math.round(r.height), vh: innerHeight,
      sticky: getComputedStyle(c).position,
      offscreen: Math.round(r.bottom - innerHeight)
    };
  })())`));
  /* 篮球：注入示例数据，让指标卡 / 表格 / 图表都有内容 */
  await ev(`document.getElementById('btnExperiment').click(); void 0`);
  await sleep(1200);
  console.log('LEFT loaded ' + await ev(`JSON.stringify((function(){
    var c = document.querySelector('#bbPane .col-left');
    var r = c.getBoundingClientRect();
    return { h: Math.round(r.height), bottom: Math.round(r.bottom), vh: innerHeight, offscreen: Math.round(r.bottom - innerHeight) };
  })())`));
  await overflow('篮球 · 分析（1440）');
  await shot('01-bb-analyze-1440');

  const bb = JSON.parse(await ev(`JSON.stringify({
    metrics: document.querySelectorAll('#metrics .metric').length,
    rows: document.querySelectorAll('#shotRows tr').length,
    sum: document.querySelectorAll('#sumCard .sum-cell').length,
    filled: Array.from(document.querySelectorAll('#metrics .m-val')).map(e => e.textContent.trim()).filter(v => v && v !== '—').length
  })`));
  push('篮球示例数据已渲染', bb.metrics >= 3 && bb.rows >= 1, JSON.stringify(bb));

  await setHash('compare');
  await overflow('篮球 · 对比（1440）');
  await shot('02-bb-compare-1440');

  await setHash('zone');
  await overflow('篮球 · 点位（1440）');
  await shot('03-bb-zone-1440');

  /* 3D 轨迹画布是否有内容（切到点位视图时数据已提前注入） */
  const arcBefore = await ev(`JSON.stringify((function(){
    var c = document.querySelector('.arc-canvas'); if (!c) return null;
    var g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    var n = 0;
    for (var i = 3; i < g.length; i += 40) if (g[i] > 0) n++;
    return { w: c.width, h: c.height, alphaSamples: n };
  })())`);
  console.log('ARC before resize ' + arcBefore);
  await ev(`window.dispatchEvent(new Event('resize')); void 0`);
  await sleep(600);
  const arcAfter = await ev(`JSON.stringify((function(){
    var c = document.querySelector('.arc-canvas');
    var g = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    var n = 0;
    for (var i = 3; i < g.length; i += 40) if (g[i] > 0) n++;
    return { w: c.width, h: c.height, alphaSamples: n };
  })())`);
  console.log('ARC after resize  ' + arcAfter);
  push('3D 轨迹画布已绘制', JSON.parse(arcBefore).alphaSamples > 100, arcBefore);
  await shot('03b-bb-zone-1440-resized');

  await setHash('rope');
  await overflow('跳绳（1440）');
  await shot('04-rope-1440');

  await checkFit('#ropePane', '跳绳');

  await setHash('pushup');
  await overflow('俯卧撑（1440）');
  await shot('05-pushup-1440');
  await checkFit('#pushupPane', '俯卧撑');

  await setHash('longjump');
  await ev(`(function(){
    var res = ${readFileSync(join(ROOT, '_verify', 'res-clean.json'), 'utf8')};
    if (window.BB && window.BB.LongJump && BB.LongJump.preview) BB.LongJump.preview(res);
  })(); void 0`);
  await sleep(900);
  await overflow('立定跳远（1440）');
  await shot('06-longjump-1440');

  const lj = JSON.parse(await ev(`JSON.stringify({
    metrics: document.querySelectorAll('#ljMetrics .metric').length,
    rows: document.querySelectorAll('#ljLogRows tr').length,
    sum: document.querySelectorAll('#ljSummary .sum-cell').length
  })`));
  push('立定跳远示例数据已渲染', lj.metrics === 4 && lj.rows >= 1 && lj.sum === 4, JSON.stringify(lj));

  /* ---- 设计令牌是否真的落地 ---- */
  await setHash('basketball');
  await setHash('analyze');
  const tokens = JSON.parse(await ev(`JSON.stringify((function(){
    var pick = function(sel, props){
      var el = document.querySelector(sel);
      if (!el) return null;
      var cs = getComputedStyle(el);
      var o = {};
      props.forEach(function(p){ o[p] = cs[p]; });
      return o;
    };
    return {
      body: pick('body', ['fontSize', 'lineHeight', 'fontFamily']),
      card: pick('#sumCard', ['borderRadius', 'borderColor', 'boxShadow']),
      btn: pick('#btnExperiment', ['borderRadius', 'fontWeight', 'minHeight', 'backgroundColor']),
      h2: pick('#sumCard h2', ['fontSize', 'letterSpacing', 'fontWeight']),
      chipActive: pick('.chip.active', ['borderRadius', 'backgroundColor']),
      tabActive: pick('.project-tab.active', ['borderRadius', 'backgroundImage']),
      input: pick('#heightInput', ['borderRadius', 'borderColor']),
      nav: pick('.views', ['borderRadius', 'padding'])
    };
  })())`));
  console.log('TOKENS ' + JSON.stringify(tokens, null, 2));
  push('卡片圆角来自令牌（16px）', tokens.card && tokens.card.borderRadius === '16px', tokens.card?.borderRadius);
  push('按钮圆角来自令牌（10px）', tokens.btn && tokens.btn.borderRadius === '10px', tokens.btn?.borderRadius);
  push('输入框圆角来自令牌（7px）', tokens.input && tokens.input.borderRadius === '7px', tokens.input?.borderRadius);
  push('一级导航为胶囊形', tokens.tabActive && tokens.tabActive.borderRadius === '999px', tokens.tabActive?.borderRadius);
  push('底部胶囊为胶囊形', tokens.nav && tokens.nav.borderRadius === '999px', tokens.nav?.borderRadius);
  push('卡片标题字号 11px', tokens.h2 && tokens.h2.fontSize === '11px', tokens.h2?.fontSize);
  push('卡片标题带字距', tokens.h2 && parseFloat(tokens.h2.letterSpacing) > 0.8, tokens.h2?.letterSpacing);

  /* 左上角 Logo 是否真的加载出图片 */
  const logo = JSON.parse(await ev(`JSON.stringify((function(){
    var i = document.querySelector('.logo img');
    if (!i) return { exists: false };
    var r = i.getBoundingClientRect();
    return {
      exists: true,
      loaded: i.complete && i.naturalWidth > 0,
      src: i.getAttribute('src'),
      w: Math.round(r.width),
      h: Math.round(r.height),
      radius: getComputedStyle(i.parentElement).borderRadius
    };
  })())`));
  console.log('LOGO ' + JSON.stringify(logo));
  push('Logo 图标已加载（favicon.ico）', logo.exists && logo.loaded && logo.src === 'favicon.ico', JSON.stringify(logo));
  push('Logo 保持 36×36 方形位', logo.w === 36 && logo.h === 36, `${logo.w}x${logo.h}`);

  /* ---- 样式表是否被语法错误截断（CSSOM 能读到即为解析成功） ---- */
  const cssInfo = JSON.parse(await ev(`JSON.stringify((function(){
    var out = [];
    function walk(rules){
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (r.selectorText) out.push(r.selectorText);
        if (r.cssRules) walk(r.cssRules);
      }
    }
    for (var i = 0; i < document.styleSheets.length; i++) {
      try { walk(document.styleSheets[i].cssRules); } catch (e) {}
    }
    return {
      count: out.length,
      btnDisabled: out.some(function(s){ return s.indexOf('.btn:disabled') >= 0; }),
      cardBar: out.indexOf('.card-head h2::before') >= 0,
      dropChild: out.indexOf('.drop > *') >= 0,
      camDisabled: out.indexOf('.btn-cam:disabled') >= 0,
      focusRing: out.some(function(s){ return s.indexOf(':focus-visible') >= 0; })
    };
  })())`));
  console.log('CSS ' + JSON.stringify(cssInfo));
  push('样式表解析完整（规则数 > 300）', cssInfo.count > 300, String(cssInfo.count));
  push('新增状态规则已生效', cssInfo.btnDisabled && cssInfo.camDisabled && cssInfo.dropChild && cssInfo.cardBar, JSON.stringify(cssInfo));
  push('键盘焦点样式已定义', cssInfo.focusRing);

  /* ---- 交互状态：hover / disabled 的视觉反馈 ---- */
  const states = JSON.parse(await ev(`JSON.stringify((function(){
    var ghost = document.getElementById('btnGhost');
    var before = getComputedStyle(ghost).backgroundColor;
    ghost.classList.add('on');
    var on = getComputedStyle(ghost).backgroundImage;
    ghost.classList.remove('on');
    var btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.disabled = true;
    document.body.appendChild(btn);
    var dis = getComputedStyle(btn);
    var out = {
      ghostBefore: before,
      ghostOnGradient: on,
      disabledOpacity: dis.opacity,
      disabledCursor: dis.cursor,
      disabledShadow: dis.boxShadow,
      transition: getComputedStyle(ghost).transitionProperty
    };
    btn.remove();
    return out;
  })())`));
  console.log('STATES ' + JSON.stringify(states, null, 2));
  push('开启态有主色渐变反馈', /gradient/.test(states.ghostOnGradient || ''));
  push('disabled 按钮透明度降低', parseFloat(states.disabledOpacity) < .6, states.disabledOpacity);
  push('disabled 按钮禁用光标', states.disabledCursor === 'not-allowed', states.disabledCursor);
  push('交互元素声明了过渡属性', /background|border/.test(states.transition || ''), states.transition);

  /* ================= 平板 1024 / 768 ================= */
  for (const w of [1024, 768]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    for (const h of ['basketball', 'rope', 'pushup', 'longjump']) {
      await setHash(h);
      await overflow(`${h} · ${w}`);
    }
    await setHash('basketball');
    await sleep(400);
    await shot(`12-bb-analyze-${w}`);
  }

  /* ================= 窄屏 390 ================= */
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(600);

  const panes = [
    ['basketball', '07-bb-analyze-390'],
    ['rope', '08-rope-390'],
    ['pushup', '09-pushup-390'],
    ['longjump', '10-longjump-390']
  ];
  for (const [hash, name] of panes) {
    await setHash(hash);
    await ev(`document.getElementById('${hash === 'basketball' ? 'bbPane' : hash + 'Pane'}').scrollIntoView({block:'start'}); window.scrollTo(0,0); void 0`);
    await sleep(500);
    await overflow(`${hash} · 390`);
    await shot(name);
  }

  /* 窄屏：指标卡不重叠、底部导航可点 */
  await setHash('basketball');
  const narrow = JSON.parse(await ev(`JSON.stringify({
    docW: document.documentElement.scrollWidth,
    winW: innerWidth,
    navVisible: (function(){ var r = document.querySelector('.views').getBoundingClientRect(); return r.width > 0 && r.bottom <= innerHeight + 1; })(),
    cols: getComputedStyle(document.getElementById('metrics')).gridTemplateColumns
  })`));
  push('390px 底部导航完整可见', narrow.navVisible, JSON.stringify(narrow));
  push('390px 指标卡栅格有效', /px/.test(narrow.cols || ''), narrow.cols);

  /* 390px 打开对比视图，确认图表卡不溢出 */
  await setHash('compare');
  await overflow('篮球 · 对比 · 390');
  await shot('11-bb-compare-390');

} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill();
  server.kill();
  await sleep(400);
  try { rmSync(userDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n--- 断言 ---');
let failed = 0;
for (const [name, pass] of assertions) {
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
}
if (problems.length) {
  console.log('\n--- 页面报错 ---');
  problems.forEach((p) => console.log('  ' + p));
}
console.log('\n截图目录: ' + OUT);
console.log(failed ? `❌ ${failed} 项未通过` : '✅ UI 自检全部通过');
process.exit(failed ? 1 : 0);
