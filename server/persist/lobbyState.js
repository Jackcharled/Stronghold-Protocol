// server/persist/lobbyState.js — the lobby document (docs/DEPLOY.md「断点续玩」): what a single-process server or the
// cluster coordinator needs to take its players back after a restart.
//
// WHAT IS SAVED
//   * sessions that are in a room (in its lobby, its match or watching it): playerId, the secret reconnect token, the
//     name, the room, the checked loadout / 潜能 练度 / not-owned / 自选 / skins / card, the pending notice, the
//     reconnect window. A client that comes back with its token after the restart is the same player in the same seat.
//     A session outside any room is not saved: its client simply gets a fresh identity (nothing is lost).
//   * rooms: code, mode, difficulty, options, host, seats (humans and AI), spectators, the per-network keys, the match
//     counter — and the running match's reference: a local match's checkpoint id (`local`), or a cluster match's
//     assignment (`remote`: node, epochs and its assignment DTO — the game node keeps the checkpoint itself).
//
// WHAT IS NOT
//   * sockets (every client reconnects with its token — that is the point), the matchmaking queue and open offers
//     (players queue again), a lobby countdown, rooms with gameplay plugins (their content sets are not restorable),
//     the replay of a finished match.
//
// ON RESTORE every session is offline; one that was online when the document was written was cut off by the restart, so
// its reconnect window starts now, an offline one keeps its own (expired ones are dropped). A seat whose session did not
// survive is freed (lobby) or departs (a running match: onLeave once the match is back). A room left without a human
// is dropped. Lobby rooms get the usual lobby grace for their absent players.

import { Session } from '../net.js';
import { Room } from '../lobby.js';
import { experimentalOptions, isExperimental } from '../../shared/experimental.js';
import { DIFFICULTIES, ROOM_CODE_LEN } from '../../shared/constants.js';

/** Document layout version; another version is not restored (logged). Raise it when the shape below changes. */
export const LOBBY_DOC_VERSION = 1;

const ROOM_RE = new RegExp(`^[A-Z]{${ROOM_CODE_LEN}}$`);
const ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const plain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v == null ? null : structuredClone(v));
/** A session's settings (the lobby replaces these frozen values, never mutates them: a reference compare finds a change). */
export const SESSION_FIELDS = Object.freeze(['loadout', 'ops', 'notOwned', 'diy', 'card', 'loadoutCs', 'notOwnedCs', 'diyCs']);
const SEAT_FIELDS = ['seat', 'playerId', 'name', 'isBot', 'ready', 'left', 'loadout', 'revivalVote', 'ops', 'notOwned', 'diy', 'card',
  'owner', 'loadoutCs', 'notOwnedCs', 'diyCs', 'band', 'accountId',
  // 管理员/服主标记：控制台房间列表据此把「玩家」显示成「管理员」。
  // 必须一起存进 Redis，否则 matchmaker 从 Redis 读房间时看不到这个字段。
  'admin',
  // 游客标记：游客不能当选房主（lobby.js migrateHost），也要让控制台区分「游客」。
  'guest'];

/** A room the document can carry: not disposed, no gameplay plugins. */
export function persistableRoom(room) {
  return !!room && !room.disposed && !room.modded;
}

/**
 * One room's record, or null when it is not saved (persistableRoom; a running match without a reference cannot come
 * back, and neither can its room). A human seat's settings that are its session's very values are not repeated: `$same`
 * names them and the restore takes them from the session.
 * @param {Room} room @param {(room: Room) => object | null | undefined} matchRef
 * @param {(playerId: string) => any} sessionOf
 */
