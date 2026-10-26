// 给补过皮肤的 19 个干员补上「精英二」条目，字段与其它干员完全一致：
//   name: '精英二', type: 'e2', group: '精英二',
//   portrait: char/portrait/<cid>_2.png, avatar: char/avatar/<cid>_2.png
// 这些干员本来就有精二立绘（portraitE2 / avatarE2），只是 import-missing-skins.mjs
// 当初只写了时装条目，没写精二条目，于是皮肤区少了「精英二」那一格。
//
//   node tools\add-e2-skins.mjs [--check] [--dry-run]
import fs from 'node:fs';

const ASSETS = 'node-1/data/assets.json';
const CDN = 'https://assets.luobomiao.love';
const CHECK = process.argv.includes('--check');
const DRY = process.argv.includes('--dry-run');

const data = JSON.parse(fs.readFileSync(ASSETS, 'utf8'));

function head(url) {
  return fetch(url, { method: 'HEAD' }).then((r) => r.status).catch(() => 0);
}

const pending = [];
for (const [cid, ch] of Object.entries(data.chars || {})) {
  // 只处理「有精二立绘、但 skins 里没有 e2 条目」的干员
  const hasE2Portrait = !!ch.portraitE2;
  const skins = ch.skins || {};
  const hasE2Entry = Object.values(skins).some((s) => s && (s.type === 'e2' || s.name === '精英二'));
  if (hasE2Entry) continue;
  if (!hasE2Portrait) continue;
  pending.push(cid);
}

console.log(`需要补精二条目的干员: ${pending.length} 个${CHECK ? '（只检查）' : ''}\n`);

let added = 0;
let skipped = 0;
for (const cid of pending) {
  const ch = data.chars[cid];
  const id = `${cid}_2`;
  const portrait = `${CDN}/assets/char/portrait/${id}.png`;
  const avatar = `${CDN}/assets/char/avatar/${id}.png`;

  const [pst, ast] = await Promise.all([head(portrait), head(avatar)]);
  if (pst !== 200) { console.log(`  skip ${cid}: 精二立绘不可用 (${pst})`); skipped++; continue; }

  if (DRY) { console.log(`  可补 ${cid}`); continue; }

  ch.skins = ch.skins || {};
  ch.skins[id] = {
    name: '精英二',
    type: 'e2',
    group: '精英二',
    portrait,
    avatar,
    // 精二复用本体的战斗模型（与其它干员一致：char_003_kalts_2 的 spine 也指向
    // spine/op/char_003_kalts/front/char_003_kalts.skel，没有单独的 _2 模型）
    ...(ch.spine ? { spine: ch.spine } : {}),
  };
  added++;
  console.log(`  ✅ ${cid}  ${portrait.replace(CDN, '')}`);
}

console.log(`\n结果: 补 ${added}，跳过 ${skipped}`);
if (CHECK) process.exitCode = added > 0 ? 1 : 0;
if (!CHECK && !DRY && added > 0) {
  fs.writeFileSync(ASSETS, JSON.stringify(data));
  console.log('已写入', ASSETS);
}
