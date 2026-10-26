// 「鸭爵策略可叠加」的显示条件与互斥关系
//
// 规则（用户确认）：
//   - 人数 > 4 才显示（普通 4 人房没有这些选项）
//   - 必须勾「允许重复选择策略」（不重复时一支队伍最多一个鸭爵，叠加无从谈起）
//   - 勾了「禁用鸭爵策略」时必须隐藏（鸭爵都被禁了，再显示"可叠加"是自相矛盾的）
//   - 勾「禁用鸭爵策略」时自动关掉「可叠加」，不留看不见却生效的开关
//   - 服务端也兜一层：手工构造的矛盾组合不会让 stackDuckLord 生效
//
//   node test/ducklord-stack-visibility.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const room = fs.readFileSync('node-1/public/js/screens/room.js', 'utf8');
const match = fs.readFileSync('node-1/server/match/Match.js', 'utf8');

console.log('=== 显示条件 ===\n');
check('★ 三个条件都要求：人数>4 && repeat && !noDuck',
  /const showDuckStack = capacity > 4 && repeat && !noDuck;/.test(room));
check('渲染用 showDuckStack', /showDuckStack \? html/.test(room));

console.log('\n=== 联动：勾「禁用鸭爵」时自动关掉「可叠加」===\n');
check('★ 点「禁用鸭爵策略」且是勾选动作时 setStackDuck(false)',
  /if \(canEdit\) \{ setNoDuck\(!noDuck\); if \(!noDuck\) setStackDuck\(false\); \}/.test(room));
check('取消「允许重复选择策略」时也关掉「可叠加」',
  /if \(repeat\) setStackDuck\(false\)/.test(room));

console.log('\n=== 提交：矛盾组合不会带上去 ===\n');
check('★ 提交条件是 capacity>4 && repeat && stackDuck（noDuck 时 stackDuck 已被清）',
  /\.\.\.\(capacity > 4 && repeat && stackDuck \? \{ stackDuckLord: true \} : \{\}\)/.test(room));

console.log('\n=== 服务端兜底 ===\n');
check('★ Match 要求 allowRepeat && !disableDuckLord && stackDuckLord',
  /this\.stackDuckLord = this\.allowRepeat && !this\.disableDuckLord && this\.experimental\.stackDuckLord === true;/.test(match));

console.log('\n=== 真值表（模拟）===\n');
{
  const showOf = (cap, repeat, noDuck) => cap > 4 && repeat && !noDuck;
  const cases = [
    [4, false, false, false], [4, true, false, false],
    [7, false, false, false], [7, false, true, false],
    [7, true, false, true],   // ← 唯一该显示的组合
    [7, true, true, false],   // ← 用户报告的问题：禁用 + 重复 → 必须隐藏
    [20, true, false, true],
    [20, true, true, false],
  ];
  let ok = true;
  for (const [cap, repeat, noDuck, want] of cases) {
    const got = showOf(cap, repeat, noDuck);
    const mark = got === want ? '✓' : '✗';
    if (got !== want) ok = false;
    console.log(`     ${mark} 人数=${String(cap).padEnd(2)} 重复=${repeat ? '✓' : '✗'} 禁用鸭爵=${noDuck ? '✓' : '✗'} → ${got ? '显示' : '隐藏'}`);
  }
  check('★ 八种组合全部符合预期', ok);
}

console.log('\n=== 服务端：矛盾组合不生效（模拟）===\n');
{
  const effective = (allowRepeat, disableDuckLord, opt) => allowRepeat && !disableDuckLord && opt === true;
  check('allowRepeat + 未禁用 + 勾选 → 生效', effective(true, false, true) === true);
  check('★ 禁用鸭爵时即使勾了也不生效', effective(true, true, true) === false);
  check('没开重复选择时不生效', effective(false, false, true) === false);
  check('没勾选时不生效', effective(true, false, false) === false);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
