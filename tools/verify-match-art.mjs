// 验证修复后「对局内」的立绘是否正常：商店、干员卡、盟约面板。
//
//   SP_E2E_NODE=5 SP_E2E_ACCOUNT=3 node tools/verify-match-art.mjs
//
// 判据（数据，不是感觉）：
//   1. 视口内图片的 naturalWidth > 0 比例
//   2. 图片请求走本机 /assets/ 还是资源站
//   3. 有没有 >1s 的慢请求
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.SP_E2E_BASE || 'https://stronghold.luobomiao.love';
const NODE = process.env.SP_E2E_NODE || '5';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
const acc = JSON.parse(readFileSync('../.secrets/test-accounts.json', 'utf8')).accounts[Number(process.env.SP_E2E_ACCOUNT || 3)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

const d = { local: 0, origin: 0, slow: [] };
const t0 = Date.now();
page.on('request', (r) => {
  const u = r.url();
  if (!/\.(png|webp|skel|atlas|json)(\?|$)/i.test(u)) return;
  if (u.includes('assets.luobomiao.love')) d.origin++;
  else if (u.startsWith('https://stronghold.luobomiao.love')) d.local++;
});
page.on('response', (r) => {
  const u = r.url();
  if (!/\.(png|webp|skel|atlas)/i.test(u)) return;
  const t = r.timing();
  if (t.responseEnd > 1000) d.slow.push({ ms: Math.round(t.responseEnd), url: u.slice(0, 80) });
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

  log('== 进大厅 → 同盟模拟 → 创建 → 开局');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '开始' && !x.disabled && x.offsetParent);
    if (b) b.click();
  });
  await sleep(3500);
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('button,[role=button]')].find((x) => /同盟模拟/.test(x.textContent || ''));
    if (c) c.click();
  });
  await sleep(1500);
  const created = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /创建同盟/.test(x.textContent || '') && !x.disabled);
    if (b) { b.click(); return true; }
    return false;
  });
  log('   建房=' + created);
  await sleep(4000);

  const room = await page.evaluate(() => globalThis.__SP__?.store?.get?.()?.room?.code || null);
  log('   房间=' + room);
  if (!room) throw new Error('没建成房间');

  // ★ 公告板会盖住整个画面。不关掉它，对局里的图根本没有机会进入视口，
  //   「空白 0 张」就只是「没测到」，不是「修好了」。
  const closed = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /关闭公告/.test(x.textContent || '') && x.offsetParent);
    if (b) { b.click(); return true; }
    return false;
  });
  log('   关闭公告板=' + closed);
  await sleep(1200);

  // 重置统计：从这里开始算「对局内」的加载
  d.local = 0; d.origin = 0; d.slow.length = 0;
  const matchStart = Date.now();

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /开始模拟/.test(x.textContent || '') && !x.disabled && x.offsetParent);
    if (b) b.click();
  });
  log('   点开始模拟，等待简报/对局画面…');
  await sleep(15000);

  const body = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120));
  log('   画面: ' + body);

  const stats = await page.evaluate(() => {
    const vh = window.innerHeight, vw = window.innerWidth;
    // 检测某个点是否被弹层盖住：取元素中心点做 elementFromPoint
    const covered = (el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > vw || cy > vh) return true;
      const top = document.elementFromPoint(cx, cy);
      if (!top) return false;
      return !(top === el || el.contains(top) || top.contains(el));
    };
    const vis = [];
    for (const el of document.querySelectorAll('img')) {
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) continue;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      vis.push({ natural: el.naturalWidth, complete: el.complete, covered: covered(el), src: (el.currentSrc || el.src || '').slice(0, 80) });
    }
    const onScreen = vis.filter((v) => !v.covered);
    return {
      visible: vis.length,
      onScreen: onScreen.length,
      loaded: onScreen.filter((v) => v.natural > 0).length,
      blankOnScreen: onScreen.filter((v) => !(v.natural > 0)),
      coveredCount: vis.length - onScreen.length,
    };
  });

  log(`\n=== 对局内图片（进入对局后 ${Math.round((Date.now() - matchStart) / 1000)} 秒）===`);
  log(`  视口内 ${stats.visible} 张（其中被弹层遮住 ${stats.coveredCount} 张）`);
  log(`  真正在屏幕上 ${stats.onScreen} 张，已加载 ${stats.loaded} 张，空白 ${stats.blankOnScreen.length} 张`);
  if (stats.blankOnScreen.length) {
    log('  空白样例:');
    stats.blankOnScreen.slice(0, 8).forEach((b) => log('    ✗ ' + b.src));
  }
  log(`\n=== 素材请求域名 ===`);
  log(`  本机 /assets/: ${d.local}`);
  log(`  资源站直连:    ${d.origin}`);
  log(`\n=== >1 秒的慢请求: ${d.slow.length} ===`);
  d.slow.slice(0, 8).forEach((s) => log(`  ${s.ms}ms  ${s.url}`));

  await page.screenshot({ path: 'test/e2e/out/verify-match-art.png' });
  log('\n截图: test/e2e/out/verify-match-art.png');
} catch (e) {
  log('异常: ' + (e && e.message));
} finally {
  await browser.close();
}
