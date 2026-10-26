// 验证：加入/观战成功后，地址栏保持干净；管理员隐身观战例外保留
const fs = require('node:fs');
const puppeteer = require('D:/Stronghold-Protocol/shared/node_modules/puppeteer-core');
const BASE = 'https://stronghold.luobomiao.love';
const CODE = process.argv[2] || 'TRNU';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const info = await fetch(`${BASE}/mm/api/find-room?code=${CODE}`).then((r) => r.json());
  const target = info.node;
  const other = target === 13 ? 5 : 13;

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

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

  // 打开密钥面板 + 输入 + 点观战
  await page.evaluate(() => {
    const b = document.querySelector('button.hub-tile--key');
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await sleep(3000);
  const inputSel = 'label.ally-key__field input';
  await page.click(inputSel).catch(() => {});
  await page.type(inputSel, CODE, { delay: 60 });
  await sleep(1000);
  await page.evaluate(() => {
    const b = document.querySelector('button.join-spectate');
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await sleep(12000);

  const r = await page.evaluate(() => {
    const sp = window.__SP__; const s = sp?.store?.get();
    return {
      href: location.href.replace(location.origin, '') || '/',
      route: (document.cookie.match(/sp_route=(\d+)/) || [])[1],
      room: s?.room?.code || null,
    };
  });

  console.log(`房间 ${CODE} @ node-${target}`);
  console.log(`  观战后地址栏: ${r.href}  ${/[?&]/.test(r.href) ? '⚠ 带参数' : '✅ 干净'}`);
  console.log(`  sp_route: ${other} → ${r.route} ${r.route == target ? '✅' : '❌'}`);
  console.log(`  当前房间: ${r.room} ${r.room === CODE ? '✅' : '❌'}`);

  await browser.close();
  if (/[?&]/.test(r.href)) process.exitCode = 1;
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
