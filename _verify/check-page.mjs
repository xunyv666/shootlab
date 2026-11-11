/**
 * 立定跳远页面的渲染自检（无头 Edge + CDP，零依赖）
 *
 * 做三件事：
 *   1) 起本地服务器，打开 #longjump，收控制台报错与页面异常；
 *   2) 截「空态」；
 *   3) 把一份离线分析结果喂给界面，截「有数据」状态，并断言关键元素都渲染出来了。
 *
 * 用法：node check-page.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

/* 这两个路径跟机器有关，用环境变量覆盖：PYTHON=... EDGE=... */
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PY = process.env.PYTHON || 'python';
/* 路径必须用 fileURLToPath 解：工作目录里有中文，pathname 是 percent-encoded 的 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');   // 仓库根目录
const SITE = ROOT;                                                  // 静态站点在 prototype/
const OUT = join(ROOT, '_verify');
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

const port = await freePort();
const userDir = mkdtempSync(join(tmpdir(), 'edge-lj-'));

const server = spawn(PY, ['tools/serve.py', String(port), 'prototype'], {
  stdio: 'ignore',
  cwd: SITE
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
  `--remote-debugging-port=${port + 1}`,
  `--user-data-dir=${userDir}`,
  'about:blank'
], { stdio: 'ignore' });

let ws;
const problems = [];
const assertions = [];

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
      /* MediaPipe 的模型/wasm 没下载，加载失败是预期内的，不算页面 bug */
      if (/wasm|model|task|fetch|Failed to load/i.test(txt)) return;
      problems.push('console.error: ' + txt);
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/index.html#longjump` });

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  };

  const waitFor = async (expr, timeout = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await ev(expr)) return true; } catch { /* 上下文切换中 */ }
      await sleep(200);
    }
    return false;
  };

  const ok = await waitFor(`document.readyState==='complete' && !!document.getElementById('longjumpPane')`);
  if (!ok) throw new Error('页面没加载起来');
  await ev(`document.documentElement.style.scrollBehavior='auto'; void 0`);
  await sleep(1200);

  /* ---- 路由断言：立定跳远面板可见、别的面板隐藏 ---- */
  assertions.push(['#longjump 路由到立定跳远面板',
    await ev(`!document.getElementById('longjumpPane').hidden`)]);

  /* ---- 空态截图 ---- */
  await send('Page.captureScreenshot', { format: 'png' }).then((s) =>
    writeFileSync(join(OUT, 'lj-empty.png'), Buffer.from(s.data, 'base64')));
  console.log('saved lj-empty.png');

  /* ---- 注入离线结果 ---- */
  const res = readFileSync(join(OUT, 'res-clean.json'), 'utf8');
  await ev(`window.__lj = ${res}; void 0`);
  const injected = await ev(`(function(){
    if (!window.BB || !window.BB.LongJump) return 'no BB.LongJump';
    window.BB.LongJump.preview(window.__lj);
    return 'ok';
  })()`);
  assertions.push(['结果注入: ' + injected, injected === 'ok']);
  await sleep(900);

  /* ---- 有数据时的 DOM 断言 ---- */
  const dom = await ev(`JSON.stringify({
    metrics: document.querySelectorAll('#ljMetrics .metric').length,
    metricVals: Array.from(document.querySelectorAll('#ljMetrics .m-val')).map(e => e.textContent.trim()),
    rows: document.querySelectorAll('#ljLogRows tr').length,
    marks: document.querySelectorAll('#ljTrackMarks .mark').length,
    bands: document.querySelectorAll('#ljTrackMarks .lj-flight-band').length,
    detail: document.querySelectorAll('#ljSummary .lj-detail-row').length,
    detailText: Array.from(document.querySelectorAll('#ljSummary .lj-detail-row')).map(e => e.textContent).join(' | '),
    verdict: (document.querySelector('#ljSummary .lj-verdict')||{}).textContent || '',
    sumCells: document.querySelectorAll('#ljSummary .sum-cell').length,
    chartW: (document.getElementById('ljChart')||{}).width,
    chartH: (document.getElementById('ljChart')||{}).height,
    overlayW: (document.getElementById('ljOverlay')||{}).width,
    stageChip: (document.getElementById('ljStageChip')||{}).textContent || '',
    badge: (document.getElementById('ljBadge')||{}).textContent || '',
    logHidden: document.getElementById('ljLogCard').hidden,
    rulerBarHidden: document.getElementById('ljRulerBar').hidden,
    docW: document.documentElement.scrollWidth,
    winW: innerWidth
  })`);
  const d = JSON.parse(dom);
  console.log(JSON.stringify(d, null, 2));

  assertions.push(['4 张指标卡', d.metrics === 4]);
  assertions.push(['指标卡有数值（不是 —）', d.metricVals.every((v) => v && v !== '—')]);
  assertions.push(['记录表 1 行', d.rows === 1]);
  assertions.push(['时间轴 1 个起跳标记', d.marks === 1]);
  assertions.push(['时间轴 1 段腾空带', d.bands === 1]);
  assertions.push(['小结细节 ≥4 行', d.detail >= 4]);
  assertions.push(['小结有建议文案', d.verdict.length > 12]);
  assertions.push(['小结 4 个格子', d.sumCells === 4]);
  /* res-clean 的三段峰值间隔只有 1ms，界面必须说「分不出先后」，
     不能印一个看着很精确的顺序出来 */
  assertions.push(['蹬伸顺序如实标注「分不出先后」', /几乎同时|分不出先后/.test(d.detailText)]);
  assertions.push(['时序图画布已按 DPR 铺开', d.chartW > 300 && d.chartH > 100]);
  assertions.push(['叠加层画布已铺开', d.overlayW > 100]);
  assertions.push(['记录表已显示', d.logHidden === false]);
  assertions.push(['标尺浮条默认隐藏', d.rulerBarHidden === true]);
  assertions.push(['没有横向溢出', d.docW <= d.winW + 1]);

  /* ---- 有数据截图：顶部 ---- */
  await ev(`window.scrollTo(0, 0); void 0`);
  await sleep(500);
  await send('Page.captureScreenshot', { format: 'png' }).then((s) =>
    writeFileSync(join(OUT, 'lj-result-top.png'), Buffer.from(s.data, 'base64')));
  console.log('saved lj-result-top.png');

  /* ---- 有数据截图：右列（指标卡 + 小结 + 时序图） ---- */
  const y2 = await ev(`Math.round(document.getElementById('ljMetrics').getBoundingClientRect().top + window.scrollY - 90)`);
  await ev(`window.scrollTo(0, ${y2}); void 0`);
  await sleep(700);
  await send('Page.captureScreenshot', { format: 'png' }).then((s) =>
    writeFileSync(join(OUT, 'lj-result-right.png'), Buffer.from(s.data, 'base64')));
  console.log('saved lj-result-right.png');

  /* ---- 标尺校准模式截图 ---- */
  await ev(`document.getElementById('ljRulerBtn').click(); void 0`);
  await sleep(600);
  const rulerOn = await ev(`JSON.stringify({
    barHidden: document.getElementById('ljRulerBar').hidden,
    cursor: getComputedStyle(document.getElementById('ljStage')).cursor
  })`);
  const r = JSON.parse(rulerOn);
  assertions.push(['标尺浮条可打开', r.barHidden === false]);
  assertions.push(['标尺模式十字光标', r.cursor === 'crosshair']);
  await send('Page.captureScreenshot', { format: 'png' }).then((s) =>
    writeFileSync(join(OUT, 'lj-ruler.png'), Buffer.from(s.data, 'base64')));
  console.log('saved lj-ruler.png');

  /* ---- 窄屏断点 ----
     先退出标尺模式，否则浮条会压住视频顶部，拍出来的不是默认状态 */
  await ev(`document.getElementById('ljRulerCancel').click(); void 0`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await ev(`window.scrollTo(0, 0); void 0`);
  await sleep(700);
  const narrow = await ev(`JSON.stringify({
    docW: document.documentElement.scrollWidth, winW: innerWidth,
    cols: getComputedStyle(document.getElementById('ljMetrics')).gridTemplateColumns
  })`);
  const n = JSON.parse(narrow);
  assertions.push(['390px 无横向溢出', n.docW <= n.winW + 1]);
  await send('Page.captureScreenshot', { format: 'png' }).then((s) =>
    writeFileSync(join(OUT, 'lj-narrow.png'), Buffer.from(s.data, 'base64')));
  console.log('saved lj-narrow.png');

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
console.log('\n' + (failed ? `❌ ${failed} 项未通过` : '✅ 渲染自检全部通过'));
process.exit(failed ? 1 : 0);
