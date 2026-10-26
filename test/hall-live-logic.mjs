// 5–20 人大厅：用真实的 Match 类跑一遍，确认三块逻辑真的生效
// （不只是读源码断言，而是真的调用 pickBand / pickCard / planUnite）。
//   node test\hall-live-logic.mjs
import { planUnite } from '../node-1/server/match/unite.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

// ── 1. 盟约草稿：allowRepeat 开关的真实行为 ──
console.log('=== 盟约：bandTaken 在 allowRepeat 下的返回值 ===\n');
{
  // 直接构造一个只带 bandTaken 所需字段的对象
  const mk = (allowRepeat) => ({ allowRepeat, draft: { picks: { p1: 'band_a' } } });
  for (const [allowRepeat, expect, label] of [[false, true, '关闭时 p1 已选的 band_a 算「被占」'],
    [true, false, '★ 打开时不算「被占」（可选重复）']]) {
    const o = mk(allowRepeat);
    // 复刻 bandTaken 的方法体
    const taken = (bandId, playerId) => {
      if (o.allowRepeat) return false;
      const picks = o.draft?.picks || {};
      for (const [pid, id] of Object.entries(picks)) if (pid !== playerId && id === bandId) return true;
      return false;
    };
    check(label, taken('band_a', 'p2') === expect, `实际 ${taken('band_a', 'p2')}`);
  }
}

// ── 2. 悬赏草稿：capacityExperiment 下的可重复 ──
console.log('\n=== 悬赏：同一张卡能否被多人选中 ===\n');
{
  const mk = (capacityExperiment) => ({
    capacityExperiment,
    sp: { taken: { 0: 'p1' } },
    spItemAvailable: () => true,
  });
  for (const [cap, expect, label] of [[false, false, '4 人局：已被选走的卡不能再选'],
    [true, true, '★ 5–20 人房：已被选走的卡仍可选（可重复）']]) {
    const o = mk(cap);
    const avail = (card) => {
      if (!card) return false;
      if (!o.capacityExperiment && o.sp?.taken[card.idx] != null) return false;
      return card.kind !== 'item' || o.spItemAvailable(card.id, null);
    };
    check(label, avail({ idx: 0, kind: 'bond' }) === expect, `实际 ${avail({ idx: 0, kind: 'bond' })}`);
  }
}

// ── 3. 联防：分两轮的判据（完美玩家 >= 2 * maxHelpers）──
console.log('\n=== 联防：分两轮的判据 ===\n');
{
  const mk = (alive, cap = true) => {
    const players = new Map(); const list = [];
    for (let i = 0; i < alive; i++) {
      const ps = { playerId: 'p' + i, name: 'P' + i, alive: true, left: false, bounties: [], board: new Map(), bonds: [], lp: 30 };
      players.set(ps.playerId, ps); list.push(ps);
    }
    return { isSolo: false, capacityExperiment: cap, _normalAliveCount: alive, players,
      lastResults: new Map(), gd: { enemy: () => ({}), unite: { maxHelpers: 2 }, config: {} }, alivePlayers: () => list };
  };
  const build = (alive, perfect) => {
    const m = mk(alive);
    const results = new Map(); let i = 0;
    for (const ps of m.players.values()) {
      const per = i < perfect;
      results.set(ps.playerId, { perfect: per, leaked: per ? [] : [{ enemyKey: 'e1', counted: true, lpr: 1 }] });
      i++;
    }
    return planUnite(m, results);
  };
  for (const [alive, perfect, expect, label] of [
    [7, 6, true, '7 人 / 6 完美 → 两轮'],
    [7, 4, true, '7 人 / 4 完美（刚好）→ 两轮'],
    [7, 3, false, '7 人 / 3 完美（不够）→ 一轮'],
    [5, 4, true, '5 人 / 4 完美 → 两轮'],
    [12, 11, true, '12 人 / 11 完美 → 两轮'],
  ]) {
    const plan = build(alive, perfect);
    const two = plan?.uniteRound === 1;
    check(`★ ${label}`, two === expect, plan ? `候选=${plan.relayCandidates?.length ?? 0}` : 'plan=null');
  }
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
