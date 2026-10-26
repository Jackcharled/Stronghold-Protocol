// 5–20 人房的玩家列表是滚动容器（.team--many，overflow-y: auto），
// 而选中框 .team__frame 用 inset: -.07rem 向行外扩。滚动容器会把外扩部分裁掉，
// 表现为第一行的框上沿缺失、相邻两行的框互相压住。4 人房是 overflow: visible，所以看不出来。
//
//   node test/team-frame-clip.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const css = readFileSync(resolve(root, 'shared/public/css/screens/game.css'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
};

console.log('5–20 人房选中框不被滚动容器裁切');

const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const all = [...css.matchAll(new RegExp('(?:^|\\n)' + esc + '\\s*\\{([^}]*)\\}', 'g'))].map((m) => m[1]);
  return all.join(' ');
};

// 前提：滚动容器确实是 overflow-y: auto（否则这个修复没必要）
const many = rule('.team--many');
ok('滚动容器 .team--many 用 overflow-y: auto', /overflow-y:\s*auto/.test(many));

// 前提：选中框确实向行外扩
const frame = rule('.team__frame');
ok('选中框 .team__frame 向外扩展（inset 为负）', /inset:\s*-\.0\d+rem/.test(frame));

// 修复：滚动容器补出与外扩等量的上下内边距
const padMatch = many.match(/padding-block:\s*\.(\d+)rem/);
ok('★ 滚动容器补了 padding-block', !!padMatch,
  padMatch ? '' : '没有 padding-block，选中框会被 overflow 裁掉');
if (padMatch) {
  const pad = Number('.' + padMatch[1]);
  const inset = Number((frame.match(/inset:\s*-(\.\d+)rem/) || [])[1]);
  ok(`★ 内边距 ${pad}rem 不小于外扩 ${inset}rem`, pad >= inset,
    `外扩 ${inset}rem 会被裁掉 ${(inset - pad).toFixed(2)}rem`);
}

// 不能为了修这个去关掉滚动：20 人房必须还能滚
ok('滚动容器的 overflow-y 没有被改成 visible', /overflow-y:\s*auto/.test(many));
ok('保留了 overscroll-behavior 与触屏滚动', /overscroll-behavior:\s*contain/.test(many) && /-webkit-overflow-scrolling:\s*touch/.test(many));

// 4 人房不受影响（它不该带 team--many 的 padding）
ok('4 人房（.team 无 team--many）不被改动', !/\.team\s*\{[^}]*padding-block/.test(rule('.team')));

// 行间距存在，修复后框之间才有呼吸空间
const players = rule('.team__players');
ok('.team__players 有行间距', /gap:\s*\.\d+rem/.test(players));

console.log(`\n结果: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
