// 把刚导入的皮肤清单里的相对路径改成 CDN 绝对地址，与 assets.json 中其它皮肤保持一致。
// skin-import2.mjs 写的是 /assets/... 相对路径；其余皮肤都是 https://assets.luobomiao.love/assets/...
//   node tools\normalize-skin-urls.mjs [--dry-run]
import fs from 'node:fs';

const DRY = process.argv.includes('--dry-run');
const CDN = 'https://assets.luobomiao.love';
const p = 'node-1/data/assets.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));

const fix = (u) => (typeof u === 'string' && u.startsWith('/assets/') ? CDN + u : u);

let fixed = 0;
let touched = [];
for (const [cid, ch] of Object.entries(d.chars || {})) {
  for (const [sid, skin] of Object.entries(ch.skins || {})) {
    const sp = skin?.spine;
    if (!sp) continue;
    let changed = false;
    for (const side of ['front', 'back']) {
      const e = sp[side];
      if (!e || typeof e !== 'object') continue;
      for (const k of ['skel', 'atlas']) {
        if (e[k] && fix(e[k]) !== e[k]) { if (!DRY) e[k] = fix(e[k]); changed = true; }
      }
      if (Array.isArray(e.textures)) {
        const next = e.textures.map(fix);
        if (next.some((u, i) => u !== e.textures[i])) { if (!DRY) e.textures = next; changed = true; }
      }
    }
    if (skin.portrait && fix(skin.portrait) !== skin.portrait) {
      if (!DRY) skin.portrait = fix(skin.portrait);
      changed = true;
    }
    if (changed) { fixed++; touched.push(`${cid}/${sid}`); }
  }
}

console.log(`需要修正的皮肤条目: ${fixed}`);
for (const t of touched.slice(0, 40)) console.log('  ' + t);
if (touched.length > 40) console.log(`  …还有 ${touched.length - 40} 个`);

if (!DRY && fixed) {
  const bak = p + '.bak-normalize';
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, fs.readFileSync(p));
  fs.writeFileSync(p, JSON.stringify(d));
  console.log(`\n已写入 ${p}`);
} else if (DRY) {
  console.log('\n(--dry-run，未写入)');
}
