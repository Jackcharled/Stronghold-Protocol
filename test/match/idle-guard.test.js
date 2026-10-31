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
  // _humanCount() 读 this.order：默认给两个真人，让既有用例继续按「多人局」判定
  m.order = [];
  m.players = new Map();
  const addHuman = (id, extra = {}) => {
    const p = { playerId: id, isBot: false, left: false, ...extra };
    m.order.push(p); m.players.set(id, p); return p;
  };
  addHuman('p_other');   // 另一个真人，保证默认是多人局
  return { m, kicks, toasts, addHuman };
}

/**
 * 造一个真人并**登记进 order**（_humanCount 靠它数人）。
 * 用法：const ps = human(m, 'p1')
 */
const human = (ctx, id = 'p1') => {
  const p = { playerId: id, isBot: false, left: false };
  if (ctx) { ctx.m.order.push(p); ctx.m.players.set(id, p); }
  return p;
};

/** 推进一回合：先设置新回合号，再发第一条消息触发结算。 */
function nextRound(m, ps, round, msg = { t: 'g.ping' }) {
  m.round = round;
  m._trackActivity(ps, msg);
}

test('规则一：连续 2 回合花钱但不部署 → 踢出', () => {
  const ctx = makeMatch(1);
  const { m, kicks, toasts } = ctx;
  const ps = human(ctx);

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
  const ctx = makeMatch(1);
  const { m, kicks, toasts } = ctx;
  const ps = human(ctx);

  m.round = 1; m._trackActivity(ps, { t: 'g.ping' });   // 第 1 回合：没买没部署
  nextRound(m, ps, 2);                                   // 结算第 1 回合 → idleStrikes=1
  assert.equal(kicks.length, 0);
  nextRound(m, ps, 3);                                   // 结算第 2 回合 → idleStrikes=2 → 踢
  assert.equal(kicks.length, 1, '连续两回合完全不动应当被踢');
  assert.match(toasts[0].text, /未购买、未部署/);
});

test('正常玩的人永远不被踢（每回合都部署）', () => {
  const ctx = makeMatch(1);
  const { m, kicks } = ctx;
  const ps = human(ctx);
  m.round = 1; m._trackActivity(ps, { t: 'g.ping' });
  for (let round = 2; round <= 4; round++) {
    m._trackActivity(ps, { t: 'g.buy' });
    m._trackActivity(ps, { t: 'g.deploy' });   // 有部署
    nextRound(m, ps, round);
  }
  assert.equal(kicks.length, 0);
});

test('★ 踢过一次就不再重复触发（以前每回合都会再踢一次）', () => {
  const ctx = makeMatch(1);
  const { m, kicks, toasts } = ctx;
  const ps = human(ctx);
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
  const ctx = makeMatch(5);
  const { m, kicks } = ctx;
  const ps = human(ctx);
  m.round = 5; m._trackActivity(ps, { t: 'g.ping' });
  nextRound(m, ps, 6);
  nextRound(m, ps, 7);
  assert.equal(kicks.length, 0, '第 4 回合之后不管');
});

test('AI 不参与判定', () => {
  const ctx = makeMatch(1);
  const { m, kicks } = ctx;
  const bot = { playerId: 'b1', isBot: true };
  m.order.push(bot);
  m.round = 1; m._trackActivity(bot, { t: 'g.ping' });
  nextRound(m, bot, 2);
  nextRound(m, bot, 3);
  assert.equal(kicks.length, 0);
});

test('花钱且部署了的人不触发规则一', () => {
  const ctx = makeMatch(1);
  const { m, kicks } = ctx;
  const ps = human(ctx);
  m.round = 1; m._trackActivity(ps, { t: 'g.ping' });
  m._trackActivity(ps, { t: 'g.buy' });
  m._trackActivity(ps, { t: 'g.place' });   // 部署了
  nextRound(m, ps, 2);
  m._trackActivity(ps, { t: 'g.buy' });
  m._trackActivity(ps, { t: 'g.swap' });    // 换位也算操作
  nextRound(m, ps, 3);
  assert.equal(kicks.length, 0);
});

test('★ 单人局（只有一个真人）不判定消极游戏', () => {
  // 维护者要求：只有 2 个以上真人才判定。
  // 一个人自己打（哪怕带三个 AI），挂机也不该被踢 —— 没有别人受影响。
  const ctx = makeMatch(1);
  const { m, kicks } = ctx;
  // 把 makeMatch 默认加进去的那个「另一个真人」撤掉，只剩一个真人
  m.order.length = 0; m.players.clear();
  const ps = human(ctx, 'p1');
  const ai1 = { playerId: 'b1', isBot: true, left: false };
  const ai2 = { playerId: 'b2', isBot: true, left: false };
  m.order.push(ai1, ai2);

  m.round = 1; m._trackActivity(ps, { t: 'g.ping' });
  nextRound(m, ps, 2);
  nextRound(m, ps, 3);
  nextRound(m, ps, 4);
  assert.equal(kicks.length, 0, '一真人 + AI 仍然是单人局，不判定');
});

test('★ 两人开局、中途一人退出 → 剩下那人不再判定', () => {
  // 这是「实时数人」而不是「建局快照」的意义：
  // 2 人开局时依规则会判定，但另一个人退出后就只剩一个人了，不该再踢。
  const ctx = makeMatch(1);
  const { m, kicks } = ctx;
  // makeMatch 默认塞了一个 p_other（保证默认是多人局）；这里要先清空再自己造两个人，
  // 否则 order 里会有三个人，_humanCount 永远是 2，测不出「退到只剩一人」。
  m.order.length = 0; m.players.clear();
  const ps = human(ctx, 'p1');
  const other = human(ctx, 'p2');
  m.round = 1; m._trackActivity(ps, { t: 'g.ping' });
  nextRound(m, ps, 2);                       // 结算第 1 回合：idleStrikes=1

  // 另一个真人离开了这局
  other.left = true;

  nextRound(m, ps, 3);                       // 本该在这一步触发踢人
  assert.equal(kicks.length, 0, '只剩一个真人时不该判消极');
});

test('两个真人都在时照常判定', () => {
  const ctx = makeMatch(1);
  const { m, kicks } = ctx;
  const ps = human(ctx, 'p1');
  m.round = 1; m._trackActivity(ps, { t: 'g.ping' });
  nextRound(m, ps, 2);
  nextRound(m, ps, 3);
  assert.equal(kicks.length, 1, '两个真人以上照常判定');
});