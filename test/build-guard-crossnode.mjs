// 跨节点不应触发「服务器已更新」的自动刷新。
//
// 背景：本服 30 个节点，buildTag 是进程启动时缓存的 size+mtime 指纹，
// 各节点重启时间不同 → 同一页面从 node-A 跳到 node-B 会看到不同 build，
// 被 buildGuard 当成「有新版」并自动 reload。
// 玩家看到的就是「离开房间 / 跨节点观战 / 加入房间时突然刷新」。
//
//   node test/build-guard-crossnode.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = readFileSync(resolve(root, 'node-1/public/js/ui/buildGuard.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass++; }
  else { fail++; console.log(`  FAIL ${n}${extra ? '  ' + extra : ''}`); }
};

console.log('buildGuard：跨节点不误判为「服务器已更新」');

// 1) 必须记录所在节点
ok('★ 记录上次检查时的节点', /let lastNode = null;/.test(src));

// 2) 节点变化时要重置基准，而不是当作新 build
ok('★ 读 sp_node 判断节点是否变了', /document\.cookie\.match\(\/sp_node=\(\\d\+\)\/\)/.test(src));
ok('★ 节点变化就把 known 清空（重新成为基准）', /known = null;/.test(src));
ok('★ 节点变化要清掉 candidate / seen', /candidate = null;/.test(src) && /seen = 0;/.test(src));

// 3) 原有行为不能被破坏
ok('仍然连续两次一致才认定新 build', /BUILD_CONFIRMATIONS/.test(src));
ok('/healthz 读不到时永不刷新', /r\.status === 'unknown'/.test(src));
ok('对局中不刷新', /const waiting = inMatch\(\);/.test(src) || /if \(!waiting\) reloadNow\(\);/.test(src));

// 4) 行为模拟：复刻节点切换逻辑
function simulate({ checks, nodeOfEachCheck }) {
  let known = null, candidate = null, seen = 0, lastNode = null, reloaded = false;
  const CONFIRM = 2;
  for (let i = 0; i < checks.length; i++) {
    const r = checks[i];
    const nodeNow = nodeOfEachCheck[i] || '';
    let nodeChanged = false;
    if (nodeNow && nodeNow !== lastNode) {
      nodeChanged = true; lastNode = nodeNow; candidate = null; seen = 0;
    }
    if (r.status === 'unknown') { candidate = null; seen = 0; continue; }
    // 节点刚变：这一轮的 build 直接当基准
    if (nodeChanged && r.build) { known = r.build; candidate = null; seen = 0; continue; }
    if (r.status === 'first') { known = r.build; continue; }
    if (r.status === 'current') { candidate = null; seen = 0; continue; }
    if (candidate !== r.build) { candidate = r.build; seen = 1; } else { seen++; }
    if (seen < CONFIRM) continue;
    // waiting=false 时立刻刷新
    const waiting = false;
    if (!waiting) { reloaded = true; break; }
  }
  return reloaded;
}

console.log('\n  === 场景 ===');
// 用 build 序列驱动：status 由 known 与实际 build 比较得出（与 checkBuildOnce 一致）
function run({ builds, nodes }) {
  let known = null, candidate = null, seen = 0, lastNode = null, reloaded = false;
  const CONFIRM = 2;
  for (let i = 0; i < builds.length; i++) {
    const build = builds[i];
    const nodeNow = nodes[i] || '';
    let nodeChanged = false;
    if (nodeNow && nodeNow !== lastNode) {
      nodeChanged = true; lastNode = nodeNow; candidate = null; seen = 0;
    }
    if (!build) { candidate = null; seen = 0; continue; }        // unknown
    if (nodeChanged) { known = build; candidate = null; seen = 0; continue; }
    if (known === null) { known = build; continue; }              // first
    if (build === known) { candidate = null; seen = 0; continue; } // current
    if (candidate !== build) { candidate = build; seen = 1; } else { seen++; }
    if (seen < CONFIRM) continue;
    reloaded = true; break;
  }
  return reloaded;
}

// 跨节点：node 5(AAA) → node 13(BBB)，之后一直是 BBB
ok('★ 跨节点（build 不同）不刷新',
  run({ builds: ['AAA', 'BBB', 'BBB', 'BBB', 'BBB'], nodes: ['5', '13', '13', '13', '13'] }) === false);

// 同一节点上真的换版：应该刷新
ok('同一节点上真的换版 → 仍然刷新',
  run({ builds: ['AAA', 'BBB', 'BBB'], nodes: ['5', '5', '5'] }) === true);

// 跨节点后稳定在新 build：不刷新
ok('跨节点后稳定在新 build → 不刷新',
  run({ builds: ['AAA', 'BBB', 'BBB', 'BBB'], nodes: ['5', '13', '13', '13'] }) === false);

// 跨过去又跨回来（两个节点 build 不同）：来回都不该刷新
ok('★ 在两节点间来回跳 → 不刷新',
  run({ builds: ['AAA', 'BBB', 'AAA', 'BBB', 'AAA'], nodes: ['5', '13', '5', '13', '5'] }) === false);

console.log(`\n结果: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
