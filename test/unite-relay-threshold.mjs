// 5–20 人房：完美玩家够不够分两轮。
// 维护者 2026-10-26 的决定：3 个完美玩家也要分两轮（第二轮只上 1 名 helper）。
//   node test/unite-relay-threshold.mjs
import { planUnite } from '../node-1/server/match/unite.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? `  ${extra}` : ''}`); }
};

const MAX_HELPERS = 2;

/** 造一个 n 人房：前 perfectCount 个人完美，其余有漏怪。 */
function makeMatch(n, perfectCount, { capacityExperiment = true } = {}) {
  const players = new Map();
  const results = new Map();
  for (let i = 0; i < n; i++) {
    const id = 'p' + i;
    players.set(id, { playerId: id, name: 'P' + (i + 1), seat: i, alive: true, left: false, board: new Map(), bondIds: [] });
    const perfect = i < perfectCount;
    results.set(id, perfect
      ? { perfect: true, leaked: [], unitsOnField: 5 - i * 0.1, activeBond: true, undownedUnits: 3 }
      // 漏怪的人：带 1 个可重入的敌人
      : { perfect: false, leaked: [{ enemyKey: 'enemy_1001_slime', sourcePlayerId: id, lpr: 1 }] });
  }
  const m = {
    capacityExperiment,
    players,
    order: [...players.values()],
    lastResults: new Map(),
    isSolo: false,
    gd: { unite: { maxHelpers: MAX_HELPERS }, enemy: (k) => ({ key: k }) },
    alivePlayers() { return [...players.values()].filter((p) => p.alive && !p.left); },
    bondLayers: () => 0,
    bondLive: () => false,
  };
  // planUnite 读 m.lastResults 里「本轮」的结果
  m.lastResults = results;
  return { m, results };
}

function planFor(n, perfectCount, opts) {
  const { m, results } = makeMatch(n, perfectCount, opts);
  // planUnite(m, results) —— results 是本轮的
  return planUnite(m, results);
}

console.log('5–20 人房 联防分轮门槛（maxHelpers = 2）');

for (const [n, perfect, wantRounds] of [
  [7, 2, 1], [7, 3, 2], [7, 4, 2], [7, 5, 2],
  [5, 3, 2], [6, 3, 2], [10, 3, 2], [20, 3, 2],
]) {
  const plan = planFor(n, perfect);
  // 没有漏怪时不会触发联防（planUnite 返回 null），这种组合不在本测试范围内
  if (!plan) { ok(`${n} 人房 / ${perfect} 个完美 → 无联防（无漏怪）`, false, '用例数据有误'); continue; }
  const rounds = plan.uniteRound === 1 ? 2 : 1;
  ok(`${n} 人房 / ${perfect} 个完美 → ${wantRounds} 轮`,
    rounds === wantRounds,
    `实际 ${rounds} 轮（uniteRound=${plan.uniteRound}, relayCandidates=${plan.relayCandidates?.length ?? 0}）`);
}

// 3 个完美：第二轮必须有 1 个候选
{
  const plan = planFor(7, 3);
  ok('★ 3 个完美 → 有接力候选（第二轮能开）',
    Array.isArray(plan.relayCandidates) && plan.relayCandidates.length === 1,
    `relayCandidates=${plan.relayCandidates?.length ?? 0}`);
  ok('★ 3 个完美 → helpers 仍是 2 人', plan.helpers.length === 2, `实际 ${plan.helpers.length}`);
  ok('★ 3 个完美 → 候选不与 helpers 重叠',
    (plan.relayCandidates || []).every((ps) => !plan.helpers.includes(ps)));
}

// 2 个完美：一轮，不该有第二轮
{
  const plan = planFor(7, 2);
  ok('2 个完美 → 不分轮（第二轮没人）', plan.uniteRound === undefined);
  ok('2 个完美 → 没有接力候选', !plan.relayCandidates || plan.relayCandidates.length === 0);
}

// 4 人房永远不分轮
{
  // 4 人房：capacityExperiment 关掉，且人人完美时没有联防（返回 null 也算「不分轮」）
  const plan = planFor(4, 4, { capacityExperiment: false });
  ok('4 人房即使全员完美也不分轮', !plan || plan.uniteRound === undefined,
    plan ? `uniteRound=${plan.uniteRound}` : '');
}

console.log(`\n结果: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
