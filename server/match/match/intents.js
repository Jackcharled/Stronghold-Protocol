// server/match/match/intents.js — Match methods: the g.* / b.* intent router (_handle: the prep intents go to
// PlayerState, the drafts, watching, the pause and the battle reports to the match), emotes, AI 托管 (setAutoplay,
// kickBot) and g.unitStats (the stats the board's units start their next battle with: a preview battle, started, read
// and dropped).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { unitStatsEntry } from '../../../shared/protocol.js';
import { PHASE, ERR, EMOTES, EMOTE_COOLDOWN_MS, GEO } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { OK, fail } from './common.js';
import { onHumanEmote } from '../botEmotes.js';

export class MatchIntents {
  /** 消极游戏检测：连续 2 回合花钱（买/刷新/升级）但一次都没部署干员 → 踢出。 */
  _trackActivity(ps, msg) {
    if (!ps || ps.isBot) return;
    const round = Number(this.round) || 0;
    // 只在第 4 回合前判定（含第 4 回合）
    if (round > 4) { if (ps._act) { ps._act.strikes = 0; ps._act.idleStrikes = 0; } return; }
    let st = ps._act;
    if (!st || st.round !== round) {
      // 规则一：连续 2 回合花钱但不部署 → 消极游戏
      if (st && st.spend > 0 && st.place === 0) {
        st.strikes = (st.strikes || 0) + 1;
        if (st.strikes >= 2) {
          try { this.toast?.(ps, 'warn', '检测到连续 2 回合购买/刷新但未部署干员，你已被移出同盟（消极游戏）'); } catch { /* ignore */ }
          try { this.onIdleKick?.(ps.playerId, 'idle'); } catch { /* ignore */ }
        }
      } else if (st) {
        st.strikes = 0;
      }
      // 规则二：连续 3 回合既不购买也不部署（只点准备）→ 消极游戏
      if (st) {
        if (st.spend === 0 && st.place === 0) {
          st.idleStrikes = (st.idleStrikes || 0) + 1;
          if (st.idleStrikes >= 2) {
            try { this.toast?.(ps, 'warn', '检测到连续 2 回合未购买、未部署干员，你已被移出同盟（消极游戏）'); } catch { /* ignore */ }
            try { this.onIdleKick?.(ps.playerId, 'idle'); } catch { /* ignore */ }
            st.idleStrikes = 0;
          }
        } else {
          st.idleStrikes = 0;
        }
      }
      st = ps._act = { round, spend: 0, place: 0, strikes: st ? (st.strikes || 0) : 0, idleStrikes: (st && st.idleStrikes) || 0 };
    }
    const t = msg && msg.t;
    if (t === 'g.buy' || t === 'g.refresh' || t === 'g.levelUp') st.spend++;
    if (t === 'g.place' || t === 'g.move' || t === 'g.deploy' || t === 'g.swap') st.place++;
  }

