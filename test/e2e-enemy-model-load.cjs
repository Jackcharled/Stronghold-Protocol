// 真实浏览器验证：本地素材敌人（只有 spineLocal）的模型能不能真正加载。
// 直接调页面的 assets.spineEntry，检查返回的 entry 是否有可用的 skel/atlas/textures URL，
// 并实际 fetch 这些 URL 确认 200。
//   node test\e2e-enemy-model-load.cjs [url]
const puppeteer = require('D:/Stronghold-Protocol/shared/node_modules/puppeteer-core');

const URL_ = process.argv[2] || 'https://stronghold.luobomiao.love/';
const IDS = ['enemy_1201_sfzhi', 'enemy_1249_lysdb', 'enemy_1254_lypa',
  'enemy_1275_dwlock', 'enemy_1373_ltnhor_2', 'enemy_1376_ltndru'];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });

  const failed = [];
  page.on('response', (r) => { if (r.status() >= 400 && /spine\/enemy/.test(r.url())) failed.push(r.url() + ' ' + r.status()); });

  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));

  let fail = 0;
  const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

  // 页面把一个 assets store 挂在 window 上了吗？没有就直接按模块逻辑在页面里复算
  const res = await page.evaluate(async (ids) => {
    // 拉清单
    const get = async (u) => {
      const r = await fetch(u, { cache: 'no-cache' });
      if (!r.ok) return null;
      return r.json();
    };
    const assets = await get('/data/assets.json');
    const local = await get('/data/local-assets.json');
    if (!assets || !local) return { err: `清单读取失败 assets=${!!assets} local=${!!local}` };

    const out = [];
    for (const id of ids) {
      const e = assets.enemies?.[id] || {};
      const sl = e.spineLocal;
      const web = e.spine && e.spine.skel ? e.spine : null;
      const grp = sl?.group ? local.groups?.[sl.group] : null;
      const urlOf = (n) => (grp && grp[n] && grp[n].path) || null;
      const skel = urlOf(sl?.skel), atlas = urlOf(sl?.atlas);
      const texs = (sl?.textures || []).map(urlOf);
      const resolvable = !!(skel && atlas && texs.length && texs.every(Boolean)
        && skel.replace(/\.skel$/, '.atlas') === atlas);
      out.push({ id, hasWeb: !!web, group: sl?.group || null, resolvable, skel });
    }
    return { out };
  }, IDS);

  if (res.err) { console.log('诊断失败:', res.err); await browser.close(); process.exit(1); }

  console.log('本地素材敌人的模型解析：');
  for (const r of res.out) {
    console.log(`  ${r.id.padEnd(22)} web=${r.hasWeb ? '有' : '无'}  可解析=${r.resolvable ? '是' : '否'}`);
  }

  check('★ 6 个本地素材敌人都能解析出模型 URL', res.out.every((r) => r.resolvable),
    res.out.filter((r) => !r.resolvable).map((r) => r.id).join(', ') || '');
  check('这些敌人确实没有 web 模型（所以以前只能画灰块）', res.out.every((r) => !r.hasWeb));

  // 实测 URL 可达
  const urls = res.out.filter((r) => r.skel).map((r) => r.skel);
  const codes = await page.evaluate(async (list) => {
    const out = [];
    for (const u of list) {
      try { const r = await fetch(u, { method: 'HEAD' }); out.push([u.split('/').pop(), r.status]); }
      catch { out.push([u.split('/').pop(), 'ERR']); }
    }
    return out;
  }, urls);
  console.log('\n模型文件可达性：');
  for (const [f, c] of codes) console.log(`  ${f} → ${c}`);
  check('★ 模型文件全部可下载（200）', codes.every(([, c]) => c === 200),
    codes.filter(([, c]) => c !== 200).map(([f, c]) => `${f}=${c}`).join(' ') || '');
  if (failed.length) console.log('\n加载失败请求:', failed.slice(0, 5));

  await browser.close();
  console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})();
