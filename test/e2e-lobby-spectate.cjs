// 精确复现：玩家在大厅 → 输入房间号 → 点观战（房间在别的节点）
// 场景要点：不在任何房间里（store.room === null），跨节点。
//
//   node test/e2e-lobby-spectate.cjs [roomCode]
const fs = require('node:fs');
const puppeteer = require('D:/Stronghold-Protocol/shared/node_modules/puppeteer-core');
const BASE = 'https://stronghold.luobomiao.love';
const CODE = process.argv[2] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!CODE) { console.log('用法: node test/e2e-lobby-spectate.cjs <房间码>'); process.exit(1); }

  const info = await fetch(`${BASE}/mm/api/find-room?code=${CODE}`).then((r) => r.json()).catch(() => null);
  if (!info?.node) { console.log(`房间 ${CODE} 不存在`); process.exit(1); }
  const targetNode = info.node;
  console.log(`房间 ${CODE}: node-${targetNode} mode=${info.mode} started=${info.started} spectators=${info.spectators ?? 0}/${info.maxSpectators ?? '?'}`);

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // 捕获 console 的 [mm-debug]
  const dbg = [];
  page.on('console', (m) => {
    const t = m.text();
    if (t.includes('[mm-debug]')) dbg.push(t);
  });
  page.on('pageerror', (e) => dbg.push('PAGEERROR: ' + String(e).slice(0, 200)));

  // WS 追踪
  await page.evaluateOnNewDocument(() => {
    window.__ws = [];
    const O = window.WebSocket;
    window.WebSocket = function (...a) {
      const ws = new O(...a);
      const s = ws.send.bind(ws);
      ws.send = (d) => { try { window.__ws.push(String(d).slice(0, 300)); } catch {} return s(d); };
      return ws;
    };
    window.WebSocket.prototype = O.prototype;
    Object.assign(window.WebSocket, O);
  });

  // ---- 1. 先登录 + 标记已进入，落在一个和房间不同的节点 ----
  const otherNode = targetNode === 13 ? 5 : 13;
  await page.setCookie(
    { name: 'sp_route', value: String(otherNode), domain: 'stronghold.luobomiao.love', path: '/' },
    { name: 'sp_node', value: String(otherNode), domain: 'stronghold.luobomiao.love', path: '/' },
  );
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(2500);

  const acc = JSON.parse(fs.readFileSync('.secrets/test-accounts.json', 'utf8')).accounts[0];
  const login = await page.evaluate(async (acc) => {
    const cap = await fetch('/mm/api/auth/captcha').then((r) => r.json());
    const code = [...cap.svg.matchAll(/<text[^>]*>([^<])<\/text>/g)].map((m) => m[1]).join('');
    return fetch('/mm/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: acc.email, password: acc.password, captchaId: cap.id, captcha: code }),
    }).then((x) => x.json());
  }, acc);
  console.log('登录:', login.ok ? 'OK' : JSON.stringify(login).slice(0, 100));
  if (!login.ok) { await browser.close(); process.exit(1); }

  // 写入登录态 = 页面认为「已进入」（等价于玩家正常登录后进入大厅）
  await page.evaluate((t) => {
    localStorage.setItem('mm.sid', t.token);
    localStorage.setItem('mm.name', t.user?.nickname || 'Test');
    localStorage.setItem('sp.name', t.user?.nickname || 'Test');
    sessionStorage.setItem('sp.entered', '1');
  }, login);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(6000);

  const lobby = await page.evaluate(() => {
    const sp = window.__SP__; const s = sp?.store?.get();
    return {
      entered: s?.session?.entered, net: sp?.net?.status,
      room: s?.room?.code || null, name: s?.session?.name,
      route: (document.cookie.match(/sp_route=(\d+)/) || [])[1],
      inLobby: /创建同盟/.test(document.body.innerText || ''),
    };
  });
  console.log('大厅状态:', JSON.stringify(lobby));

  if (lobby.room) { console.log('⚠ 不在大厅（已有房间），场景不符'); await browser.close(); process.exit(1); }

  // ---- 2. 模拟玩家在大厅输入房间号并点「观战」 ----
  //     逐字复刻 client.js 点击拦截逻辑：查 find-room → 跨节点则记 pendingRoom + 切 cookie + replace('/')
  dbg.length = 0;
  const navs = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(f.url()); });

  const clicked = await page.evaluate(async (code) => {
    const d = await fetch('/mm/api/find-room?code=' + encodeURIComponent(code)).then((r) => r.json()).catch(() => null);
    if (!d || !d.node) return 'no-room';
    const cur = Number((document.cookie.match(/sp_node=(\d+)/) || [])[1]) || 1;
    if (d.node === cur) return 'same-node';
    document.cookie = `sp_node=${d.node}; path=/; max-age=86400; SameSite=Lax`;
    document.cookie = `sp_route=${d.node}; path=/; max-age=86400; SameSite=Lax`;
    sessionStorage.setItem('mm.pendingRoom', JSON.stringify({ code, spectate: true }));
    location.replace('/');
    return 'jumped';
  }, CODE);
  console.log('点击结果:', clicked);

  await sleep(16000);

  const end = await page.evaluate(() => {
    const sp = window.__SP__; const s = sp?.store?.get();
    return {
      route: (document.cookie.match(/sp_route=(\d+)/) || [])[1],
      pending: sessionStorage.getItem('mm.pendingRoom'),
      net: sp?.net?.status, entered: s?.session?.entered,
      room: s?.room?.code || null,
      spectators: s?.room?.spectators || null,
      ws: (window.__ws || []).filter((x) => /room\.(join|spectate)/.test(x)),
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 180),
    };
  });

  console.log('\n=== 结果 ===');
  console.log(`  sp_route   = ${end.route} ${end.route == targetNode ? '✅' : '❌'}`);
  console.log(`  pendingRoom= ${end.pending} ${end.pending === null ? '✅ 已消费' : '❌ 残留'}`);
  console.log(`  net        = ${end.net}   entered = ${end.entered}`);
  console.log(`  当前房间   = ${end.room}`);
  const sent = end.ws.some((x) => /room\.spectate/.test(x));
  console.log(`  发出 room.spectate = ${sent ? '✅' : '❌'}`);
  end.ws.forEach((x) => console.log('    ' + x));
  console.log(`  导航次数   = ${navs.length}`);
  navs.forEach((u, i) => console.log(`    ${i}: ${u.replace(BASE, '')}`));
  console.log('\n=== [mm-debug] 日志 ===');
  console.log(dbg.length ? dbg.join('\n') : '  (无 —— 说明 joinFlow 根本没被调用)');

  await browser.close();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
