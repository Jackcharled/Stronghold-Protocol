// 直接验证 UI 层：写入 sp.resumeAvailable 后，恢复按钮必须高亮 + 出现提示条。
// 这是「被另一台接管」时 accountObserver 写下的那个标记，UI 的反应由这里保证。
//
//   SP_E2E_NODE=9 node tools/e2e-resume-hint.mjs
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';

const BASE = process.env.SP_E2E_BASE || 'https://stronghold.luobomiao.love';
const NODE = process.env.SP_E2E_NODE || '9';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
const OUT = 'test/e2e/out';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const ok = (m) => log('  ✓ ' + m);
const bad = (m) => { log('  ✗ ' + m); failed = true; };

const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });

try {
  await page.goto(`${BASE}/?n=${NODE}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);

  log('1) 基线：没有标记时不应有提示');
  const before = await page.evaluate(() => ({
    urgent: !!document.querySelector('.verchip--urgent'),
    banner: !!document.querySelector('.resume-banner'),
  }));
  log('   ' + JSON.stringify(before));
  if (!before.urgent && !before.banner) ok('基线干净（无高亮、无提示条）');
  else bad('基线就有提示，说明标记残留');

  log('2) 写入 sp.resumeAvailable=1 并通知 UI');
  await page.evaluate(() => {
    sessionStorage.setItem('sp.resumeAvailable', '1');
    window.dispatchEvent(new Event('sp-resume-available'));
  });
  await sleep(1500);

  const after = await page.evaluate(() => ({
    urgent: !!document.querySelector('.verchip--urgent'),
    banner: !!document.querySelector('.resume-banner'),
    bannerText: (document.querySelector('.resume-banner')?.textContent || '').trim().slice(0, 90),
    // 标题页（/）用自己那条引导条，避免和大厅的横幅重复
    titleHint: (document.querySelector('[data-testid=title-resume-hint]')?.textContent || '').trim().slice(0, 90),
    chipTitle: document.querySelector('[data-testid=resume-local-match]')?.getAttribute('title') || '',
  }));
  log('   ' + JSON.stringify(after, null, 1));
  await page.screenshot({ path: `${OUT}/resume-hint.png` });

  if (after.urgent) ok('恢复按钮已高亮');
  else bad('恢复按钮没有高亮');
  if (after.titleHint) ok('标题页引导条已出现：' + after.titleHint);
  else bad('标题页引导条没有出现');
  if (after.banner) bad('标题页不该再显示大厅的横幅（会和引导条重复）');
  else ok('标题页不重复显示横幅');

  log('3) 清除标记后应恢复原样');
  await page.evaluate(() => {
    sessionStorage.removeItem('sp.resumeAvailable');
    window.dispatchEvent(new Event('sp-resume-available'));
  });
  await sleep(1200);
  const cleared = await page.evaluate(() => ({
    urgent: !!document.querySelector('.verchip--urgent'),
    banner: !!document.querySelector('.resume-banner'),
  }));
  log('   ' + JSON.stringify(cleared));
  if (!cleared.banner) ok('提示条已收回');
  else bad('提示条没有收回');

  log('\n结果: ' + (failed ? '有失败 ✗' : '全部通过 ✓'));
} catch (e) {
  log('异常: ' + (e && e.message));
  failed = true;
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
