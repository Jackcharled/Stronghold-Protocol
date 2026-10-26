// 「恢复对局失败：请关闭其他设备…」的回归测试
//
// 现象：玩家点「恢复对局」后反复失败，toast 显示 ×4（15 秒内跳转 4 次）。
//
// 真实原因（多数情况与「其他设备」无关）：
//   服务端 resumeAccount 用 registry.byAccount() 查会话，而它**只查本节点内存**。
//   节点重启过、或本局已结束、或会话过期时，本节点找不到候选会话 →
//   'no active match for this account' → 前端跳到 /r/CODE → 到了那个节点还是找不到 →
//   再跳 → 触发 RESUME_HOP_KEY 的 15 秒防循环 → 弹出那句会误导人的提示。
//
//   node test/resume-fail-message.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const observer = fs.readFileSync('node-1/public/js/ui/accountObserver.js', 'utf8');
const lobby = fs.readFileSync('node-1/server/lobby.js', 'utf8');
const netSrv = fs.readFileSync('node-1/server/net.js', 'utf8');

console.log('=== 服务端失败原因（说明为什么提示会误导）===\n');
check('byAccount 只查本节点内存（不跨节点）',
  /byAccount\(accountId\) \{[\s\S]{0,200}?this\.byPlayerId\.values\(\)/.test(netSrv));
check('找不到有座位的会话 → no active match for this account',
  /if \(!candidates\.length\) return fail\(ERR\.BAD_TARGET, 'no active match for this account'\)/.test(lobby));
check('该结果与「其他设备占用」无关',
  !/no active match for this account'[\s\S]{0,80}other device/.test(lobby));

console.log('\n=== 前端提示：不能再误导成「关闭其他设备」===\n');
check('★ 旧文案已移除', !observer.includes('请关闭其他设备/标签页中的同一账号后重试'));
check('★ 新文案说明真实原因（节点重启 / 对局已结束）',
  observer.includes('本局所在节点可能刚重启过，或对局已结束'));

console.log('\n=== 跳转逻辑：已经在 /r/CODE 上就不要原地打转 ===\n');
check('★ 只有「拿到房间码且当前页不是该房间」才跳',
  /if \(code && !location\.pathname\.endsWith\('\/r\/' \+ code\)\) \{/.test(observer));
check('★ 保留 15 秒防循环（跳过一次就停）',
  /if \(Date\.now\(\) - lastHop < 15000\)/.test(observer));
check('★ 触发防循环时给出可操作的下一步', observer.includes('可回到大厅重新开始'));

console.log('\n=== 会话是否跨重启持久化（决定重启后能否恢复）===\n');
const state = fs.readFileSync('node-1/server/persist/lobbyState.js', 'utf8');
const persister = fs.readFileSync('node-1/server/persist/persister.js', 'utf8');
check('lobbyState 会写入 accountId', /accountId: s\.accountId \|\| null/.test(state));
check('persister 持久化字段含 accountId', /s\.accountId, s\.accountTag/.test(persister));
console.log('  → 会话本身会跨重启保留；失败通常发生在「重启后会话尚未恢复完就请求」或对局已结束。');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
