// client.js 自动刷新的安全门：只在非对局状态刷新
//
//   node test/client-reload-safety.mjs
//
// 背景：这个自检是为了让 matchmaker 的改动能下发到已打开的页面（节点的 buildTag 不覆盖
// matchmaker/），但它每 5 秒轮询一次、文件一变就 location.reload()。
// 实测代价：开发期一天改 6 次 client.js，等于把所有在线玩家各踢 6 次；
// 玩家正在房间/选策略/对局/填表单时刷新同样是破坏性的。
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const src = fs.readFileSync('matchmaker/public/client.js', 'utf8');

console.log('=== 1) 安全门 ===\n');
check('★ 有 safeToReload 判断', /let safeToReload = false;/.test(src));
check('★ 不安全时只记待办、不刷新', /if \(!safeToReload\) \{[\s\S]{0,140}clientUpdatePending = true;\s*\n\s*return;/.test(src));
{
  // 只看 checkClientBuild 函数内部：safeToReload 必须在它的 reload 之前
  const fnStart = src.indexOf('function checkClientBuild');
  const fnEnd = src.indexOf('function flushClientBuildWait');
  const body = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 3000);
  const iSafe = body.indexOf('let safeToReload');
  const iReload = body.indexOf('location.reload()', iSafe);
  check('safeToReload 声明在「版本自检的刷新」之前', iSafe > 0 && iReload > iSafe,
    iSafe > 0 && iReload > iSafe ? `位置 ${iSafe} < ${iReload}` : '');
}

console.log('\n=== 2) 状态判定条件 ===\n');
check('读 window.__SP__.store', /window\.__SP__/.test(src) && /g\.store/.test(src));
check('标题页（未进大厅）允许刷', /!entered/.test(src));
check('★ 对局中不刷', /inMatchNow/.test(src));
check('★ 在房间不刷', /inRoom/.test(src));
check('★ 匹配中不刷', /matching/.test(src));

console.log('\n=== 3) 不再"刷一次就永久锁死" ===\n');
check('★ 用 reloadedForBuild 记录已刷版本', /let reloadedForBuild = null;/.test(src));
check('同一 build 只刷一次', /if \(reloadedForBuild === serverBuild\) return;/.test(src));
check('没有残留的布尔量 clientReloaded', !/clientReloaded/.test(src));

console.log('\n=== 4) 行为模拟 ===\n');
{
  // 复刻 safeToReload 的判定
  const safe = (s) => {
    const entered = !!(s.session && s.session.entered);
    const phase = s.match && s.match.public && s.match.public.phase;
    const inMatchNow = !!(phase && phase !== 'LOBBY') || !!(s.match && s.match.result);
    const inRoom = !!s.room;
    const matching = !!(s.ui && (s.ui.pendingJoin || s.ui.matchmaking));
    return !entered || (!inMatchNow && !inRoom && !matching);
  };
  const cases = [
    ['标题页（没进大厅）', { session: { entered: false } }, true],
    ['大厅（无房无匹配）', { session: { entered: true }, room: null, ui: {} }, true],
    ['大厅但正在等待加入', { session: { entered: true }, room: null, ui: { pendingJoin: 'ABCD' } }, false],
    ['大厅但正在匹配', { session: { entered: true }, room: null, ui: { matchmaking: true } }, false],
    ['同盟等待室', { session: { entered: true }, room: { code: 'ABCD' } }, false],
    ['选策略 BAND_DRAFT', { session: { entered: true }, room: { code: 'ABCD' }, match: { public: { phase: 'BAND_DRAFT' } } }, false],
    ['对局中 PREP', { session: { entered: true }, room: { code: 'ABCD' }, match: { public: { phase: 'PREP' } } }, false],
    ['对局中 BATTLE', { session: { entered: true }, room: { code: 'ABCD' }, match: { public: { phase: 'BATTLE' } } }, false],
    ['结算画面', { session: { entered: true }, room: { code: 'ABCD' }, match: { result: {} } }, false],
    ['对局结束回到大厅', { session: { entered: true }, room: null, match: null, ui: {} }, true],
  ];
  let ok = true;
  for (const [name, s, want] of cases) {
    const got = safe(s);
    if (got !== want) ok = false;
    console.log(`     ${got === want ? '✓' : '✗'} ${name.padEnd(24)} 可自动刷新=${got}`);
  }
  check('★ 十种状态全部符合预期', ok);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
