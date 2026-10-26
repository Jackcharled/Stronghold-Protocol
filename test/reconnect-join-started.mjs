// 掉线刷新后「回不到对局」的回归：joinFlow 不能把 ROOM_STARTED 当终态清场。
//
// 背景：玩家掉线刷新，服务端在 hello 的 resume 里把会话接回原房间
// （lobby.onHello → resync → 对局 match.onReconnect）。但 matchmaker/client.js 的 joinFlow
// 会抢在 room.state 到达前发 room.join；对局已开始时服务端回 ROOM_STARTED，
// 旧代码把它当确定性失败：清掉 mm.pendingRoom / sp_join / URL 并弹「加入失败：模拟已开始」，
// 玩家就被踢回大厅，表现为「掉线后回不到对局」。
//
//   node test/reconnect-join-started.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const client = fs.readFileSync('matchmaker/public/client.js', 'utf8');
const lobby = fs.readFileSync('node-1/server/lobby.js', 'utf8');
const netSrv = fs.readFileSync('node-1/server/net.js', 'utf8');

console.log('=== 服务端 resume 路径必须完好（这是回对局的唯一正路）===\n');
check('hello 用 token 找回会话', /session = msg\.token \? this\.registry\.byToken\(msg\.token\) : null;/.test(netSrv));
check('找回后标记 resumed', /resumed = true;/.test(netSrv));
check('onHello 触发 resync', /this\.resync\(session, !resumed\);/.test(lobby));
check('对局中 resync 走 match.onReconnect',
  /if \(room\.match\) \{\s*\n\s*this\.callMatch\(room, room\.spectatorOf\(session\.playerId\) \? 'addSpectator' : 'onReconnect', session\.playerId\);/.test(lobby));
check('断线只标记 connected=false，座位保留', /seat\.connected = false;/.test(lobby));
check('room.join 对已在房内的成员是幂等的',
  /if \(cur === room && !room\.spectatorOf\(session\.playerId\)\) \{ this\.sendState\(room, session\); return OK; \}/.test(lobby));

console.log('\n=== 客户端 joinFlow 不得清场 ===\n');
check('★ ROOM_STARTED 单独判定为 startedCode',
  /const startedCode = code2 === 'ROOM_STARTED' \|\|/.test(client));
check('★ terminal 判定排除 startedCode', /const terminal = !startedCode && \(/.test(client));
check('★ ROOM_STARTED 分支早于清场逻辑 return', /if \(startedCode\) \{[\s\S]{0,900}?return;\s*\}\s*\n\s*joined = true;/.test(client));
check('★ ROOM_STARTED 时不清 mm.pendingRoom', (() => {
  const i = client.indexOf('if (startedCode) {');
  const seg = client.slice(i, client.indexOf('return;', i));
  return seg.length > 0 && !seg.includes("removeItem('mm.pendingRoom')");
})());
check('★ ROOM_STARTED 时不清 sp_join cookie', (() => {
  const i = client.indexOf('if (startedCode) {');
  const seg = client.slice(i, client.indexOf('return;', i));
  return !seg.includes('sp_join=; Path=/');
})());
check('★ ROOM_STARTED 时主动请求 state.resync', (() => {
  const i = client.indexOf('if (startedCode) {');
  const seg = client.slice(i, client.indexOf('return;', i));
  return seg.includes("net.request('state.resync'");
})());
check('提示语不再是「加入失败：模拟已开始」', client.includes('正在把你送回对局'));

console.log('\n=== 抢跑保护：先等 resume ===\n');
check('★ 有 resume 宽限窗口常量', /RESUME_GRACE_MS = \d+/.test(client));
check('★ 对局中 + 宽限期内不发 room.join',
  /const inMatchNow = !!\(s\.match && \(s\.match\.phase \|\| s\.match\.public\)\);[\s\S]{0,120}?return;/.test(client));
check('协议的 state.resync 已注册',
  fs.readFileSync('node-1/shared/protocol.js', 'utf8').includes("'state.resync': {}"));

console.log('\n=== 其它终态仍应清场（别把这两个也放过了）===\n');
check('ROOM_FULL 仍是终态', /code2 === 'ROOM_FULL'/.test(client));
check('ROOM_NOT_FOUND 仍是终态', /code2 === 'ROOM_NOT_FOUND'/.test(client));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
