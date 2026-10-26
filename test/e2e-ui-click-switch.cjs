// 通过真实输入 + 点击「观战」验证跨节点无感切换
//   node test/e2e-ui-click-switch.cjs <房间码>
const fs = require('node:fs');
const puppeteer = require('D:/Stronghold-Protocol/shared/node_modules/puppeteer-core');
const BASE = 'https://stronghold.luobomiao.love';
const CODE = process.argv[2] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!CODE) { console.log('用法: node test/e2e-ui-click-switch.cjs <房间码>'); process.exit(1); }
  const info = await fetch(`${BASE}/mm/api/find-room?code=${CODE}`).then((r) => r.json());
  const target = info.node;
  const other = target === 13 ? 5 : 13;
  console.log(`房间 ${CODE} @ node-${target}，浏览器先落 node-${other}`);

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const dbg = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('[mm-debug]')) dbg.push(t); });
  page.on('pageerror', (e) => dbg.push('ERR: ' + String(e).slice(0, 200)));

  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  const docs = [];
  client.on('Network.requestWillBeSent', (e) => {
    if (e.type === 'Document') docs.push({ url: e.request.url, init: JSON.stringify(e.initiator).slice(0, 90) });
  });

  await page.setCookie(
    { name: 'sp_route', value: String(other), domain: 'stronghold.luobomiao.love', path: '/' },
    { name: 'sp_node', value: String(other), domain: 'stronghold.luobomiao.love', path: '/' },
  );
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(2500);

  const acc = JSON.parse(fs.readFileSync('.secrets/test-accounts.json', 'utf8')).accounts[0];
  const login = await page.evaluate(async (a) => {
    const c = await fetch('/mm/api/auth/captcha').then((r) => r.json());
    const code = [...c.svg.matchAll(/<text[^>]*>([^<])<\/text>/g)].map((m) => m[1]).join('');
    return fetch('/mm/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: a.email, password: a.password, captchaId: c.id, captcha: code }),
    }).then((x) => x.json());
  }, acc);
  await page.evaluate((t) => {
    localStorage.setItem('mm.sid', t.token);
    localStorage.setItem('mm.name', t.user?.nickname || 'T');
    localStorage.setItem('sp.name', t.user?.nickname || 'T');
    sessionStorage.setItem('sp.entered', '1');
  }, login);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(5000);

  await page.evaluate(() => {
    const b = document.querySelector('button.hub-tile--key');
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await sleep(3000);

  const inputSel = 'label.ally-key__field input';
  await page.click(inputSel).catch(() => {});
  await page.type(inputSel, CODE, { delay: 60 });
  await sleep(1200);

  const st = await page.evaluate((sel) => {
    const inp = document.querySelector(sel);
    const btn = document.querySelector('button.join-spectate');
    return { val: inp?.value, btnDisabled: btn?.disabled, btnText: btn?.textContent?.trim() };
  }, inputSel);
  console.log('输入后:', JSON.stringify(st));

  docs.length = 0;
  dbg.length = 0;
  await page.evaluate(() => {
    const b = document.querySelector('button.join-spectate');
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await sleep(12000);

  const after = await page.evaluate(() => {
    const sp = window.__SP__; const s = sp?.store?.get();
    return {
      route: (document.cookie.match(/sp_route=(\d+)/) || [])[1],
      room: s?.room?.code || null, net: sp?.net?.status, href: location.href,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
    };
  });

  console.log('\n=== 结果 ===');
  console.log(`  Document（页面）请求: ${docs.length} ${docs.length === 0 ? '✅ 无刷新' : '❌ 刷新了'}`);
  docs.forEach((d) => console.log(`    ${d.url.replace(BASE, '') || '/'}  init=${d.init}`));
  console.log(`  sp_route: ${other} → ${after.route} ${after.route == target ? '✅' : '❌'}`);
  console.log(`  当前房间: ${after.room} ${after.room === CODE ? '✅' : '❌'}`);
  console.log(`  net: ${after.net}`);
  console.log(`  页面: ${after.text.slice(0, 100)}`);
  console.log('\n=== [mm-debug] ===');
  console.log(dbg.length ? dbg.join('\n') : '  (无)');

  await browser.close();
  if (docs.length > 0 || after.room !== CODE) process.exitCode = 1;
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
