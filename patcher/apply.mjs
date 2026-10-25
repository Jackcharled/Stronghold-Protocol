// patcher/apply.mjs — 把「匹配 + 防护」需要的服务端改动重新打回 30 个节点
//
// 用法（在 D:\Stronghold-Protocol 下）：
//   node patcher\apply.mjs          应用补丁（幂等：已打过就跳过）
//   node patcher\apply.mjs --dry    只检查能不能打，不写文件
//   node patcher\apply.mjs --check  检查当前是否已全部打好
//
// 设计：不保存整份改过的文件，而是按「锚点」把改动插进当前版本的源码里，
// 所以官方更新（整个 server 目录被替换成新版本）之后，再跑一次本脚本即可重新打上。
// 任何一处锚点找不到都会中止并且不写任何文件，避免打出半套补丁。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SP_BASE || path.dirname(HERE);
const NODES = 30;
const NODE_LIST = (process.env.SP_NODE_LIST || Array.from({ length: NODES }, (_, i) => String(i + 1)).join(','))
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= NODES);
if (!NODE_LIST.length) {
  console.error('SP_NODE_LIST 没有有效节点');
  process.exit(1);
}
const FILES = ['server/lobby.js', 'server/http/config.js'];
const LEGACY_RE = /^(persist-|ckpt-|quiet-)/;   // 已由 patcher/new 的整文件替换
const ONLY = process.env.SP_ONLY ? process.env.SP_ONLY.split(',').map((s) => s.trim()).filter(Boolean) : null;
const DRY = process.argv.includes('--dry');
const CHECK = process.argv.includes('--check');

const nodeDir = (n) => path.join(BASE, `node-${n}`);
const read = (n, rel) => fs.readFileSync(path.join(nodeDir(n), rel), 'utf8');
const write = (n, rel, text) => fs.writeFileSync(path.join(nodeDir(n), rel), text, 'utf8');

// ---------------------------------------------------------------- 改动清单

