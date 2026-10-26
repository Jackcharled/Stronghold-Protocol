// 体检：assets.json 里所有干员的模型是否完整。
// 找出「前/后模型缺失」的干员 —— 这类在战场上只能画菱形头像。
//   node test\op-model-gaps.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const assets = JSON.parse(fs.readFileSync('node-1/data/assets.json', 'utf8'));
const chars = assets.chars || {};
const validSpine = (sp) => !!(sp && typeof sp === 'object' && (sp.skel || sp.atlas));

const noFront = [];
const noBoth = [];
let total = 0;
for (const [id, ch] of Object.entries(chars)) {
  if (!ch || typeof ch !== 'object') continue;
  total++;
  const sp = ch.spine;
  if (!sp || typeof sp !== 'object') { noBoth.push(id); continue; }
  const front = validSpine(sp.front);
  const back = validSpine(sp.back);
  if (!front && !back) noBoth.push(id);
  else if (!front) noFront.push({ id, name: ch.name || ch.nameRaw || id });
}

console.log(`干员总数: ${total}\n`);
if (noBoth.length) {
  console.log('完全没有模型的干员:');
  for (const id of noBoth) console.log('  ' + id);
}
if (noFront.length) {
  console.log('只有背面模型、没有正面模型（战斗中会显示菱形头像）:');
  for (const x of noFront) console.log(`  ${x.id}  ${x.name}`);
}

console.log('');
check('★ 每个干员至少有一个可用模型', noBoth.length === 0, noBoth.length ? `${noBoth.length} 个完全没有模型` : '');
check('★ 每个干员都有正面（Front）模型', noFront.length === 0,
  noFront.length ? `${noFront.length} 个缺正面模型: ${noFront.slice(0, 8).map((x) => x.id).join(', ')}` : '');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
