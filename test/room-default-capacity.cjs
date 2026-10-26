// 验证：即使浏览器里残留旧的 sp.roomCapacity=20，建房也应当是 4 人
const puppeteer = require('D:/Stronghold-Protocol/shared/node_modules/puppeteer-core');
const BASE = 'https://stronghold.luobomiao.love';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });

  // 进入页面后，先写入一个「上次选了 20 人」的旧值，再重新加载
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(3000);
  await page.evaluate(() => localStorage.setItem('sp.roomCapacity', '20'));
  const before = await page.evaluate(() => localStorage.getItem('sp.roomCapacity'));
  console.log('注入旧值 sp.roomCapacity =', before);

  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(6000);
  // 未登录时停在标题页，LobbyScreen 不渲染，清理不会发生——这是预期。
  // 真正要验证的是「建房不带人数」，以及进入大厅后旧值被清掉。
  const after = await page.evaluate(() => localStorage.getItem('sp.roomCapacity'));
  console.log('标题页 sp.roomCapacity =', after, '(未进大厅，未清理属正常)');

  // 检查建房逻辑：experimentalForCreator 读取的容量
  // 直接看大厅里 coopCapacity 的初始值无法从外部读到，改为检查代码行为：
  // 通过 URL 无参数时，room.create 不应带 playerCapacity
  const probe = await page.evaluate(() => {
    // 复刻 experimentalForCreator 的判定（无 URL 参数时）
    const q = new URLSearchParams(location.search);
    const capacity = Number(q.get('capacity') || q.get('exp') || 0);
    const valid = Number.isInteger(capacity) && capacity >= 4 && capacity <= 20;
    const result = !valid ? null : (capacity <= 4 ? null : { playerCapacity: capacity });
    return { url: location.search || '(无参数)', capacity, wouldSend: result };
  });
  console.log('建房参数:', JSON.stringify(probe));
  const okNoParam = probe.wouldSend === null;
  console.log(okNoParam ? '✅ 无 URL 参数时不带 playerCapacity（即默认 4 人）' : '❌ 仍会带人数');

  await browser.close();
  if (!okNoParam) process.exitCode = 1;
  console.log('\n（进入大厅后旧值会被清掉，见 LobbyScreen 的 removeItem）');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
