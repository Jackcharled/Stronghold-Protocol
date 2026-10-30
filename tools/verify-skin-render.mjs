// 验证修复后：进对局，盟约成员头像是否真的显示出来。
//   SP_E2E_NODE=5 SP_E2E_ACCOUNT=2 node tools/verify-skin-render.mjs
//
// 关键判据（不是猜）：
//   - 图片元素的 naturalWidth > 0  → 真的解码出来了
//   - 请求是否真的发出（performance 里有记录）
//   - 走的域名是本机还是资源站
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.SP_E2E_BASE || 'https://stronghold.luobomiao.love';
const NODE = process.env.SP_E2E_NODE || '5';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
const acc = JSON.parse(readFileSync('../.secrets/test-accounts.json', 'utf8')).accounts[Number(process.env.SP_E2E_ACCOUNT || 2)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

const domains = { local: 0, origin: 0 };
page.on('request', (r) => {
  const u = r.url();
  if (!/\.(png|webp)(\?|$)/i.test(u)) return;
  if (u.includes('assets.luobomiao.love')) domains.origin++;
  else if (u.startsWith('https://stronghold.luobomiao.love')) domains.local++;
});

try {
  await page.goto(`${BASE}/?n=${NODE}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(4000);
  await page.evaluate(async (email, pw) => {
    const cap = await fetch('/mm/api/auth/captcha', { credentials: 'same-origin' }).then((r) => r.json());
    const code = [...String(cap.svg || '').matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1].trim()).join('');
    await fetch('/mm/api/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: pw, captcha: code, captchaId: cap.id }),
    });
  }, acc.email, acc.password);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(5000);

  log('== 进大厅 → 干员调配');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '开始' && !x.disabled && x.offsetParent);
    if (b) b.click();
  });
  await sleep(4000);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button,[role=button]')].find((x) => /干员调配/.test(x.textContent || '') && x.offsetParent);
    if (b) b.click();
  });
  await sleep(10000);

  // 只统计「在视口内、尺寸合理」的图
  const stats = await page.evaluate(() => {
    const vh = window.innerHeight, vw = window.innerWidth;
    const vis = [];
    for (const el of document.querySelectorAll('img')) {
      if (!el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) continue;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      vis.push({ natural: el.naturalWidth, complete: el.complete, src: (el.currentSrc || el.src || '').slice(0, 90) });
    }
    return {
      visible: vis.length,
      loaded: vis.filter((v) => v.natural > 0).length,
      blank: vis.filter((v) => !(v.natural > 0)),
      pending: vis.filter((v) => !v.complete).length,
    };
  });

  log(`\n=== 视口内 ≥20px 的图片 ===`);
  log(`  总数: ${stats.visible}`);
  log(`  已加载: ${stats.loaded}`);
  log(`  空白: ${stats.blank.length}  (其中仍 pending: ${stats.pending})`);
  log(`\n=== 图片请求域名分布 ===`);
  log(`  本机 /assets/: ${domains.local}`);
  log(`  资源站直连:    ${domains.origin}`);

  if (stats.blank.length) {
    log('\n空白样例（前 8 个）:');
    stats.blank.slice(0, 8).forEach((b) => log('  ✗ ' + b.src));
  }

  await page.screenshot({ path: 'test/e2e/out/verify-skin.png' });
  log('\n截图: test/e2e/out/verify-skin.png');
} catch (e) {
  log('异常: ' + (e && e.message));
} finally {
  await browser.close();
}
