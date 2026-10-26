// 对局中掉线能否恢复：直接验证服务端的会话保留与恢复链路。
// 三件事决定「刷新后能不能回到对局」：
//   1. 断线时座位是否保留（不踢人）
//   2. 会话重连窗口有多长（过期就真的回不去了）
//   3. 用同一 token 重连是否命中同一会话（resume 而非新建）
//   node test/reconnect-midmatch.mjs
import { TokenBucket, SessionRegistry } from '../node-1/server/net.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

console.log('=== 1) 重连窗口：多久之内还能回去 ===\n');
const reg = new SessionRegistry({});
check('★ 默认重连窗口 = 10 分钟', reg.reconnectWindowMs === 600000, `${reg.reconnectWindowMs} ms`);

const s = reg.create('雾灯');
check('建会话成功', !!s?.token);
s.connected = true;
s.disconnectedAt = null;

// byToken() 内部用 this.now()（真实当前时间）判过期，所以断线时间必须基于真实时钟
const NOW = Date.now();

console.log('\n=== 2) 断线后 5 分钟：仍可恢复 ===\n');
s.connected = false;
s.disconnectedAt = NOW - 5 * 60_000;
check('5 分钟时未过期', reg.isExpired(s, NOW) === false);
check('★ 同一 token 能找到会话（= resume 而非新建）', reg.byToken(s.token) === s);

console.log('\n=== 3) 断线超过 10 分钟：会话被回收 ===\n');
check('10 分 01 秒时已过期', reg.isExpired(s, NOW + 5 * 60_000 + 1000) === true);
console.log('  → 超过 10 分钟，服务端会移除会话，玩家只能重新进房（对局已开始则进不去）');

console.log('\n=== 4) 单人模式可以延长到 24 小时 ===\n');
const s2 = reg.create('雾灯2');
s2.connected = false;
s2.disconnectedAt = NOW;
s2.resumeWindowMs = 24 * 3600 * 1000;
check('单人局 11 分钟后仍未过期', reg.isExpired(s2, NOW + 11 * 60_000) === false);
check('windowOf 采用较长的那个', reg.windowOf(s2) === 24 * 3600 * 1000);
check('但不会被缩短', (() => {
  const s3 = reg.create('x');
  s3.resumeWindowMs = 1000;   // 比默认短
  return reg.windowOf(s3) === reg.reconnectWindowMs;
})());

console.log('\n=== 5) 服务端关键保证（源码核对）===\n');
const fs = await import('node:fs');
const lobby = fs.readFileSync('node-1/server/lobby.js', 'utf8');
check('★ 断线只标记 connected=false，不删座位', /seat\.connected = false;/.test(lobby)
  && !/onDisconnect[\s\S]{0,600}?removeMember\(room, session\.playerId\)/.test(lobby));
check('★ 对局中大厅宽限期不淘汰玩家（if room.match return）',
  /if \(room\.disposed \|\| room\.match\) return;/.test(lobby));
check('★ 重连后清掉宽限计时', /this\.clearGrace\(session\.playerId\);/.test(lobby));
check('★ 重连后把座位标回 connected', /seat\.connected = true;/.test(lobby));
check('★ 重连后 resync 到对局（match.onReconnect）',
  /this\.callMatch\(room, room\.spectatorOf\(session\.playerId\) \? 'addSpectator' : 'onReconnect', session\.playerId\)/.test(lobby));

console.log('\n=== 结论 ===\n');
console.log('  对局中掉线 → 座位保留 → 10 分钟内（单人 24 小时）刷新可自动回到对局。');
console.log('  超过窗口或对局结束，就只能重新开一局。');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
