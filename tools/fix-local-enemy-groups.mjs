// 补齐 local-assets.json 里漏登记的敌人模型 group。
// assets.json 声明了 spineLocal，但清单没有对应 group → localSpineEntry 返回 null → 画灰块。
// 素材本身在 CDN 上齐全（HEAD 200），只是清单漏收录。
//   node tools\fix-local-enemy-groups.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';

const CHECK = process.argv.includes('--check');
const ROOT = path.resolve('.');
const BASE = 'https://assets.luobomiao.love/assets/local/';

// 素材缺失的这几个敌人：磁盘上 public/assets/local/spine/enemy/<id>/ 里都有 skel/atlas/png
const MISSING = [
  'enemy_1201_sfzhi',
  'enemy_1249_lysdb',
  'enemy_1254_lypa',
  'enemy_1275_dwlock',
  'enemy_1373_ltnhor_2',
  'enemy_1376_ltndru',
];

const targets = ['node-1/data/local-assets.json', 'shared/data/local-assets.json']
  .map((p) => path.join(ROOT, p))
  .filter((p) => fs.existsSync(p));

if (!targets.length) { console.error('找不到 local-assets.json'); process.exit(1); }

let changed = 0;
for (const file of targets) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.groups ||= {};
  const added = [];
  for (const id of MISSING) {
    const group = `spine/enemy/${id}`;
    if (doc.groups[group]) continue;                 // 已经有了，别覆盖
    const dir = path.join(ROOT, 'shared/assets/local/spine/enemy', id);
    if (!fs.existsSync(dir)) { console.log(`  跳过 ${id}：磁盘上没有素材目录`); continue; }
    const files = fs.readdirSync(dir);
    const need = [`${id}.skel`, `${id}.atlas`, `${id}.png`];
    const lack = need.filter((n) => !files.includes(n));
    if (lack.length) { console.log(`  跳过 ${id}：缺 ${lack.join(', ')}`); continue; }
    doc.groups[group] = {
      [`${id}.atlas`]: { path: `${BASE}spine/enemy/${id}/${id}.atlas`, kind: 'TextAsset' },
      [`${id}.png`]: { path: `${BASE}spine/enemy/${id}/${id}.png`, kind: 'Texture2D' },
      [`${id}.skel`]: { path: `${BASE}spine/enemy/${id}/${id}.skel`, kind: 'TextAsset' },
    };
    added.push(id);
  }
  if (!added.length) { console.log(`${path.relative(ROOT, file)}: 无需改动`); continue; }
  if (CHECK) { console.log(`${path.relative(ROOT, file)}: 需要补 ${added.length} 个 group（--check 模式不写入）`); continue; }
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  console.log(`${path.relative(ROOT, file)}: 补了 ${added.length} 个 group → ${added.join(', ')}`);
  changed += added.length;
}
if (!CHECK) console.log(changed ? `\n共补 ${changed} 个 group` : '\n无需改动');
