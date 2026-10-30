// sameGhostSeat：刷新后「幽灵座位」判定的边界（2026-10-30）
//
// 背景：玩家刷新时客户端可能换掉 reconnect token，服务端把它当新玩家建了新会话；
// 那时 session.accountId 还是空的，旧的 accountRoomConflict 直接放弃，
// 于是座位被自己的旧会话占着 → 报「该同盟人数已满，无法加入」，且旧会话 15 分钟后才过期。
//
// 兜底必须**很严**：宁可让玩家手动恢复，也不能把别人的座位抢过来。
// 维护者特别指出：玩家可以重名，不能出现「两个同名玩家只有一个能进来」。
//
// 这里直接调用 Lobby.prototype.sameGhostSeat，用假的 registry/rooms 验证判定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../../server/lobby.js';

/** 最小化的 Lobby 替身：只需要 registry.byId 和 rooms。 */
function fakeLobby({ sessions = {}, rooms = {} } = {}) {
  const lobby = Object.create(Lobby.prototype);
  lobby.registry = { byId: (pid) => sessions[pid] || null };
  lobby.rooms = new Map(Object.entries(rooms).map(([code, r]) => [code, r]));
  return lobby;
}
const seatIn = (code) => ({ code });
const mkRoom = (seats, { match = null } = {}) => ({ disposed: false, seats, match });
const mkSeat = (o) => ({ isBot: false, left: false, guest: false, ...o });

test('★ 只有名字相同、没有任何账号依据 → 不接管（重名保护）', () => {
  // 2026-10-30 收严：名字可以重名，绝不能作为身份依据。
  // 两边都没有 accountId / tag 时一律不接管，宁可让玩家手动用密钥回去，也不误抢重名玩家的座位。
  const seat = mkSeat({ playerId: 'p_old', name: '武桐_Uton', accountId: null, tag: null });
  const room = mkRoom([seat]);
  const lobby = fakeLobby({ sessions: {}, rooms: { QBJH: room } });
  const session = { playerId: 'p_new', name: '武桐_Uton', accountId: null, tag: null, guest: false };
  assert.equal(lobby.sameGhostSeat(session, seat, room), false);
});

test('旧会话还连着 → 绝不抢（那是真人）', () => {
  const seat = mkSeat({ playerId: 'p_old', name: '武桐_Uton' });
  const room = mkRoom([seat]);
  const lobby = fakeLobby({ sessions: { p_old: { connected: true } }, rooms: { QBJH: room } });
  const session = { playerId: 'p_new', name: '武桐_Uton', guest: false };
  assert.equal(lobby.sameGhostSeat(session, seat, room), false);
});

test('名字不同 → 不接管', () => {
  const seat = mkSeat({ playerId: 'p_old', name: '塔露拉' });
  const room = mkRoom([seat]);
  const lobby = fakeLobby({ sessions: {}, rooms: { QBJH: room } });
  const session = { playerId: 'p_new', name: '武桐_Uton', guest: false };
  assert.equal(lobby.sameGhostSeat(session, seat, room), false);
});

test('★ 两个同名幽灵 → 都不接管（维护者明确要求：不能只剩一个人能进）', () => {
  const a = mkSeat({ playerId: 'p_old1', name: '同名' });
  const b = mkSeat({ playerId: 'p_old2', name: '同名' });
  const room = mkRoom([a], { match: null });
  const other = mkRoom([b]);
  const lobby = fakeLobby({ sessions: {}, rooms: { QBJH: room, OTHER: other } });
  const session = { playerId: 'p_new', name: '同名', guest: false };
  assert.equal(lobby.sameGhostSeat(session, a, room), false, '两个同名幽灵时无法判断身份，必须放弃');
  assert.equal(lobby.sameGhostSeat(session, b, other), false);
});

test('对局进行中 → 不按名字接管（进度比便利重要）', () => {
  const seat = mkSeat({ playerId: 'p_old', name: '武桐_Uton' });
  const room = mkRoom([seat], { match: {} });
  const lobby = fakeLobby({ sessions: {}, rooms: { QBJH: room } });
  const session = { playerId: 'p_new', name: '武桐_Uton', guest: false };
  assert.equal(lobby.sameGhostSeat(session, seat, room), false);
});

test('accountId 一致时直接接管，与名字无关（改名后刷新也能回来）', () => {
  const seat = mkSeat({ playerId: 'p_old', name: '旧名字', accountId: '1' });
  const room = mkRoom([seat], { match: {} });
  const lobby = fakeLobby({ sessions: { p_old: { connected: false, accountId: '1' } }, rooms: { QBJH: room } });
  const session = { playerId: 'p_new', name: '新名字', accountId: '1', guest: false };
  assert.equal(lobby.sameGhostSeat(session, seat, room), true);
});

test('accountId 不同 → 不接管（是别人的座位）', () => {
  const seat = mkSeat({ playerId: 'p_old', name: '武桐_Uton', accountId: '9' });
  const room = mkRoom([seat]);
  const lobby = fakeLobby({ sessions: { p_old: { connected: false, accountId: '9' } }, rooms: { QBJH: room } });
  const session = { playerId: 'p_new', name: '武桐_Uton', accountId: '1', guest: false };
  assert.equal(lobby.sameGhostSeat(session, seat, room), false);
});

test('tag 一致优先于名字（同名不同 tag 不接管）', () => {
  const seat = mkSeat({ playerId: 'p_old', name: '同名', tag: '1111' });
  const room = mkRoom([seat]);
  const lobby = fakeLobby({ sessions: { p_old: { connected: false, tag: '1111' } }, rooms: { QBJH: room } });
  assert.equal(lobby.sameGhostSeat({ playerId: 'p_new', name: '同名', tag: '1111', guest: false }, seat, room), true);
  assert.equal(lobby.sameGhostSeat({ playerId: 'p_new', name: '同名', tag: '2222', guest: false }, seat, room), false);
});

test('游客不参与接管', () => {
  const seat = mkSeat({ playerId: 'p_old', name: '游客甲', guest: true });
  const room = mkRoom([seat]);
  const lobby = fakeLobby({ sessions: {}, rooms: { QBJH: room } });
  assert.equal(lobby.sameGhostSeat({ playerId: 'p_new', name: '游客甲', guest: true }, seat, room), false);
});
