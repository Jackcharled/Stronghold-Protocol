// 「同账号同房间可以接管」的回归测试。
//
// 现象：武桐_Uton（owner）在房间 DGCF 对局中，换标签页/设备后「回不去」，
// 提示「恢复对局失败」或「该账号已在其他房间中」。
//
// 根因（两处叠加）：
//   1. room.join 的幂等判断用 session.playerId 比较：
//        if (cur === room && !room.spectatorOf(session.playerId)) return OK;
//      换设备/新标签页时 playerId 不同 → 判定不成立 → 落到下面的冲突检查。
//   2. accountRoomConflict 看到「同 accountId 的座位且 connected=true」→
//      stale=false → 直接 fail(SESSION_IN_USE)，拒绝进入。
//   于是玩家被挡在自己正在对局的房间外面。
//
//   node test/resume-same-room-takeover.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const lobby = fs.readFileSync('node-1/server/lobby.js', 'utf8');

console.log('=== 1) 冲突检测只看 connected（这是被挡住的直接原因）===\n');
check('accountRoomConflict 存在', /accountRoomConflict\(session\) \{/.test(lobby));
check('★ stale 判定是 `!old || old.connected !== true`',
  /const stale = !old \|\| old\.connected !== true;/.test(lobby));
console.log('  → 对局中 connected=true 的座位被判成「正在使用」，不算 stale，于是拒绝进入');

console.log('\n=== 2) join 里必须区分「同一房间」与「其他房间」===\n');
check('★ 存在同房间接管分支（conflict.room === room && kind === 玩家）',
  /conflict\.room === room && conflict\.kind === 'player'/.test(lobby));
check('★ 接管时把座位交给当前会话',
  /seat\.playerId = session\.playerId;/.test(lobby) && /seat\.connected = true;/.test(lobby));
check('★ 接管时旧设备的 socket 被断开（4001 account moved）',
  /oldWs\.close\(4001, 'account moved'\)/.test(lobby));
check('★ 房主身份随座位转移',
  /if \(room\.hostId === oldSeatPid\) room\.hostId = session\.playerId;/.test(lobby));
check('★ 对局中接管后重推对局状态（onReconnect）',
  /if \(room\.match\) \{ try \{ this\.callMatch\(room, 'onReconnect', session\.playerId\); \}/.test(lobby));
check('★ 「其他房间」仍然拒绝（不能被接管逻辑放过）',
  /if \(conflict\) return fail\(ERR\.SESSION_IN_USE, '该账号已在其他房间中，请先离开原房间'\);/.test(lobby));

console.log('\n=== 3) 接管前的清理顺序 ===\n');
check('先清理 stale 座位再重新判定',
  (() => {
    const i = lobby.indexOf('let conflict = this.accountRoomConflict(session);');
    if (i < 0) return false;
    const j = lobby.indexOf("if (conflict) return fail(ERR.SESSION_IN_USE", i);
    if (j < 0) return false;
    const seg = lobby.slice(i, j);
    const drop = seg.indexOf('dropStaleAccountSeats');
    const takeover = seg.indexOf("conflict.kind === 'player'");
    return drop >= 0 && takeover >= 0 && drop < takeover;
  })());
check('对局外的同房间冲突先按 stale 清理一次',
  /if \(conflict && conflict\.room === room && conflict\.kind === 'player' && !room\.match\) \{[\s\S]{0,120}?dropStaleAccountSeats/.test(lobby));

console.log('\n=== 4) 与 account.resume 行为一致 ===\n');
check('resumeAccount 也在同一账号的不同会话间转移座位',
  /resumeAccount\(session\) \{[\s\S]{0,600}?registry\.byAccount/.test(lobby));
check('两边都会断开旧 socket（行为一致）',
  (lobby.match(/close\(4001, 'account moved'\)/g) || []).length >= 2,
  `找到 ${(lobby.match(/close\(4001, 'account moved'\)/g) || []).length} 处`);

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
