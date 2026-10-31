// test/match/idle-no-rejoin.test.js — 被踢出的人不能自己加回来（2026-10-31）。
//
// 维护者的规则：防消极游戏把人踢出去之后，**他不能自己再加回来**。
//
// 实现要点（也是这份测试要盯的）：
//   · 按**账号**记录，不按 playerId —— 重连会换 playerId，按 playerId 记等于没记。
//   · 记录挂在房间上，房间散了就一起没：不会「被踢一次、以后永远进不来这个房」。
//   · 只有 room.join 被拦；房主建房 / 房主重新把人拉进来走的是另一条路径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../../server/lobby.js';
import { SessionRegistry } from '../../server/net.js';
import { ERR } from '../../shared/constants.js';

function make() {
  class Rec { constructor() {} start() {} dispose() {} }
  const lobby = new Lobby({
    registry: new SessionRegistry(),
    MatchClass: Rec,
    getData: () => ({}),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const sess = (playerId, accountId, name) => ({
    playerId, accountId: accountId == null ? null : String(accountId), name, connected: true,
    // admin: true —— 测试环境 data/create-room.json 是 {"enabled":false}（建房维护开关），
    // lobby.create 对 session.admin 放行。这里只借它造房间，与「被踢不许重进」无关。
    roomCode: null, ws: null, lastActiveAt: Date.now(), admin: true,
  });
  return { lobby, sess };
}

test('被踢的账号再用 room.join 进同一个房间 → IDLE_KICKED', () => {
  const { lobby, sess } = make();
  const host = sess('p_a', 101, '甲');
  const guest = sess('p_b', 202, '乙');
  assert.equal(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }).ok, true);
  const room = lobby.roomOf(host);
  const code = room.code;
  assert.equal(lobby.join(guest, { code }).ok, true);

  // 乙被判定消极游戏踢出
  lobby.kickIdle(room, guest.playerId, guest, { reason: 'idle' });
  assert.equal(lobby.roomOf(guest) ?? null, null, '已经不在房间里了');

  // 乙想自己加回来：应当被拒
  const again = lobby.join(guest, { code });
  assert.equal(again.error, ERR.IDLE_KICKED, '应当回 IDLE_KICKED 而不是放行');
});

test('★ 重连换了 playerId 也照样拦（记录按账号，不按 playerId）', () => {
  const { lobby, sess } = make();
  const host = sess('p_a', 101, '甲');
  const guest = sess('p_b', 202, '乙');
  lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }).ok;
  const room = lobby.roomOf(host);
  const code = room.code;
  lobby.join(guest, { code });

  lobby.kickIdle(room, guest.playerId, guest, { reason: 'idle' });

  // 玩家刷新后拿到一个新的 playerId，但账号是同一个
  const reconnect = sess('p_b_new', 202, '乙');
  const again = lobby.join(reconnect, { code });
  assert.equal(again.error, ERR.IDLE_KICKED, '换 playerId 不能绕过');
});

test('没被踢的第三个账号照常能进（记录只针对被踢的那个账号）', () => {
  const { lobby, sess } = make();
  const host = sess('p_a', 101, '甲');
  const guest = sess('p_b', 202, '乙');
  const other = sess('p_c', 303, '丙');
  lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }).ok;
  const room = lobby.roomOf(host);
  const code = room.code;
  lobby.join(guest, { code });
  lobby.kickIdle(room, guest.playerId, guest, { reason: 'idle' });

  const r = lobby.join(other, { code });
  assert.equal(r.ok, true, '别人不受影响');
});

test('记录跟房间走：换一个新房间就能进（不会「以后永远进不来」）', () => {
  const { lobby, sess } = make();
  const host = sess('p_a', 101, '甲');
  const guest = sess('p_b', 202, '乙');
  lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }).ok;
  const room = lobby.roomOf(host);
  lobby.join(guest, { code: room.code });
  lobby.kickIdle(room, guest.playerId, guest, { reason: 'idle' });

  // 房主另开一个新房（旧房还在也没关系，记录不跨房间）。
  // ⚠ 同一个账号不能同时拥有两个房间（accountRoomConflict），所以这里用一个**新账号**当新房主，
  //   这跟真实场景一致：换了个房主重新开局，被踢的人应该能进新局。
  const host2 = sess('p_a2', 404, '丁');
  const r1 = lobby.create(host2, { mode: 'coop', difficulty: 'NORMAL' });
  assert.equal(r1.ok, true, '新房主应当能建房');
  const room2 = lobby.roomOf(host2);
  assert.notEqual(room2.code, room.code);
  const join2 = lobby.join(guest, { code: room2.code });
  assert.equal(join2.ok, true, '新房间不受旧房间的踢出记录影响');
});

test('游客（没有账号）被踢后无法按账号追踪——不崩，且不误伤别人', () => {
  const { lobby, sess } = make();
  const host = sess('p_a', 101, '甲');
  const guest = sess('p_b', null, '游客乙');
  lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }).ok;
  const room = lobby.roomOf(host);
  lobby.join(guest, { code: room.code });
  // 没有 accountId 时不应抛错
  assert.doesNotThrow(() => lobby.kickIdle(room, guest.playerId, guest, { reason: 'idle' }));
  assert.equal(lobby.roomOf(guest) ?? null, null);
});
