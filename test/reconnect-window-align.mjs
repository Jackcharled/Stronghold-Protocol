// 重连窗口必须与房间清理 TTL 对齐，否则会出现「房间还在、人已被踢出对局」的空窗期。
//
// 两条独立的清理线：
//   A. 会话回收 net.js reconnectWindowMs → lobby.onExpire → removeMember（删座位、对局算退出）
//   B. 房间销毁 lobby.roomTtlMs（data/room-ttl.json，默认 15 分钟）→ disposeRoom
//
// 若 A < B：玩家在 [A, B) 之间回来，房间还在但座位已删，自动恢复和「恢复对局」按钮全部失效。
// 因此要求 A >= B。
//
//   node test/reconnect-window-align.mjs
import fs from 'node:fs';
import { NET_DEFAULTS } from '../node-1/server/net.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

console.log('=== 实际生效的两个时长 ===\n');
const reconnectMs = NET_DEFAULTS.reconnectWindowMs;
const ttlCfg = JSON.parse(fs.readFileSync('shared/data/room-ttl.json', 'utf8'));
const roomTtlMs = Math.round(Number(ttlCfg.minutes) * 60000);

console.log(`  会话重连窗口 reconnectWindowMs = ${reconnectMs / 60000} 分钟`);
console.log(`  房间清理 TTL  room-ttl.json   = ${roomTtlMs / 60000} 分钟`);
console.log('');

check('★ 重连窗口 >= 房间清理 TTL（不留空窗期）', reconnectMs >= roomTtlMs,
  `${reconnectMs / 60000} vs ${roomTtlMs / 60000}`);
check('★ 两者相等（同时失效，不留中间地带）', reconnectMs === roomTtlMs);

console.log('\n=== 源码核对 ===\n');
const net = fs.readFileSync('node-1/server/net.js', 'utf8');
const lobby = fs.readFileSync('node-1/server/lobby.js', 'utf8');
check('reconnectWindowMs 字面值就是 15 分钟', /reconnectWindowMs:\s*15 \* 60_000/.test(net));
check('会话过期会删座位（onExpire → removeMember）',
  (() => {
    const i = lobby.indexOf('onExpire(session) {');
    const j = lobby.indexOf('\n  }', i);
    return i > 0 && j > i && lobby.slice(i, j).includes('this.removeMember(room, session.playerId)');
  })());
check('对局中删座位 = 判中途退出（onLeave）',
  /if \(room\.match\) \{\s*\n\s*seat\.left = true;[\s\S]{0,200}?this\.callMatch\(room, 'onLeave', playerId\)/.test(lobby));
check('房间 TTL 默认 15 分钟', /roomTtlMsCache = \{ ms: 15 \* 60 \* 1000/.test(lobby) || /ms: 15 \* 60 \* 1000/.test(lobby));

console.log('\n=== 时间线（对齐后）===\n');
console.log(`  T+0      玩家断线，座位保留（connected=false）`);
console.log(`  T+0..15m 刷新可自动回对局；「恢复对局」按钮可用`);
console.log(`  T+${reconnectMs / 60000}m     会话回收 + 房间销毁同时发生 → 确实回不去了`);
console.log('  （此前是 T+10m 踢出对局、T+15m 才销毁房间，中间 5 分钟房间还在却谁也进不去）');

console.log('\n=== 单人与其它模式不受影响 ===\n');
check('单人局仍可延长到 24 小时（windowOf 取较大值）',
  /return typeof own === 'number' && own > this\.reconnectWindowMs \? own : this\.reconnectWindowMs;/.test(net));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
