// server/match/match/spDraft.js — Match methods: the 机变 draft (SP_DRAFT: turn order, timers, AI picks, the card applied
// by choices.js applyCard), the personal bounty choice of the Art 教鞭 (offerBountyChoice / pickPersonalChoice /
// autoPickPersonalChoice: held by the player inside PREP — no phase, no timer of its own) and the rolls the meta effects
// ask for — bounties (addBounty), item ids (rollItemId) and choices.json pools (rollPool).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { generateDraft, applyCard, bountyBattles, isMultiRoundBounty, bountyCard } from '../choices.js';
import { onPickCard } from '../botEmotes.js';
import { weightedPick } from '../waves.js';
import { OK, fail, DELAYS } from './common.js';

/** Cards of the personal choice (PRTS 卫戍协议：盟约 下半 §法术 教鞭: "于3个战术特训的悬赏任务中选择一项"). */
const PERSONAL_OFFER_SIZE = 3;

export class MatchSpDraft {
  enterSpDraft() {
    const draft = generateDraft(this.gd, this.rngDraft, this.round, { stageId: this.stageId, bondAvailable: (bondId) => this.bondLive(bondId), itemAvailable: id => this.itemPool.canGain(id) });
    const alive = this.alivePlayers();
    if (!draft || !alive.length) { this.beforePrepOffers(); return; }
    this.phase = PHASE.SP_DRAFT;
    let order = alive.map((p) => p.playerId);
    if (!this.isSolo) this.rngDraft.shuffle(order);
    // 「AI 队友最后选择」 (GitHub #338): humans before AI seats, after the same shuffle (MatchPhases.humansFirst)
    order = this.humansFirst(order);
    // untimed: solo and any single-human match (soloUntimed); the co-op order / 6 cards stay
    const untimed = this.soloUntimed;
    // 5–20 人大厅：所有人同时各选一张，整段共用一个倒计时（原来的实现，升级上游时被丢掉了）
    const concurrent = this.concurrentDraft();
    this.sp = { ...draft, order, idx: 0, picks: {}, taken: {}, untimed, turnDeadline: 0, ...(concurrent ? { concurrent: true } : {}) };
    this.setDeadline(0);
    this.startSpTurn();
    this.markPublic();
  }

  spTurn() {
    const s = this.sp;
    if (!s || s.concurrent) return null;   // 并发草稿没有「当前这一位」
    return s.order[s.idx] ?? null;
  }

  /** Whether `ps` still has a card to pick in a concurrent draft. */
  spPending(ps) {
    const s = this.sp;
    return !!s && !!ps && ps.alive && s.picks[ps.playerId] == null && s.cards.some((c) => this.spCardAvailable(c, ps));
  }

  /**
   * 这张卡能不能选。
   *
   * `this.capacityExperiment`（5–20 人大厅）时**不判重**：多人局里每人独立卡池，
   * 允许多人悬赏同一个目标。以前这里是 `taken[idx] == null` 一刀切，
   * 大房间也强制不重复 —— 玩家反馈的「5–20 的悬赏决策不能重复选择」正是这个。
   * 普通 4 人局仍按 队友已选 的规则走。
   *
   * @param {any} card @param {any} [player] 谁在选（物品类卡按这个人的卡池判断）
   */
  spCardAvailable(card, player = null) {
    if (!card) return false;
    // 5–20 人大厅不判重（每人独立卡池，允许多人悬赏同一个目标）；
    // 普通 4 人局仍按「队友已选」的规则走。
    if (!this.capacityExperiment && this.sp?.taken[card.idx] != null) return false;
    return card.kind !== 'item' || this.spItemAvailable(card.id, player);
  }

  /**
   * 这张物品卡对 `player` 还可获得吗（不掉人头就按全队）。
   *
   * 5–20 人房「独立卡池」(disableSharedPool) 下**每人有自己的卡池**：
   * 必须用 `itemPoolFor(player)` 判断，而不是全队共用的 `this.itemPool` ——
   * 否则 A 拿过的东西会挡住 B，独立卡池等于没生效。
   * @param {any} id @param {any} [player]
   */
  spItemAvailable(id, player = null) {
    if (player) return this.itemPoolFor(player).canGain(id);
    return this.alivePlayers().some((p) => this.itemPoolFor(p).canGain(id));
  }

