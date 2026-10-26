// 修复批量导入的皮肤缺失的「显示名」和「立绘」。
//
// 两个 bug：
//   1. name 写成了模型 ID（char_133_mm_summer_20），所以界面显示「char_133…」
//      正确来源是官方 skin_table.json 的 displaySkin.skinName（如「夏卉 FA054」）
//   2. 立绘路径找错：实际结构是 /assets/char/skin/<model>.png，
//      之前的脚本按 /assets/char/portrait/<model>_1.png 找，永远找不到，于是 portrait 留空，
//      界面回落到干员本体立绘（所以「立绘不对」）。
//
//   node tools\fix-skin-names-portraits.mjs [--dry-run]
import fs from 'node:fs';

const DRY = process.argv.includes('--dry-run');
const CDN = 'https://assets.luobomiao.love';
const p = 'node-1/data/assets.json';

const official = JSON.parse(fs.readFileSync('.cache/skin_table.json', 'utf8'));
const charSkins = official.charSkins || {};
const data = JSON.parse(fs.readFileSync(p, 'utf8'));

// 官方 skinId（char_133_mm@summer#20）→ 镜像/清单里的模型名（char_133_mm_summer_20）
const toModel = (sid) => String(sid).replace('@', '_').replace('#', '_');

// 建立 model → { name, officialId }
const modelInfo = new Map();
for (const [sid, sk] of Object.entries(charSkins)) {
  const name = sk?.displaySkin?.skinName || sk?.skinName || null;
  if (!name) continue;
  modelInfo.set(toModel(sid), { name, officialId: sid });
}

const head = async (url) => {
  try { return (await fetch(url, { method: 'HEAD' })).status; } catch { return 0; }
};

let fixedName = 0;
let fixedPortrait = 0;
const report = [];

for (const [cid, ch] of Object.entries(data.chars || {})) {
  for (const [model, skin] of Object.entries(ch.skins || {})) {
    // 只修「name 等于模型 ID」的（= 批量导入留下的），已有的正常皮肤不动
    const looksUnset = !skin.name || skin.name === model;
    if (!looksUnset && skin.portrait) continue;

    let changed = false;
    if (looksUnset) {
      const info = modelInfo.get(model);
      if (info?.name) {
        if (!DRY) skin.name = info.name;
        changed = true;
        fixedName++;
        report.push(`名字 ${model} -> ${info.name}`);
      }
    }
    // 立绘：/assets/char/skin/<model>.png
    if (!skin.portrait) {
      const candidate = `${CDN}/assets/char/skin/${model}.png`;
      const st = await head(candidate);
      if (st === 200) {
        if (!DRY) skin.portrait = candidate;
        changed = true;
        fixedPortrait++;
        report.push(`立绘 ${model} -> ok`);
      } else {
        report.push(`立绘 ${model} -> 资源站上没有 (${st})`);
      }
    }
  }
}

console.log(`修正名字 ${fixedName} 个，修正立绘 ${fixedPortrait} 个\n`);
const shown = report.filter((r) => !r.startsWith('立绘') || r.includes('ok'));
for (const r of shown.slice(0, 40)) console.log('  ' + r);
const missing = report.filter((r) => r.includes('资源站上没有'));
if (missing.length) {
  console.log(`\n资源站上还没有立绘的 ${missing.length} 个（等上传，界面会回落到本体立绘）：`);
  for (const r of missing.slice(0, 30)) console.log('  ' + r);
}

if (!DRY) {
  const bak = p + '.bak-names';
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, fs.readFileSync(p));
  fs.writeFileSync(p, JSON.stringify(data));
  console.log(`\n已写入 ${p}`);
} else {
  console.log('\n(--dry-run，未写入)');
}
