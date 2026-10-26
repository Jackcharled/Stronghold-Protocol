// server/match/match/phases.js — Match methods: the round flow up to the prep — INFO_CHECK, the strategy draft
// (BAND_DRAFT: one countdown of BAND_TURN_SECONDS per turn, 队友已选, the highlighted strategy on a timeout, skips),
// BATTLE_CHECK and ROUND_START (the round's enemies — a normal wave or the boss pairing — planned before the players'
// round start).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { buildNormalWave, buildBossWave } from '../waves.js';
import { pairPlayers, bossPairSalt } from '../finalAssault.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { OK, fail, DELAYS, BAND_TURN_SECONDS } from './common.js';

export class MatchPhases {
  enterInfoCheck() {
    this.phase = PHASE.INFO_CHECK;
    for (const ps of this.order) if (ps.botControlled) ps.infoReady = true;
    // solo: no time limit (the player confirms); co-op: the official 25 s guard
    this.setDeadline(this.soloUntimed ? 0 : this.gd.timer('infoCheck'), () => this.enterBandDraft());
    this.markPublic();
    for (const ps of this.order) this.markPrivate(ps);
    this.flush(true);
    this.maybeEndInfo();
  }

  maybeEndInfo() {
    if (this.phase !== PHASE.INFO_CHECK || this.setupVote || this._infoAdvanceTimer) return;
    if (this.order.every((p) => p.isBot || p.left || p.infoReady)) {
      this.setDeadline(0);
      this._infoAdvanceTimer = this.later(0, () => {
        this._infoAdvanceTimer = null;
        if (this.phase === PHASE.INFO_CHECK && !this.setupVote) this.enterBandDraft();
      });
    }
  }

  /**
   * The strategy draft (user playtest #4 item 4): ONE countdown — every turn has the same clock, BAND_TURN_SECONDS, and
   * m.public.deadline is the current turn's end (= draft.turnDeadline; the step header and the turn indicator show the
   * same number). No separate step cap: the turns bound the step (≤ (seats + skips) × turn). AI seats pick at once. A
   * turn that runs out takes the strategy the player has highlighted (g.bandFocus) while it is free, else the default
   * (timeoutBand). Solo, and any single-human match (soloUntimed): untimed. Solo also keeps seat order and has no skip.
   */
  enterBandDraft() {
    if (this.phase !== PHASE.INFO_CHECK) return;
    this.phase = PHASE.BAND_DRAFT;
    // The opening is settled, so no reroll cooldown outlives this phase.
    this._rerollStartAt.clear();
    let order = this.order.map((p) => p.playerId);
    if (!this.isSolo) this.rngDraft.shuffle(order);
    order = this.humansFirst(order);
    // 并发草稿（5–20 人大厅）：所有人同时选一次，没有「跳过」这个动作
    const concurrent = this.concurrentDraft();
    const skips = this.isSolo || concurrent ? 0 : this.gd.bandDraft.skipsPerPlayer;
    const untimed = this.soloUntimed;
    this.draft = {
      order, idx: 0, picks: {}, skipsLeft: Object.fromEntries(order.map((pid) => [pid, skips])), untimed, turnDeadline: 0,
      /** playerId → the strategy highlighted in the draft screen (g.bandFocus) */
      focus: new Map(),
      ...(concurrent ? { concurrent: true } : {}),
    };
    this.setDeadline(0);
    this.startDraftTurn();
    this.markPublic();
  }

  /**
   * The co-op room option 「AI 队友最后选择」 (this.aiPicksLast, GitHub #338): every human seat before every AI seat, each
   * group in the order the draft drew (a stable partition applied AFTER the shuffle — no extra random draw: the order
   * with the option off is unchanged, and with it on every random stream stands where it would without it; only the
   * picks made in the new order can differ). A human is any seat that is not an AI seat (room.addBot): under AI 托管,
   * disconnected or departed it still counts as a human. Used by the strategy draft and the 机变 draft
   * (MatchSpDraft.enterSpDraft).
   * @param {string[]} order playerIds in drawn order
   * @returns {string[]}
   */
  humansFirst(order) {
    if (!this.aiPicksLast) return order;
    const bot = (pid) => !!this.players.get(pid)?.isBot;
    return [...order.filter((pid) => !bot(pid)), ...order.filter(bot)];
  }

  draftTurn() {
    const d = this.draft;
    if (!d || d.concurrent) return null;   // 并发草稿没有「当前这一位」
    return d.order[d.idx] ?? null;
  }

