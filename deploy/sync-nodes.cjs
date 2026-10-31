'use strict';
// 把 node-1 的代码同步到 2–30 节点（多节点分流后，所有节点都会接玩家）
//   node deploy/sync-nodes.cjs            # 只报告差异
//   node deploy/sync-nodes.cjs --apply    # 复制缺失/不同的文件
//
// ⚠ 2026-10-27：把 server 加进同步范围。
//   以前这里刻意排除 server，理由是「server 改动要重启节点，不在这里做」——
//   结果是一个陷阱：`--apply` 只同步静态文件，server 代码**永远不会**被复制到 2–30 号节点，
//   那些节点会一直跑建服当天（10-25）的 server 代码。鸭爵叠加上线时就踩到了：node-1 已更新，
//   其余 29 个节点连 meta.js 都是旧版，重启也拿不到新东西。
//   现在 server 也复制；重启仍需按重启纪律单独执行（复制 ≠ 生效）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// 部署根目录用环境变量，不写死本机路径（仓库是公开的，见 AGENTS.md「敏感信息不能写死在代码里」）。
//   SP_ROOT=D:/Stronghold-Protocol node deploy/sync-nodes.cjs
const ROOT = process.env.SP_ROOT || path.resolve(__dirname, '..');
const DIRS = ['public', 'shared', 'server', 'plugins', 'packs', 'schemas'];
const APPLY = process.argv.includes('--apply');
const sha = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

function walk(dir, base = '', out = new Map()) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walk(full, rel, out);
    else if (e.isFile()) out.set(rel, full);
  }
  return out;
}

const ref = {};
for (const d of DIRS) ref[d] = walk(path.join(ROOT, 'node-1', d));
let totalCopied = 0, totalDiff = 0;
for (let n = 2; n <= 30; n++) {
  const ND = path.join(ROOT, 'node-' + n);
  if (!fs.existsSync(ND)) { console.log(`node-${n}: 目录不存在，跳过`); continue; }
  const diffs = [];
  for (const d of DIRS) {
    const src = ref[d];
    const dstDir = path.join(ND, d);
    const dst = fs.existsSync(dstDir) ? walk(dstDir) : new Map();
    for (const [rel, full] of src) {
      const target = path.join(dstDir, rel);
      if (!dst.has(rel) || sha(full) !== sha(dst.get(rel))) diffs.push({ d, rel, full, target });
    }
  }
  totalDiff += diffs.length;
  if (!diffs.length) continue;
  console.log(`node-${n}: ${diffs.length} 处差异`);
  for (const x of diffs.slice(0, 5)) console.log(`   ${x.d}/${x.rel}`);
  if (diffs.length > 5) console.log(`   ... 另 ${diffs.length - 5} 处`);
  if (APPLY) {
    for (const x of diffs) {
      fs.mkdirSync(path.dirname(x.target), { recursive: true });
      fs.copyFileSync(x.full, x.target);
      // ★ 2026-10-31：**必须把源文件的 mtime 一起带过去**。
      //
      //   /healthz.build（server/http/buildTag.js）的指纹是 `[相对路径, 大小, mtimeMs]`。
      //   上游是单机部署，mtime 天然就代表内容版本 —— 但本服是 30 个独立目录，
      //   fs.copyFileSync 会给每个目标文件写「复制那一刻」的时间戳。
      //   于是**同一份代码在不同节点算出不同的 build**（实测 30 个节点分成 4 种指纹），
      //   玩家在两个节点之间跳转时 buildGuard 以为「服务器更新了」，就触发一次刷新。
      //   把 mtime 复制成源文件的，各节点的 build 就只由内容决定。
      try {
        const st = fs.statSync(x.full);
        fs.utimesSync(x.target, st.atime, st.mtime);
      } catch { /* 设不上也不致命，只是那一轮 build 可能不一致 */ }
      totalCopied++;
    }
    console.log(`   → 已复制 ${diffs.length} 个文件`);
  }
}
console.log(APPLY ? `完成：共复制 ${totalCopied} 个文件` : `完成：共 ${totalDiff} 处差异${totalDiff ? '（加 --apply 复制）' : ''}`);
