// 复活（联防救援）完整流程验证。
//
// 覆盖三件事：
//   1. Match.revive() 在满足条件时能把死亡队友救回来（lp=1，donor 扣 10）
//   2. 各种不满足条件时的拒绝原因正确
//   3. _revivalDeathReason() 的提示不再因为「死者自己」而误报「都不足 11」
//      （2026-10-29 维护者反馈的 bug，见 MAINTENANCE §9.25）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from './harness.js';
import { PHASE } from '../../shared/constants.js';
import { REVIVAL_COST, REVIVAL_MIN_DONOR_LP } from '../../server/match/match/common.js';

/**
 * 构造一个已进入 SETTLE、救援窗口打开的双人合作局。
 * 直接改内部状态而不是跑完一整局：本测试验证的是 revive 的准入与效果，不是战斗。
 */
function rescueFixture(t) {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 7, fake: true }).start().toPrep(1);
  t.after(() => h.m.dispose());
  const m = h.m;
  const donor = h.ps('p_0');
  const victim = h.ps('p_1');

  // 模拟「本轮联防结束、victim 被打死、窗口打开」的状态
  m.revivalEnabled = true;
  m.phase = PHASE.SETTLE;
  m.ended = false;
  m.teamLp = null;
  m._revival = {
    round: m.round,
    eligible: new Set([donor.playerId]),
    windowOpen: true,
    deadline: m.sched.now() + 15000,
  };
  donor.alive = true;
  donor.left = false;
  donor.lp = 20;
  // victim 处于 pendingDeath：死了但还能救
  victim.alive = false;
  victim.pendingDeath = true;
  victim.left = false;
  victim.revived = false;
  victim.lp = 0;
  return { ...h, m, donor, victim };
}

test('复活：满足条件时队友回到 1 点，施救者扣 10 点', (t) => {
  const { m, donor, victim } = rescueFixture(t);
  assert.equal(m.revivalWindowOpen(), true, '窗口应当是开的');

  const r = m.revive(donor, { playerId: victim.playerId, round: m.round, matchId: m.battlePrefix });
  assert.deepEqual(r, { ok: true }, '复活应当成功');

  assert.equal(victim.alive, true, '队友应当复活');
  assert.equal(victim.pendingDeath, false, '不再处于待死状态');
  assert.equal(victim.lp, 1, '复活的队友回到 1 点生命');
  assert.equal(victim.revived, true, '标记本局已用过复活');
  assert.equal(donor.lp, 20 - REVIVAL_COST, '施救者扣 10 点');
});

test('复活：同一队友第二次复活被拒绝', (t) => {
  const { m, donor, victim } = rescueFixture(t);
  assert.deepEqual(m.revive(donor, { playerId: victim.playerId, round: m.round, matchId: m.battlePrefix }), { ok: true });

  // 第一次复活消耗 10 点，补给施救者后让他仍够门槛，这样拒绝原因才是「目标已用过」
  donor.lp = REVIVAL_MIN_DONOR_LP + 5;
  victim.alive = false;
  victim.pendingDeath = true;
  const r2 = m.revive(donor, { playerId: victim.playerId, round: m.round, matchId: m.battlePrefix });
  assert.equal(r2.ok, undefined, '第二次应当失败');
  assert.equal(r2.detail, 'revival-target-ineligible', '原因：目标本局已用过复活');
});

test('复活：施救者生命值不足 11 被拒绝', (t) => {
  const { m, donor, victim } = rescueFixture(t);
  donor.lp = REVIVAL_MIN_DONOR_LP - 1;
  const r = m.revive(donor, { playerId: victim.playerId, round: m.round, matchId: m.battlePrefix });
  assert.equal(r.ok, undefined, '应当失败');
  assert.equal(r.detail, 'revival-lp-insufficient', '原因：生命值不足');
});

test('复活：窗口关闭后无法复活', (t) => {
  const { m, donor, victim } = rescueFixture(t);
  m._revival.windowOpen = false;
  const r = m.revive(donor, { playerId: victim.playerId, round: m.round, matchId: m.battlePrefix });
  assert.equal(r.ok, undefined, '应当失败');
  assert.equal(r.detail, 'revival-window-closed', '原因：窗口已关');
});

// ---- 2026-10-29 bug：提示「都不足 11」把死者自己算了进去 ----

test('提示：除死者外仍有队友能付款时，不报 donor-lp', (t) => {
  const { m, donor, victim } = rescueFixture(t);
  donor.lp = 15;   // 够 11
  // 死者自己 lp=0，但 donorsome 是别人，所以不能因此报「都不足 11」
  const reason = m._revivalDeathReason(victim);
  assert.notEqual(reason, 'donor-lp', '有人能付款时不该说「都不足 11」');
});

test('提示：确实全队都不足 11 时才报 donor-lp', (t) => {
  const { m, donor, victim } = rescueFixture(t);
  donor.lp = 5;    // 不够
  const reason = m._revivalDeathReason(victim);
  assert.equal(reason, 'donor-lp', '全队不够时才是 donor-lp');
});

test('提示：没有合格队友时是 no-helper 而不是 donor-lp', (t) => {
  const { m, victim } = rescueFixture(t);
  m._revival.eligible = new Set();   // 没人有资格
  const reason = m._revivalDeathReason(victim);
  assert.equal(reason, 'no-helper', '没有合格队友');
});
