// 两套恢复机制必须互不干扰：
//   A. token 恢复    —— 同一浏览器刷新：hello{token} → byToken() → resync → match.onReconnect
//   B. 账号恢复对局  —— 换设备/换浏览器：account.resume → byAccount() → 换发座位 token
// 二者可能同时被触发（刷新时既带 token 又带账号），joinFlow 必须给 B 让路，
// 否则会先抢占一个新座位，和 B 的「接管旧座位」打架。
//   node test/recovery-mechanisms.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const client = fs.readFileSync('matchmaker/public/client.js', 'utf8');
const observer = fs.readFileSync('node-1/public/js/ui/accountObserver.js', 'utf8');
const lobby = fs.readFileSync('node-1/server/lobby.js', 'utf8');
const netSrv = fs.readFileSync('node-1/server/net.js', 'utf8');

console.log('=== A. token 恢复（同一浏览器刷新）===\n');
check('hello 携带 token', /session = msg\.token \? this\.registry\.byToken\(msg\.token\) : null;/.test(netSrv));
check('服务端标记 resumed', /resumed = true;/.test(netSrv));
check('onHello → resync', /this\.resync\(session, !resumed\);/.test(lobby));
check('对局中 resync 走 match.onReconnect',
  /this\.callMatch\(room, room\.spectatorOf\(session\.playerId\) \? 'addSpectator' : 'onReconnect'/.test(lobby));

console.log('\n=== B. 账号恢复对局（换设备）===\n');
check('前端会发 account.resume', /net\.request\('account\.resume'\)/.test(observer));
check('监听 account.resume 回包', /net\.on\('account\.resume'/.test(observer));
check('服务端按账号找会话', /this\.registry\.byAccount\(session\.accountId\)/.test(lobby));
check('★ 接管时换发座位 token（旧设备随即失效）', /this\.registry\.rotateToken\(old\)/.test(lobby));
check('★ 旧设备收到 account.detached 并断开', /sendSession\(old, \{ t: 'account\.detached'/.test(lobby));
check('只接管有座位的会话（房间号 + 座位都在）',
  /\.filter\(\(s\) => s !== session && s\.roomCode && this\.rooms\.get\(s\.roomCode\)\?\.seatOf\(s\.playerId\)\)/.test(lobby));

console.log('\n=== 两者共存：joinFlow 必须给 B 让路 ===\n');
check('★ accountObserver 用 __SP_ACCOUNT_RESUME_PENDING 标记窗口',
  /window\.__SP_ACCOUNT_RESUME_PENDING = true/.test(observer));
check('★ joinFlow 检查该标记并让路',
  /if \(window\.__SP_ACCOUNT_RESUME_PENDING === true/.test(client));
check('★ 让路有上限（残留标记不会把玩家永久挡在外面）',
  /ACCOUNT_RESUME_YIELD_MS/.test(client) && /Date\.now\(\) - startedAt < ACCOUNT_RESUME_YIELD_MS/.test(client));
check('★ 标记在成功/失败/超时/跳转各路径都会被清掉',
  (observer.match(/__SP_ACCOUNT_RESUME_PENDING = false/g) || []).length >= 4,
  `找到 ${(observer.match(/__SP_ACCOUNT_RESUME_PENDING = false/g) || []).length} 处清理`);

console.log('\n=== 防重复座位 ===\n');
check('accountObserver 在恢复前阻止 /r/CODE 抢先建座位',
  /Block the \/r\/CODE pending-join from creating a second seat/.test(observer));
check('B 失败/无候选时有明确回报', /no active match for this account/.test(lobby));

console.log('\n=== resumeAccount 的前置条件（B 什么时候用不了）===\n');
check('需要账号（游客不行）', /if \(!session\.accountId\) return fail\(ERR\.BAD_TARGET, 'account login required'\)/.test(lobby));
check('游客明确拒绝', /if \(session\.guest\) return fail\(ERR\.BAD_TARGET, 'guest cannot resume'\)/.test(lobby));
console.log('  → 游客/未登录只能靠 A（token 恢复）；清掉浏览器数据后 A、B 都失效');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
