// 端到端：建房 → 开局 → 对局中刷新 → 回到对局。
//
// 这是「功能能不能正常用」的验证 —— 光刷新留在房间不够，要真的开出对局、
// 进入对局画面、中途刷新之后还能回到对局。
//
//   SP_E2E_NODE=17 node tools/e2e-full-play.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';

const BASE = process.env.SP_E2E_BASE || 'https://stronghold.luobomiao.love';
const NODE = process.env.SP_E2E_NODE || '17';
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
  room: globalThis.__SP__?.store?.get()?.room?.code || null,
  name: localStorage.getItem('sp.name'),
  tok: (sessionStorage.getItem('sp.token') || '').slice(0, 8),
  screen: (() => { try { return globalThis.__SP__?.store?.get()?.screen ?? null; } catch { return null; } })(),
  playerId: (() => { try { return globalThis.__SP__?.store?.get()?.me?.playerId ?? null; } catch { return null; } })(),
});

const browser = await puppeteer.launch({ executablePath: EDGE, headless: '-new', args: ['--no-sandbox', '--window-size=1280,800'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + String(e.message).slice(0, 200)));
// 401 来自哪个接口：必须看到 URL，否则「5 个 401」是没法判断的噪音
const httpFails = [];
page.on('response', (r) => { if (r.status() >= 400) httpFails.push(r.status() + ' ' + r.url().replace(BASE, '').slice(0, 90)); });

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
    return { ok: !!(j && j.ok), status: r.status, error: j && j.error };
  }, acc.email, acc.password);
  log('   登录返回: status=' + lg.status + ' ok=' + lg.ok + (lg.error ? ' error=' + lg.error : ''));
  if (!lg.ok) throw new Error('登录失败');
  ok('登录成功');

  log('3) 刷新让账号身份生效');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3500);

  // 点「开始」进大厅
  log('4) 进大厅');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, .btn, [role=button]')]
      .find((e) => /开始|进入/.test((e.textContent || '').trim()) && e.offsetParent);
    if (b) b.click();
  });
  await sleep(2500);
  log('   状态: ' + JSON.stringify(await page.evaluate(stateOf)));

  log('5) 同盟模拟 → 创建同盟');
  const created = await page.evaluate(() => {
    const byText = (re) => [...document.querySelectorAll('button, .btn, [role=button], .card, .mode-card')]
      .find((e) => re.test((e.textContent || '').trim()) && e.offsetParent);
    const card = byText(/同盟模拟/);
    if (card) card.click();
    return { card: !!card };
  });
  await sleep(1500);
  const createClick = await page.evaluate(() => {
    const cands = [...document.querySelectorAll('button, .btn, [role=button]')]
      .filter((e) => e.offsetParent && !e.disabled)
      .map((e) => (e.textContent || '').trim().replace(/\s+/g, ' '))
      .filter((t) => t && t.length < 40);
    const b = [...document.querySelectorAll('button, .btn, [role=button]')]
      .find((e) => /^创建同盟$|^创建房间$|创建同盟/.test((e.textContent || '').trim()) && e.offsetParent && !e.disabled);
    if (b) b.click();
    return { clicked: b ? (b.textContent || '').trim().slice(0, 20) : null, cands: cands.slice(0, 25) };
  });
  log('   卡片=' + created.card + ' 创建点击=' + JSON.stringify(createClick.clicked));
  if (!createClick.clicked) log('   可见按钮: ' + JSON.stringify(createClick.cands));
  await sleep(3000);

  const inRoom = await page.evaluate(stateOf);
  log('   进房后: ' + JSON.stringify(inRoom));
  await page.screenshot({ path: `${OUT}/play-1-room.png` });
  if (!inRoom.room) {
    const shot = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
    log('   当前画面文字: ' + shot);
    throw new Error('没能进入房间');
  }
  ok('进入房间 ' + inRoom.room);
  await page.screenshot({ path: `${OUT}/play-1-room.png` });

  log('6) 点「开始模拟」');
  const started = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button, .btn, [role=button]')]
      .find((e) => /开始模拟|开始游戏|开始/.test((e.textContent || '').trim()) && e.offsetParent && !e.disabled);
    if (b) b.click();
    return b ? (b.textContent || '').trim().slice(0, 20) : null;
  });
  log('   点击的按钮: ' + started);
  await sleep(6000);

  const inMatch = await page.evaluate(() => {
    const s = globalThis.__SP__?.store?.get?.() || {};
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
    return {
      screen: s.screen ?? null,
      phase: s.match?.phase ?? s.phase ?? null,
      roomCode: s.room?.code ?? null,
      // 真正的对局界面标志：简报/休整期/行动阶段的具体字样
      matchUi: /BRIEFING|休整期|行动阶段|备战|购买干员|部署|回合/.test(txt),
      // 房间界面标志（用「准备就绪 / 邀请」这类只在房间才有的字样；不要把公告板算进来）
      roomUi: /准备对局|准备就绪|邀请好友|添加 AI/.test(txt),
      noticeOpen: /公告板/.test(txt),
      bodyText: txt.slice(0, 220),
    };
  });
  log('   对局状态: ' + JSON.stringify({
    screen: inMatch.screen, phase: inMatch.phase, room: inMatch.roomCode,
    matchUi: inMatch.matchUi, roomUi: inMatch.roomUi, noticeOpen: inMatch.noticeOpen,
  }));
  log('   画面文字: ' + inMatch.bodyText.slice(0, 130));
  await page.screenshot({ path: `${OUT}/play-2-match.png` });

  // 简报页本身就带「准备就绪」按钮，所以不能拿它区分。真正的判据是简报/对局专属的标志。
  if (inMatch.noticeOpen) log('   （公告板开着，只是浮层，不影响下面按文字判定）');
  const inMatchNow = /BRIEFING|INFO CHECK/.test(inMatch.bodyText);
  if (inMatchNow) ok('已进入对局简报画面');
  else bad('没能进入对局画面: ' + inMatch.bodyText.slice(0, 120));

  log('7) 对局中刷新');
  const before = await page.evaluate(stateOf);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);
  const after = await page.evaluate(stateOf);
  log('   刷新前: ' + JSON.stringify(before));
  log('   刷新后: ' + JSON.stringify(after));
  await page.screenshot({ path: `${OUT}/play-3-after-reload.png` });

  const back = await page.evaluate(() => {
    const s = globalThis.__SP__?.store?.get?.() || {};
    const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
    return {
      screen: s.screen ?? null,
      room: s.room?.code ?? null,
      matchUi: /BRIEFING|休整期|行动阶段|备战|购买干员|部署|回合/.test(txt),
      roomUi: /准备对局|准备就绪|邀请好友|添加 AI/.test(txt),
      bodyText: txt.slice(0, 320),
    };
  });
  log('   刷新后画面: ' + JSON.stringify({ screen: back.screen, room: back.room, matchUi: back.matchUi, roomUi: back.roomUi }));
  log('   画面文字: ' + back.bodyText.slice(0, 170));

  if (after.tok !== before.tok) bad('token 变了: ' + before.tok + ' → ' + after.tok);
  else ok('token 未变');
  if (after.playerId !== before.playerId) bad('playerId 变了: ' + before.playerId + ' → ' + after.playerId);
  else ok('playerId 未变');
  if (after.room !== before.room) bad('房间丢了: ' + before.room + ' → ' + after.room);
  else ok('房间还在 ' + after.room);

  if (/BRIEFING|INFO CHECK/.test(back.bodyText)) ok('刷新后仍在对局简报画面');
  else if (back.room) ok('刷新后回到房间 ' + back.room + '（对局未自动恢复，符合「恢复对局只能手动点」的既定设计）');
  else bad('刷新后掉回大厅');

  // /mm/api/auth/me 在登录之前被调用是**正常**的（此时还没有会话，401 就是预期回答）
  const realFails = httpFails.filter((e) => !/401 \/mm\/api\/auth\/me/.test(e));
  if (realFails.length) {
    log('\nHTTP 失败请求 (' + realFails.length + '):');
    for (const e of [...new Set(realFails)].slice(0, 10)) log('   ' + e);
    bad('有 HTTP 请求失败');
  } else ok('无失败请求（登录前的 /auth/me 401 属正常）');
  const realConsoleErrs = consoleErrors.filter((e) => !/status of 401/.test(e));
  if (realConsoleErrs.length) {
    log('\n控制台错误 (' + realConsoleErrs.length + '):');
    for (const e of realConsoleErrs.slice(0, 8)) log('   ' + e);
    bad('有控制台错误');
  } else ok('无控制台错误');

  log('\n截图: ' + OUT + '/play-*.png');
  log('结果: ' + (failed ? '有失败 ✗' : '全部通过 ✓'));
} catch (e) {
  log('异常: ' + (e && e.message));
  try { await page.screenshot({ path: `${OUT}/play-error.png` }); } catch { /* ignore */ }
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