const EDITS = [
  {
    id: 'lobby-defaults',
    file: 'server/lobby.js',
    marker: 'maxBotsPerAddr: 0',
    apply(src) {
      const re = /(  maxMatchesPerAddr: \d+,?[^\n]*\n)/;
      if (!re.test(src)) return null;
      return src.replace(re, (m) => m
        + '  maxBotsPerAddr: 0,      // 同一 IP 跨房间累计的 AI 队友上限（0 = 不限）\n'
        + '  idleKickMs: 0,          // 挂机多久后移出房间（0 = 关闭；240000 ≈ 两回合）\n');
    },
  },
  {
    id: 'idle-timer',
    file: 'server/lobby.js',
    marker: 'this.idleTimer = null',
    apply(src) {
      const anchor = '    this.resyncTimers = new Map();\n';
      if (!src.includes(anchor)) return null;
      const block = [
        '    /** 挂机检测定时器（idleKickMs > 0 时启用） */',
        '    this.idleTimer = null;',
        '    if (this.opts.idleKickMs > 0) {',
        '      this.idleTimer = setInterval(() => {',
        "        try { this.sweepIdle(); } catch (e) { this.log.warn('[lobby] idle sweep failed', e); }",
        '      }, 20_000);',
        '      this.idleTimer.unref?.();',
        '    }',
        '',
      ].join('\n');
      return src.replace(anchor, anchor + block);
    },
  },
  {
    id: 'idle-shutdown',
    file: 'server/lobby.js',
    marker: 'clearInterval(this.idleTimer)',
    apply(src) {
      const anchor = '    this.offContentStale = null;\n';
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, anchor + '    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }\n');
    },
  },
  {
    id: 'activity-stamp',
    file: 'server/lobby.js',
    marker: 'session.lastActiveAt = this.now();',
    apply(src) {
      const anchor = '  onMessage(session, msg) {\n';
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, anchor + '    // 挂机检测：任何一条来自玩家的消息都算「还在操作」\n    session.lastActiveAt = this.now();\n');
    },
  },
  {
    id: 'idle-sweep-methods',
    file: 'server/lobby.js',
    marker: 'sweepIdle() {',
    apply(src) {
      const anchors = [
        '  // ---------------------------------------------------------------------------------------------------\n  // room.* handlers\n',
        '  create(session, { mode, difficulty, test } = {}) {',
      ];
      const anchor = anchors.find((a) => src.includes(a));
      if (!anchor) return null;
      const block = [
        '  // ---------------------------------------------------------------------------------------------------',
        '  // 挂机踢人',
        '  // ---------------------------------------------------------------------------------------------------',
        '',
        '  /** 每 20 秒扫一次：房间里坐着但长时间没有任何消息的真人，移出房间（房主走了会自动移交）。 */',
        '  sweepIdle() {',
        '    const idleMs = this.opts.idleKickMs;',
        '    if (!idleMs || idleMs <= 0) return;',
        '    const now = this.now();',
        '    for (const room of [...this.rooms.values()]) {',
        '      if (room.disposed) continue;',
        '      for (const seat of room.seats) {',
        '        if (!seat || seat.isBot || seat.left) continue;',
        '        if (seat.ready) continue; // 已准备就绪：不算挂机',
        '        const session = this.registry.byId(seat.playerId);',
        '        if (!session || !session.connected) continue;',
        '        const last = session.lastActiveAt || now;',
        '        if (now - last < idleMs) continue;',
        '        this.kickIdle(room, seat.playerId, session);',
        '      }',
        '    }',
        '  }',
        '',
        '  /** 把一个挂机的真人移出房间：先提示，再按「被移出」关房；断线中的玩家等回来时看到提示。 */',
        '  kickIdle(room, playerId, session) {',
        '    const replay = this.replayFor ? this.replayFor(room, playerId) : null;',
        '    this.removeMember(room, playerId);',
        '    if (session.roomCode === room.code) session.roomCode = null;',
        '    session.lastActiveAt = this.now();',
        '    if (session.connected) {',
        "      sendSession(session, { t: 'm.toast', kind: 'warn', text: '长时间未操作，你已被自动移出同盟' });",
        "      sendSession(session, { t: 'room.closed', reason: 'kicked' });",
        '    } else {',
        "      session.notice = 'kicked';",
        '      session.pendingResult = replay;',
        '    }',
        '    this.log.info(`[lobby] ${room.code} ${session.name || playerId} removed for idling`);',
        '  }',
        '',
      ].join('\n');
      return src.replace(anchor, block + anchor);
    },
  },
  {
    id: 'bot-cap',
    file: 'server/lobby.js',
    marker: 'too many AI teammates from your network',
    apply(src) {
      const anchor = "    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo rooms cannot have AI teammates');\n";
      if (!src.includes(anchor)) return null;
      const block = [
        '    // 同一个网络地址能挂的 AI 队友总数（跨房间累计），防止用一堆机器人占满 CPU',
        '    if (this.opts.maxBotsPerAddr > 0) {',
        '      const key = session.limitKey;',
        '      if (key && this.countBots(key) >= this.opts.maxBotsPerAddr) {',
        '        this.limitWarn(`AI teammate limit (${this.opts.maxBotsPerAddr}) reached for ${session.addr}`);',
        "        return fail(ERR.RATE, 'too many AI teammates from your network');",
        '      }',
        '    }',
      ].join('\n');
      return src.replace(anchor, anchor + block + '\n');
    },
  },
  {
    id: 'count-bots',
    file: 'server/lobby.js',
    marker: 'countBots(key) {',
    apply(src) {
      const anchor = '  /** Number of rooms matching a predicate. */\n  countRooms(pred) {';
      if (!src.includes(anchor)) return null;
      const block = [
        '  /** 某个网络地址在所有房间里的 AI 队友总数（maxBotsPerAddr）。 */',
        '  countBots(key) {',
        '    let n = 0;',
        '    for (const r of this.rooms.values()) {',
        '      if (r.disposed || r.ownerKey !== key) continue;',
        '      for (const s of r.seats) if (s && s.isBot) n++;',
        '    }',
        '    return n;',
        '  }',
        '',
      ].join('\n');
      return src.replace(anchor, block + anchor);
    },
  },
  {
    id: 'lobby-option-keys',
    file: 'server/http/config.js',
    marker: "'maxBotsPerAddr'",
    apply(src) {
      const re = /(const LOBBY_OPTION_KEYS = \[)([^\]]*)(\];)/;
      if (!re.test(src)) return null;
      return src.replace(re, (m, a, body, c) => `${a}${body.replace(/\s+$/, '')}, 'maxBotsPerAddr', 'idleKickMs'${c}`);
    },
  },
  {
    id: 'persist-option-keys',
    file: 'server/http/config.js',
    marker: "'snapshotPath'",
    apply(src) {
      const re = /(const LOBBY_OPTION_KEYS = \[)([^\]]*)(\];)/;
      if (!re.test(src)) return null;
      return src.replace(re, (m, a, body, c) => `${a}${body.replace(/\s+$/, '')}, 'snapshotPath', 'snapshotIntervalMs', 'restoredTtlMs'${c}`);
    },
  },
  {
    id: 'persist-imports',
    file: 'server/lobby.js',
    marker: "import fs from 'node:fs';",
    apply(src) {
      const re = /(import \{ randomBytes, randomInt \} from 'node:crypto';\r?\n)/;
      if (!re.test(src)) return null;
      return src.replace(re, (m) => m + "import fs from 'node:fs';\r\nimport path from 'node:path';\r\n");
    },
  },
  {
    id: 'persist-defaults',
    file: 'server/lobby.js',
    marker: 'snapshotPath: null',
    apply(src) {
      const re = /(  idleKickMs: 0,[^\n]*\n)/;
      if (!re.test(src)) return null;
      return src.replace(re, (m) => m
        + '  snapshotPath: null,     // 断点快照文件：重启后恢复房间与重连身份（null = 关闭）\n'
        + '  snapshotIntervalMs: 10_000, // 运行中每隔这么久落盘一次\n');
    },
  },
  {
    id: 'persist-constructor',
    file: 'server/lobby.js',
    marker: 'this.snapshotTimer = null',
    apply(src) {
      const re = /(      this\.idleTimer\.unref\?\.\(\);\r?\n    \}\r?\n)/;
      if (!re.test(src)) return null;
      const block = [
        '    // 断点：启动时读回上次的房间与重连身份；运行中定时落盘，崩溃也能恢复',
        '    this.snapshotTimer = null;',
        '    if (this.opts.snapshotPath) {',
        '      try {',
        "        const data = JSON.parse(fs.readFileSync(this.opts.snapshotPath, 'utf8'));",
        '        const restored = this.restoreSnapshot(data);',
        "        if (restored) this.log.info(`[lobby] restored ${restored} room(s) from snapshot`);",
        '      } catch { /* 首次启动：还没有快照 */ }',
        '      this.snapshotTimer = setInterval(() => {',
        "        try { this.saveSnapshot(); } catch (e) { this.log.warn('[lobby] snapshot failed', e); }",
        "        try { this.expireRestored(); } catch (e) { this.log.warn('[lobby] expireRestored failed', e); }",
        '      }, this.opts.snapshotIntervalMs || 10_000);',
        '      this.snapshotTimer.unref?.();',
        '    }',
        '',
      ].join('\n');
      return src.replace(re, (m) => m + block);
    },
  },
  {
    id: 'persist-shutdown',
    file: 'server/lobby.js',
    marker: 'clearInterval(this.snapshotTimer)',
    apply(src) {
      const anchor = '    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }\n';
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, anchor
        + '    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); this.snapshotTimer = null; }\n'
        + '    try { this.saveSnapshot(); } catch { /* 关服时尽量落盘 */ }\n');
    },
  },
  {
    id: 'persist-methods',
    file: 'server/lobby.js',
    marker: 'saveSnapshot() {',
    apply(src) {
      const anchor = '  // ---------------------------------------------------------------------------------------------------\n  // 挂机踢人\n';
      if (!src.includes(anchor)) return null;
      const block = [
        '  // ---------------------------------------------------------------------------------------------------',
        '  // 断点：未完成的对局在重启后不丢房间与人员',
        '  // ---------------------------------------------------------------------------------------------------',
        '',
        '  /** 开服后 30 分钟内没人回来的房间自动作废（只对恢复出来的房间生效）。 */',
        '  expireRestored() {',
        '    const ttl = this.opts.restoredTtlMs || 30 * 60 * 1000;',
        '    const now = this.now();',
        '    for (const room of [...this.rooms.values()]) {',
        '      if (!room.restored || room.disposed) continue;',
        '      if (room.seats.some((s) => s && !s.isBot && s.connected)) { room.restored = false; continue; }',
        '      if (now - (room.restoredAt || now) > ttl) {',
        '        room.restored = false;',
        '        this.log.info(`[lobby] ${room.code} dropped: nobody came back within 30 min`);',
        "        this.disposeRoom(room, 'expired');",
        '      }',
        '    }',
        '  }',
        '',
        '  /** 把房间、座位和重连身份写进快照文件（原子替换）。对局进行中的房间会被标记为“中断”。 */',
        '  saveSnapshot() {',
        '    const file = this.opts.snapshotPath;',
        '    if (!file) return;',
        '    const rooms = [];',
        '    for (const r of this.rooms.values()) {',
        '      if (r.disposed) continue;',
        '      const humans = r.seats.filter((s) => s && !s.isBot);',
        '      if (!humans.length) continue;',
        '      rooms.push({',
        '        code: r.code, mode: r.mode, difficulty: r.difficulty, aiPicksLast: !!r.aiPicksLast,',
        '        createdAt: r.createdAt, test: !!r.test, matchCount: r.matchCount || 0, interrupted: !!r.match,',
        '        seats: r.seats.map((s) => (s ? {',
        '          seat: s.seat, playerId: s.playerId, name: s.name, isBot: !!s.isBot, ready: !!s.ready,',
        '          loadout: s.loadout || null, ops: s.ops || null, notOwned: s.notOwned || null, diy: s.diy || null,',
        '        } : null)),',
        '      });',
        '    }',
        '    const sessions = [];',
        '    for (const s of this.registry.byPlayerId.values()) {',
        '      if (!s.roomCode) continue;',
        '      sessions.push({',
        '        playerId: s.playerId, token: s.token, name: s.name, roomCode: s.roomCode,',
        '        loadout: s.loadout || null, ops: s.ops || null, notOwned: s.notOwned || null, diy: s.diy || null,',
        '      });',
        '    }',
        '    try {',
        '      fs.mkdirSync(path.dirname(file), { recursive: true });',
        '      const tmp = file + ".tmp";',
        '      fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: this.now(), rooms, sessions }));',
        '      fs.renameSync(tmp, file);',
        '    } catch (e) { this.log.warn("[lobby] snapshot failed", e); }',
        '  }',
        '',
        '  /** 读回快照：恢复房间、座位与重连 token（对局本身不能续跑，只能回到房间重新开始）。 */',
        '  restoreSnapshot(data) {',
        '    if (!data || data.v !== 1) return 0;',
        '    // 恢复出来的房间 30 分钟内没人回来就作废（expireRestored）',
        '    const byId = new Map();',
        '    for (const sd of data.sessions || []) {',
        '      if (!sd || !sd.playerId || !sd.token) continue;',
        '      let session = this.registry.byPlayerId.get(sd.playerId);',
        '      if (!session) {',
        '        session = this.registry.create(sd.name || "博士");',
        '        if (!session) continue;',
        '        this.registry.byPlayerId.delete(session.playerId);',
        '        this.registry.byTokenMap.delete(session.token);',
        '        session.playerId = sd.playerId;',
        '        session.token = sd.token;',
        '        this.registry.byPlayerId.set(session.playerId, session);',
        '        this.registry.byTokenMap.set(session.token, session);',
        '      }',
        '      session.roomCode = sd.roomCode || null;',
        '      session.loadout = sd.loadout || null;',
        '      session.ops = sd.ops || null;',
        '      session.notOwned = sd.notOwned || null;',
        '      session.diy = sd.diy || null;',
        '      byId.set(sd.playerId, session);',
        '    }',
        '    let n = 0;',
        '    for (const rd of data.rooms || []) {',
        '      if (!rd || !rd.code || this.rooms.has(rd.code)) continue;',
        '      const room = new Room(rd.code, rd.mode === "solo" ? "solo" : "coop", rd.difficulty, this.now());',
        '      room.aiPicksLast = !!rd.aiPicksLast;',
        '      room.createdAt = rd.createdAt || this.now();',
        '      room.test = !!rd.test;',
        '      room.matchCount = rd.matchCount || 0;',
        '      room.content = this.vanilla;',
        '      room.interrupted = !!rd.interrupted;',
        '      room.restored = true;',
        '      room.restoredAt = this.now();',
        '      for (const s of rd.seats || []) {',
        '        if (!s) continue;',
        '        const session = byId.get(s.playerId);',
        '        if (s.isBot) {',
        '          room.seats[s.seat] = { seat: s.seat, playerId: s.playerId, name: s.name, isBot: true, ready: true, connected: true, left: false };',
        '        } else if (session) {',
        '          const seat = this.humanSeat(s.seat, session);',
        '          seat.ready = !!s.ready;',
        '          seat.connected = false;',
        '          seat.loadout = s.loadout || null;',
        '          seat.ops = s.ops || null;',
        '          room.seats[s.seat] = seat;',
        '        }',
        '      }',
        '      const first = room.seats.find((s) => s && !s.isBot);',
        '      if (!first) continue;',
        '      room.hostId = first.playerId;',
        '      this.rooms.set(room.code, room);',
        '      n++;',
        '    }',
        '    return n;',
        '  }',
        '',
      ].join('\n');
      return src.replace(anchor, block + anchor);
    },
  },

  {
    id: 'ckpt-import',
    file: 'server/lobby.js',
    marker: "from './match/checkpoint.js'",
    apply(src) {
      const anchor = "import { getData as defaultGetData, lookup } from './data.js';\n";
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, anchor + "import { writeMatchCheckpoint, clearMatchCheckpoint } from './match/checkpoint.js';\n");
    },
  },
  {
    id: 'ckpt-writer',
    file: 'server/lobby.js',
    marker: 'writeMatchCheckpoint(dir, r',
    apply(src) {
      const anchor = "        try { this.expireRestored(); } catch (e) { this.log.warn('[lobby] expireRestored failed', e); }\n";
      if (!src.includes(anchor)) return null;
      const block = [
        '        try {',
        "          const dir = this.opts.snapshotPath ? path.dirname(this.opts.snapshotPath) : null;",
        '          for (const r of this.rooms.values()) if (r.match && !r.disposed) writeMatchCheckpoint(dir, r, this.now());',
        "        } catch (e) { this.log.warn('[lobby] match checkpoint failed', e); }",
      ].join('\n') + '\n';
      return src.replace(anchor, anchor + block);
    },
  },
  {
    id: 'quiet-shutdown',
    file: 'server/lobby.js',
    marker: 'room.quiet = true',
    apply(src) {
      const anchor = "    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);\n";
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, "    for (const room of [...this.rooms.values()]) room.quiet = true;   // 重启：静默解散，客户端重连后恢复\n" + anchor);
    },
  },
  {
    id: 'quiet-dispose',
    file: 'server/lobby.js',
    marker: 'if (room.quiet) {',
    apply(src) {
      const m = src.match(/  disposeRoom\(room, reason[^)]*\) \{\n/);
      if (!m) return null;
      return src.replace(m[0], m[0] + "    if (room.quiet) { room.disposed = true; if (this.rooms.get(room.code) === room) this.rooms.delete(room.code); return; }\n");
    },
  },
  {
    id: 'room-matchmaking-fields',
    file: 'server/lobby.js',
    marker: 'this.matchmaking = false;',
    apply(src) {
      const anchor = '    this.match = null;\n';
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, anchor
        + '    // 匹配队友期间暂停 15 分钟解散计时（本服）\n'
        + '    this.matchmaking = false;\n'
        + '    this.matchmakingAt = 0;\n'
        + '    this.matchmakingStartedAt = 0;\n');
    },
  },
  {
    id: 'room-matchmaking-state',
    file: 'server/lobby.js',
    marker: 'matchmaking: !!this.matchmaking,',
    apply(src) {
      const anchor = '      inMatch: !!this.match,\n';
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, anchor
        + '      matchmaking: !!this.matchmaking,\n'
        + '      matchmakingAt: this.matchmaking ? (Number(this.matchmakingStartedAt) || this.matchmakingAt || 0) : 0,\n');
    },
  },
  {
    id: 'room-matchmaking-dispatch',
    file: 'server/lobby.js',
    marker: "case 'room.matchmaking'",
    apply(src) {
      const anchor = "      case 'room.start': return this.start(session);\n";
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, "      case 'room.matchmaking': return this.matchmaking(session, msg);\n" + anchor);
    },
  },
  {
    id: 'room-matchmaking-method',
    file: 'server/lobby.js',
    marker: '  matchmaking(session, msg) {',
    apply(src) {
      const anchor = '  start(session) {\n';
      if (!src.includes(anchor)) return null;
      const block = [
        '  /** 房主进入/退出「匹配队友」：匹配期间暂停 15 分钟解散计时。 */',
        '  matchmaking(session, msg) {',
        '    const room = this.roomOf(session);',
        '    if (!room) return fail(ERR.NOT_IN_ROOM);',
        '    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);',
        '    if (room.match) return fail(ERR.ROOM_STARTED);',
        '    const on = !!(msg && msg.on);',
        '    if (on === room.matchmaking) return OK;',
        '    if (on) {',
        '      const humans = room.activeHumans();',
        "      if (humans.some((s) => s.playerId !== room.hostId && (!s.connected || !s.ready))) {",
        "        return fail(ERR.NOT_READY, 'all players must be ready before matchmaking');",
        '      }',
        '    }',
        '    const now = this.now();',
        '    if (on) {',
        '      room.matchmaking = true;',
        '      room.matchmakingAt = now;',
        '      room.matchmakingStartedAt = now;',
        "      this.log?.info?.('[lobby] ' + room.code + ' 开始匹配队友，暂停解散计时');",
        '    } else {',
        '      const started = Number(room.matchmakingStartedAt) || now;',
        '      room.matchmaking = false;',
        '      room.matchmakingAt = 0;',
        '      room.matchmakingStartedAt = 0;',
        '      // 暂停计时：把匹配期间的时间补回房间寿命，剩余时间不被消耗',
        '      const elapsed = Math.max(0, now - started);',
        '      room.createdAt = (Number(room.createdAt) || now) + elapsed;',
        '      if (room.lastMatchEndAt) room.lastMatchEndAt = Number(room.lastMatchEndAt) + elapsed;',
        "      this.log?.info?.('[lobby] ' + room.code + ' 取消匹配，恢复解散计时（暂停 ' + Math.round(elapsed / 1000) + 's）');",
        '    }',
        '    this.broadcastState(room);',
        '    return OK;',
        '  }',
        '',
      ].join('\n');
      return src.replace(anchor, block + anchor);
    },
  },
  {
    id: 'guest-create-guard',
    file: 'server/lobby.js',
    marker: '游客不能创建同盟模拟房间',
    apply(src) {
      const anchor = "  create(session, { mode, difficulty: asked, test, version: askedVersion, soloUnlimited } = {}) {\n";
      if (!src.includes(anchor)) return null;
      const block = [
        '    // 本服：游客不能建房，先给出明确原因，避免只拿到 BAD_MSG。',
        '    if (session.guest || !session.accountId) {',
        "      return fail(ERR.BAD_MSG, mode === 'solo'",
        "        ? '游客不能开始独立模拟，请先登录'",
        "        : '游客不能创建同盟模拟房间，请先登录');",
        '    }',
      ].join('\n') + '\n';
      return src.replace(anchor, anchor + block);
    },
  },
  {
    id: 'admin-room-flags',
    file: 'server/lobby.js',
    marker: 'room.adminCreated = session.admin === true;',
    apply(src) {
      const anchor = '    room.test = test === true;\n';
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, anchor
        + '    // 管理员建房：不自动过期，并在控制台标记\n'
        + '    room.adminCreated = session.admin === true;\n'
        + '    room.noExpire = room.adminCreated;\n');
    },
  },
  {
    id: 'room-admin-state',
    file: 'server/lobby.js',
    marker: 'adminCreated: this.adminCreated === true,',
    apply(src) {
      const anchor = '      inMatch: !!this.match,\n';
      if (!src.includes(anchor)) return null;
      return src.replace(anchor, anchor + '      adminCreated: this.adminCreated === true,\n');
    },
  },
];

