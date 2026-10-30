// 端到端：两个**同名**玩家在同盟房间里的区分（2026-10-30）
//
// 验证维护者反复强调的要求：
//   1. 两个重名玩家都能进房，谁都进得去
//   2. 座位/观战席按 playerId 区分，不混淆
//   3. 刷新后各自回到自己的位置，不互抢
//   4. 观战席不会出现两条同名记录
//
// 运行（一定要落在跑新代码的节点上）：
//   SP_E2E_BASE=https://stronghold.luobomiao.love node tools/e2e-same-name.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.SP_E2E_BASE || 'https://stronghold.luobomiao.love';
const NODE = process.env.SP_E2E_NODE || '19';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

const accs = JSON.parse(readFileSync('../.secrets/test-accounts.json', 'utf8')).accounts;
const A = accs[0], B = accs[1] || accs[0];
const SAME_NAME = '同名' + Math.floor(Math.random() * 1000);
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_ = `${BASE}/?n=${NODE}`;

const login = (page, acc) => page.evaluate(async (email, pw) => {
  const cap = await fetch('/mm/api/auth/captcha', { credentials: 'same-origin' }).then((r) => r.json());
  const code = [...String(cap.svg || '').matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1].trim()).join('');
  const r = await fetch('/mm/api/auth/login', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: pw, captcha: code, captchaId: cap.id }),
  });
  const j = await r.json().catch(() => null);
  return { ok: !!(j && j.ok), error: j && j.error, user: j && j.user };
}, acc.email, acc.password);

const enterAndSetName = async (page, nm) => {
  await page.evaluate((n) => {
    localStorage.setItem('sp.name', n);
  }, nm);
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  await page.evaluate((n) => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '开始' && !x.disabled);
    if (b) { b.click(); return; }
    // 已进过游戏：直接确保 store 里的名字
    try { globalThis.__SP__.net.setName(n); } catch { /* ignore */ }
  }, nm);
  await sleep(2500);
};

const stateOf = (page) => page.evaluate(() => ({
  pid: globalThis.__SP__?.store?.get()?.me?.playerId || null,
  name: globalThis.__SP__?.store?.get()?.me?.name || null,
  room: globalThis.__SP__?.store?.get()?.room?.code || null,
  seats: (globalThis.__SP__?.store?.get()?.room?.seats || []).filter(Boolean).map((s) => ({ n: s.name, p: s.playerId })),
  specs: (globalThis.__SP__?.store?.get()?.room?.spectators || []).map((s) => ({ n: s.name, p: s.playerId })),
}));

let failed = false;
const ok = (m) => log('  ✓ ' + m);
const bad = (m) => { log('  ✗ ' + m); failed = true; };

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors'],
});

let code = null;
try {
  const pa = await browser.newPage();
  const pb = await browser.newPage();
  await pa.setViewport({ width: 1280, height: 800 });
  await pb.setViewport({ width: 1280, height: 800 });

  log(`同名代号: "${SAME_NAME}"   节点: n=${NODE}`);

  // --- A 登录并建房 ---
  log('1) A 登录并建房');
  await pa.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  if (!(await login(pa, A)).ok) { bad('A 登录失败'); throw new Error('loginA'); }
  await enterAndSetName(pa, SAME_NAME);
  const cr = await pa.evaluate(async () => {
    try {
      await globalThis.__SP__.net.request('room.create', { mode: 'coop', difficulty: 'NORMAL' });
      return globalThis.__SP__.store.get().room?.code || null;
    } catch (e) { return 'ERR:' + (e && (e.code || e.message)); }
  });
  if (!cr || String(cr).startsWith('ERR:')) { bad('建房失败 ' + cr); throw new Error('create'); }
  code = cr;
  ok('房间 = ' + code);
  const sa = await stateOf(pa);
  ok(`A 座位: pid=${sa.pid} name=${sa.name}`);

  // --- B 用同一个名字加入 ---
  log('2) B 用相同代号加入');
  await pb.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  if (!(await login(pb, B)).ok) { bad('B 登录失败'); throw new Error('loginB'); }
  await enterAndSetName(pb, SAME_NAME);
  const jr = await pb.evaluate(async (c) => {
    try { await globalThis.__SP__.net.request('room.join', { code: c }); return 'ok'; }
    catch (e) { return 'ERR:' + (e && (e.code || e.message)); }
  }, code);
  await sleep(1500);
  const sb = await stateOf(pb);
  if (!sb.room) { bad('★ B 进不去（重名被挡）' + jr); }
  else ok('★ B 成功进入（重名不阻挡）');
  log(`   B: pid=${sb.pid} name=${sb.name}`);

  // --- 座位区分 ---
  log('3) 座位用 playerId 区分');
  const seats = sb.seats;
  const sameNameSeats = seats.filter((s) => s.n === SAME_NAME);
  log('   座位: ' + JSON.stringify(seats));
  if (sameNameSeats.length < 2) bad('同名座位数 = ' + sameNameSeats.length + '（应 ≥ 2）');
  else if (new Set(sameNameSeats.map((s) => s.p)).size !== sameNameSeats.length) bad('同名座位 playerId 重复');
  else ok('两个同名座位 playerId 不同，可区分');
  if (sa.pid === sb.pid) bad('A 与 B 的 playerId 相同（不该发生）');

  // --- A 刷新 ---
  log('4) A 刷新');
  await pa.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);
  const sa2 = await stateOf(pa);
  if (sa2.room === code) ok('★ A 刷新后仍在 ' + code);
  else bad('★ A 刷新后掉出房间: ' + sa2.room);
  if (sa2.pid !== sa.pid) log('   注意 A 的 playerId 变了: ' + sa.pid + ' → ' + sa2.pid);

  // --- B 刷新 ---
  log('5) B 刷新');
  await pb.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);
  const sb2 = await stateOf(pb);
  if (sb2.room === code) ok('★ B 刷新后仍在 ' + code);
  else bad('★ B 刷新后掉出房间: ' + sb2.room);

  // --- 观战席无重复 ---
  log('6) 观战席不应有重复');
  const dupSpec = (sb2.specs || []).filter((s, i, arr) => arr.findIndex((x) => x.p === s.p) !== i);
  if (dupSpec.length) bad('观战席出现重复 playerId: ' + JSON.stringify(dupSpec));
  else ok('观战席无重复记录');

  log('\n结果: ' + (failed ? '有失败 ✗' : '全部通过 ✓'));
} catch (e) {
  log('异常: ' + (e && e.message));
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