  startSpTurn() {
    const s = this.sp;
    if (s.concurrent) { this._concurrentSpStep(); return; }
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    while (s.idx < s.order.length) { // loop-cap: draft order
      const ps = this.players.get(s.order[s.idx]);
      if (ps && ps.alive && s.picks[ps.playerId] == null) break;
      s.idx++;
    }
    const available = s.cards.filter(c => this.spCardAvailable(c)).map(c => c.idx);
    if (s.idx >= s.order.length || !available.length) { this.setDeadline(0); this.later(0, () => this.finishSpDraft()); return; }
    const token = ++this._turnToken;
    if (!s.untimed) {
      const first = s.idx === 0;
      const secs = this.isSolo && this.gd.config.version?.rules?.soloTimed ? 150 : first ? this.gd.timer('spFirst') : this.gd.timer('spTurn');
      this.setDeadline(secs, () => {
        if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken) return;
        const ps = this.players.get(this.spTurn());
        if (!ps) return;
        const avail = s.cards.filter(c => this.spCardAvailable(c, ps)).map(c => c.idx);
        if (!avail.length) { this.finishSpDraft(); return; }
        this._applyCard(ps, avail[Math.floor(this.rngDraft() * avail.length)]);
      });
      s.turnDeadline = this.deadline;
    } else {
      this.setDeadline(0);
    }
    const cur = this.players.get(this.spTurn());
    if (cur && cur.botControlled) this.scheduleSpBot();
    this.markPublic();
  }

  /**
   * 5–20 人大厅的并发悬赏：**所有还活着的座位同时各选一张**，整段共用一个倒计时。
   * 这是本服 0.3.3 之前的实现，升级上游时被丢掉，大房间退回成「一个一个按顺序选」。
   */
  _concurrentSpStep() {
    const s = this.sp;
    if (!s || s.done) return;
    const deciding = s.order.map((pid) => this.players.get(pid)).filter((ps) => this.spPending(ps));
    // 都选完了（或没有可选的卡）：结束本阶段
    if (!deciding.length) {
      s.done = true;
      s.turnDeadline = 0;
      this.setDeadline(0);
      this.later(0, () => this.finishSpDraft());
      this.markPublic();
      return;
    }
    if (!s.armed) {
      s.armed = true;
      const token = ++this._turnToken;
      this.setDeadline(this.gd.timer('spFirst'), () => {
        if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken || this.sp !== s) return;
        // 超时：还没选的人各随机拿一张可选的
        for (const ps of deciding) {
          if (!this.spPending(ps)) continue;
          const avail = s.cards.filter((c) => this.spCardAvailable(c, ps)).map((c) => c.idx);
          if (avail.length) this._applyCard(ps, avail[Math.floor(this.rngDraft() * avail.length)]);
        }
        this._concurrentSpStep();
      });
      s.turnDeadline = this.deadline;
    } else {
      this.setDeadline(0);
    }
    // AI / 托管座位立刻出手；真人各选各的
    const humansDeciding = deciding.some((p) => p && !p.isBot);
    for (const ps of deciding) {
      if (ps.botControlled && (!this.aiPicksLast || !ps.isBot || !humansDeciding)) this.scheduleSpBot(ps);
    }
    this.markPublic();
  }

  scheduleSpBot(target = null) {
    const token = this._turnToken;
    const s = this.sp;
    // 并发草稿：每个座位只排一次
    if (s?.concurrent) {
      if (!target || s.botQueued?.has(target.playerId)) return;
      (s.botQueued ||= new Set()).add(target.playerId);
    }
    this.later(this.scaled(DELAYS.BOT_ACTION), () => {
      if (s?.concurrent) s.botQueued.delete(target.playerId);
      if (this.phase !== PHASE.SP_DRAFT || token !== this._turnToken || !this.sp || this.sp !== s) return;
      const ps = s.concurrent ? target : this.players.get(this.spTurn());
      if (!ps || !ps.botControlled || !this.spPending(ps)) return;
      const avail = s.cards.filter(c => this.spCardAvailable(c, ps)).map(c => c.idx);
      if (!avail.length) return;
      const fallback = () => this._applyCard(ps, this.bot.pickCard(this, ps, this.sp.cards, avail));
      if (this.bot.decide?.(this, ps, { kind: 'card',
        valid: () => this.phase === PHASE.SP_DRAFT && token === this._turnToken,
        complete: () => this.sp?.picks[ps.playerId] != null, fallback })) return;
      fallback();
    });
  }

  pickCard(ps, idx) {
    if (this.phase !== PHASE.SP_DRAFT || !this.sp) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (this.sp.picks[ps.playerId] != null) return fail(ERR.ALREADY);
    // 并发草稿里人人同时选，没有轮次限制
    if (!this.sp.concurrent && this.spTurn() !== ps.playerId) return fail(ERR.NOT_YOUR_TURN);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.sp.cards.length) return fail(ERR.BAD_TARGET);
    if (!this.spCardAvailable(this.sp.cards[idx], ps)) return fail(ERR.SOLD_OUT);
    this._applyCard(ps, idx);
    return OK;
  }

  _applyCard(ps, idx) {
    const s = this.sp;
    if (!s || s.picks[ps.playerId] != null || !this.spCardAvailable(s.cards[idx], ps)) return;
    // 5–20 人大厅里同一张卡可能被多人选中：每人拿一份独立的副本，
    // 否则 applyCard 会改到共享的卡片对象，后面选同一张的人就被前面的人影响了。
    const card = this.capacityExperiment ? structuredClone(s.cards[idx]) : s.cards[idx];
    if (!card) return;
    s.picks[ps.playerId] = idx;
    if (s.taken[idx] == null) s.taken[idx] = ps.playerId;
    try { applyCard(this, ps, card); } catch (e) { this.reportError(`applyCard ${card.id}`, e); }
    this.markPrivate(ps);
    this.markPublic();
    onPickCard(this, ps, card); // AI bots say "思考" when they take a bounty (enabled by default; SP_BOT_EMOTES=0 silences it)
    this.startSpTurn();
  }

  finishSpDraft() {
    if (this.phase !== PHASE.SP_DRAFT) return;
    this.cancel(this._turnTimer);
    this._turnTimer = null;
    this.beforePrepOffers();
  }

  /**
   * 教鞭 (content/items/meta.js, ctx.offerBountyChoice): the Art opens a PERSONAL choice (act2autochess choice event
   * `hunter_band_1`, choiceType PERSONAL_CHOOSE) between up to three of `candidates` — drawn once from the meta rng, kept in
   * `ps.personalChoice` (m.private only) until the owner confirms one with `g.choice { idx, choiceId }`. It lives inside
   * PREP: no phase of its own and no timer — the prep's deadline resolves it (prepDeadline), Ready is refused while it is
   * pending (PlayerPrep.setReady). Refused — before an rng draw or an id is used, so the Art stays in the hand — when it
   * is not the player's PREP, a choice is already open or no card is left to offer.
   * @param {import('../PlayerState.js').PlayerState} ps @param {any[]} candidates cards.bounty entries
   * @param {string} sourceItemId the Art
   */
  offerBountyChoice(ps, candidates, sourceItemId) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    if (ps.personalChoice) return fail(ERR.BAD_TARGET, '请先完成当前教鞭选择'); // i18n-ignore: developer error detail
    if (!candidates.length) return fail(ERR.BAD_TARGET, '当前没有可用的战术特训'); // i18n-ignore: developer error detail
    const cards = this.rngMeta.shuffle(candidates.slice()).slice(0, PERSONAL_OFFER_SIZE);
    ps.personalChoice = { id: `${this.battlePrefix}.choice.${this.nextUid()}`, round: this.round, sourceItemId, cards };
    ps.dirty();
    return OK;
  }

  /** g.choice { idx, choiceId }: the owner's pick of its open personal choice — the card becomes a bounty on its next battles. */
  pickPersonalChoice(ps, idx, choiceId) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (!ps.alive) return fail(ERR.ELIMINATED);
    if (ps.ready) return fail(ERR.WRONG_PHASE, 'ready');
    const pending = ps.personalChoice;
    if (!pending || pending.id !== choiceId || pending.round !== this.round) return fail(ERR.BAD_TARGET);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pending.cards.length) return fail(ERR.BAD_TARGET);
    if (!this.addBounty(ps, pending.cards[idx])) return fail(ERR.BAD_TARGET);
    ps.personalChoice = null;
    ps.dirty();
    return OK;
  }

  /**
   * The pick made for a player who did not make it. 'bot': an AI seat or a human under AI 托管 — the bounty scorer of the
   * 机变 draft (bot.js botPickCard: the expected pay minus the expected LP lost against the own board, the bots' seeded rng
   * only breaks ties); 'random': the prep's deadline and a seat the engine finishes by other means — one of the cards at
   * random from the meta rng, like a 机变 turn that runs out. Nothing pending: nothing happens, no rng draw.
   */
  autoPickPersonalChoice(ps, mode) {
    const pending = ps.personalChoice;
    if (!pending) return undefined;
    const indices = pending.cards.map((c, i) => i);
    const idx = mode === 'bot'
      ? this.bot.pickCard(this, ps, pending.cards.map((c) => bountyCard(this.gd, c)), indices)
      : this.rngMeta.pick(indices);
    return this.pickPersonalChoice(ps, idx, pending.id);
  }

  addBounty(ps, card) {
    if (!ps || !card || !this.gd.enemy(card.enemyKey)) return null;
    // a multi-round card lasts MULTI_ROUND_BOUNTY_BATTLES battles (choices.js; the user's call after playtest #6)
    const rounds = bountyBattles(card);
    const b = {
      id: `bounty:${this.nextUid()}`,
      card: { effectId: card.effectId ?? card.id ?? null, name: card.name ?? '悬赏', desc: card.desc ?? '', tier: card.tier ?? 1, coin: Math.max(0, Math.trunc(Number(card.coin) || 0)), payout: card.payout === 'perfect' ? 'perfect' : 'kill', rounds, multiRound: isMultiRoundBounty(card), enemyKey: card.enemyKey, count: Math.max(1, Math.min(20, Number.isInteger(card.count) ? card.count : 1)) }, // i18n-ignore: a data-less card's fallback name
      roundsLeft: rounds,
    };
    ps.bounties.push(b);
    ps.dirty();
    return b.id;
  }

  /** Random item id: a choices.json server pool ({ pool }), a tier, or ≤ maxTier shop-eligible items.
   * `also` (pool_equip_kathe: 突变细胞) joins the draw even though it is shopExcluded. The shop item slot does not
   * read it. `pick` still drops ids that `canGain` refuses, so an empty shop item stays out and an uncapped `also`
   * id can still be drawn. `exclude` removes ids before sampling (Cathy's match-long allowance / distinct choices). */
  rollItemId({ pool = null, tier = null, maxTier = 6, shopLevel = 6, exclude = [] } = {}) {
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof pool === 'string' && Object.hasOwn(pools, pool) ? pools[pool] : null;
    const rng = this.rngMeta;
    const pick = (ids, weights = null) => this.itemPool.pick(rng, ids.filter((id) => !exclude.includes(id)), weights);
    const tierList = (lo, hi) => { const out = []; for (let t = lo; t <= hi; t++) for (const id of this.gd.shopItemsByTier[t] || []) out.push(id); return out; };
    const also = p && Array.isArray(p.also) ? p.also.filter((id) => typeof id === 'string' && this.gd.item(id)) : [];
    const withAlso = (list) => {
      const out = list.slice();
      for (const id of also) if (!out.includes(id)) out.push(id);
      return out;
    };
    if (p && p.kind === 'equip') {
      if (Array.isArray(p.weighted) && p.weighted.length) {
        const pairs = p.weighted.filter((x) => Array.isArray(x) && this.gd.item(x[0]) && this.itemPool.canGain(x[0]));
        for (const id of also) if (!pairs.some((x) => x[0] === id)) pairs.push([id, 1]);
        return pick(pairs.map(x => x[0]), new Map(pairs));
      }
      if (Array.isArray(p.items) && p.items.length) {
        const items = p.items.filter((id) => this.gd.item(id));
        return pick(withAlso(items));
      }
      let list;
      if (Array.isArray(p.tiers) && p.tiers.length) list = p.tiers.flatMap((t) => this.gd.shopItemsByTier[t] || []);
      else list = tierList(1, p.maxTier === 'shopLevel' ? Math.max(1, Math.min(6, shopLevel)) : 6);
      return pick(withAlso(list));
    }
    const list = Number.isInteger(tier) ? tierList(tier, tier) : tierList(1, Math.max(1, Math.min(6, maxTier)));
    return pick(list);
  }

  /**
   * Roll a choices.json pool (ctx.rollPool). Equip pools → rollItemId. Chess pools: an `items` (uniform) or `weighted`
   * list — only chess with a free pool copy (or outside the pool) qualify — else a copy-weighted draw from the shared
   * pool filtered by `tier` / `minTier` / `maxTier` (number or 'shopLevel') / `bond`; `golden: true` yields the elite id.
   * `extra` (the drawing player's 自选 stock, player/diy.js diyStockEntries) joins that shared-pool draw, `chessOf` reads the
   * bonds (the player's data view: a slotted slot's operator) — 0.2.0 WE2.
   * @returns {{ kind: 'item'|'chess', id: string, golden?: boolean } | null}
   */
  rollPool(poolId, { shopLevel = 6, extra = null, chessOf = null, exclude = [] } = {}) {
    const pools = this.gd.choices.pools && typeof this.gd.choices.pools === 'object' ? this.gd.choices.pools : {};
    const p = typeof poolId === 'string' && Object.hasOwn(pools, poolId) ? pools[poolId] : null;
    if (!p || typeof p !== 'object') return null;
    const lvl = Math.max(1, Math.min(6, Number.isInteger(shopLevel) ? shopLevel : 6));
    if (p.kind === 'equip') {
      const id = this.rollItemId({ pool: poolId, shopLevel: lvl, exclude });
      return id ? { kind: 'item', id } : null;
    }
    if (p.kind !== 'chess') return null;
    const rng = this.rngMeta;
    const free = (id) => {
      if (typeof id !== 'string' || !this.gd.chess(id)) return false;
      const base = this.gd.baseIdOf(id);
      return !this.pool.has(base) || this.pool.left(base) > 0;
    };
    let id = null;
    if (Array.isArray(p.weighted) && p.weighted.length) {
      const pairs = p.weighted.filter((x) => Array.isArray(x) && free(x[0]));
      id = pairs.length ? weightedPick(rng, pairs) : null;
    } else if (Array.isArray(p.items) && p.items.length) {
      const list = p.items.filter(free);
      id = list.length ? list[Math.floor(rng() * list.length)] : null;
    } else {
      const maxTier = p.maxTier === 'shopLevel' ? lvl : Number.isInteger(p.maxTier) ? p.maxTier : 6;
      const minTier = Number.isInteger(p.minTier) ? p.minTier : 1;
      const bond = typeof p.bond === 'string' ? p.bond : null;
      const recOf = typeof chessOf === 'function' ? chessOf : (cid) => this.gd.chess(cid);
      id = this.pool.roll(rng, {
        tier: Number.isInteger(p.tier) ? p.tier : null,
        maxTier,
        filter: (cid, e) => e.tier >= minTier && (!bond || (Array.isArray(recOf(cid)?.bonds) && recOf(cid).bonds.includes(bond))),
        extra,
      });
    }
    if (!id) return null;
    const golden = !!p.golden;
    return { kind: 'chess', id: golden ? this.gd.goldenIdOf(id) || id : id, golden };
  }
}
