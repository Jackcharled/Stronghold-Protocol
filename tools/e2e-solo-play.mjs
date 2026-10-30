// 端到端：独立模拟房间 —— 建房 → 开局 → 刷新 → 不掉出房间。
//
// 维护者的要求：「确保在同盟模拟房间中和独立模拟房间中刷新玩家不会掉出到大厅中」。
// e2e-refresh-room / e2e-full-play 覆盖的是同盟模拟，这个覆盖独立模拟。
//
//   SP_E2E_NODE=5 SP_E2E_ACCOUNT=3 node tools/e2e-solo-play.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';

const BASE = process.env.SP_E2E_BASE || 'https://stronghold.luobomiao.love';
const NODE = process.env.SP_E2E_NODE || '5';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

const OUT = 'test/e2e/out';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const acc = JSON.parse(readFileSync('../.secrets/test-accounts.json', 'utf8'))
  .accounts[Number(process.env.SP_E2E_ACCOUNT || 0)];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (m) => log('  ✓ ' + m);
const bad = (m) => { log('  ✗ ' + m); failed = true; };

const stateOf = () => ({
  room: globalThis.__SP__?.store?.get?.()?.room?.code || null,
  name: localStorage.getItem('sp.name'),
  tok: (sessionStorage.getItem('sp.token') || '').slice(0, 8),
  playerId: globalThis.__SP__?.store?.get?.()?.me?.playerId || null,
  mode: globalThis.__SP__?.store?.get?.()?.room?.mode || null,
});

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

try {
  const startUrl = `${BASE}/?n=${encodeURIComponent(NODE)}`;
  log('1) 打开 ' + startUrl);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);

  log('2) 登录 ' + acc.email);
  const lg = await page.evaluate(async (email, pw) => {
    const cap = await fetch('/mm/api/auth/captcha', { credentials: 'same-origin' }).then((r) => r.json());
    const code = [...String(cap.svg || '').matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1].trim()).join('');
    const r = await fetch('/mm/api/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: pw, captcha: code, captchaId: cap.id }),
    });
    const j = await r.json().catch(() => null);
    return { ok: !!(j && j.ok), status: r.status };
  }, acc.email, acc.password);
  if (!lg.ok) throw new Error('登录失败');
  ok('登录成功');

  log('3) 刷新让账号身份生效，进大厅');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '开始' && !x.disabled);
    if (b) b.click();
  });
  await sleep(2500);

  log('4) 独立模拟 → 创建');
  const soloCard = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button,[role=button]')]
      .find((x) => /SOLO SIMULATION|独立模拟/.test(x.textContent || ''));
    if (b) b.click();
    return !!b;
  });
  log('   独立模拟卡片=' + soloCard);
  await sleep(1500);

  // 独立模拟会弹出「选择模拟协议」：先选一个难度，再点它自己的创建/开始按钮
  const btns = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((e) => e.offsetParent && !e.disabled)
    .map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 36)));
  log('   弹窗按钮: ' + JSON.stringify(btns.filter((t) => t)));

  const createBtn = await page.evaluate(() => {
    const all = [...document.querySelectorAll('button')].filter((e) => e.offsetParent && !e.disabled);
    // 真正的开局按钮文字是「开始独立模拟」（前面带品牌字），难度卡片是长文案
    const b = all.find((e) => /开始独立模拟/.test(e.textContent || ''));
    if (!b) return null;
    const t = (b.textContent || '').trim().replace(/\s+/g, ' ');
    b.click();
    return t.slice(0, 40);
  });
  log('   点击=' + JSON.stringify(createBtn));
  await sleep(3500);

  const inRoom = await page.evaluate(stateOf);
  log('   进房后: ' + JSON.stringify(inRoom));
  await page.screenshot({ path: `${OUT}/solo-1-room.png` });
  if (!inRoom.room) {
    const txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 260));
    log('   画面: ' + txt);
    throw new Error('没能进入独立模拟房间');
  }
  ok('进入独立模拟房间 ' + inRoom.room + (inRoom.mode ? '（mode=' + inRoom.mode + '）' : ''));

  log('5) 刷新');
  const before = await page.evaluate(stateOf);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);
  const after = await page.evaluate(stateOf);
  log('   刷新前: ' + JSON.stringify(before));
  log('   刷新后: ' + JSON.stringify(after));
  await page.screenshot({ path: `${OUT}/solo-2-after-reload.png` });

  if (after.tok !== before.tok) bad('token 变了: ' + before.tok + ' → ' + after.tok);
  else ok('token 未变');
  if (after.playerId !== before.playerId) bad('playerId 变了');
  else ok('playerId 未变');
  if (!after.room) bad('★ 刷新后掉回大厅（维护者要求不能发生）');
  else ok('★ 刷新后仍在独立模拟房间 ' + after.room);

  log('\n结果: ' + (failed ? '有失败 ✗' : '全部通过 ✓'));
} catch (e) {
  log('异常: ' + (e && e.message));
  try { await page.screenshot({ path: `${OUT}/solo-error.png` }); } catch { /* ignore */ }
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
