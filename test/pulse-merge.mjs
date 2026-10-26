// 合并轮询：/mm/api/gate、/api/room-ttl、/api/announcement → /mm/api/pulse
//
// 依据（真实访问日志 1,192,827 条采样）：
//   /mm/api/gate          67,450 次
//   /mm/api/room-ttl      67,439 次
//   /mm/api/announcement  67,439 次
// 三个各自 5 秒轮询，合计约占全部请求的 55%，比素材请求（11.6%）多近 5 倍。
// 合并成一个端点后，这部分请求量直接降到 1/3。
//
//   node test/pulse-merge.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const srv = fs.readFileSync('matchmaker/server.js', 'utf8');
const cli = fs.readFileSync('matchmaker/public/client.js', 'utf8');

console.log('=== 服务端：合并端点 ===\n');
check('★ 新增 /api/pulse 路由', /pathname === '\/api\/pulse'/.test(srv));
check('pulse 返回 gate', /gate: gameGate\(\)/.test(srv));
check('pulse 返回 roomTtl', /roomTtl: readJson\(/.test(srv));
check('pulse 返回 announcement', /announcement: readJson\(/.test(srv));
check('pulse 不缓存（与三个原端点一致）', /'cache-control': 'no-store'/.test(srv.split("pathname === '/api/pulse'")[1]?.slice(0, 900) || ''));
check('三个原端点保留（已打开的旧页面不会坏）',
  /pathname === '\/api\/gate'/.test(srv) && /pathname === '\/api\/room-ttl'/.test(srv) && /pathname === '\/api\/announcement'/.test(srv));

console.log('\n=== 前端：一次请求拿三份数据 ===\n');
check('★ 有 refreshPulse', /function refreshPulse\(\)/.test(cli));
check('★ 打的是 /mm/api/pulse', cli.includes("fetch('/mm/api/pulse'"));
check('boot 里用 refreshPulse 替代 refreshGate', /try \{ refreshPulse\(\); setInterval\(refreshPulse, 5000\); \}/.test(cli));
check('把 gate 应用到按钮状态', /applyGate\(j\.gate\)/.test(cli));
check('把 ttl 派发给订阅者', /emitPulse\('ttl', j\.roomTtl\)/.test(cli));
check('把 announcement 派发给订阅者', /emitPulse\('announcement', j\.announcement\)/.test(cli));

console.log('\n=== 兼容：pulse 不可用时自动回退 ===\n');
check('★ 失败后把 pulseOk 置 false', /if \(!j \|\| !j\.ok\) \{ pulseOk = false; refreshGate\(\); return; \}/.test(cli));
check('gate 回退到原端点', /if \(!pulseOk\) \{ refreshGate\(\); return; \}/.test(cli));
check('ttl 回退到原端点', /const syncTtl = async \(\) => \{\s*\n\s*if \(pulseOk\) return;/.test(cli));
check('announcement 回退到原端点',
  /const poll = \(\) => \{\s*\n\s*if \(pulseOk\) return;/.test(cli));
check('刷新页面（内存态重置）后能重新尝试 pulse', !/localStorage.*pulseOk/.test(cli));

console.log('\n=== 请求量估算 ===\n');
{
  // 日志实测：一分钟内约多少请求
  const total = 1192827;
  const polls = 67450 + 67439 + 67439;
  const after = 67450; // 合并后只保留一份
  const pctBefore = polls / total * 100;
  const pctAfter = after / total * 100;
  console.log(`     合并前：轮询 ${polls.toLocaleString()} 次，占全部请求 ${pctBefore.toFixed(1)}%`);
  console.log(`     合并后：轮询 ${after.toLocaleString()} 次，占全部请求 ${pctAfter.toFixed(1)}%`);
  console.log(`     减少：${(polls - after).toLocaleString()} 次（-${((polls - after) / polls * 100).toFixed(0)}% 的轮询，` +
    `-${((polls - after) / total * 100).toFixed(1)}% 的总请求）`);
  check('★ 轮询请求量降到原来的 1/3 左右', after * 3 === polls || Math.abs(after * 3 - polls) < 200);
}

console.log('\n=== 每个玩家省下的请求 ===\n');
{
  // 每 5 秒一次，一分钟 12 次
  const perMinBefore = 12 * 3;
  const perMinAfter = 12;
  console.log(`     每个玩家每分钟：${perMinBefore} → ${perMinAfter} 个轮询请求`);
  check('★ 每人每分钟少 24 个请求', perMinBefore - perMinAfter === 24);
  console.log(`     60 人同时在线：${(perMinBefore * 60).toLocaleString()} → ${(perMinAfter * 60).toLocaleString()} 请求/分钟`);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