export function roomDoc(room, matchRef, sessionOf) {
  if (!persistableRoom(room)) return null;
  let match = null;
  if (room.match) {
    match = matchRef(room) || null;
    if (!match) { /* 拿不到对局快照也保存房间 */ }
  }
  const seat = (s) => {
    if (!s) return null;
    const session = s.isBot ? null : sessionOf(s.playerId);
    const same = session ? SESSION_FIELDS.filter((k) => s[k] != null && s[k] === session[k]) : [];
    const out = {};
    for (const k of SEAT_FIELDS) if (s[k] !== undefined && !same.includes(k)) out[k] = s[k];
    if (!s.isBot) out.skins = s.skins;
    if (same.length) out.$same = same;
    return out;
  };
  return {
    code: room.code, mode: room.mode, difficulty: room.difficulty, aiPicksLast: !!room.aiPicksLast, hostId: room.hostId,
    // 房间容量必须单独存一份：匹配端 roomInfo() 读的是 doc.capacity，
    // 以前这里只有 experimental（里面虽有 playerCapacity，但 matchmaker 不认这个字段），
    // 于是所有房间在匹配池里都被当成默认 4 人 —— 5–20 人房会混进 4 人局一起被配走。
    capacity: room.capacity,
    // 房间的游戏版本（第二期下半 / 第二期上半 / 第一期…）也必须单独存一份：
    // matchmaker 的 roomInfo() 读的是 doc.version，用来按版本隔离匹配池。
    // 以前这里没有 version，matchmaker 读不到就退回客户端上报值 —— 而客户端在
    // 排队时并不总会带上，于是不同版本的房间会被配进同一局。
    version: room.version,
    experimental: room.experimental, source: room.source, ownerKey: room.ownerKey, ownerKeys: room.ownerKeys ? [...room.ownerKeys] : null,
    matchKey: room.matchKey, matchKeys: room.matchKeys ? [...room.matchKeys] : null, matchCount: room.matchCount | 0, createdAt: room.createdAt,
    ttlMs: room.ttlMs, noExpire: room.noExpire === true, adminCreated: room.adminCreated === true,
    matchLive: !!room.match, liveRound: room.liveRound | 0, livePhase: room.livePhase || null,
    maxSpectators: typeof room.spectatorLimit === 'function' ? room.spectatorLimit() : 0,
    seats: room.seats.map(seat),
    spectators: room.spectators.map((s) => ({ playerId: s.playerId, name: s.name, ...(s.owner ? { owner: true } : {}) })),
    match,
  };
}

/** One session's record (its settings by reference: JSON.stringify serializes them, nothing is copied). */
export function sessionDoc(s) {
  const doc = { playerId: s.playerId, token: s.token, name: s.name, roomCode: s.roomCode, notice: s.notice || null,
    accountId: s.accountId || null, accountTag: s.accountTag || null,
    connected: !!s.connected, disconnectedAt: s.disconnectedAt ?? null,
    resumeWindowMs: typeof s.resumeWindowMs === 'number' && s.resumeWindowMs > 0 ? s.resumeWindowMs : null, matchHeld: !!s.matchHeld,
    skins: s.skins || {} };
  for (const k of SESSION_FIELDS) if (s[k] != null) doc[k] = s[k];
  return doc;
}

/**
 * The whole lobby document (tests and tools; the persister writes the same records one by one, persister.js).
 * @param {{ registry: import('../net.js').SessionRegistry, lobby: import('../lobby.js').Lobby,
 *   matchRef: (room: Room) => object | null | undefined, now?: number, kind?: string }} args
 */
export function snapshotLobby({ registry, lobby, matchRef, now = Date.now(), kind = 'local' }) {
  const rooms = [];
  for (const room of lobby.rooms.values()) {
    const doc = roomDoc(room, matchRef, (id) => registry.byId(id));
    if (doc) rooms.push(doc);
  }
  const codes = new Set(rooms.map((r) => r.code));
  const sessions = [];
  for (const s of registry.all()) if (s.roomCode && codes.has(s.roomCode)) sessions.push(sessionDoc(s));
  return JSON.parse(JSON.stringify({ v: LOBBY_DOC_VERSION, kind, savedAt: now, sessions, rooms }));
}

/**
 * Re-create the sessions and rooms of a document (before the server listens). Never throws for a bad record: it is
 * skipped and counted. Returns the rooms whose match is to be restored, with the seats that departed meanwhile.
 * @param {{ doc: any, registry: import('../net.js').SessionRegistry, lobby: import('../lobby.js').Lobby, now?: number,
 *   log?: object }} args
 * @returns {{ ok: boolean, reason?: string, sessions: number, expired: number, rooms: number, dropped: number,
 *   matches: { room: Room, ref: any, departed: string[] }[] }}
 */
