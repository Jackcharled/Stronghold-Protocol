// test/ui/adminGate.test.js — public/js/ui/adminGate.js：游戏内管理员工具能不能打开。
//
// 维护者的规则（2026-10-31）：
//   **只有在自己参与的对局中才能打开；观战和隐身观战都不能。**
//
// 注意 mm/client.js 里有一份同样规则的副本（注入脚本是 IIFE，import 不了 ES 模块，
// 又要同步判断，没法调这里）。那份副本的正确性靠本文件最后一条测试盯着 ——
// 它会去源码里核对判定条件是否还在，改了这边忘了那边就会被这条测试拦下。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canOpenAdminTools } from '../../public/js/ui/adminGate.js';

/** A store state shaped like public/js/store.js's initial state. */
function state({ adminId = false, gameTool = false, match = null, room = null, myId = 'p1' } = {}) {
  return {
    adminId,
    gameTool,
    match: match === null ? { public: null, private: null, field: null, result: null, battle: null } : { public: match },
    room,
    me: { playerId: myId },
  };
}

const MATCH = { phase: 'BATTLE' };
const seat = (playerId, extra = {}) => ({ playerId, name: playerId, ...extra });

test('an admin seated in their own match may open the tools', () => {
  const s = state({ adminId: true, gameTool: true, match: MATCH, room: { seats: [seat('p1'), seat('p2')], spectators: [] } });
  assert.equal(canOpenAdminTools(s), true);
});

test('★ an admin WITHOUT tools.game may not open anything, even seated in their match', () => {
  // 维护者 2026-10-31：管理员如果没被授予 tools.game 权限，
  // 连「输入授权码的界面」和「工具界面」都不能打开。
  const s = state({ adminId: true, gameTool: false, match: MATCH, room: { seats: [seat('p1')], spectators: [] } });
  assert.equal(canOpenAdminTools(s), false);
});

test('a normal player never may, even seated in a match', () => {
  const s = state({ adminId: false, gameTool: false, match: MATCH, room: { seats: [seat('p1')], spectators: [] } });
  assert.equal(canOpenAdminTools(s), false);
});

test('an admin in the lobby (no match) may not open the tools', () => {
  const s = state({ adminId: true, gameTool: true, match: null, room: { seats: [seat('p1')], spectators: [] } });
  assert.equal(canOpenAdminTools(s), false);
});

test('an admin waiting in the room, before the match starts, may not', () => {
  const s = state({ adminId: true, gameTool: true, room: { seats: [seat('p1')], spectators: [] } });
  assert.equal(canOpenAdminTools(s), false);
});

test('★ a spectator watching someone else may NOT open the tools', () => {
  // Sitting in no seat but on the spectator list: this is the normal 观战 case.
  const s = state({
    adminId: true,
    gameTool: true,
    match: MATCH,
    room: { seats: [seat('p2'), seat('p3')], spectators: [{ playerId: 'p1' }] },
    myId: 'p1',
  });
  assert.equal(canOpenAdminTools(s), false);
});

test('★ a hidden admin-watch spectator may NOT open the tools', () => {
  // 隐身观战（?adminWatch=1&adminNode=N）把管理员加进 room.spectators，同样是观战者。
  const s = state({
    adminId: true,
    gameTool: true,
    match: MATCH,
    room: { seats: [seat('p2')], spectators: [{ playerId: 'p1', hidden: true }] },
    myId: 'p1',
  });
  assert.equal(canOpenAdminTools(s), false);
});

test('a spectator who is ALSO listed in seats is still refused (spectator wins)', () => {
  // 换座位时可能出现「既在 seats 又在 spectators」的瞬时状态：保守起见按观战处理。
  const s = state({
    adminId: true,
    gameTool: true,
    match: MATCH,
    room: { seats: [seat('p1')], spectators: [{ playerId: 'p1' }] },
    myId: 'p1',
  });
  assert.equal(canOpenAdminTools(s), false);
});

test('in a match but with no seat and no spectator entry → refused', () => {
  // 老版本隐身观战可能既不进 seats 也不进 spectators：没有席位就是在看别人打。
  const s = state({ adminId: true, gameTool: true, match: MATCH, room: { seats: [seat('p2')], spectators: [] }, myId: 'p1' });
  assert.equal(canOpenAdminTools(s), false);
});

test('unknown player id (not logged in yet) → refused', () => {
  const s = state({ adminId: true, gameTool: true, match: MATCH, room: { seats: [seat('p1')], spectators: [] }, myId: null });
  assert.equal(canOpenAdminTools(s), false);
});

test('no room / no store state → refused, never throws', () => {
  assert.equal(canOpenAdminTools(null), false);
  assert.equal(canOpenAdminTools(undefined), false);
  assert.equal(canOpenAdminTools({}), false);
  assert.equal(canOpenAdminTools(state({ adminId: true, gameTool: true, match: MATCH, room: null })), false);
});

test('a malformed seats/spectators list does not throw', () => {
  const s = state({ adminId: true, gameTool: true, match: MATCH, room: { seats: [null, undefined, seat('p1')], spectators: [null] } });
  assert.equal(canOpenAdminTools(s), true);
});

test('★ the copy inside mm/client.js still enforces the same conditions', () => {
  // 注入脚本是 IIFE、且需要同步判断，所以那边必须再写一遍。这份测试盯着它别走样：
  // 少一条（尤其是权限门 gameTool 或 spectators 那条）就意味着不该进来的人又能进来了。
  const src = fs.readFileSync(path.join(process.cwd(), 'mm', 'client.js'), 'utf8');
  assert.match(src, /function canOpenAdminTools\(st\)/, '副本必须还在');
  assert.match(src, /st\.adminId !== true/, '① 身份门');
  assert.match(src, /st\.gameTool !== true/, '①b 权限门');
  assert.match(src, /!s\.match \|\| !s\.match\.public/, '② 必须在对局里');
  assert.match(src, /\(room\.spectators \|\| \[\]\)\.some/, '④ 观战者必须被挡掉');
  assert.match(src, /\(room\.seats \|\| \[\]\)\.some/, '⑤ 必须自己坐着');
});
