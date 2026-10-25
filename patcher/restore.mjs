// patcher/restore.mjs — 一键还原：把 server/lobby.js 和 server/http/config.js 换回官方原版
//
// 用法（在 D:\Stronghold-Protocol 下）：
//   node patcher\restore.mjs          还原 30 个节点
//   node patcher\restore.mjs --check  只核对当前是不是官方原版（不写文件）
//
// 还原后与 MANIFEST.json 完全一致，官方更新包就能正常校验并启动。
// 注意：官方更新之后，patcher\orig 里的副本会变成「旧版本」，那时请不要还原，直接跑 apply.mjs。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SP_BASE || path.dirname(HERE);
const NODES = 30;
const FILES = ['server/lobby.js', 'server/http/config.js'];
const CHECK = process.argv.includes('--check');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nodeDir = (n) => path.join(BASE, `node-${n}`);

let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(path.join(nodeDir(1), 'MANIFEST.json'), 'utf8')); } catch { /* 没清单就只按 orig 还原 */ }

let bad = 0;
for (const rel of FILES) {
  const origPath = path.join(HERE, 'orig', rel);
  if (!fs.existsSync(origPath)) { console.error(`✗ 缺少原版文件 patcher/orig/${rel}`); process.exit(1); }
  const buf = fs.readFileSync(origPath);
  const want = manifest?.files?.[rel]?.sha256;
  if (want && sha(buf) !== want) {
    console.warn(`! patcher/orig/${rel} 与当前 MANIFEST 不一致（官方已升级？）— 仍按文件还原`);
  }
  if (CHECK) {
    for (let n = 1; n <= NODES; n++) {
      const cur = fs.readFileSync(path.join(nodeDir(n), rel));
      if (sha(cur) !== sha(buf)) { bad++; console.log(`  ✗ node-${n}/${rel} 不是原版`); }
    }
    continue;
  }
  for (let n = 1; n <= NODES; n++) fs.writeFileSync(path.join(nodeDir(n), rel), buf);
  console.log(`✓ 已还原 ${rel} → node-1 … node-${NODES}`);
}

if (CHECK) {
  console.log(bad ? `检查完成：有 ${bad} 个文件不是原版。` : '检查完成：30 个节点都是官方原版。');
  process.exit(bad ? 1 : 0);
}
console.log('完成：已还原官方文件，请执行 pm2 restart all。');
