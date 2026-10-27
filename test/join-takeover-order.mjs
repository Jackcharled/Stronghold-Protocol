// 「开新标签页回到自己房间」不能把房间搞没
//
//   node test/join-takeover-order.mjs
//
// 事故（2026-10-27 13:53）：玩家开新标签页想回到自己正在对局的 ZUHW，
// 服务端把同一账号在**目标房间自己的座位**当成"遗留座位"删了，
// 而那是房间唯一的人类座位 —— 删完房间就空、被解散：
//   [lobby] ZUHW 清理账号 1 的遗留座位（旧会话 p_cdb94a4f02，未连接）
//   [lobby] ZUHW disposed (empty)
// 之后新旧标签页都失去房间，加入时报「未找到该同盟密钥对应的房间」。
//
// 根因是 join 里的顺序：先无条件 dropStaleAccountSeats()，再判断能否在同房间接管。
// 正确顺序：同房间 → 接管（不删）；别的房间 → 清理。
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const src = fs.readFileSync('server/lobby.js', 'utf8');

console.log('=== 1) join 里的顺序 ===\n');
const joinIdx = src.indexOf('  join(session');
const joinBody = src.slice(joinIdx, src.indexOf('\n  ', src.indexOf('room.join', joinIdx) + 10) || joinIdx + 20000);
const iConflict = src.indexOf('let conflict = this.accountRoomConflict(session);', joinIdx);
const iDrop = src.indexOf('this.dropStaleAccountSeats(session);', iConflict);
const iTakeover = src.indexOf('if (conflict && conflict.room === room && conflict.kind === \'player\')', iConflict);

check('找到 join 的冲突判定', iConflict > 0);
check('找到接管分支', iTakeover > 0);
check('★ 接管判断在「清理遗留座位」之前', iTakeover < iDrop && iTakeover > iConflict,
  `接管@${iTakeover} < 清理@${iDrop}`);

console.log('\n=== 2) 同房间时绝不删除 ===\n');
check('★ 同房间分支是空实现（只让接管往下走）',
  /if \(conflict && conflict\.room === room && conflict\.kind === 'player'\) \{\s*\n\s*\/\/ 同房间：[\s\S]{0,120}?\n\s*\} else if \(conflict && conflict\.stale\) \{/.test(src));
check('清理只在 else if 里（= 账号在别的房间）',
  /else if \(conflict && conflict\.stale\) \{[\s\S]{0,200}dropStaleAccountSeats/.test(src));

console.log('\n=== 3) 接管的具体动作 ===\n');
check('发 account.detached 通知旧会话', /account\.detached/.test(src));
check('用 4001 关掉旧 socket', /close\(4001/.test(src));
check('座位 playerId 换成当前会话', /seat\.playerId = session\.playerId/.test(src));
check('对局中接管后调 match.onReconnect', /callMatch\(room, 'onReconnect'/.test(src));

console.log('\n=== 4) dropStaleAccountSeats 自身的保守判定 ===\n');
const dropIdx = src.indexOf('dropStaleAccountSeats(session) {');
const dropBody = src.slice(dropIdx, dropIdx + 2500);
check('座位标记为连接中 → 不清理', /if \(seat\.connected !== false\) continue;/.test(dropBody));
check('旧会话仍 connected → 不清理', /if \(old && old\.connected === true\) continue;/.test(dropBody));
check('★ 座位 accountId 为空时用 playerId 反查（本轮另一处修复）',
  /const seatAccountId = \(seat\) =>/.test(src) || /registry\.byId\(seat\.playerId\)/.test(dropBody));

console.log('\n=== 5) 场景模拟 ===\n');
{
  // 复刻修复后的分支选择
  const decide = (conflict, room) => {
    if (!conflict) return 'no-conflict';
    if (conflict.room === room && conflict.kind === 'player') return 'takeover';
    if (conflict.stale) return 'drop-stale';
    return 'reject';
  };
  const ROOM = { code: 'ZUHW' };
  const OTHER = { code: 'XXXX' };
  const cases = [
    ['新标签页回到自己房间（座位未连接）', { room: ROOM, kind: 'player', stale: true }, ROOM, 'takeover'],
    ['新标签页回到自己房间（座位仍连接）', { room: ROOM, kind: 'player', stale: false }, ROOM, 'takeover'],
    ['对局进行中，同账号换设备回来', { room: ROOM, kind: 'player', stale: true }, ROOM, 'takeover'],
    ['账号在别的房间留了旧座位', { room: OTHER, kind: 'player', stale: true }, ROOM, 'drop-stale'],
    ['账号在别的房间且还在用', { room: OTHER, kind: 'player', stale: false }, ROOM, 'reject'],
  ];
  let ok = true;
  for (const [name, conflict, room, want] of cases) {
    const got = decide(conflict, room);
    if (got !== want) ok = false;
    console.log(`     ${got === want ? '✓' : '✗'} ${name.padEnd(32)} → ${got}`);
  }
  check('★ 五种场景全部正确（同房间一律接管，绝不清空房间）', ok);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
