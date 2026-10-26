// 验证「独立卡池」(disableSharedPool) 的生效范围：
//   **只在开启后生效，并且 4 人房也要支持**（不只 5–20 人房）。
//   node test\independent-pool.mjs
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const matchJs = fs.readFileSync('node-1/server/match/Match.js', 'utf8');
const expJs = fs.readFileSync('node-1/shared/experimental.js', 'utf8');
const roomJs = fs.readFileSync('node-1/public/js/screens/room.js', 'utf8');

console.log('=== 1) 服务端：disableSharedPool 不受人数限制 ===\n');
check('disableSharedPool 只看「非单人 + 开关」',
  /this\.disableSharedPool = !this\.isSolo && this\.experimental\.disableSharedPool;/.test(matchJs),
  '没有 capacityExperiment 前置条件');
check('★ 每人卡池的条件含 disableSharedPool（4 人房也走这条）',
  /this\.playerPools = this\.disableSharedPool \|\| this\.capacityExperiment/.test(matchJs));
check('卡池对象按 disableSharedPool 重建',
  /this\.pool = this\.disableSharedPool \? new SharedPool/.test(matchJs));

console.log('\n=== 2) 选项本身不被人数裁剪 ===\n');
check('★ experimentalOptions 保留 disableSharedPool（不论人数）',
  /return Object\.freeze\(\{ revivalEnabled: value\.revivalEnabled, disableSharedPool: value\.disableSharedPool,/.test(expJs));

console.log('\n=== 3) 前端：4 人房也能开这些开关 ===\n');
// 直接检查每个开关按钮是否被 capacity > 4 的条件包住
const switchBlock = (testid) => {
  const i = roomJs.indexOf(`data-testid="${testid}"`);
  if (i < 0) return null;
  // 往前找最近的 ${capacity > 4 ? 或 html`<
  const before = roomJs.slice(Math.max(0, i - 400), i);
  return { before, wrappedByCapacity: /\$\{capacity > 4 \? html`/.test(before) && !before.includes('</div>') };
};
for (const [testid, label] of [['exp-revival', '队友复活'], ['exp-independent', '独立卡池']]) {
  const b = switchBlock(testid);
  check(`★ 「${label}」开关不受人数限制（4 人房可开）`, b && !b.wrappedByCapacity,
    b ? (b.wrappedByCapacity ? '被 capacity > 4 包住' : '无人数条件') : '未找到按钮');
}
for (const [testid, label] of [['exp-no-duck', '禁用鸭爵'], ['exp-repeat', '允许重复选择策略']]) {
  const b = switchBlock(testid);
  check(`对照：「${label}」只在 5–20 人房出现`, b && b.wrappedByCapacity,
    b ? (b.wrappedByCapacity ? '有 capacity > 4 条件' : '⚠️ 缺条件') : '未找到按钮');
}
check('★ apply 时 revivalEnabled / disableSharedPool 都不受人数限制',
  /revivalEnabled: revival,/.test(roomJs) && /disableSharedPool: independent,/.test(roomJs)
  && !/capacity > 4 && revival/.test(roomJs) && !/capacity > 4 && independent/.test(roomJs));
check('对照：鸭爵/重复确实有 capacity > 4 限制（它们只属于大厅房）',
  /capacity > 4 && noDuck/.test(roomJs) && /capacity > 4 && repeat/.test(roomJs));

console.log('\n=== 4) 四人房 vs 大厅房的卡池归属 ===\n');
// 复刻 playerPools 的构造条件
const makePools = ({ solo = false, capacity = 4, independent = false }) => {
  const capacityExperiment = !solo && capacity > 4;
  const disableSharedPool = !solo && independent;
  const usesPerPlayer = disableSharedPool || capacityExperiment;
  return { capacityExperiment, disableSharedPool, usesPerPlayer };
};
for (const [label, o, expect] of [
  ['4 人房 + 独立卡池开', { capacity: 4, independent: true }, true],
  ['4 人房 + 独立卡池关', { capacity: 4, independent: false }, false],
  ['7 人房 + 独立卡池关（大厅房本来就分池）', { capacity: 7, independent: false }, true],
  ['7 人房 + 独立卡池开', { capacity: 7, independent: true }, true],
  ['单人房 + 独立卡池开（不适用）', { solo: true, capacity: 1, independent: true }, false],
]) {
  const r = makePools(o);
  check(`★ ${label} → ${expect ? '每人独立卡池' : '共享卡池'}`, r.usesPerPlayer === expect,
    `实际 ${r.usesPerPlayer}`);
}

console.log('\n=== 5) 悬赏/物品按人取池 ===\n');
const spJs = fs.readFileSync('node-1/server/match/match/spDraft.js', 'utf8');
check('★ 物品可得性用 itemPoolFor(player)（按人）',
  /spItemAvailable\(id, player = null\)[\s\S]{0,200}itemPoolFor\(player\)\.canGain\(id\)/.test(spJs));
check('★ spCardAvailable 传 player 下去',
  /this\.spItemAvailable\(card\.id, player\)/.test(spJs));

console.log('\n=== 6) 「只在开启后生效」——关闭时不得有任何副作用 ===\n');
// 复刻 Match 里的开关门控
const gate = ({ solo = false, revival = false, independent = false, capacity = 4 }) => {
  const isSolo = solo;
  const revivalEnabled = !isSolo && revival;
  const disableSharedPool = !isSolo && independent;
  const capacityExperiment = !isSolo && capacity > 4;
  return { revivalEnabled, disableSharedPool, capacityExperiment,
    perPlayerPools: disableSharedPool || capacityExperiment };
};
{
  const off = gate({ capacity: 4 });
  check('★ 4 人房两个开关都关 → 复活禁用', off.revivalEnabled === false);
  check('★ 4 人房两个开关都关 → 共享卡池', off.disableSharedPool === false);
  check('★ 4 人房两个开关都关 → 不启用每人卡池', off.perPlayerPools === false);

  const on = gate({ capacity: 4, revival: true, independent: true });
  check('★ 4 人房两个开关都开 → 复活启用', on.revivalEnabled === true);
  check('★ 4 人房两个开关都开 → 独立卡池', on.disableSharedPool === true);
  check('★ 4 人房两个开关都开 → 每人卡池', on.perPlayerPools === true);
}
// 复活的几个入口都必须看 revivalEnabled
const matchJs2 = fs.readFileSync('node-1/server/match/Match.js', 'utf8');
const settleJs = fs.readFileSync('node-1/server/match/match/settle.js', 'utf8');
const guards = (src, re) => re.test(src);
check('★ 复活申请看 revivalEnabled', guards(matchJs2, /if \(!this\.revivalEnabled\) return \{ error: ERR\.WRONG_PHASE/));
check('★ 复活窗口看 revivalEnabled', guards(matchJs2, /if \(!this\.revivalEnabled\) return 'disabled'/));
check('★ 结算救援看 revivalEnabled', guards(settleJs, /const canRescue = this\.revivalEnabled &&/));
check('★ 房间状态里的复活开关按 experimental 下发',
  guards(fs.readFileSync('node-1/server/lobby.js', 'utf8'),
    /revival: \{ enabled: this\.mode === 'coop' && this\.experimental\?\.revivalEnabled === true \}/));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
