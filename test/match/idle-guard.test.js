// test/match/idle-guard.test.js — 防消极游戏（2026-10-31）。
//
// 维护者要的规则：前期（第 1–4 回合）连续两回合
//   · 花了钱（买/刷新/升级）却一次都没部署干员，或
//   · 干脆什么都不做（连钱都不花）
// 就算消极游戏，把人移出同盟。
//
// 这套判定原本就写在 MatchIntents._trackActivity 里，但**从来没生效过**：
// server/lobby.js 创建 Match 时没有传 onIdleKick，于是
// `this.onIdleKick?.(...)` 永远不执行 —— 只弹一个 toast，人照样留在局里。
// 这份测试盯住三件事：
//   1) 两条规则各自在正确的时机触发；
//   2) 触发之后不会再重复触发（以前每回合都会再踢一次）；
//   3) 正常玩的人永远不会被踢。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchIntents } from '../../server/match/match/intents.js';
import { PHASE } from '../../shared/constants.js';

/** 一个足够驱动 _trackActivity 的最小 Match：只有 round / 回调。 */
function makeMatch(round = 1) {
  const kicks = [];
  const toasts = [];
  const m = Object.create(MatchIntents.prototype);
  m.round = round;
  m.phase = PHASE.PREP;
  m.toast = (ps, kind, text) => toasts.push({ playerId: ps.playerId, kind, text });
  m.onIdleKick = (playerId, reason) => kicks.push({ playerId, reason });
  return { m, kicks, toasts };
}

const human = (id = 'p1') => ({ playerId: id, isBot: false });

/** 推进一回合：先设置新回合号，再发第一条消息触发结算。 */
function nextRound(m, ps, round, msg = { t: 'g.ping' }) {
  m.round = round;
  m._trackActivity(ps, msg);
}

test('规则一：连续 2 回合花钱但不部署 → 踢出', () => {
  const { m, kicks, toasts } = makeMatch(1);
  const ps = human();

  // 第 1 回合：买了东西，没部署。此时结算的是「上一个回合」（还不存在），只建立状态
  m.round = 1; m._trackActivity(ps, { t: 'g.ping' });
  m._trackActivity(ps, { t: 'g.buy' });
  m._trackActivity(ps, { t: 'g.refresh' });
  assert.equal(kicks.length, 0, '第 1 回合内不判定');

  // 第 2 回合开始：结算第 1 回合 —— spend>0 且 place=0，记 1 次
  nextRound(m, ps, 2);
  assert.equal(kicks.length, 0, '第一次不踢，要看是否连续');
  m._trackActivity(ps, { t: 'g.buy' });

  // 第 3 回合开始：结算第 2 回合 —— 再次 spend>0 且 place=0，累计 2 次 → 踢
  nextRound(m, ps, 3);
  assert.equal(kicks.length, 1, '连续两回合花钱不部署应当被踢');
  assert.equal(kicks[0].playerId, 'p1');
  assert.equal(kicks[0].reason, 'idle');
  assert.equal(toasts.length, 1, '踢之前要提示一次');
  assert.match(toasts[0].text, /未部署干员/);
});

test('规则二：连续 2 回合什么都不做 → 踢出', () => {
  const { m, kicks, toasts } = makeMatch(1);
  const ps = human();

  m.round = 1; m._trackActivity(ps, { t: 'g.ping' });   // 第 1 回合：没买没部署
  nextRound(m, ps, 2);                                   // 结算第 1 回合 → idleStrikes=1
  assert.equal(kicks.length, 0);
  nextRound(m, ps, 3);                                   // 结算第 2 回合 → idleStrikes=2 → 踢
  assert.equal(kicks.length, 1, '连续两回合完全不动应当被踢');
  assert.match(toasts[0].text, /未购买、未部署/);
});

test('正常玩的人永远不被踢（每回合都部署）', () => {
  const { m, kicks } = makeMatch(1);
  const ps = human();
  m.round = 1; m._trackActivity(ps, { t: 'g.ping' });
  for (let round = 2; round <= 4; round++) {
    m._trackActivity(ps, { t: 'g.buy' });
    m._trackActivity(ps, { t: 'g.deploy' });   // 有部署
    nextRound(m, ps, round);
  }
  assert.equal(kicks.length, 0);
});

test('★ 踢过一次就不再重复触发（以前每回合都会再踢一次）', () => {
  const { m, kicks, toasts } = makeMatch(1);
  const ps = human();
  m.round = 1; m._trackActivity(ps, { t: 'g.ping' });
  nextRound(m, ps, 2);
  nextRound(m, ps, 3);                       // 这里触发第一次
  assert.equal(kicks.length, 1);
  // 继续挂机两回合：不应该再踢、也不应该再弹提示
  nextRound(m, ps, 4);
  assert.equal(kicks.length, 1, '已经踢过的人不再重复踢');
  assert.equal(toasts.length, 1, '也不再重复提示');
});

test('第 4 回合之后不再判定（避免中后期把整局搞失衡）', () => {
  const { m, kicks } = makeMatch(5);
  const ps = human();
  m.round = 5; m._trackActivity(ps, { t: 'g.ping' });
  nextRound(m, ps, 6);
  nextRound(m, ps, 7);
  assert.equal(kicks.length, 0, '第 4 回合之后不管');
});

test('AI 不参与判定', () => {
  const { m, kicks } = makeMatch(1);
  const bot = { playerId: 'b1', isBot: true };
  m.round = 1; m._trackActivity(bot, { t: 'g.ping' });
  nextRound(m, bot, 2);
  nextRound(m, bot, 3);
  assert.equal(kicks.length, 0);
});

test('花钱且部署了的人不触发规则一', () => {
  const { m, kicks } = makeMatch(1);
  const ps = human();
  m.round = 1; m._trackActivity(ps, { t: 'g.ping' });
  m._trackActivity(ps, { t: 'g.buy' });
  m._trackActivity(ps, { t: 'g.place' });   // 部署了
  nextRound(m, ps, 2);
  m._trackActivity(ps, { t: 'g.buy' });
  m._trackActivity(ps, { t: 'g.swap' });    // 换位也算操作
  nextRound(m, ps, 3);
  assert.equal(kicks.length, 0);
});
