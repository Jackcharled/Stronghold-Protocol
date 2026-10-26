// client.js 版本自检：让 matchmaker 的改动也能自动下发到已打开的页面
//
// 问题：页面加载后模块留在内存里，服务器更新送不到已打开的标签页。节点的 ui/buildGuard.js
// 靠 /healthz.build 发现更新并自动刷新，但 buildTag 的覆盖范围是
// public/index.html、public/js、public/css、server/sim、shared、data
// —— **不含 matchmaker 的 client.js**。
//
// 实测（2026-10-27）：合并轮询上线 15 分钟后，12,252 次轮询里只有 215 次走新端点，
// client.js 只被请求了 9 次 —— 绝大多数玩家还在跑旧代码。
//
//   node test/client-build-guard.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const srv = fs.readFileSync('matchmaker/server.js', 'utf8');
const cli = fs.readFileSync('matchmaker/public/client.js', 'utf8');
const buildTag = fs.readFileSync('server/http/buildTag.js', 'utf8');

console.log('=== 前提：buildTag 不含 matchmaker ===\n');
const inputs = /export const BUILD_INPUTS = Object\.freeze\(\[([^\]]+)\]\)/.exec(buildTag);
check('找到 BUILD_INPUTS', !!inputs);
check('★ 确认 buildTag 不覆盖 matchmaker（这就是问题本身）',
  !!inputs && !/matchmaker/.test(inputs[1]), inputs ? inputs[1].trim() : '');

console.log('\n=== 服务端：暴露 client.js 指纹 ===\n');
check('★ 有 clientBuildTag()', /function clientBuildTag\(\)/.test(srv));
check('★ 用 sha1 前 12 位', /createHash\('sha1'\).*digest\('hex'\)\.slice\(0, 12\)/.test(srv));
check('★ 结果缓存在内存（不每次读盘）', /if \(clientBuild\) return clientBuild;/.test(srv));
check('★ /api/pulse 带上 clientBuild', /clientBuild: clientBuildTag\(\)/.test(srv));

console.log('\n=== 前端：比对与刷新 ===\n');
check('★ 有 checkClientBuild()', /function checkClientBuild\(serverBuild\)/.test(cli));
check('★ 首次记录当作"我这一份"', /if \(seenClientBuild === null\) \{ seenClientBuild = serverBuild; return; \}/.test(cli));
check('★ 相同时清除待刷标记（避免误刷）',
  /if \(serverBuild === seenClientBuild\) \{ clientReloaded = false; clientUpdatePending = false; return; \}/.test(cli));
check('★ 对局中不刷，只记待办', /if \(inRunningMatch\(\)\) \{ clientUpdatePending = true; return; \}/.test(cli));
check('★ 最多自动刷一次（clientReloaded 挡住重复）', /if \(clientReloaded\) return;/.test(cli));
check('★ pulse 返回后触发检查', /checkClientBuild\(j\.clientBuild\)/.test(cli));
check('★ 对局结束立即刷（flushClientBuildWait）', /function flushClientBuildWait\(\)/.test(cli));
check('有对局判定 inRunningMatch', /function inRunningMatch\(\)/.test(cli));

console.log('\n=== 行为模拟 ===\n');
{
  // 复刻 checkClientBuild 的状态机（不含 DOM）
  let seen = null, reloaded = false, pending = false, reloadCount = 0;
  let inMatch = false;
  const step = (build) => {
    if (typeof build !== 'string' || !build) return;
    if (seen === null) { seen = build; return; }
    if (build === seen) { reloaded = false; pending = false; return; }
    if (reloaded) return;
    if (inMatch) { pending = true; return; }
    reloaded = true; seen = build; reloadCount++;
  };
  const flush = () => {
    if (!pending || reloaded) return;
    if (inMatch) return;
    pending = false; reloaded = true; reloadCount++;
  };

  step('aaa'); // 第一次：记录
  check('首轮不刷新', reloadCount === 0);
  step('aaa');
  check('同版本不刷新', reloadCount === 0);

  inMatch = true;
  step('bbb'); // 对局中服务器更新
  check('★ 对局中不刷新', reloadCount === 0);
  check('★ 但记下待办', pending === true);

  step('bbb');
  check('待办期间仍不刷', reloadCount === 0);

  inMatch = false;
  flush(); // 对局结束
  check('★ 对局结束后立即刷一次', reloadCount === 1);

  step('ccc');
  check('已刷过不再刷（reloaded 挡住）', reloadCount === 1);

  // 新会话
  seen = null; reloaded = false; pending = false; reloadCount = 0;
  step(''); // 空 build（老节点）
  check('★ 老节点没有 clientBuild 时不刷', reloadCount === 0 && seen === null);
}

console.log('\n=== 与 buildGuard 的一致性 ===\n');
check('对局中都不打断玩家（不刷新）', /对局中：等回大厅/.test(cli));
check('最多自动刷一次，避免来回刷', /最多自动刷一次/.test(cli));
check('拿不到 build 时不刷', /typeof serverBuild !== 'string'/.test(cli));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
