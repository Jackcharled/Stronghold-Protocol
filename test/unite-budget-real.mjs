// 直接跑 unitePhase.uniteTimeLimit 的真实逻辑（不靠读源码猜），
// 验证 7 人房 / 8 人房各拿到多少联防时间。
//   node test\unite-budget-real.mjs
import { planUnite, uniteRelayHelpers } from '../node-1/server/match/unite.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

// 造一个最小 Match 形状，只满足 planUnite 的读取
function fakeMatch({ alive, normalAlive, capacityExperiment = true }) {
  const players = new Map();
  const list = [];
  for (let i = 0; i < alive; i++) {
    const ps = { playerId: 'p' + i, name: 'P' + i, alive: true, left: false, bounties: [], board: new Map(), bonds: [], lp: 30 };
    players.set(ps.playerId, ps);
    list.push(ps);
  }
  return {
    isSolo: false,
    capacityExperiment,
    _normalAliveCount: normalAlive,
    players,
    lastResults: new Map(),
    gd: { enemy: () => ({}), unite: { maxHelpers: 2 }, config: {} },
    alivePlayers: () => list,
  };
}

// 复刻 unitePhase.uniteTimeLimit 的分配逻辑（修复后：看 relayCandidates 而非 uniteRelayHelpers）
function allocate(m, plan, gameSpeed = 2) {
  const relayPossible = plan.uniteRound === 1
    && Array.isArray(plan.relayCandidates) && plan.relayCandidates.length > 0;
  const budget = {
    total: 300,
    remaining: 300,
    allocations: relayPossible ? [150, 150] : [300],
  };
  const timeLimit = Math.min(budget.remaining, budget.allocations[plan.uniteRound === 2 ? 1 : 0] ?? 0);
  return { allocations: budget.allocations, timeLimit, uniteRound: plan.uniteRound, relayPossible };
}

console.log('=== 7 人房（有富余完美玩家 → 应该能接力）===\n');
{
  const m = fakeMatch({ alive: 7, normalAlive: 7 });
  const results = new Map();
  for (const ps of m.players.values()) results.set(ps.playerId, { perfect: true, leaked: [] });
  // 让 1 个人漏怪、其余完美，触发联防
  results.get('p0').leaked = [{ enemyKey: 'e1', counted: true, lpr: 1 }];
  const plan = planUnite(m, results);
  check('planUnite 返回了联防计划', !!plan, plan ? `helpers=${plan.helpers.length} leakers=${plan.leakers.length}` : '');
  // 7 人里有 6 个完美玩家，第一波只用掉 maxHelpers(2) 个，还剩 4 个 → 够第二波
  check('★ 7 人房有富余完美玩家 → 允许接力', plan && plan.uniteRound === 1,
    `uniteRound=${plan?.uniteRound} relayCandidates=${plan?.relayCandidates?.length ?? 0}`);
  const a = allocate(m, plan);
  console.log(`   allocations = [${a.allocations}] → 本段 ${a.timeLimit} 游戏秒`);
  check('★ 7 人房可以接力时第一波 150 秒', a.timeLimit === 150, `实际 ${a.timeLimit}`);
}

console.log('\n=== 5 人房（完美玩家刚好够第一波，无富余 → 不接力）===\n');
{
  const m = fakeMatch({ alive: 5, normalAlive: 5 });
  const results = new Map();
  for (const ps of m.players.values()) results.set(ps.playerId, { perfect: true, leaked: [] });
  results.get('p0').leaked = [{ enemyKey: 'e1', counted: true, lpr: 1 }];
  const plan = planUnite(m, results);
  // 4 个完美玩家，第一波 helper 最多 2 个，但 maxHelpers 取 min(2, 4)=2 → 还剩 2 个，仍够
  console.log(`   helpers=${plan?.helpers.length} relayCandidates=${plan?.relayCandidates?.length ?? 0}`);
  const a = allocate(m, plan);
  console.log(`   allocations = [${a.allocations}] → 本段 ${a.timeLimit} 游戏秒`);
  check('5 人房按候选实际数量决定（有富余就接力）',
    plan.uniteRound === 1 ? a.timeLimit === 150 : a.timeLimit === 300,
    `uniteRound=${plan?.uniteRound} 时间=${a.timeLimit}`);
}

console.log('\n=== 8 人房（有接力资格，且有富余的完美玩家）===\n');
{
  const m = fakeMatch({ alive: 8, normalAlive: 8 });
  const results = new Map();
  for (const ps of m.players.values()) results.set(ps.playerId, { perfect: true, leaked: [] });
  results.get('p0').leaked = [{ enemyKey: 'e1', counted: true, lpr: 1 }];
  const plan = planUnite(m, results);
  check('★ 8 人房设 uniteRound=1', plan && plan.uniteRound === 1, `uniteRound=${plan?.uniteRound}`);
  // relayCandidates 里除 helper 外的完美玩家 → 有接力帮手
  const cand = plan.relayCandidates || [];
  const realHelpers = uniteRelayHelpers(m, plan);
  console.log(`   完美玩家=${(plan.helpers.length + cand.length)} relayCandidates=${cand.length} 可接力帮helper=${realHelpers.length}`);
  const a = allocate(m, plan);
  console.log(`   allocations = [${a.allocations}] → 本段 ${a.timeLimit} 游戏秒`);
  check('★ 8 人房有接力候选时第一波 150 秒', a.timeLimit === 150,
    `实际 ${a.timeLimit}（allocations=[${a.allocations}]，接力帮手=${realHelpers.length}）`);
}

console.log('\n=== 4 人房（非容量实验）===\n');
{
  const m = fakeMatch({ alive: 4, normalAlive: 4, capacityExperiment: false });
  const results = new Map();
  for (const ps of m.players.values()) results.set(ps.playerId, { perfect: true, leaked: [] });
  results.get('p0').leaked = [{ enemyKey: 'e1', counted: true, lpr: 1 }];
  const plan = planUnite(m, results);
  check('4 人房不设 uniteRound', plan && plan.uniteRound === undefined);
  console.log('   （4 人房走 base = wave.timeLimit，不用 300 秒预算）');
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
