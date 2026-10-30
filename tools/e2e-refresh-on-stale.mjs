// 端到端验证：旧代码节点上的玩家刷新后是否仍在房间（2026-10-31）
//
// 背景：为了让跑旧代码的节点不再接新玩家，nginx 的 split_clients（新访客去哪）
// 只写「已跑新代码」的节点；而 map $cookie_sp_route（老 cookie 还算不算有效）
// 仍然包含全部存活节点。这个脚本证明这个组合是安全的：
//
//   1. 带 sp_route=<旧代码节点> 打开站点（模拟那台机器上的老玩家）
//   2. 登录 → 建房 → 确认在房间里，且落在旧代码节点上
//   3. 刷新 → 必须仍在同一房间、同一 playerId、同一节点
//
// 运行：
//   node tools/e2e-refresh-on-stale.mjs        # 自动取 /api/ops/state 里第一个 stale 节点
//   node tools/e2e-refresh-on-stale.mjs 4      # 指定节点号
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.SP_E2E_BASE || 'https://127.0.0.1';
const ROOT = process.env.SP_ROOT || 'D:\\Stronghold-Protocol';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickNode() {
  const want = Number(process.argv[2]);
  if (Number.isInteger(want) && want >= 1 && want <= 30) return want;
  const j = await fetch('http://127.0.0.1:3080/api/ops/state').then((r) => r.json());
  if (!j.stale || !j.stale.length) throw new Error('当前没有跑旧代码的节点，无需验证');
  return j.stale[0];
}

const accounts = JSON.parse(readFileSync(`${ROOT}\\.secrets\\test-accounts.json`, 'utf8'));
const acc = accounts.accounts[0];

const NODE = await pickNode();
log(`目标节点: node-${NODE}（跑旧代码；不在 split_clients 里，但必须在 map 里）`);

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors', '--window-size=1280,800'],
});

const fails = [];
const ok = (cond, msg) => { log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails.push(msg); };
let roomCode = null;

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  // 「这台机器」的浏览器状态：cookie 钉在 node-N
  await page.setCookie({ name: 'sp_route', value: String(NODE), url: BASE, path: '/' });
  await page.setCookie({ name: 'sp_node', value: String(NODE), url: BASE, path: '/' });

  let lastNode = null;
  page.on('response', (res) => {
    const n = res.headers()['x-sp-node'];
    if (n) lastNode = Number(n);
  });

  log(`1) 打开 ${BASE}/ （sp_route=${NODE}）`);
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);
  ok(lastNode === NODE, `首页落在 node-${lastNode}（期望 node-${NODE}）`);

  log(`2) 登录 ${acc.email}`);
  const login = await page.evaluate(async (email, pw) => {
    const cap = await fetch('/mm/api/auth/captcha', { credentials: 'same-origin' }).then((r) => r.json());
    // ⚠ 验证码是每个字符一个 <text> 元素（实测 4 个），不是一整串。
    //   用 /<text[^>]*>([^<]+)<\/text>/ 只匹配**第一个**字符，登录必然 captcha_wrong。
    const chars = [...String(cap.svg || '').matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    const code = chars.join('').replace(/\s+/g, '');
    const r = await fetch('/mm/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: pw, captcha: code, captchaId: cap.id }),
    });
    const j = await r.json().catch(() => null);
    return { ok: !!(j && j.ok), error: j && j.error, code };
  }, acc.email, acc.password);
  if (!login.ok) { ok(false, `登录失败: ${JSON.stringify(login)}`); throw new Error('login'); }
  ok(true, `登录成功（验证码 ${login.code}）`);

  log('3) 刷新让账号身份生效');
  lastNode = null;
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3500);
  ok(lastNode === NODE, `刷新后仍落在 node-${lastNode}`);

  log('4) 建房（room.create）');
  lastNode = null;
  const created = await page.evaluate(async () => {
    const net = globalThis.__SP__?.net;
    if (!net) return { error: 'no net' };
    try {
      const r = await net.request('room.create', { mode: 'coop', difficulty: 'NORMAL' });
      return { ok: true, code: globalThis.__SP__?.store?.get()?.room?.code || null };
    } catch (e) { return { error: String(e && (e.code || e.message)) }; }
  });
  await sleep(2500);
  const before = await page.evaluate(() => ({
    playerId: globalThis.__SP__?.store?.get()?.me?.playerId || null,
    room: globalThis.__SP__?.store?.get()?.room?.code || null,
  }));
  roomCode = before.room;
  log(`   create → ${JSON.stringify(created)}   刷新前: ${JSON.stringify(before)}`);
  ok(!!before.room, `已进入房间 ${before.room}`);
  if (!before.room) throw new Error('没进到房间');

  // 确认这个房间确实建在 node-N 上
  try {
    const at = await fetch(`http://127.0.0.1:${3000 + NODE}/healthz`).then((r) => r.json());
    ok(at.rooms >= 1, `node-${NODE} 上现在有 ${at.rooms} 个房间（测试房在其中）`);
  } catch { /* ignore */ }

  log('5) ★ 刷新（这就是要验证的操作）');
  lastNode = null;
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(6000);

  const after = await page.evaluate(() => ({
    playerId: globalThis.__SP__?.store?.get()?.me?.playerId || null,
    room: globalThis.__SP__?.store?.get()?.room?.code || null,
  }));
  log(`   刷新后: ${JSON.stringify(after)}`);

  ok(lastNode === NODE, `刷新后仍落在 node-${lastNode}（期望 node-${NODE}，未被改派）`);
  ok(after.room === before.room, `刷新后仍在房间 ${after.room}（期望 ${before.room}）`);
  ok(after.playerId === before.playerId, `playerId 未变（${after.playerId}）`);

  log('');
  log(fails.length ? `结果: ${fails.length} 项失败 ✗` : '结果: 全部通过 ✓');
  for (const f of fails) log(`  ✗ ${f}`);
} catch (e) {
  log(`脚本出错: ${e.message}`);
  fails.push(e.message);
} finally {
  // 清理测试房，别留垃圾
  if (roomCode) {
    try {
      await browser.pages()[0]?.evaluate(async () => {
        const net = globalThis.__SP__?.net;
        if (net) { await net.request('room.leave', {}).catch(() => {}); }
      });
    } catch { /* ignore */ }
    log(`（测试房 ${roomCode} 已退出；它会在无人后自动关闭）`);
  }
  await browser.close();
}
process.exit(fails.length ? 1 : 0);
