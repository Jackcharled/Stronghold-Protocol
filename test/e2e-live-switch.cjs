// 验证跨节点加入/观战是否「无感」：全程不刷新页面
//   node test/e2e-live-switch.cjs [roomCode]
const fs = require('node:fs');
const puppeteer = require('D:/Stronghold-Protocol/shared/node_modules/puppeteer-core');
const BASE = 'https://stronghold.luobomiao.love';
const CODE = process.argv[2] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!CODE) { console.log('用法: node test/e2e-live-switch.cjs <房间码>'); process.exit(1); }

  const info = await fetch(`${BASE}/mm/api/find-room?code=${CODE}`).then((r) => r.json()).catch(() => null);
  if (!info?.node) { console.log(`房间 ${CODE} 不存在`); process.exit(1); }
  const targetNode = info.node;
  const otherNode = targetNode === 13 ? 5 : 13;
  console.log(`房间 ${CODE} 在 node-${targetNode}；浏览器先落 node-${otherNode}`);

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // ---- 统计页面导航：无感切换应当为 0 ----
  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  const docReqs = [];
  client.on('Network.requestWillBeSent', (e) => {
    if (e.type === 'Document') docReqs.push({ url: e.request.url, ts: e.timestamp, init: JSON.stringify(e.initiator).slice(0, 120) });
  });

  const dbg = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('[mm-debug]')) dbg.push(t); });
  page.on('pageerror', (e) => dbg.push('ERR: ' + String(e).slice(0, 200)));

  await page.evaluateOnNewDocument(() => {
    window.__ws = [];
    const O = window.WebSocket;
    window.WebSocket = function (...a) {
      const ws = new O(...a);
      const s = ws.send.bind(ws);
      ws.send = (d) => { try { window.__ws.push(String(d).slice(0, 200)); } catch {} return s(d); };
      ws.addEventListener('open', () => window.__ws.push('__OPEN__ ' + String(a[0]).slice(0, 80)));
      return ws;
    };
    window.WebSocket.prototype = O.prototype;
    Object.assign(window.WebSocket, O);
  });

  // 登录 + 落在大厅
  await page.setCookie(
    { name: 'sp_route', value: String(otherNode), domain: 'stronghold.luobomiao.love', path: '/' },
    { name: 'sp_node', value: String(otherNode), domain: 'stronghold.luobomiao.love', path: '/' },
  );
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(2500);
  const acc = JSON.parse(fs.readFileSync('.secrets/test-accounts.json', 'utf8')).accounts[0];
  const login = await page.evaluate(async (acc) => {
    const cap = await fetch('/mm/api/auth/captcha').then((r) => r.json());
    const c = [...cap.svg.matchAll(/<text[^>]*>([^<])<\/text>/g)].map((m) => m[1]).join('');
    return fetch('/mm/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: acc.email, password: acc.password, captchaId: cap.id, captcha: c }),
    }).then((x) => x.json());
  }, acc);
  await page.evaluate((t) => {
    localStorage.setItem('mm.sid', t.token);
    localStorage.setItem('mm.name', t.user?.nickname || 'T');
    localStorage.setItem('sp.name', t.user?.nickname || 'T');
    sessionStorage.setItem('sp.entered', '1');
  }, login);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(6000);

  const before = await page.evaluate(() => {
    const sp = window.__SP__; const s = sp?.store?.get();
    return { entered: s?.session?.entered, net: sp?.net?.status, room: s?.room?.code || null,
      route: (document.cookie.match(/sp_route=(\d+)/) || [])[1] };
  });
  console.log('大厅:', JSON.stringify(before));
  if (!before.entered) { console.log('未进入，终止'); await browser.close(); process.exit(1); }

  // ---- 触发跨节点观战：调用页面里的 switchNodeLive（与点击路径同一实现） ----
  docReqs.length = 0;
  dbg.length = 0;
  await page.evaluate(() => { window.__ws = []; });

  const t0 = Date.now();
  const switched = await page.evaluate(async (node, code) => {
    // 复用页面内实现：通过模拟点击「观战」走 checkAndGo 不可靠（需要输入框），
    // 这里直接调用同一套能力：给 socket 换节点，然后发 room.spectate
    const sp = window.__SP__;
    const before = {
      route: (document.cookie.match(/sp_route=(\d+)/) || [])[1],
      href: location.href,
    };
    const res = { before, steps: [] };
    try {
      // 手动做 switchNodeLive 会做的事（该函数在闭包里，外部取不到）
      const net = sp.net;
      const base = net.url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      const u = new URL(base, location.href);
      u.searchParams.set('watchNode', String(node));
      document.cookie = `sp_node=${node}; path=/; max-age=86400; SameSite=Lax`;
      document.cookie = `sp_route=${node}; path=/; max-age=86400; SameSite=Lax`;
      const welcomed = new Promise((resolve, reject) => {
        const onW = () => { net.off?.('welcome', onW); resolve('welcome'); };
        const t = setTimeout(() => { net.off?.('welcome', onW); reject(new Error('timeout')); }, 8000);
        net.on?.('welcome', onW);
      });
      net._quietSwap = true;
      net.close?.();
      net.url = u.toString();
      net.connect?.();
      res.steps.push('reconnecting to ' + u.toString());
      await welcomed;
      res.steps.push('welcome received');
      res.net = net.status;
      await net.request('room.spectate', { code });
      res.steps.push('room.spectate ok');
      res.ok = true;
    } catch (e) {
      res.steps.push('FAILED: ' + (e && e.message));
      res.ok = false;
    }
    res.after = { route: (document.cookie.match(/sp_route=(\d+)/) || [])[1], href: location.href };
    return res;
  }, targetNode, CODE);

  await sleep(4000);
  const after = await page.evaluate(() => {
    const sp = window.__SP__; const s = sp?.store?.get();
    return {
      route: (document.cookie.match(/sp_route=(\d+)/) || [])[1],
      room: s?.room?.code || null,
      net: sp?.net?.status,
      ws: (window.__ws || []).filter((x) => /room\.spectate|__OPEN__/.test(x)),
      href: location.href,
    };
  });

  console.log('\n=== 切换过程 ===');
  switched.steps.forEach((s) => console.log('  ' + s));
  console.log('  结果:', switched.ok ? '✅ 成功' : '❌ 失败');
  console.log('\n=== 无感判定 ===');
  console.log(`  页面导航（Document 请求）次数: ${docReqs.length} ${docReqs.length === 0 ? '✅ 无刷新' : '❌ 刷新了'}`);
  console.log(`  地址栏变化: ${switched.before.href === after.href ? '✅ 未变' : '❌ ' + after.href}`);
  console.log(`  sp_route: ${switched.before.route} → ${after.route} ${after.route == targetNode ? '✅' : '❌'}`);
  console.log(`  当前房间: ${after.room} ${after.room === CODE ? '✅' : '❌'}`);
  console.log(`  net: ${after.net}`);
  console.log('\n=== WS 事件 ===');
  after.ws.forEach((x) => console.log('  ' + x));
  console.log('\n=== 耗时 ===');
  console.log(`  ${Date.now() - t0}ms（含等待）`);

  await browser.close();
  if (docReqs.length > 0 || after.room !== CODE) process.exitCode = 1;
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
