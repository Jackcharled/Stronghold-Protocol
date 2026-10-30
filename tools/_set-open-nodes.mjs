// 按给定节点号改 nginx 的开放列表：写 open-nodes.conf，先 nginx -t，失败自动还原。
//
//   node tools/_set-open-nodes.mjs 2,4,7,12,13,14,16,18,20,21,24,25,27,30
//
// ★ 2026-10-31 大改（原来改的是 nginx.conf，现在改 open-nodes.conf）：
//   为了「节点挂了自动摘掉」，split_clients 与 map $cookie_sp_route 两块已经从
//   nginx.conf 移进 nginx/conf/open-nodes.conf（主配置用 include 引它，见 §9.34）。
//   本脚本还在老地方找那两块，于是控制台点「更新开放列表」直接失败：
//       找不到 split_clients 块
//   现在改成写 open-nodes.conf——**与 tools\sync-open-nodes.ps1 写的是同一个文件、
//   同一种格式**，所以两边可以互相接手，不会出现「刚设好又被自动同步改回去」。
//
// ★ 与 sync-open-nodes.ps1 的关系（重要，别搞混）：
//   * sync-open-nodes.ps1  = 「按存活状态」开放：探测 /healthz，活着就开、挂了就摘。
//                            计划任务 SP-Open-Nodes 每 5 分钟跑一次，它才是日常唯一在跑的。
//   * 本脚本              = 「按节点号」开放：维护者明确指定只开哪几个。
//   * 因为 5 分钟后自动同步会按存活状态重写一遍，本脚本的效果**只维持到下一次自动同步**。
//     想让某个节点长期不开，应该去停它的进程，而不是改这个文件。
//     控制台按钮已经改成直接调 sync-open-nodes.ps1（见 dashboard/server.js）。
//
// ★ 为什么用 node 而不是 tools\_set-open-nodes.ps1：
//   后者用 `Set-Content -Encoding UTF8` 在 PowerShell 5.1 下会给文件加 BOM，
//   nginx 读第一行 `worker_processes` 直接报 unknown directive；
//   而且它读原文件时的编码也不稳（实测把中文注释读成乱码写回去）。
//   两者叠加会把 nginx.conf 写坏（服务能撑住是因为 nginx 跑的是内存里的旧配置，
//   但下次 reload 就炸）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONF = path.join(ROOT, 'nginx', 'conf', 'open-nodes.conf');
const MAIN = path.join(ROOT, 'nginx', 'conf', 'nginx.conf');
const NGX = path.join(ROOT, 'nginx', 'nginx.exe');
const PREFIX = path.join(ROOT, 'nginx');

const raw = process.argv[2] || '';
const open = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 30);
if (!open.length) { console.log('用法: node tools/_set-open-nodes.mjs 2,4,7'); process.exit(1); }
if (new Set(open).size !== open.length) { console.log('节点号有重复'); process.exit(1); }
open.sort((a, b) => a - b);

const before = fs.readFileSync(CONF, 'utf8');
if (before.charCodeAt(0) === 0xfeff) { console.log('原文件带 BOM（不该有），写回时会去掉'); }

// 百分比必须精确合计 100%（nginx 的 split_clients 要求）
const base = Math.floor(10000 / open.length) / 100;
const last = Math.round((100 - base * (open.length - 1)) * 100) / 100;
const sum = base * (open.length - 1) + last;
if (Math.abs(sum - 100) > 1e-9) { console.log(`百分比合计 ${sum} ≠ 100`); process.exit(1); }

// 必须和 sync-open-nodes.ps1 生成的格式逐字一致，否则两边来回「变化」会每 5 分钟 reload 一次。
const out = [];
out.push('# 由 tools\\sync-open-nodes.ps1 自动生成，请勿手改。');
out.push('# 内容 = 当前存活（/healthz 可用）的节点。节点挂了会被自动摘掉，回来会自动加回。');
out.push('');
out.push('# sp_route cookie 缺失/无效时去哪：只在存活节点里随机');
out.push('split_clients "$request_id" $sp_rand_node {');
open.forEach((n, i) => {
  const v = i === open.length - 1 ? last : base;
  out.push(`  ${v.toFixed(2)}% ${n};`);
});
out.push('}');
out.push('');
out.push('# sp_route cookie 指向存活节点 → 视为有效（粘住它）；指向挂掉的节点 → 无效 → 重新分流');
out.push('map $cookie_sp_route $sp_cookie_open {');
out.push('  default 0;');
out.push(`  ${open.map((n) => `${n} 1;`).join(' ')}`);
out.push('}');
out.push('');
// sync-open-nodes.ps1 写的是 ($lines -join "`n") + "`n"，即末尾恰好一个空行。
// 这里必须一致，否则本脚本跑完自动同步会认为「有变化」而每 5 分钟 reload 一次。
const text = out.join('\n') + '\n';

