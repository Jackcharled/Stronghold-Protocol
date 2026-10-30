// onDisconnect 的席位查找必须覆盖 roomOf() 认的全部三种身份：座位、普通观战、隐身观战
// （hiddenSpectators）。旧代码写的是 `room.seatOf(id) || room.spectatorOf(id)`，漏掉隐身观战，
// 于是 seat 为 null、`seat.connected = false` 抛 TypeError（[net] onDisconnect crashed）。
//
// 后果不只是少记一个字段：net.js 里 session.connected 已经置 false 了，而 onDisconnect 余下的
// startGrace / broadcastState / lastHumanLeftAt 全都没跑 —— 房间状态与真实情况脱节。
// 线上 2026-10-26 ~ 10-30 共 12 个节点 31 次（各节点 logs/*.error*.log 的 `onDisconnect crashed`）。
//
// 这里用 Object.create(Room.prototype) 造最小房间，只验证 watcherOf 的覆盖面与 onDisconnect 的取席方式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../../server/lobby.js';

/** 最小 Room 替身：只放 watcherOf / seatOf / spectatorOf / hiddenSpectatorOf 需要的字段。 */
function fakeRoom({ seats = [], spectators = [], hiddenSpectators = [] } = {}) {
  const room = Object.create(Room.prototype);
  room.code = 'AAAA';
  room.disposed = false;
  room.match = null;
  room.seats = seats;
  room.spectators = spectators;
  room.hiddenSpectators = hiddenSpectators;
  room.versionVote = null;
  return room;
}

const mkSeat = (playerId, name) => ({ playerId, name, connected: true, isBot: false, left: false, guest: false });

test('Room.watcherOf 覆盖 普通观战 / 隐身观战；座位由 seatOf 单独取', () => {
  const room = fakeRoom({
    seats: [mkSeat('p_seat', '甲')],
    spectators: [mkSeat('p_spec', '乙')],
    hiddenSpectators: [mkSeat('p_hidden', '丙')],
  });

  assert.equal(room.seatOf('p_seat')?.playerId, 'p_seat', '座位');
  assert.equal(room.watcherOf('p_spec')?.playerId, 'p_spec', '普通观战');
  assert.equal(room.watcherOf('p_hidden')?.playerId, 'p_hidden', '隐身观战');
  assert.equal(room.watcherOf('p_nobody'), null, '不在房间里');
  assert.equal(room.watcherOf('p_seat'), null, 'watcherOf 只管观战者，不含座位');
});

test('★ 隐身观战：旧代码的取席表达式返回 null（这就是崩溃点）', () => {
  const room = fakeRoom({ hiddenSpectators: [mkSeat('p_hidden', '丙')] });

  const oldExpr = room.seatOf('p_hidden') || room.spectatorOf('p_hidden');
  assert.equal(oldExpr, null, '旧表达式取不到隐身观战 —— 下一行 seat.connected 必然抛异常');

  const newExpr = room.seatOf('p_hidden') || room.watcherOf('p_hidden');
  assert.ok(newExpr, 'seatOf || watcherOf 能取到');
  assert.doesNotThrow(() => { newExpr.connected = false; }, '赋值不再崩溃');
  assert.equal(room.hiddenSpectatorOf('p_hidden').connected, false, '标记的是同一个对象');
});

test('座位与普通观战：新旧表达式结果一致（修复不改变原有行为）', () => {
  const room = fakeRoom({
    seats: [mkSeat('p_seat', '甲')],
    spectators: [mkSeat('p_spec', '乙')],
  });

  for (const id of ['p_seat', 'p_spec']) {
    const oldExpr = room.seatOf(id) || room.spectatorOf(id);
    const newExpr = room.seatOf(id) || room.watcherOf(id);
    assert.ok(oldExpr && newExpr, `${id}: 两者都非空`);
    assert.equal(newExpr, oldExpr, `${id}: 指向同一个席位对象`);
  }
});

test('座位优先于观战：同一 playerId 两处都有时取座位（与旧表达式一致）', () => {
  const seat = mkSeat('p_both', '甲');
  const spec = mkSeat('p_both', '甲');
  const room = fakeRoom({ seats: [seat], spectators: [spec] });
  assert.equal(room.seatOf('p_both') || room.watcherOf('p_both'), seat, '取座位那个对象，不是观战席');
});

// startGrace 的定时器回调同样用 `seatOf || spectatorOf` 找席位。不崩（有判空），但有行为缺陷：
// 隐身观战者断线后找不到席位 → `if (!s || s.connected) return` → removeMember 永不执行，
// 观战席位永久残留。改成 `seatOf || watcherOf` 后，过期检查能看到它。
test('★ startGrace 的席位查找：隐身观战者必须能被看到（否则过期后永不移除）', () => {
  const room = fakeRoom({ hiddenSpectators: [{ ...mkSeat('p_hidden', '丙'), connected: false }] });

  const oldExpr = room.seatOf('p_hidden') || room.spectatorOf('p_hidden');
  assert.equal(oldExpr, null, '旧表达式看不到隐身观战者 → 回调里 `!s` 成立 → 直接 return，不移除');

  const newExpr = room.seatOf('p_hidden') || room.watcherOf('p_hidden');
  assert.ok(newExpr, 'watcherOf 能看到');
  assert.equal(newExpr.connected, false, '能看到「已断开」，回调会继续走到 removeMember');
});
