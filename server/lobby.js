// server/lobby.js — rooms, seats, host, AI seats, ready/start, reconnect, and room → Match wiring
// (DESIGN §2, §6.1 LOBBY, §8.1). Implements the handler interface consumed by server/net.js.
//
// Rules (the choices where DESIGN is silent are marked ▸):
//   * Rooms are keyed by 4-letter codes from an unambiguous alphabet (no I/O, letters only). Join codes are
//     case-insensitive.
//   * 'solo' rooms hold exactly one human and never bots. 'coop' rooms have 4 seats (humans + AI bots).
//     Humans and bots take the lowest free seat index; seat indexes never compact.
//   * ▸ Being in a LOBBY room and sending room.create / room.join implicitly leaves it. While your room is
//     in a match, create/join of another room fails with ROOM_STARTED (send g.leave or room.leave first).
//   * room.create {mode, difficulty?, test?}: ▸ without a difficulty the room starts at DEFAULT_DIFFICULTY (标准) and the
//     host changes it in the room — the event's 联合模拟 creates the room first (research 06 §3.2), the starting
//     difficulty is not recorded [ASSUMED: 标准, the first one unlocked; the event room research 06 §3.2 describes shows
//     ♜ 标准模拟 in its footer pill]. The game's own lobby always sends the remembered one.
//   * Host-only: room.setDifficulty, room.setAiPicksLast, room.setSoloUnlimited, room.addBot, room.removeBot, room.kick,
//     room.start.
//     ▸ Changing the difficulty or the AI-picks-last option (co-op only) un-readies the other humans.
//     ▸ 「不限时」 (room.setSoloUnlimited { on }, DESIGN §35.23.10): a solo room of a version whose rules.soloTimed is
//       true, off by default. On, the match is built with opts.soloUnlimited (preparation and 机变 untimed — the existing
//       Match opt-out). room.state carries `soloUnlimited: true` only while it is on, so a default room.state stays
//       identical. A switch to a version whose solo is not timed clears it. A create that sends the key on a co-op room
//       or an untimed version is ignored.
//     ▸ room.start requires every other human to be connected and ready; the host's start counts as the host's
//     ready (the host may still toggle room.ready for display).
//   * room.kick {seat, playerId} (community report #17, owner approved): before the match only, the host removes another
//     human like an AI seat (an AI seat stays room.removeBot's; never the host itself). `playerId` names the player the
//     host confirmed: a seat that changed hands meanwhile (left, someone else joined) is refused with BAD_TARGET. The
//     seat is freed at once and the player gets `room.closed {reason:'kicked'}` — now, or on the next resume when
//     offline (with the result replay, as the grace timeout) —, so the reconnect token no longer leads back to the seat
//     (it stays the player's identity: net.js sessions belong to players, not seats). ▸ No ban: the player may join
//     again with the code.
//   * Host migration: when the host leaves (or is removed), the lowest-seat remaining human (connected
//     ones first) becomes host. A room without humans is disposed (bots never keep a room alive).
//   * Disconnect in LOBBY: the seat shows connected=false and is freed after `lobbyGraceMs` (60 s); a
//     session that comes back after that gets `room.closed {reason:'timeout'}`.
//     Disconnect in a match: the seat is kept and match.onDisconnect(playerId) is called.
//   * Reconnect: `hello` with a known token (reconnect window, 10 min, see net.js) rebinds the session;
//     the lobby then broadcasts room.state and, in a match, calls match.onReconnect(playerId).
//     Solo runs (下半: "休整期及机变阶段没有时间限制…24小时内随时返回", research 01 §1 / 06 §17): a session that drops
//     while its solo room's match runs stays resumable for the official `config.constants.singleReconnectTime`
//     (86400 s; option `soloReconnectWindowMs` overrides it) instead of the 10-minute window (net.js
//     session.resumeWindowMs, set at every disconnect). 第一期's constData has no singleReconnectTime, so that solo
//     uses the same 24 h figure as a carried-over convenience [ASSUMED] — not because the run is untimed (a 第一期 solo
//     is timed unless the room's 「不限时」 is on, §35.23.10). Only after that does expiry turn into
//     match.onLeave ('abandoned'). The extension outlives the match, so a run that ended meanwhile (e.g. a server-run
//     Final Assault) still shows its result on the player's return.
//     A repeated hello on a live connection is a full resync: room.state goes to the requester only
//     (broadcast only when the seat visibly changed, e.g. a rename in LOBBY); the heavy part (match.onReconnect,
//     or the result replay below) runs at most once per `resyncMinGapMs` per session — extra requests inside
//     that window coalesce into one deferred resync, so hello spam cannot amplify into ~15 KB per request.
//   * Result replay: the match's final m.public and each human's m.result are kept after the match ends. A
//     human who resyncs (resume after a drop, a reloaded tab, a repeated hello) while the room is back in LOBBY
//     gets room.state followed by those two frames again, until they act in the room (ready, difficulty, the
//     AI-picks-last option, AI seats, start), leave it, or a new match starts. A human removed by the lobby grace
//     gets them right after `room.closed {timeout}` on their next resume (Match.onReconnect cannot do this: the
//     lobby drops the match reference at onEnd and disposes it on the next macrotask).
//   * Per-network limits (internet clients only, see net.js clientAddress): at most `maxRoomsPerAddr` rooms
//     created from one network may exist at once and at most `maxMatchesPerAddr` matches started from one
//     network may run at once (room.create / room.start → ERR.RATE). Without them a socket loop could fill
//     `maxRooms` or keep hundreds of unattended matches simulating for the whole reconnect window.
//   * Permanent departure during a match (room.leave, g.leave, reconnect window expired): the seat is
//     marked departed (shown as connected=false), match.onLeave(playerId) is called, and the seat is freed
//     when the match ends. 'g.leave' is handled here and never reaches match.handle().
//   * All other 'g.*' messages go to room.match.handle(playerId, msg); its {ok}/{error} becomes the reply.
//   * Match lifecycle: room.start → new Match({...}) → room.state (inMatch=true) → match.start(). The match gets
//     `matchNo` = the room's match number (1, 2, …): with the seed it keeps battleIds unique across the room's
//     matches, so a late b.progress / b.result of the previous match is ignored by the next one (DESIGN §14).
//     onEnd(summary) → room back to LOBBY (departed seats freed, humans un-readied, disconnected humans
//     get the lobby grace), dispose() on the next macrotask. Players can start again.
//   * room.closed reasons: 'timeout' (removed after lobby grace), 'kicked' (room.kick, room.removeSpectator), 'empty' (a
//     spectator whose room lost its last player), 'shutdown' (server stopping).
//   * Operator loadout (DESIGN §16): room.loadout { entries } is checked strictly against the game data
//     (shared/protocol.js checkLoadout: known visible chess, a skill index legal for the normal AND the elite status, a
//     module of the elite or 'none'; any bad entry rejects the whole message, nothing is stored). ▸ It is stored on the
//     session (it follows the player into every room they create/join, and survives a resume) and on the seat; the
//     match receives seats[].loadout (bots: none — they fight with the defaults). ▸ Accepted any time: in a LOBBY room
//     (or outside a room) it simply replaces the stored one; while the room's match runs it is also handed to
//     match.setLoadout(playerId, loadout), which accepts it only during INFO_CHECK (the 干员调配 entry of the briefing)
//     and refuses it afterwards (WRONG_PHASE: the match's loadout is locked, the stored one applies to the next match).
//     ▸ Its `ops` (0.2.2: the per-operator 潜能 / 练度, shared/protocol.js checkLoadoutOps — an operator of the 干员调配
//     roster or the 自选 owned pool, strict like the entries) travel with it: session.ops / seat.ops / seats[].ops and
//     match.setLoadout(playerId, loadout, ops); a message without `ops` sets none (every operator 潜能 6, 精英2 Lv.60).
//   * Operator ownership (干员持有, 0.2.0 补位, owner's decision 2026-10-05): room.ownership { notOwned } — the base chess
//     ids the player marked as not owned — is checked leniently (shared/protocol.js checkNotOwned: anything that is not
//     a droppable NORMAL chess is dropped, never the whole list; only a malformed list is BAD_MSG) and stored on the
//     session and the seat like the loadout. The match receives seats[].notOwned when it starts (bots: none — they own
//     every operator) and keeps it for its whole length: the setting is out of match ("局外设置，下一局生效"), so while
//     the room's match runs a new list is only stored for the next match (ROOM_STARTED 'stored for the next match',
//     never handed to the match). A spectator's list stays on its session.
//   * 自选编队 (0.2.0 DIY, the owner's decisions of 2026-10-05): room.diy { picks } — the player's picks for the four DIY
//     slots ({ [slotBaseId]: { charId, skillIndex?, uniEquipId? } | null }) — is checked leniently (shared/protocol.js
//     checkDiyPicks against the game data and the kit registry, server/sim/content/kits/index.js KITTED_CHARS: an
//     illegal pick — an operator without a kit, another tier's prototype, a prototype off its locked skill, a second slot
//     of one owned operator, the same operator twice in a tier, an unknown slot / skill / module — is dropped, never the
//     whole roster; only malformed picks are BAD_MSG) and stored on the session and the seat exactly like the
//     not-owned list: the match receives seats[].diy when it starts (bots: none — they field no 自选 piece [ASSUMED]),
//     and a change while it runs is stored for the next match (ROOM_STARTED 'stored for the next match'). Every
//     `welcome` carries `diyKitted` (welcomeInfo): the operators a DIY slot may field, so the client's picker offers
//     exactly what the server accepts.
//   * 干员皮肤 (docs/SKINS.md): room.skins { skins } — `{ [charId]: skinId }`, the appearance each operator wears — is
//     a plain map of charIds to skinIds, at most SKIN_LIMITS.entries (256 [ASSUMED]); a bad shape is BAD_MSG and does
//     not clear the stored choice. A charId the room's content does not have is dropped (shared/protocol.js
//     checkSkinSelection). An unknown skinId can do nothing worse than fail to resolve in the client's spineEntry.
//     Stored on the session and the seat. Unlike
//     the settings above there is NO phase gate: a match receives seats[].skins when it starts AND takes a later change
//     at once (match.setSkins, any phase), because the choice is public — a teammate sees your model — and cosmetic.
//     The room's members see a seat's map as room.state seats[].skins (human seats with a non-empty map only, so a room
//     without skins sends what it sent before): the waiting room's 名片干员 seat cards wear the outfit of the operator
//     they show (the maintainer's decision 4 of 2026-10-21; the client picks that operator's entry — ui/seatArt.js
//     seatCardSkin — exactly as a match card reads Match.publicView().players[].skins). A changed map is broadcast while
//     the room waits; during a match its m.public carries it, and the room.state at the match's end. [ASSUMED] The whole
//     map rides in room.state, not one skinId per card: a seat without a pick shows an operator its clients choose by
//     player id (ui/seatArt.js seatOperator), which the server does not compute.
//   * 名片干员 (PR #643 split 6): room.card { charId } — the operator whose portrait fills the player's seat card in the
//     waiting room, '' for none — is kept only when it is a visible charId of the room's chess.json (another id, a hidden
//     preset, a stand-in body or a 自选-only operator: BAD_MSG, the stored one stays). Stored on the session (it follows the player into
//     the next room) and the seat; the room's members see it as room.state seats[].card (human seats with a card only,
//     so a room without one sends what it sent before). Checked again when the player takes a seat (humanSeat): a card
//     the room's content does not have (a plugin operator picked in a room with gameplay plugins) is left off that seat
//     — the session keeps it, and the player's page sends the card it can show for the room (ui/loadoutSync.js
//     installCardSync). Cosmetic: no phase gate, never handed to a match. [ASSUMED] A card picked in this browser stands
//     in for the event's account assistant (名片形象, display_meta_table avatarTypeData ASSISTANT); the client's default
//     for a seat without one is ui/seatArt.js'.
//   * Content identity (DESIGN §32, the plugin system's first step): the lobby is given the server's vanilla content
//     (server/plugins/identity.js; none in unit tests that build a Lobby without it). Every `welcome` carries
//     `content: { vanilla: <cs> }` — and `plugins: <n>` when this server has n > 0 unofficial plugins (every class but a
//     language: the title screen's 「本服务器安装了 N 个插件」; a page fetches the catalogue only when n > 0 and something
//     needs it, so a server without plugins sends exactly what it sent before) —, every room's `room.state.content` is
//     `{ cs, vanilla: true, plugins: [] }` while it has
//     no plugin, and the match receives `cs`, which it copies into every BattleSpec (the sim never reads it;
//     diagnostics and replays name the content with it).
//   * The room's plugins (DESIGN §32 P1a — cosmetic plugins only): room.setPlugins { plugins: [{ id }] } — host-only,
//     before the match, and ▸ like a difficulty change it un-readies the other humans. The lobby asks the server's
//     visual sets (server/plugins/visualSet.js resolve: loaded cosmetic plugins of scope `room`, their requirements
//     switched on, in load order, within the size limit — PLUGIN_UNKNOWN / PLUGIN_BLOCKED / PLUGIN_DEPENDENCY /
//     PLUGIN_CONFLICT / PLUGIN_LIMIT otherwise; none given to the Lobby → PLUGIN_UNKNOWN) and the room's content becomes
//     `{ cs, vanilla: true, vs, plugins: [{ id, version, class, hash, auto? }], warnings, bytes }`: `cs` stays the vanilla
//     one — art never changes a battle, so the match, its BattleSpecs and the golden results are those of the original
//     content and ▸ such a match counts as the original game in the statistics overview (the owner's decision of
//     2026-10-13: gameplay and numbers unchanged) —, `vs` names the
//     art every member's page draws with (/vs/<vs16>/overlay.json, composed by public/js/content.js on the page's own
//     manifest). An empty list brings back
//     exactly the vanilla shape above. The set is the room's: kept across its matches and a host change, held in the
//     visual sets while the room uses it (hold / release) and gone with the room. The same set again (the same `vs`)
//     un-readies nobody; ▸ when only its 「自动」 marks changed (a plugin first switched on automatically is now chosen, or
//     the other way round) the new state is broadcast without un-readying. A request that changes nothing (the same `vs`
//     and the same marks) — or a refused one — leaves the host's result replay (a settlement screen still open:
//     dropReplay; a change is the host moving on). ▸ When a plugin of the room's set changes on disk while the room holds
//     it (the visual sets' onStale, after the registry read the folders again), the host is told once (an m.toast: apply
//     the room's plugins again — the panel's 「重新应用」 sends the same list, which resolves to the set of the files as
//     they are now) — during a match, once the room is back in its lobby (onMatchEnd), when it can be done; nothing
//     changes by itself — ▸ but in a room the plugin studio names (DESIGN §32.9: `autoApplyPlugins`, set by
//     server/studio/index.js — a room whose host is the plugin's author or whose host is its only player) the same choice
//     is applied again at once, during a match too (refreshPlugins: art never changes a battle, the `cs` stays the vanilla
//     one; nobody is un-readied), and the host is told only when that fails.
//   * Gameplay plugins (DESIGN §32.6, P1c): room.setPlugins also takes the server's content plugins (data: numbers,
//     records, modes). The lobby's `plugins` (server/plugins/roomSets.js) closes the list over its requirements, refuses
//     conflicts, other classes and scopes, what the server owner's plugins/config.json does not allow and — unless it
//     allows them — gameplay plugins made for other game versions (PLUGIN_INCOMPATIBLE), and builds the room's content set:
//     a `cs` of its own (server/plugins/contentSets.js; at most limits.maxSets such sets held by rooms at once, else
//     PLUGIN_BUSY). The room's content is then `{ cs, vanilla: false, plugins: [{ id, version, class, hash, auto? }],
//     warnings, bytes, dataBytes, vs?, modes?, modeId? }` and ▸ the room is held to it like to a visual set (holdContent /
//     releaseContent). Its members' pages load and check that set (/cs/<cs16>/…, public/js/content.js) and say so with
//     room.contentReady { cs } — `seats[].content` (and `spectators[].content`) is 'loading' | 'ready' | 'failed' in such a
//     room only, reset to 'loading' when the set changes and when the member's socket drops (a reloaded page loads it
//     again); room.ready { ready: true } and room.start wait for every player's 'ready' (CONTENT_NOT_READY). A new room
//     starts with the policy's `default` plugins (none: the original game).
//     room.setMode { modeId } (host, before the match): an official mode of the room's type sets the difficulty; a mode
//     of the room's content set (content.modes, same room type) becomes content.modeId — the match's modeId — until the
//     host picks a difficulty or the set no longer has it; ▸ like a difficulty change it un-readies the other humans.
//     The match of such a room runs in that set's match host (server/match/host/ — a child process, a worker thread with
//     SP_MATCH_HOST=worker: hosts.create — the match is a MatchProxy whose answers are Promises), with opts.cs = the set's cs, opts.requireCs (a b.result naming another
//     content is refused) and opts.vs; ▸ every message and event of such a room is handled in order, one at a time, on
//     the room's own queue (serial): a request waits for the previous one's answer. A vanilla room never queues — its
//     match is in this process and answers at once, exactly as before. A loadout, 干员持有 list or 自选 roster stored while
//     the player was in a room of another content is filtered to the room's data when its match starts (an id the set
//     does not know is dropped, the rest kept — design study §6.9), and room.loadout / room.ownership / room.diy are
//     checked against the room's own data (and its 自选 list). When the worker stops (a crash, the watchdog), the match
//     ends with summary.reason 'plugin-crash' | 'plugin-hang' | 'plugin-start' and the room is back in its lobby.
//   * Spectator seats (community report #26, owner's decision 2026-10-04 — a remake feature, the official room has none):
//     room.spectate { code } takes one of a co-op room's MAX_SPECTATORS (2) spectator seats, in its lobby or while its
//     match runs (▸ solo rooms: ROOM_FULL). A spectator is not a player: never in `seats`, never counted for the 1–4 players
//     or the start gate, never host, never keeps a room alive (a room whose last human leaves closes with room.closed
//     {empty} for its spectators). It receives room.state (`spectators: [{ playerId, name, connected }]`) and every match
//     broadcast (m.public, m.ticker, m.emote, b.pool — public data); the match registers it (opts.spectators /
//     addSpectator) and shows it fields like an eliminated player (b.start watch / m.field), never an m.private. It may
//     only g.watch (the heavy bucket, like every watcher), g.leave / room.leave, and room.loadout / room.ownership /
//     room.diy (stored for its session, never handed to the match); anything else → SPECTATOR (▸ emotes too). Host: room.removeSpectator { playerId } any
//     time → room.closed {kicked} to it. A spectator in a LOBBY room may take a free player seat with room.join of the same
//     code; a player never switches to spectating in place (ALREADY). Disconnect / grace / reconnect / expiry work as for
//     a player seat (the seat is kept and given back on resume).
//   * Official versions (DESIGN §35.23, M1; shared/versions.js, server/versions.js): a room plays one official version,
//     `room.version` — room.create { version? } (omitted: the server's default version; refused VERSION_UNKNOWN when this
//     server does not enable it, VERSION_UNSUPPORTED when it does not offer the room mode, its data failed to load
//     (server/versions.js available; welcome then omits it) or the server owner's fixed plugins (plugins/config.json
//     rooms: fixed) cannot play it; a difficulty the version lacks is lowered — the highest it
//     offers below, else its lowest: 终极 → 绝境). A room of 第二期下半 (act2autochess, the code constant DEFAULT_VERSION)
//     is exactly the room of before: no new key in its room.state, its match in this process. Another version's room:
//     room.state.version, its content `{ cs: <the version's cs>, vanilla: true, version, plugins }` (official — never
//     unofficial; cosmetic plugins only: gameplay plugins play 第二期下半 only, VERSION_UNSUPPORTED), every member's page
//     loads and checks that version's data like a gameplay plugin's set (room.needsContent: seats[].content, contentReady,
//     CONTENT_NOT_READY), room.setDifficulty / room.setMode accept only the version's modes (BAD_TARGET), settings are
//     checked against its data, and its match runs in that version's match host (server/match/host/, kind 'version':
//     opts.version, opts.requireCs) — never in this process, whose module singletons hold 第二期下半's data (INTERNAL
//     without one, unless a test gave its own MatchClass).
//     The version switch, before the match, modelled on 重刷 (server/match/match/setupVote.js): the host proposes
//     (room.proposeVersion { version }: refused NOT_IN_ROOM, SPECTATOR, NOT_HOST, ROOM_STARTED, VERSION_UNKNOWN,
//     VERSION_UNSUPPORTED — the room mode, or gameplay plugins on and the target not 第二期下半 —, ALREADY, VERSION_VOTE,
//     RATE — `versionProposeGapMs` (300 ms) since the last proposal, `versionRetryMs` (5 s) after a declined or expired
//     vote [ASSUMED] —, NOT_READY — a seated human offline —, VERSION_UNSUPPORTED when the target's data failed to load,
//     and VERSION_UNSUPPORTED again when the room's cosmetic plugins do not resolve on the target, checked last);
//     ▸ a lone active human switches at once; otherwise a vote opens: voters = the seated humans then (seat order; AI and
//     spectators never vote), the host counted as agreed, `versionVoteMs` (60 s [ASSUMED]: a room has no clock to pause,
//     unlike 重刷) to answer. room.versionVote { voteId, agree }: a decline cancels (toast to every member), the last
//     agreement switches. room.cancelVersionVote { voteId } (host). A seat taken by a human (a join, a spectator sitting
//     down), a player seat freed (leave, kick, grace timeout, expiry), a host change, a voter's socket dropping and a
//     match start void it (toast); spectators coming or going and AI seats do not. While it is open room.start,
//     room.setPlugins and room.setMode answer VERSION_VOTE. room.state.versionVote { id, proposerId, version, voters,
//     agreed, remainingMs } while open (remainingMs: a duration by the lobby's clock, never a wall clock).
//     The switch (applyVersion): room.version, the difficulty lowered as at create, the content the version's base with
//     the room's cosmetic plugins applied again (none when they do not resolve there), every member's page loading it
//     again, the other humans un-readied, the WHOLE result replay dropped (its frames name the old version's chess ids),
//     every human seat's loadout / 潜能 / 干员持有 / 自选 cleared (the pages send them again) and a seat card the version
//     lacks dropped. ▸ A setting sent in such a room before its page reported the room's content ready is kept unverified
//     (the version's chess ids are reused with other operators: chess_char_1_02 is 角峰 in 第二期, 讯使 in 第一期) — a
//     version room's match then drops that loadout's skill / module choices and that 干员持有 list whole, while 潜能 /
//     练度 and 自选 (keyed by charId) are checked again against the version's data (seatSettings); a setting checked for
//     another content keeps only the ids whose operator (charId) is the same in both data sets.

