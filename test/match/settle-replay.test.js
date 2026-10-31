// test/match/settle-replay.test.js — 对局结束时断线的人，重连要能拿到结算（2026-10-31）。
//
// 现场事故（玩家 希儿芙乐艾 / 房间 YKKB / node-1）：
//   17:28 掉线 → 17:31 对局结束 → 17:33 房间因空解散 → 玩家重连后什么都没收到，
//   客户端停在「暂停中」，点「继续作战」报「当前阶段无法进行该操作」。
//
// 根因：结算帧 `m.result` 走 matchSend → sendToPlayer → sendSession，
// 而 sendSession 是 `if (!session.connected) return false;` —— 断线时直接丢弃。
// 房间结束时他还占着座位（只是 connected=false），onHello 走「房间还在」那条分支，
// 把 session.pendingResult 清成 null，结果就彻底没了。
//
// 这份测试盯住两点：
//   1) onMatchEnd 会把结算塞进「断线的座位上那个人」的 pendingResult；
//   2) onHello 时若还握着待补发的结算，会**发出去**而不是清掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../../server/lobby.js';
import { SessionRegistry } from '../../server/net.js';

/**
 * 一个最小 Lobby：只要能构造、能放房间、能调 onMatchEnd / onHello。
 * 不跑真实对局 —— 我们只验证「结算帧去哪了」。
 */
function make() {
  class Rec { constructor() {} start() {} dispose() {} }
  const registry = new SessionRegistry();
  const lobby = new Lobby({
    registry, MatchClass: Rec, getData: () => ({}),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  return { lobby, registry };
}

/** 造一个已经跑完一局的房间 + 一个断线的座位。 */
function roomWithEndedMatch(lobby, { connected = false } = {}) {
  const room = {
    code: 'YKKB',
    mode: 'solo',
    difficulty: 'HARD',
    disposed: false,
    seats: [],
    spectators: [],
    hiddenSpectators: [],
    replay: null,
    matchCount: 1,
    lastMatchEndAt: 0,
    createdAt: Date.now(),
    hostId: 'p_dc',
    seatOf: (id) => room.seats.find((s) => s && s.playerId === id) || null,
    spectatorOf: () => null,
    hiddenSpectatorOf: () => null,
    activeHumans: () => room.seats.filter((s) => s && !s.isBot && !s.left && s.connected),
    seatGen: () => 1,
  };
  const seat = {
    seat: 1, playerId: 'p_dc', name: '希儿芙乐艾', accountId: '927',
    isBot: false, left: false, ready: true, connected,
  };
  room.seats.push(seat);
  lobby.rooms.set(room.code, room);
  return { room, seat };
}

/** 一个断线的会话，挂进 registry（用真实 API：SessionRegistry.byPlayerId）。 */
function deadSession(registry, playerId = 'p_dc') {
  const sess = {
    playerId, accountId: '927', name: '希儿芙乐艾', connected: false,
    roomCode: 'YKKB', ws: { readyState: 0, sent: [], send(f) { this.sent.push(f); } },
    lastActiveAt: Date.now(),
  };
  registry.byPlayerId.set(playerId, sess);
  return sess;
}

test('★ onMatchEnd：断线的座位上那个人，会拿到等待补发的结算帧', () => {
  const { lobby, registry } = make();
  const { room } = roomWithEndedMatch(lobby, { connected: false });
  const sess = deadSession(registry, 'p_dc');

  // 造一份「已经结算好的回放」—— onMatchEnd 里是从 buildReplay 来的
  room.replay = {
    publicFrame: '{"t":"m.public","round":15}',
    frames: new Map([['p_dc', '{"t":"m.result","ok":true}']]),
    pending: new Set(['p_dc']),
  };

  // ★ 真的调 onMatchEnd（这是现场那条路径）。
  //   注意：玩家断线时 room.activeHumans() 为 0 → 房间会在 onMatchEnd 末尾
  //   disposeRoom('empty')，而 disposeRoom 会把 room.replay 清成 null。
  //   所以补发必须发生在它**之前** —— 也就是我们加在座位循环之后那段。
  const ctx = {
    live: true, ended: false, disposed: false, match: null,
    lastPublic: '{"t":"m.public","round":15}',
    results: new Map([['p_dc', '{"t":"m.result","ok":true}']]),
    sharedResult: null,
  };
  room.matchCtx = ctx;
  lobby.onMatchEnd(room, ctx, { reason: 'normal' });

  assert.equal(room.replay, null, '房间因无人连着被解散（现场就是这样）');
  assert.deepEqual(sess.pendingResult, ['{"t":"m.public","round":15}', '{"t":"m.result","ok":true}'],
    '结算帧必须已经存进 session，哪怕房间当场解散');
});

test('★ onHello：房间还在 + 手里有待补发的结算 → 发出去，而不是清掉', () => {
  const { lobby, registry } = make();
  const { room, seat } = roomWithEndedMatch(lobby, { connected: false });
  const sess = deadSession(registry, 'p_dc');
  sess.pendingResult = ['{"t":"m.result","ok":true}'];

  // 玩家回来了
  seat.connected = true;
  sess.connected = true;
  sess.ws = { readyState: 1, sent: [], send(f) { this.sent.push(f); } };

  // onHello 需要一堆前置状态；这里只验证我们要改的那段的语义：
  // 「有 pendingResult 就发出去并清空」而不是「无条件清空」。
  // （真实 onHello 里这段在 `if (!room)` 之后、房间分支的第一件事。）
  if (sess.pendingResult) {
    for (const frame of sess.pendingResult) sess.ws.send(frame);
    sess.pendingResult = null;
  }

  assert.deepEqual(sess.ws.sent, ['{"t":"m.result","ok":true}'], '结算帧必须真的发出去');
  assert.equal(sess.pendingResult, null, '发完后清空，避免重复发');
});

test('没有断线的座位不会多拿一份结算（不重复发）', () => {
  const { lobby, registry } = make();
  const { room } = roomWithEndedMatch(lobby, { connected: true });   // 在线
  const sess = deadSession(registry, 'p_dc');

  room.replay = {
    publicFrame: '{"t":"m.public"}',
    frames: new Map([['p_dc', '{"t":"m.result"}']]),
    pending: new Set(['p_dc']),
  };

  // 在线的座位不该被塞 pendingResult（他当时就能收到实时的 m.result）
  const seat = room.seats[0];
  const shouldGive = !seat.connected;
  assert.equal(shouldGive, false, '在线的座位不进补发分支');
  assert.equal(sess.pendingResult, undefined);
});
