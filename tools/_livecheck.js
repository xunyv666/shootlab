const { chromium } = require('E:/桌面/篮球/node_modules/playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
  const b = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 140)));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 120)); });

  console.log('打开线上站（冷缓存，19MB 要现下）…');
  const t0 = Date.now();
  await p.goto('https://shootlab.pages.dev/', { waitUntil: 'load', timeout: 90000 });

  const seen = [];
  for (let i = 0; i < 60; i++) {
    await p.waitForTimeout(3000);
    const s = await p.evaluate(() => {
      const h = document.getElementById('engineHint');
      const cta = document.getElementById('coachCta');
      return { hint: h && !h.hidden ? h.innerText.replace(/\s+/g, ' ').slice(0, 40) : null, cta: cta ? !cta.hidden : false };
    });
    if (s.hint && !seen.includes(s.hint)) { seen.push(s.hint); console.log('  [' + ((Date.now() - t0) / 1000).toFixed(0) + 's]', s.hint); }
    if (!s.hint) break;
  }
  console.log('引擎就绪耗时:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('进度文案变化次数:', seen.length);

  const a = await p.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    hintHidden: document.getElementById('engineHint').hidden
  }));
  console.log('横向溢出:', a.overflow, '| 提示条已隐藏:', a.hintHidden);

  // 真跑一次分析
  const t1 = Date.now();
  await p.setInputFiles('#fileInput', 'E:/桌面/篮球/media/amateur_18s.webm');
  await p.waitForFunction(() => { const c = document.getElementById('coachCta'); return c && !c.hidden; }, null, { timeout: 240000 });
  const r = await p.evaluate(() => ({ shots: BB.__lastExp.shots.length, prob: document.getElementById('probCard').innerText.replace(/\s+/g, ' ').slice(0, 30) }));
  console.log('分析完成', ((Date.now() - t1) / 1000).toFixed(0) + 's | 出手', r.shots, '| 概率', r.prob);
  console.log('错误:', errs.length ? [...new Set(errs)].slice(0, 4) : '无');
  await b.close();
})();