/** 匹配队友最长搜索时间（默认 2 分钟；测试可用 SP_MATCHMAKING_TIMEOUT_MS 缩短）。 */
const MATCHMAKING_TIMEOUT_MS = Math.max(1000, Number(process.env.SP_MATCHMAKING_TIMEOUT_MS) || 2 * 60 * 1000);

function currentNodeNumber() {
  return Number((String(process.env.SP_NODE_DIR || '').match(/node-(\d+)/i) || [])[1])
    || (Number(process.env.PORT) > 3000 ? Number(process.env.PORT) - 3000 : 0);
}

/** 房间开始/解散时把房间从 matchmaker 的整队队列里移除。 */
function notifyPartyLeave(room) {
  try {
    const node = currentNodeNumber();
    if (!node || !room || !room.code) return;
    fetch('http://127.0.0.1:3090/api/party/leave', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomCode: room.code, node }),
    }).catch(() => {});
  } catch { /* 匹配器通知失败不能影响房间 */ }
}

import { aiTakeover, resetAiTakeover, reconcileAiTakeover } from './aiTakeover.js';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DIFFICULTIES, ERR, MAX_SEATS, MAX_SPECTATORS, ROOM_CODE_LEN, modeIdFor } from '../shared/constants.js';
import { roomCapacity } from '../shared/playerCapacity.js';
import { EXPERIMENTAL_DEFAULTS, isExperimental, experimentalOptions } from '../shared/experimental.js';
import { checkLoadout, checkLoadoutOps, cultivationCharIds, checkNotOwned, checkDiyPicks, charPotentialChanges, checkSkinSelection, operatorCharIds } from '../shared/protocol.js';
import { encode, isErrCode, sendRaw, sendSession } from './net.js';
import { getData as defaultGetData, lookup } from './data.js';
import { Match as DefaultMatch } from './match/Match.js';
import { KITTED_CHARS } from './sim/content/kits/index.js';

const VANILLA_KITTED = new Set(KITTED_CHARS);
import { isContentHash } from '../shared/plugins/identity.js';
import { ruleOption } from '../shared/plugins/rules.js';
import { msg, wireMessage } from '../shared/i18n.js';
import { DEFAULT_VERSION } from '../shared/versions.js';
import { parseTestModeEnv, testModeGate, unrecognizedTestMode } from './testMode.js';

/** Room code alphabet: uppercase letters without I and O (and no digits, so no 0/1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Tunables. */
export const LOBBY_DEFAULTS = Object.freeze({
  lobbyGraceMs: 60_000,   // disconnected humans keep their lobby seat this long
  maxRooms: 1000,
  maxRoomsPerAddr: 16,    // rooms created from one client network that may exist at once (0 = unlimited)
  maxMatchesPerAddr: 8,   // matches started from one client network that may run at once (0 = unlimited)
  maxBotsPerAddr: 0,      // 同一 IP 跨房间累计的 AI 队友上限（0 = 不限）
  idleKickMs: 0,          // 挂机多久后移出房间（0 = 关闭；240000 ≈ 两回合）
  resyncMinGapMs: 1000,   // heavy resyncs (match state / result replay) per session at most this often on repeated hellos
  soloReconnectWindowMs: null, // a dropped solo run stays resumable this long (null = data singleReconnectTime, 24 h)
  versionVoteMs: 60_000,  // an open version vote is cancelled after this long (header "Official versions") [ASSUMED]
  versionRetryMs: 5_000,  // no new version proposal this long after a declined or expired vote [ASSUMED]
  versionProposeGapMs: 300, // nor this soon after the last proposal (重刷's debounce)
  roomCode: null,         // --room-code / roomCode: a fixed alliance key for every new room (null = random per room)
});

/** The stamp of a setting a version room's page sent before it reported the room's content ready (header). */
const UNVERIFIED_CS = 'unverified';

/**
 * The difficulty of a room created without one (room.create's `difficulty` left out; see the header) [ASSUMED: 标准 —
 * the event's room is changed by its creator after 创建同盟, its starting difficulty is not recorded; the event room of
 * research 06 §3.2 shows ♜ 标准模拟 in its footer pill].
 */
export const DEFAULT_DIFFICULTY = 'FUNNY';

/** Official `singleReconnectTime` (s) when the data lacks it (constData, research 01 §1). */
export const SOLO_RECONNECT_FALLBACK_SEC = 86_400;

/** Display names for AI teammates (the tutorial NPCs first, then a few familiar faces). */
export const BOT_NAMES = Object.freeze(['AI·华法琳', 'AI·阿米娅', 'AI·惊蛰', 'AI·杜宾', 'AI·凯尔希', 'AI·可露希尔']); // i18n-ignore: player names (docs/I18N.md)

const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });
/** A match's answer to a request as the platform replies it: OK, or its error (an unknown code: INTERNAL). */
const matchAnswer = (res) => (res && typeof res === 'object' && res.error
  ? fail(isErrCode(res.error) ? res.error : ERR.INTERNAL, typeof res.detail === 'string' ? res.detail : undefined)
  : OK);
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @typedef {{ seat: number, playerId: string, name: string, isBot: boolean, ready: boolean,
 *             connected: boolean, left: boolean, loadout?: Record<string, { skill: number, module: string|null }> | null,
 *             ops?: Readonly<Record<string, { potential: number, cultivate: number }>> | null,
 *             notOwned?: readonly string[] | null, diy?: Readonly<Record<string, DiyLoadout>> | null,
 *             skins?: Readonly<Record<string, string>> | null,
 *             card?: string | null,
 *             content?: 'ready' | 'failed' | null, contentGen?: number, loadoutCs?: string | null, notOwnedCs?: string | null,
 *             diyCs?: string | null, consentCs?: string | null }} Seat
 *   content: a room with gameplay plugins — whether the player's page loaded and checked its content (header "Gameplay
 *   plugins"; null = still loading); contentGen: counts the seat's disconnects (a queued room.contentReady of an earlier
 *   page no longer counts); loadoutCs / notOwnedCs / diyCs: the content its settings were checked for
 * @typedef {{ charId: string, skillIndex: number, uniEquipId: string|null }} DiyLoadout
 */

/** Deep-frozen copy of a checked loadout (shared by the session, the seat and the match's PlayerState). */
function freezeLoadout(loadout) {
  const out = {};
  for (const [id, e] of Object.entries(loadout || {})) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
  return Object.freeze(out);
}

/** Deep-frozen copy of checked operator settings (0.2.2 潜能 / 练度; shared by the session, the seat and the match). */
function freezeOps(ops) {
  const out = {};
  for (const [id, e] of Object.entries(ops || {})) out[id] = Object.freeze({ potential: e.potential, cultivate: e.cultivate });
  return Object.freeze(out);
}

/** The charIds a player may set a potential / 练度 for, per data object (shared/protocol.js cultivationCharIds). */
const OPS_IDS = new WeakMap();
function opsCharIds(data) {
  if (!data || typeof data !== 'object') return new Set();
  let ids = OPS_IDS.get(data);
  if (!ids) { ids = cultivationCharIds(data.chess, data.backups); OPS_IDS.set(data, ids); }
  return ids;
}

/** The operator charIds of a data object's chess.json that a player can see (room.card's whitelist, the client's picker
 * list: no hidden preset, no stand-in or 自选-only body). */
const CHESS_IDS = new WeakMap();
function chessCharIds(data) {
  const chess = data && typeof data.chess === 'object' ? data.chess : null;
  if (!chess) return new Set();
  let ids = CHESS_IDS.get(chess);
  if (!ids) {
    ids = new Set();
    for (const c of Object.values(chess)) if (c && !c.isDiy && c.visible !== false && typeof c.charId === 'string') ids.add(c.charId);
    CHESS_IDS.set(chess, ids);
  }
  return ids;
}

/** Deep-frozen copy of checked 自选 picks (shared by the session, the seat and the match's PlayerState). */
function freezeDiy(picks) {
  const out = {};
  for (const [id, p] of Object.entries(picks || {})) out[id] = Object.freeze({ charId: p.charId, skillIndex: p.skillIndex, uniEquipId: p.uniEquipId ?? null });
  return Object.freeze(out);
}

/**
 * Frozen copy of a skin selection (docs/SKINS.md), keyed by operator charId.
 *
 * A non-plain object, a key that is not a charId, a value that is not a skinId, or a map over the wire cap is refused
 * (`null` — the caller answers BAD_MSG and does not clear what is already stored). A charId `hasOperator` rejects is
 * dropped. The stored copy is then at most the operator count of the room's content, and ≤ 256 [ASSUMED].
 * @param {Record<string, string>} skins `{ [charId]: skinId }`
 * @param {(charId: string) => boolean} hasOperator
 * @returns {Readonly<Record<string, string>>|null}
 */
function freezeSkins(skins, hasOperator) {
  const res = checkSkinSelection(skins, hasOperator);
  if (!res.ok) return null;
  return Object.freeze({ ...res.skins });
}

/** Do two skin selections hold the same pairs (a resend of the same map is not broadcast again)? */
function sameSkins(a, b) {
  const ka = a ? Object.keys(a) : [], kb = b ? Object.keys(b) : [];
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/** 房间创建后多久未开始对局就解散；data/room-ttl.json 的 minutes，默认 15 分钟。 */
let __roomTtlCache = { ms: 15 * 60 * 1000, at: 0 };
function roomTtlMs() {
  if (Date.now() - __roomTtlCache.at > 5000) {
    try {
      const j = JSON.parse(readFileSync(new URL('../../data/room-ttl.json', import.meta.url), 'utf8'));
      const m = Number(j.minutes);
      if (Number.isFinite(m) && m >= 1 && m <= 1440) __roomTtlCache = { ms: Math.round(m * 60000), at: Date.now() };
    } catch { /* 配置缺失时用默认 15 分钟 */ }
  }
  return __roomTtlCache.ms;
}

/**
 * 后台维护开关（管理后台「维护开关」页）：
 *   data/create-room.json 的 enabled：是否允许创建新房间（同盟 + 独立）
 *   content/game-gate.json 的 start / match：是否允许开始游戏 / 匹配队友（匹配另见匹配服务器自己的校验）
 * 与 roomTtlMs 一样 5 秒缓存，后台一开关到点内生效。文件缺失或损坏时视为开放。
 */
let __gateCache = { at: 0, create: true, start: true, match: true };
function maintenanceGate() {
  if (Date.now() - __gateCache.at > 5000) {
    let create = true, start = true, match = true;
    try {
      // 每个节点自己的开关文件：node-N/data/create-room.json（本文件在 node-N/server/ 下，故为 ../data）。
      const j = JSON.parse(readFileSync(new URL('../data/create-room.json', import.meta.url), 'utf8'));
      if (j && j.enabled === false) create = false;
    } catch { /* 配置缺失 = 开放 */ }
    try {
      const j = JSON.parse(readFileSync(new URL('../../content/game-gate.json', import.meta.url), 'utf8'));
      if (j && j.start === false) start = false;
      if (j && j.match === false) match = false;
    } catch { /* 配置缺失 = 开放 */ }
    __gateCache = { at: Date.now(), create, start, match };
  }
  return __gateCache;
}

const __watchSecretFile = new URL('../../.secrets/watch-secret', import.meta.url);
function watchSecret() {
  try { return readFileSync(__watchSecretFile, 'utf8').trim(); } catch { return ''; }
}
function verifyWatchToken(token, code) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const sec = watchSecret();
  if (!sec) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const want = createHmac('sha256', sec).update(payload).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data && data.c === code && Number(data.exp) > Date.now();
  } catch { return false; }
}

/** One room: 4 seat slots, host, difficulty, optional running match. */
export class Room {
  /**
   * @param {string} code @param {'solo'|'coop'} mode @param {string} difficulty @param {number} now
   * @param {string} [version] the official version the room plays (header "Official versions")
   * @param {object} [experimental] 5–20 人实验房选项（本服）
   */
  constructor(code, mode, difficulty, now, version = DEFAULT_VERSION, experimental = null) {
    this.code = code;
    this.mode = mode;
    this.difficulty = difficulty;
    this.experimental = experimental || null;
    /** 5–20 人房间：座位数由实验选项决定 */
    this.capacity = roomCapacity(mode, this.experimental);
    /** 15 分钟未开始对局解散（管理员房**房主在线时**才 noExpire） */
    this.ttlMs = roomTtlMs();
    this.noExpire = false;
    /** 管理员房主离线时刻：人不在就从这时起走普通超时规则，回来清零（sweepOldRooms） */
    this.adminLeftAt = 0;
    /** the official version the room plays (shared/versions.js id; header "Official versions") */
    this.version = version;
    /**
     * the open version vote, else null: `{ id, proposerId, version, voters, agreed, expiresAt, timer }`
     * @type {{ id: number, proposerId: string, version: string, voters: string[], agreed: Set<string>, expiresAt: number, timer: any } | null}
     */
    this.versionVote = null;
    /** the last vote id (room.state.versionVote.id: 1, 2, …) */
    this.versionVoteSeq = 0;
    /** the lobby clock of the last proposal, and the time before which no proposal is taken (a declined / expired vote) */
    this.versionProposeAt = -Infinity;
    this.versionRetryAt = -Infinity;
    /**
     * 「AI 队友最后选择」 (room.setAiPicksLast, GitHub #338; co-op only, off by default): the match's strategy and 机变 drafts
     * put every human seat before every AI seat (Match opts.aiPicksLast). Kept across the room's matches.
     */
    this.aiPicksLast = false;
    // [ASSUMED] Remake cooperation option, approved 2026-10-24; host opt-in before the match.
    this.aiTakeoverEnabled = false;
    /**
     * 「不限时」 (room.setSoloUnlimited, DESIGN §35.23.10; a timed solo only, off by default): the match is built with
     * opts.soloUnlimited. room.state omits the key unless this is true.
     */
    this.soloUnlimited = false;
    /** @type {string | null} */
    this.hostId = null;
    /** @type {(Seat | null)[]} */
    this.seats = new Array(this.capacity).fill(null);
    /** @type {{ playerId: string, name: string, connected: boolean }[]} spectator seats, ≤ MAX_SPECTATORS (header) */
    this.spectators = [];
    /** @type {{ playerId: string, name: string, connected: boolean }[]} hidden admin watchers */
    this.hiddenSpectators = [];
    /** @type {any} running Match instance */
    this.match = null;
    // 匹配队友期间暂停 15 分钟解散计时（本服）
    this.matchmaking = false;
    this.matchmakingAt = 0;
    this.matchmakingStartedAt = 0;
    /** @type {{ live: boolean, ended: boolean, disposed: boolean, match: any } | null} */
    this.matchCtx = null;
    this.matchCount = 0;
    /** @type {any} summary passed to onEnd by the last match */
    this.lastSummary = null;
    /**
     * Frames of the last match's end, replayed on resync to humans who have not moved on yet.
     * @type {{ publicFrame: string | null, frames: Map<string, string>, pending: Set<string> } | null}
     */
    this.replay = null;
    /** @type {string[] | null} plugins of the room's set that changed on disk — the host not told yet (Lobby.pluginsChanged) */
    this.pluginsChanged = null;
    this.pluginNoticeKeys = {};
    /** @type {string | null} per-network limit key of the creator (net.js clientAddress) */
    this.ownerKey = null;
    /** @type {string | null} per-network limit key of whoever started the running match */
    this.matchKey = null;
    this.createdAt = now;
    this.disposed = false;
    /**
     * The content set the room plays (DESIGN §32): `{ cs, vanilla, plugins }` — the server's vanilla set, or with the
     * cosmetic plugins its host switched on (header "The room's plugins": `vs`, `warnings`, `bytes` beside them), or a
     * content set with gameplay plugins (header "Gameplay plugins": `vanilla: false`, its own cs, `dataBytes`, `modes`,
     * `modeId`); null when the lobby has no content identity (room.state then carries none).
     * @type {Readonly<{ cs: string, vanilla: boolean, plugins: readonly object[], vs?: string, warnings?: readonly object[],
     *   bytes?: number, dataBytes?: number, modes?: readonly object[], modeId?: string }> | null}
     */
    this.content = null;
    /** Test room (DESIGN §34.8). Set only at create, and only when the process switch is on. Never flipped later. */
    this.test = false;
    /** the room's queue (header "Gameplay plugins": Lobby.serial): what is still waiting or running, and its tail */
    this.queue = { pending: 0, tail: Promise.resolve() };
  }

  /** Does the room play a content set with gameplay plugins (its own cs; header "Gameplay plugins")? */
  get modded() { return !!this.content && this.content.vanilla === false; }

  /** 5–20 人实验房：返回给客户端的实际座位上限。 */
  get playerCapacity() { return this.capacity; }

  /**
   * Must every member's page load and check the room's content before ready / start (header "Gameplay plugins",
   * "Official versions")? A set with gameplay plugins, or another official version than 第二期下半.
   */
  get needsContent() { return this.modded || this.version !== DEFAULT_VERSION; }

  /** @param {string} playerId @returns {Seat | null} */
  seatOf(playerId) {
    for (const s of this.seats) if (s && s.playerId === playerId) return s;
    return null;
  }

  /** @param {string} playerId @returns {{ playerId: string, name: string, connected: boolean } | null} */
  spectatorOf(playerId) { return this.spectators.find((s) => s.playerId === playerId) || null; }
  hiddenSpectatorOf(playerId) { return this.hiddenSpectators.find((s) => s.playerId === playerId) || null; }
  watcherOf(playerId) { return this.spectatorOf(playerId) || this.hiddenSpectatorOf(playerId); }
  spectatorLimit() {
    if (this.mode !== 'coop') return 0;
    return Math.max(MAX_SPECTATORS, Math.ceil(this.activeHumans().length / 2));
  }

  /** Lowest free seat index, or -1. */
  freeSeat() { return this.seats.indexOf(null); }

  /** Humans that have not departed, in seat order. @returns {Seat[]} */
  activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); }

  /**
   * `room.state` frame (DESIGN §8.1) plus `inMatch`.
   * @param {number} [now] the lobby's clock (an open version vote's remainingMs)
   */
  toState(now = Date.now()) {
    return {
      t: 'room.state',
      ...(this.aiTakeoverEnabled ? { aiTakeoverEnabled: true, aiTakeoverVotes: this.aiTakeoverVotes || [] } : {}),
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      difficulty: this.difficulty,
      capacity: this.capacity,
      experimental: this.experimental ? { ...this.experimental } : null,
      revival: { enabled: this.mode === 'coop' && this.experimental?.revivalEnabled === true },
      aiPicksLast: this.aiPicksLast,
      inMatch: !!this.match,
      // 解散计时的基准：建房时间，或「上一局结束」的时间（取较晚者）。
      // 对局进行中不退出、不倒计时（sweepOldRooms 会跳过有 match 的房间），
      // 所以这里和 sweepOldRooms 用同一个 base，前端显示的剩余时间才不会与实际解散时机打架。
      expiresInMs: this.noExpire ? null
        : Math.max(0, Math.max(Number(this.createdAt) || 0, Number(this.lastMatchEndAt) || 0)
          + (this.ttlMs || roomTtlMs()) - now),
      ttlMs: this.noExpire ? null : (this.ttlMs || roomTtlMs()),
      adminCreated: this.adminCreated === true,
      // 前端倒计时用它判断显示 ∞ 还是 mm:ss（mm/client.js installRoomCountdown）。
      // 之前只下发了 expiresInMs/ttlMs，唯独漏了 noExpire，导致管理员房
      // 明明不销毁却仍然显示倒计时。
      noExpire: this.noExpire === true,
      matchmaking: !!this.matchmaking,
      matchmakingAt: this.matchmaking ? (Number(this.matchmakingStartedAt) || this.matchmakingAt || 0) : 0,
      seats: this.seats.map((s) => (s
        ? { seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected && !s.left,
          // 账号 tag（4 位数字）：前端的 DOCTOR #1234 用它显示真实账号编号。
          // 上游是按 playerId 做 FNV 哈希，而 playerId 每次新建会话都随机生成（net.js: 'p_' + randomBytes(5)），
          // 于是同一账号的编号每次重连都变，玩家会以为"我的编号不对/立绘被改了"。
          // 这里下发真实 tag；拿不到（游客、老节点没这个字段）时前端回退到哈希，行为与上游一致。
          ...(typeof s.tag === 'string' && /^[0-9]{4}$/.test(s.tag) ? { tag: s.tag } : {}),
          // 管理员/服主标记：控制台据此把「玩家」显示成「管理员」（仅展示用）
          ...(s.admin === true ? { admin: true } : {}),
          // a room with gameplay plugins (header "Gameplay plugins"): has this player's page loaded and checked its content?
          ...(this.needsContent && !s.isBot ? { content: s.content || 'loading' } : {}),
          // 名片干员 (room.card): only a human seat with a card carries the key
          ...(!s.isBot && s.card ? { card: s.card } : {}),
          // 干员皮肤 (room.skins, PUBLIC like Match.publicView().players[].skins): the seat card's outfit (header);
          // only a human seat with a non-empty map carries the key
          ...(!s.isBot && s.skins && Object.keys(s.skins).length ? { skins: s.skins } : {}) }
        : null)),
      spectators: this.spectators.map((s) => ({ playerId: s.playerId, name: s.name, connected: s.connected, ...(this.needsContent ? { content: /** @type {any} */ (s).content || 'loading' } : {}) })),
      maxSpectators: this.spectatorLimit(),
      ...(this.content ? { content: this.content.trusted ? {...this.content, trusted:{...this.content.trusted, consent:Object.fromEntries(this.seats.filter(x => x && !x.isBot).map(x => [x.seat,x.consentCs === this.content.cs]))}} : this.content } : {}),
      // another official version than 第二期下半, and its open vote (header "Official versions"): omitted otherwise, so a
      // default room's room.state stays identical
      ...(this.version !== DEFAULT_VERSION ? { version: this.version } : {}),
      ...(this.versionVote ? { versionVote: { id: this.versionVote.id, proposerId: this.versionVote.proposerId, version: this.versionVote.version,
        voters: [...this.versionVote.voters], agreed: this.versionVote.voters.filter((id) => this.versionVote?.agreed.has(id)),
        remainingMs: Math.max(0, Math.round(this.versionVote.expiresAt - now)) } } : {}),
      // omitted when false so a normal room.state stays identical
      ...(this.test ? { test: true } : {}),
      // 「不限时」 (header): omitted unless on, so a default room.state stays identical
      ...(this.soloUnlimited === true ? { soloUnlimited: true } : {}),
    };
  }
}

