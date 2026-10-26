// 页面不能重复加载 —— 否则跨节点「加入同盟 / 观战」必然要输两次房间号。
//
// 曾经的 bug：mm/account-title.js 里有一段「旧缓存自检」，检查
// /js/screens/lobby.js 的文本里是否含 'accountTag'。但整个项目从来没写入过这个标记，
// 于是每次进入页面都判定「拿到的是旧版脚本」并 location.reload() 一次：
//   第 1 次加载读走 sessionStorage 的 mm.pendingRoom（跨节点跳转的目标房间）并删除，
//   第 2 次加载读不到 → joinFlow 不执行 → 玩家必须再输一次房间号。
//
//   node test/page-single-load.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const at = readFileSync(resolve(root, 'matchmaker/public/account-title.js'), 'utf8');
const lobby = readFileSync(resolve(root, 'node-1/public/js/screens/lobby.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass++; }
  else { fail++; console.log(`  FAIL ${n}${extra ? '  ' + extra : ''}`); }
};

console.log('页面单次加载（跨节点加入/观战的前提）');

// 1) 那个失效的自检必须不再存在
ok('★ account-title.js 不再检查 accountTag', !/txt\.includes\('accountTag'\)/.test(at));
ok('★ 不再因「旧缓存自检」强制 reload', !/mm\.reload1/.test(at));

// 2) account-title.js 的自动 reload 只应出现在用户动作里（重置云端数据）
//    先去掉注释行，避免把说明文字当成调用
const atCode = at.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const reloads = [...atCode.matchAll(/location\.reload\(\)/g)];
ok(`account-title.js 的 location.reload() 只剩用户动作触发（当前 ${reloads.length} 处）`, reloads.length <= 1,
  reloads.length > 1 ? '有自动 reload 会在加载时多刷一次' : '');

// 3) lobby.js 本身没有 accountTag，这正说明那种自检永远为真
ok('（事实核对）lobby.js 不含 accountTag —— 旧自检必然每次触发', !lobby.includes('accountTag'));

// 4) pendingRoom 的读取仍然是「读到就删」，且只在一处顶层读取
const mm = readFileSync(resolve(root, 'matchmaker/public/client.js'), 'utf8');
const reads = [...mm.matchAll(/getItem\('mm\.pendingRoom'\)/g)];
ok('mm.pendingRoom 只在启动时读取一次', reads.length === 1, `实际 ${reads.length} 处`);
ok('读到 pendingRoom 立刻删除（避免重复触发）', /getItem\('mm\.pendingRoom'\)[\s\S]{0,200}removeItem\('mm\.pendingRoom'\)/.test(mm));

// 5) PENDING_JOIN 必须排在 JOIN_COOKIE 之前
const iHost = mm.indexOf("IS_HOST && MID && TICKET && SECRET && DIFF) hostFlow");
const iRoomUi = mm.indexOf('roomUi(sp);', iHost);
const block = iHost >= 0 && iRoomUi > iHost ? mm.slice(iHost, iRoomUi) : '';
ok('★ PENDING_JOIN 排在 JOIN_COOKIE 之前',
  block.indexOf('PENDING_JOIN) joinFlow') >= 0 && block.indexOf('PENDING_JOIN) joinFlow') < block.indexOf('JOIN_COOKIE) resolveRoomNode'));

console.log(`\n结果: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