export function restoreLobby({ doc, registry, lobby, now = Date.now(), log = null }) {
  const out = { ok: false, sessions: 0, expired: 0, rooms: 0, dropped: 0, matches: [] };
  if (!plain(doc)) return { ...out, reason: 'empty' };
  if (doc.v !== LOBBY_DOC_VERSION) return { ...out, reason: `version ${doc.v}` };
  const restored = new Map();
  for (const s of Array.isArray(doc.sessions) ? doc.sessions : []) {
    try {
      if (!plain(s) || !ID_RE.test(String(s.playerId)) || !TOKEN_RE.test(String(s.token)) || typeof s.name !== 'string'
        || registry.byId(s.playerId) || registry.byTokenMap.has(s.token)) { out.dropped++; continue; }
      // a session that was online when the document was written was cut off by the restart: its window starts now
      const since = s.connected || !Number.isFinite(s.disconnectedAt) ? now : Number(s.disconnectedAt);
      const ownRaw = Number.isFinite(s.resumeWindowMs) && s.resumeWindowMs > 0 ? Number(s.resumeWindowMs) : null;
      // Keep a restored disconnect recoverable for at most 30 minutes, even when an older
      // record (before this cap) stored the old 24-hour solo window.
      const own = ownRaw != null ? Math.min(ownRaw, 30 * 60 * 1000) : null;
      const window = own != null && own > registry.reconnectWindowMs ? own : registry.reconnectWindowMs;
      if (now - since > window) { out.expired++; continue; }
      const session = new Session({ playerId: s.playerId, token: s.token, name: s.name, now });
      session.connected = false;
      session.disconnectedAt = since;
      session.resumeWindowMs = own;
      session.accountId = typeof s.accountId === 'string' ? s.accountId : null;
      session.accountTag = typeof s.accountTag === 'string' && /^[0-9]{4}$/.test(s.accountTag) ? s.accountTag : null;
      session.matchHeld = !!s.matchHeld;
      session.roomCode = typeof s.roomCode === 'string' && ROOM_RE.test(s.roomCode) ? s.roomCode : null;
      session.notice = typeof s.notice === 'string' ? s.notice : null;
      session.skins = Object.freeze({ ...(plain(s.skins) ? s.skins : {}) });
      for (const k of SESSION_FIELDS) if (s[k] != null) session[k] = Object.freeze(clone(s[k]));
      registry.byPlayerId.set(session.playerId, session);
      registry.byTokenMap.set(session.token, session);
      restored.set(session.playerId, session);
      out.sessions++;
    } catch (e) { out.dropped++; log?.warn?.(`[persist] a session was not restored (${e.message})`); }
  }
  for (const r of Array.isArray(doc.rooms) ? doc.rooms : []) {
    try {
      const room = roomFrom(r, restored, lobby, now) || fallbackRoom(r, lobby, now);
      if (!room) { out.dropped++; continue; }
      lobby.rooms.set(room.code, room);
      room.restoredAt = now;
      out.rooms++;
      // every departed seat (left before the restart, or its player did not come back): the restored match hears onLeave
      if (r.match) out.matches.push({ room, ref: r.match, departed: room.seats.filter((s) => s && !s.isBot && s.left).map((s) => s.playerId) });
      else for (const s of [...room.activeHumans(), ...room.spectators]) lobby.startGrace(room, s);
    } catch (e) { out.dropped++; log?.warn?.(`[persist] room ${r?.code} was not restored (${e.message})`); }
  }
  // a session whose room did not come back is in no room
  for (const s of restored.values()) {
    const room = s.roomCode ? lobby.rooms.get(s.roomCode) : null;
    if (!room || (!room.seatOf(s.playerId) && !room.spectatorOf(s.playerId))) s.roomCode = null;
  }
  out.ok = true;
  return out;
}

