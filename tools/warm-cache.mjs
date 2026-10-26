// 资源预热器：把素材提前拉进 nginx 缓存，让玩家第一次访问就是 HIT
//
//   node tools/warm-cache.mjs                 # 预热全部素材
//   node tools/warm-cache.mjs --only spine    # 只预热某类
//   node tools/warm-cache.mjs --dry           # 只报告，不实际请求
//
// 原理（实测依据）：
//   /assets-cdn/ 走 nginx 的 proxy_cache，MISS 要跨境回源 107-176ms，
//   HIT 只要 6-11ms —— 差 20 倍。预热 = 提前把 MISS 做成 HIT。
//
// 注意：
//   * 只预热**本机已有**的文件（shared/assets 里存在的），避免给资源站造无用请求
//   * 并发默认 8，避免把跨境链路和资源站打满
//   * 失败不重试太多次（资源站慢，重试只会更慢）
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const ROOT = 'D:/Stronghold-Protocol';
const ASSETS = path.join(ROOT, 'shared', 'assets');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ONLY = arg('only', null);
const DRY = process.argv.includes('--dry');
const CONC = Number(arg('conc', '8'));

// 按优先级排：spine 模型和立绘最影响观感
const PRIORITY = ['spine', 'char', 'enemy', 'ui', 'skins', 'item', 'skill', 'band', 'bond', 'module'];

function collect(dir, base = '', out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) collect(path.join(dir, e.name), rel, out);
    else if (/\.(png|webp|jpg|skel|atlas|json|mp3|ogg|bin|obj)$/i.test(e.name)) out.push(rel);
  }
  return out;
}

let files = collect(ASSETS);
if (ONLY) files = files.filter((f) => f.startsWith(ONLY + '/'));
files.sort((a, b) => {
  const pa = PRIORITY.findIndex((p) => a.startsWith(p + '/'));
  const pb = PRIORITY.findIndex((p) => b.startsWith(p + '/'));
  return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb);
});

console.log(`待预热 ${files.length.toLocaleString()} 个文件${ONLY ? `（仅 ${ONLY}）` : ''}，并发 ${CONC}`);
if (DRY) {
  for (const f of files.slice(0, 20)) console.log('  ' + f);
  if (files.length > 20) console.log(`  ... 另 ${files.length - 20} 个`);
  process.exit(0);
}

const agent = new https.Agent({ keepAlive: true, maxSockets: CONC });
let done = 0, hit = 0, miss = 0, failed = 0, bytes = 0;
const t0 = Date.now();

function warm(rel) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: '127.0.0.1', port: 443, path: '/assets-cdn/' + rel, method: 'GET', agent, rejectUnauthorized: false },
      (res) => {
        let b = 0;
        res.on('data', (c) => { b += c.length; });
        res.on('end', () => {
          const st = res.headers['x-sp-asset-cache'] || '';
          if (res.statusCode !== 200) failed++;
          else if (st === 'HIT') hit++;
          else miss++;
          bytes += b;
          done++;
          if (done % 500 === 0 || done === files.length) {
            const pct = (done / files.length * 100).toFixed(1);
            const el = (Date.now() - t0) / 1000;
            const eta = done ? ((files.length - done) / (done / el)) : 0;
            console.log(`  ${done}/${files.length} (${pct}%)  HIT ${hit}  MISS ${miss}  失败 ${failed}  ` +
              `${(bytes / 1048576).toFixed(0)}MB  已用 ${el.toFixed(0)}s  剩约 ${eta.toFixed(0)}s`);
          }
          resolve();
        });
      },
    );
    req.on('error', () => { failed++; done++; resolve(); });
    req.setTimeout(30000, () => { req.destroy(); failed++; done++; resolve(); });
    req.end();
  });
}

let idx = 0;
async function worker() {
  while (idx < files.length) {
    const f = files[idx++];
    await warm(f);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const el = (Date.now() - t0) / 1000;
console.log(`\n完成：${done} 个，HIT ${hit}，MISS ${miss}，失败 ${failed}，${(bytes / 1048576).toFixed(0)} MB，用时 ${el.toFixed(0)}s`);
agent.destroy();
