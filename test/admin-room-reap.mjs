// 管理员房（noExpire）如果管理员离线太久，也必须被回收。
// 以前的实现：noExpire 只看「房主是不是管理员」，是的话无条件跳过所有过期判定，
// 于是管理员断线后再也不回来，房间就永远挂在那里（和普通玩家卡死房一个毛病，只是更严重，
// 因为管理员房连 15 分钟 TTL 都不走）。
//   node test\admin-room-reap.mjs
import { Lobby, Room } from '../node-1/server/lobby.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const TTL = 15 * 60_000;
let clock = 1_000_000;

function makeLobby() {
  const lobby = new Lobby({
    log: { info() {}, warn() {}, error() {} },
    options: {
      roomTtlMs: TTL, lobbyGraceMs: 60_000, idleKickMs: 0,
      maxRooms: 100, maxRoomsPerAddr: 0, maxBotsPerAddr: 0, maxMatchesPerAddr: 0,
    },
  });
  const sessions = new Map();
  lobby.now = () => clock;
  lobby.registry = {
    byId: (id) => sessions.get(id) || null,
    byAccount: (a) => [...sessions.values()].filter((s) => s.accountId === a),
    rotateToken: () => 'tok',
  };
  return { lobby, sessions };
}

function adminSession(sessions, id = 'p_admin1', connected = true) {
  const s = {
    playerId: id, name: '服主', tag: '0001', connected, admin: true,
    limitKey: '10.0.0.1', addr: '10.0.0.1', accountId: 'admin-acc',
    guest: false, ws: { readyState: 1, send() {} }, roomCode: null,
  };
  sessions.set(id, s);
  return s;
}

console.log('=== 场景 1：管理员建房后离线，远超 TTL，房间必须回收 ===\n');
{
  const { lobby, sessions } = makeLobby();
  const adm = adminSession(sessions);
  const r = lobby.create(adm, { mode: 'coop', difficulty: 'FUNNY' });
  check('管理员建房成功', !r?.error, JSON.stringify(r).slice(0, 80));
  const room = lobby.rooms.get(adm.roomCode);
  check('管理员房标记为 noExpire', room && room.noExpire === true, `noExpire=${room?.noExpire}`);

  // 管理员断线（走真实的 onDisconnect）
  adm.connected = false;
  lobby.onDisconnect(adm);

  clock += 6 * 3600_000;   // 6 小时
  lobby.sweepOldRooms();
  check('★ 管理员离线 6 小时后房间被回收', !lobby.rooms.has(room.code),
    lobby.rooms.has(room.code) ? `仍然存在 noExpire=${room.noExpire}` : '已回收');
}

console.log('\n=== 场景 2：管理员在线挂着，房间不能动 ===\n');
{
  const { lobby, sessions } = makeLobby();
  const adm = adminSession(sessions);
  lobby.create(adm, { mode: 'coop', difficulty: 'FUNNY' });
  const room = lobby.rooms.get(adm.roomCode);
  clock += 12 * 3600_000;   // 12 小时
  lobby.sweepOldRooms();
  check('★ 管理员一直在线的房间永远不会过期', lobby.rooms.has(room.code));
}

console.log('\n=== 场景 3：管理员刚离线不久，给足回来时间 ===\n');
{
  const { lobby, sessions } = makeLobby();
  const adm = adminSession(sessions);
  lobby.create(adm, { mode: 'coop', difficulty: 'FUNNY' });
  const room = lobby.rooms.get(adm.roomCode);
  adm.connected = false;
  lobby.onDisconnect(adm);
  clock += 10 * 60_000;     // 10 分钟
  lobby.sweepOldRooms();
  check('管理员离线 10 分钟：房间要留着（可能只是切窗口）', lobby.rooms.has(room.code));
}

console.log('\n=== 场景 4：管理员又回来了，计时作废 ===\n');
{
  const { lobby, sessions } = makeLobby();
  const adm = adminSession(sessions);
  lobby.create(adm, { mode: 'coop', difficulty: 'FUNNY' });
  const room = lobby.rooms.get(adm.roomCode);
  adm.connected = false;
  lobby.onDisconnect(adm);
  clock += 20 * 60_000;
  // 回来了（走真实的 onHello，它会把 seat.connected 置回 true 并清掉 lastHumanLeftAt）
  adm.connected = true;
  lobby.onHello(adm, { resumed: true, repeat: false });
  clock += 6 * 3600_000;
  lobby.sweepOldRooms();
  check('★ 管理员离开 20 分钟后回来，房间保留且不再计时', lobby.rooms.has(room.code));
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