// ---------------------------------------------------------------- 新增文件（补丁自带的模块）

const NEW_FILES = ['server/match/checkpoint.js', 'server/match/redis-store.js', 'shared/playerCapacity.js', 'shared/experimental.js'];
function copyNewFiles() {
  const from = path.join(HERE, 'new');
  for (const rel of NEW_FILES) {
    const srcFile = path.join(from, rel);
    if (!fs.existsSync(srcFile)) continue;
    for (const n of NODE_LIST) {
      const target = path.join(nodeDir(n), rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(srcFile, target);
    }
    console.log('  → 新文件 ' + rel + ' 已复制到 ' + NODE_LIST.length + ' 个节点');
  }
}

// ---------------------------------------------------------------- 执行

const results = [];
let failed = false;
if (!DRY && !CHECK && !ONLY) copyNewFiles();

for (const file of FILES) {
  let src;
  try { src = read(1, file); } catch (e) { console.error(`✗ 读不到 node-1/${file}`); process.exit(1); }
  let changed = false;
  for (const edit of EDITS.filter((e) => e.file === file && !LEGACY_RE.test(e.id))) {
    if (ONLY && !ONLY.includes(edit.id)) continue;
    if (src.includes(edit.marker)) { results.push(`= ${edit.id}（已存在，跳过）`); continue; }
    const out = edit.apply(src);
    if (out == null) { results.push(`✗ ${edit.id}：找不到锚点（版本结构可能变了）`); failed = true; continue; }
    src = out;
    changed = true;
    results.push(`+ ${edit.id}`);
  }
  if (!failed && !DRY && !CHECK && changed) {
    for (const n of NODE_LIST) write(n, file, src);
    results.push(`→ 已写入 ${NODE_LIST.map((n) => 'node-' + n).join(', ')}`);
  }
}

console.log('补丁结果：');
for (const r of results) console.log('  ' + r);

// 校验：所有 marker 都在
if (!failed && !DRY) {
  let ok = true;
  for (const file of FILES) {
    const src = read(1, file);
    for (const edit of EDITS.filter((e) => e.file === file && !LEGACY_RE.test(e.id))) {
      if (ONLY && !ONLY.includes(edit.id)) continue;
      if (!src.includes(edit.marker)) { console.error(`  ✗ 校验失败：${edit.id} 没有出现在 ${file}`); ok = false; }
    }
  }
  if (!ok) process.exit(1);
  console.log(CHECK ? '检查完成：补丁已全部就位。' : `完成：${NODE_LIST.length} 个节点已更新，请执行 pm2 restart all。`);
}
if (failed) { console.error('有锚点缺失，未写入任何文件。请检查游戏版本是否变化。'); process.exit(1); }
