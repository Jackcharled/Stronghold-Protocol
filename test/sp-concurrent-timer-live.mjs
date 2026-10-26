// 运行时验证：5–20 人房的悬赏决策是**公共计时**——
// 所有人共用一个倒计时，选卡不会重置或清空它，直到阶段结束。
//
//   node test/sp-concurrent-timer-live.mjs
import { makeMatch, DATA } from './match/harness.js';
import { PHASE } from '../shared/constants.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

// 5 人（capacityExperiment=true）+ 允许重复 → concurrentDraft() 为真 → 悬赏走并发
// 注意 shared/experimental.js 的 isExperimental：revivalEnabled / disableSharedPool
// 两个布尔必须存在，否则直接抛 invalid experimental options。
const h = makeMatch({
  mode: 'coop', humans: 5, seed: 3,
  seats: [0, 1, 2, 3, 4].map((i) => ({ seat: i, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true })),
  experimental: { revivalEnabled: false, disableSharedPool: false, playerCapacity: 5, allowRepeat: true },
}).start();
const m = h.m;

console.log('=== 前置：确实进入了并发悬赏 ===\n');
check('capacityExperiment 为真', m.capacityExperiment === true);
check('concurrentDraft() 为真', m.concurrentDraft() === true);

// 推进到 SP_DRAFT：所有人 infoReady → 选策略 → 用 harness 的 run() 推进到机变回合
const allReady = () => { for (const p of m.order) m.handle(p.playerId, { t: 'g.infoReady' }); h.sched.advance(1); };
allReady();                                   // INFO_CHECK → BAND_DRAFT
if (m.phase === PHASE.BAND_DRAFT) {
  const d = m.draft;
  for (const pid of d.order) {
    if (d.picks[pid]) continue;
    const ps = m.players.get(pid);
    if (ps?.isBot) continue;
    const free = m.gd.bandIds().find((b) => !m.bandTaken(b, pid));
    if (free) m.handle(pid, { t: 'g.band', bandId: free });
  }
  h.sched.advance(1);
}
// 机变在 gd.spRounds() 指定的回合触发（通常是第 2 回合），用 run() 推进到那里
try { h.run(() => m.phase === PHASE.SP_DRAFT, { maxTime: 600000 }); } catch { /* ignore */ }

check('进入 SP_DRAFT', m.phase === PHASE.SP_DRAFT, `phase=${m.phase} round=${m.round}`);

if (m.phase === PHASE.SP_DRAFT) {
  const s = m.sp;
  console.log('\n=== 并发悬赏的公共计时 ===\n');
  check('sp.concurrent 为真', s.concurrent === true);
  check('★ 阶段开始时就有公共 deadline', m.deadline > 0, `deadline=${m.deadline}`);
  const firstDeadline = m.deadline;
  check('时长 = 配置的 spFirst（30 秒）',
    Math.abs((firstDeadline - m.sched.now()) / 1000 - DATA.config.timers.spFirst) < 2,
    `约 ${Math.round((firstDeadline - m.sched.now()) / 1000)} 秒`);

  // 让一个人选一张卡：选卡会 _applyCard → startSpTurn → _concurrentSpStep
  const pickerId = s.order.find((pid) => s.picks[pid] == null);
  const avail = s.cards.filter((c) => m.spCardAvailable(c, m.players.get(pickerId))).map((c) => c.idx);
  const before = m.deadline;
  m.handle(pickerId, { t: 'g.choice', idx: avail[0] });
  const after = m.deadline;

  console.log('\n=== 有人选卡之后（这是 bug 触发点）===\n');
  check('该玩家已选上', s.picks[pickerId] != null);
  check('★ 公共 deadline 仍然存在（没被清零）', after > 0, `before=${before} after=${after}`);
  check('★ deadline 没有被重置（公共计时不因选卡重算）', after === before,
    '选卡不应该改变公共倒计时');

  // 再让第二个人选，确认持续保持
  const secondId = s.order.find((pid) => s.picks[pid] == null);
  const avail2 = s.cards.filter((c) => m.spCardAvailable(c, m.players.get(secondId))).map((c) => c.idx);
  m.handle(secondId, { t: 'g.choice', idx: avail2[0] });
  check('★ 第二个人选完后 deadline 依然不变', m.deadline === before, `after2=${m.deadline}`);

  console.log('\n=== 全部选完才结束 ===\n');
  for (const pid of s.order) {
    if (s.picks[pid] != null) continue;
    const ps = m.players.get(pid);
    const a = s.cards.filter((c) => m.spCardAvailable(c, ps)).map((c) => c.idx);
    if (a.length) m.handle(pid, { t: 'g.choice', idx: a[0] });
  }
  check('都选完后阶段结束（deadline 归零）', m.deadline === 0, `deadline=${m.deadline}`);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
