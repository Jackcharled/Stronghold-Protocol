// 「本局模拟已结束」面板不能被无关的标签页看到
//
//   node test/restart-panel-scope.mjs
//
// 玩家报告（2026-10-27）：
//   「我打开了新的标签页，提示我这个内容（本局模拟已结束 / 返回同盟）。
//     然后我点击返回同盟，回到的是我刚刚新开的对局。」
//
// 两个独立缺陷：
//   A. sp.matchInterrupted 存在 **localStorage**（跨标签页共享、30 分钟有效），
//      而 resumeTick 里「只要没有房间就弹面板」—— 于是任何新标签页都会看到它。
//      新标签页跟那一局毫无关系，不该提示。
//   B. 「返回同盟」按钮先读标记拿到房间码，**紧接着被"当前房间"覆盖**：
//        inRoom = !!(s.room && s.room.code);
//        if (inRoom) code = s.room.code;     ← 用新房号盖掉被打断的旧房号
//        if (inRoom) { location.reload(); }  ← 于是只是原地刷新
//      在新标签页里点，就等于原地刷新新房 → 永远回不到旧同盟。
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const src = fs.readFileSync('matchmaker/public/client.js', 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

console.log('=== A) 面板只对「进过那间房」的页面显示 ===\n');
{
  const i = src.indexOf('const resumeTick');
  const body = src.slice(i, src.indexOf('setInterval(resumeTick', i));
  check('找到 resumeTick', i > 0);
  check('★ 没有房间时不再弹面板（新标签页不会看到）',
    /if \(!s\.room\) return;/.test(body));
  check('★ 只在房间号与标记一致时才弹',
    /if \(s\.room\.code !== rec\.code\) return;/.test(body));
  // 关键：确认不存在"没房间就 showBackPanel"的老写法
  check('★ 不存在「!s.room 之后紧跟 showBackPanel」的旧逻辑',
    !/if \(!s\.room\)\s*\{[\s\S]{0,200}?showBackPanel\(\)/.test(body));
}

console.log('\n=== B) 返回同盟以标记里的房间码为准 ===\n');
{
  const i = src.indexOf("box.querySelector('button').onclick");
  // 注释里会引用旧代码，必须剥掉再判断真实代码
  const body = stripComments(src.slice(i, src.indexOf("document.body.appendChild(box)", i)));
  check('找到按钮处理函数', i > 0);
  check('★ 先读 sp.matchInterrupted 的房间码', /sp\.matchInterrupted[\s\S]{0,200}?const interrupted/.test(body));
  // 旧 bug 的指纹：用当前房间覆盖 code
  check('★ 不存在「用当前房间覆盖被打断房间」的写法',
    !/if \(inRoom\) code = s\.room\.code/.test(body));
  check('★ 房间一致才 reload（否则跳到被打断的那间）',
    /interrupted === current\)[\s\S]{0,80}?location\.reload\(\)/.test(body));
  check('★ 房间不一致时跳到 interrupted 那一间',
    /if \(interrupted\)[\s\S]{0,200}?location\.assign\(\s*'\/r\/'\s*\+\s*encodeURIComponent\(interrupted\)/.test(body));
}

console.log('\n=== C) 场景模拟 ===\n');
{
  // 复刻修复后的按钮决策
  const decide = ({ interrupted, current }) => {
    if (interrupted && interrupted === current) return 'reload';
    if (interrupted) return 'goto:' + interrupted;
    return 'reload';
  };
  const cases = [
    ['新标签页（在新对局 QSXU 里），标记是被打断的 UYCR', { interrupted: 'UYCR', current: 'QSXU' }, 'goto:UYCR'],
    ['同一页面刷新后（标记与当前一致）', { interrupted: 'UYCR', current: 'UYCR' }, 'reload'],
    ['没有房间，只有标记', { interrupted: 'UYCR', current: '' }, 'goto:UYCR'],
    ['没有标记（兜底）', { interrupted: '', current: 'QSXU' }, 'reload'],
  ];
  let ok = true;
  for (const [name, input, want] of cases) {
    const got = decide(input);
    if (got !== want) ok = false;
    console.log(`     ${got === want ? '✓' : '✗'} ${name.padEnd(38)} → ${got}`);
  }
  check('★ 四种场景全部正确（新标签页会回到被打断的那间）', ok);
}

console.log('\n=== D) 面板是否出现（新标签页不该看到）===\n');
{
  const shouldShow = ({ roomCode, recCode, inMatch }) => {
    if (inMatch === true) return false;      // 正在对局
    if (!recCode) return false;              // 没有标记
    if (!roomCode) return false;             // ★ 还没进任何房间（新标签页）→ 不弹
    if (roomCode !== recCode) return false;  // 进的是别的房间
    return true;
  };
  const cases = [
    ['新标签页刚打开，还没进房间', { roomCode: '', recCode: 'UYCR', inMatch: false }, false],
    ['刷新后回到了被打断的同一间', { roomCode: 'UYCR', recCode: 'UYCR', inMatch: false }, true],
    ['在新开的另一间对局里', { roomCode: 'QSXU', recCode: 'UYCR', inMatch: false }, false],
    ['正在对局中', { roomCode: 'QSXU', recCode: 'QSXU', inMatch: true }, false],
    ['没有标记', { roomCode: 'QSXU', recCode: '', inMatch: false }, false],
  ];
  let ok = true;
  for (const [name, input, want] of cases) {
    const got = shouldShow(input);
    if (got !== want) ok = false;
    console.log(`     ${got === want ? '✓' : '✗'} ${name.padEnd(30)} → ${got ? '显示面板' : '不显示'}`);
  }
  check('★ 新标签页不再误报「本局模拟已结束」', ok);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
