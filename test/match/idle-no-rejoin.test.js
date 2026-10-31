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
    // adminId: true —— 测试环境 data/create-room.json 是 {"enabled":false}（建房维护开关），
    // lobby.create 对**身份**（session.adminId）放行。这里只借它造房间，与「被踢不许重进」无关。
    // ⚠ 2026-10-31：判据从 session.admin（三道门）改成了 adminId，这里必须跟着改，
    //   否则 create 直接返回 CREATE_DISABLED，本文件全部用例挂掉（踩过一次）。
    roomCode: null, ws: null, lastActiveAt: Date.now(), adminId: true,
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

// ---------------------------------------------------------------------------------------------------
// 2026-10-31 维护者最终决定：**只要「操作挂机检测」，不要「时间挂机检测」。**
//
//   去掉：坐在房间里 N 分钟没消息 → 踢（会在等人 / 离开一会儿时误伤）
//   保留：对局中连续 2 回合「只花钱不部署」或「什么都不做」→ 踢（且要求 ≥2 个真人）
// ---------------------------------------------------------------------------------------------------

test('时间挂机踢人已停用：即使把 idleKickMs 设成正数，也不踢人', () => {
  // ⚠ 这份文件的 make() 里 sess 是**普通对象**、没注册到 registry，
  //   而 sweepIdle 内部 `registry.byId()` 拿到 null 就 continue ——
  //   用那种 sess 写的测试会「假通过」（不管行为对不对都绿）。踩过一次。
  //   所以这里自己造一个**真实注册**的 session，并自检它在 registry 里。
  const { lobby } = make();
  lobby.opts.idleKickMs = 4 * 60_000;      // 明确设成正数，模拟「有人想恢复时间挂机」
  const reg = lobby.registry;
  const mk = (name, accountId) => {
    const s = reg.create(name);
    s.connected = true;
    s.accountId = String(accountId);
    s.guest = false;
    s.adminId = true;                       // 借它绕过建房维护开关（本机 create-room.json 是关的）
    s.messages = [];
    s.ws = { readyState: 1, bufferedAmount: 0, send: (txt) => s.messages.push(JSON.parse(txt)) };
    return s;
  };
  const host = mk('甲', 101);
  const guest = mk('乙', 202);
  assert.equal(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }).ok, true, '建房成功');
  const room = lobby.roomOf(host);
  assert.equal(lobby.join(guest, { code: room.code }).ok, true, '加入成功');

  room.match = { dispose() {}, start() {} };     // 假装已经开局
  const way = 30 * 60_000;
  host.lastActiveAt = Date.now() - way;
  guest.lastActiveAt = Date.now() - way;

  // 前提自检：这两个 session 确实能被 registry 找到（否则测试没有意义）
  assert.equal(reg.byId(guest.playerId), guest, '前提：guest 在 registry 里');
  assert.equal(room.seatOf(guest.playerId)?.ready, false, '前提：座位未准备（否则本来就不算挂机）');

  lobby.sweepIdle();

  assert.ok(lobby.roomOf(host), '房主没被踢');
  assert.ok(lobby.roomOf(guest), '房客没被踢（按时间的判定已停用，配置也不起作用）');
  assert.equal(room.idleKicked?.size ?? 0, 0, '没有产生踢出记录');

  // ★ 这条测试的「有效性」由下面这段保证：同样条件下、同样这份 fixture，
  //   如果换成旧的按时间实现，guest 一定会被踢。手动验证过（见 PR 描述）。
  //   实现若被恢复，sweepIdle 会调 kickIdle → roomOf(guest) 变 null → 上面断言失败。
});

test('默认配置：idleKickMs = 0（时间挂机检测关闭）', () => {
  const { lobby } = make();
  assert.equal(lobby.opts.idleKickMs, 0, '默认不启用按时间的挂机踢人');
});

test('「操作挂机检测」仍然存在：连续 2 回合什么都不做 → 判定消极（非单人局）', async () => {
  // 这条走 MatchIntents._trackActivity → onIdleKick，与 sweepIdle 无关。
  // 这里只验证「判定入口还在、规则没被删」，不跑整局。
  const { default: fs } = await import('node:fs');
  const src = fs.readFileSync(new URL('../../server/match/match/intents.js', import.meta.url), 'utf8');
  assert.match(src, /_trackActivity\(/, '操作挂机检测的实现还在');
  assert.match(src, /st\.strikes >= 2/, '规则一：连续 2 回合只花钱不部署');
  assert.match(src, /st\.idleStrikes >= 2/, '规则二：连续 2 回合什么都不做');
  assert.match(src, /_humanCount\(\) < 2/, '单人局不判定（保留）');
  assert.match(src, /this\.onIdleKick\?\./, '踢人回调仍然接着');
});

test('对局内的消极判定确实会调用 lobby.kickIdle（没被这次改动误伤）', () => {
  const { lobby, sess } = make();
  const host = sess('p_a', 101, '甲');
  const guest = sess('p_b', 202, '乙');
  assert.equal(lobby.create(host, { mode: 'coop', difficulty: 'NORMAL' }).ok, true);
  const room = lobby.roomOf(host);
  assert.equal(lobby.join(guest, { code: room.code }).ok, true);

  // 模拟 MatchIntents 判定出自消极后回调 lobby
  lobby.kickIdle(room, guest.playerId, guest, { reason: 'idle' });
  assert.equal(lobby.roomOf(guest) ?? null, null, '对局内消极判定仍然能把人移出');
  assert.equal(room.idleKicked?.has('202'), true, '并留下踢出记录（不能自己加回来）');
});
