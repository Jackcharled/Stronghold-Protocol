// 端到端验证：结算页的「这台服务器还在用旧版本」提示，只在旧代码节点出现（2026-10-31）
//
// 验证两件事：
//   A. 在旧代码节点（X-SP-Accepts-New: 0）上，模块判断为 false → 结算页会提示玩家刷新；
//   B. 在新代码节点（X-SP-Accepts-New: 1）上，判断为 true → 不提示。
//
// 不真的打完一局（那要几分钟），而是在真实页面里直接调用模块的导出函数，
// 断言它读到的响应头与预期一致——提示的显示条件就是这个返回值。
//
// 运行：node tools/e2e-node-code-hint.mjs
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const BASE = process.env.SP_E2E_BASE || 'https://127.0.0.1';
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 挑一个旧代码节点和一个新代码节点
const state = await fetch('http://127.0.0.1:3080/api/ops/state').then((r) => r.json());
const staleNode = (state.stale || [])[0];
if (!staleNode) { log('当前没有跑旧代码的节点，无法验证 A；只能验证 B。'); }
const freshNode = (state.fresh || [])[0];

const fails = [];
const ok = (cond, msg) => { log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails.push(msg); };

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--ignore-certificate-errors', '--window-size=1280,800'],
});

try {
  for (const [label, node, expect] of [
    staleNode ? ['旧代码节点', staleNode, false] : null,
    ['新代码节点', freshNode, true],
  ].filter(Boolean)) {
    log(`\n=== ${label} node-${node}（期望 ${{ false: '提示（false）', true: '不提示（true）' }[expect]}）===`);
    const page = await browser.newPage();
    await page.setCookie({ name: 'sp_route', value: String(node), url: BASE, path: '/' });
    await page.setCookie({ name: 'sp_node', value: String(node), url: BASE, path: '/' });
    await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2500);

    // 直接 import 页面里已部署的模块，调用它的判断函数（不依赖登录/开局）
    const got = await page.evaluate(async () => {
      const mod = await import('/js/ui/nodeCodeHint.js');
      const v = await mod.checkNodeAcceptsNew((u, o) => fetch(u, o));
      return { value: v, hasHeaderFn: typeof mod.nodeAcceptsNew === 'function' };
    });
    log(`  模块返回: ${JSON.stringify(got)}`);
    ok(got.hasHeaderFn, '模块已部署并导出 nodeAcceptsNew');
    ok(got.value === expect, `判断结果 ${got.value}（期望 ${expect}）`);
    await page.close();
  }

  log('');
  log(fails.length ? `结果: ${fails.length} 项失败 ✗` : '结果: 全部通过 ✓');
  for (const f of fails) log(`  ✗ ${f}`);
} catch (e) {
  log(`脚本出错: ${e.message}`);
  fails.push(e.message);
} finally {
  await browser.close();
}
process.exit(fails.length ? 1 : 0);
