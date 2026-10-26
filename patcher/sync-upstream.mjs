#!/usr/bin/env node
// patcher/sync-upstream.mjs — 上游更新后的一键流程。
//
// 按 MAINTENANCE.md「标准更新流程」把能自动化的部分串起来：
//   1. 审计仓库同步状态（behind 必须为 0）
//   2. 刷新功能快照（从线上 node-1 读源码）
//   3. 对新上游源码跑三方合并
//   4. 对合并结果跑功能自检
//   5. 给出结论：能不能直接部署
//
// 它**不会**自动部署、不会重启任何节点 —— 那一步永远由人决定。
//
// 用法：
//   node patcher/sync-upstream.mjs --upstream <新上游源码根目录>
//   node patcher/sync-upstream.mjs --upstream D:\tmp\upstream-master --skip-snapshot
//
// 退出码：0 可以部署；1 需要人工处理。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.SP_REPO || path.dirname(HERE);
const RUNTIME = process.env.SP_RUNTIME
  || (path.basename(REPO) === 'repo-sync' ? path.dirname(REPO) : REPO);

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const UPSTREAM = argOf('--upstream');
const SKIP_SNAPSHOT = argv.includes('--skip-snapshot');

if (!UPSTREAM) {
  console.error('用法: node patcher/sync-upstream.mjs --upstream <新上游源码根目录>');
  process.exit(2);
}
if (!fs.existsSync(UPSTREAM)) {
  console.error(`上游目录不存在：${UPSTREAM}`);
  process.exit(2);
}

const node1 = path.join(RUNTIME, 'node-1');
if (!fs.existsSync(node1)) {
  console.error(`找不到线上源码：${node1}\n可用 SP_RUNTIME 指定运行目录。`);
  process.exit(2);
}

const run = (title, cmd, args, opts = {}) => {
  console.log(`\n${'─'.repeat(60)}\n${title}\n${'─'.repeat(60)}`);
  try {
    const out = execFileSync(cmd, args, { cwd: opts.cwd || REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (out.trim()) console.log(out.trim());
    return { ok: true, out };
  } catch (e) {
    const text = `${e.stdout || ''}${e.stderr || ''}`.trim();
    if (text) console.log(text);
    return { ok: false, out: text, code: e.status };
  }
};

console.log(`仓库:   ${REPO}`);
console.log(`运行:   ${RUNTIME}`);
console.log(`上游:   ${UPSTREAM}`);

let blocking = false;

// ---- 1) 仓库同步状态 -------------------------------------------------------------
const sync = run('1/4 仓库同步状态', process.execPath, [path.join(REPO, 'patcher', 'check-repo-sync.mjs')]);
if (!sync.ok) {
  console.log('\n仓库落后上游或检查失败，请先完成 git 合并，再跑本脚本。');
  blocking = true;
}

// ---- 2) 刷新快照 -----------------------------------------------------------------
if (SKIP_SNAPSHOT) {
  console.log('\n（跳过快照刷新）');
} else {
  const snap = run('2/4 刷新功能快照（从线上 node-1）', process.execPath, [path.join(REPO, 'patcher', 'snapshot-features.mjs')]);
  if (!snap.ok) blocking = true;
}

// ---- 3) 三方合并 -----------------------------------------------------------------
const mergedDir = path.join(REPO, 'staging', 'features-merged');
const merge = run('3/4 三方合并', 'python', [path.join(REPO, 'patcher', 'merge-features.py'), '--upstream', UPSTREAM]);
// merge-features.py 有冲突时返回 1
if (!merge.ok) blocking = true;

// ---- 4) 功能自检 -----------------------------------------------------------------
if (fs.existsSync(mergedDir)) {
  const check = run('4/4 合并结果功能自检', process.execPath,
    [path.join(REPO, 'patcher', 'check-features.mjs'), '--dir', mergedDir]);
  if (!check.ok) blocking = true;
} else {
  console.log('\n没有合并输出，跳过功能自检。');
  blocking = true;
}

// ---- 结论 ------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`);
if (blocking) {
  console.log('需要人工处理');
  console.log('='.repeat(60));
  console.log(`
  1. 打开 ${path.join(mergedDir, 'report.json')}
  2. 处理 status 为 conflict / error / no-base-keep-ours 的条目
  3. 重新跑本脚本确认
  4. 然后：node patcher/apply.mjs → node --check → 部署 → 重启（由你决定时机）
`);
  process.exit(1);
}

console.log('可以部署');
console.log('='.repeat(60));
console.log(`
  合并结果：${mergedDir}
  功能自检：全部通过

  后续（本脚本不代劳）：
    1. 把合并结果同步到 node-1 … node-30（记得 nginx 轮询，必须全部节点一起更新）
    2. node patcher/apply.mjs          服务端锚点补丁
    3. node patcher/check-features.mjs  对线上目录再确认一次
    4. 跑测试
    5. 重启节点（择机，由人决定）
`);
process.exit(0);
