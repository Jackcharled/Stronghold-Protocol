// 用真实浏览器（手机模拟）打开首页，抓 boot 是否成功 / 有没有 JS 报错。
//   node test\e2e-mobile-boot.cjs [url]
const puppeteer = require('D:/Stronghold-Protocol/shared/node_modules/puppeteer-core');

const URL_ = process.argv[2] || 'https://stronghold.luobomiao.love/';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36');

  const errors = [];
  const failedReqs = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // 未登录时 /mm/api/auth/me 的 401 是正常探测
    if (/Failed to load resource: the server responded with a status of 401/.test(t)) return;
    errors.push('CONSOLE: ' + t.slice(0, 300));
  });
  // /mm/api/auth/me 在未登录时必然 401：这是正常的账号探测，不算失败
  page.on('response', (r) => {
    if (r.status() >= 400 && !/\/mm\/api\/auth\/me/.test(r.url())) {
      failedReqs.push(`${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
    }
  });

  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 6000));

  const state = await page.evaluate(() => {
    const bodyText = document.body?.innerText || '';
    return {
      hasBootFail: /游戏脚本加载失败/.test(bodyText),
      hasReloadBtn: /重新加载/.test(bodyText),
      bodySnippet: bodyText.replace(/\s+/g, ' ').slice(0, 200),
      bootRetry: (() => { try { return sessionStorage.getItem('sp_boot_retry'); } catch { return null; } })(),
      hasCanvas: !!document.querySelector('canvas'),
      url: location.href,
    };
  });

  console.log('URL:', state.url);
  console.log('停在「游戏脚本加载失败」界面:', state.hasBootFail);
  console.log('页面文字:', state.bodySnippet);
  console.log('sp_boot_retry:', state.bootRetry);
  console.log('有 canvas:', state.hasCanvas);
  console.log('\n失败的请求:', failedReqs.length ? '\n  ' + failedReqs.slice(0, 15).join('\n  ') : '无');
  console.log('JS 错误:', errors.length ? '\n  ' + errors.slice(0, 10).join('\n  ') : '无');

  await page.screenshot({ path: 'D:/Stronghold-Protocol/dist/_mobile-boot.png' });
  await browser.close();
  process.exit(state.hasBootFail || errors.length || failedReqs.length ? 1 : 0);
})();
