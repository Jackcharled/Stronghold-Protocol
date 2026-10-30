// 端到端验证：刷新后 sp.token 是否保持不变（2026-10-30 刷新掉线的核心）
//
// 背景：维护者实测 sp.token 每次刷新都会从 e7bbb968 变成 4123ea6a 之类的另一个值。
// 根因候选：identity.resolveToken() 把本标签页自己的 token 也交给 BroadcastChannel 裁决，
//           一旦被判「被占用」就返回 null → init() 删掉 sp.token → hello 不带 token →
//           服务端建新会话 → playerId 变 → main.js backToLobby() → 掉回大厅。
//
// 本脚本：登录进游戏 → 记下 token → 刷新 → 比对 token 是否变化，并打印频道活动。
//
// 运行：SP_E2E_NODE=8 node tools/e2e-token-stable.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.SP_E2E_BASE || 'https://stronghold.luobomiao.love';
const NODE = process.env.SP_E2E_NODE || '8';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
const acc = JSON.parse(readFileSync('../.secrets/test-accounts.json', 'utf8')).accounts[0];
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_ = `${BASE}/?n=${NODE}`;

const snap = () => ({
  tok: (sessionStorage.getItem('sp.token') || '').slice(0, 8),
  welcome: sessionStorage.getItem('sp.tokenWelcome'),
  entered: sessionStorage.getItem('sp.entered'),
  recent: JSON.parse(localStorage.getItem('sp.tokens') || '[]').map((t) => String(t).slice(0, 8)),
});

const browser = await puppeteer.launch({
  executablePath: EDGE, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
const diag = [];
page.on('console', (m) => { const t = m.text(); if (t.includes('[diag-')) diag.push(t); });
await page.setViewport({ width: 1280, height: 800 });

let failed = false;
try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  const lg = await page.evaluate(async (email, pw) => {
    const cap = await fetch('/mm/api/auth/captcha', { credentials: 'same-origin' }).then((r) => r.json());
    const code = [...String(cap.svg || '').matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1].trim()).join('');
    const r = await fetch('/mm/api/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: pw, captcha: code, captchaId: cap.id }),
    });
    const j = await r.json().catch(() => null);
    return !!(j && j.ok);
  }, acc.email, acc.password);
  if (!lg) throw new Error('登录失败');

  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '开始' && !x.disabled);
    if (b) b.click();
  });
  await sleep(3000);

  const before = await page.evaluate(snap);
  log('刷新前: ' + JSON.stringify(before));

  // 连刷 3 次，任何一次变化都算失败
  for (let i = 1; i <= 3; i++) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4500);
    const after = await page.evaluate(snap);
    const same = after.tok && after.tok === before.tok;
    log(`第 ${i} 次刷新: tok=${after.tok}  ${same ? '✓ 未变' : '✗ 变了'}   recent=${JSON.stringify(after.recent)}`);
    if (!same) failed = true;
  }

  log('\n=== diag-resolve 输出 ===');
  diag.forEach((l) => log('  ' + l));

  log('\n结果: ' + (failed ? 'token 会变 ✗（刷新掉线的根因仍在）' : 'token 稳定 ✓'));
} catch (e) {
  log('异常: ' + (e && e.message));
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
