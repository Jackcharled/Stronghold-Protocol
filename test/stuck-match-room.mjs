// 复现 node-19 卡死房间：对局卡住（房主断线且不再回来）时，
// sweepOldRooms 因为 room.match 存在直接 continue，房间永远不过期。
//   node test\stuck-match-room.mjs
import { Lobby, Room } from '../node-1/server/lobby.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const TTL = 15 * 60_000;
let clock = 1_000_000;

function makeLobby() {
  const lobby = new Lobby({
    log: { info() {}, warn() {}, error() {} },
    opts: {
      roomTtlMs: TTL,
      lobbyGraceMs: 60_000,
      idleKickMs: 0,
      maxRooms: 100,
      maxRoomsPerAddr: 0,
      maxBotsPerAddr: 0,
      maxMatchesPerAddr: 0,
      versions: null,
      versionHosts: null,
    },
  });
  // 假时钟
  lobby.now = () => clock;
  return lobby;
}

// 造一个「对局进行中」的房间（和 node-19 一样：solo / 1 人 / matchLive）
function seedStuckMatch(lobby, { code = 'DTTW', connected = false } = {}) {
  const room = new Room(code, 'solo', 'ABYSS', clock);
  room.content = lobby.vanilla;
  room.seats[0] = {
    seat: 0, playerId: 'p_stuck1', name: '月城苍', isBot: false,
    connected, ready: false, left: false, skins: {},
  };
  room.hostId = 'p_stuck1';
  // 关键：假装对局还活着（node-19 的向量：matchLive=True, liveRound=0, livePhase=BAND_DRAFT）
  room.match = { onDisconnect() {}, onReconnect() {} };
  room.matchCount = 1;
  room.liveRound = 0;
  room.livePhase = 'BAND_DRAFT';
  lobby.rooms.set(code, room);
  return room;
}

console.log('=== 场景：对局卡住 + 玩家早已断线，远超 15 分钟 TTL ===\n');
{
  const lobby = makeLobby();
  const room = seedStuckMatch(lobby, { connected: false });

  // 推进 6 小时（node-19 就是卡了 5.5 小时）
  clock += 6 * 3600_000;
  lobby.sweepOldRooms();

  const still = lobby.rooms.has('DTTW');
  check('★ 卡死的对局房间不会永远占着（应被回收）', !still,
    still ? `仍然存在，match=${!!room.match} livePhase=${room.livePhase}` : '已回收');
}

console.log('\n=== 对照：对局进行中且玩家在线，不该被打断 ===\n');
{
  const lobby = makeLobby();
  seedStuckMatch(lobby, { code: 'LIVE1', connected: true });
  clock += 6 * 3600_000;
  lobby.sweepOldRooms();
  check('★ 有人在打的房间不能被回收（不能影响玩家对局）', lobby.rooms.has('LIVE1'));
}

console.log('\n=== 边界 1：刚断线还没到 15 分钟，不能立刻回收 ===\n');
{
  const lobby = makeLobby();
  const room = seedStuckMatch(lobby, { code: 'JUST1', connected: false });
  room.lastHumanLeftAt = clock;      // 刚刚才断线
  clock += 5 * 60_000;               // 过了 5 分钟
  lobby.sweepOldRooms();
  check('断了 5 分钟的房间要留着（玩家可能回来续上）', lobby.rooms.has('JUST1'));
  clock += 11 * 60_000;              // 累计 16 分钟，超过 15 分钟 TTL
  lobby.sweepOldRooms();
  check('★ 断了 16 分钟的房间回收掉', !lobby.rooms.has('JUST1'));
}

console.log('\n=== 边界 2：管理员房（noExpire）—— 人在则保留，人走了要回收 ===\n');
{
  // 管理员房主**在线**：房间永久保留
  const lobby = makeLobby();
  const room = seedStuckMatch(lobby, { code: 'ADM1', connected: true });
  room.noExpire = true;
  lobby.registry = { byId: (id) => (id === 'p_stuck1' ? { playerId: 'p_stuck1', admin: true, connected: true } : null) };
  clock += 24 * 3600_000;
  lobby.sweepOldRooms();
  check('★ 管理员在线的房间永久保留', lobby.rooms.has('ADM1'));

  // 管理员房主**离线**：按普通规则回收（原先这里断言「永远不动」，后按需求改为要回收）
  const lobby2 = makeLobby();
  const room2 = seedStuckMatch(lobby2, { code: 'ADM2', connected: false });
  room2.noExpire = true;
  room2.adminLeftAt = clock;
  lobby2.registry = { byId: (id) => (id === 'p_stuck1' ? { playerId: 'p_stuck1', admin: true, connected: false } : null) };
  clock += 24 * 3600_000;
  lobby2.sweepOldRooms();
  check('★ 管理员已离线的房间要回收（管理员离线太久也要回收）', !lobby2.rooms.has('ADM2'));
}

console.log('\n=== 边界 3：多人房里还有一个人在打，不能回收 ===\n');
{
  const lobby = makeLobby();
  const room = seedStuckMatch(lobby, { code: 'MULTI', connected: false });
  room.seats[1] = { seat: 1, playerId: 'p_alive', name: '在线玩家', isBot: false, connected: true, ready: false, left: false, skins: {} };
  room.lastHumanLeftAt = clock;
  clock += 6 * 3600_000;
  lobby.sweepOldRooms();
  check('★ 只要有 1 个真人在线就保留', lobby.rooms.has('MULTI'));
}

console.log('\n=== 边界 4：被回收的房间会给断线玩家留 notice（回来能看到原因）===\n');
{
  const lobby = makeLobby();
  const room = seedStuckMatch(lobby, { code: 'CLOS1', connected: false });
  room.lastHumanLeftAt = clock;
  // 断线玩家的路径是 session.notice（disposeRoom 里 session.connected 为 false 时写入），
  // 不是 sendToPlayer —— 给它一个真会话对象
  const session = { playerId: 'p_stuck1', roomCode: 'CLOS1', connected: false, notice: null };
  lobby.registry = { byId: (id) => (id === 'p_stuck1' ? session : null) };
  clock += 20 * 60_000;
  lobby.sweepOldRooms();
  check('★ 回收时给断线玩家留下 notice（回来能看到原因）', session.notice === 'expired',
    `notice=${JSON.stringify(session.notice)} roomCode=${JSON.stringify(session.roomCode)}`);
  check('回收后玩家的 roomCode 被清空', session.roomCode === null, `roomCode=${JSON.stringify(session.roomCode)}`);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