  /** Real ms of one strategy-draft turn (BAND_TURN_SECONDS × timerScale). */
  bandTurnMs() { return this.scaled(BAND_TURN_SECONDS * 1000); }

  startDraftTurn() {
    const d = this.draft;
    if (d.concurrent) { this._concurrentBandStep(); return; }
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    if (this.test) this.setDeadline(0);
    while (d.idx < d.order.length && d.picks[d.order[d.idx]]) d.idx++; // loop-cap: draft order
    if (d.idx >= d.order.length) {
      d.turnDeadline = 0;
      this.deadline = 0;
      this.later(0, () => this.finishBandDraft(false));
      return;
    }
    const token = ++this._turnToken;
    if (!d.untimed) {
      const ms = this.bandTurnMs();
      d.turnDeadline = this.sched.now() + ms;
      // the step's countdown IS the turn's (one number everywhere)
      this.deadline = d.turnDeadline;
      const expire = () => {
        if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken) return;
        const pid = this.draftTurn();
        if (pid) this._applyBand(this.players.get(pid), this.timeoutBand(pid));
      };
      if (this.test) { this.setDeadline(ms / 1000 / (this.timerScale || 1), expire); d.turnDeadline = this.deadline; }
      else this._turnTimer = this.later(ms, expire);
    } else {
      d.turnDeadline = 0;
      this.deadline = 0;
    }
    const cur = this.players.get(this.draftTurn());
    if (cur && cur.botControlled) this.scheduleBandBot();
    this.markPublic();
  }

  /**
   * 5–20 人大厅的并发草稿：**所有座位同时各选一次**，整个阶段共用一个倒计时。
   *
   * 这是本服 0.3.3 之前的实现，升级上游时被整段丢掉（`Match.concurrentDraft()` 和
   * `views.js` 的 `d.concurrent` 都还在，只有这里的执行逻辑没了），
   * 于是大房间退回成「一个一个按顺序选」——玩家反馈的正是这个。
   */
  _concurrentBandStep() {
    const d = this.draft;
    if (d.done) return;
    // 所有人都选完了：结束本阶段
    if (d.order.every((pid) => d.picks[pid])) {
      d.done = true;
      this.cancel(this._turnTimer);
      this._turnTimer = null;
      d.turnDeadline = 0;
      this.setDeadline(0);
      this.later(0, () => this.finishBandDraft(false));
      this.markPublic();
      return;
    }
    // 第一次进入：起一个覆盖整个阶段的倒计时
    if (!d.armed) {
      d.armed = true;
      const token = ++this._turnToken;
      if (!d.untimed) {
        const ms = this.bandTurnMs();
        d.turnDeadline = this.sched.now() + ms;
        this.deadline = d.turnDeadline;
        // 超时：所有还没选的人各自按 timeoutBand 兜底（高亮的策略优先，否则默认且尽量不重复）
        const expire = () => {
          if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken || this.draft !== d) return;
          for (const pid of d.order) if (!d.picks[pid] && this.players.get(pid)) this._applyBand(this.players.get(pid), this.timeoutBand(pid));
        };
        if (this.test) { this.setDeadline(ms / 1000 / (this.timerScale || 1), expire); d.turnDeadline = this.deadline; }
        else this._turnTimer = this.later(ms, expire);
      } else {
        d.turnDeadline = 0;
        this.setDeadline(0);
      }
    }
    // 让还在等的 AI / 托管座位立刻出手（真人不受影响，各选各的）
    const deciding = d.order.filter((pid) => !d.picks[pid]).map((pid) => this.players.get(pid));
    const humansDeciding = deciding.some((p) => p && !p.isBot);
    for (const ps of deciding) {
      if (ps && ps.botControlled && (!this.aiPicksLast || !ps.isBot || !humansDeciding)) this.scheduleBandBot(ps);
    }
    this.markPublic();
  }

  /** An AI seat's (or an AI 托管 seat's) turn: it picks at once (user playtest #4 item 4 — nobody waits on the AI). */
  scheduleBandBot(target = null) {
    const token = this._turnToken;
    const d = this.draft;
    // 并发草稿：每个座位只排一次（避免重复排队）
    if (d?.concurrent) {
      if (!target || d.botQueued?.has(target.playerId)) return;
      (d.botQueued ||= new Set()).add(target.playerId);
    }
    this.later(0, () => {
      if (d?.concurrent) d.botQueued.delete(target.playerId);
      if (this.phase !== PHASE.BAND_DRAFT || token !== this._turnToken || this.draft !== d) return;
      const ps = d.concurrent ? target : this.players.get(this.draftTurn());
      if (!ps || !ps.botControlled) return;
      if (d.picks[ps.playerId]) return;
      const fallback = () => {
        // a strategy a teammate already took is not selectable (队友已选): the bot re-draws, else the first free one.
        // 「允许重复选择策略」开着时 bandTaken 恒为 false，AI 就按自己的意愿挑（可能与人重复）—— 与本服原始设计一致。
        let id = this.bot.pickBand(this, ps);
        for (let k = 0; k < 8 && this.bandTaken(id, ps.playerId); k++) id = this.bot.pickBand(this, ps);
        if (this.bandTaken(id, ps.playerId)) id = this.gd.bandIds().find((b) => !this.bandTaken(b, ps.playerId)) || id;
        this._applyBand(ps, id, { dedupe: true });
      };
      if (this.bot.decide?.(this, ps, { kind: 'band',
        valid: () => this.phase === PHASE.BAND_DRAFT && token === this._turnToken,
        complete: () => token !== this._turnToken || !!this.draft?.picks[ps.playerId], fallback })) return;
      fallback();
    });
  }

  /**
   * Whether `bandId` was already picked by another player of this draft. Research 09 §5 / DESIGN §14 corrections:
   * the strategy draft marks a teammate's pick as 队友已选 and it cannot be chosen again (co-op). The automatic
   * assignments — a turn that runs out and a departing seat — obey the same rule: see timeoutBand / defaultBand.
   *
   * 实验选项「允许重复选择策略」(allowRepeat，5–20 人大厅) 打开后**整支队伍都不再判重**：
   * 玩家可以主动选别人已拿过的盟约，AI 也照常按自己的意愿挑（可能与人重复）。
   * 这是本服原始设计（0.3.3 升级时 `_concurrentBandStep` 那套并发草稿连同本行一起被丢掉，
   * 导致开关只剩「下发给前端」一个作用，实际选的时候仍被拦成「队友已选」）。
   */
  bandTaken(bandId, playerId) {
    if (this.allowRepeat) return false;
    const picks = this.draft?.picks || {};
    for (const [pid, id] of Object.entries(picks)) if (pid !== playerId && id === bandId) return true;
    return false;
  }

  /**
   * The strategy an automatic assignment gives `playerId` (a departing seat; a timed-out turn without a usable
   * highlight, timeoutBand): the official default 「华法琳」 (bandDraft.timeoutBandId) while no teammate holds it, else the
   * first strategy of the mode (sortId order, gd.bandIds) that nobody else picked — never a duplicate (队友已选; the
   * client shows the same choice: public/js/screens/bandDraft.js timeoutBand). Solo drafts have no teammates, so it is
   * always the default.
   * @param {string} playerId
   */
  defaultBand(playerId) {
    const def = this.gd.bandDraft.timeoutBandId;
    if (!this.bandTaken(def, playerId)) return def;
    return this.gd.bandIds().find((b) => !this.bandTaken(b, playerId)) || def;
  }

  /**
   * What a turn that runs out assigns (user playtest #4 item 4): the strategy the player has highlighted in the draft
   * screen (g.bandFocus — the detail pane's band, the one 确认选择 would take) while it is allowed and no teammate holds
   * it, else defaultBand.
   * @param {string} playerId
   */
  timeoutBand(playerId) {
    const f = this.draft && this.draft.focus instanceof Map ? this.draft.focus.get(playerId) : null;
    // 玩家高亮的这个就是他想要的：allowRepeat 下允许它和队友重复（不算「自动」），
    // 没高亮才退到 defaultBand，那里才会去重。
    if (typeof f === 'string' && this.gd.bandAllowed(f) && !this.bandTaken(f, playerId)) return f;
    return this.defaultBand(playerId);
  }

  /**
   * g.bandFocus { bandId? }: the strategy the player highlights in the draft screen (any time before its pick; also
   * while waiting for its turn). A missing / null bandId clears it. Only a timed-out turn reads it (timeoutBand).
   */
  bandFocus(ps, bandId) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    const d = this.draft;
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    if (!(d.focus instanceof Map)) d.focus = new Map();
    if (bandId == null) { d.focus.delete(ps.playerId); return OK; }
    if (typeof bandId !== 'string' || !this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
    d.focus.set(ps.playerId, bandId);
    return OK;
  }

  pickBand(ps, bandId) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    if (this.draft.picks[ps.playerId]) return fail(ERR.ALREADY);
    // 并发草稿里人人都是「当前位」，没有轮次限制
    if (!this.draft.concurrent && this.draftTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (typeof bandId !== 'string' || !this.gd.bandAllowed(bandId)) return fail(ERR.BAD_TARGET);
    if (this.bandTaken(bandId, ps.playerId)) return fail(ERR.BAD_TARGET, '队友已选'); // i18n-ignore: developer detail (players see ERR_TEXT)
    this._applyBand(ps, bandId);
    return OK;
  }

  _applyBand(ps, bandId, { dedupe = false } = {}) {
    const d = this.draft;
    if (!d || !ps || d.picks[ps.playerId]) return;
    let id = this.gd.bandAllowed(bandId) ? bandId : this.defaultBand(ps.playerId);
    // dedupe 只出现在自动分配路径上（超时 / 掉线托管）：避开队友已选的，给玩家一个有区分度的兜底。
    // allowRepeat 打开时 bandTaken 恒为 false，所以这里自然不生效。
    if (dedupe && this.bandTaken(id, ps.playerId)) id = this.gd.bandIds().find((b) => !this.bandTaken(b, ps.playerId)) || id;
    d.picks[ps.playerId] = id;
    ps.bandId = id;
    ps.lp = this.gd.startLp(id);
    this.markPrivate(ps);
    this.markPublic();
    this.startDraftTurn();
  }

  skipBand(ps) {
    if (this.phase !== PHASE.BAND_DRAFT || !this.draft) return fail(ERR.WRONG_PHASE);
    const d = this.draft;
    if (this.isSolo) return fail(ERR.WRONG_PHASE, 'no skip in solo');
    if (d.picks[ps.playerId]) return fail(ERR.ALREADY);
    // 并发草稿没有「跳过」：没有人排在后面等你让位
    if (d.concurrent) return fail(ERR.WRONG_PHASE, 'no skip in a concurrent draft');
    if (this.draftTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!(d.skipsLeft[ps.playerId] > 0)) return fail(ERR.ALREADY, 'no skip left');
    if (d.order.length - d.idx <= 1) return fail(ERR.BAD_TARGET, 'nobody to pass to');
    d.skipsLeft[ps.playerId]--;
    d.order.splice(d.idx, 1);
    // the skipper goes to the end; with 「AI 队友最后选择」 to the end of the humans still to pick — behind them, ahead of
    // the AI seats — and to the very end only when no other human is left to pass to [ASSUMED: the option's intent,
    // humans before AI, kept through a skip; no source, a remake option]
    let at = d.order.length;
    if (this.aiPicksLast) {
      for (let j = d.order.length - 1; j >= d.idx; j--) {
        if (!this.players.get(d.order[j])?.isBot) { at = j + 1; break; }
      }
    }
    d.order.splice(at, 0, ps.playerId);
    this.startDraftTurn();
    return OK;
  }

  finishBandDraft(timeout) {
    if (this.phase !== PHASE.BAND_DRAFT) return;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    for (const ps of this.order) {
      if (!this.draft.picks[ps.playerId]) {
        // one after another in seat order, so each default sees the ones assigned before it (no duplicates)
        const id = this.defaultBand(ps.playerId);
        this.draft.picks[ps.playerId] = id;
        ps.bandId = id;
        ps.lp = this.gd.startLp(id);
      }
      this.markPrivate(ps);
    }
    void timeout;
    this.enterBattleCheck();
  }

  enterBattleCheck() {
    this.phase = PHASE.BATTLE_CHECK;
    this.setDeadline(this.gd.timer('battleCheck'), () => this.afterBattleCheck(), { silent: this.soloUntimed });
    this.markPublic();
  }

  /**
   * BATTLE_CHECK is over: R1 is about to begin. A plugin window declared at `battleCheck` for this round opens here —
   * "before the round begins", the host's own step first (docs/PLUGINS.md §10b) — and holds R1 back until it closes; a
   * content set without a window continues exactly as before (`openOfferWindow` returns before it touches anything).
   */
  afterBattleCheck() {
    this.startRound(1);
  }

  startRound(r, afterStart = null) {
    // Every round, including boss rounds. [ASSUMED] Expire nonblocking windows at the next round.
    for (const w of this.offerWin) this._closeOffer(w);
    this.offersDispose(); // A test-console round jump must discard the older continuation too.
    const step = () => { this._startRoundAfterOffers(r); afterStart?.(); };
    if (this.openOfferWindow('battleCheck', r) !== 'open') { step(); return; }
    this._offerResume = step;
  }

  _startRoundAfterOffers(r) {
    this.phase = PHASE.ROUND_START;
    this.round = r;
    this.fields = [];
    this.watchers.clear();
    this.unitePlan = null;
    this.uniteResultView = null;
    this.sp = null;
    this.wave = null;
    this.bossWaves = null;
    this.bossPairsRound = null;
    const alive = this.alivePlayers();
    // the round's enemies (shared composition, generated now so the prep preview is exact). Planned BEFORE the players'
    // round start: its recompute() checks the board on the field the player deploys on this round (deployFieldOf reads
    // the boss pairing), so R14 → R15 never re-checks a boss-field board against the normal field (user playtest #5
    // item 7). rngWaves is used only here, so the order leaves every random stream unchanged.
    const isBoss = r === this.gd.bossRound || r === this.gd.hiddenRound;
    if (isBoss) {
      this._planBossWaves();
    } else {
      this.wave = buildNormalWave(this.gd, this.rngWaves, this.factions, r);
    }
    for (const ps of alive) ps.startRound(r);
    for (const ps of alive) this.dispatch(ps, 'onRoundStart', { round: r });
    // an eliminated player's pending 信标 gift still goes to its teammate (effects flagged afterElimination; GitHub #86)
    for (const ps of this.order) {
      if (ps.alive) continue;
      try { this.dispatcher.dispatchEliminated(ps, 'onRoundStart', { round: r }); } catch (e) { this.reportError('dispatch onRoundStart (eliminated)', e); }
    }
    for (const ps of alive) ps.recompute();
    this.setDeadline(DELAYS.ROUND_START / 1000, () => this.afterRoundStart(), { silent: this.soloUntimed });
    this.markPublic();
    // eliminated humans and spectator seats scout the board of the player they follow through the round's prep, not
    // their own empty board (community report of 2026-10-06, item 56; MatchWatch._followScout)
    for (const ps of this._viewers()) this._followScout(ps);
  }

  /** The round's pairs and their templates, generated before the prep preview / board validation. */
  _planBossWaves() {
    const r = this.round;
    const hidden = r === this.gd.hiddenRound && r !== this.gd.bossRound;
    const bossId = hidden ? this.hiddenBossId : this.bossId;
    // Pairing uses an independent seeded draw, consuming no shop, wave, draft or battle randomness. The Hidden Core
    // draws its pairs and sides anew (GitHub #845: the official R15 of BV1VCXyBjEN1 p1 pairs 1-2 / 3-4 after an R14 of
    // 1-4 / 2-3; DESIGN §35.27, superseding §30.12's kept partners) from a stream of its own, so the Final Assault's
    // draw is unchanged; a player who changes half keeps the board (bossFieldPlacement mirrors it, the halves' deploy
    // maps are identical). Only the round's first plan draws anew: a re-plan after a departure in its round start, 机变
    // draft or prep (platform.js _quit) keeps the intact pairs and re-pairs the orphan, as the Final Assault does.
    const fresh = hidden && this.bossPairsRound !== r;
    const groups = pairPlayers(this.alivePlayers(), createRng(deriveSeed(this.seed, bossPairSalt(this.gd, r))), fresh ? null : this.bossPairs);
    this.bossPairs = groups.map(g => g.map(p => p.playerId));
    this.bossPairsRound = r;
    this.bossWaves = groups.map((g) => ({
      players: g.map((p) => p.playerId),
      wave: buildBossWave(this.gd, this.rngWaves, this.factions, r, { bossId, solo: this.isSolo || g.length === 1 }),
    }));
  }

  afterRoundStart() {
    if (this.gd.spRounds().includes(this.round)) this.enterSpDraft();
    else this.beforePrepOffers();
  }

  beforePrepOffers() {
    // The official round start and its draw/draft finish first; only entering prep waits.
    this.sp = null;
    const step = () => this.enterPrep();
    if (this.openOfferWindow('prep', this.round) !== 'open') { step(); return; }
    this._offerResume = step;
  }
}