// 主配置必须还在 include 这份文件，否则写了也没人用——这是最容易静默失败的一步，先查。
try {
  const mainText = fs.readFileSync(MAIN, 'utf8');
  if (!/include\s+open-nodes\.conf\s*;/.test(mainText)) {
    console.log('nginx.conf 里没有 include open-nodes.conf; —— 这份文件的改动不会生效');
    console.log('（维护快照时把 include 漏掉了？见 MAINTENANCE.md §9.34）');
    process.exit(1);
  }
} catch (e) {
  console.log('读不到 nginx/conf/nginx.conf: ' + e.message);
  process.exit(1);
}

function nginxTest() {
  try {
    execFileSync(NGX, ['-t', '-p', PREFIX, '-c', 'conf/nginx.conf'], { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.log((e.stderr?.toString() || e.message).trim());
    return false;
  }
}

const same = text === before;
if (same && !process.argv.includes('--reload-if-same')) {
  // ★ 文件一致 ≠ 配置已生效。踩过：把列表改成 3 个节点 reload 过一次，再把文件还原成 30 个，
  //   文件与目标一致，于是这里直接退出 —— 但 nginx 内存里跑的还是「只有 3 个节点」那一版，
  //   新访客仍会被往 27 个「已关闭」的节点上分。
  //   所以保留一个显式开关，让调用方在“刚还原过配置”时强制对齐。
  console.log(`开放 ${open.length} 个已经是目标状态，未改动，未 reload`);
  console.log('（刚还原过配置、担心 nginx 内存里还是旧的？加 --reload-if-same 强制 reload）');
  process.exit(0);
}
if (same) console.log('文件已是目标状态，按要求强制 reload 一次');

if (!same) {
  fs.writeFileSync(CONF, text, 'utf8');
  if (!nginxTest()) {
    fs.writeFileSync(CONF, before, 'utf8');
    console.log('nginx -t 失败，已还原配置，未 reload');
    process.exit(1);
  }
}

// ★ reload 必须走 SYSTEM 计划任务：nginx 主进程是 SYSTEM，普通 shell（以及 AI 助手的会话）
//   发 reload 会得到 OpenEvent("Global\ngx_reload_<pid>") failed (5: Access denied)，
//   配置改了却没生效，还容易误报成功（踩过）。见 MAINTENANCE.md §9.34。
try {
  execFileSync('schtasks', ['/Run', '/TN', 'SP-Nginx-Reload'], { stdio: 'pipe', windowsHide: true });
} catch (e) {
  console.log('触发 SP-Nginx-Reload 失败: ' + (e.message || e));
  console.log('配置已写入但尚未生效，请手动运行 tools\\nginx-reload.ps1');
  process.exit(1);
}
// 等 reload 真的走完（脚本里自己会 nginx -t + 拉起 worker）。新 worker 起来前旧 worker 还在
// 服务，所以这 8 秒是「等结果」而不是「等可用」，不阻塞站点。
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);

const after = fs.readFileSync(CONF);
const closed = [];
for (let n = 1; n <= 30; n++) if (!open.includes(n)) closed.push(n);
console.log(`开放 ${open.length} 个: ${open.join(', ')}`);
console.log(`关闭 ${closed.length} 个: ${closed.join(', ')}`);
console.log(`每个权重: ${base}%（最后一个 ${last}%）合计 ${sum}%`);
console.log(`BOM: ${after[0] === 0xef ? '有 ✗' : '无 ✓'}   中文完好: ${/其余|开放|关闭|节点/.test(after.toString('utf8')) ? '✓' : '检查'}`);
console.log('nginx 已 reload（经 SP-Nginx-Reload）');
