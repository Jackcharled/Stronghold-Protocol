// 比较 30 个节点的 BUILD_INPUTS 文件是否与 node-1 一致（size + mtime）
// buildTag 是 [path,size,mtime] 的哈希，所以两者任一不同都会产生不同 build
import fs from 'node:fs';
import path from 'node:path';

const INPUTS = ['public/index.html', 'public/js', 'public/css', 'server/sim', 'shared', 'data'];
const NODES = Array.from({ length: 30 }, (_, i) => `node-${i + 1}`);
const ig = (n) => n.startsWith('.') || n.endsWith('~');

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (st.isFile()) { out.set(rel.replace(/\\/g, '/'), `${st.size}:${Math.floor(st.mtimeMs)}`); return; }
  if (!st.isDirectory()) return;
  let names;
  try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const d of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (ig(d.name)) continue;
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    // data/versions 只算服务端提供的版本，两边都一样，这里全算（差异会显示出来）
    if (d.isDirectory()) walk(root, childRel, out);
    else if (d.isFile()) {
      try { const s = fs.statSync(path.join(root, childRel)); out.set(childRel, `${s.size}:${Math.floor(s.mtimeMs)}`); } catch {}
    }
  }
}

function snapshot(root) {
  const m = new Map();
  for (const rel of INPUTS) walk(root, rel, m);
  return m;
}

const base = snapshot(NODES[0]);
console.log(`node-1 共 ${base.size} 个构建输入文件\n`);

const diffs = [];
for (const n of NODES.slice(1)) {
  const snap = snapshot(n);
  const missing = [];
  const differ = [];
  for (const [k, v] of base) {
    if (!snap.has(k)) missing.push(k);
    else if (snap.get(k) !== v) differ.push(k);
  }
  const extra = [...snap.keys()].filter((k) => !base.has(k));
  if (missing.length || differ.length || extra.length) {
    diffs.push({ n, missing, differ, extra });
  }
}

if (!diffs.length) {
  console.log('✅ 全部 30 个节点构建输入一致');
} else {
  console.log(`❌ ${diffs.length} 个节点与 node-1 不一致：\n`);
  for (const d of diffs) {
    console.log(`  ${d.n}: 缺 ${d.missing.length}, 差异 ${d.differ.length}, 多 ${d.extra.length}`);
    if (d.differ.length) console.log(`     差异: ${d.differ.slice(0, 6).join(', ')}${d.differ.length > 6 ? ' …' : ''}`);
    if (d.missing.length) console.log(`     缺: ${d.missing.slice(0, 6).join(', ')}`);
  }
  // 打印所有涉及的文件名
  const all = new Set();
  for (const d of diffs) { d.differ.forEach((x) => all.add(x)); d.missing.forEach((x) => all.add(x)); }
  console.log('\n涉及文件:');
  [...all].sort().slice(0, 40).forEach((f) => console.log('  ' + f));
  if (all.size > 40) console.log(`  …共 ${all.size} 个`);
  process.exitCode = 1;
}
