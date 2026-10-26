// 模块导入完整性：每个 `import { x } from '...'` 引用的名字，目标文件必须真的导出。
//
// 2026-10-26 事故：bandDraft.js 里加了 `import { draftMyTurn } from '../ui/gameLogic.js'`，
// 但 gameLogic.js 的 re-export 列表漏了它 → 浏览器抛
//   SyntaxError: The requested module does not provide an export named 'draftMyTurn'
// → 整个模块图崩掉 → **全站打不开**，只显示「游戏脚本加载失败」。
//
// 语法检查（node --check）抓不到这种错误：它不是语法问题，是模块解析问题。
// 这个脚本就是补这个缺口。
//   node test\module-exports-ok.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'node-1/public/js';
const SHARED = 'node-1/shared';

let fail = 0;
const problems = [];

/** 收集一个文件导出的名字。 */
function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (process.env.DEBUG_EXPORTS) console.error('--- exportsOf', file);
  const names = new Set();
  // export function foo / export const foo / export let / export var / export class
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // export { a, b as c }  （含 `from` 的 re-export）
  for (const m of src.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      // `a as b` → 导出名是 b；`a` → a
      const as = t.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      names.add(as ? as[1] : t.split(/\s+/)[0]);
    }
  }
  if (/export\s+default\b/.test(src)) names.add('default');
  return names;
}

/** 收集一个文件的 import 需求：{ from, names[] }（names 是**目标模块**里应有的名字，即 `as` 左边那个）。 */
function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  // 先去注释，避免把文档里的示例 import 当成真的
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
  const out = [];
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = [];
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      // `store as appStore` → 目标里要有的名字是 `store`；`foo` → `foo`
      const as = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      names.push(as ? as[1] : t.split(/\s+/)[0]);
    }
    out.push({ from: m[2], names });
  }
  return out;
}

const walk = (dir, base = '') => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? path.join(base, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
};

const cache = new Map();
const exportsCached = (f) => {
  if (!cache.has(f)) cache.set(f, exportsOf(f));
  return cache.get(f);
};

const files = walk(ROOT);
let checked = 0;
for (const rel of files) {
  const file = path.join(ROOT, rel);
  for (const imp of importsOf(file)) {
    if (!imp.from.startsWith('.')) continue;   // 裸包名（vendor）跳过
    const target = path.resolve(path.dirname(file), imp.from);
    if (!fs.existsSync(target)) { problems.push(`${rel}: 找不到模块 ${imp.from}`); continue; }
    const exp = exportsCached(target);
    checked += imp.names.length;
    for (const n of imp.names) {
      if (!exp.has(n)) problems.push(`${rel}\n    从 ${imp.from} 导入 '${n}'，但目标没有导出`);
    }
  }
}

console.log(`检查 ${files.length} 个文件、${checked} 个具名导入\n`);
if (problems.length) {
  console.log(`❌ ${problems.length} 个导入无法解析（会导致整站打不开）：\n`);
  for (const p of problems) console.log('  ' + p);
  fail = 1;
} else {
  console.log('✅ 所有具名导入都能解析');
}
process.exit(fail);
