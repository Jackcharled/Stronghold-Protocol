// 补丁完整性检查：当前代码相对上游的所有改动，是否都进了 patcher/features？
//
// 上游发新版本时按 restore → 升级 → apply 走，凡是没进补丁的改动都会丢失。
// 这个脚本把「改动」与「补丁覆盖」逐文件对比，任何一个漏网都报错。
//
//   node patcher/check-coverage.mjs          # 检查（有不一致则退出码 1）
//   node patcher/check-coverage.mjs --list   # 同时列出全部文件
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FEATURES = path.join(ROOT, 'patcher', 'features');
const GIT = process.env.GIT_EXE || 'git';
const LIST = process.argv.includes('--list');

// 不纳入补丁管理的路径：
//   public/vendor/** 上游整包替换的第三方库
//   patcher/**       补丁自身
//   docs/** 等文档   不参与运行
//   test/**          测试号（升级后按需重跑，不属于「要保住的功能」）
//   tools/** schemas/** packs/**  运维工具与生成产物，上游不覆盖
//   package*.json    依赖清单（上游升级会合并，强行替换反而危险）
//   *.png 等资源     截图素材
//   nginx/**         部署配置，已由 deploy/nginx.conf 与 repo 跟踪，不进游戏补丁
const IGNORE = [
  /^public\/vendor\//, /^patcher\//, /^docs\//, /^\.github\//, /^test\//,
  /^tools\//, /^schemas\//, /^packs\//, /^nginx\//,
  /^package(-lock)?\.json$/, /\.(png|jpg|jpeg|gif|webp|ico)$/,
  // 上游 .gitignore 明令禁止提交的后台页面（Server-only administration）
  /^matchmaker\/public\/admin\.html$/,
];

function git(args) {
  return execFileSync(GIT, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
}

// 1) 补丁覆盖集合
const covered = new Set();
if (fs.existsSync(FEATURES)) {
  for (const feat of fs.readdirSync(FEATURES)) {
    const filesDir = path.join(FEATURES, feat, 'files');
    if (!fs.existsSync(filesDir)) continue;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else covered.add(path.relative(filesDir, p).replace(/\\/g, '/'));
      }
    };
    walk(filesDir);
  }
}

// 2) 相对上游的改动（只算会影响运行的文件）
let changed = [];
try {
  changed = git(['diff', '--name-only', 'upstream/master', 'HEAD']).split('\n').filter(Boolean);
} catch {
  console.error('无法与 upstream/master 比对（缺少该远程分支？）');
  process.exit(2);
}
const runtime = changed.filter((f) => /\.(js|mjs|cjs|json|css|html)$/.test(f) && !IGNORE.some((re) => re.test(f)));

// 3) 差异
const missing = runtime.filter((f) => !covered.has(f));
// 失效检查只看代码文件；历史截图/临时 json 留在补丁里无害，不算过期。
// admin.html 例外：上游 gitignore 禁止提交，补丁里保留它是有意的。
const extra = [...covered].filter((f) =>
  /\.(js|mjs|cjs|css|html)$/.test(f)
  && !IGNORE.some((re) => re.test(f))
  && !fs.existsSync(path.join(ROOT, f)));

console.log(`补丁覆盖文件: ${covered.size}`);
console.log(`影响运行的改动: ${runtime.length}`);
console.log(`未进补丁: ${missing.length}`);
console.log(`补丁里已失效(仓库无此文件): ${extra.length}`);

if (LIST) {
  if (missing.length) { console.log('\n--- 未进补丁 ---'); missing.forEach((f) => console.log('  ' + f)); }
  if (extra.length) { console.log('\n--- 补丁中已失效 ---'); extra.forEach((f) => console.log('  ' + f)); }
}

let bad = false;
if (missing.length) {
  bad = true;
  console.error(`\n✗ 有 ${missing.length} 个改动没有进入补丁，上游升级时会丢失：`);
  missing.slice(0, 30).forEach((f) => console.error('  ' + f));
  if (missing.length > 30) console.error(`  …还有 ${missing.length - 30} 个（用 --list 查看全部）`);
}
if (extra.length) {
  bad = true;
  console.error(`\n✗ 补丁里有 ${extra.length} 个文件在仓库中已不存在（补丁过期）：`);
  extra.slice(0, 20).forEach((f) => console.error('  ' + f));
}

if (!bad) console.log('\n✓ 全部改动都已被补丁覆盖');
process.exit(bad ? 1 : 0);
