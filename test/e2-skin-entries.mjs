// 每个有精二立绘的干员，皮肤区都必须有「精英二」条目。
//
// 起因：import-missing-skins.mjs 补皮肤时只写了时装条目，没写精二条目，
// 于是那 19 个干员的皮肤区少了「精英二」那一格（ui/skins.js 按 type==='e2' 排序展示），
// 玩家只看到「默认 + 时装」两格，而时装又没有立绘，两格都显示不出正确外观。
//
//   node test/e2-skin-entries.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const data = JSON.parse(readFileSync(resolve(root, 'node-1/data/assets.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass++; }
  else { fail++; console.log(`  FAIL ${n}${extra ? '  ' + extra : ''}`); }
};

const chars = Object.entries(data.chars || {});
const missing = [];
const malformed = [];

for (const [cid, ch] of chars) {
  const skins = Object.values(ch.skins || {});
  const e2 = skins.filter((s) => s && (s.type === 'e2' || s.name === '精英二'));
  // 有精二立绘的干员，就该有精二条目
  if (ch.portraitE2 && !e2.length) { missing.push(cid); continue; }
  for (const s of e2) {
    const bad = [];
    if (s.name !== '精英二') bad.push(`name=${s.name}`);
    if (s.type !== 'e2') bad.push(`type=${s.type}`);
    if (!s.portrait) bad.push('无 portrait');
    if (!s.avatar) bad.push('无 avatar');
    if (!s.spine) bad.push('无 spine');
    if (bad.length) malformed.push(`${cid}: ${bad.join(', ')}`);
  }
}

console.log('精二条目完整性');
ok(`★ 有精二立绘的干员都有精二条目（缺 ${missing.length} 个）`, missing.length === 0,
  missing.slice(0, 8).join(', '));
ok(`★ 精二条目字段齐全（异常 ${malformed.length} 个）`, malformed.length === 0,
  malformed.slice(0, 5).join(' | '));

const withE2 = chars.filter(([, c]) => Object.values(c.skins || {}).some((s) => s && s.type === 'e2')).length;
ok(`精二条目覆盖 ${withE2}/${chars.length} 个干员`, withE2 === chars.length,
  `缺: ${chars.filter(([, c]) => !Object.values(c.skins || {}).some((s) => s && s.type === 'e2')).map(([id]) => id).slice(0, 8).join(', ')}`);

// 精二复用本体模型，不能指向不存在的 _2 模型
const badSpine = [];
for (const [cid, ch] of chars) {
  for (const s of Object.values(ch.skins || {})) {
    if (!s || s.type !== 'e2') continue;
    const skel = s.spine?.front?.skel || '';
    if (skel && /_2\/front\/.*_2\.skel$/.test(skel)) badSpine.push(cid);
  }
}
ok('精二 spine 指向本体模型（不引用不存在的 _2 模型）', badSpine.length === 0, badSpine.slice(0, 5).join(','));

console.log(`\n结果: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
