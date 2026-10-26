// 批量导入缺失的干员皮肤 Spine（来自 fexli 镜像），并写回 node-1/data/assets.json。
//
// 背景：19 个干员官方有皮肤但本服一个都没导入（2026-10-26 排查，含 char_133_mm「梅」）。
// 这些干员的**本体模型**是完整的，只是没有皮肤可选。
//
// 用法：
//   node tools\import-missing-skins.mjs --dry-run     只列出要做什么
//   node tools\import-missing-skins.mjs               实际导入
//   node tools\import-missing-skins.mjs --only char_133_mm
//
// 与 deploy\skin-import2.mjs 的区别：
//   - 立绘不再瞎用默认值：只有资源站上确实存在该皮肤的立绘时才写，否则不写（避免张冠李戴）
//   - 幂等：已经导入过的皮肤跳过
//   - 批量：一次处理清单里所有「官方有、本地无」的干员
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

const ROOT = 'D:/Stronghold-Protocol';
const NODE1 = path.join(ROOT, 'node-1');
const PROXY = 'https://gh-proxy.com/';
const RAW_F = PROXY + 'https://raw.githubusercontent.com/fexli/ArknightsResource/main/';
const CDN = 'https://assets.luobomiao.love';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null; })();

function get(url, n = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ url: undefined, host: u.host, path: u.pathname + u.search, headers: { 'User-Agent': 'dsh', Accept: '*/*' }, timeout: 120000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && n < 5) {
        res.resume();
        return get(new URL(res.headers.location, url).toString(), n + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(Buffer.concat(c)));
    }).on('error', reject);
  });
}

const head = (url) => new Promise((resolve) => {
  const u = new URL(url);
  https.get({ host: u.host, path: u.pathname + u.search, headers: { 'User-Agent': 'dsh' }, timeout: 40000 }, (r) => {
    if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
      r.resume();
      return resolve(head(new URL(r.headers.location, url).toString()));
    }
    r.resume(); resolve(r.statusCode);
  }).on('error', () => resolve(0));
});

const toDir = (s) => String(s).replace('@', '_').replace('#', '_');

const official = JSON.parse(fs.readFileSync(path.join(ROOT, '.cache/skin_table.json'), 'utf8'));
const charSkins = official.charSkins || {};
const assetsPath = path.join(NODE1, 'data/assets.json');
const data = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));

// 找出「官方有皮肤、本地一个都没有」的干员
const targets = Object.entries(data.chars || {})
  .filter(([cid, ch]) => !Object.keys(ch.skins || {}).length && (!ONLY || cid === ONLY))
  .map(([cid]) => cid);

console.log(`待处理的干员: ${targets.length} 个${ONLY ? ` (--only ${ONLY})` : ''}\n`);

const { parseSkel } = await import(pathToFileURL(path.join(NODE1, 'tools/assets/skel.mjs')).href);
const { resolveRoles } = await import(pathToFileURL(path.join(NODE1, 'tools/assets/anim-roles.mjs')).href);

let imported = 0;
let skipped = 0;
const report = [];

for (const cid of targets) {
  const skins = Object.entries(charSkins)
    .filter(([, sk]) => (sk.charId || sk.char_id) === cid)
    .map(([sid, sk]) => ({ sid, group: String(sk.skinGroupId || '') }))
    .filter((s) => !/_1$/.test(s.group) && s.group !== cid);

  const done = [];
  for (const s of skins) {
    const model = toDir(s.sid);
    const dstDir = path.join(NODE1, 'public/assets/spine/op', cid, model, 'front');

    // 探测镜像
    const status = await head(`${RAW_F}spine/${cid}/${model}/Front/${model}.skel`);
    if (status !== 200) { skipped++; continue; }

    if (DRY) { console.log(`  可导入 ${cid} / ${model}`); done.push(model); continue; }

    try {
      if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
      for (const ext of ['skel', 'atlas', 'png']) {
        const buf = await get(`${RAW_F}spine/${cid}/${model}/Front/${model}.${ext}`);
        fs.writeFileSync(path.join(dstDir, `${model}.${ext}`), buf);
      }
      // 动画角色
      let anims = null;
      try {
        const info = parseSkel(new Uint8Array(fs.readFileSync(path.join(dstDir, `${model}.skel`))));
        anims = resolveRoles(info.animations || []);
      } catch (e) { console.log(`     动画解析失败（留空，渲染时用默认剪辑）: ${e.message}`); }

      // 立绘：只有资源站确实有这个皮肤的立绘时才写，避免张冠李戴
      let portrait = null;
      for (const cand of [`${model}_1.png`, `${model}.png`]) {
        const st = await fetch(`${CDN}/assets/char/portrait/${cand}`, { method: 'HEAD' }).then((r) => r.status).catch(() => 0);
        if (st === 200) { portrait = '/assets/char/portrait/' + cand; break; }
      }

      data.chars[cid].skins = data.chars[cid].skins || {};
      data.chars[cid].skins[model] = {
        name: model,
        ...(portrait ? { portrait } : {}),
        spine: {
          front: {
            skel: `/assets/spine/op/${cid}/${model}/front/${model}.skel`,
            atlas: `/assets/spine/op/${cid}/${model}/front/${model}.atlas`,
            textures: [`/assets/spine/op/${cid}/${model}/front/${model}.png`],
            pma: false,
            ...(anims ? { anims } : {}),
          },
        },
      };
      imported++;
      done.push(model);
      console.log(`  ✅ ${cid} / ${model}${portrait ? '  (含立绘)' : ''}`);
    } catch (e) {
      console.log(`  ❌ ${cid} / ${model}: ${e.message}`);
    }
  }
  report.push({ cid, models: done });
}

if (!DRY) {
  // 先备份一次
  const bak = assetsPath + '.bak-skins-bulk';
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, fs.readFileSync(assetsPath));
  fs.writeFileSync(assetsPath, JSON.stringify(data));
  console.log(`\n已写入 ${assetsPath}`);
}
console.log(`\n导入 ${imported} 个，镜像上没有 ${skipped} 个（精一/精二用本体模型，属正常）`);
fs.writeFileSync(path.join(ROOT, 'dist/_skin-import-report.json'), JSON.stringify(report, null, 1));
