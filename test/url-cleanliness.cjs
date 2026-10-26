// 检查各种进入方式下，地址栏最终显示什么
const puppeteer = require('D:/Stronghold-Protocol/shared/node_modules/puppeteer-core');
const BASE = 'https://stronghold.luobomiao.love';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  { name: '首页', url: `${BASE}/` },
  { name: '邀请短链 /r/CODE', url: `${BASE}/r/TRNU` },
  { name: '?room=CODE', url: `${BASE}/?room=TRNU` },
  { name: '?room=CODE&spectate=1', url: `${BASE}/?room=TRNU&spectate=1` },
  { name: '匹配参数 ?mm=1&mid=x&t=y', url: `${BASE}/?mm=1&mid=abc123&t=tok&tk=tk&d=NORMAL&c=4` },
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'],
  });

  for (const c of CASES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(c.url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(6000);
    const u = await page.evaluate(() => location.href);
    const shown = u.replace(BASE, '') || '/';
    const messy = /[?&]/.test(shown);
    console.log(`  ${c.name.padEnd(24)} → ${shown.padEnd(50)} ${messy ? '⚠ 带参数' : '✅ 干净'}`);
    await page.close();
  }

  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
