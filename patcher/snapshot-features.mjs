import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/Stronghold-Protocol';
const SRC = `${ROOT}/node-1`;
const BASE = `${ROOT}/_ref-ann1/Stronghold-Protocol-master`;
const FEATURES = `${ROOT}/patcher/features.json`;
const OUT = `${ROOT}/patcher/features`;

const skipDir = new Set(['node_modules', 'logs', 'state', '.cache', 'bundles', '.git']);
const skipRel = /^(public\/assets|data\/runtime)\//;

function expand(pattern) {
  const clean = pattern.replace(/\\/g, '/');
  if (!clean.includes('*')) return [clean];
  const parts = clean.split('/');
  const out = [];
  const start = fs.existsSync(path.join(SRC, parts[0])) ? SRC : ROOT;
  const relRoot = start;
  const walk = (dir, idx) => {
    if (idx >= parts.length) return;
    const part = parts[idx];
    if (part === '**') {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skipDir.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, idx);
        else if (idx === parts.length - 1) out.push(path.relative(relRoot, full).replace(/\\/g, '/'));
        if (e.isDirectory()) walk(full, idx + 1);
      }
      return;
    }
    if (part.includes('*')) {
      const re = new RegExp('^' + part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!re.test(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, idx + 1);
        else if (idx === parts.length - 1) out.push(path.relative(relRoot, full).replace(/\\/g, '/'));
      }
      return;
    }
    const full = path.join(dir, part);
    if (!fs.existsSync(full)) return;
    const st = fs.statSync(full);
    if (idx === parts.length - 1) {
      if (st.isFile()) out.push(path.relative(relRoot, full).replace(/\\/g, '/'));
      return;
    }
    if (st.isDirectory()) walk(full, idx + 1);
  };
  walk(start, 0);
  return out;
}

const features = JSON.parse(fs.readFileSync(FEATURES, 'utf8')).features;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const index = [];
for (const feature of features) {
  const files = [];
  for (const pattern of feature.files || []) {
    for (const rel of expand(pattern)) {
      if (skipRel.test(rel) || rel.endsWith('.log')) continue;
      const src = fs.existsSync(path.join(SRC, rel)) ? path.join(SRC, rel) : path.join(ROOT, rel);
      const base = path.join(BASE, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(OUT, feature.id, 'files', rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      if (fs.existsSync(base)) {
        const bdst = path.join(OUT, feature.id, 'base', rel);
        fs.mkdirSync(path.dirname(bdst), { recursive: true });
        fs.copyFileSync(base, bdst);
      }
      files.push({ path: rel, baseExists: fs.existsSync(base), customBytes: fs.statSync(src).size });
    }
  }
  index.push({ id: feature.id, name: feature.name, status: feature.status, files });
  console.log(feature.id, files.length);
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
console.log('features', index.length, 'files', index.reduce((n, f) => n + f.files.length, 0));
