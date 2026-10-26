// 皮肤 / 精二覆盖体检：对比官方 skin_table.json 与本服 assets.json，
// 找出「官方有皮肤、本服没有」的干员，以及缺精二头像/模型的情况。
//
// 2026-10-26 的结论（这个脚本就是那次排查的固化）：
//   19 个干员的皮肤未导入，且资源站上也没有它们的皮肤模型文件 —— 属「素材未提取」，
//   不是清单漏登记。其中 char_133_mm（梅）正是玩家反馈「只有头像没有模型」的干员之一。
//   它们的**本体**模型是完整的，所以游戏里能正常显示；只是没有皮肤可选。
//
//   node test\op-skin-coverage.mjs           只做本地对比
//   node test\op-skin-coverage.mjs --cdn     额外探测资源站上是否真有这些皮肤模型
import fs from 'node:fs';

const WITH_CDN = process.argv.includes('--cdn');
const CDN = 'https://assets.luobomiao.love';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const assets = JSON.parse(fs.readFileSync('node-1/data/assets.json', 'utf8'));
const chars = assets.chars || {};

// 官方皮肤表（可选：没有 .cache 时只做本地统计）
let officialByChar = null;
try {
  const official = JSON.parse(fs.readFileSync('.cache/skin_table.json', 'utf8'));
  const charSkins = official.charSkins || {};
  officialByChar = new Map();
  for (const [skinId, sk] of Object.entries(charSkins)) {
    const cid = sk.charId || sk.char_id;
    if (!cid) continue;
    const group = String(sk.skinGroupId || '');
    // 默认皮肤跳过（_1 / 与 charId 同名）
    if (/_1$/.test(group) || group === cid || String(skinId) === cid) continue;
    if (!officialByChar.has(cid)) officialByChar.set(cid, []);
    officialByChar.get(cid).push(skinId);
  }
} catch { /* 没有官方表就只做本地统计 */ }

const total = Object.keys(chars).length;
const noSkin = [];
const noBack = [];
const noE2Avatar = [];
for (const [cid, ch] of Object.entries(chars)) {
  if (!Object.keys(ch.skins || {}).length) noSkin.push(cid);
  if (!(ch.spine && ch.spine.back && ch.spine.back.skel)) noBack.push(cid);
  if (!ch.avatarE2) noE2Avatar.push(cid);
}

const pct = (n) => `${n}/${total} (${((n / total) * 100).toFixed(1)}%)`;
console.log(`干员总数: ${total}\n`);
console.log(`皮肤:     ${pct(total - noSkin.length)} 有，${noSkin.length} 个没有`);
console.log(`Back模型: ${pct(total - noBack.length)} 有，${noBack.length} 个没有`);
console.log(`精二头像: ${pct(total - noE2Avatar.length)} 有，${noE2Avatar.length} 个没有\n`);

// ── 关键断言 1：本体模型必须齐全（缺了就会在战场上显示成菱形头像）──
const noFront = Object.entries(chars).filter(([, ch]) => !(ch.spine && ch.spine.front && ch.spine.front.skel)).map(([c]) => c);
check('★ 每个干员都有本体（Front）模型', noFront.length === 0, noFront.join(', '));

// ── 关键断言 2：没有精二头像的只能是 c*/ac* 后备干员（官方本来就没有）──
const realNoE2 = noE2Avatar.filter((c) => !/^char_\d+_a?c[a-z]+$/.test(c));
check('★ 缺精二头像的只有后备干员（官方数据本身没有）', realNoE2.length === 0, realNoE2.join(', '));

if (officialByChar) {
  const missed = [...officialByChar.keys()]
    .filter((cid) => chars[cid] && !Object.keys(chars[cid].skins || {}).length)
    .map((cid) => ({ cid, n: officialByChar.get(cid).length }));

  console.log('');
  check('★ 官方有皮肤的干员，本服都导入了皮肤', missed.length === 0,
    missed.length ? `${missed.length} 个未导入: ${missed.map((m) => m.cid).join(', ')}` : '');

  // ── 关键断言 3：皮肤的显示名必须是官方名，不能是模型 ID ──
  // 批量导入脚本曾经把 name 写成模型 ID（char_133_mm_summer_20），
  // 界面上就显示成「char_133…」而不是「夏卉 FA054」。
  const nameById = [];
  for (const [cid, ch] of Object.entries(chars)) {
    for (const [model, skin] of Object.entries(ch.skins || {})) {
      if (!skin?.name || skin.name === model) nameById.push(`${cid}/${model}`);
    }
  }
  check('★ 每个皮肤都有显示名（不是模型 ID）', nameById.length === 0,
    nameById.length ? `${nameById.length} 个: ${nameById.slice(0, 5).join(', ')}` : '');

  // ── 关键断言 4：皮肤立绘不能张冠李戴 ──
  // 导入脚本曾把 char_002_amiya_2.png（阿米娅的立绘）写进所有新皮肤的 portrait。
  // 判据：立绘 URL 的文件名里出现的 char_xxx 必须属于本干员。
  const wrongArt = [];
  for (const [cid, ch] of Object.entries(chars)) {
    for (const [model, skin] of Object.entries(ch.skins || {})) {
      const p = typeof skin?.portrait === 'string' ? skin.portrait : '';
      if (!p) continue;
      // 从 URL 里抽出所有 char_<数字>_<名字> 片段
      const ids = p.match(/char_\d+_[a-z0-9]+/gi) || [];
      const foreign = ids.filter((x) => !x.startsWith(cid) && !model.startsWith(x));
      if (foreign.length) wrongArt.push(`${cid}/${model} -> ${foreign[0]}`);
    }
  }
  check('★ 皮肤立绘没有引用别的干员', wrongArt.length === 0,
    wrongArt.length ? `${wrongArt.length} 个: ${wrongArt.slice(0, 5).join(', ')}` : '');

  if (missed.length) {
    console.log('\n  未导入皮肤的干员（本体模型正常，只是没有皮肤可选）：');
    for (const m of missed) console.log(`    ${m.cid}  官方 ${m.n} 个皮肤`);

    if (WITH_CDN) {
      console.log('\n  探测资源站上是否真有这些皮肤模型：');
      const toDir = (s) => String(s).replace('@', '_').replace('#', '_');
      let found = 0;
      for (const m of missed) {
        for (const sid of officialByChar.get(m.cid)) {
          const dir = toDir(sid);
          const url = `${CDN}/assets/spine/op/${m.cid}/${dir}/front/${dir}.skel`;
          const st = await fetch(url, { method: 'HEAD' }).then((r) => r.status).catch(() => 'ERR');
          if (st === 200) { found++; console.log(`    ✅ ${m.cid} ${dir}`); }
        }
      }
      console.log(`    资源站上找到 ${found} 个`);
      if (found === 0) console.log('    → 素材本身就没提取/上传，不是清单问题');
    }
  }
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过（本体模型齐全；皮肤缺口见上）');
process.exit(fail ? 1 : 0);
