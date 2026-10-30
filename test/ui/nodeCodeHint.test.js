// test/ui/nodeCodeHint.test.js — public/js/ui/nodeCodeHint.js: 「本节点还跑旧代码，打完这局刷新一下」的判断。
//
// 契约（任何一条破了都会误伤玩家）：
//   * 只有 nginx 明确说 0（不接新玩家）才算「旧代码节点」；
//   * 拿不到 / 读不懂 / 请求失败 一律 null —— 绝不能当成 false，否则所有玩家都会看到提示；
//   * 1（新代码）必须是 false（不提示），不是 null。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeAcceptsNew, checkNodeAcceptsNew, ACCEPTS_HEADER } from '../../public/js/ui/nodeCodeHint.js';

/** 造一个只有 headers.get 的最小响应。 */
const resWith = (v) => ({ headers: { get: (n) => (n === ACCEPTS_HEADER ? v : null) } });

test('nodeAcceptsNew: 1 = 接新玩家，0 = 不接，其它一律 null', () => {
  assert.equal(nodeAcceptsNew(resWith('1')), true);
  assert.equal(nodeAcceptsNew(resWith('0')), false);
  // 缺头（老 nginx / 直连节点）不能当成「不接」
  assert.equal(nodeAcceptsNew(resWith(null)), null);
  assert.equal(nodeAcceptsNew({ headers: { get: () => null } }), null);
  // 脏值不猜
  assert.equal(nodeAcceptsNew(resWith('')), null);
  assert.equal(nodeAcceptsNew(resWith('yes')), null);
  assert.equal(nodeAcceptsNew(resWith('2')), null);
  // 结构不对不能抛
  assert.equal(nodeAcceptsNew(null), null);
  assert.equal(nodeAcceptsNew({}), null);
  assert.equal(nodeAcceptsNew({ headers: {} }), null);
  // 空白容忍
  assert.equal(nodeAcceptsNew(resWith(' 0 ')), false);
  assert.equal(nodeAcceptsNew(resWith(' 1 ')), true);
});

test('checkNodeAcceptsNew: 打 /healthz、no-store，并读出响应头', async () => {
  let seen = null;
  const f = async (url, init) => { seen = { url, init }; return resWith('0'); };
  assert.equal(await checkNodeAcceptsNew(f), false);
  assert.equal(seen.url, '/healthz');
  assert.equal(seen.init.cache, 'no-store');

  assert.equal(await checkNodeAcceptsNew(async () => resWith('1')), true);
  assert.equal(await checkNodeAcceptsNew(async () => resWith(null)), null);
});

test('checkNodeAcceptsNew: 请求失败 / 超时一律 null（绝不因此提示）', async () => {
  assert.equal(await checkNodeAcceptsNew(async () => { throw new Error('offline'); }), null);
  assert.equal(await checkNodeAcceptsNew(async () => { throw new Error('aborted'); }), null);

  // 永不返回的 fetch 必须被超时兜住（否则结算页会一直挂着）
  const hang = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await checkNodeAcceptsNew(hang, { timeoutMs: 30 });
  assert.equal(r, null);
  assert.ok(Date.now() - t0 < 2000, '超时没有生效');
});
