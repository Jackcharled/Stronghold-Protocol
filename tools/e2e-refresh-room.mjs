// 端到端验证：房间内刷新是否留在房间（2026-10-30）
//
// 走真实浏览器 + 真实 UI 流程，不绕过任何按钮逻辑：
//   1. 登录测试账号（图形验证码自动解出）
//   2. 标题页点「开始」进大厅
//   3. 大厅点「同盟模拟」→「创建同盟」
//   4. 记录状态（entered / room / playerId）
//   5. 刷新
//   6. 再记录，判断是否还在房间
//
// 运行（必须在 repo-sync 下，puppeteer-core 在那里）：
//   node tools/e2e-refresh-room.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.SP_E2E_BASE || 'https://stronghold.luobomiao.love';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

// SP_E2E_ACCOUNT=<下标> 换一个测试账号。同一个账号在别的节点上残留房间时，
// 「账号已有房间」会把新建房挡掉，换账号可以避开这种测试污染。
const acc = JSON.parse(readFileSync('../.secrets/test-accounts.json', 'utf8'))
  .accounts[Number(process.env.SP_E2E_ACCOUNT || 0)];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stateOf = () => ({
  entered: sessionStorage.getItem('sp.entered'),
  name: localStorage.getItem('sp.name'),
  tok: (sessionStorage.getItem('sp.token') || '').slice(0, 8),
  playerId: globalThis.__SP__?.store?.get()?.me?.playerId || null,
  room: globalThis.__SP__?.store?.get()?.room?.code || null,
});

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });

let failed = false;
const ok = (m) => log('  ✓ ' + m);
const bad = (m) => { log('  ✗ ' + m); failed = true; };

try {
  log('1) 打开站点');
  // ?n=<1-30> 把这次会话钉在某一个节点上（nginx 的 $sp_room_node 优先级最高），
  // 否则 sp_route cookie 会让请求随机落到 30 个节点中的任意一个 —— 而各节点的
  // server 代码可能不同版本，测出来的结果就不可信。
  const node = process.env.SP_E2E_NODE || '';
  const startUrl = BASE + '/' + (node ? '?n=' + encodeURIComponent(node) : '');
  log('   ' + startUrl);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);

  log('2) 登录 ' + acc.email);
  const lg = await page.evaluate(async (email, pw) => {
    const cap = await fetch('/mm/api/auth/captcha', { credentials: 'same-origin' }).then((r) => r.json());
    const code = [...String(cap.svg || '').matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1].trim()).join('');
    const r = await fetch('/mm/api/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: pw, captcha: code, captchaId: cap.id }),
    });
    const j = await r.json().catch(() => null);
    return { ok: !!(j && j.ok), error: j && j.error };
  }, acc.email, acc.password);
  if (!lg.ok) { bad('登录失败 ' + JSON.stringify(lg)); throw new Error('login'); }
  ok('登录成功');

  log('3) 刷新让账号身份生效，然后点「开始」');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  const start = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '开始' && !x.disabled);
    if (b) { b.click(); return true; }
    return false;
  });
  if (!start) bad('找不到「开始」按钮（可能已登录直接进大厅）');
  await sleep(3000);
  log('   大厅状态:', JSON.stringify(await page.evaluate(stateOf)));

  log('4) 点「同盟模拟」→「创建同盟」');
  const clicked = await page.evaluate(() => {
    const card = [...document.querySelectorAll('button,[role=button]')]
      .find((x) => /同盟模拟|ALLIANCE SIMULATION/.test(x.textContent || ''));
    if (!card) return { card: false };
    card.click();
    return { card: true };
  });
  await sleep(1200);
  const created = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /创建同盟/.test((x.textContent || '').trim()) && !x.disabled);
    if (!b) return { create: false, sample: [...document.querySelectorAll('button')].map((x) => (x.textContent || '').trim()).filter(Boolean).slice(0, 25) };
    b.click();
    return { create: true };
  });
  log('   卡片点击=' + clicked.card + '  创建点击=' + created.create);
  if (!created.create) log('   可见按钮:', JSON.stringify(created.sample));
  await sleep(3000);

  const before = await page.evaluate(stateOf);
  log('   建房后:', JSON.stringify(before));
  if (!before.room) { bad('没进到房间，无法继续'); throw new Error('noroom'); }
  ok('已进入房间 ' + before.room);
  if (before.entered === '1') ok('sp.entered = "1"');
  else bad('sp.entered 未写入（实际 ' + JSON.stringify(before.entered) + '）');

  log('5) 刷新（这一步就是维护者遇到问题的操作）');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);

  const after = await page.evaluate(stateOf);
  log('   刷新后:', JSON.stringify(after));

  if (after.name !== before.name) bad('账号名丢了'); else ok('账号名保留');
  if (after.playerId !== before.playerId) log('   注意 playerId 变化: ' + before.playerId + ' → ' + after.playerId);
  else ok('playerId 未变（复用会话）');
  if (after.room === before.room) ok('★ 刷新后仍在房间 ' + after.room);
  else bad('★ 刷新后掉出房间: ' + before.room + ' → ' + after.room);

  log('\n结果: ' + (failed ? '有失败 ✗' : '全部通过 ✓'));
} catch (e) {
  log('异常: ' + (e && e.message));
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
