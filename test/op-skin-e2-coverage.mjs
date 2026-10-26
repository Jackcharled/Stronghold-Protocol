// 统计干员的皮肤与精二（E2）艺术覆盖情况：
//   - 有没有皮肤（skins）
//   - 有没有精二立绘 / 头像（avatarE2 / portraitE2 / E2 模型）
//   node test\op-skin-e2-coverage.mjs
import fs from 'node:fs';

const assets = JSON.parse(fs.readFileSync('node-1/data/assets.json', 'utf8'));
const chars = assets.chars || {};

const noSkin = [];
const noE2Avatar = [];
const noE2Portrait = [];
const noE2Model = [];
let total = 0;

for (const [cid, ch] of Object.entries(chars)) {
  if (!ch || typeof ch !== 'object') continue;
  total++;
  const skins = Object.keys(ch.skins || {});
  if (!skins.length) noSkin.push(cid);
  if (!ch.avatarE2) noE2Avatar.push(cid);
  if (!ch.portraitE2) noE2Portrait.push(cid);
  // 精二模型：Back 模型通常就是精二形态（官方里 E2 用背身模型）
  const hasBack = !!(ch.spine && ch.spine.back && ch.spine.back.skel);
  if (!hasBack) noE2Model.push(cid);
}

const pct = (n) => `${n}/${total} (${((n / total) * 100).toFixed(1)}%)`;

console.log(`干员总数: ${total}\n`);
console.log('=== 皮肤覆盖 ===');
console.log(`  有皮肤:      ${pct(total - noSkin.length)}`);
console.log(`  无皮肤:      ${pct(noSkin.length)}`);
if (noSkin.length) console.log(`  无皮肤清单: ${noSkin.join(', ')}`);

console.log('\n=== 精二头像/立绘 ===');
console.log(`  有 avatarE2:   ${pct(total - noE2Avatar.length)}`);
console.log(`  有 portraitE2: ${pct(total - noE2Portrait.length)}`);
if (noE2Avatar.length) console.log(`  无精二头像: ${noE2Avatar.slice(0, 40).join(', ')}${noE2Avatar.length > 40 ? ' …' : ''}`);

console.log('\n=== 精二模型（Back 模型）===');
console.log(`  有 Back 模型: ${pct(total - noE2Model.length)}`);
console.log(`  无 Back 模型: ${pct(noE2Model.length)}`);
if (noE2Model.length) console.log(`  无 Back: ${noE2Model.join(', ')}`);