function roomFrom(r, sessions, lobby, now) {
  if (!plain(r) || !ROOM_RE.test(String(r.code)) || lobby.rooms.has(r.code) || !['solo', 'coop'].includes(r.mode)
    || !DIFFICULTIES.includes(r.difficulty) || !isExperimental(r.experimental) || !Array.isArray(r.seats)) return null;
  const room = new Room(r.code, r.mode, r.difficulty, Number.isFinite(r.createdAt) ? r.createdAt : now,
    typeof r.version === 'string' && r.version ? r.version : undefined, experimentalOptions(r.experimental));
    room.ttlMs = Number.isFinite(r.ttlMs) ? r.ttlMs : null;
    room.adminCreated = r.adminCreated === true;
    room.noExpire = room.adminCreated;
  if (r.seats.length !== room.seats.length) return null;
  const inMatch = !!r.match;
  room.content = lobby.vanilla;
  room.aiPicksLast = r.mode === 'coop' && r.aiPicksLast === true;
  room.source = typeof r.source === 'string' ? r.source : 'private';
  room.ownerKey = typeof r.ownerKey === 'string' ? r.ownerKey : null;
  room.ownerKeys = Array.isArray(r.ownerKeys) ? new Set(r.ownerKeys.filter((k) => typeof k === 'string')) : null;
  room.matchCount = Number.isSafeInteger(r.matchCount) && r.matchCount >= 0 ? r.matchCount : 0;
  room.liveRound = Number.isSafeInteger(r.liveRound) && r.liveRound >= 0 ? r.liveRound : 0;
  room.livePhase = typeof r.livePhase === 'string' ? r.livePhase : null;
  if (inMatch) {
    room.matchKey = typeof r.matchKey === 'string' ? r.matchKey : null;
    room.matchKeys = Array.isArray(r.matchKeys) ? new Set(r.matchKeys.filter((k) => typeof k === 'string')) : null;
  }
  r.seats.forEach((s, i) => {
    if (!plain(s)) return;
    if (s.seat !== i || !ID_RE.test(String(s.playerId)) || typeof s.name !== 'string' || typeof s.isBot !== 'boolean') return;
    const seat = { ...Object.fromEntries(SEAT_FIELDS.filter((k) => s[k] !== undefined).map((k) => [k, clone(s[k])])),
      connected: s.isBot, ready: s.isBot || (inMatch && !!s.ready), left: !s.isBot && !!s.left };
    for (const k of SEAT_FIELDS) if (seat[k] && typeof seat[k] === 'object') Object.freeze(seat[k]);
    if (!seat.isBot) {
      seat.skins = Object.freeze({ ...(plain(s.skins) ? s.skins : {}) });
      // the settings the seat shared with its session: the same restored values again
      for (const k of Array.isArray(s.$same) ? s.$same : []) if (SESSION_FIELDS.includes(k)) seat[k] = sessions.get(seat.playerId)?.[k] ?? null;
      const session = sessions.get(seat.playerId);
      if (!session || session.roomCode !== r.code) {
        if (!inMatch) return; // a lobby seat whose player is gone is simply free
        seat.left = true; // a running match: the seat departs once the match is back
      }
    }
    room.seats[i] = seat;
  });
  room.spectators = (Array.isArray(r.spectators) ? r.spectators : [])
    .filter((s) => plain(s) && sessions.get(s.playerId)?.roomCode === r.code && !room.seatOf(s.playerId))
    .map((s) => ({ playerId: s.playerId, name: String(s.name || ''), connected: false, ...(s.owner ? { owner: true } : {}) }));
  if (!(typeof room.validCapacity === 'function' ? room.validCapacity : (() => true))() || !room.activeHumans().length) return null;
  room.hostId = room.activeHumans().some((s) => s.playerId === r.hostId) ? r.hostId : room.activeHumans()[0].playerId;
  return room;
}


/** 参考版的 roomFrom 校验太严：这里用最少字段重建房间，保证重启后能回到原房间。 */
function fallbackRoom(r, lobby, now) {
  try {
    const room = new Room(r.code, r.mode, r.difficulty, Number.isFinite(r.createdAt) ? r.createdAt : now,
      typeof r.version === 'string' && r.version ? r.version : undefined);
    room.content = lobby.vanilla;
    room.adminCreated = r.adminCreated === true;
    room.noExpire = room.adminCreated;
    room.matchCount = Number.isSafeInteger(r.matchCount) ? r.matchCount : 0;
    room.aiPicksLast = r.mode === 'coop' && r.aiPicksLast === true;
    (Array.isArray(r.seats) ? r.seats : []).forEach((s, i) => {
      if (!s || !s.playerId) return;
      room.seats[i] = {
        seat: i,
        playerId: s.playerId,
        name: typeof s.name === 'string' ? s.name : '',
        isBot: !!s.isBot,
        connected: false,
        ready: false,
        left: false,
        skins: {},
      };
    });
    const humans = typeof room.activeHumans === 'function' ? room.activeHumans() : [];
    if (humans.length) room.hostId = r.hostId && humans.some((s) => s.playerId === r.hostId) ? r.hostId : humans[0].playerId;
    room.spectators = [];
    console.log('[persist] room ' + r.code + ' restored by fallback');
    return room;
  } catch (e) {
    console.log('[persist] fallbackRoom failed ' + (e && e.message));
    return null;
  }
}
