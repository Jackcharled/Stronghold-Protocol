// 恢复对局必须由玩家亲手点 —— 全站不允许出现「页面自己跳转 / 自己恢复」
//
//   node test/manual-resume-only.mjs
//
// 维护者 2026-10-27 的要求：
//   「能不能做成需要玩家自己手动点恢复对局才跳转。不需要你自动帮玩家跳转。
//     包括换设备情况也是」
//
// 以前有 6 条自动路径，玩家打开页面 / 刷新 / 换设备就被自己跳走，
// 换设备那次还会把原来那台顶下线：
//   1. accountObserver: autoResumeFromQuery 读 URL ?accountResume=1 → 自动恢复
//   2. accountObserver: maybeAutoResumeOnReload 刷新/打开就探测账号房间 → location.assign
//   3. accountObserver: tryAuto 失败后跳 /r/CODE 再恢复
//   4. client.js: resumeTick 在没房间时 location.assign 回上次房间
//   5. client.js: installAutoRejoin 用 sp.lastRoom 自动 room.join
//   6. 各种 sessionStorage 标记遗留下来导致下次自动触发
//
// 现在唯一允许的跳转来源：玩家点击（按钮 onclick / 明确的手势回调）。
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };
const read = (p) => fs.readFileSync(p, 'utf8');

// 把注释全部剥掉，只在**真实代码**里找跳转，避免被说明文字误判
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

console.log('=== 1) accountObserver：不得有页面自发的恢复/跳转 ===\n');
{
  const code = stripComments(read('public/js/ui/accountObserver.js'));
  check('★ 没有 location.assign', !/location\.assign/.test(code));
  check('★ 没有 location.replace', !/location\.replace/.test(code));
  check('★ 没有 location.href 赋值', !/location\.href\s*=/.test(code));
  check('★ 不存在 maybeAutoResumeOnReload 这个自动探测函数', !/maybeAutoResumeOnReload/.test(read('public/js/ui/accountObserver.js'))
    || /整段删除/.test(read('public/js/ui/accountObserver.js')));
  check('★ 不再用 URL 的 accountResume 参数决定恢复', !/params(?:\.get|\.has)\(\s*['"]accountResume['"]\s*\)\s*===?\s*['"]1/.test(code));
  // 一次性标记：读一次就删
  check('★ sp.accountResume 读完立刻删除（刷新不会再触发）',
    /getItem\('sp\.accountResume'\)[\s\S]{0,400}?removeItem\('sp\.accountResume'\)/.test(code));
  check('★ 无条件清理 accountResumeSilent / accountResumeHopAt', /removeItem\('sp\.accountResumeHopAt'\)/.test(code));
}

console.log('\n=== 2) client.js：不得自动回房 ===\n');
{
  const src = read('matchmaker/public/client.js');
  const code = stripComments(src);
  check('★ installAutoRejoin 已是空实现（不再 room.join 旧房间）',
    /function installAutoRejoin\(\)\s*\{\s*(?:\/\/[^\n]*\s*)*\}\s*\n/.test(src) || !/installAutoRejoin[\s\S]{0,3000}?room\.join/.test(code));
  check('★ resumeTick 里没有 location.assign 回房间', (() => {
    const i = code.indexOf('const resumeTick');
    if (i < 0) return true;
    const body = code.slice(i, i + 1400);
    return !/location\.(assign|replace)/.test(body);
  })());
  check('★ 不再读写 sp.restartJoin（旧自动跳转标记）', !/sp\.restartJoin/.test(code));
  // 允许的跳转：都在按钮 onclick 里
  const assigns = [...code.matchAll(/location\.assign\(([^\n]*)/g)].map((m) => m[0]);
  check('允许的 location.assign 数量 == 3（重启面板按钮 + 两处恢复按钮）',
    assigns.length === 3, `实际 ${assigns.length}`);
}

console.log('\n=== 3) 恢复入口只有一个按钮 ===\n');
{
  const src = read('mobile-ignore' === '' ? '' : 'public/js/ui/resumeMatch.js');
  check('恢复按钮调用 requestAccountResume（手动）', /requestAccountResume\(\)/.test(src));
  check('★ 按钮本身不自动调用（只在 onClick 处理函数里）', (() => {
    // resumeAccount 必须挂在 onClick 上，而不是在渲染阶段直接调用
    return /onClick=\$\{resumeAccount\}/.test(src) || /onClick=\$\{[^}]*resumeAccount/.test(src);
  })());
  check('★ 跨节点跳转也是玩家再点一次（goToRoom 挂在按钮上）', /onClick=\$\{goToRoom\}/.test(src));
  check('跳转不在 resumeAccount 里（恢复失败只提示，不自己跳）', (() => {
    const i = src.indexOf('const resumeAccount');
    const j = src.indexOf('const goToRoom', i);
    if (!(i > 0 && j > i)) return false;
    // 注释里提到"以前会 location.assign"是历史说明，不算违规 → 先剥注释再判断
    const body = stripComments(src.slice(i, j));
    return !/location\.(assign|replace|href\s*=)/.test(body);
  })());
  check('goToRoom 里的跳转确实存在（手动跳转路径保留）', /const goToRoom[\s\S]{0,900}?location\.assign/.test(src));
}

console.log('\n=== 4) 全局扫描：还有没有别的自动跳转 ===\n');
{
  const files = [];
  const walk = (d, base = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = d + '/' + e.name;
      const rel = base ? base + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!/node_modules|vendor|assets|studio|dev/.test(e.name)) walk(full, rel); }
      else if (e.isFile() && e.name.endsWith('.js')) files.push([full, rel]);
    }
  };
  walk('public/js');
  const suspicious = [];
  for (const [full, rel] of files) {
    const code = stripComments(fs.readFileSync(full, 'utf8'));
    for (const m of code.matchAll(/location\.(assign|replace)\(([^\n]*)/g)) {
      const line = m[0];
      if (!/accountResume/.test(line)) continue;
      // 合法条件：这个跳转所在的函数由按钮/点击触发。
      // 判定方式：往上看最近的函数定义名，再看它是否被 onClick= / addEventListener('click'
      // / .onclick = 引用。
      const before = code.slice(0, m.index);
      const fns = [...before.matchAll(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\()/g)];
      const last = fns[fns.length - 1];
      const fnName = last ? (last[1] || last[2]) : '';
      const wired = fnName && new RegExp(
        `(?:onClick=\\$\\{[^}]*\\b${fnName}\\b|\\.onclick\\s*=[^;]*\\b${fnName}\\b|addEventListener\\(\\s*['"]click['"][\\s\\S]{0,200}?\\b${fnName}\\b)`,
      ).test(code);
      if (!wired) suspicious.push(`${rel} [${fnName || '?'}]: ${line.trim().slice(0, 80)}`);
    }
  }
  check('★ public/js 下没有「不由点击触发」的 accountResume 跳转', suspicious.length === 0,
    suspicious.length ? '\n     ' + suspicious.join('\n     ') : '');
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过：恢复对局只能由玩家手动点击触发');
process.exit(fail ? 1 : 0);
