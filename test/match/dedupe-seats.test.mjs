// 验证 dedupeSeats：同一账号在房间里只保留一个座位。
// 直接构造一个最小 Lobby 实例，不依赖 WebSocket / 对局。
import assert from 'node:assert/strict';

const { Lobby } = await import('../../server/lobby.js');

function makeLobby() {
  const logs = [];
  const lobby = Object.create(Lobby.prototype);
  Object.assign(lobby, {
    rooms: new Map(),
    registry: {
      _m: new Map(),
      byId(id) { return this._m.get(id) || null; },
      set(s) { this._m.set(s.playerId, s); },
    },
    log: { info: (m) => logs.push(m), warn: () => {}, error: () => {} },
    now: () => Date.now(),
  });
  lobby.disposeRoom = () => {};
  lobby.migrateHost = () => {};
  lobby.broadcastState = () => {};
  return { lobby, logs };
}

function fakeRoom(code, seatCount) {
  const seats = new Array(seatCount).fill(null);
  return {
    code, seats, hostId: null, disposed: false, match: null, matchCtx: null,
    activeHumans() { return seats.filter((s) => s && !s.isBot && !s.left); },
    seatOf(pid) { for (const s of seats) if (s && s.playerId === pid) return s; return null; },
  };
}

function seat(idx, pid, accountId, { connected = true, name = 'X' } = {}) {
  return { seat: idx, playerId: pid, name, accountId, isBot: false, connected, left: false };
}

// ---- 1) 同账号两个座位（不同 playerId）→ 清掉一个 ----
{
  const { lobby, logs } = makeLobby();
  const room = fakeRoom('DVWE', 4);
  room.seats[0] = seat(0, 'p_aaa', 'acc_1', { name: '山雎' });
  room.seats[1] = seat(1, 'p_bbb', 'acc_1', { name: '山雎' });
  room.hostId = 'p_aaa';
  const cur = { playerId: 'p_aaa', accountId: 'acc_1' };
  lobby.registry.set(cur);

  const removed = lobby.dedupeSeats(room, cur);
  assert.equal(removed, 1, '应清掉 1 个重复座位');
  assert.ok(room.seats[0], '当前会话自己的座位必须保留');
  assert.equal(room.seats[1], null, '另一个同账号座位应被清掉');
  assert.ok(logs.some((l) => l.includes('重复座位')), '应记录日志');
  console.log('  ✓ 同账号两个座位 → 清掉多余的，保留自己的');
}

// ---- 2) 只有自己一个座位 → 不动 ----
{
  const { lobby } = makeLobby();
  const room = fakeRoom('ROOM', 4);
  room.seats[0] = seat(0, 'p_aaa', 'acc_1');
  const cur = { playerId: 'p_aaa', accountId: 'acc_1' };
  lobby.registry.set(cur);
  assert.equal(lobby.dedupeSeats(room, cur), 0, '不该清任何座位');
  assert.ok(room.seats[0]);
  console.log('  ✓ 只有自己一个座位 → 不动');
}

// ---- 3) 不同账号 → 绝不动 ----
{
  const { lobby } = makeLobby();
  const room = fakeRoom('ROOM', 4);
  room.seats[0] = seat(0, 'p_aaa', 'acc_1');
  room.seats[1] = seat(1, 'p_bbb', 'acc_2');
  const cur = { playerId: 'p_ccc', accountId: 'acc_3' };
  lobby.registry.set(cur);
  assert.equal(lobby.dedupeSeats(room, cur), 0, '不同账号不该被清');
  assert.ok(room.seats[0] && room.seats[1]);
  console.log('  ✓ 不同账号 → 绝不动队友');
}

// ---- 4) 对局进行中 → 绝不动 ----
{
  const { lobby } = makeLobby();
  const room = fakeRoom('ROOM', 4);
  room.seats[0] = seat(0, 'p_aaa', 'acc_1');
  room.seats[1] = seat(1, 'p_bbb', 'acc_1');
  room.match = {};   // 对局在跑
  const cur = { playerId: 'p_aaa', accountId: 'acc_1' };
  lobby.registry.set(cur);
  assert.equal(lobby.dedupeSeats(room, cur), 0, '对局中绝不删座位');
  assert.ok(room.seats[0] && room.seats[1]);
  console.log('  ✓ 对局进行中 → 不碰任何座位');
}

// ---- 5) 游客（无 accountId）→ 不动 ----
{
  const { lobby } = makeLobby();
  const room = fakeRoom('ROOM', 4);
  room.seats[0] = seat(0, 'p_aaa', null);
  room.seats[1] = seat(1, 'p_bbb', null);
  const cur = { playerId: 'p_aaa', accountId: null };
  lobby.registry.set(cur);
  assert.equal(lobby.dedupeSeats(room, cur), 0, '游客不去重');
  assert.ok(room.seats[0] && room.seats[1]);
  console.log('  ✓ 游客（无账号）→ 不去重');
}

// ---- 6) 座位 accountId 为空但能反查到会话 → 仍能识别 ----
{
  const { lobby } = makeLobby();
  const room = fakeRoom('ROOM', 4);
  room.seats[0] = seat(0, 'p_aaa', 'acc_1');
  room.seats[1] = seat(1, 'p_bbb', null);      // 落座时令牌还没到
  const cur = { playerId: 'p_aaa', accountId: 'acc_1' };
  const old = { playerId: 'p_bbb', accountId: 'acc_1' };
  lobby.registry.set(cur);
  lobby.registry.set(old);
  const removed = lobby.dedupeSeats(room, cur);
  assert.equal(removed, 1, '通过反查会话识别出同账号');
  assert.ok(room.seats[0] && !room.seats[1]);
  console.log('  ✓ 座位 accountId 为空 → 反查会话仍能识别');
}

console.log('\n全部通过');