/** Room registry + lobby message handlers. Pass an instance as the `handler` of net.js Network. */
export class Lobby {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   MatchClass?: new (opts: object) => any,
   *   getData?: () => object,
   *   now?: () => number,
   *   seedFn?: () => number,
   *   content?: { cs: string } | null,
   *   plugins?: { resolve: (ids: string[], opts?: { scope?: 'room' | 'personal', settings?: object, replacing?: object | null }) => any,
   *     hold?: (vs: string) => void, release?: (vs: string) => void, holdContent?: (cs: string) => void,
   *     releaseContent?: (cs: string) => void, onContentStale?: (fn: (cs: string, ids: string[]) => void) => () => void, onStale?: (fn: (vs: string, ids: string[]) => void) => () => void,
   *     unofficial?: () => number, hasNotices?: () => boolean, defaults?: () => string[], dataOf?: (cs: string) => any, kittedOf?: (cs: string) => any,
   *     contentInUse?: () => number } | null,
   *   hosts?: { create: (cs: string, opts: object) => any, stats?: () => object } | null,
   *   versions?: ReturnType<typeof import('./versions.js').createVersionSets> | null,
   *   versionHosts?: { create: (cs: string, opts: object) => any, stats?: () => object } | null,
   *   options?: Partial<typeof LOBBY_DEFAULTS>,
   * }} opts
   *   content: the server's vanilla content (server/plugins/identity.js; header "Content identity"); plugins: what a host
   *   chooses from — the room's sets (server/plugins/roomSets.js: visual sets and content sets; header "The room's
   *   plugins", "Gameplay plugins"); hosts: the match hosts a room with gameplay plugins runs its match in
   *   (server/match/host/index.js; none: such a match runs here, unit tests); versions: the official versions this server
   *   offers (server/versions.js; none: 第二期下半 alone — header "Official versions"); versionHosts: the match hosts of
   *   the other versions (server/match/host/index.js, kind 'version')
   */
  constructor({ registry, log = noopLog, MatchClass = DefaultMatch, getData = defaultGetData, now = Date.now, seedFn, content = null, plugins = null, hosts = null,
    versions = null, versionHosts = null, simPool = null, options = {} }) {
    this.registry = registry;
    /** the vanilla content set every room plays (header "Content identity"), or null */
    this.vanilla = content && isContentHash(content.cs) ? Object.freeze({ cs: content.cs, vanilla: true, plugins: Object.freeze([]) }) : null;
    /** the server's room sets — visual and content (header "The room's plugins", "Gameplay plugins"), or null */
    this.plugins = plugins;
    /** the match hosts (header "Gameplay plugins"), or null */
    this.hosts = hosts;
    /** the official versions this server offers and their match hosts (header "Official versions"), or null */
    this.versions = versions;
    this.versionHosts = versionHosts;
    /**
     * The server's own simulation pool for bot rehearsals (server/workers/roomPool.js), or null when the operator
     * started none — then every rehearsal stays on this thread, exactly as before.
     */
    this.simPool = simPool;
    this.log = log;
    this.MatchClass = MatchClass;
    this.getData = getData;
    this.now = now;
    this.seedFn = seedFn || (() => randomInt(2 ** 32));
    const testModeOpt = options.testMode;
    const testHostOpt = options.testHost;
    if (Object.hasOwn(options, 'testMode') || Object.hasOwn(options, 'testHost')) {
      options = { ...options };
      delete options.testMode;
      delete options.testHost;
    }
    this.opts = { ...LOBBY_DEFAULTS, ...options };
    // A fixed alliance key (--room-code / roomCode): every room this process creates uses it. server/index.js parses
    // the argument once at startup; a test passes it directly. Nothing is read from the environment or persisted.
    if (this.opts.roomCode) {
      // The fixed key is an admission secret: ordinary room lifecycle logs must not expose it either.
      const key = this.opts.roomCode;
      this.log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level,
        (...args) => log[level]?.(...args.map(value => typeof value === 'string' ? value.split(key).join('[fixed room]') : value)),
      ]));
    }
    // Test rooms stay off until the bound address is known (setTestHost). An empty host fails closed, so a
    // server that is about to bind 0.0.0.0 does not briefly accept test rooms on the default. [ASSUMED] the
    // env words are parsed in server/testMode.js.
    const rawMode = testModeOpt != null ? testModeOpt : (typeof process !== 'undefined' && process.env ? process.env.SP_TEST_MODE : undefined);
    this.testMode = parseTestModeEnv(rawMode);
    this.testUnrecognized = unrecognizedTestMode(rawMode);
    this.testHost = '';
    this.testEnabled = false;
    this.testWarn = this.testUnrecognized;
    if (testHostOpt != null) this.setTestHost(testHostOpt);
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    // 房间目录：每 10 秒把本节点房间码报给匹配服务（跨节点邀请链接找房、控制台房间列表）。
    // 升级 0.3.3 时这段丢了，导致 matchmaker 的 content/rooms.json 一直是空的，
    // 节点控制台和后台都看不到任何房间。匹配服务侧 POST /api/rooms/report 仍在。
    try {
      const nodeNo = Number((String(process.env.SP_NODE_DIR || '').match(/node-(\d+)/i) || [])[1])
        || (Number(process.env.PORT) > 3000 ? Number(process.env.PORT) - 3000 : 0);
      if (nodeNo > 0) {
        this.roomReportTimer = setInterval(() => {
          try {
            fetch('http://127.0.0.1:3090/api/rooms/report', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ node: nodeNo, codes: [...this.rooms.keys()] }),
            }).catch(() => {});
          } catch { /* ignore */ }
        }, 10_000);
        this.roomReportTimer.unref?.();
      }
    } catch { /* ignore */ }
    /** @type {Map<string, NodeJS.Timeout>} lobby grace timers by playerId */
    this.graceTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} deferred (coalesced) resyncs by playerId */
    this.resyncTimers = new Map();
    /** 挂机检测定时器（idleKickMs > 0 时启用） */
    this.idleTimer = null;
    if (this.opts.idleKickMs > 0) {
      this.idleTimer = setInterval(() => {
        try { this.sweepIdle(); } catch (e) { this.log.warn('[lobby] idle sweep failed', e); }
      }, 20_000);
      this.idleTimer.unref?.();
    }
    /** 15 分钟房间扫描定时器 */
    this.roomTimer = setInterval(() => {
      try { this.sweepOldRooms(); } catch (e) { this.log.warn('[lobby] room sweep failed', e); }
    }, 20_000);
    this.roomTimer.unref?.();
    /** per-network limit warnings: at most one log line per 10 s (the rest are counted) */
    this.limitLog = { at: -Infinity, suppressed: 0 };
    /** log lines said once (warnOnce) */
    this.told = new Set();
    /** a held visual set whose plugins changed on disk: its rooms' hosts are told (header "The room's plugins") */
    this.offStale = typeof plugins?.onStale === 'function' ? plugins.onStale((vs, ids) => this.pluginsChanged(vs, ids)) : null;
    /**
     * Whether a room applies a change of its plugins on disk by itself (header "The room's plugins"): `({ code, hostId,
     * humans, inMatch }) => boolean`, set by the plugin studio (server/studio/index.js); null — every host is told.
     * @type {((room: { code: string, hostId: string, humans: number, inMatch: boolean }) => boolean) | null}
     */
    this.autoApplyPlugins = null;
    this.offContentStale = plugins?.onContentStale?.((cs, ids) => this.pluginsChanged(cs, ids, 'content')) || null;
  }

  /**
   * The address this process bound. Test rooms stay disabled until this runs. `host` empty fails closed.
   * @param {string} host
   * @returns {{ enabled: boolean, warn: string|null }}
   */
  setTestHost(host) {
    this.testHost = typeof host === 'string' ? host : '';
    const gate = testModeGate(this.testMode, this.testHost);
    this.testEnabled = gate.enabled === true;
    this.testWarn = this.testUnrecognized || gate.warn;
    return { enabled: this.testEnabled, warn: this.testWarn };
  }

  /**
   * The plugins `ids` of the visual set `vs` changed on disk: the host of every room using it is told to apply the room's
   * plugins again (header "The room's plugins") — a host offline now misses it; the panel's 「重新应用」 is always there.
   * @param {string} vs @param {string[]} ids
   */
  pluginsChanged(vs, ids, kind = 'visual') {
    for (const room of this.rooms.values()) {
      if (room.disposed || (kind === 'content' ? room.content?.cs : room.content?.vs) !== vs) continue;
      const noticeKey = `${room.content?.cs}|${room.content?.vs || ''}`;
      if (room.pluginNoticeKeys[kind] === noticeKey) continue;
      // the plugin studio's rooms (the author hosts, or plays alone): the same choice again at once (refreshPlugins)
      let auto;
      try { auto = !!this.autoApplyPlugins?.({ code: room.code, hostId: room.hostId, humans: room.activeHumans().length, inMatch: !!room.match }); } catch { auto = false; }
      if (kind === 'visual' && auto && this.refreshPlugins(room)) continue;
      room.pluginNoticeKeys[kind] = noticeKey;
      this.log.info(`[lobby] ${room.code} plugins changed on disk: ${ids.join(', ')} — the host is asked to apply them again`);
      // during a match the panel cannot change them: the host hears it once the room is back in its lobby (onMatchEnd)
      room.pluginsChanged = [...new Set([...(room.pluginsChanged || []), ...ids])];
      if (!room.match) this.tellPluginsChanged(room);
    }
  }

  /**
   * Apply a room's plugins again as they are on disk now (header "The room's plugins": the plugin studio's rooms) — the
   * plugins its host chose (not the 「自动」 ones), resolved again (resolveContent); the room's content becomes the new set,
   * held in its place, and every member hears it. Allowed during a match: a cosmetic set never changes a battle (the `cs`
   * stays the vanilla one) and nobody is un-readied. Only a room of cosmetic plugins: one with gameplay plugins (DESIGN
   * §32.6) would get another `cs` — every page loads and checks it again, the players are un-readied, a match keeps its
   * set — so its host is told instead, as is the host of a room whose plugins would now make one. Whether it worked
   * (false: the host is told).
   * @param {Room} room
   */
  refreshPlugins(room) {
    const before = room.content;
    if (!before?.vs || before.vanilla === false || !this.vanilla || !this.plugins) return false;
    const ids = before.plugins.filter((p) => !p.auto).map((p) => p.id);
    const r = this.resolveContent(room, ids);
    if (!('content' in r) || !r.content) { this.log.info(`[lobby] ${room.code} plugins changed on disk and no longer apply: ${'detail' in r && r.detail ? r.detail : ('error' in r ? r.error : '?')}`); return false; }
    const next = r.content;
    if (next.vanilla === false || !next.vs) return false;
    room.pluginsChanged = null;
    if (next.vs === before.vs) return true;
    room.content = next;
    this.holdContent(next);
    this.releaseContent(before);
    this.log.info(`[lobby] ${room.code} plugins applied again: ${next.plugins.map((p) => `${p.id}@${p.version}`).join(', ')}`);
    this.broadcastState(room);
    return true;
  }

  /** Tell the host of `room` that its plugins changed on disk (pluginsChanged), once. @param {Room} room */
  tellPluginsChanged(room) {
    const ids = room.pluginsChanged;
    room.pluginsChanged = null;
    // the room's set changed since (re-applied, switched off): nothing to tell
    if (!ids || !room.content?.plugins?.length) return;
    const names = ids.slice(0, 8).join('、');
    this.sendToPlayer(room, room.hostId, { t: 'm.toast', kind: 'warn', ...wireMessage(msg('房间插件「{names}」的文件在服务器上变了，请在插件面板中点「重新应用」', { names })) });
  }

  /** @param {string} code @returns {Room | null} */
  getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; }

  /** Counters for /healthz. */
  stats() {
    let matches = 0;
    let humans = 0;
    let bots = 0;
    let spectators = 0;
    for (const r of this.rooms.values()) {
      if (r.match) matches++;
      for (const s of r.seats) if (s && !s.left) (s.isBot ? bots++ : humans++);
      spectators += r.spectators.length;
    }
    return { rooms: this.rooms.size, matches, humans, bots, spectators };
  }

  // ---------------------------------------------------------------------------------------------------
  // net.js handler interface
  // ---------------------------------------------------------------------------------------------------

  /**
   * After `welcome`: resend room state / match state for resumed (or repeated) hellos.
   * @param {import('./net.js').Session} session
   * @param {{ resumed: boolean, repeat: boolean }} info
   */
  onHello(session, { resumed, repeat }) {
    if (!resumed && !repeat) return;
    const room = this.roomOf(session);
    if (!room) {
      if (session.notice) {
        sendSession(session, { t: 'room.closed', reason: session.notice });
        session.notice = null;
      }
      if (session.pendingResult) {
        for (const frame of session.pendingResult) if (frame) sendRaw(session.ws, frame);
        session.pendingResult = null;
      }
      return;
    }
    session.notice = null;
    session.pendingResult = null;
    // a player seat, or a spectator seat (header): both carry `connected` / `name`
    const seat = room.seatOf(session.playerId) || room.watcherOf(session.playerId);
    this.clearGrace(session.playerId);
    // Only a visible change (reconnect, rename, new host) is broadcast; a plain resync (repeated hello on a
    // live socket) answers the requester alone, so hello spam cannot amplify into room-wide traffic.
    let changed = !seat.connected;
    seat.connected = true;
    // 回填账号身份：落座时 hello 里可能还没带账号令牌（令牌是异步补发的，比首帧 hello 晚），
    // 而 humanSeat() 只写一次、之后没有任何地方补。座位 accountId 为空会直接破坏
    // 「一个账号只能占一处席位」的判定（accountRoomConflict 靠它比对），
    // 后果是同一账号能一边坐着一边去旁观（实测：新标签页没回到对局，旧标签页变成观战）。
    // 这里在每次重连 / 重复 hello 时补上，属于幂等操作。
    if (session.accountId && String(seat.accountId || '') !== String(session.accountId)) {
      seat.accountId = String(session.accountId);
      changed = true;
    }
    if (session.tag && seat.tag !== session.tag) { seat.tag = session.tag; changed = true; }
    // 有人回来了：卡死对局的回收计时作废（房间重新有活人，sweepOldRooms 不会再碰它）
    if (room.lastHumanLeftAt) room.lastHumanLeftAt = 0;
    // 管理员房主回来了：恢复「永久保留」，管理员房重新不计时
    if (room.adminLeftAt && room.hostId === session.playerId) room.adminLeftAt = 0;
    if (!room.match && seat.name !== session.name) { seat.name = session.name; changed = true; }
    if (!room.hostId) { this.migrateHost(room); changed = true; }
    if (changed) this.broadcastState(room);
    else this.sendState(room, session);
    this.resync(session, !resumed);
  }

  /**
   * Validated client message from an identified session. A room whose match runs in a match host handles its
   * messages one at a time, in order (serial; header "Gameplay plugins"): the answer is then a Promise (server/net.js
   * replies when it settles).
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string } | Promise<{ ok: true } | { error: string, detail?: string }>}
   */
  /** 每 20 秒扫描：创建后超过 15 分钟仍未开始对局的房间解散；匹配超过 2 分钟强制开局。 */
  sweepOldRooms() {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (!room || room.disposed) continue;
      // 「永久保留」只在房主（管理员/服主）本人**在线**时才成立。
      // 以前 noExpire 一旦为 true 就无条件跳过所有过期判定，于是管理员断线后再不回来，
      // 房间就永远挂在那里 —— 比普通玩家的卡死房更糟，连 15 分钟 TTL 都不走。
      // 管理员房也要有回收出口：人不在，就按普通房间的规则计时回收。
      const forever = room.noExpire === true && this.adminOwnerOnline(room);
      // 对局进行中的房间：正常情况下不碰它（玩家在打，绝不能因为计时器被解散）。
      // 但必须能回收「卡死的对局」——以前这里直接 `continue`，于是只要 room.match 还在，
      // 房间就永远不会过期。node-19 的 DTTW 就是这样卡了 5 个半小时：
      // 房主 08:20 断线再没回来，对局停在 BAND_DRAFT（liveRound=0）永远推不动，
      // 而 sweepOldRooms 看到 room.match 就跳过，15 分钟 TTL 形同虚设。
      //
      // 判据只有一条：房间里的真人都已经断线（没有在线玩家）。这时对局不可能再推进，
      // 保留它只会占着房间、挡住建房、让后台显示一个假「对局中」。
      // 只要还有任何一个真人连着，就照旧跳过 —— 不影响正常对局。
      if (room.match) {
        if (forever) continue;
        if (room.activeHumans().some((s) => s && s.connected)) continue;
        // 从「最后一个人断线」的时刻起算宽限期，避免对局刚开的瞬间被误判
        const since = Math.max(Number(room.lastHumanLeftAt) || 0, Number(room.createdAt) || now);
        if (now - since < (room.ttlMs || roomTtlMs())) continue;
        this.log?.info?.(`[lobby] ${room.code} 对局已无人在线超过 ${Math.round((room.ttlMs || roomTtlMs()) / 60000)} 分钟，回收卡死房间`);
        try { this.disposeRoom(room, 'expired'); } catch { /* ignore */ }
        continue;
      }
      if (room.matchmaking) {
        const started = Number(room.matchmakingAt) || now;
        if (now - started >= MATCHMAKING_TIMEOUT_MS) {
          try { this.forceStartMatchmaking(room); } catch (e) { this.log?.warn?.('[lobby] 匹配超时开局失败 ' + (e && e.message)); }
        }
        continue;
      }
      if (forever) continue;
      // 普通房间：从建房 / 上一局结束算起。
      // 管理员房（noExpire 但人已离线）：从「管理员离线」算起 —— 他人在的时候房间一直保留，
      // 人一走才开始走 15 分钟倒计时，回来续上。
      const ttl = room.ttlMs || roomTtlMs();
      // 刚恢复的房间至少给满一个 TTL 的宽限：管理员房没存下 adminLeftAt（老存档）时，
      // base 会回退到 createdAt，一个建了半天的房间重启后会被立刻判过期 ——
      // 玩家点「返回同盟」就得到「未找到该同盟密钥对应的房间」。恢复时刻记在 restoredAt。
      const restoredAt = Number(room.restoredAt) || 0;
      if (restoredAt && now - restoredAt < ttl) continue;
      const base = room.noExpire === true
        ? Math.max(Number(room.adminLeftAt) || Number(room.createdAt) || now)
        : Math.max(Number(room.createdAt) || now, Number(room.lastMatchEndAt) || 0);
      if (now - base < ttl) continue;
      this.log?.info?.(`[lobby] ${room.code} expired (${room.noExpire === true ? '管理员离线，' : ''}15 min without a match)`);
      try { this.disposeRoom(room, 'expired'); } catch { /* ignore */ }
    }
  }

  /**
   * 房间的房主是不是一个**在线**的管理员/服主。「永久保留」（noExpire）只在这种时候生效。
   * 管理员建完房就走、再也不回来时，房间必须能按超时规则回收，否则就是僵尸房。
   * @param {Room} room
   */
  adminOwnerOnline(room) {
    if (!room || !room.hostId) return false;
    const host = room.hostId ? room.seatOf?.(room.hostId) || room.watcherOf?.(room.hostId) : null;
    // 房主座位还在，但人没连着：不算在线
    if (host && host.connected !== true) return false;
    const session = this.registry?.byId ? this.registry.byId(room.hostId) : null;
    return !!(session && session.admin === true && session.connected === true);
  }

  /** 匹配队友 2 分钟没凑满：按当前人数直接开局，并通知匹配器移出队列。 */
  forceStartMatchmaking(room) {
    if (!room || room.match) return;
    const humans = room.activeHumans();
    if (!humans.length || !humans.some((s) => s.connected)) { this.disposeRoom(room, 'empty'); return; }
    for (const s of humans) {
      s.ready = true;
      if (room.modded) s.content = 'ready';
    }
    room.matchmaking = false;
    room.matchmakingAt = 0;
    room.matchmakingStartedAt = 0;
    notifyPartyLeave(room);
    const host = room.seatOf(room.hostId);
    const hostSession = host && this.registry?.byId ? this.registry.byId(host.playerId) : null;
    const key = hostSession ? hostSession.limitKey : null;
    this.log?.info?.(`[lobby] ${room.code} 匹配超时，按当前 ${humans.length} 人开局`);
    this.startMatch(room, key);
  }

  onMessage(session, msg) {
    // 挂机检测：任何一条来自玩家的消息都算「还在操作」
    session.lastActiveAt = this.now();
    const room = this.queuedRoom(session);
    if (!room) return this.handleMessage(session, msg);
    // a queued room.contentReady speaks for the page that sent it: the seat and its generation now — a disconnect in
    // between bumps it, and the page that comes back checks the set again (contentReady)
    const ctx = msg && msg.t === 'room.contentReady' ? { from: this.seatGen(room, session.playerId) } : null;
    return this.serial(room, () => this.handleMessage(session, msg, ctx));
  }

  /** A seat (or spectator seat) of `room` and its content generation (header "Gameplay plugins"), or null. */
  seatGen(room, playerId) {
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    return seat ? { seat, gen: seat.contentGen || 0 } : null;
  }

  /**
   * The room of `session` when its messages go through the room's queue: its match runs in a match host
   * (MatchProxy `hosted`), or something of the room is still pending. Null for every vanilla room.
   * @param {import('./net.js').Session} session
   */
  queuedRoom(session) {
    const room = session.roomCode ? this.rooms.get(session.roomCode) : null;
    return room && !room.disposed && (room.queue.pending > 0 || room.match?.hosted === true) ? room : null;
  }

  /**
   * Run `fn` on the room's queue (header "Gameplay plugins"): at once when nothing of the room is pending — a synchronous
   * answer stays synchronous —, else after everything before it has settled. An answer that is a Promise keeps the room's
   * queue busy until it settles.
   * @template T
   * @param {Room} room @param {() => T} fn
   * @returns {T | Promise<Awaited<T>>}
   */
  serial(room, fn) {
    const q = room.queue;
    if (q.pending === 0) {
      const r = fn();
      if (!r || typeof /** @type {any} */ (r).then !== 'function') return r;
      q.pending++;
      const done = Promise.resolve(r).finally(() => { q.pending--; });
      q.tail = done.then(() => {}, () => {});
      return /** @type {any} */ (done);
    }
    q.pending++;
    const done = q.tail.then(() => fn()).finally(() => { q.pending--; });
    q.tail = done.then(() => {}, () => {});
    return /** @type {any} */ (done);
  }

  /** An event of the room (a disconnect, a resync, an expiry) on its queue: nothing waits for it; a failure is logged. */
  queueEvent(room, fn) {
    let r;
    try { r = this.serial(room, fn); } catch (e) { this.log.error(`[lobby] ${room.code} a room event failed`, e); return; }
    if (r && typeof r.then === 'function') r.then(null, (e) => this.log.error(`[lobby] ${room.code} a room event failed`, e));
  }

  /**
   * One message (onMessage), now. `ctx`: what onMessage noted when it queued the message (a contentReady's seat
   * generation), else null.
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @param {{ from?: { seat: Seat, gen: number } | null } | null} [ctx]
   */
  handleMessage(session, msg, ctx = null) {
    switch (msg.t) {
      case 'room.create': return this.create(session, msg);
      case 'room.join': return this.join(session, msg);
      case 'room.leave': return this.leave(session);
      case 'account.resume': return this.resumeAccount(session);
      case 'room.ready': return this.ready(session, msg);
      case 'room.setDifficulty': return this.setDifficulty(session, msg);
      case 'room.setExperimental': return this.setExperimental(session, msg);
      case 'room.setAiPicksLast': return this.setAiPicksLast(session, msg);
      case 'room.setSoloUnlimited': return this.setSoloUnlimited(session, msg);
      case 'room.setAiTakeover': return this.setAiTakeover(session, msg);
      case 'room.aiRequest':
      case 'room.aiVote': return aiTakeover(this, session, msg);
      case 'room.addBot': return this.addBot(session);
      case 'room.removeBot': return this.removeBot(session, msg);
      case 'room.kick': return this.kick(session, msg);
      case 'room.matchmaking': return this.matchmaking(session, msg);
      case 'room.start': return this.start(session);
      case 'room.rerollSetup': return this.rerollSetup(session, msg);
      case 'room.cancelReroll': return this.rerollSetup(session, msg, true);
      case 'room.loadout': return this.loadout(session, msg);
      case 'room.ownership': return this.ownership(session, msg);
      case 'room.diy': return this.diy(session, msg);
      case 'room.skins': return this.skins(session, msg);
      case 'room.card': return this.card(session, msg);
      case 'room.spectate': return this.spectate(session, msg);
      case 'room.removeSpectator': return this.removeSpectator(session, msg);
      case 'room.setPlugins': return this.setPlugins(session, msg);
      case 'room.setMode': return this.setMode(session, msg);
      case 'room.contentReady': return this.contentReady(session, msg, ctx);
      case 'room.consent': return this.consent(session,msg);
      case 'room.proposeVersion': return this.proposeVersion(session, msg);
      case 'room.versionVote': return this.versionVote(session, msg);
      case 'room.cancelVersionVote': return this.cancelVersionVote(session, msg);
      // A client that missed a state-delta frame asks for a full one (shared/stateDelta.js StateReceiver; server/net.js
      // throttles it like the other resend-heavy intents). This is the same heavy resync a repeated hello runs, so it
      // draws from the same per-session budget: the match resends its full state, or the lobby its room state.
      case 'state.resync': return this.resync(session, true) ?? { ok: true };
      default:
        if (typeof msg.t === 'string' && msg.t.startsWith('g.')) return this.routeGameNow(session, msg);
        return fail(ERR.BAD_MSG, `unhandled type ${String(msg.t).slice(0, 32)}`);
    }
  }

  /** The session's socket closed. @param {import('./net.js').Session} session */
  onDisconnect(session) {
    this.clearResync(session.playerId); // the next resume resyncs immediately
    const room = this.roomOf(session);
    // a solo run may be resumed within singleReconnectTime (24 h); everything else keeps the registry's window
    session.resumeWindowMs = room && room.match && room.mode === 'solo' ? this.soloResumeWindowMs(room) : null;
    if (!room) return;
    const player = room.seatOf(session.playerId);
    const seat = player || room.spectatorOf(session.playerId);
    seat.connected = false;
    // the page may come back as a new one (a reload): it loads and checks the room's content again (header "Gameplay
    // plugins") — and a room.contentReady of the page that went, still on the room's queue, no longer counts (seatGen)
    if (room.needsContent) seat.content = null;
    seat.contentGen = (seat.contentGen || 0) + 1;
    // a voter's socket dropped: the version vote is void (header "Official versions")
    if (player && room.versionVote?.voters.includes(session.playerId)) this.voidVersionVote(room, 'members');
    // 记下「最后一个真人断线」的时刻：sweepOldRooms 用它来回收
    //  —— 卡死的对局房间（对局推不动，onMatchEnd 永远不来）
    //  —— 管理员房（noExpire，人在时永久保留，人走了才开始计时）
    if (!room.activeHumans().some((s) => s && s.connected)) room.lastHumanLeftAt = this.now();
    // 管理员房主本人离线：从这一刻起让房间走普通超时规则（人回来会清零）
    if (room.noExpire === true && room.hostId === session.playerId) room.adminLeftAt = this.now();
    // a spectator's seat is kept like a player's (nothing to tell the match: it plays no field)
    if (room.match) {
      if (player) {
        // a match in a match host hears it in order with the room's messages (header "Gameplay plugins") — not at
        // all when the player is back by then (the resync after the reconnect tells it onReconnect)
        if (this.queuedRoom(session)) this.queueEvent(room, () => { if (!session.connected) this.callMatch(room, 'onDisconnect', session.playerId); });
        else this.callMatch(room, 'onDisconnect', session.playerId);
      }
    } else this.startGrace(room, seat);
    this.broadcastState(room);
  }

  /** The session's reconnect window elapsed (already removed from the registry). */
  onExpire(session) {
    session.notice = null;
    session.pendingResult = null;
    this.clearResync(session.playerId);
    const code = session.roomCode;
    const room = code ? this.rooms.get(code) : null;
    // in order with the room's messages when its match runs in a match host (header "Gameplay plugins")
    if (room && this.queuedRoom(session)) {
      this.queueEvent(room, () => { if (session.roomCode === code) session.roomCode = null; this.removeMember(room, session.playerId); });
      return;
    }
    session.roomCode = null;
    if (room) this.removeMember(room, session.playerId);
  }

  /**
   * Dispose every room (notifying members with room.closed) — used on server shutdown.
   * @param {string} [reason]
   */
  shutdown(reason = 'shutdown') {
    this.offStale?.();
    this.offContentStale?.();
    this.offStale = null;
    this.offContentStale = null;
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    if (this.roomTimer) { clearInterval(this.roomTimer); this.roomTimer = null; }
    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.resyncTimers.clear();
  }

  // ---------------------------------------------------------------------------------------------------
  // 挂机踢人
  // ---------------------------------------------------------------------------------------------------

  /** 每 20 秒扫一次：房间里坐着但长时间没有任何消息的真人，移出房间（房主走了会自动移交）。 */
  sweepIdle() {
    const idleMs = this.opts.idleKickMs;
    if (!idleMs || idleMs <= 0) return;
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.disposed) continue;
      for (const seat of room.seats) {
        if (!seat || seat.isBot || seat.left) continue;
        if (seat.ready) continue; // 已准备就绪：不算挂机
        const session = this.registry.byId(seat.playerId);
        if (!session || !session.connected) continue;
        const last = session.lastActiveAt || now;
        if (now - last < idleMs) continue;
        this.kickIdle(room, seat.playerId, session);
      }
    }
  }

  /** 把一个挂机的真人移出房间：先提示，再按「被移出」关房；断线中的玩家等回来时看到提示。 */
  kickIdle(room, playerId, session) {
    const replay = this.replayFor ? this.replayFor(room, playerId) : null;
    this.removeMember(room, playerId);
    if (session.roomCode === room.code) session.roomCode = null;
    session.lastActiveAt = this.now();
    if (session.connected) {
      sendSession(session, { t: 'm.toast', kind: 'warn', text: '长时间未操作，你已被自动移出同盟' });
      sendSession(session, { t: 'room.closed', reason: 'kicked' });
    } else {
      session.notice = 'kicked';
      session.pendingResult = replay;
    }
    this.log.info(`[lobby] ${room.code} ${session.name || playerId} removed for idling`);
  }
  // ---------------------------------------------------------------------------------------------------
  // room.* handlers
  // ---------------------------------------------------------------------------------------------------

  create(session, { mode, difficulty: asked, test, version: askedVersion, soloUnlimited, experimental = null } = {}) {
    // 5–20 人实验房：只接受合法选项；独立模拟始终只有 1 个座位。
    if (experimental != null && !isExperimental(experimental)) return fail(ERR.BAD_MSG, 'invalid experimental options');
    if (mode === 'solo') experimental = null;
    // 后台维护开关：关闭「创建房间」时，同盟房与独立模拟一律拒绝（页面侧按钮同时置灰并给出提示）。
    // 管理员/服主（session.admin）无视维护开关，便于维护期间自测；服务端仍是最终判据。
    if (!session.admin && !maintenanceGate().create) return fail(ERR.CREATE_DISABLED);
    // 本服：游客不能建房，先给出明确原因，避免只拿到 BAD_MSG。
    if (session.guest || !session.accountId) {
      return fail(ERR.BAD_MSG, mode === 'solo'
        ? '游客不能开始独立模拟，请先登录'
        : '游客不能创建同盟模拟房间，请先登录');
    }
    let conflict = this.accountRoomConflict(session);
    // 遗留座位（刷新页面 / 换设备后的旧会话）不再是拦路石：清掉它即可建房。
    if (conflict && conflict.stale) {
      this.dropStaleAccountSeats(session);
      conflict = this.accountRoomConflict(session);
    }
    if (conflict && conflict.room !== this.roomOf(session)) {
      return fail(ERR.SESSION_IN_USE, '该账号已在其他房间中，请先离开原房间');
    }
    // A test room exists only when the process switch allowed it. The check runs before the room is built.
    if (test === true && this.testEnabled !== true) return fail(ERR.TEST_DISABLED);
    // the official version (header "Official versions"): left out, the server's default
    const version = askedVersion ?? this.defaultVersion();
    if (!this.versionEnabled(version)) return fail(ERR.VERSION_UNKNOWN);
    if (!this.offered(version, mode).length) return fail(ERR.VERSION_UNSUPPORTED, `${version} has no ${mode} rooms`);
    if (!this.versionAvailable(version)) return fail(ERR.VERSION_UNSUPPORTED, 'the data of this version is not available');
    // left out: the default (header); the protocol refuses any other value that is not a difficulty; one the version
    // lacks is lowered (终极 → 绝境)
    const difficulty = this.fallbackDifficulty(version, mode, DIFFICULTIES.includes(asked) ? asked : DEFAULT_DIFFICULTY);
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (this.rooms.size >= this.opts.maxRooms) return fail(ERR.INTERNAL, 'too many rooms');
    const key = session.limitKey || null;
    // The room being left disappears with this create when the creator is its only human (a spectator is none).
    const leaving = !!cur && cur.activeHumans().length === 1 && !cur.spectatorOf(session.playerId);
    // 同网段建房数上限：管理员/服主豁免（维护期自测会反复建房）
    if (key && this.opts.maxRoomsPerAddr > 0 && session.admin !== true) {
      if (this.countRooms((r) => r.ownerKey === key) - (leaving && cur.ownerKey === key ? 1 : 0) >= this.opts.maxRoomsPerAddr) {
        this.limitWarn(`room limit (${this.opts.maxRoomsPerAddr}) reached for ${session.addr}`);
        return fail(ERR.RATE, 'too many rooms from your network');
      }
    }
    // A fixed key (--room-code) can only belong to one room. This player's own room may hold it and can be left
    // below (then the key is free again); any other room — or a room this session only watches as a spectator —
    // keeps it, and the create is refused before anything is removed.
    const fixed = this.opts.roomCode || null;
    const fixedIsMine = !!fixed && !!cur && this.rooms.get(fixed) === cur;
    if (fixed) {
      const taken = this.rooms.get(fixed);
      const mine = cur && cur.seatOf(session.playerId);
      const onlyMe = mine && cur.activeHumans().length === 1;
      if (taken && !(taken === cur && onlyMe)) {
        return fail(ERR.ROOM_CODE_TAKEN, 'the fixed alliance key is in use');
      }
    }
    // Treat this sole-human room as yielding its key, but keep membership until all content/version checks pass.
    const code = this.genCode(fixedIsMine ? cur : null);
    if (!code) return fixed ? fail(ERR.ROOM_CODE_TAKEN, 'the fixed alliance key is in use')
      : fail(ERR.INTERNAL, 'no room code available');
    // the server owner's default plugins (plugins/config.json `default`; header "Gameplay plugins"): none — the original
    // game. On another official version (header "Official versions") gameplay plugins are refused: a server whose rooms
    // must play them (rooms: fixed) cannot make that version's room; otherwise the room starts without them. Resolved
    // before the creator leaves the old room (a refusal keeps them there), so a set that room alone holds counts as freed
    // (limits.maxSets), as when the room went first before M1
    let initial = this.baseContent(version);
    const defaults = this.plugins?.defaults?.() || [];
    if (defaults.length) {
      const r = this.resolveContent(null, defaults, {}, version, leaving ? cur.content : null);
      if ('error' in r) {
        const fixed = (() => { try { return this.plugins?.fixed?.() || null; } catch { return null; } })();
        if (fixed && fixed.length && version !== DEFAULT_VERSION) return fail(ERR.VERSION_UNSUPPORTED, `this server fixes every room's plugins (plugins/config.json rooms: fixed): ${r.error}`);
        this.warnOnce(`[lobby] the default plugins (${defaults.join(', ')}) cannot be applied${version !== DEFAULT_VERSION ? ` to ${version}` : ''}: ${r.error}${r.detail ? ` (${r.detail})` : ''}`);
      } else initial = r.content;
    }
    if (cur) this.removeMember(cur, session.playerId);
    const room = new Room(code, mode, difficulty, this.now(), version, experimental);
    room.test = test === true;
    // 管理员建房：不自动过期，并在控制台标记。
    // noExpire 只在房主本身是管理员/服主时成立，房主换人会由 migrateHost 重新判定。
    room.adminCreated = session.admin === true;
    room.noExpire = room.adminCreated;
    // 「不限时」 only on a solo room of a version whose solo is timed (header). Anywhere else the key is ignored, so a
    // stray true cannot change a default or co-op create.
    if (mode === 'solo' && soloUnlimited === true && this.versionSoloTimed(version)) room.soloUnlimited = true;
    room.content = initial;
    if (initial !== this.baseContent(version)) this.holdContent(initial);
    room.ownerKey = key;
    room.seats[0] = this.humanSeat(0, session, room);
    room.hostId = session.playerId;
    this.rooms.set(code, room);
    session.roomCode = code;
    session.notice = null;
    session.pendingResult = null;
    this.log.info(`[lobby] ${code} created (${mode}/${difficulty}${version !== DEFAULT_VERSION ? `, ${version}` : ''}${room.test ? ', test' : ''}) by ${session.name}`);
    this.broadcastState(room);
    // 建房立刻持久化，避免重启前 10 秒窗口丢房间
    try { this.persistFlush?.('room-create'); } catch { /* ignore */ }
    return OK;
  }

  join(session, { code, testAck }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    if (room.test && testAck !== true) return fail(ERR.TEST_CONFIRM);
    const cur = this.roomOf(session);
    // idempotent for members; a spectator of this room goes on below: it may take a free player seat (header)
    if (cur === room && !room.spectatorOf(session.playerId)) { this.sendState(room, session); return OK; }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    let conflict = this.accountRoomConflict(session);
    // ★ 顺序很关键：先判断「能不能在本房间接管」，再考虑清理遗留座位。
    //
    // 以前这里先无条件 dropStaleAccountSeats()：同一账号在**目标房间自己的座位**被当成
    // "遗留"删掉，而那个座位往往是房间里唯一的人类座位 —— 删完房间就空了、被解散。
    // 实测事故（13:53）：玩家开新标签页想回到自己正在对局的 ZUHW，
    // 服务端把旧会话的座位清了 → 「ZUHW disposed (empty)」→
    // 新旧标签页都失去房间，加入时报「未找到该同盟密钥对应的房间」。
    //
    // 正确做法：同房间的座位应当**接管**（下面的 takeover 分支会把 playerId 换成当前会话、
    // 关掉旧 socket），清理只用于「账号在**别的**房间留下的座位」。
    if (conflict && conflict.room === room && conflict.kind === 'player') {
      // 同房间：无论对局是否在跑，都走接管（旧设备让位），绝不删除座位。
    } else if (conflict && conflict.stale) {
      // 账号在别的房间留下了旧座位：清掉，不再挡住这次加入
      this.dropStaleAccountSeats(session);
      conflict = this.accountRoomConflict(session);
    }
    // ★ 2026-10-29：同房间接管时顺手收敛同账号的重复座位（房间 DVWE「山雎」出现两次）。
    //   accountRoomConflict 只返回第一个匹配座位，房间里的第二个座位它永远看不到；
    //   dropStaleAccountSeats 又要求座位自带 accountId，落座时令牌还没到的那种座位清不掉。
    //   接管把座位换成本会话之后，再调 dedupeSeats 清掉同账号的其它旧座位。
    //   对局进行中 dedupeSeats 内部直接返回 0，不会把人踢出对局。
    if (conflict && conflict.room === room && conflict.kind === 'player') {
      // 对局进行中也允许：同账号接管自己的座位（旧设备让位）。
      const oldSeatPid = conflict.seat.playerId;
      const oldSess = this.registry.byId(oldSeatPid);
      if (oldSess && oldSess.playerId !== session.playerId) {
        if (oldSess.ws && oldSess.connected) {
          try { sendSession(oldSess, { t: 'account.detached', roomCode: room.code, playerId: oldSeatPid }); } catch { /* ignore */ }
          const oldWs = oldSess.ws;
          setTimeout(() => { try { oldWs.close(4001, 'account moved'); } catch { /* ignore */ } }, 120);
        }
        oldSess.ws = null;
        oldSess.connected = false;
        oldSess.disconnectedAt = this.now();
        oldSess.roomCode = null;
      }
      // 把座位交给当前会话
      const seat = conflict.seat;
      seat.playerId = session.playerId;
      seat.name = session.name;
      seat.connected = true;
      if (room.hostId === oldSeatPid) room.hostId = session.playerId;
      session.roomCode = room.code;
      session.notice = null;
      session.pendingResult = null;
      // 座位已经属于当前会话：清掉同账号**其它**的旧座位（房间 DVWE「山雎」出现两次的收口）。
      // 对局进行中 dedupeSeats 直接返回 0，接管行为与以前完全一致。
      this.dedupeSeats(room, session);
      this.broadcastState(room);
      if (room.match) { try { this.callMatch(room, 'onReconnect', session.playerId); } catch { /* ignore */ } }
      return OK;
    }
    if (conflict) return fail(ERR.SESSION_IN_USE, '该账号已在其他房间中，请先离开原房间');
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    // a human takes a player seat: the version vote is void (header "Official versions") — before the seat is taken, so
    // its toast reaches the members who saw the vote (a spectator sitting down too), never a joiner who did not
    if (room.versionVote) this.voidVersionVote(room, 'members');
    if (cur) this.removeMember(cur, session.playerId);
    room.seats[idx] = this.humanSeat(idx, session, room);
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    if (!room.hostId) room.hostId = session.playerId;
    // ★ 2026-10-29：落座**之后**再收敛同账号的旧座位。
    //   accountRoomConflict 只返回第一个匹配座位，座位 accountId 为空时它也会漏判；
    //   于是新 playerId 占了新座位，旧座位还留着 → 一个人两个座位（房间 DVWE「山雎」）。
    //   这里自己已有座位（刚落的这个），dedupeSeats 会把同账号的其它旧座位清掉。
    //   必须放在落座之后：落座前调用会把自己的新座位当成「多余」处理。
    this.dedupeSeats(room, session);
    this.broadcastState(room);
    return OK;
  }

  leave(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    this.removeMember(room, session.playerId);
    return OK;
  }

  /**
   * room.spectate: one of a co-op room's MAX_SPECTATORS spectator seats, in its lobby or during its match (header). In a
   * running match the match registers the spectator and resends what it may see (Match.addSpectator).
   */
  spectate(session, { code, testAck, hidden, adminToken }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    if (room.test && testAck !== true) return fail(ERR.TEST_CONFIRM);
    const wantHidden = hidden === true;
    if (wantHidden && !verifyWatchToken(adminToken, room.code)) return fail(ERR.BAD_MSG, 'admin watch denied');
    const cur = this.roomOf(session);
    if (cur === room) {
      if (wantHidden && room.hiddenSpectatorOf(session.playerId)) { this.sendState(room, session); return OK; }
      if (!room.watcherOf(session.playerId)) return fail(ERR.ALREADY, 'seated as a player');
      this.sendState(room, session);
      return OK;
    }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    // 一个账号只能在一个房间里（玩家席或观战席），与 create / join 同一条规则。
    // 以前观战没有这道检查：账号可以「在 A 房打对局的同时去 B 房观战」，或者
    // 静默退出原房间后才进观战席。现在与 join 一致：已在别的房间就先离开。
    // 隐藏观战（adminWatch，管理员隐身）是例外：它不占观战席、不算房间成员。
    if (!wantHidden) {
      let conflict = this.accountRoomConflict(session);
      // 同账号的遗留座位（刷新/换设备后的旧会话）先清掉，不再挡观战。
      if (conflict && conflict.stale) {
        this.dropStaleAccountSeats(session);
        conflict = this.accountRoomConflict(session);
      }
      if (conflict) return fail(ERR.SESSION_IN_USE, '该账号已在其他房间中，请先离开原房间');
    }
    if (!wantHidden && room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    if (!wantHidden && room.spectators.length >= room.spectatorLimit()) return fail(ERR.ROOM_FULL, 'no free spectator seat');
    if (cur) this.removeMember(cur, session.playerId);
    if (wantHidden) {
      if (!room.hiddenSpectatorOf(session.playerId)) {
        room.hiddenSpectators.push({ playerId: session.playerId, name: session.name, connected: session.connected });
      }
      session.roomCode = room.code;
      session.notice = null;
      session.pendingResult = null;
      this.sendState(room, session);
      if (room.match) this.callMatch(room, 'addSpectator', session.playerId, true);
      return OK;
    }
    // 旁观席也要记 accountId：accountRoomConflict 用它判断「同一账号是否已占席位」，
    // 不写的话同一个账号可以在别的房间坐着、同时还来这边旁观。
    room.spectators.push({
      playerId: session.playerId,
      name: session.name,
      connected: session.connected,
      ...(session.accountId ? { accountId: String(session.accountId) } : {}),
    });
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    this.broadcastState(room);
    if (room.match) this.callMatch(room, 'addSpectator', session.playerId);
    return OK;
  }

  /** room.removeSpectator (host, any time): the spectator gets room.closed {kicked} and its seat is freed. */
  removeSpectator(session, { playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (!room.spectatorOf(playerId)) return fail(ERR.BAD_TARGET, 'not a spectator of this room');
    const target = this.registry.byId(playerId);
    const wasHere = !!target && target.roomCode === room.code;
    const replay = this.replayFor(room, playerId);
    this.removeMember(room, playerId);
    if (wasHere) {
      // like room.kick: now, or on the next resume (with the result replay, as after the grace timeout)
      if (target.connected) sendSession(target, { t: 'room.closed', reason: 'kicked' });
      else { target.notice = 'kicked'; target.pendingResult = replay; }
    }
    return OK;
  }

  /** account.resume: move this account's seat to this device; the old device loses the seat, not the account. */
  resumeAccount(session) {
    if (!session.accountId) return fail(ERR.BAD_TARGET, 'account login required');
    if (session.guest) return fail(ERR.BAD_TARGET, 'guest cannot resume');
    const candidates = this.registry.byAccount(session.accountId)
      .filter((s) => s !== session && s.roomCode && this.rooms.get(s.roomCode)?.seatOf(s.playerId));
    if (!candidates.length) return fail(ERR.BAD_TARGET, 'no active match for this account');
    const old = candidates.find((s) => s.connected) || candidates[0];
    const token = this.registry.rotateToken(old);
    if (!token) return fail(ERR.INTERNAL, 'cannot rotate seat token');
    if (old.connected) sendSession(old, { t: 'account.detached', roomCode: old.roomCode, playerId: old.playerId });
    if (old.ws) {
      const oldWs = old.ws;
      setTimeout(() => { try { oldWs.close(4001, 'account moved'); } catch { /* ignore */ } }, 120);
      old.ws = null;
      old.connected = false;
      old.disconnectedAt = this.now();
    }
    sendSession(session, {
      t: 'account.resume',
      token,
      roomCode: old.roomCode,
      playerId: old.playerId,
      name: old.name,
    });
    return OK;
  }

  ready(session, { ready }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const seat = room.seatOf(session.playerId);
    // a room with gameplay plugins: ready once the page has loaded and checked its content (header "Gameplay plugins")
    if (ready && room.needsContent && seat.content !== 'ready') return fail(ERR.CONTENT_NOT_READY);
    if (seat.ready !== ready) {
      seat.ready = ready;
      this.broadcastState(room);
    }
    return OK;
  }

  /** Room-owned experimental rules (host-only, before a match); enlarging keeps seats, shrinking requires empty tail seats. */
  setExperimental(session, { experimental }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.mode === 'solo') return fail(ERR.BAD_MSG, 'experimental options are for co-op only');
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (!isExperimental(experimental)) return fail(ERR.BAD_MSG, 'invalid experimental options');
    const next = experimentalOptions(experimental);
    const capacity = roomCapacity(room.mode, next);
    if (room.seats.some((s, i) => s && i >= capacity)) return fail(ERR.ROOM_FULL, 'occupied seats exceed the new capacity');
    room.experimental = next;
    room.capacity = capacity;
    if (room.mode !== 'solo') {
      while (room.seats.length < capacity) room.seats.push(null);
      room.seats.length = capacity;
    }
    for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
    this.broadcastState(room);
    return OK;
  }

  setDifficulty(session, { difficulty }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    // the room's version offers it (header "Official versions": 第二期上半 / 第一期 have no 终极)
    if (!this.offered(room.version, room.mode).includes(difficulty)) return fail(ERR.BAD_TARGET, 'not a mode of this version');
    this.dropReplay(room, session.playerId);
    // a plugin mode chosen (header "Gameplay plugins") carries its own difficulty: picking one leaves it
    if (room.difficulty !== difficulty || room.content?.modeId) {
      room.difficulty = difficulty;
      if (room.content?.modeId) { const rest = { ...room.content }; delete rest.modeId; room.content = Object.freeze(rest); }
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  /** 「AI 队友最后选择」 (GitHub #338): host-only, before the match, co-op rooms only (a solo room has no AI seat). */
  /** Host-only opt-in, fixed before play; inherited seat metrics never become personal rewards (§35.100). */
  setAiTakeover(session, { on }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo' || (on && (room.modded || room.version !== DEFAULT_VERSION))) return fail(ERR.BAD_TARGET);
    if (room.aiTakeoverEnabled !== on) {
      this.dropReplay(room, session.playerId);
      room.aiTakeoverEnabled = on;
      resetAiTakeover(room);
      for (const seat of room.seats) if (seat && !seat.isBot && seat.playerId !== room.hostId) seat.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  setAiPicksLast(session, { on }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.BAD_TARGET, 'solo rooms have no AI teammates');
    this.dropReplay(room, session.playerId);
    if (room.aiPicksLast !== on) {
      room.aiPicksLast = on;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  /**
   * 「不限时」 (DESIGN §35.23.10): host-only, before the match, a solo room of a version whose solo is timed. `on: false`
   * clears the flag and drops the room.state key. A co-op room or a version whose solo is already untimed is BAD_TARGET.
   */
  setSoloUnlimited(session, { on }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode !== 'solo' || !this.versionSoloTimed(room.version)) return fail(ERR.BAD_TARGET, 'this version\'s solo is not timed');
    this.dropReplay(room, session.playerId);
    const next = on === true;
    if (room.soloUnlimited !== next) {
      room.soloUnlimited = next;
      this.broadcastState(room);
    }
    return OK;
  }

  /**
   * room.setPlugins (header "The room's plugins", "Gameplay plugins"): host-only, before the match; the set of the plugins
   * asked for becomes the room's content and the other humans are un-readied — nothing changes (and nobody is un-readied)
   * when it is the set the room already has. The host's result replay (a settlement screen still open) is dropped only
   * when the set did change: re-applying the same plugins, or a refused set, leaves it.
   */
  setPlugins(session, { plugins }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.versionVote) return fail(ERR.VERSION_VOTE);
    const ids = [...new Set(plugins.map((p) => p.id))];
    /** @type {Record<string, Record<string, unknown>>} */
    const settings = {};
    for (const p of plugins) if (p.settings) settings[p.id] = p.settings;
    const r = this.resolveContent(room, ids, settings);
    if ('error' in r) return r;
    let content = r.content;
    const before = room.content;
    const sameSet = (before?.vs ?? null) === (content?.vs ?? null) && (before?.cs ?? null) === (content?.cs ?? null);
    const marks = (c) => JSON.stringify((c?.plugins || []).map((p) => [p.id, !!p.auto, p.settings || null]));
    if (sameSet && marks(before) === marks(content)) return OK;
    this.dropReplay(room, session.playerId);
    // another set: a notice still waiting for the end of a match (pluginsChanged) is moot
    if (!sameSet) { room.pluginsChanged = null; room.pluginNoticeKeys = {}; }
    // the plugin mode chosen stays while the set still provides it (header "Gameplay plugins")
    if (before?.modeId && content?.modes?.some((m) => m.id === before.modeId)) content = Object.freeze({ ...content, modeId: before.modeId });
    room.content = content;
    if (!sameSet) {
      this.holdContent(content);
      this.releaseContent(before);
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      // another content set: every page loads and checks it again (room.contentReady)
      if ((before?.cs ?? null) !== (content?.cs ?? null)) for (const s of [...room.seats, ...room.spectators]) if (s && !s.isBot)  { s.content = null; s.consentCs = null; }
      this.log.info(`[lobby] ${room.code} plugins: ${content?.plugins?.length ? content.plugins.map((p) => `${p.id}@${p.version}`).join(', ') : 'none'}${room.modded ? ` (content ${content.cs.slice(0, 8)})` : ''}`);
    }
    this.broadcastState(room);
    return OK;
  }

  /**
   * The content a room gets for the plugins `ids` (header "The room's plugins", "Gameplay plugins"): the vanilla set for
   * none, else what the room sets resolve — cosmetic plugins only: the vanilla cs with their `vs`; content plugins: the
   * content set's own cs (`vanilla: false`). Nothing is held yet (holdContent). On another official version (header
   * "Official versions") the base is that version's content (its cs, `version`) and gameplay plugins are refused
   * (VERSION_UNSUPPORTED).
   * @param {Room | null} room @param {string[]} ids @param {Record<string, Record<string, unknown>>} [settings]
   * @param {string} [version] the version the content is for (default: the room's)
   * @param {Room['content'] | null} [replacing] the content this change frees (default: the room's — room.create passes
   *   the creator's old room's when it goes away with the create: its set counts as freed against limits.maxSets)
   * @returns {{ content: Room['content'] } | { error: string, detail?: string }}
   */
  resolveContent(room, ids, settings = {}, version = room ? room.version : DEFAULT_VERSION, replacing = room?.content ?? null) {
    const base = this.baseContent(version);
    if (!ids.length) {
      // the server owner may fix every room's plugins (plugins/config.json rooms: fixed): the original game is not one
      const fixed = (() => { try { return this.plugins?.fixed?.() || null; } catch { return null; } })();
      if (fixed && fixed.length) return fail(ERR.PLUGIN_BLOCKED, 'this server fixes every room\'s plugins (plugins/config.json rooms: fixed)');
      return { content: base };
    }
    if (!this.vanilla || !this.plugins || !base) return fail(ERR.PLUGIN_UNKNOWN, 'this server applies no plugins');
    const gameplay = version === DEFAULT_VERSION;
    let r;
    try { r = this.plugins.resolve(ids, { scope: 'room', settings, replacing, gameplay }); } catch (e) {
      this.log.error(`[lobby] ${room?.code ?? '----'} plugin set failed`, e);
      return fail(ERR.INTERNAL);
    }
    if (!r || !r.ok) return fail(r && isErrCode(r.error) ? r.error : ERR.INTERNAL, r && typeof r.detail === 'string' ? r.detail.slice(0, 200) : undefined);
    const { cs, vs, plugins: list, warnings, bytes, dataBytes, modes, kitted, trusted, execution, rules } = r.set;
    const modded = isContentHash(cs) && cs !== this.vanilla.cs;
    // (roomSets refuses them itself; a room-sets object that does not know the option must not slip one through)
    if (modded && !gameplay) return fail(ERR.VERSION_UNSUPPORTED, 'gameplay plugins play the default version (act2autochess) only');
    const frozen = (a) => Object.freeze((Array.isArray(a) ? a : []).map((p) => Object.freeze({ ...p })));
    // the operators its plugins add to a 自选 slot's list (welcome.diyKitted holds the server's own): the pages' pickers
    const extra = modded && Array.isArray(kitted) ? kitted.filter((id) => typeof id === 'string' && !VANILLA_KITTED.has(id)).slice(0, 200) : [];
    return {
      content: Object.freeze({
        cs: modded ? cs : base.cs,
        vanilla: !modded,
        ...(base.version ? { version: base.version } : {}),
        ...(vs ? { vs } : {}),
        plugins: frozen(list),
        ...(trusted ? {trusted} : {}),
        ...(execution ? {execution} : {}),
        warnings: Object.freeze([...(warnings || [])]),
        bytes: Number(bytes) || 0,
        ...(modded ? { dataBytes: Number(dataBytes) || 0, modes: frozen(modes), ...(extra.length ? { kittedExtra: Object.freeze(extra) } : {}) } : {}),
        ...(rules ? { rules } : {}),
      }),
    };
  }

  /** A room now uses `content`: its visual set and its content set are held (released by releaseContent). */
  holdContent(content) {
    if (content?.vs) this.plugins?.hold?.(content.vs);
    if (content && content.vanilla === false) this.plugins?.holdContent?.(content.cs);
  }

  /** A room no longer uses `content`. */
  releaseContent(content) {
    if (content?.vs) this.plugins?.release?.(content.vs);
    if (content && content.vanilla === false) this.plugins?.releaseContent?.(content.cs);
  }

  /**
   * room.setMode (header "Gameplay plugins"): host-only, before the match. An official mode of the room's type sets its
   * difficulty (and leaves a plugin mode); a mode of the room's content set (content.modes, the room's type) becomes
   * content.modeId — its difficulty the room's. Like a difficulty change it un-readies the other humans.
   */
  setMode(session, { modeId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.versionVote) return fail(ERR.VERSION_VOTE);
    const official = DIFFICULTIES.find((d) => modeIdFor(room.mode, d) === modeId);
    let difficulty = room.difficulty;
    let content = room.content;
    if (official) {
      // the room's version offers it (header "Official versions")
      if (!this.offered(room.version, room.mode).includes(official)) return fail(ERR.BAD_TARGET, 'not a mode of this version');
      difficulty = official;
      if (content?.modeId) { const rest = { ...content }; delete rest.modeId; content = Object.freeze(rest); }
    } else {
      const mode = Array.isArray(content?.modes) ? content.modes.find((m) => m && m.id === modeId) : null;
      if (!mode) return fail(ERR.BAD_TARGET, 'not a mode of this room');
      if (mode.roomMode !== room.mode) return fail(ERR.BAD_TARGET, `a mode of ${mode.roomMode} rooms`);
      if (DIFFICULTIES.includes(mode.difficulty)) difficulty = mode.difficulty;
      if (content.modeId !== modeId) content = Object.freeze({ ...content, modeId });
    }
    if (difficulty === room.difficulty && content === room.content) return OK;
    this.dropReplay(room, session.playerId);
    room.difficulty = difficulty;
    room.content = content;
    for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
    this.broadcastState(room);
    return OK;
  }

  /**
   * room.contentReady { cs, ok? } (header "Gameplay plugins"): the member's page has loaded and checked the room's content
   * set (`ok: false`: it could not). Recorded for the room's current set only — a page that checked an older one is
   * answered OK and changes nothing — and only for the page that is there: a session whose socket is gone, or a message
   * that waited on the room's queue across a disconnect of its seat (`ctx.from`: the seat's generation when it was
   * queued), is answered OK and writes nothing (the page that comes back checks the set again).
   * @param {import('./net.js').Session} session @param {{ cs: string, ok?: boolean }} msg
   * @param {{ from?: { seat: Seat, gen: number } | null } | null} [ctx]
   */
  contentReady(session, { cs, ok }, ctx = null) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!room.needsContent || room.content?.cs !== cs) return OK;
    if (!session.connected) return OK;
    const seat = room.seatOf(session.playerId) || room.watcherOf(session.playerId);
    if (!seat) return OK;
    if (ctx && ctx.from && (ctx.from.seat !== seat || ctx.from.gen !== (seat.contentGen || 0))) return OK;
    if (ok !== false && room.content?.trusted && room.seatOf(session.playerId) && seat.consentCs !== cs) return fail(ERR.PLUGIN_CONSENT);
    const state = ok === false ? 'failed' : 'ready';
    if (seat.content === state) return OK;
    seat.content = state;
    if (state === 'failed') this.log.warn(`[lobby] ${room.code} ${session.name}: the room's content ${cs.slice(0, 8)} did not load or check on that page`);
    this.broadcastState(room);
    return OK;
  }

  /** Each live session consents only for its own seat and the current cs. Reconnect keeps the seat. */
  consent(session, {cs,accept}) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    const seat = room.seatOf(session.playerId);
    if (!seat || seat.isBot) return fail(ERR.SPECTATOR);
    if (!session.connected || !room.content?.trusted || room.content.cs !== cs) return fail(ERR.PLUGIN_CONSENT);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const changed = (seat.consentCs === cs) !== accept;
    seat.consentCs = accept ? cs : null;
    if (changed) seat.content = null;
    if (!accept) { seat.ready = false; seat.content = null; }
    this.broadcastState(room);
    return OK;
  }

  // ---------------------------------------------------------------------------------------------------
  // Official versions (header "Official versions")
  // ---------------------------------------------------------------------------------------------------

  /**
   * The server's default version (a room created without one, the settings outside a room). When the configured one's
   * data failed to load: 第二期下半 if enabled, else the first enabled version that loads (server/versions.js welcome
   * marks the same one the default).
   */
  defaultVersion() {
    const v = this.versions;
    const id = v?.defaultId ?? DEFAULT_VERSION;
    if (!v || this.versionAvailable(id)) return id;
    if (v.isEnabled(DEFAULT_VERSION)) return DEFAULT_VERSION;
    return v.ids.find((x) => this.versionAvailable(x)) ?? id;
  }

  /** Does this server offer the version `id`? @param {unknown} id */
  versionEnabled(id) { return this.versions ? this.versions.isEnabled(id) : id === DEFAULT_VERSION; }

  /**
   * Can a room play the enabled version `id` now? Another version's data loads on first use (a room of it loads it
   * anyway); a failed load is remembered (server/versions.js available), and such a version is never offered again.
   * @param {string} id
   */
  versionAvailable(id) { return id === DEFAULT_VERSION || typeof this.versions?.available !== 'function' || this.versions.available(id); }

  /** A room's content base for a version: the vanilla content for 第二期下半, else the version's own. @param {string} v */
  baseContent(v) {
    if (v === DEFAULT_VERSION || !this.versions) return this.vanilla;
    return this.versions.content(v) || null;
  }

  /**
   * The difficulties a version offers a room mode (DIFFICULTIES for 第二期下半 / a server without versions).
   * @param {string} v @param {string} mode @returns {readonly string[]}
   */
  offered(v, mode) {
    if (!this.versions || v === DEFAULT_VERSION) return DIFFICULTIES;
    return this.versions.offered(v, /** @type {'solo' | 'coop'} */ (mode));
  }

  /**
   * Does this version's solo use the official per-round timers (`config.version.rules.soloTimed`)? 第二期下半, a server
   * without the versions service, and a version whose data cannot be read: no.
   * @param {string} id
   */
  versionSoloTimed(id) {
    if (!id || id === DEFAULT_VERSION || !this.versions) return false;
    try {
      const data = this.versions.data(id);
      return data?.config?.version?.rules?.soloTimed === true;
    } catch (e) {
      this.log.error(`[lobby] the solo timer of ${id} failed`, e);
      return false;
    }
  }

  /**
   * `d`, or the difficulty the version offers instead: the highest below it, else its lowest (终极 → 绝境).
   * @param {string} v @param {string} mode @param {string} d
   */
  fallbackDifficulty(v, mode, d) {
    const offered = this.offered(v, mode);
    if (!offered.length || offered.includes(d)) return d;
    const below = DIFFICULTIES.slice(0, Math.max(0, DIFFICULTIES.indexOf(d))).reverse().find((x) => offered.includes(x));
    return below || offered[0];
  }

  /**
   * room.proposeVersion { version } (host, before the match): a lone active human switches at once, else the seated
   * humans vote (header "Official versions").
   */
  proposeVersion(session, { version }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (!this.versionEnabled(version)) return fail(ERR.VERSION_UNKNOWN);
    if (!this.offered(version, room.mode).length) return fail(ERR.VERSION_UNSUPPORTED, `${version} has no ${room.mode} rooms`);
    if (room.modded && version !== DEFAULT_VERSION) return fail(ERR.VERSION_UNSUPPORTED, 'gameplay plugins play the default version (act2autochess) only');
    if (version === room.version) return fail(ERR.ALREADY);
    if (room.versionVote) return fail(ERR.VERSION_VOTE);
    const now = this.now();
    // 版本提议频率/冷却：管理员/服主豁免（同一人自测时来回切换版本会被 300ms / 5s 卡住）
    if (session.admin !== true
      && (now - room.versionProposeAt < this.opts.versionProposeGapMs || now < room.versionRetryAt)) return fail(ERR.RATE);
    const humans = room.activeHumans();
    if (humans.some((s) => !s.connected)) return fail(ERR.NOT_READY);
    if (!this.versionAvailable(version)) return fail(ERR.VERSION_UNSUPPORTED, 'the data of this version is not available');
    room.versionProposeAt = now;
    // the room's cosmetic plugins must resolve on the target (the server owner's policy, a plugin refused there)
    const ids = (room.content?.plugins || []).filter((p) => !p.auto).map((p) => p.id);
    if (ids.length) {
      const r = this.resolveContent(room, ids, this.pluginSettings(room.content), version);
      if ('error' in r) return fail(ERR.VERSION_UNSUPPORTED, `the room's plugins do not apply to ${version}: ${r.error}`);
    }
    this.dropReplay(room, session.playerId);
    if (humans.length === 1) { this.applyVersion(room, version, 'alone'); return OK; }
    room.versionVoteSeq = room.versionVoteSeq >= 2 ** 31 ? 1 : room.versionVoteSeq + 1;
    const id = room.versionVoteSeq;
    const ms = Math.max(0, Number(this.opts.versionVoteMs) || 0);
    const timer = setTimeout(() => {
      const run = () => { if (!room.disposed && room.versionVote?.id === id) this.voidVersionVote(room, 'expired'); };
      // in order with the room's messages when something of the room is still pending (header "Gameplay plugins")
      if (room.queue.pending > 0) this.queueEvent(room, run); else run();
    }, ms);
    timer.unref?.();
    room.versionVote = { id, proposerId: session.playerId, version, voters: humans.map((s) => s.playerId), agreed: new Set([session.playerId]), expiresAt: now + ms, timer };
    this.log.info(`[lobby] ${room.code} version vote #${id} → ${version} (${humans.length} voters)`);
    this.broadcastState(room);
    return OK;
  }

  /** room.versionVote { voteId, agree } (a voter): a decline cancels the vote, the last agreement switches. */
  versionVote(session, { voteId, agree }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    const vote = room.versionVote;
    if (!vote) return fail(ERR.WRONG_PHASE);
    if (vote.id !== voteId) return fail(ERR.BAD_TARGET, 'vote changed');
    if (!vote.voters.includes(session.playerId)) return fail(ERR.BAD_TARGET, 'not a voter');
    this.dropReplay(room, session.playerId);
    if (!agree) {
      this.voidVersionVote(room, 'declined', session.name);
      return OK;
    }
    if (vote.agreed.has(session.playerId)) return OK;
    vote.agreed.add(session.playerId);
    if (vote.voters.every((id) => vote.agreed.has(id))) this.applyVersion(room, vote.version, 'vote');
    else this.broadcastState(room);
    return OK;
  }

  /** room.cancelVersionVote { voteId } (host): the vote ends, the room keeps its version. */
  cancelVersionVote(session, { voteId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (!room.versionVote) return fail(ERR.WRONG_PHASE);
    if (room.versionVote.id !== voteId) return fail(ERR.BAD_TARGET, 'vote changed');
    this.dropReplay(room, session.playerId);
    this.voidVersionVote(room, 'cancelled');
    return OK;
  }

  /**
   * End the room's open version vote without a switch and tell its members (header "Official versions"): `declined`
   * (by `name`; every member), `expired` (every member), `members` (a seat or the host changed, a voter dropped, a match
   * started; every member), `cancelled` (by the host; everyone but the host). A declined or expired vote holds the next
   * proposal back versionRetryMs. room.state is broadcast — but for `members`: every such caller broadcasts it next.
   * @param {Room} room @param {'declined' | 'expired' | 'members' | 'cancelled'} reason @param {string} [name]
   */
  voidVersionVote(room, reason, name = '') {
    const vote = room.versionVote;
    if (!vote) return;
    clearTimeout(vote.timer);
    room.versionVote = null;
    if (reason === 'declined' || reason === 'expired') room.versionRetryAt = this.now() + this.opts.versionRetryMs;
    this.log.info(`[lobby] ${room.code} version vote #${vote.id} ended (${reason})`);
    if (room.disposed) return;
    if (reason !== 'members') this.broadcastState(room);
    const text = reason === 'declined' ? msg('{name}拒绝了切换版本', { name })
      : reason === 'expired' ? msg('切换版本投票已超时，房间版本未改变')
        : reason === 'cancelled' ? msg('创建者取消了切换版本投票')
          : msg('同盟成员有变动，切换版本投票已取消');
    const toast = { t: 'm.toast', kind: reason === 'cancelled' ? 'info' : 'warn', ...wireMessage(text) };
    if (reason !== 'cancelled') { this.broadcastRoom(room, toast); return; }
    for (const s of [...room.seats, ...room.spectators]) if (s && !/** @type {any} */ (s).isBot && s.playerId !== room.hostId) this.sendToPlayer(room, s.playerId, toast);
  }

  /** The per-plugin settings of a room content's plugins (to resolve the same choice again). */
  pluginSettings(content) {
    /** @type {Record<string, Record<string, unknown>>} */
    const out = {};
    for (const p of content?.plugins || []) if (p.settings && typeof p.settings === 'object') out[p.id] = { ...p.settings };
    return out;
  }

  /**
   * Switch the room to `version` (header "Official versions"): its difficulty, its content (the version's base with the
   * room's cosmetic plugins again — none when they no longer resolve), every member's page loading it, the other humans
   * un-readied, the whole result replay and every human seat's stored settings dropped, a seat card the version lacks
   * dropped. Broadcast.
   * @param {Room} room @param {string} version @param {'vote' | 'alone'} how
   */
  applyVersion(room, version, how) {
    if (room.versionVote) { clearTimeout(room.versionVote.timer); room.versionVote = null; }
    const before = room.content;
    room.version = version;
    // 「不限时」 belongs to a timed solo only (header): a co-op room, or a version whose solo is not timed, drops it.
    // Switching between the two 第一期 versions keeps it.
    if (room.mode !== 'solo' || !this.versionSoloTimed(version)) room.soloUnlimited = false;
    room.difficulty = this.fallbackDifficulty(version, room.mode, room.difficulty);
    let next = this.baseContent(version);
    const ids = (before?.plugins || []).filter((p) => !p.auto).map((p) => p.id);
    if (ids.length) {
      const r = this.resolveContent(room, ids, this.pluginSettings(before));
      if ('content' in r && r.content && r.content.vanilla !== false) next = r.content;
      else this.warnOnce(`[lobby] ${room.code} plugins (${ids.join(', ')}) dropped on the switch to ${version}: ${'error' in r ? r.error : '?'}${'detail' in r && r.detail ? ` (${r.detail})` : ''}`);
    }
    room.content = next;
    this.holdContent(next);
    this.releaseContent(before);
    room.pluginsChanged = null;
    room.pluginNoticeKeys = {};
    room.replay = null;
    const data = this.dataFor(room);
    const operators = chessCharIds(data);
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || /** @type {any} */ (s).isBot) continue;
      const seat = /** @type {Seat} */ (s);
      seat.content = null;
      seat.consentCs = null;
    }
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      if (s.playerId !== room.hostId) s.ready = false;
      s.loadout = null; s.ops = null; s.notOwned = null; s.diy = null;
      s.loadoutCs = null; s.notOwnedCs = null; s.diyCs = null;
      if (s.card && !operators.has(s.card)) s.card = null;
    }
    this.log.info(`[lobby] ${room.code} version → ${version} (${how})`);
    this.broadcastState(room);
  }

  addBot(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo rooms cannot have AI teammates');
    // 同一个网络地址能挂的 AI 队友总数（跨房间累计），防止用一堆机器人占满 CPU。
    // 管理员/服主豁免这次限流：维护期自测（尤其 5–20 人房）需要一次加很多 AI，
    // 被「操作过于频繁」挡住就没法测试（玩家就是管理员本人）。
    if (this.opts.maxBotsPerAddr > 0 && session.admin !== true) {
      const key = session.limitKey;
      if (key && this.countBots(key) >= this.opts.maxBotsPerAddr) {
        this.limitWarn(`AI teammate limit (${this.opts.maxBotsPerAddr}) reached for ${session.addr}`);
        return fail(ERR.RATE, 'too many AI teammates from your network');
      }
    }
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    const used = new Set(room.seats.filter((s) => s && s.isBot).map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `AI·${idx + 1}`;
    let playerId;
    do playerId = 'ai_' + randomBytes(4).toString('hex'); while (room.seatOf(playerId));
    room.seats[idx] = { seat: idx, playerId, name, isBot: true, ready: true, connected: true, left: false };
    this.broadcastState(room);
    return OK;
  }

  removeBot(session, { seat }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || !target.isBot) return fail(ERR.BAD_TARGET, 'seat does not hold an AI');
    room.seats[seat] = null;
    this.broadcastState(room);
    return OK;
  }

  /** Host removes another human before the match (header: room.kick). */
  kick(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || target.left) return fail(ERR.BAD_TARGET, 'seat holds no player');
    if (target.playerId !== playerId) return fail(ERR.BAD_TARGET, 'seat changed hands'); // the confirmed player left meanwhile
    if (target.isBot) return fail(ERR.BAD_TARGET, 'seat holds an AI (room.removeBot)');
    if (target.playerId === session.playerId) return fail(ERR.BAD_TARGET, 'cannot kick yourself');
    const kicked = this.registry.byId(target.playerId);
    const wasHere = !!kicked && kicked.roomCode === room.code;
    const replay = this.replayFor(room, target.playerId);
    this.removeMember(room, target.playerId);
    if (wasHere) {
      if (kicked.connected) sendSession(kicked, { t: 'room.closed', reason: 'kicked' });
      else { kicked.notice = 'kicked'; kicked.pendingResult = replay; }
    }
    this.log.info(`[lobby] ${room.code} ${target.name} removed by the host`);
    return OK;
  }

  /** 房主进入/退出「匹配队友」：匹配期间暂停 15 分钟解散计时。 */
  matchmaking(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const on = !!(msg && msg.on);
    if (on === room.matchmaking) return OK;
    // 后台维护开关：关闭「匹配队友」时不能进入匹配队列（取消匹配不受影响，免得房间卡在队列里）。
    // 管理员/服主无视该开关。
    if (on && !session.admin && !maintenanceGate().match) return fail(ERR.MATCH_DISABLED);
    if (on) {
      const humans = room.activeHumans();
      if (humans.some((s) => s.playerId !== room.hostId && (!s.connected || !s.ready))) {
        return fail(ERR.NOT_READY, 'all players must be ready before matchmaking');
      }
    }
    const now = this.now();
    if (on) {
      room.matchmaking = true;
      room.matchmakingAt = now;
      room.matchmakingStartedAt = now;
      this.log?.info?.('[lobby] ' + room.code + ' 开始匹配队友，暂停解散计时');
    } else {
      const started = Number(room.matchmakingStartedAt) || now;
      room.matchmaking = false;
      room.matchmakingAt = 0;
      room.matchmakingStartedAt = 0;
      // 暂停计时：把匹配期间的时间补回房间寿命，剩余时间不被消耗
      const elapsed = Math.max(0, now - started);
      room.createdAt = (Number(room.createdAt) || now) + elapsed;
      if (room.lastMatchEndAt) room.lastMatchEndAt = Number(room.lastMatchEndAt) + elapsed;
      this.log?.info?.('[lobby] ' + room.code + ' 取消匹配，恢复解散计时（暂停 ' + Math.round(elapsed / 1000) + 's）');
    }
    this.broadcastState(room);
    return OK;
  }
  start(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    // 后台维护开关：关闭「开始游戏」时，已建好的房间也不能开局（房主先看到提示，页面侧同时会把按钮置灰）。
    // 管理员/服主无视该开关。
    if (!session.admin && !maintenanceGate().start) return fail(ERR.START_DISABLED);
    if (room.versionVote) return fail(ERR.VERSION_VOTE);
    const humans = room.activeHumans();
    if (room.content?.trusted && humans.some(s => s.consentCs !== room.content.cs)) return fail(ERR.PLUGIN_CONSENT);
    for (const s of humans) {
      if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return fail(ERR.NOT_READY);
    }
    // a room with gameplay plugins, or of another official version, starts once every player's page has loaded and checked
    // its content (the host's too)
    if (room.needsContent && humans.some((s) => s.content !== 'ready')) return fail(ERR.CONTENT_NOT_READY);
    const bots = room.seats.filter((s) => s && s.isBot);
    if (humans.length < 1 || (room.mode === 'solo' && (humans.length !== 1 || bots.length > 0))) {
      return fail(ERR.BAD_MSG, 'invalid seat configuration');
    }
    const key = session.limitKey || null;
    // 同网段同时对局数上限：管理员/服主豁免（维护期要能同时开多局自测）
    if (key && this.opts.maxMatchesPerAddr > 0 && session.admin !== true
      && this.countRooms((r) => !!r.match && r.matchKey === key) >= this.opts.maxMatchesPerAddr) {
      this.limitWarn(`match limit (${this.opts.maxMatchesPerAddr}) reached for ${session.addr}`);
      return fail(ERR.RATE, 'too many running matches from your network');
    }
    return this.startMatch(room, key);
  }

  /**
   * Any seated player may open or cancel the vote (issue #854); the match owns the vote, the per-seat cooldown and the
   * setup replacement itself. A spectator has no seat and therefore nothing to reroll.
   */
  rerollSetup(session, msg, cancel = false) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    const method = cancel ? 'cancelSetupReroll' : 'requestSetupReroll';
    if (!room.match || typeof room.match[method] !== 'function') return fail(ERR.WRONG_PHASE);
    return this.callMatch(room, method, session.playerId, cancel ? msg.voteId : msg.setupRevision) || fail(ERR.INTERNAL);
  }

  /**
   * room.loadout (DESIGN §16): check the operator loadout — and its per-operator 潜能 / 练度 `ops` (0.2.2) — against the
   * game data, store both on the session and the seat, and — while a match runs — hand them to the match (accepted only
   * during INFO_CHECK, see the header). Either part refused: nothing is stored.
   */
  loadout(session, { entries, ops }) {
    const room = this.roomOf(session);
    // checked against the room's own data: a room with gameplay plugins knows its plugins' operators (header "Gameplay plugins")
    const data = this.dataFor(room);
    const res = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const ids = opsCharIds(data);
    const resOps = checkLoadoutOps(ops, (id) => ids.has(id), (id) => charPotentialChanges(data, id));
    if (!resOps || resOps.error) return fail(resOps && isErrCode(resOps.error) ? resOps.error : ERR.BAD_MSG, resOps && resOps.detail);
    const loadout = freezeLoadout(res.loadout);
    const opsSet = freezeOps(resOps.ops);
    const cs = this.settingsCs(room, session.playerId);
    session.loadout = loadout;
    session.ops = opsSet;
    session.loadoutCs = cs;
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.loadout = loadout; seat.ops = opsSet; seat.loadoutCs = cs; }
    if (!room.match || !seat) return OK; // a spectator's loadout stays on its session, never reaching the match
    if (typeof room.match.setLoadout !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      // Preserve named defaults for prep merging: normalisation drops them, but they mean reset this operator.
      r = ruleOption(room.content?.rules, 'prepLoadout') === 'prep'
        ? room.match.setLoadout(session.playerId, entries, ops)
        : room.match.setLoadout(session.playerId, loadout, opsSet);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setLoadout threw`, e);
      return fail(ERR.INTERNAL);
    }
    // a match in a match host answers later (header "Gameplay plugins")
    if (r && typeof r.then === 'function') return Promise.resolve(r).then(matchAnswer, () => fail(ERR.INTERNAL));
    return matchAnswer(r);
  }

  /**
   * room.ownership (0.2.0 补位): keep the droppable chess of the not-owned list, store it on the session and the seat
   * (see the header). A running match never takes it: it keeps the list its seat had at its start.
   */
  ownership(session, { notOwned }) {
    const room = this.roomOf(session);
    const data = this.dataFor(room);
    const res = checkNotOwned(notOwned, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(ERR.BAD_MSG, res && res.detail);
    const list = Object.freeze(res.notOwned.slice());
    const cs = this.settingsCs(room, session.playerId);
    session.notOwned = list;
    session.notOwnedCs = cs;
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.notOwned = list; seat.notOwnedCs = cs; }
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /**
   * room.diy (0.2.0 自选编队): keep the legal picks (checkDiyPicks against the data and KITTED_CHARS — the room's own in a
   * room with gameplay plugins), store them on the session and the seat (see the header). A running match never takes
   * them: it keeps the picks its seat had at its start.
   */
  diy(session, { picks }) {
    const room = this.roomOf(session);
    const res = checkDiyPicks(picks, { data: this.dataFor(room), kitted: this.kittedFor(room) });
    if (!res || !('ok' in res)) return fail(ERR.BAD_MSG, res && res.detail);
    const kept = freezeDiy(res.picks);
    const cs = this.settingsCs(room, session.playerId);
    session.diy = kept;
    session.diyCs = cs;
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.diy = kept; seat.diyCs = cs; }
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /**
   * room.skins (docs/SKINS.md): store the appearances this player chose for their operators, on the session and the
   * seat, and hand them to a running match. A waiting room is shown a changed map (room.state seats[].skins: its seat
   * cards wear them — header 干员皮肤).
   *
   * Unlike room.loadout there is no phase gate. The loadout is frozen at INFO_CHECK because it changes what a unit
   * *does*; a skin changes only what it looks like, and it is public — a teammate switching model mid-match is
   * harmless, and the next `m.public` broadcast carries it to everyone.
   */
  skins(session, { skins }) {
    const room = this.roomOf(session);
    const ids = operatorCharIds(this.dataFor(room));
    const kept = freezeSkins(skins, (id) => ids.has(id));
    if (!kept) return fail(ERR.BAD_MSG, 'bad skin selection');
    session.skins = kept;
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) {
      const changed = !sameSkins(seat.skins, kept);
      seat.skins = kept;
      // the waiting room's seat cards wear them (room.state seats[].skins, header); a match shows them in its m.public
      if (changed && !room.match) this.broadcastState(room);
    }
    if (!room.match || !seat) return OK;
    if (typeof room.match.setSkins !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return matchAnswer(this.callMatch(room, 'setSkins', session.playerId, kept));
  }

  /**
   * 名片干员 (room.card): the operator whose portrait fills the player's seat card — a visible charId of the room's
   * chess.json (the server's outside a room), '' for none. Kept on the session and the seat; a change is broadcast to the room.
   * Cosmetic: accepted in any phase, never touches a match.
   */
  card(session, { charId }) {
    const room = this.roomOf(session);
    if (charId && !chessCharIds(this.dataFor(room)).has(charId)) return fail(ERR.BAD_MSG, 'unknown operator');
    session.card = charId || null;
    const seat = room ? room.seatOf(session.playerId) : null;
    if (seat && seat.card !== session.card) {
      seat.card = session.card;
      this.broadcastState(room);
    }
    return OK;
  }

  /**
   * The game data of a room's content (header "Gameplay plugins", "Official versions"): its content set's, else its
   * version's — outside a room, the server's default version's —, else the server's. Another version's data that cannot
   * be read is logged and nothing (every check then refuses), never 第二期下半's.
   * @param {Room | null} room
   */
  dataFor(room) {
    if (room?.modded) {
      try {
        const d = this.plugins?.dataOf?.(room.content.cs);
        if (d) return d;
      } catch (e) { this.log.error(`[lobby] ${room.code} content data failed`, e); }
    }
    const v = room ? room.version : this.defaultVersion();
    if (v !== DEFAULT_VERSION) {
      try {
        const d = this.versions?.data(v);
        if (d) return d;
        this.warnOnce(`[lobby] the data of ${v} is not available`);
      } catch (e) { this.log.error(`[lobby] ${room?.code ?? '----'} the data of ${v} failed`, e); }
      return Object.freeze({});
    }
    return this.safeData();
  }

  /** The operators a 自选 slot may field in a room (its content set's list, else the vanilla one). @param {Room | null} room */
  kittedFor(room) {
    if (room?.modded) {
      try {
        const k = this.plugins?.kittedOf?.(room.content.cs);
        if (Array.isArray(k)) return k;
      } catch (e) { this.log.error(`[lobby] ${room.code} content 自选 list failed`, e); }
    }
    return KITTED_CHARS;
  }

  /**
   * The content a setting stored now is checked for: the room's cs, else (outside a room) the server's default version's
   * — the vanilla one unless the server's default is another version. @param {Room | null} room
   */
  csOf(room) { return room?.content?.cs ?? this.baseContent(this.defaultVersion())?.cs ?? this.vanilla?.cs ?? null; }

  /**
   * The stamp of a setting a player sends now (loadout / ownership / diy): csOf(room) — but in a room whose pages must
   * load its content (needsContent) only once the sender's page reported that content ready; before, UNVERIFIED_CS: the
   * page may still show another version's data, whose chess ids name other operators (header "Official versions").
   * @param {Room | null} room @param {string} playerId
   */
  settingsCs(room, playerId) {
    if (!room || !room.needsContent) return this.csOf(room);
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    return seat && /** @type {any} */ (seat).content === 'ready' ? this.csOf(room) : UNVERIFIED_CS;
  }

  /**
   * The data a setting stamped with `cs` was checked against: the vanilla data, a version's, a content set's — null when
   * none is known (an unverified stamp, a set no longer kept). @param {string | null} cs
   */
  dataOfCs(cs) {
    if (!cs || cs === UNVERIFIED_CS) return null;
    if (this.vanilla && cs === this.vanilla.cs) return this.safeData();
    try {
      const v = this.versions?.dataOfCs?.(cs);
      if (v) return v;
      const p = this.plugins?.dataOf?.(cs);
      if (p) return p;
    } catch (e) { this.log.error(`[lobby] the data of content ${String(cs).slice(0, 8)} failed`, e); }
    return null;
  }

  /**
   * A human seat's stored settings for a match of `room` (header "Gameplay plugins", the design study's §6.9): kept as
   * they are when they were checked for the room's content; filtered to its data otherwise — an id it does not know is
   * dropped, the rest kept (never the whole setting refused). A loadout or 干员持有 list checked for another data set also
   * loses every chess id whose operator (charId) differs between the two (header "Official versions": chess ids are
   * reused across versions); in a room of another version than 第二期下半, one whose data is unknown (an unverified
   * stamp) is dropped whole.
   * @param {Room} room @param {Seat} s @param {Readonly<Record<string, any>>} data
   */
  seatSettings(room, s, data) {
    const cs = this.csOf(room);
    const vanillaCs = this.vanilla?.cs ?? null;
    const other = (checked) => !!cs && (checked ?? vanillaCs) !== cs;
    const versioned = room.version !== DEFAULT_VERSION;
    let loadout = s.loadout || null;
    let ops = s.ops || null;
    let notOwned = s.notOwned || null;
    let diy = s.diy || null;
    const chess = (id) => lookup('chess', id, data);
    /** the chess ids of `from` whose operator is the room data's too (null `from`: every id) */
    const sameOperator = (from, id) => !from || (lookup('chess', id, from)?.charId ?? null) === (chess(id)?.charId ?? undefined);
    if (loadout && other(s.loadoutCs)) {
      const from = this.dataOfCs(s.loadoutCs ?? vanillaCs);
      const keep = {};
      if (from || !versioned) {
        for (const [id, e] of Object.entries(loadout)) {
          if (!sameOperator(from, id)) continue;
          const r = checkLoadout({ [id]: { skill: e.skill, ...(e.module != null ? { module: e.module } : {}) } }, chess);
          if (r && !r.error && r.loadout[id]) keep[id] = r.loadout[id];
        }
      }
      loadout = freezeLoadout(keep);
      const ids = opsCharIds(data);
      const changes = (x) => charPotentialChanges(data, x);
      const keepOps = {};
      for (const [id, e] of Object.entries(ops || {})) {
        // a 潜能 that changes nothing on this content's operator (a plugin's char_x_ without a curve) is dropped, its 练度
        // kept — as the page's sanitizeOps does (public/js/ui/loadoutModel.js)
        const one = changes(id) === false ? { cultivate: e.cultivate } : { potential: e.potential, cultivate: e.cultivate };
        const r = checkLoadoutOps({ [id]: one }, (x) => ids.has(x), changes);
        if (r && !r.error && r.ops[id]) keepOps[id] = r.ops[id];
      }
      ops = freezeOps(keepOps);
    }
    if (notOwned && other(s.notOwnedCs)) {
      const from = this.dataOfCs(s.notOwnedCs ?? vanillaCs);
      const r = from || !versioned ? checkNotOwned(notOwned.filter((id) => sameOperator(from, id)), chess) : null;
      notOwned = r && !r.error ? Object.freeze(r.notOwned.slice()) : null;
    }
    if (diy && other(s.diyCs)) {
      const r = checkDiyPicks({ ...diy }, { data, kitted: this.kittedFor(room) });
      diy = r && 'ok' in r ? freezeDiy(r.picks) : null;
    }
    // 干员皮肤 (docs/SKINS.md): the skinId lives in a cosmetic overlay, not the content set, but the KEY is an operator
    // of this room. A charId the content does not have is dropped; a map that is no longer a plain charId→skinId
    // selection is left off the seat rather than handed to the match.
    let skins = null;
    if (s.skins && typeof s.skins === 'object') {
      const ids = operatorCharIds(data);
      const res = checkSkinSelection(s.skins, (id) => ids.has(id));
      if (res.ok) skins = Object.freeze({ ...res.skins });
    }
    return { loadout, ops, notOwned, diy, skins };
  }

  /**
   * Extra fields of every `welcome` (net.js): the operators a 自选 slot may field (shared/diy.js `kitted`) and the
   * server's content identity (header "Content identity").
   */
  welcomeInfo() {
    let info;
    if (!this.vanilla) info = { diyKitted: KITTED_CHARS };
    else {
      let n;
      try { n = Number(this.plugins?.unofficial?.()) || 0; } catch { n = 0; }
      info = { diyKitted: KITTED_CHARS, content: n > 0 ? { vanilla: this.vanilla.cs, plugins: n } : { vanilla: this.vanilla.cs } };
      // Catalogue metadata, never part of a room or match; omitted when no loaded plugin publishes a notice.
      if (this.plugins?.hasNotices?.()) info.content.notices = true;
    }
    // the official versions (header "Official versions"): only when the server offers more than 第二期下半, so a
    // welcome from a server narrowed to that version alone stays without `versions`
    let versions = null;
    try { versions = this.versions?.welcome?.() || null; } catch (e) { this.log.error('[lobby] the versions list failed', e); }
    if (versions) info.versions = versions;
    // Omitted when the switch is off, so a welcome from a normal server stays identical.
    if (this.testEnabled === true) info.testMode = true;
    return info;
  }

  // ---------------------------------------------------------------------------------------------------
  // Match wiring
  // ---------------------------------------------------------------------------------------------------

  /** @param {Room} room @param {string | null} [key] per-network limit key of the starter */
  startMatch(room, key = null) {
    if (room.matchmaking) {
      room.matchmaking = false;
      room.matchmakingAt = 0;
      room.matchmakingStartedAt = 0;
      notifyPartyLeave(room);
    }
    if (room.test && !this.testEnabled) return fail(ERR.TEST_DISABLED);
    // another official version's match runs in that version's match host — never here, where every module singleton
    // holds 第二期下半's data (header "Official versions"); a test that gave its own MatchClass runs it in place
    const versioned = room.version !== DEFAULT_VERSION;
    if (versioned && !this.versionHosts && this.MatchClass === DefaultMatch) {
      this.log.error(`[lobby] ${room.code} has no match host for ${room.version}`);
      return fail(ERR.INTERNAL, 'no match host for this version');
    }
    // (room.start refuses during a vote; a start from elsewhere voids it)
    if (room.versionVote) this.voidVersionVote(room, 'members');
    const host = room.seatOf(room.hostId);
    if (host) host.ready = true;
    // the room's data: its content set's in a room with gameplay plugins (header "Gameplay plugins")
    const data = this.dataFor(room);
    const seats = room.seats.filter(Boolean).map((s) => {
      // a setting checked for another content is filtered to this room's data (header "Gameplay plugins")
      const own = s.isBot ? null : this.seatSettings(room, s, data);
      return {
        seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected,
        // DESIGN §16: the human's checked operator loadout and (0.2.2) per-operator 潜能 / 练度 (bots fight with the defaults)
        loadout: own ? own.loadout : null,
        ops: own ? own.ops : null,
        // 0.2.0 补位: the chess the human marked as not owned (bots own every operator)
        notOwned: own ? own.notOwned : null,
        // 0.2.0 自选编队: the human's checked DIY picks (bots field no 自选 piece [ASSUMED])
        diy: own ? own.diy : null,
        // 干员皮肤 (docs/SKINS.md): the appearances the human wears, keyed by operator charId (bots always default)
        skins: own ? own.skins : null,
      };
    });
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null, results: new Map() };
    let seed = 0;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    const modded = room.modded;
    try {
      const opts = {
        roomCode: room.code,
        mode: room.mode,
        difficulty: room.difficulty,
        // a plugin mode the host chose (header "Gameplay plugins"), else the official mode of the difficulty
        modeId: room.content?.modeId || modeIdFor(room.mode, room.difficulty),
        // 「AI 队友最后选择」 (GitHub #338): fixed for the match
        aiPicksLast: room.mode !== 'solo' && room.aiPicksLast === true,
        seats,
        // the spectator seats (header): watched like eliminated players, never players
        spectators: room.spectators.map((s) => s.playerId),
        // 隐身观战者（管理员）：同样要能被 Match 当作观察者，
        // 否则开局后才进来的 hidden spectator 收不到 m.public（会卡在「正在进入模拟…」）。
        hiddenSpectators: (Array.isArray(room.hiddenSpectators) ? room.hiddenSpectators : []).map((s) => s.playerId),
        // the room's host: the current executor of a delegated bot layout rehearsal (DESIGN §14; setHost follows a
        // migration while the match runs)
        hostId: room.hostId,
        // only a room created as a test room; a normal match opts object does not grow a test key
        ...(room.test === true ? { test: true } : {}),
        seed,
        // the room's match number: with the seed it keeps battleIds unique across the room's matches (DESIGN §14)
        matchNo: room.matchCount + 1,
        // the room's content hash (header "Content identity"): copied into every BattleSpec; its visual set too (a
        // replay names the art), and with gameplay plugins a b.result must name the room's cs (header "Gameplay plugins")
        ...(room.content ? { cs: room.content.cs } : {}),
        ...(room.content?.vs ? { vs: room.content.vs } : {}),
        ...(modded || versioned ? { requireCs: true } : {}),
        // another official version (header "Official versions"): its registry id; a default room's opts keep their keys
        ...(versioned ? { version: room.version } : {}),
        // 「不限时」 (header): only while the room's flag is on, so a default match's opts keep their keys
        ...(room.mode === 'solo' && room.soloUnlimited === true ? { soloUnlimited: true } : {}),
        // 本服：5–20 人实验房。Match 由 room.experimental 推出 playerCapacity，并在座位数超过容量时抛
        // RangeError（Match.js「seats exceed room capacity」）。之前这里漏传，match 一律按默认 4 人算，
        // 于是只要有第 5 个座位就「服务器内部错误」。普通房不带这个键（保持上游 match 的键集不变）。
        ...(room.mode !== 'solo' && room.experimental ? { experimental: { ...room.experimental } } : {}),
        // The list the lobby just checked the picks with (kittedFor). Vanilla rooms omit it: setDiy stays on
        // KITTED_CHARS, and the worker payload / test journal of a normal match do not grow a key.
        ...(modded ? { kitted: this.kittedFor(room) } : {}),
        ...(room.content?.rules ? { rules: room.content.rules } : {}),
        data,
        log: this.log,
        now: this.now,
        // the server's own simulation pool (server/workers/roomPool.js) for bot rehearsals, when the operator started
        // one: null keeps every rehearsal on this thread, exactly as before (Match.simPool / MatchRehearsal.poolRehearsal)
        ...(!modded && !versioned && this.simPool ? { simPool: this.simPool } : {}),
        send: (playerId, msg, encoded) => (ctx.live ? this.matchSend(room, ctx, playerId, msg, encoded) : false),
        broadcast: (msg, encoded) => { if (ctx.live) this.matchBroadcast(room, ctx, msg, encoded); },
        onEnd: (summary) => this.onMatchEnd(room, ctx, summary),
      };
      // a room with gameplay plugins plays in its content set's match host, a room of another official version in that
      // version's; every other room here, as always
      const match = modded && this.hosts ? this.hosts.create(room.content.cs, opts)
        : versioned && this.versionHosts ? this.versionHosts.create(room.content.cs, opts)
          : new this.MatchClass(opts);
      ctx.match = match;
      room.match = match;
      room.matchCtx = ctx;
      room.matchKey = key;
      room.replay = null;
      room.matchCount++;
      this.log.info(`[lobby] ${room.code} match #${room.matchCount} starting (${room.mode}/${room.difficulty}, ${seats.length} seats, seed ${seed}${room.test ? ', test' : ''}${modded ? `, content ${room.content.cs.slice(0, 8)}${match.hosted ? ' in its match host' : ''}` : ''}${versioned ? `, version ${room.version}${match.hosted ? ' in its match host' : ''}` : ''})`);
      this.broadcastState(room);
      match.start();
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match failed to start`, e);
      if (room.matchCtx === ctx) {
        resetAiTakeover(room);
        room.match = null; room.matchCtx = null; room.matchKey = null;
      }
      this.disposeMatchCtx(ctx);
      this.broadcastState(room);
      // the match hosts refuse one content set more than they run (PLUGIN_BUSY: server/match/host/index.js)
      return fail(e && isErrCode(e.code) ? e.code : ERR.INTERNAL, 'match failed to start');
    }
    return OK;
  }

  /** onEnd callback: return the room to LOBBY and dispose the match on the next macrotask. */
  onMatchEnd(room, ctx, summary) {
    if (ctx.ended || !ctx.live || room.matchCtx !== ctx || room.disposed) return;
    ctx.ended = true;
    room.lastSummary = summary ?? null;
    resetAiTakeover(room);
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = this.buildReplay(room, ctx);
    setImmediate(() => this.disposeMatchCtx(ctx));
    // 本服：对局结束后重新开始「15 分钟未开始对局就解散」的计时。
    // 以前这里什么都没做，解散计时一直按 room.createdAt（建房那一刻）算，
    // 而 lastMatchEndAt 只被读取、从来没被赋值 —— 于是一局打完回到房间后，
    // 剩余时间早就耗光，房间立刻被判超时解散（玩家反馈「对局结束房间自动解散 / 房间时间到了」）。
    // 现在：对局一结束就把计时基准推到「现在」，玩家有完整的 15 分钟再来一局。
    room.lastMatchEndAt = this.now();
    room.createdAt = room.lastMatchEndAt;
    // a match of gameplay plugins, or of an official version, whose match host stopped (header "Gameplay plugins",
    // "Official versions"; its members were told: proxy.js)
    const why = summary && typeof summary.reason === 'string' && /^(?:plugin|version)-/.test(summary.reason) ? ` (${summary.reason}${summary.detail ? `: ${summary.detail}` : ''})` : '';
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ended${why}`);
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.isBot) continue;
      if (s.left) { room.seats[i] = null; continue; }
      s.ready = false;
      if (!s.connected) this.startGrace(room, s);
    }
    for (const s of room.spectators) if (!s.connected) this.startGrace(room, s);
    const host = room.hostId ? room.seatOf(room.hostId) : null;
    if (!host || host.isBot || host.left) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else {
      this.broadcastState(room);
      // its plugins changed on disk during the match: the host can apply them again now
      if (room.pluginsChanged) this.tellPluginsChanged(room);
    }
  }

  /** Match unicast; m.result frames are also kept for the replay. */
  matchSend(room, ctx, playerId, msg, encoded = null) {
    if (msg && msg.t === 'm.result') {
      const data = encoded ?? encode(msg);
      if (data != null) ctx.results.set(playerId, data);
    }
    return this.sendToPlayer(room, playerId, msg, encoded);
  }

  /** Match broadcast; the latest m.public and a broadcast m.result are also kept for the replay. */
  matchBroadcast(room, ctx, msg, encoded = null) {
    if (msg.t === 'm.public' && reconcileAiTakeover(this, room)) this.broadcastState(room);
    // 本服：把对局进度回填到 room，供后台/控制台的「回合」列显示。
    // 以前 room.liveRound / livePhase 从来没被赋值，持久化时永远是 0，
    // 后台只能显示「准备中」（玩家反馈「看不到玩家所在的回合」）。
    // 注意 m.public 帧是扁平的：{ t:'m.public', phase, round, players, ... }，
    // round / phase 直接在顶层（match/match/views.js publicView）。
    if (msg.t === 'm.public') {
      const r = Number(msg.round);
      if (Number.isSafeInteger(r) && r >= 0) room.liveRound = r;
      if (typeof msg.phase === 'string') room.livePhase = msg.phase;
    }
    const data = this.broadcastRoom(room, msg, encoded);
    if (data == null) return;
    if (msg.t === 'm.public') ctx.lastPublic = data;
    else if (msg.t === 'm.result') ctx.sharedResult = data;
  }

  /**
   * Replay record for the humans still seated when a match ends (null when the match produced no m.result,
   * e.g. it was abandoned: those clients then see "simulation closed").
   * @param {Room} room @returns {Room['replay']}
   */
  buildReplay(room, ctx) {
    const frames = new Map();
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const frame = ctx.results.get(s.playerId) || ctx.sharedResult;
      if (frame) frames.set(s.playerId, frame);
    }
    if (frames.size === 0) return null;
    return { publicFrame: ctx.lastPublic, frames, pending: new Set(frames.keys()) };
  }

  /** The replay frames still owed to a player (null when they moved on). @returns {string[] | null} */
  replayFor(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.has(playerId)) return null;
    return [r.publicFrame, r.frames.get(playerId)].filter(Boolean);
  }

  /** The player moved on from the result screen (acted in the room, left): stop replaying it. */
  dropReplay(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.delete(playerId)) return;
    r.frames.delete(playerId);
    if (r.pending.size === 0) room.replay = null;
  }

  /**
   * The heavy part of a resync — full match state (match.onReconnect) or, back in LOBBY, the result replay.
   * Immediate after a (re)connect; for repeated hellos on a live socket at most once per resyncMinGapMs
   * (requests inside the window coalesce into one deferred resync).
   * @param {import('./net.js').Session} session @param {boolean} coalesce
   */
  resync(session, coalesce) {
    const pid = session.playerId;
    if (coalesce) {
      if (this.resyncTimers.has(pid)) return; // the scheduled resync answers this request too
      const wait = (Number.isFinite(session.resyncAt) ? session.resyncAt : -Infinity) + this.opts.resyncMinGapMs - this.now();
      if (wait > 0) {
        const t = setTimeout(() => { this.resyncTimers.delete(pid); this.runResync(session); }, wait);
        t.unref?.();
        this.resyncTimers.set(pid, t);
        return;
      }
    } else {
      this.clearResync(pid);
    }
    this.runResync(session);
  }

  /** @param {import('./net.js').Session} session */
  runResync(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    const room = this.roomOf(session);
    if (!room) return;
    // in order with the room's messages when its match runs in a match host (header "Gameplay plugins")
    if (this.queuedRoom(session)) { this.queueEvent(room, () => this.resyncNow(session)); return; }
    this.resyncNow(session);
  }

  /** runResync, now. @param {import('./net.js').Session} session */
  resyncNow(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    const room = this.roomOf(session);
    if (!room) return;
    session.resyncAt = this.now();
    if (room.match) {
      this.callMatch(room, room.spectatorOf(session.playerId) ? 'addSpectator' : 'onReconnect', session.playerId);
      return;
    }
    const frames = this.replayFor(room, session.playerId);
    if (frames) for (const frame of frames) sendRaw(session.ws, frame);
  }

  clearResync(playerId) {
    const t = this.resyncTimers.get(playerId);
    if (t) { clearTimeout(t); this.resyncTimers.delete(playerId); }
  }

  /** Log a per-network limit refusal without letting a refusal loop flood the log. */
  limitWarn(text) {
    const now = this.now();
    if (now - this.limitLog.at < 10_000) { this.limitLog.suppressed++; return; }
    const more = this.limitLog.suppressed ? ` (+${this.limitLog.suppressed} similar refusals)` : '';
    this.limitLog.at = now;
    this.limitLog.suppressed = 0;
    this.log.warn(`[lobby] ${text}${more}`);
  }

  /** A warning logged once per text (the default plugins that cannot be applied …). @param {string} line */
  warnOnce(line) {
    if (this.told.has(line)) return;
    if (this.told.size < 256) this.told.add(line);
    this.log.warn(line);
  }

  /** 某个网络地址在所有房间里的 AI 队友总数（maxBotsPerAddr）。 */
  countBots(key) {
    let n = 0;
    for (const r of this.rooms.values()) {
      if (r.disposed || r.ownerKey !== key) continue;
      for (const s of r.seats) if (s && s.isBot) n++;
    }
    return n;
  }
  /** Number of rooms matching a predicate. */
  countRooms(pred) {
    let n = 0;
    for (const r of this.rooms.values()) if (pred(r)) n++;
    return n;
  }

  /**
   * Route a 'g.*' intent or a 'b.*' report (server/net.js) to the running match — on the room's queue when its match runs
   * in a match host (header "Gameplay plugins").
   */
  routeGame(session, msg) {
    const room = this.queuedRoom(session);
    return room ? this.serial(room, () => this.routeGameNow(session, msg)) : this.routeGameNow(session, msg);
  }

  /** routeGame, now. */
  routeGameNow(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (msg.t === 'g.test') {
      if (!this.testEnabled) return fail(ERR.TEST_DISABLED);
      if (room.test !== true) return fail(ERR.TEST_FORBIDDEN);
    }
    if (!room.match) return fail(ERR.WRONG_PHASE, 'no running match');
    if (msg.t === 'g.leave') {
      this.removeMember(room, session.playerId);
      return OK;
    }
    // a spectator only watches (header): nothing else of it ever reaches the match.
    // 隐身观战（hiddenSpectators）同样是「只能看」：以前只拦了 spectators，
    // 隐身观战者的其它 g.* 会被直接转发给对局，等于能替玩家操作。
    if (msg.t !== 'g.watch' && !(room.test && msg.t === 'g.test') && room.watcherOf(session.playerId)) return fail(ERR.SPECTATOR);
    let res;
    try {
      res = room.match.handle(session.playerId, msg);
      if (reconcileAiTakeover(this, room)) this.broadcastState(room);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (res && typeof res.then === 'function') {
      // a match in a match host answers later (header "Gameplay plugins"): the reply waits for it
      if (room.match?.hosted === true) {
        return Promise.resolve(res).then((r) => matchAnswer(r), (e) => {
          this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e);
          return fail(ERR.INTERNAL);
        });
      }
      // Contract violation (handle must be synchronous): never let the rejection go unhandled.
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) returned a Promise; it must be synchronous`);
      Promise.resolve(res).catch((e) => this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e));
      return OK;
    }
    return matchAnswer(res);
  }

  /** Call an optional match hook without letting it throw. onLeave falls back to onDisconnect. */
  callMatch(room, method, ...args) {
    const m = room.match;
    if (!m) return undefined;
    let fn = m[method];
    if (typeof fn !== 'function' && method === 'onLeave') fn = m.onDisconnect;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(m, args);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.${method} threw`, e);
      return undefined;
    }
  }

  disposeMatchCtx(ctx) {
    if (ctx.disposed) return;
    ctx.disposed = true;
    ctx.live = false;
    try { ctx.match?.dispose?.(); } catch (e) { this.log.error('[lobby] match.dispose threw', e); }
  }

  safeData() {
    try { return this.getData(); } catch (e) { this.log.error('[lobby] getData failed', e); return Object.freeze({}); }
  }

  /**
   * How long a dropped solo run stays resumable (ms): the option, else data singleReconnectTime — the room's version's
   * (header "Official versions": 第一期 has none, so the 24 h figure below) —, else 24 h. The 24 h fallback is a
   * carried-over convenience [ASSUMED]: 第一期's constData never gained singleReconnectTime, and M2 did not add it.
   * The code path is unchanged (§35.23.10). It is not official 第一期 data, and it is not "because the solo is untimed"
   * — a 第一期 solo is timed unless the room's 「不限时」 is on.
   * @param {Room | null} [room]
   */
  soloResumeWindowMs(room = null) {
    const o = this.opts.soloReconnectWindowMs;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    const data = room && room.version !== DEFAULT_VERSION ? this.dataFor(room) : this.safeData();
    const sec = data?.config?.constants?.singleReconnectTime;
    return (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : SOLO_RECONNECT_FALLBACK_SEC) * 1000;
  }

  // ---------------------------------------------------------------------------------------------------
  // Membership helpers
  // ---------------------------------------------------------------------------------------------------

  /** The session's current room (self-heals stale `roomCode`). @returns {Room | null} */
  roomOf(session) {
    if (!session.roomCode) return null;
    const room = this.rooms.get(session.roomCode);
    const seat = room ? room.seatOf(session.playerId) : null;
    if (room && !seat && room.spectatorOf(session.playerId)) return room; // a spectator seat
    // 隐身观战（adminWatch）：只存在于 hiddenSpectators，既不是座位也不在 spectators 里。
    // 以前这里漏了它，roomCode 会被当成「无效」清成 null —— 于是 g.watch 走进
    // routeGameNow → roomOf → NOT_IN_ROOM，观战者看到的画面就永远停在自动打开的 P1 上，
    // 点谁都不换（玩家反馈「隐身观战不能切换观战目标」）。
    if (room && !seat && room.hiddenSpectatorOf(session.playerId)) return room;
    if (!room || !seat || seat.left || seat.isBot) { session.roomCode = null; return null; }
    return room;
  }

  /**
   * A human seat for `session` in `room`. The card is checked against the room's operators (header 名片干员): one the
   * room's content lacks is left off the seat, never cleared from the session.
   * @param {number} idx @param {any} session @param {Room} room
   * @returns {Seat}
   */
  /**
   * The account may hold at most one seat (player or spectator) across all rooms.
   *
   * 遗留座位（stale）处理：玩家刷新页面 / 换设备 / 断线重连后会拿到**新的 playerId**，
   * 而旧房间里的座位还挂着同一个 accountId 和旧的 playerId。以前这里只比 playerId，
   * 于是把自己遗留的座位当成「别人的房间」拒绝建房，可玩家界面上根本看不到那个房间，
   * 也没有入口离开 —— 表现就是「对局结束 / 中途退出后不能再创建房间」，怎么点都失败，
   * 只能等 15 分钟房间超时解散。（玩家雾灯等人反馈的就是这个。）
   *
   * 现在：同一账号的座位如果是**旧会话**（playerId 不同）且那个会话已经断线/不存在，
   * 就当作遗留座位，交给调用方清理掉再继续，不再拦截。
   * `stale` 在返回值里标明，方便调用方决定怎么处理。
   */
  accountRoomConflict(session) {
    const accountId = session.accountId;
    if (!accountId) return null;
    // 座位上的 accountId 可能是 null：建房/落座时 hello 里还没带账号令牌（令牌是异步补发的），
    // 而 humanSeat() 只写一次，之后没人回填。这时同一个账号可以"坐在座位上 + 再开一个旁观席"，
    // 因为下面这条 != 判断直接把这排除了。实测踩到：玩家新开标签页没回到对局，
    // 反而看到旧标签页变成旁观状态。
    // 兜底：座位没有 accountId 时，用 playerId 反查会话的 accountId 再比对。
    const seatAccountId = (seat) => {
      if (seat.accountId) return String(seat.accountId);
      const s = this.registry.byId(seat.playerId);
      return s && s.accountId ? String(s.accountId) : null;
    };
    for (const room of this.rooms.values()) {
      if (!room || room.disposed) continue;
      for (const seat of room.seats) {
        if (!seat || seat.isBot || seat.left) continue;
        if (seat.playerId === session.playerId) continue;
        if (seatAccountId(seat) !== accountId) continue;
        // 同一账号的另一处座位：判断是不是「已经没人的旧会话」
        const old = this.registry.byId(seat.playerId);
        const stale = !old || old.connected !== true;
        return { room, kind: 'player', seat, stale };
      }
      for (const spec of room.spectators) {
        if (!spec || spec.playerId === session.playerId) continue;
        if (seatAccountId(spec) !== accountId) continue;
        const old = this.registry.byId(spec.playerId);
        const stale = !old || old.connected !== true;
        return { room, kind: 'spectator', seat: spec, stale };
      }
    }
    return null;
  }

  /**
   * 清掉同一账号遗留的旧座位（刷新页面 / 换设备 / 断线后残留）。
   * 返回被清理的房间码列表，便于日志。房间因此变空就照常解散。
   *
   * ★ 判定必须保守，否则会误删正在使用的房间：
   *   之前只看 registry.byId(seat.playerId) 是否为 null/已断线，
   *   但 registry 查不到 ≠ 这个座位真的没人用了（会话可能还没登记、或刚重连）。
   *   实测踩过：WS 建好 4 个房、同一批账号又建 4 个房时，
   *   旧房被误判为「遗留」直接解散，而匹配池里还记着旧房号，
   *   于是成局后玩家进不去 —— 表现就是「卡在匹配界面」。
   *
   * 现在要求同时满足才算遗留：
   *   ① 座位自己标记为未连接（seat.connected === false，由断线处理写入）
   *   ② registry 里确实查不到这个会话，或该会话已断开
   * 任何一条不成立就当作「还在用」，不动它。
   */
  /**
   * 同一账号在一个房间里只允许占**一个**玩家座位。
   *
   * ★ 2026-10-29 事故：房间 DVWE，玩家「山雎」在座位表里出现两次，房主连踢两次才清干净
   *   （日志里 `DVWE 山雎 removed by the host` 出现两条，相隔 4 秒）。
   *
   *   成因是「清理只清一个，查询也只返回一个」：
   *   - accountRoomConflict() 找到第一个匹配座位就 return，房间里的第二个座位永远看不见；
   *   - dropStaleAccountSeats() 要求 `seat.accountId === accountId` 才清，而 humanSeat()
   *     只在落座那一刻写一次 accountId —— 玩家落座时 hello 还没带账号令牌（令牌是异步补发的），
   *     座位 accountId 就是 null。这种座位既不被当成「同账号」，也过不了清理的账号比对，
   *     于是变成永久孤儿；玩家下次进来（新 playerId）又占一个新座位 → 一个人两个座位。
   *
   *   这里做一次全量收敛：同一账号（或同一 playerId）在同一房间里，只保留一个座位。
   *   保留优先级：正在连接 > 座位号小；对局进行中一律不删（重启/断线不能把人踢出对局）。
   * @param {Room} room @param {{ accountId?: string|null, playerId?: string }} session
   * @returns {number} 清掉的座位数
   */
  dedupeSeats(room, session) {
    if (!room || room.disposed) return 0;
    const accountId = session && session.accountId ? String(session.accountId) : null;
    const playerId = session && session.playerId ? session.playerId : null;
    // ★ 只有「已登录账号」才做去重。
    //   游客 / 测试里没带 accountId 的会话一律不动 —— 它们本来就可能多人共用一个
    //   空 accountId，凭它去重会把队友顶掉（2026-10-29：这条曾让 5 个 lobby 测试全红）。
    if (!accountId) return 0;
    // 对局进行中：绝不动座位（与 dropStaleAccountSeats 的保护一致）
    if (room.match || room.matchCtx) return 0;
    /**
     * 这个座位是「同一账号的**另一个**会话」吗？
     * 当前会话自己的座位（playerId 相同）必须排除，否则会把本人座位删掉。
     */
    const otherSessionOfSameAccount = (seat) => {
      if (!seat || seat.isBot || seat.left) return false;
      if (playerId && seat.playerId === playerId) return false;   // 自己，保留
      if (seat.accountId && String(seat.accountId) === accountId) return true;
      // 座位 accountId 为空时反查会话（humanSeat 只在落座时写过一次，之后没人回填）。
      // 这里也要求查到的会话 accountId 一致，绝不靠空值兜底。
      const s = this.registry.byId(seat.playerId);
      return !!(s && s.accountId && String(s.accountId) === accountId);
    };
    const held = [];
    for (let i = 0; i < room.seats.length; i++) {
      if (otherSessionOfSameAccount(room.seats[i])) held.push(i);
    }
    // 当前会话自己在这个房间里有座位吗？有就保留它；没有再决定留哪个旧的。
    const mine = playerId ? room.seatOf(playerId) : null;
    if (mine) {
      // 自己有座位：把同账号的其它旧座位全部清掉
    } else if (held.length <= 1) {
      return 0;   // 自己还没落座，且旧座位至多一个 —— 交给前面的 takeover 分支处理
    }
    // 保留一个：优先正在连接的，其次座位号小的
    held.sort((a, b) => {
      const ca = room.seats[a].connected === true ? 0 : 1;
      const cb = room.seats[b].connected === true ? 0 : 1;
      return ca - cb || a - b;
    });
    let keep = mine ? mine.seat : held[0];
    const targets = mine ? held : held.slice(1);
    let removed = 0;
    for (const i of targets) {
      const seat = room.seats[i];
      room.seats[i] = null;
      removed++;
      this.log.info(`[lobby] ${room.code} 清除同账号重复座位 seat ${i}（${seat.name}），保留 seat ${keep}`);
    }
    if (removed) {
      if (room.hostId && !room.seatOf(room.hostId)) this.migrateHost(room);
      if (!room.activeHumans().some((s) => s && s.guest !== true)) this.disposeRoom(room, 'empty');
      else this.broadcastState(room);
    }
    return removed;
  }

  dropStaleAccountSeats(session) {
    const accountId = session.accountId;
    if (!accountId) return [];
    const cleaned = [];
    for (const room of [...this.rooms.values()]) {
      if (!room || room.disposed) continue;
      for (let i = 0; i < room.seats.length; i++) {
        const seat = room.seats[i];
        if (!seat || seat.isBot || seat.left) continue;
        if (seat.accountId !== accountId || seat.playerId === session.playerId) continue;
        // ① 座位仍然标记为连接中：这个人还在用，绝不清理
        if (seat.connected !== false) continue;
        // ② 会话仍然存活：也不清理
        const old = this.registry.byId(seat.playerId);
        if (old && old.connected === true) continue;
        // ③ ★ 2026-10-28：对局进行中的座位绝不清理 —— 与 startGrace 的保护一致。
        //
        //   当天 nginx 重启（改分流规则）把所有人的 socket 都断了。玩家重连时拿到的是
        //   **新的 playerId**，于是这里把旧座位判成「同账号遗留」，删掉。
        //   实测事故：VAHS（node-1）里 4 人房的 seat 3 被删，那位玩家对自己座位
        //   做任何操作都报「你不在房间中」，而 UI 上他还看着 4 个队友。
        //
        //   宽限期（startGrace）本来就有 if (room.match) return —— 对局中不踢人。
        //   这个函数绕过了那一层，现在补回来：只要对局在跑，座位就留着，
        //   让人自己重连回来（他会拿到原座位，因为 playerId 在接管时会被换回）。
        if (room.match || room.matchCtx) continue;
        room.seats[i] = null;
        cleaned.push(room.code);
        this.log.info(`[lobby] ${room.code} 清理账号 ${accountId} 的遗留座位（旧会话 ${seat.playerId}，未连接）`);
        if (room.hostId === seat.playerId || !room.hostId) this.migrateHost(room);
        // 同 removeMember：没有注册玩家了（空房或只剩游客）就解散
        if (!room.activeHumans().some((s) => s && s.guest !== true)) this.disposeRoom(room, 'empty');
        else this.broadcastState(room);
      }
      for (let i = room.spectators.length - 1; i >= 0; i--) {
        const spec = room.spectators[i];
        if (!spec || spec.accountId !== accountId || spec.playerId === session.playerId) continue;
        const old = this.registry.byId(spec.playerId);
        if (old && old.connected === true) continue;
        room.spectators.splice(i, 1);
        if (!cleaned.includes(room.code)) cleaned.push(room.code);
        if (!room.disposed) this.broadcastState(room);
      }
    }
    return cleaned;
  }

  humanSeat(idx, session, room) {
    const card = session.card && chessCharIds(this.dataFor(room)).has(session.card) ? session.card : null;
    return {
      seat: idx, playerId: session.playerId, name: session.name, tag: session.tag || null, accountId: session.accountId || null, isBot: false, ready: false, connected: session.connected, left: false,
      // 游客标记：游客只能游玩/旁观，不能当选房主（migrateHost 用它排除游客）。
      guest: session.guest === true || !session.accountId,
      // 后台/服主标记：只用于控制台把「玩家」显示成「管理员」，不参与任何规则判定。
      // 判定与服务端的 session.admin 完全一致（adminToken 或账号角色）。
      admin: session.admin === true,
      loadout: session.loadout || null,
      ops: session.ops || null,
      notOwned: session.notOwned || null,
      diy: session.diy || null,
      // 干员皮肤 (docs/SKINS.md): the appearances this player wears, keyed by operator charId (PUBLIC: the match
      // publishes them to teammates)
      skins: session.skins || null,
      // 名片干员 (room.card): the operator on this player's seat card (PUBLIC: room.state seats[].card)
      card,
      // the content each was checked for (header "Gameplay plugins": filtered at the match start when it is another)
      loadoutCs: session.loadoutCs ?? null,
      notOwnedCs: session.notOwnedCs ?? null,
      diyCs: session.diyCs ?? null,
    };
  }

  /**
   * Remove a human from a room permanently (leave, grace timeout, expiry, switching rooms).
   * In LOBBY the seat is freed; during a match it is marked departed and match.onLeave is called.
   * @param {Room} room @param {string} playerId
   */
  removeMember(room, playerId) {
    const session = this.registry.byId(playerId);
    if (session && session.roomCode === room.code) session.roomCode = null;
    this.clearGrace(playerId);
    this.dropReplay(room, playerId);
    if (this.freeSpectatorSeat(room, playerId)) return;
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || room.disposed) return;
    if (room.match) {
      seat.left = true;
      seat.connected = false;
      seat.ready = false;
      this.callMatch(room, 'onLeave', playerId);
    } else {
      room.seats[seat.seat] = null;
      // a player seat freed: the version vote is void (header "Official versions")
      if (room.versionVote) this.voidVersionVote(room, 'members');
    }
    if (room.disposed) return; // onLeave may have ended the match and emptied the room
    if (room.hostId === playerId) this.migrateHost(room);
    // 没有注册玩家了（空房，或只剩游客）：解散。
    // 只剩游客时必须解散 —— migrateHost 不再把房主给游客，
    // 留着就是一间没有房主、谁也开不了局的僵尸房。
    if (!room.activeHumans().some((s) => s && s.guest !== true)) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /**
   * Free a spectator seat (removeMember): the match forgets the spectator; never a host change or a disposal — a
   * spectator neither holds the host nor keeps a room alive. @returns {boolean} true when it was a spectator seat
   */
  freeSpectatorSeat(room, playerId) {
    let i = room.spectators.findIndex((s) => s.playerId === playerId);
    let hidden = false;
    if (i < 0) { i = room.hiddenSpectators.findIndex((s) => s.playerId === playerId); hidden = i >= 0; }
    if (i < 0) return false;
    if (hidden) room.hiddenSpectators.splice(i, 1);
    else room.spectators.splice(i, 1);
    if (room.disposed) return true;
    this.callMatch(room, 'removeSpectator', playerId);
    if (!hidden) this.broadcastState(room);
    return true;
  }

  /**
   * Lowest-seat connected human becomes host (else lowest-seat human, else null).
   * 游客永远不继承房主：游客只能游玩/旁观，不能创建同盟模拟房间，自然也不该成为房主
   * （玩家反馈「游客成了房主」）。
   *
   * 以前的写法是：房主退出后房主落到第一个非游客；如果房里只剩游客，
   * 就退回给游客（日志标记 all guests, fallback），理由是「避免房间无主卡住」。
   * 但这样一来游客就拿到了开始对局、调实验选项、踢人、解散房间等房主权限，
   * 违背设计。而且「房间无主会卡住」本来就不成立 —— 房间里已经没有任何注册玩家，
   * 没有人会继续玩，直接解散才是正确的收尾。
   *
   * 现在：房里只剩游客 → 房主置空，房间随即解散（调用方负责）。
   */
  migrateHost(room) {
    const humans = room.activeHumans();
    const nonGuest = humans.filter((s) => s && s.guest !== true);
    const pick = nonGuest.find((s) => s.connected) || nonGuest[0] || null;
    const prev = room.hostId;
    room.hostId = pick ? pick.playerId : null;
    if (pick && prev !== pick.playerId) {
      this.log.info(`[lobby] ${room.code} host → ${pick.name}`);
    }
    if (!pick && humans.length) {
      // 只剩游客：不给房主，房间由调用方解散，别让游客拿到房主权限
      this.log.info(`[lobby] ${room.code} 只剩游客，不给房主（房间将解散）`);
    }
    // 房主换人后重新判定「不自动销毁」：noExpire 只在房主本人是管理员/服主时成立。
    // 管理员建房后离开、房主交给普通玩家，房间必须恢复 15 分钟销毁计时，
    // 否则 adminCreated/noExpire 会一直停在 true，这个房间永远扫不掉（僵尸房）。
    // 反向也成立：普通房主走了、接任的是管理员，则从此刻起不再销毁。
    if (room.hostId !== prev) this.syncNoExpire(room);
    // a host change voids the version vote (header "Official versions") — defensive: while a vote is open (no match) the
    // host only changes by leaving, kick or grace timeout, whose freed seat voided it already (removeMember)
    if (room.hostId !== prev && room.versionVote) this.voidVersionVote(room, 'members');
    // a running match follows the host change: its delegated bot rehearsals fall back to the server and later ones ask
    // the new host (DESIGN §14, Match.setHost)
    if (room.match && room.hostId !== prev) this.callMatch(room, 'setHost', room.hostId);
  }

  /**
   * 按「当前房主是不是管理员」重新设置 adminCreated / noExpire。
   * 只有建房那一刻和房主换人时需要调用；匹配开始后不再改（房间已不属于大厅）。
   * @param {Room} room
   */
  syncNoExpire(room) {
    if (!room || room.match) return;
    // 没有房主（房间里已经没人、即将销毁）：保持原状，不要在这里把 noExpire 抹掉。
    // 房间会紧接着被 disposeRoom('empty') 处理，此时改动只会产生误导性的日志。
    if (!room.hostId) return;
    const session = this.registry.byId(room.hostId);
    const isAdmin = !!(session && session.admin === true);
    const before = room.noExpire === true;
    room.adminCreated = isAdmin;
    room.noExpire = isAdmin;
    // 从「不销毁」切回「计时」时，把起点重置为现在：否则会拿很久以前的 createdAt
    // 去比 15 分钟，房间可能在切回的瞬间就被判定过期直接删掉。
    if (before && !isAdmin) room.createdAt = this.now();
    // adminLeftAt 跟着房主身份走：
    //  —— 新房主是在线管理员：清掉（永久保留生效）
    //  —— 新房主不是管理员（或管理员但不在线）：从现在起计时，否则会拿旧的 adminLeftAt 立刻判定过期
    if (isAdmin && session && session.connected === true) room.adminLeftAt = 0;
    else if (!room.adminLeftAt) room.adminLeftAt = this.now();
    if (before !== isAdmin) {
      this.log?.info?.(`[lobby] ${room.code} noExpire ${before} -> ${isAdmin}`);
    }
  }

  startGrace(room, seat) {
    const playerId = seat.playerId;
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (room.disposed || room.match) return;
      const s = room.seatOf(playerId) || room.spectatorOf(playerId);
      if (!s || s.connected) return;
      const session = this.registry.byId(playerId);
      if (session && session.roomCode === room.code) {
        session.notice = 'timeout';
        session.pendingResult = this.replayFor(room, playerId); // still shown after room.closed on resume
      }
      this.removeMember(room, playerId);
    }, this.opts.lobbyGraceMs);
    t.unref?.();
    this.graceTimers.set(playerId, t);
  }

  clearGrace(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) { clearTimeout(t); this.graceTimers.delete(playerId); }
  }

  /**
   * 本服：强制结束房间当前这一局，但**保留房间**，让玩家留在大厅里可以重新开局。
   *
   * 和 disposeRoom 的区别（这是维护者 2026-10-29 明确要的第二个按钮）：
   *   * disposeRoom      → 房间整个没了，玩家被踢回大厅/首页（room.closed）
   *   * abortMatch       → 只是这一局结束，房间还在、座位还在、玩家还在房间里
   *
   * 走的是和对局自然结束完全一样的收尾路径 onMatchEnd：它会把房间退回大厅状态
   * （match/matchCtx/matchKey 置空）、重置座位 ready、必要时迁移房主、
   * 并把「15 分钟未开始对局就解散」的计时重新推到现在 —— 所以不会因为
   * 「房间创建时间太早」而在结束对局后立刻被解散。
   *
   * 用 summary.reason = 'admin-aborted'：结算界面会据此显示「对局已被管理员终止」，
   * 而不是伪装成一次正常打完的结算。
   *
   * @param {Room} room @param {{ reason?: string }} [opts]
   * @returns {{ ok: true, code: string, wasRunning: boolean } | { ok: false, reason: string }}
   */
  abortMatch(room, { reason = 'admin-aborted' } = {}) {
    if (!room || room.disposed) return { ok: false, reason: 'no_room' };
    const ctx = room.matchCtx;
    // 没有对局在跑：不报错，如实说明（房间可能只是开着没开局）
    if (!ctx || !room.match) return { ok: false, reason: 'no_match' };
    if (ctx.ended || !ctx.live) return { ok: false, reason: 'no_match' };
    const round = Number(room.match.round) || 0;
    this.log.info(`[lobby] ${room.code} match aborted by admin at round ${round}`);
    // 和自然结束同一条路径：房间留下，只是这一局没了
    this.onMatchEnd(room, ctx, { reason: String(reason), detail: 'admin', adminAborted: true });
    // 对局中房间里的玩家就算断着线，也要让他们回来就能看到房间还在
    if (!room.disposed) this.broadcastState(room);
    return { ok: true, code: room.code, wasRunning: true };
  }

  /**
   * Delete a room, detach its members (room.closed unless the room simply emptied) and dispose its match.
   * @param {Room} room @param {string} reason
   */
  disposeRoom(room, reason) {
    if (room.disposed) return;
    room.disposed = true;
    if (this.rooms.get(room.code) === room) { this.trustedRuntime?.event('roomClosed',{room:room.toState(this.now())}); this.rooms.delete(room.code); }
    // an open version vote ends with the room (its timer)
    if (room.versionVote) { clearTimeout(room.versionVote.timer); room.versionVote = null; }
    const ctx = room.matchCtx;
    resetAiTakeover(room);
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = null;
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (s.left || reason === 'empty') continue;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    // spectators did not leave: they are told whatever closed the room (its last human leaving included)
    for (const s of room.spectators) {
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    if (ctx) this.disposeMatchCtx(ctx);
    // the room's visual set and content set are no longer held by it (server/plugins/visualSet.js, contentSets.js)
    this.releaseContent(room.content);
    this.log.info(`[lobby] ${room.code} disposed (${reason})`);
  }

  genCode(yieldingRoom = null) {
    // create() may reuse its caller's sole-human room only after validation; no membership changes here.
    const fixed = this.opts.roomCode || null;
    if (fixed) return this.rooms.has(fixed) && this.rooms.get(fixed) !== yieldingRoom ? null : fixed;
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------------

  /**
   * Connected, non-departed human sessions of a room (room.state, match broadcasts).
   * 包含席位、观战席，以及「隐身观战」的观察者（hiddenSpectators）。
   * 以前这里只遍历 seats + spectators，隐身观战者只收到 room.state、
   * 收不到任何对局帧（m.public），前端就一直停在「正在进入模拟…」
   * —— 玩家反馈「隐身观战加载不出来」。
   */
  *memberSessions(room) {
    const all = [...room.seats, ...room.spectators, ...(Array.isArray(room.hiddenSpectators) ? room.hiddenSpectators : [])];
    const seen = new Set();
    for (const s of all) {
      if (!s || s.isBot || s.left) continue;
      if (s.playerId && seen.has(s.playerId)) continue;   // 同一人只发一次
      const session = this.registry.byId(s.playerId);
      if (session && session.connected && session.roomCode === room.code) {
        if (s.playerId) seen.add(s.playerId);
        yield session;
      }
    }
  }

  broadcastState(room) {
    if (room.disposed) return;
    reconcileAiTakeover(this, room);
    if (this.trustedRuntime) {
      const state = room.toState(this.now()), prev = room.trustedPrevious;
      const event = (name,extra={}) => this.trustedRuntime.event(name,{room:state,...extra});
      if (!prev) event('roomCreated');
      const before = new Set((prev?.seats || []).filter(Boolean).map(s => s.playerId));
      const after = new Set(state.seats.filter(Boolean).map(s => s.playerId));
      for (const id of after) if (!before.has(id)) event('playerJoined',{playerId:id});
      for (const id of before) if (!after.has(id)) event('playerLeft',{playerId:id});
      if (state.inMatch && !prev?.inMatch) event('matchStarted');
      room.trustedPrevious = state;
    }
    const data = encode(room.toState(this.now()));
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data);
  }

  sendState(room, session) {
    sendSession(session, room.toState(this.now()));
  }

  /** Match broadcast: encode once, send to every connected member. @returns {string | null} the encoded frame */
  broadcastRoom(room, msg, encoded = null) {
    if (room.disposed) return null;
    const data = encoded ?? encode(msg);
    if (data == null) { this.log.error(`[lobby] ${room.code} unserializable broadcast ${msg && msg.t}`); return null; }
    // per connection: sendSession runs the state transport, which owns each socket's delta baseline (and the
    // droppable/backpressure rules) - one shared byte string in, one frame per member out
    for (const session of this.memberSessions(room)) sendSession(session, msg, data);
    return data;
  }

  /** Match unicast. @returns {boolean} */
  sendToPlayer(room, playerId, msg, encoded = null) {
    if (room.disposed) return false;
    // 隐身观战（adminWatch）只存在于 hiddenSpectators：既不是 seat 也不在 spectators。
    // 以前这里只查 seatOf / spectatorOf，隐身观战者的单播一律被拒，
    // 于是 addSpectator → _resync 发不出去，前端停在「正在进入模拟…」。
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId) || room.hiddenSpectatorOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || session.roomCode !== room.code) return false;
    return sendSession(session, msg, encoded);
  }
}
