// 体检：assets.json 里声明了 spineLocal 的敌人/召唤物，其 group 是否真的在 local-assets.json 里。
// 缺 group 时 localSpineEntry 返回 null、spineEntry 返回 null —— 这些单位没有 web 模型，就只能画灰块。
//   node test\asset-manifest-gaps.mjs
import fs from 'node:fs';
import path from 'node:path';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const assets = readJson('node-1/data/assets.json');
const localPath = ['node-1/data/local-assets.json', 'shared/data/local-assets.json'].find((p) => fs.existsSync(p));
if (!localPath) { console.log('找不到 local-assets.json'); process.exit(1); }
const local = readJson(localPath);
const groups = local.groups || {};

const problems = [];
const scan = (kind, table) => {
  for (const [id, e] of Object.entries(table || {})) {
    if (!e || typeof e !== 'object') continue;
    const sl = e.spineLocal;
    if (!sl) continue;
    const g = sl.group;
    if (!g) { problems.push({ kind, id, why: 'spineLocal 没有 group' }); continue; }
    const grp = groups[g];
    if (!grp) { problems.push({ kind, id, group: g, why: 'local-assets.json 里没有这个 group' }); continue; }
    const need = [sl.skel, sl.atlas, ...(sl.textures || [])];
    const miss = need.filter((n) => !grp[n] || !grp[n].path);
    if (miss.length) { problems.push({ kind, id, group: g, why: 'group 缺文件: ' + miss.join(', ') }); continue; }
    const atlasName = String(sl.skel || '').replace(/\.skel$/, '.atlas');
    if (atlasName !== sl.atlas) problems.push({ kind, id, group: g, why: `atlas 名不匹配: ${atlasName} vs ${sl.atlas}` });
  }
};
scan('enemy', assets.enemies);
scan('token', assets.tokens);

console.log(`检查 ${localPath}：${Object.keys(groups).length} 个 group\n`);
if (problems.length) {
  console.log('有声明但没有可用素材的条目：');
  for (const p of problems) console.log(`  ${p.kind}/${p.id}  ${p.why}${p.group ? `  (${p.group})` : ''}`);
} else {
  console.log('所有 spineLocal 声明都能解析到 URL');
}
console.log('');
check('★ 声明了 spineLocal 的条目都能真正加载（不会画成灰块）',
  problems.length === 0, problems.length ? `${problems.length} 条有问题` : '');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
