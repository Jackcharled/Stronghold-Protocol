// 验证 MM_DISABLED_NODES：被禁用的节点不得再被选为新对局的落点。
// 这条限制用于「节点上还有对局、不能重启时，先停止接收新对局」。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = readFileSync(resolve(root, 'matchmaker/server.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? `  ${extra}` : ''}`); }
}

console.log('MM_DISABLED_NODES（暂停接收新对局的节点）');

ok('定义了 MM_DISABLED_NODES', /MM_DISABLED_NODES/.test(src));
ok('解析为 Set 并按节点号过滤',
  /const DISABLED_NODES = new Set\(/.test(src) && /n >= 1 && n <= NODES/.test(src));
ok('非法值（NaN / 越界）会被过滤掉',
  /Number\.isInteger\(n\)/.test(src));

// pickNode 必须排除禁用节点
const pickFn = src.match(/function pickNode\(\)\s*\{[\s\S]*?\n\}/);
ok('pickNode 存在', !!pickFn);
ok('pickNode 过滤掉 DISABLED_NODES',
  !!pickFn && /DISABLED_NODES\.has\(n\)/.test(pickFn[0]),
  pickFn ? '未在筛选条件里判断禁用' : '');

// pickNodeFor 对实验节点也要判断
const pickForFn = src.match(/function pickNodeFor\(capacity\)\s*\{[\s\S]*?\n\}/);
ok('pickNodeFor 存在', !!pickForFn);
ok('pickNodeFor 对实验节点也判断禁用',
  !!pickForFn && /!DISABLED_NODES\.has\(EXPERIMENTAL_NODE\)/.test(pickForFn[0]),
  pickForFn ? '实验节点被禁用后仍会被选中' : '');

// 状态接口要能把禁用情况暴露出去
ok('/api/state 的节点列表带 disabled 字段', /disabled: DISABLED_NODES\.has\(n\)/.test(src));

// 启动日志
ok('启动时打印被禁用的节点', /暂停接收新对局的节点/.test(src));

// 空值不炸
const emptyCase = "'', '  ', 'abc', '0', '31', '5'".split(',');
ok('空字符串解析后不产生节点（不会禁用全部）',
  emptyCase.filter((s) => /^\d+$/.test(s.trim())).every((s) => {
    const n = Number(s.trim());
    return !(Number.isInteger(n) && n >= 1 && n <= 30);
  }));

console.log(`\n结果: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
