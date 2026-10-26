// 验证 5–20 人房「分两轮」的规则：
//   **完美玩家够「第一波 2 人 + 至少 1 人接力」（即 >= 3）就分成 2 轮；否则一轮打完。**
// 与房间总人数无关（以前卡「存活 ≥ 8 人」是错的：7 人房明明有 3 个以上完美玩家却只打一轮）。
// 2026-10-26 维护者决定：第二轮不要求凑满 2 人，3 个完美玩家也要分两轮。
//   node test\unite-two-rounds.mjs
import { planUnite, uniteRelayHelpers } from '../node-1/server/match/unite.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

function fakeMatch({ alive, capacityExperiment = true }) {
  const players = new Map(); const list = [];
  for (let i = 0; i < alive; i++) {
    const ps = { playerId: 'p' + i, name: 'P' + i, alive: true, left: false, bounties: [], board: new Map(), bonds: [], lp: 30 };
    players.set(ps.playerId, ps); list.push(ps);
  }
  return { isSolo: false, capacityExperiment, _normalAliveCount: alive, players,
    lastResults: new Map(), gd: { enemy: () => ({}), unite: { maxHelpers: 2 }, config: {} }, alivePlayers: () => list };
}

/** 造一个房间：1 个漏怪 + (total-1) 个完美玩家 */
function scenario(total, perfect) {
  const m = fakeMatch({ alive: total });
  const results = new Map();
  let i = 0;
  for (const ps of m.players.values()) {
    const isPerfect = i < perfect;
    results.set(ps.playerId, { perfect: isPerfect, leaked: isPerfect ? [] : [{ enemyKey: 'e1', counted: true, lpr: 1 }] });
    i++;
  }
  return { m, plan: planUnite(m, results) };
}

console.log('规则：完美玩家 >= 3（第一波 2 人 + 至少 1 人接力）→ 分两轮；否则一轮\n');

const cases = [
  // [总人数, 完美玩家数, 期望分两轮]
  [7, 6, true,  '7 人房 6 个完美（玩家反馈的实际情况）'],
  [7, 4, true,  '7 人房 4 个完美（够两轮，第二轮 2 人）'],
  [7, 3, true,  '7 人房 3 个完美（第二轮只上 1 人，仍分两轮）'],
  [5, 4, true,  '5 人房 4 个完美（够）'],
  [5, 3, true,  '5 人房 3 个完美（第二轮只上 1 人）'],
  [7, 2, false, '7 人房 2 个完美（第一波就用完，一轮）'],
  [10, 9, true, '10 人房 9 个完美'],
  [20, 20, true, '20 人房全员完美'],
  [8, 7, true,  '8 人房 7 个完美'],
  [6, 5, true,  '6 人房 5 个完美'],
];

for (const [total, perfect, expectTwo, label] of cases) {
  const { m, plan } = scenario(total, perfect);
  // 没有漏怪就没有联防（plan=null）：这种情况对「分几轮」不适用，跳过
  if (!plan) { console.log(`${label}: 无漏怪 → 不触发联防（跳过）`); continue; }
  const twoRounds = plan.uniteRound === 1;
  const helpers = plan?.helpers?.length ?? 0;
  const cand = plan?.relayCandidates?.length ?? 0;
  console.log(`${label}: helpers=${helpers} relayCandidates=${cand} → ${twoRounds ? '两轮' : '一轮'}`);
  check(`★ ${label} → ${expectTwo ? '分两轮' : '一轮打完'}`, twoRounds === expectTwo,
    `期望 ${expectTwo ? '两轮' : '一轮'}，实际 ${twoRounds ? '两轮' : '一轮'}`);
}

console.log('\n=== 非 5–20 人房（4 人房）不分轮 ===\n');
{
  const m = fakeMatch({ alive: 4, capacityExperiment: false });
  const results = new Map();
  let i = 0;
  for (const ps of m.players.values()) {
    results.set(ps.playerId, { perfect: i < 3, leaked: i < 3 ? [] : [{ enemyKey: 'e1', counted: true, lpr: 1 }] });
    i++;
  }
  const plan = planUnite(m, results);
  check('★ 4 人房即使完美玩家够也不分轮', plan === null || plan.uniteRound === undefined,
    `uniteRound=${plan?.uniteRound}`);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
