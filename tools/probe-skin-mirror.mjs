// 探测 fexli 镜像上，19 个「无皮肤」干员的官方皮肤 spine 资源是否存在。
// 官方 skinId 形如 char_133_mm@summer#20，镜像目录名形如 char_133_mm_summer_20。
//   node tools\probe-skin-mirror.mjs
import fs from 'node:fs';
import https from 'node:https';

const PROXY = 'https://gh-proxy.com/';
const RAW_F = PROXY + 'https://raw.githubusercontent.com/fexli/ArknightsResource/main/';

const official = JSON.parse(fs.readFileSync('.cache/skin_table.json', 'utf8'));
const charSkins = official.charSkins || {};
const assets = JSON.parse(fs.readFileSync('node-1/data/assets.json', 'utf8'));

const MISSING = Object.entries(assets.chars || {})
  .filter(([, ch]) => !Object.keys(ch.skins || {}).length)
  .map(([cid]) => cid);

const toDir = (s) => String(s).replace('@', '_').replace('#', '_');

function head(url, n = 0) {
  return new Promise((resolve) => {
    const u = new URL(url);
    https.get({ host: u.host, path: u.pathname + u.search, headers: { 'User-Agent': 'dsh' }, timeout: 40000 }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && n < 5) {
        r.resume();
        return resolve(head(new URL(r.headers.location, url).toString(), n + 1));
      }
      r.resume();
      resolve(r.statusCode);
    }).on('error', (e) => resolve('ERR ' + e.message.slice(0, 30)));
  });
}

const out = [];
for (const cid of MISSING) {
  const skins = Object.entries(charSkins)
    .filter(([, sk]) => (sk.charId || sk.char_id) === cid)
    .map(([sid, sk]) => ({ sid, name: sk.skinName || sk.displaySkin?.skinName || sid, group: String(sk.skinGroupId || '') }))
    .filter((s) => !/_1$/.test(s.group) && s.group !== cid);
  console.log(`\n== ${cid}  官方 ${skins.length} 个`);
  const found = [];
  for (const s of skins) {
    const dir = toDir(s.sid);
    const st = await head(`${RAW_F}spine/${cid}/${dir}/Front/${dir}.skel`);
    const ok = st === 200;
    if (ok) found.push(dir);
    console.log(`   ${ok ? '✅' : '❌'} ${String(st).padEnd(4)} ${dir}`);
  }
  out.push({ cid, total: skins.length, found });
}

const totalFound = out.reduce((n, x) => n + x.found.length, 0);
console.log(`\n\n镜像上共可下载 ${totalFound} 个皮肤模型`);
console.log('\n可直接导入的模型名：');
for (const x of out) if (x.found.length) console.log(`  ${x.cid}: ${x.found.join(' ')}`);

fs.writeFileSync('dist/_skin-mirror.json', JSON.stringify(out, null, 1));
console.log('\n结果已写入 dist/_skin-mirror.json');
