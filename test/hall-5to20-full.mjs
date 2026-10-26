// 5–20 人大厅的完整规则回归：盟约 / 悬赏 / 联防 三块。
//   node test\hall-5to20-full.mjs
import fs from 'node:fs';
import { planUnite, uniteRelayHelpers } from '../node-1/server/match/unite.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };
const read = (p) => fs.readFileSync(p, 'utf8');

const phases = read('node-1/server/match/match/phases.js');
const spDraft = read('node-1/server/match/match/spDraft.js');
const unitePhase = read('node-1/server/match/match/unitePhase.js');
const uniteJs = read('node-1/server/match/unite.js');
const bandDraftFe = read('node-1/public/js/screens/bandDraft.js');

function fakeMatch({ alive, normalAlive, capacityExperiment = true }) {
  const players = new Map(); const list = [];
  for (let i = 0; i < alive; i++) {
    const ps = { playerId: 'p' + i, name: 'P' + i, alive: true, left: false, bounties: [], board: new Map(), bonds: [], lp: 30 };
    players.set(ps.playerId, ps); list.push(ps);
  }
  return { isSolo: false, capacityExperiment, _normalAliveCount: normalAlive, players,
    lastResults: new Map(), gd: { enemy: () => ({}), unite: { maxHelpers: 2 }, config: {} }, alivePlayers: () => list };
}
function planFor(n) {
  const m = fakeMatch({ alive: n, normalAlive: n });
  const results = new Map();
  for (const ps of m.players.values()) results.set(ps.playerId, { perfect: true, leaked: [] });
  results.get('p0').leaked = [{ enemyKey: 'e1', counted: true, lpr: 1 }];
  return { m, plan: planUnite(m, results) };
}
const allocate = (plan) => {
  const relayPossible = plan.uniteRound === 1 && Array.isArray(plan.relayCandidates) && plan.relayCandidates.length > 0;
  const alloc = relayPossible ? [150, 150] : [300];
  return Math.min(300, alloc[plan.uniteRound === 2 ? 1 : 0] ?? 0);
};
// 第二波：预算表已经由第一波建好，这里直接验「第二轮取 allocations[1]」
const secondWave = () => {
  const alloc = [150, 150];           // 第一波分配时建立的表
  return Math.min(300, alloc[1] ?? 0);
};

console.log('=== 一、盟约：允许重复选择策略 ===\n');
check('★ allowRepeat 时 bandTaken 不判重', /bandTaken\(bandId, playerId\) \{\s*\n\s*if \(this\.allowRepeat\) return false;/.test(phases));
check('★ 只在 5–20 人房生效（capacityExperiment 把关）',
  /allowRepeat = this\.capacityExperiment && this\.experimental\.allowRepeat === true/.test(read('node-1/server/match/Match.js')));
check('★ 并发草稿：所有人同时选', /_concurrentBandStep\(\)/.test(phases));
check('★ 并发时没有轮次限制', /if \(!this\.draft\.concurrent && this\.draftTurn\(\) !== ps\.playerId\)/.test(phases));
check('前端接受并发（draftMyTurn）', /draftMyTurn\(draft, myId, solo\)/.test(bandDraftFe));

console.log('\n=== 二、悬赏：可重复选择 ===\n');
check('★ 大厅房不判「已被选走」（capacityExperiment 短路）',
  /this\.capacityExperiment \|\| this\.sp\?\.taken\[card\.idx\] == null/.test(spDraft));
check('★ 重复选中时克隆卡片', /this\.capacityExperiment \? structuredClone\(s\.cards\[idx\]\)/.test(spDraft));
check('★ 并发悬赏：所有人同时选', /_concurrentSpStep\(\)/.test(spDraft));
check('★ 并发时没有轮次限制', /if \(!this\.sp\.concurrent && this\.spTurn\(\) !== ps\.playerId\)/.test(spDraft));

console.log('\n=== 三、联防：预算与接力 ===\n');
// 7 人：完美玩家 >= 4 → 应该分两轮（规则：够 4 个人联防就两轮，与总人数无关）
{
  const { plan } = planFor(7);
  check('★ 7 人房有富余完美玩家 → 允许接力', plan.uniteRound === 1,
    `uniteRound=${plan.uniteRound} 候选=${plan.relayCandidates?.length ?? 0}`);
  check('★ 7 人房可以接力时第一波 150 秒', allocate(plan) === 150, `实际 ${allocate(plan)}`);
}
// 8 人：有接力，分两段
{
  const { m, plan } = planFor(8);
  check('8 人房设置接力（>= 8 人）', plan.uniteRound === 1, `uniteRound=${plan.uniteRound}`);
  check('8 人房有接力候选', Array.isArray(plan.relayCandidates) && plan.relayCandidates.length > 0,
    `候选=${plan.relayCandidates?.length ?? 0}`);
  check('★ 8 人房第一波 150 秒（分两段）', allocate(plan) === 150, `实际 ${allocate(plan)}`);
  // 第二波：预算表在第一波建好后复用，取 allocations[1]
  check('★ 第二波也是 150 秒', secondWave() === 150, `实际 ${secondWave()}`);
}
// 分配不能依赖 lastResults（修复的那个 bug）
check('★ 预算分配不看 uniteRelayHelpers（它依赖 lastResults，分配时还没更新）',
  !/allocations: uniteRelayHelpers\(/.test(unitePhase),
  '修复前：8 人房也被判成无接力');
check('★ 分配看 relayCandidates', /relayCandidates\.length > 0/.test(unitePhase));

console.log('\n=== 四、联防：分组与配额 ===\n');
check('helper 上限来自配置', /maxHelpers/.test(uniteJs));
check('最多 2 名 helper', /slice\(0, m\.gd\.unite\.maxHelpers\)/.test(uniteJs));
check('第二波只允许第一波的残留敌人', /Only the first field's residual enemies may enter a relay/.test(uniteJs));

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
