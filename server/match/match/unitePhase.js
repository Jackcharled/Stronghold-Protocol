// server/match/match/unitePhase.js — Match methods: 联防 glue (the rules: server/match/unite.js) — the UNITE phase in
// both modes (the 联防 field from the helpers' carried state and the leakers' enemies), its end, and the leakers' live
// counts (_uniteLeft, user playtest #6 item 7; _uniteTick in the server-run mode).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { uniteBattleOpts, uniteSurvivors, planUniteRelay } from '../unite.js';
import { FieldRunner, timelineAt, uniteBillBounds } from '../fields.js';
import { uniteLeft } from '../../sim/spec.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from './common.js';
import { msg } from '../../../shared/i18n.js';
import { onStartUnite } from '../botEmotes.js';

export class MatchUnite {
  startUnite(plan) {
    if (this.capacityExperiment && !this.alivePlayers().length) { this.settle(null, null); return; }
    if (plan.uniteRound === 1) this._uniteRelay = { rounds: [], eligible: new Set() };
    if (plan.uniteRound && !this.clientCombat) this.battleId = `${this.battlePrefix}.${this.round}.${++this._battleSeq}.relay${plan.uniteRound}`;
    if (this.clientCombat) { this._startUniteClient(plan); return; }
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.uniteTimeLimit(plan);
    if (this.capacityExperiment && !(limit > 0)) { this.settle(plan, null); return; }
    const battle = this.newBattle(this._uniteOpts(plan, limit));
    this.fields = [{ fieldId: plan.uniteRound === 2 ? 'u:2' : 'u', kind: 'unite', players: plan.helpers.map((p) => p.playerId), battle, live: true }];
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人{extra}', { names: plan.helpers.map((p) => p.name).join('、'),
      extra: plan.totalBudget ? `（本段 ${plan.timeLimit} 游戏秒）` : '' }), FLOW_TICKER_PRIORITY);
    onStartUnite(this, plan); // an AI helper says "合作愉快" once on the open of a 联防 (enabled by default; SP_BOT_EMOTES=0 silences it)
    this._uniteLeftKey = null;
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE || this.unitePlan !== plan) return;
        this._finishUniteField(plan, runner.resultOf(this.fields[0]), this.fields[0]);
      },
    });
    this.runner.start();
  }

  /** Expanded rooms get a 300-game-second budget; a viable relay splits it into 150 + 150. */
  uniteTimeLimit(plan) {
    const base = this.wave ? this.wave.timeLimit : 60;
    if (!this.capacityExperiment) return base;
    if (!this._uniteBudget) {
      // 判断「有没有可能接力」时看 plan.relayCandidates，**不能**用 uniteRelayHelpers()：
      // 后者依赖 m.lastResults（上一轮每个人的战果），而这里是在**本段开始之前**分配预算的，
      // 那时 lastResults 还没更新，于是它恒返回 []，8 人房也永远拿不到 150+150 的分段。
      // relayCandidates 已经由 planUnite() 按本轮 results 筛过（≥8 人 + 未被选为 helper + 完美），
      // 正是「有没有富余的完美玩家可以再来一波」的正确判据。
      const relayPossible = plan.uniteRound === 1
        && Array.isArray(plan.relayCandidates) && plan.relayCandidates.length > 0;
      this._uniteBudget = {
        total: 300,
        remaining: 300,
        allocations: relayPossible ? [150, 150] : [300],
      };
    }
    const budget = this._uniteBudget;
    plan.totalBudget = budget.total;
    plan.remainingBudget = budget.remaining;
    plan.gameSpeed = this.gameSpeed;
    plan.timeLimit = Math.min(budget.remaining, budget.allocations[plan.uniteRound === 2 ? 1 : 0] ?? 0);
    plan.budgetSpent = 0;
    return plan.timeLimit;
  }

  _consumeUniteBudget(plan, res, field) {
    if (!this.capacityExperiment || !this._uniteBudget || this.disposed || this.ended
      || this.phase !== PHASE.UNITE || this.unitePlan !== plan || !this.fields.includes(field)
      || !field.battle?.finished) return;
    const time = Number.isFinite(res?.time) ? res.time : Number(field.battle?.time) || 0;
    const spent = Math.min(plan.timeLimit, Math.max(plan.budgetSpent, time, 0));
    this._uniteBudget.remaining = Math.max(0, this._uniteBudget.remaining - (spent - plan.budgetSpent));
    plan.budgetSpent = spent;
  }

  /** Archive one field; on an expanded room start the relay or settle once. */
  _finishUniteField(plan, res, field) {
    if (this.disposed || this.ended || this.phase !== PHASE.UNITE || this.unitePlan !== plan
      || !this.fields.includes(field) || field.uniteCompleted) return;
    field.uniteCompleted = true;
    this._consumeUniteBudget(plan, res, field);
    this._collectSimErrors(field, res);
    field.live = false;
    this.deadline = 0;
    if (this._uniteRelay && plan.uniteRound) {
      const survivors = res && !res.synthetic ? uniteSurvivors(plan, res) : new Map(plan.notReentered);
      if (!res || res.synthetic) for (const l of plan.leaked) {
        survivors.set(l.sourcePlayerId, (survivors.get(l.sourcePlayerId) || 0) + 1);
      }
      const eligible = this._revivalHelpers(plan, res);
      for (const pid of eligible) {
        const pp = res?.perPlayer?.[pid];
        if (pp && pp.perfect !== false && !(pp.leaked || []).some((l) => l && l.counted !== false)) this._uniteRelay.eligible.add(pid);
      }
      this._uniteRelay.rounds.push({ plan, result: res, survivors });
    }
    this.markPublic();
    this.later(this.scaled(DELAYS.COMBAT_END), () => {
      if (this.phase !== PHASE.UNITE || this.unitePlan !== plan || !this.fields.includes(field) || field.uniteReleased) return;
      field.uniteReleased = true;
      const next = this.capacityExperiment && !(Math.min(this._uniteBudget.remaining, this._uniteBudget.allocations[1] ?? 0) > 0) ? null
        : planUniteRelay(this, plan, res, field.battle?.opts?.spawns);
      if (next) {
        this.runner?.stop();
        this.runner = null;
        this._stopClientCombat();
        this.startUnite(next);
      } else this.settle(plan, res);
    });
  }

  /**
   * Battle options of the 联防 field (helpers' carried end state, the leakers' enemies) on the round's battlefield, its
   * terrain, crates, water, devices and runes included (unite.js header; the owner's decision of 2026-10-07 — 0.2.0's
   * escaped-level map is withdrawn). The field meta and the client-run spec carry the match stageId, so every viewer
   * draws the battlefield the boards stand on.
   */
  _uniteOpts(plan, limit) {
    const { wave, players } = uniteBattleOpts(this, plan, limit);
    return {
      seed: deriveSeed(this.seed, plan.uniteRound === 2 ? `u:${this.round}:2` : `u:${this.round}`),
      ...(plan.uniteRound ? { battleId: plan.battleId || this.battleId } : {}),
      kind: 'unite',
      modeId: this.modeId,
      round: this.round,
      stageId: this.stageId,
      rect: { ...GEO.UNITE_RECT },
      timeLimit: limit,
      players,
      spawns: this._sanitizeSpawns(wave.spawns),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: false, ...this.gd.dp },
      fieldId: plan.uniteRound === 2 ? 'u:2' : 'u',
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
    };
  }

  _startUniteClient(plan) {
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.uniteTimeLimit(plan);
    if (this.capacityExperiment && !(limit > 0)) { this.settle(plan, null); return; }
    const fieldId = plan.uniteRound === 2 ? 'u:2' : 'u';
    const f = this._ccField({ fieldId, kind: 'unite', players: plan.helpers.map((p) => p.playerId), opts: this._uniteOpts(plan, limit) });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    this._launch([f]);
    // helpers and everyone else (as observers, spectator seats included) simulate the same 联防 spec locally
    for (const ps of this._viewers()) {
      this.watchers.set(ps.playerId, fieldId);
      this._sendStart(ps.playerId, f, { watch: !f.players.includes(ps.playerId) });
    }
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人{extra}', { names: plan.helpers.map((p) => p.name).join('、'),
      extra: plan.totalBudget ? `（本段 ${plan.timeLimit} 游戏秒）` : '' }), FLOW_TICKER_PRIORITY);
  }

  _finishUniteClient() {
    if (this.phase !== PHASE.UNITE) return;
    const f = this.fields[0];
    const plan = this.unitePlan;
    this._stopClientCombat();
    this._finishUniteField(plan, f.result, f);
  }

  /**
   * 联防 (user playtest #6 item 7; PRTS Stronghold-Protocol/帮助 "防卫失败的玩家可通过上方信息栏确认自身所属敌人的剩余数量"): how many of
   * a leaker's enemies are still standing on the 联防 field — not spawned yet, alive, or through the objective again —
   * plus its leaks that could not re-enter: what settle() charges it (before the per-round cap) if the 联防 ended now.
   * It falls as the helpers strike them down; a split or a summon raises nothing (a 联防 field tags its runtime spawns
   * `uniteRuntime`, spawns.js — they never crossed the leaker's own goal, so they are neither billed nor shown here).
   * Live from the field (client run: the authority's b.progress `left`; server run: the headless timeline on the field
   * clock, or the streamed battle itself), clamped to what the escaped wave sent that leaker (fields.js uniteBillBounds:
   * keySourceCounts only — the same set settlement bills); exact once the field has its result (unite.js
   * uniteSurvivors; a synthetic result charges the own leaks, as settle()). null for anyone but a leaker of the running
   * 联防.
   * @returns {number|null}
   */
  _uniteLeft(ps) {
    const plan = this.unitePlan;
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    const f = this.fields.find((x) => x && x.kind === 'unite') || null;
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(plan, res).get(pid) || 0;
    const sent = plan.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        // the sample is [gt, killed, total, resolved(, left)]: a 联防 sample's `left` is its 5th element
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[4] && typeof sample[4] === 'object' ? sample[4] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) this._uniteBounds = { plan, bounds: uniteBillBounds(plan.leaked, this.gd) };
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    return standing + (plan.notReentered.get(pid) || 0);
  }

  /** Server-run 联防 (streaming mode): refresh m.public about once a game second when a leaker's count moved. */
  _uniteTick(runner) {
    const f = runner && runner.fields ? runner.fields[0] : null;
    if (!f || !f.battle || runner.ticks % 30 !== 0) return;
    let key = '';
    try { key = JSON.stringify(uniteLeft(f.battle)); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }
}
