// 端到端验证：**密钥加入**房间后刷新，是否仍在房间（维护者实际遇到的路径）
//
// 走真实 UI：大厅「同盟模拟」→ 弹窗「选择同盟方式」→ 在密钥框输入 → 点加入。
//
// 运行：node tools/e2e-refresh-join.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.SP_E2E_BASE || 'https://stronghold.luobomiao.love';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

const accs = JSON.parse(readFileSync('../.secrets/test-accounts.json', 'utf8')).accounts;
const A = accs[0], B = accs[1] || accs[0];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateOf = () => ({
  entered: sessionStorage.getItem('sp.entered'),
  name: localStorage.getItem('sp.name'),
  tok: (sessionStorage.getItem('sp.token') || '').slice(0, 8),
  playerId: globalThis.__SP__?.store?.get()?.me?.playerId || null,
  room: globalThis.__SP__?.store?.get()?.room?.code || null,
});
const login = (page, acc) => page.evaluate(async (email, pw) => {
  const cap = await fetch('/mm/api/auth/captcha', { credentials: 'same-origin' }).then((r) => r.json());
  const code = [...String(cap.svg || '').matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1].trim()).join('');
  const r = await fetch('/mm/api/auth/login', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: pw, captcha: code, captchaId: cap.id }),
  });
  const j = await r.json().catch(() => null);
  return { ok: !!(j && j.ok), error: j && j.error };
}, acc.email, acc.password);

let failed = false;
const ok = (m) => log('  ✓ ' + m);
const bad = (m) => { log('  ✗ ' + m); failed = true; };

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

try {
  log('1) A 登录建房拿密钥');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  if (!(await login(page, A)).ok) { bad('A 登录失败'); throw new Error('login'); }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  const code = await page.evaluate(async () => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '开始' && !x.disabled);
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 2500));
    await globalThis.__SP__.net.request('room.create', { mode: 'coop', difficulty: 'NORMAL' });
    return globalThis.__SP__.store.get().room?.code || null;
  });
  if (!code) { bad('建房失败'); throw new Error('create'); }
  ok('房间密钥 = ' + code);

  log('2) 换 B，清身份后登录');
  await page.evaluate(async () => {
    try { await fetch('/mm/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* ignore */ }
    localStorage.clear(); sessionStorage.clear();
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  if (!(await login(page, B)).ok) { bad('B 登录失败'); throw new Error('loginB'); }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '开始' && !x.disabled);
    if (b) b.click();
  });
  await sleep(2500);
  log('   进大厅后:', JSON.stringify(await page.evaluate(stateOf)));

  log('3) 打开「同盟模拟」弹窗，走密钥加入');
  const step1 = await page.evaluate(() => {
    const card = [...document.querySelectorAll('button,[role=button]')]
      .find((x) => /同盟模拟|ALLIANCE SIMULATION/.test(x.textContent || ''));
    if (!card) return false;
    card.click();
    return true;
  });
  if (!step1) { bad('找不到同盟模拟卡片'); throw new Error('card'); }
  await sleep(1500);

  const step2 = await page.evaluate((c) => {
    // 弹窗里的密钥输入框：优先 class，退回 placeholder
    const inp = document.querySelector('input.ally-key__field')
      || [...document.querySelectorAll('input')].find((x) => /密钥|KEY/i.test(x.placeholder || ''));
    if (!inp) return { input: false };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, c);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return { input: true };
  }, code);
  log('   密钥输入框 =', step2.input);
  if (!step2.input) { bad('找不到密钥输入框'); throw new Error('input'); }
  await sleep(600);

  const step3 = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => /^加入$|密钥加入|JOIN/.test((x.textContent || '').trim()) && !x.disabled);
    if (!b) return { btn: false, sample: btns.map((x) => (x.textContent || '').trim()).filter(Boolean).slice(0, 20) };
    b.click();
    return { btn: true };
  });
  log('   加入按钮 =', step3.btn);
  // 抓 room.join 的网络结果与页面上的错误提示
  await page.evaluate(() => {
    globalThis.__JOIN_LOG__ = [];
    const net = globalThis.__SP__ && globalThis.__SP__.net;
    if (net) {
      net.on && net.on('unhandledError', (e) => globalThis.__JOIN_LOG__.push('unhandled:' + JSON.stringify(e && (e.code || e.message))));
    }
  });
  if (!step3.btn) { log('   可见按钮:', JSON.stringify(step3.sample)); bad('找不到加入按钮'); throw new Error('btn'); }
  await sleep(4000);

  const before = await page.evaluate(stateOf);
  log('   加入后:', JSON.stringify(before));
  if (before.room !== code) { bad('没加入成功 ' + code + '（实际 ' + before.room + '）'); throw new Error('join'); }
  ok('★ 已通过密钥加入 ' + code);
  if (before.entered === '1') ok('sp.entered = "1"'); else bad('sp.entered 未写入（实际 ' + JSON.stringify(before.entered) + '）');

  log('4) 刷新');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);
  const after = await page.evaluate(stateOf);
  log('   刷新后:', JSON.stringify(after));
  if (after.room === code) ok('★ 刷新后仍在房间 ' + code);
  else bad('★ 刷新后掉出房间: ' + code + ' → ' + after.room);

  log('\n结果: ' + (failed ? '有失败 ✗' : '全部通过 ✓'));
} catch (e) {
  log('异常: ' + (e && e.message));
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
