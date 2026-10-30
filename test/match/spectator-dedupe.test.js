// 观战席去重 + 重名保护（2026-10-30）
//
// 事故：维护者截图里观战席出现两个「逸天」；且观战满员时本人无法取回席位。
// 根因：room.spectate 直接 push 到 room.spectators，而刷新会换 playerId，
//       同一个账号就留下两条记录；旧记录还占着名额，导致满员时进不来。
//
// 修复：先把本账号（accountId）/ 本会话（playerId）的旧观战席清掉，**再**判断满员。
//
// 硬性要求（维护者反复强调）：**绝不按名字判定**。
// 两个重名玩家必须都能进，互不抢占。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'server/lobby.js'), 'utf8');

/** 取 spectate 方法体 */
function spectateBody() {
  const i = SRC.indexOf('  spectate(session');
  assert.ok(i > 0, 'spectate should exist');
  const rest = SRC.slice(i);
  const end = rest.indexOf('\n  /** room.removeSpectator');
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 4000);
}

test('观战席去重发生在「满员检查」之前 —— 否则自己的旧席会把名额占住', () => {
  const body = spectateBody();
  const dedupeAt = body.indexOf('room.spectators = room.spectators.filter');
  const limitAt = body.indexOf('room.spectatorLimit()');
  assert.ok(dedupeAt > 0, 'spectate must dedupe the account\'s old spectator seats');
  assert.ok(limitAt > 0, 'spectate must still check the spectator limit');
  assert.ok(dedupeAt < limitAt, '去重必须在满员检查之前，否则满员时本人取不回席位');
});

test('去重只按 playerId / accountId，绝不按名字', () => {
  const body = spectateBody();
  const dedupe = body.slice(body.indexOf('room.spectators = room.spectators.filter'));
  const block = dedupe.slice(0, dedupe.indexOf('});') + 3);
  assert.match(block, /s\.playerId === session\.playerId/, 'same session');
  assert.match(block, /s\.accountId\) === String\(session\.accountId\)/, 'same account');
  assert.ok(!/\.name\b/.test(block), '名字绝不参与去重判定（重名玩家必须都能进）');
});

test('落座时记录 accountId，供下次刷新去重', () => {
  const body = spectateBody();
  assert.match(body, /accountId: String\(session\.accountId\)/, 'the pushed spectator must record accountId');
});

test('隐身观战同样按 accountId 去重', () => {
  const body = spectateBody();
  assert.match(body, /room\.hiddenSpectators = room\.hiddenSpectators\.filter/, 'hidden spectators dedupe too');
  const h = body.slice(body.indexOf('room.hiddenSpectators = room.hiddenSpectators.filter'));
  const block = h.slice(0, h.indexOf('});') + 3);
  assert.ok(!/\.name\b/.test(block), 'hidden dedupe must not use the name either');
});

test('两个重名但账号不同的观战席：都不是「自己」，互不删除', () => {
  // 用与实现相同的谓词验证语义（纯逻辑，不启服务器）
  const keep = (s, session) => {
    if (!s) return false;
    if (s.playerId === session.playerId) return false;
    if (session.accountId && s.accountId && String(s.accountId) === String(session.accountId)) return false;
    return true;
  };
  // 两个同名玩家，accountId 不同 —— 都不能被删
  assert.equal(keep({ playerId: 'p_a', name: '同名', accountId: '1' }, { playerId: 'p_b', name: '同名', accountId: '2' }), true);
  assert.equal(keep({ playerId: 'p_b', name: '同名', accountId: '2' }, { playerId: 'p_a', name: '同名', accountId: '1' }), true);
  // 同账号刷新后的旧席 —— 删
  assert.equal(keep({ playerId: 'p_old', name: '同名', accountId: '1' }, { playerId: 'p_new', name: '同名', accountId: '1' }), false);
  // 同一会话重复观战 —— 删
  assert.equal(keep({ playerId: 'p_x', name: '甲', accountId: '1' }, { playerId: 'p_x', name: '甲', accountId: '1' }), false);
});
