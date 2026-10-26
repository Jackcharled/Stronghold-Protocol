// 在本机为 /assets-cdn/ 提速的三个工具（都只碰 nginx 缓存层，不改资源站）
//
//   node tools/augment-cdn.mjs --check      # 只体检，不改任何东西
//   node tools/augment-cdn.mjs --apply      # 应用 nginx 配置改进
//
// 三个改进点（都有实测依据）：
//
//   1) 缓存键去掉 ~hash 前缀
//      现状：/assets-cdn/~abc123/path/to/x.png 与 /assets-cdn/~def456/path/to/x.png
//            是同一个文件，却各存一份。实测 77,287 个缓存文件 vs 33,893 个真实素材，
//            多出 43,394 个重复副本（占 3.11 GB 里的相当一部分）。
//      改法：proxy_cache_key 里剥掉 /~[0-9a-f]+/ 段，同一文件只存一份。
//      效果：缓存能装下更多真实素材，命中率提高，磁盘也更省。
//
//   2) 加大缓存上限
//      现状：max_size=8g，已用 3.11g。33,893 个素材全量约 1.44 GB，
//            去掉重复后 8g 绰绰有余；但把上限提到 16g 可以连旧版本一起留着，
//            避免玩家在版本切换时反复 MISS。
//
//   3) 缓存锁等待时间调长
//      现状：proxy_cache_lock on + 30s。跨境回源实测 107-176ms，正常不会超时；
//            但资源站抖动时（实测有 9.2s 的长尾）可能触发，等待者会失败。
//            调到 60s 更稳。
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const CONF = 'D:/Stronghold-Protocol/nginx/conf/nginx.conf';
const NGINX = 'D:/Stronghold-Protocol/nginx/nginx.exe';
const CHECK_ONLY = !process.argv.includes('--apply');

let conf = fs.readFileSync(CONF, 'utf8');
const findings = [];

console.log('=== 体检 ===\n');

// 1) 缓存键是否显式剥离了 ~hash（不看整个 location 块，只看有没有 proxy_cache_key 这一行）
const cdnIdx = conf.indexOf('location ^~ /assets-cdn/');
const cdnSection = cdnIdx >= 0 ? conf.slice(cdnIdx, cdnIdx + 2000) : '';
// 找到这个 location 块结束（下一个 "location " 之前）
const nextLoc = cdnSection.indexOf('location ', 10);
const cdnBlockText = nextLoc > 0 ? cdnSection.slice(0, nextLoc) : cdnSection;
const hasCacheKey = /proxy_cache_key\s+"?\$sp_asset_cache_uri/.test(cdnBlockText);
console.log(`1) 缓存键剥离 ~hash 前缀: ${hasCacheKey ? '已配置' : '未配置（同一素材的不同 ~hash 会各存一份）'}`);
if (!hasCacheKey) {
  findings.push({
    id: 'cachekey',
    desc: '缓存键剥离 ~hash 前缀，同一素材只缓存一份',
    apply: (c) => {
      // 在这个 location 块的 proxy_cache sp_assets; 之后插入
      const start = c.indexOf('location ^~ /assets-cdn/');
      if (start < 0) return c;
      const seg = c.slice(start);
      const m = /(\n(\s*)proxy_cache sp_assets;)/.exec(seg);
      if (!m) return c;
      const indent = m[2];
      const insertAt = start + m.index + m[0].length;
      return c.slice(0, insertAt)
        + `\n${indent}# 本服：剥掉客户端的 ~<hash> 版本段再作为缓存键。`
        + `\n${indent}# /assets-cdn/~abc/x.png 与 /assets-cdn/~def/x.png 是同一个文件，`
        + `\n${indent}# 不剥就会各存一份（缓存目录里同一素材的多份副本）。`
        + `\n${indent}proxy_cache_key "$sp_asset_cache_uri";`
        + c.slice(insertAt);
    },
  });
}

