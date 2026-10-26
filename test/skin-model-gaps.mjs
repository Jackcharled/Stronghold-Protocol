// 体检：皮肤（skins）声明的 spine 模型是否都真的可加载。
// skinHasModel 只检查 spine.front.skel 是字符串；若 skel/atlas 实际指向不存在或无效的条目，
// 或 validSpine 不通过，spineEntry 会掉回干员本体模型 —— 但如果本体也取不到，就只剩菱形头像。
//   node test\skin-model-gaps.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const assets = JSON.parse(fs.readFileSync('node-1/data/assets.json', 'utf8'));
const chars = assets.chars || {};

const validSpine = (sp) => !!(sp && typeof sp === 'object' && sp.skel);
const skinHasModel = (skin) => !!(skin && skin.spine && typeof skin.spine.front === 'object' && skin.spine.front && typeof skin.spine.front.skel === 'string');

const brokenFront = [];   // 皮肤声明了 front 但不 valid
const backNoFront = [];   // 只有 back 没有 front（skinHasModel 会判 false，掉回本体）
let totalSkins = 0;
let withModel = 0;

for (const [cid, ch] of Object.entries(chars)) {
  if (!ch || typeof ch !== 'object' || !ch.skins) continue;
  for (const [sid, skin] of Object.entries(ch.skins)) {
    if (!skin || typeof skin !== 'object') continue;
    totalSkins++;
    const sp = skin.spine;
    if (!sp || typeof sp !== 'object') continue;
    const hasFront = typeof sp.front === 'object' && sp.front && typeof sp.front.skel === 'string';
    const hasBack = typeof sp.back === 'object' && sp.back && typeof sp.back.skel === 'string';
    if (hasFront || hasBack) withModel++;
    if (sp.front !== undefined && sp.front !== null && !validSpine(sp.front)) brokenFront.push({ cid, sid });
    if (!hasFront && hasBack) backNoFront.push({ cid, sid });
  }
}

console.log(`皮肤总数: ${totalSkins}`);
console.log(`其中带模型: ${withModel}\n`);

if (brokenFront.length) {
  console.log('皮肤声明了 front 但模型无效（会掉回本体模型）:');
  for (const x of brokenFront.slice(0, 15)) console.log(`  ${x.cid} / ${x.sid}`);
  if (brokenFront.length > 15) console.log(`  …共 ${brokenFront.length} 个`);
}
if (backNoFront.length) {
  console.log('\n只有 back、没有 front 的皮肤（skinHasModel 判 false，会掉回本体模型）:');
  for (const x of backNoFront.slice(0, 15)) console.log(`  ${x.cid} / ${x.sid}`);
  if (backNoFront.length > 15) console.log(`  …共 ${backNoFront.length} 个`);
}

// 关键不变量：任何「皮肤有 front」的干员，本体也必须有 front（否则切皮肤时无模型可退）
const skinNoBody = [];
for (const [cid, ch] of Object.entries(chars)) {
  if (!ch || typeof ch !== 'object') continue;
  const bodyFront = ch.spine && ch.spine.front && ch.spine.front.skel;
  if (bodyFront) continue;
  for (const [sid, skin] of Object.entries(ch.skins || {})) {
    if (skinHasModel(skin)) { skinNoBody.push({ cid, sid }); break; }
  }
}

console.log('');
check('没有「皮肤声明 front 但模型无效」的条目', brokenFront.length === 0, brokenFront.length ? `${brokenFront.length} 个` : '');
check('没有「有皮肤模型但本体没正面模型」的干员（否则切皮肤必掉成菱形）',
  skinNoBody.length === 0, skinNoBody.length ? skinNoBody.map((x) => x.cid).join(', ') : '');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
