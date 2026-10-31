// 一次性脚本：把 30 个节点的 BUILD_INPUTS 文件 mtime 对齐到 repo-sync 源文件，
// 让 /healthz.build 只由内容决定，而不是「谁什么时候复制的」。
//
// 为什么需要：buildTag.js 的指纹是 [路径, 大小, mtimeMs]。sync-nodes.cjs 以前用
// fs.copyFileSync（不保留 mtime），于是同一份代码在不同节点算出不同 build，
// 玩家跨节点就被 buildGuard 判定为「服务器更新了」并触发刷新。
const fs = require('fs');
const path = require('path');

const ROOT = 'D:\\Stronghold-Protocol';
const SRC = path.join(ROOT, 'repo-sync');
const DIRS = ['public/index.html', 'public/js', 'public/css', 'server/sim', 'shared', 'data'];
const APPLY = process.argv.includes('--apply');

const ign = (n) => n.startsWith('.') || n.endsWith('~');

/** [相对路径, size, mtimeMs] 列表（与 buildTag.js 的遍历口径一致）。 */
function entries(root, relDir, out) {
  const abs = path.join(root, relDir);
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (st.isFile()) { out.set(relDir, [st.size, st.mtimeMs]); return; }
  if (!st.isDirectory()) return;
  let names;
  try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const d of names) {
    if (ign(d.name)) continue;
    const childRel = path.posix.join(relDir, d.name);
    if (d.isDirectory()) entries(root, childRel, out);
    else if (d.isFile()) {
      try { const s = fs.statSync(path.join(root, childRel)); out.set(childRel, [s.size, s.mtimeMs]); } catch { /* */ }
    }
  }
}

// 源文件的权威 mtime
const src = new Map();
for (const d of DIRS) entries(SRC, d, src);
console.log(`源文件: ${src.size} 个`);

// 把所有节点的 mtime 对齐；只对「内容相同但 mtime 不同」的动手，内容不同的留给 sync-nodes.cjs
let fixed = 0;
for (let n = 1; n <= 30; n++) {
  const nodeDir = path.join(ROOT, `node-${n}`);
  const dst = new Map();
  for (const d of DIRS) entries(nodeDir, d, dst);
  let cnt = 0;
  let mismatch = 0;
  for (const [rel, [size, mt]] of dst) {
    const s = src.get(rel);
    if (!s) continue;                                   // 节点多了个文件：不管
    if (s[0] !== size) { mismatch++; continue; }         // 大小不同 = 内容不同，交给 sync-nodes
    if (Math.abs(s[1] - mt) < 1) continue;               // 已经一致
    if (APPLY) {
      try { fs.utimesSync(path.join(nodeDir, rel), new Date(s[1]), new Date(s[1])); } catch { /* */ }
    }
    cnt++;
  }
  if (cnt || mismatch) console.log(`node-${n}: 对齐 ${cnt} 个${mismatch ? `，内容不同 ${mismatch} 个（需 --apply 分发）` : ''}`);
  fixed += cnt;
}
console.log(APPLY ? `完成：对齐了 ${fixed} 个文件的 mtime` : `预演：${fixed} 个文件需要对齐（加 --apply 执行）`);
