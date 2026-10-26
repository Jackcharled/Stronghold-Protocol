// 全量校验：assets.json 里声明的每一个 spine 模型文件（干员本体 + 所有皮肤 + 召唤物 + 敌人）
// 是否真的存在于资源站。这是「玩家看到 404」的最终事实校验。
//   node test\cdn-assets-exist.mjs [--limit N] [--only <子串>]
import fs from 'node:fs';

const argv = process.argv.slice(2);
const LIMIT = (() => { const i = argv.indexOf('--limit'); return i >= 0 ? Number(argv[i + 1]) : 0; })();
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null; })();

const assets = JSON.parse(fs.readFileSync('node-1/data/assets.json', 'utf8'));
const CDN = 'https://assets.luobomiao.love';

/** 从清单里收集所有 spine 文件 URL（skel / atlas / textures）。 */
const urls = new Map(); // 去 hash 后的 URL → 来源描述
const addSpine = (label, sp) => {
  if (!sp || typeof sp !== 'object') return;
  const sides = sp.front || sp.back ? ['front', 'back'] : [null];
  for (const side of sides) {
    const e = side ? sp[side] : sp;
    if (!e || typeof e !== 'object') continue;
    const tag = side ? `${label} ${side}` : label;
    if (typeof e.skel === 'string') urls.set(e.skel, `${tag} skel`);
    if (typeof e.atlas === 'string') urls.set(e.atlas, `${tag} atlas`);
    for (const t of Array.isArray(e.textures) ? e.textures : []) if (typeof t === 'string') urls.set(t, `${tag} tex`);
  }
};

let count = 0;
for (const [cid, ch] of Object.entries(assets.chars || {})) {
  if (ONLY && !cid.includes(ONLY)) continue;
  count++;
  addSpine(`${cid}`, ch.spine);
  for (const [sid, skin] of Object.entries(ch.skins || {})) addSpine(`${sid}`, skin?.spine);
}
for (const [tid, t] of Object.entries(assets.tokens || {})) { if (!ONLY || tid.includes(ONLY)) addSpine(`token:${tid}`, t.spine); }
for (const [eid, e] of Object.entries(assets.enemies || {})) { if (!ONLY || eid.includes(ONLY)) addSpine(`enemy:${eid}`, e.spine); }

let list = [...urls.entries()].map(([u, label]) => ({ url: u.replace(/\/~\w+\//, '/'), label }));
if (LIMIT > 0) list = list.slice(0, LIMIT);

console.log(`干员 ${count} 个，收集到 ${list.length} 个 spine 文件，逐个校验…\n`);

const missing = [];
let done = 0;
const CONC = 12;
let idx = 0;
async function worker() {
  while (idx < list.length) {
    const item = list[idx++];
    done++;
    let status = 'ERR';
    try {
      const r = await fetch(item.url, { method: 'HEAD' });
      status = r.status;
    } catch (e) { status = 'ERR:' + (e.cause?.code || e.message).toString().slice(0, 20); }
    if (status !== 200) missing.push({ ...item, status });
    if (done % 300 === 0) console.log(`  已检查 ${done}/${list.length}…`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

console.log(`\n检查完成：${list.length} 个文件`);
if (missing.length) {
  console.log(`\n❌ 缺失 ${missing.length} 个：`);
  const byOwner = new Map();
  for (const m of missing) {
    const owner = m.label.split(' ')[0];
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(m);
  }
  for (const [owner, items] of byOwner) {
    console.log(`\n  ${owner}  (${items.length} 个缺失)`);
    for (const it of items.slice(0, 6)) console.log(`    ${it.status}  ${it.url.replace(CDN, '')}`);
    if (items.length > 6) console.log(`    …还有 ${items.length - 6} 个`);
  }
  process.exit(1);
}
console.log('\n✅ 全部存在');