  _handle(ps, msg) {
    try { this._trackActivity(ps, msg); } catch { /* ignore */ }
    switch (msg.t) {
      case 'g.infoReady':
        if (this.phase !== PHASE.INFO_CHECK) return fail(ERR.WRONG_PHASE);
        if (this.setupVote) return fail(ERR.WRONG_PHASE, 'setup reroll vote in progress');
        if ((msg.setupRevision ?? 0) !== this.setupRevision) return fail(ERR.BAD_TARGET, 'setup changed; confirm the current revision');
        if (!ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
        return OK;
      case 'g.rerollVote': return this.voteSetupReroll(ps, msg.voteId, msg.agree);
      case 'g.band': return this.pickBand(ps, msg.bandId);
      case 'g.bandSkip': return this.skipBand(ps);
      // the strategy highlighted in the draft screen (what a timed-out turn takes, timeoutBand)
      case 'g.bandFocus': return this.bandFocus(ps, msg.bandId ?? null);
      case 'g.buy': return ps.buy(msg.slot);
      case 'g.refresh': return ps.refresh();
      case 'g.freeze': return ps.freeze();
      case 'g.levelUp': return ps.levelUp();
      case 'g.sell': return ps.sell(msg.uid);
      // dir: the deploy wheel's facing (DESIGN §3; absent ⇒ PlayerState reads to.dir, then RIGHT)
      case 'g.move': return ps.move(msg.uid, msg.to, msg.dir);
      case 'g.equip': return ps.equip(msg.itemUid, msg.targetUid, msg.replaceUid ?? null);
      case 'g.art': return ps.useArt(msg.itemUid, msg.row, msg.col, msg.dir);
      case 'g.destroy': return ps.destroy(msg.uid);
      case 'g.unequip': return ps.unequip(msg.itemUid);
      case 'g.reward': return ps.pickReward(msg.idx);
      case 'g.choice': return msg.choiceId !== undefined
        ? this.pickPersonalChoice(ps, msg.idx, msg.choiceId)
        : this.pickCard(ps, msg.idx);
      // a plugin interaction window (PLUGIN API v2, docs/PLUGINS.md §10b): the window's own id, not a draft card —
      // the host applies the declared primitive, a plugin never reaches the match state itself
      case 'g.offer': return this.requestOffer(ps, msg.offerId, msg.idx, msg);
      case 'g.offerRefresh': return this.requestOfferRefresh(ps, msg.offerId, msg.idx, msg);
      case 'g.ready': return ps.setReady(!!msg.ready);
      case 'g.emote': return this.emote(ps, msg.id);
      // playerId: the player tapped (a shared field names two) — the watch preference (item 56)
      case 'g.watch': return this.watch(ps, msg.fieldId, msg.playerId ?? null);
      case 'g.autoplay': return this.setAutoplay(ps, !!msg.on);
      case 'g.pause': return this.setPause(ps, !!msg.on);
      // the stats the board's units start their next battle with (the detail card in prep, user playtest #4 item 7)
      case 'g.unitStats': return this.unitStats(ps, msg.seq ?? null);
      case 'g.leave': this.onLeave(ps.playerId); return OK;
      case 'g.test': return this.applyTestCommand(ps, msg);
      case 'b.progress': return this._onProgress(ps, msg);
      case 'b.result': return this._onResult(ps, msg);
      // the host's answer to a delegated bot layout rehearsal (DESIGN §14): a report, never an error — an unknown,
      // expired or foreign task is ignored (MatchRehearsal._onRehearsalResult)
      case 'b.rehearsalResult': this._onRehearsalResult(ps, msg); return OK;
      default: return fail(ERR.BAD_MSG);
    }
  }

  emote(ps, id) {
    if (!EMOTES.includes(id)) return fail(ERR.BAD_MSG, 'unknown emote');
    const now = this.sched.now();
    if (now - ps.lastEmoteAt < EMOTE_COOLDOWN_MS) return fail(ERR.RATE);
    ps.lastEmoteAt = now;
    this.broadcast({ t: 'm.emote', playerId: ps.playerId, id });
    // an AI teammate can react to a human's emote (enabled by default: server/match/botEmotes.js, SP_BOT_EMOTES=0 silences it)
    onHumanEmote(this, ps.playerId, id);
    return OK;
  }

  setAutoplay(ps, on) {
    if (ps.autoplay === on) return OK;
    ps.autoplay = on;
    this.markPublic();
    if (on) this.kickBot(ps);
    return OK;
  }

  /** Let the bot act for a (newly) bot-controlled seat in the current phase. */
  kickBot(ps) {
    if (!ps.botControlled || this.ended) return;
    this.offersChanged();
    if (this.phase === PHASE.INFO_CHECK && !ps.infoReady) { ps.infoReady = true; this.markPublic(); this.maybeEndInfo(); }
    else if (this.phase === PHASE.BAND_DRAFT && this.draftTurn() === ps.playerId) this.scheduleBandBot();
    else if (this.phase === PHASE.SP_DRAFT && this.spTurn() === ps.playerId) this.scheduleSpBot();
    else if (this.phase === PHASE.PREP && ps.alive && !ps.ready) this.scheduleBotPrep(ps, 0);
  }

  /**
   * g.unitStats { seq? } (user playtest #4 item 7: the detail card showed fixed record stats): the stats every unit of
   * the player's board will fight with at the start of its next battle — equipment, bonds and their layers, 特质, the
   * band and 机变 effects — computed exactly by the shared sim. The player's battle input after the onBattleStart meta
   * handlers (`ev.preview: true`, no enemies — those handlers must not change the match for a preview) builds a Battle
   * of the battle's options that is started (initial deployment + battleStart hooks), read and dropped: it is never
   * stepped: deployment skills contribute their initial stats but their timers do not advance. No SP / skill timer is
   * sent, and the real battle gets fresh units. Pushed to the player as `m.unitStats { seq, round, units }`
   * (units: shared/protocol.js unitStatsEntry, board operators and summons by uid); cached per input (a build costs
   * ≈ 0.3–0.7 ms). Prep phases only (ROUND_START, 机变, PREP); a battle's live stats come from the browser's own sim.
   * @param {PlayerState} ps @param {number|null} seq echoed (the client keeps the newest answer)
   */
  unitStats(ps, seq = null) {
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.phase !== PHASE.ROUND_START && this.phase !== PHASE.SP_DRAFT && this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    const units = this._unitStatsOf(ps);
    this.sendTo(ps.playerId, { t: 'm.unitStats', seq: Number.isInteger(seq) ? seq : null, round: this.round, units });
    return OK;
  }

  /** The start-of-battle stats of a player's board units (see unitStats); [] when the preview battle cannot be built. */
  _unitStatsOf(ps) {
    const input = ps.battleInput({ side: 'L', colOffset: 0 });
    const ev = { input, kind: 'normal', round: this.round, preview: true };
    this.dispatch(ps, 'onBattleStart', ev);
    const players = [ev.input && typeof ev.input === 'object' ? ev.input : input];
    let key = null;
    try { key = JSON.stringify([this.round, this.stageId, this.battleContent, players]); } catch { key = null; }
    if (!this._unitStatsCache) this._unitStatsCache = new WeakMap(); // PlayerState → { key, units } (the last preview)
    const cached = this._unitStatsCache.get(ps);
    if (key && cached && cached.key === key) return cached.units;
    const units = [];
    // the flags of the battle it previews: a normal round gains IN_BATTLE layers from its start (a <战斗开始时> layer gain
    // raises bond stats at t = 0 there too); the Final Assault / Hidden Core fight without (previewed as a normal field)
    const bossRound = this.round === this.gd.bossRound || this.round === this.gd.hiddenRound;
    const b = this.newBattle({
      seed: deriveSeed(this.seed, `preview:${this.round}:${ps.seat}`), kind: 'normal', modeId: this.modeId, round: this.round,
      stageId: this.stageId, rect: { ...GEO.NORMAL_RECT }, timeLimit: 60, players, spawns: [], routes: this.wave ? this.wave.routes : [],
      sharedBoss: null, flags: { layerGainsEnabled: !bossRound, ...this.gd.dp }, fieldId: `n:${ps.playerId}`, recordEvents: false,
    });
    try {
      if (typeof b.start === 'function') b.start();
      for (const u of Array.isArray(b.allyUnits) ? b.allyUnits : []) {
        if (u && Number.isInteger(u.uid) && (u.kind === 'op' || u.kind === 'token')) units.push(unitStatsEntry(u, u.s));
      }
    } catch (e) { this.reportError('unitStats', e); }
    this._unitStatsCache.set(ps, { key, units });
    return units;
  }
}
