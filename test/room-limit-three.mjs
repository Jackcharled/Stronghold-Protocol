// 验证 room limit = 3（新配置）下的行为：
//  1) 同一网络（同 IP）可以建 3 个房间
//  2) 第 4 个被挡（防护仍在）
//  3) 对局结束 / 中途退出 / 刷新页面后都能建房
//  4) 一个账号仍只能在一个房间里（这条设计不能松）
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = process.cwd();
const { Lobby } = await import(pathToFileURL(path.join(ROOT, 'node-1/server/lobby.js')).href);

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const log = { info() {}, warn() {}, error() {}, debug() {} };
let seq = 0;
function mkWorld(maxRoomsPerAddr = 3) {
  const lobby = new Lobby({ data: {}, log, options: { maxRoomsPerAddr } });
  const sessions = new Map();
  lobby.registry = {
    byId: (id) => sessions.get(id) || null,
    byAccount: (a) => [...sessions.values()].filter((s) => s.accountId === a),
    rotateToken: () => 'tok',
  };
  return { lobby, sessions };
}
function session(opts = {}) {
  seq += 1;
  const id = 'p' + seq;
  return {
    playerId: id, name: opts.name || 'P' + seq, tag: '0001',
    connected: opts.connected !== false, admin: false,
    limitKey: opts.limitKey !== undefined ? opts.limitKey : '223.101.108.54',
    addr: '223.101.108.54',
    accountId: opts.accountId || '90' + seq, guest: false,
    ws: { readyState: 1, send() {} }, roomCode: null,
  };
}
const rateOf = (r) => (r && (r.code === 'RATE' || r.error === 'RATE' || /too many rooms/.test(String(r.detail || '')))) ? r : null;
const fakeMatch = () => ({ addSpectator() {}, removeSpectator() {}, onLeave() {}, setHost() {}, dispose() {}, onDisconnect() {}, publicView: () => ({ t: 'm.public', phase: 'prep', round: 1, players: [] }) });

console.log('room limit = 3（新配置）\n');

console.log('=== 1) 同一网络 3 名玩家各建一房（宿舍/家庭/网吧）===');
{
  const { lobby, sessions } = mkWorld();
  const ok = [];
  for (let i = 1; i <= 3; i++) {
    const s = session({ name: '同网玩家' + i }); sessions.set(s.playerId, s);
    const r = lobby.create(s, { mode: 'coop', difficulty: 'FUNNY' });
    ok.push(!(r?.ok === false) && !rateOf(r));
  }
  check('3 名玩家都能建房', ok.every(Boolean), ok.map((x, i) => `${i + 1}:${x ? 'OK' : 'BLOCKED'}`).join(' '));
}

console.log('\n=== 2) 第 4 个房间被挡（防护还在）===');
{
  const { lobby, sessions } = mkWorld();
  for (let i = 1; i <= 3; i++) {
    const s = session(); sessions.set(s.playerId, s);
    lobby.create(s, { mode: 'coop', difficulty: 'FUNNY' });
  }
  const s4 = session({ name: '第4人' }); sessions.set(s4.playerId, s4);
  const r = lobby.create(s4, { mode: 'coop', difficulty: 'FUNNY' });
  check('第 4 个房间被 RATE 挡住', !!rateOf(r), JSON.stringify(r).slice(0, 110));
}

console.log('\n=== 3) 对局结束 / 中途退出 / 刷新页面后建房（原反馈场景）===');
{
  const { lobby, sessions } = mkWorld();
  const a = session({ name: '雾灯' }); sessions.set(a.playerId, a);
  lobby.create(a, { mode: 'coop', difficulty: 'FUNNY' });
  const room = lobby.rooms.get(a.roomCode);
  lobby.addBot(room, a);
  const ctx = { live: true, ended: false, disposed: false, results: new Map(), lastPublic: null };
  room.matchCtx = ctx; room.match = fakeMatch();
  lobby.onMatchEnd(room, ctx, {});
  const r1 = lobby.create(a, { mode: 'coop', difficulty: 'FUNNY' });
  check('对局结束后能建房', !rateOf(r1) && !r1?.error, JSON.stringify(r1).slice(0, 110));
}
{
  const { lobby, sessions } = mkWorld();
  const a = session(); sessions.set(a.playerId, a);
  lobby.create(a, { mode: 'coop', difficulty: 'FUNNY' });
  const room = lobby.rooms.get(a.roomCode);
  lobby.addBot(room, a);
  room.match = fakeMatch();
  lobby.leave(a);
  const r = lobby.create(a, { mode: 'coop', difficulty: 'FUNNY' });
  check('中途退出后能建房', !rateOf(r) && !r?.error, JSON.stringify(r).slice(0, 110));
}
{
  // 刷新页面：新 playerId，同 accountId，旧座位已断线
  // 注意：真实的 onDisconnect 会同时把 session.connected 和 **座位 seat.connected** 标成 false。
  // 以前这里只标了 session，座位仍是 connected:true —— 于是 dropStaleAccountSeats 按设计
  // （座位还标着「连接中」就绝不清理）拒绝清理，用例永远失败，但线上并不会出现这个问题。
  const { lobby, sessions } = mkWorld();
  const a = session({ name: '雾灯' }); sessions.set(a.playerId, a);
  lobby.create(a, { mode: 'coop', difficulty: 'FUNNY' });
  const oldRoom = lobby.rooms.get(a.roomCode);
  a.connected = false;
  const oldSeat = oldRoom && oldRoom.seatOf(a.playerId);
  if (oldSeat) oldSeat.connected = false;
  a.roomCode = null;
  const a2 = session({ accountId: a.accountId, name: '雾灯' }); sessions.set(a2.playerId, a2);
  const r = lobby.create(a2, { mode: 'coop', difficulty: 'FUNNY' });
  check('★ 刷新页面后能建房（遗留座位被清理）', !r?.error, JSON.stringify(r).slice(0, 120));
}

console.log('\n=== 4) 一个账号只能在一个房间（设计不能松）===');
{
  const { lobby, sessions } = mkWorld();
  const a = session(); sessions.set(a.playerId, a);
  const b = session(); sessions.set(b.playerId, b);
  lobby.create(a, { mode: 'coop', difficulty: 'FUNNY' });
  const roomA = lobby.rooms.get(a.roomCode);
  lobby.create(b, { mode: 'coop', difficulty: 'FUNNY' });
  const roomB = lobby.rooms.get(b.roomCode);
  // 让 a 以新会话（同账号）加入 b 的房间 —— 但 a 还在线，所以不能抢
  const aDup = session({ accountId: a.accountId }); sessions.set(aDup.playerId, aDup);
  const r = lobby.join(aDup, { code: roomB.code });
  check('同账号在线时不能进第二个房间', !!r?.error, JSON.stringify(r).slice(0, 110));
  check('房间数没被误删', lobby.rooms.has(roomA.code) && lobby.rooms.has(roomB.code));
}

console.log('\n=== 5) 旧配置 1 下的对比（回归确认）===');
{
  const { lobby, sessions } = mkWorld(1);
  const a = session(); sessions.set(a.playerId, a);
  const b = session(); sessions.set(b.playerId, b);
  lobby.create(a, { mode: 'coop', difficulty: 'FUNNY' });
  const r = lobby.create(b, { mode: 'coop', difficulty: 'FUNNY' });
  check('旧限制 1 时第二人被挡（确认改动确实生效）', !!rateOf(r), JSON.stringify(r).slice(0, 110));
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