// 2) 缓存上限
const maxMatch = /max_size=(\d+)g/.exec(conf);
const curMax = maxMatch ? Number(maxMatch[1]) : 0;
console.log(`2) 缓存上限: ${curMax}g（素材全量约 1.5 GB，含旧版本约 3 GB）`);
if (curMax > 0 && curMax < 16) {
  findings.push({
    id: 'maxsize',
    desc: `缓存上限 ${curMax}g → 16g（装得下多个版本，减少切换时 MISS）`,
    apply: (c) => c.replace(/max_size=\d+g/, 'max_size=16g'),
  });
}

// 3) 缓存锁超时
const lockMatch = /proxy_cache_lock_timeout\s+(\d+)s/.exec(conf);
const curLock = lockMatch ? Number(lockMatch[1]) : 0;
console.log(`3) 缓存锁超时: ${curLock ? curLock + 's' : '未配置'}`);
if (curLock > 0 && curLock < 60) {
  findings.push({
    id: 'locktimeout',
    desc: `缓存锁超时 ${curLock}s → 60s（资源站抖动时 9.2s 长尾不会把等待者打失败）`,
    apply: (c) => c.replace(/proxy_cache_lock_timeout\s+\d+s/, 'proxy_cache_lock_timeout 60s'),
  });
}

// 4) 是否需要 $sp_asset_cache_uri 这个 map
const needMap = /proxy_cache_key "\$sp_asset_cache_uri"/.test(conf) || findings.some((f) => f.id === 'cachekey');
const hasMap = /map \$uri \$sp_asset_cache_uri/.test(conf);
console.log(`4) $sp_asset_cache_uri map: ${hasMap ? '已存在' : '不存在'}`);
if (needMap && !hasMap) {
  findings.push({
    id: 'map',
    desc: '新增 map $uri $sp_asset_cache_uri（剥离 ~hash）',
    apply: (c) => {
      // 放在其他 map 附近：找到第一个 map 块的位置前插入
      const anchor = /map \$http_upgrade \$connection_upgrade/;
      if (anchor.test(c)) {
        return c.replace(anchor, `# 本服：/assets-cdn/~abc/x.png → /assets-cdn/x.png，作为缓存键，
  # 让同一素材的不同版本段共用一份缓存（配合 proxy_cache_key）。
  map $uri $sp_asset_cache_uri {
    default                     $uri;
    "~^/assets-cdn/~[0-9a-f]+/(?<rest>.*)$"  /assets-cdn/$rest;
    "~^/assets/~[0-9a-f]+/(?<rest2>.*)$"     /assets/$rest2;
  }

  map $http_upgrade $connection_upgrade`);
      }
      return c;
    },
  });
}

console.log('');
if (!findings.length) {
  console.log('✓ 三项都已经是推荐配置，无需改动');
  process.exit(0);
}

console.log(`发现 ${findings.length} 项可改进：`);
for (const f of findings) console.log(`  - ${f.desc}`);

if (CHECK_ONLY) {
  console.log('\n（只体检，未改动。加 --apply 应用）');
  process.exit(0);
}

console.log('\n=== 应用 ===');
for (const f of findings) {
  const before = conf;
  conf = f.apply(conf);
  if (conf === before) { console.log(`  ✗ ${f.id}: 模式没匹配上，跳过`); continue; }
  console.log(`  ✓ ${f.id}: ${f.desc}`);
}

// 备份后写入并测试
const bak = `${CONF}.bak-${Date.now()}`;
fs.copyFileSync(CONF, bak);
fs.writeFileSync(CONF, conf);
console.log(`\n  已备份: ${bak}`);

try {
  execSync(`"${NGINX}" -p D:/Stronghold-Protocol/nginx/ -t`, { stdio: 'pipe' });
  console.log('  ✓ nginx -t 通过');
  execSync(`"${NGINX}" -p D:/Stronghold-Protocol/nginx/ -s reload`, { stdio: 'pipe' });
  console.log('  ✓ 已 reload（不影响已有连接与对局）');
} catch (e) {
  fs.copyFileSync(bak, CONF);
  console.log('  ✗ nginx -t 失败，已回滚：' + (e.stderr ? String(e.stderr).slice(0, 400) : e.message));
  process.exit(1);
}
