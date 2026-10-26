'use strict';
// Stronghold-Protocol · 全局匹配服务（跨 30 节点）
//
// 玩家在 /mm/ 输入代号、选难度后进入队列；凑满 4 人时：
//   * 选一个当前人数最少的节点；
//   * 给 4 个人分别写好 sp_node Cookie，把他们钉到同一个节点；
//   * 第一个（房主）自动建房并把房间码回传给本服务，其余三人拿房间码自动加入。
//
// 只用 node:http，无第三方依赖。数据全在内存（重启即清空）。
// 监听 127.0.0.1:3090，对外只经 nginx 的 /mm/ 暴露。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
// 项目根目录：按本文件位置推导，不写死部署路径
const ROOT_DIR = path.join(__dirname, '..');
const GATE_FILE = path.join(ROOT_DIR, 'content', 'game-gate.json');
function gameGate() {
  try {
    const j = JSON.parse(fs.readFileSync(GATE_FILE, 'utf8'));
    return { start: j.start !== false, match: j.match !== false, reason: String(j.reason || '') };
  } catch {
    return { start: true, match: true, reason: '' };
  }
}
// 更新公告模块只在服务器上存在（guard/），公开仓库里没有它
let updateFile = null;
try { updateFile = require('../guard/update-file.cjs'); } catch { /* 可选模块 */ }
const account = require('./account.cjs');

const PORT = Number(process.env.MM_PORT || 3090);
const HOST = process.env.MM_HOST || '127.0.0.1';
const NODES = 30;
const SEATS = 4;
const MAX_SEATS = 20;
const isSeatCount = (n) => Number.isInteger(n) && n >= SEATS && n <= MAX_SEATS;
const DIFFICULTIES = ['FUNNY', 'NORMAL', 'HARD', 'ABYSS'];
const DIFF_NAMES = { FUNNY: '标准模拟', NORMAL: '险境模拟', HARD: '绝境模拟', ABYSS: '终极模拟' };
const TICKET_TTL_MS = 15 * 60 * 1000;
const MATCH_TTL_MS = 5 * 60 * 1000;
/**
 * 停止对外接收新对局的节点（逗号分隔节点号）。
 * 用途：这些节点上还有未结束的对局，不能重启；先让它们不再被调度，
 * 等在打的局自然结束后再重启。已被分配过去的玩家不受影响。
 */
const DISABLED_NODES = new Set(
  String(process.env.MM_DISABLED_NODES || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= NODES),
);
const CODE_RE = /^[A-Za-z0-9]{4,8}$/;

/**
 * 把浏览器钉到某个节点：sp_node 给前端 nodeOf() 读，sp_route 给 nginx 选上游（两者必须一致，
 * 否则页面会落在 A 节点却以为自己在 B 节点）。
 */
const pinCookies = (node) => [
  `sp_node=${node}; Path=/; Max-Age=604800; SameSite=Lax`,
  `sp_route=${node}; Path=/; Max-Age=604800; SameSite=Lax`,
];

const PUB = path.join(__dirname, 'public');

/** @type {Map<string, any>} 票据 */
const tickets = new Map();
/** @type {Map<string, any>} 已组成的对局 */
const matches = new Map();
/** @type {Map<string, any>} 房间（整队）匹配：key = `${roomCode}@${node}` */
const parties = new Map();
/** @type {Map<number, {humans:number, rooms:number, ok:boolean, at:number}>} */
const nodeLoad = new Map();

const rid = () => crypto.randomBytes(12).toString('hex');
const nodePort = (n) => 3000 + n;

// ---------------------------------------------------------------- node 状态

async function probeNode(n) {
  try {
    const res = await fetch(`http://127.0.0.1:${nodePort(n)}/healthz`, { signal: AbortSignal.timeout(1500) });
    const j = await res.json();
    return { humans: Number(j.sockets) || 0, rooms: Number(j.rooms) || 0, bots: Number(j.bots) || 0, ok: res.ok, at: Date.now() };
  } catch {
    return { humans: 0, rooms: 0, bots: 0, ok: false, at: Date.now() };
  }
}

async function refreshNodes() {
  const results = await Promise.all(Array.from({ length: NODES }, (_, i) => probeNode(i + 1)));
  results.forEach((r, i) => nodeLoad.set(i + 1, r));
}

/** 选人最少、其次房间最少的节点；并列随机，避免总是压同一个。 */
function pickNode() {
  const alive = [...nodeLoad.entries()].filter(([n, v]) => v.ok && !DISABLED_NODES.has(n));
  if (!alive.length) return null;
  const shuffled = alive.map(([n, v]) => ({ n, v, r: Math.random() })).sort((a, b) => a.r - b.r);
  shuffled.sort((a, b) => a.v.humans - b.v.humans || a.v.rooms - b.v.rooms);
  return shuffled[0].n;
}

/** Expanded queues are only admitted by the isolated experimental node. */
const EXPERIMENTAL_NODE = Number(process.env.MM_EXPERIMENTAL_NODE || 4);
function pickNodeFor(capacity) {
  if (capacity > SEATS) {
    const v = nodeLoad.get(EXPERIMENTAL_NODE);
    if (v?.ok && !DISABLED_NODES.has(EXPERIMENTAL_NODE)) return EXPERIMENTAL_NODE;
  }
  return pickNode();
}

// ---------------------------------------------------------------- 匹配

function positionOf(ticket) {
  const waiting = [...tickets.values()]
    .filter((t) => !t.matchId && t.difficulty === ticket.difficulty && t.capacity === ticket.capacity)
    .sort((a, b) => a.createdAt - b.createdAt);
  return { position: waiting.findIndex((t) => t.id === ticket.id) + 1, waiting: waiting.length };
}

function formMatches() {
  const now = Date.now();
  for (const difficulty of DIFFICULTIES) {
    const capacities = [...new Set([...tickets.values()]
      .filter((t) => !t.matchId && t.difficulty === difficulty && now - t.createdAt < TICKET_TTL_MS)
      .map((t) => t.capacity))]
      .filter(isSeatCount)
      .sort((a, b) => a - b);
    for (const capacity of capacities) {
      for (;;) {
        const waiting = [...tickets.values()]
          .filter((t) => !t.matchId && t.difficulty === difficulty && t.capacity === capacity && now - t.createdAt < TICKET_TTL_MS)
          .sort((a, b) => a.createdAt - b.createdAt);
        if (waiting.length < capacity) break;
        const node = pickNodeFor(capacity);
        if (!node) { console.warn('[mm] 没有可用节点，暂停组队'); break; }
        const group = waiting.slice(0, capacity);
        const match = {
          id: rid(),
          difficulty,
          capacity,
          node,
          hostId: (group.find((t) => !t.guest) || group[0]).id,
          memberIds: group.map((t) => t.id),
          code: null,
          createdAt: now,
        };
        matches.set(match.id, match);
        for (const t of group) { t.matchId = match.id; t.node = node; }
        console.log(`[mm] 组成对局 ${match.id.slice(0, 8)} 难度=${difficulty} 人数=${capacity} 节点=${node} 玩家=${group.map((t) => t.name).join(',')}`);
      }
    }
  }
}

function sweep() {
  const now = Date.now();
  for (const [id, t] of tickets) {
    // 页面关掉/断网：25 秒没轮询就退出队列，避免和幽灵玩家凑成一局
    if (!t.matchId && now - (t.lastSeen || t.createdAt) > 25_000) {
      tickets.delete(id);
      console.log(`[mm] 超时移出队列 ${t.name}`);
      continue;
    }
    if (now - t.createdAt > TICKET_TTL_MS) { tickets.delete(id); continue; }
    if (t.matchId) {
      const m = matches.get(t.matchId);
      if (!m) { t.matchId = null; t.node = null; }
      else if (now - m.createdAt > MATCH_TTL_MS) {
        if (m.code) { matches.delete(m.id); tickets.delete(t.id); }
        else { m.memberIds.forEach((mid) => { const x = tickets.get(mid); if (x) { x.matchId = null; x.node = null; } }); matches.delete(m.id); }
      }
    }
  }
  for (const [id, m] of matches) if (now - m.createdAt > MATCH_TTL_MS * 2) matches.delete(id);
}

function publicState(ticket) {
  if (!ticket.matchId) {
    const { position, waiting } = positionOf(ticket);
    return { state: 'queued', difficulty: ticket.difficulty, capacity: ticket.capacity, position, waiting, need: ticket.capacity };
  }
  const match = matches.get(ticket.matchId);
  if (!match) return { state: 'queued', difficulty: ticket.difficulty, capacity: ticket.capacity, position: 1, waiting: 1, need: ticket.capacity };
  const role = match.hostId === ticket.id ? 'host' : 'guest';
  return {
    state: 'matched',
    difficulty: match.difficulty,
    capacity: match.capacity,
    node: match.node,
    matchId: match.id,
    role,
    code: match.code,
    ready: Boolean(match.code) || role === 'host',
  };
}

// ---------------------------------------------------------------- 房间整队匹配（房间里的「匹配」按钮）
// 房主点匹配后，整个房间作为一支队伍进池；同难度的几支队伍人数加起来正好 4 人时成局，
// 所有人被钉到同一个节点：原来的房主在新节点自动建房，其余人拿房间码自动加入。

const partyKey = (code, node) => `${String(code || '').toUpperCase()}@${node}`;

// 本服：匹配必须按游戏版本隔离。不同版本（第二期下半 / 第二期上半 / 第一期…）的数据、
// 干员与规则都不同，绝不能被配进同一局。老客户端没有带版本时按默认版本处理。
const DEFAULT_GAME_VERSION = 'act2autochess';
const normVersion = (v) => (typeof v === 'string' && /^[A-Za-z0-9_@.-]{1,64}$/.test(v) ? v : DEFAULT_GAME_VERSION);

function waitingPartyPlayers(difficulty, capacity = SEATS, version = null) {
  return [...parties.values()]
    .filter((p) => !p.matchId && p.difficulty === difficulty
      && (isSeatCount(p.capacity) ? p.capacity : SEATS) === capacity
      && (version == null || normVersion(p.version) === version))
    .reduce((n, p) => n + p.size, 0);
}

function partyState(p, clientId) {
  const capacity = isSeatCount(p.capacity) ? p.capacity : SEATS;
  const version = normVersion(p.version);
  if (!p.matchId) {
    return { state: 'queued', size: p.size, waiting: waitingPartyPlayers(p.difficulty, capacity, version), difficulty: p.difficulty, capacity, version };
  }
  const m = matches.get(p.matchId);
  if (!m) {
    p.matchId = null;
    return { state: 'queued', size: p.size, waiting: waitingPartyPlayers(p.difficulty, capacity, version), difficulty: p.difficulty, capacity, version };
  }
  return {
    state: 'matched',
    node: m.node,
    matchId: m.id,
    difficulty: m.difficulty,
    capacity: m.capacity || capacity,
    version: m.version || version,
    leader: clientId === m.hostClientId,
    home: !!m.mainPartyKey && m.mainPartyKey === p.key,
    code: m.code || null,
  };
}

function formPartyMatches() {
  if (!gameGate().match) return;
  const now = Date.now();
  for (const difficulty of DIFFICULTIES) {
    // 先用 (版本, 人数) 分组：不同版本的队伍永远不进同一个候选池
    const groups = [...new Set([...parties.values()]
      .filter((p) => !p.matchId && p.difficulty === difficulty)
      .map((p) => `${normVersion(p.version)}|${isSeatCount(p.capacity) ? p.capacity : SEATS}`))];
    for (const group of groups) {
      const [version, capStr] = group.split('|');
      const capacity = Number(capStr);
      for (let guard = 0; guard < 20; guard++) {
        const waiting = [...parties.values()]
          .filter((p) => !p.matchId && p.difficulty === difficulty
            && normVersion(p.version) === version
            && (isSeatCount(p.capacity) ? p.capacity : SEATS) === capacity
            && now - (p.lastSeen || p.createdAt) < 25_000)
          .sort((a, b) => a.createdAt - b.createdAt);
        if (waiting.length < 2) break;
        const picked = [];
        let sum = 0;
        for (const p of waiting) {
          if (sum + p.size > capacity) continue;
          picked.push(p);
          sum += p.size;
          if (sum === capacity) break;
        }
        if (sum !== capacity) break;
        // 用人数最多的一队作为主房间；同人数时用先排队的队伍。
        const hostParty = picked
          .filter((p) => !p.guest)
          .sort((a, b) => b.size - a.size || a.createdAt - b.createdAt)[0];
        if (!hostParty) break;
        const hostNode = hostParty.node;
        const hostOnline = !!(hostNode && nodeLoad.get(hostNode)?.ok);
        const node = hostOnline ? hostNode : pickNode();
        if (!node) break;
        const match = {
          id: rid(), difficulty, node, party: true, capacity,
          // 本服：把版本记进成局结果，房间按这个版本创建
          version,
          partyIds: picked.map((p) => p.key),
          mainPartyKey: hostOnline ? hostParty.key : null,
          hostClientId: hostParty.leaderClientId,
          code: hostOnline ? hostParty.roomCode : null,
          createdAt: now,
        };
        matches.set(match.id, match);
        for (const p of picked) { p.matchId = match.id; p.node = node; }
        scheduleWriteRoomDir();
        console.log(`[mm] 组队成局 ${match.id.slice(0, 8)} 难度=${difficulty} 人数=${capacity} 版本=${version} 节点=${node} 房间=${picked.map((p) => `${p.roomCode}(${p.size})`).join('+')} 主房间=${hostParty.roomCode} ${hostOnline ? '沿用主房间' : '新房'}`);
      }
    }
  }
}

function sweepParties() {
  const now = Date.now();
  for (const [key, p] of parties) {
    if (!p.matchId && now - (p.lastSeen || p.createdAt) > 25_000) { parties.delete(key); scheduleWriteRoomDir(); continue; }
    if (p.matchId) {
      const m = matches.get(p.matchId);
      if (!m) { p.matchId = null; continue; }
      if (now - m.createdAt > MATCH_TTL_MS) {
        if (m.code) parties.delete(key);
        else { p.matchId = null; p.node = null; }
      }
    }
  }
}

// ---------------------------------------------------------------- HTTP

/** 30 个节点的中文名（与节点目录 node-1…node-30 一一对应）。 */
const NODE_NAMES = [
  '阿戈尔', '玻利瓦尔', '东', '杜林', '哥伦比亚',
  '卡西米尔', '卡兹戴尔', '拉特兰', '莱塔尼亚', '雷姆必拓',
  '米诺斯', '萨尔贡', '萨米', '维多利亚', '乌萨斯',
  '谢拉格', '叙拉古', '炎', '伊比利亚', '汐斯塔',
  '龙门', '伦蒂尼姆', '切尔诺伯格', '沃伦姆德', '长泉镇',
  '多索雷斯', '阿卡胡拉', '因非冰原', '焚风热土', '瓦伊凡',
];
let nodesCache = { at: 0, data: null };
const roomDirModule = new Map();   // node -> { codes, at }

/** 把内存里的房间目录写成 content/rooms.json（带模式/人数/对局状态），供控制台与后台读取。 */
let roomDirWriting = false;
let roomDirTimer = null;
function scheduleWriteRoomDir() {
  if (roomDirTimer) return;
  roomDirTimer = setTimeout(() => { roomDirTimer = null; writeRoomDir(); }, 2000);
  roomDirTimer.unref?.();
}
async function writeRoomDir() {
  if (roomDirWriting) {
    // 正在写：稍后补一次，避免这次匹配状态被丢掉
    if (!roomDirTimer) {
      roomDirTimer = setTimeout(() => { roomDirTimer = null; writeRoomDir(); }, 500);
      roomDirTimer.unref?.();
    }
    return;
  }
  roomDirWriting = true;
  try {
    const nodes = [];
    for (const [n, v] of roomDirModule) {
      const rooms = [];
      for (const code of v.codes) {
        let info = null;
        try { info = await roomInfo(code, n); } catch { info = null; }
        // 该房间是否正在同盟整队匹配（parties 里未成局的同房号/节点）
        let queued = false;
        try { queued = [...parties.values()].some((p) => p.roomCode === code && p.node === n && !p.matchId); } catch { /* ignore */ }
        rooms.push({ code, ...(info || {}), queued });
      }
      nodes.push({ n, at: v.at, rooms });
    }
    const dir = path.join(ROOT_DIR, 'content');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify({ at: Date.now(), nodes }));
  } catch { /* 写不了就算了，控制台显示为空 */ } finally { roomDirWriting = false; }
}
// 后台管理（owner）通过 /api/admin2/rooms 读取同一份内存目录
account.setRoomDirProvider?.(() => [...roomDirModule].map(([n, v]) => ({ n, codes: v.codes, at: v.at })));

/** 所有节点的在线情况（5 秒缓存，玩家端每 15 秒取一次）。 */
async function nodeStatus() {
  if (nodesCache.data && Date.now() - nodesCache.at < 5000) return nodesCache.data;
  const nodes = await Promise.all(NODE_NAMES.map(async (name, i) => {
    const n = i + 1;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 900);
      const r = await fetch(`http://127.0.0.1:${3000 + n}/healthz`, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error('bad');
      const j = await r.json();
      return { n, name, ok: true, humans: (j.sockets | 0), rooms: j.rooms | 0, matches: j.matches | 0, bots: (j.bots | 0) };
    } catch {
      return { n, name, ok: false, humans: 0, rooms: 0, matches: 0, bots: 0 };
    }
  }));
  const data = { at: Date.now(), online: nodes.filter((x) => x.ok).length, total: nodes.length, nodes };
  nodesCache = { at: Date.now(), data };
  return data;
}
function redisHget(prefix, field) {
  return new Promise((resolve) => {
    let host = '127.0.0.1', port = 6379;
    try { const u = new URL(process.env.SP_REDIS_URL || 'redis://127.0.0.1:6379'); host = u.hostname; port = Number(u.port) || 6379; } catch { /* defaults */ }
    const sock = net.createConnection({ host, port });
    let data = '';
    let done = false;
    const finish = () => { if (done) return; done = true; try { sock.destroy(); } catch { /* ignore */ } resolve(data); };
    const complete = (s) => {
      if (!s) return false;
      if (s[0] === '+' || s[0] === '-') return s.includes('\r\n');
      const m = /^\$(-?\d+)\r\n/.exec(s);
      if (!m) return false;
      const n = Number(m[1]);
      return n < 0 || s.length >= m[0].length + n + 2;
    };
    sock.setTimeout(800, finish);
    sock.on('error', finish);
    sock.on('connect', () => {
      const args = ['HGET', prefix + 'lobby:rooms', field];
      sock.write(`*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join(''));
    });
    sock.on('data', (d) => { data += d.toString(); if (complete(data)) finish(); });
    sock.on('end', finish);
    sock.on('close', finish);
  });
}
function parseRedisBulk(s) {
  if (!s || s[0] === '-') return null;
  const m = /^\$(-?\d+)\r\n/.exec(s);
  if (!m || Number(m[1]) < 0) return null;
  return s.slice(m[0].length, m[0].length + Number(m[1]));
}
async function roomInfo(code, node) {
  const raw = parseRedisBulk(await redisHget(`sp:n${node}:`, code));
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw);
    const seats = Array.isArray(doc.seats) ? doc.seats : [];
    const seatList = seats.filter(Boolean);
    const humans = seatList.filter((s) => !s.isBot).length;
    const bots = seatList.length - humans;
    const mode = doc.mode || null;
    const players = seatList
      .filter((s) => s && !s.isBot)
      .map((s, i) => ({
        name: String(s.name || ''),
        // 账号 ID：恢复对局按「账号」而不是「昵称」精确匹配（昵称可以重名、可以改，
        // 用昵称匹配会把玩家送去别人的对局）。guest 座位的 accountId 为 null。
        accountId: s.accountId ? String(s.accountId) : null,
        seat: Number.isInteger(s.seat) ? s.seat + 1 : i + 1,
        ready: !!s.ready,
        connected: s.connected !== false,
        host: !!doc.hostId && doc.hostId === s.playerId,
        guest: !s.accountId,
        // 管理员/服主：控制台把标签显示成「管理员」而不是「玩家」（仅展示用）
        admin: s.admin === true,
      }));
    const spectatorPlayers = (Array.isArray(doc.spectators) ? doc.spectators : [])
      .filter((s) => s && typeof s === 'object')
      .map((s) => ({ name: String(s.name || ''), connected: s.connected !== false }));
    const round = doc.matchLive ? (Number(doc.liveRound) || 0) : (doc.match && Number.isFinite(Number(doc.match.round)) ? Number(doc.match.round) : null);
    const maxSpectators = Number.isInteger(doc.maxSpectators) ? doc.maxSpectators
      : (mode === 'coop' ? Math.max(2, Math.ceil(humans / 2)) : 0);
    // 房间容量：优先 doc.capacity（lobbyState 现在会存）。
    // 兜底读 doc.experimental.playerCapacity —— 老版本的房间文档没有 capacity 字段，
    // 只靠 capacity 会让 5–20 人房在匹配池里被当成 4 人，被 4 人局配走。
    const capacity = Number(
      doc.capacity
      ?? (doc.experimental && typeof doc.experimental === 'object' ? doc.experimental.playerCapacity : NaN),
    );
    return { full: seats.length > 0 && seats.every(Boolean), started: !!(doc.matchLive || doc.matchKey || doc.match), mode, difficulty: doc.difficulty || null, capacity: isSeatCount(capacity) ? capacity : SEATS, humans, bots, players, spectatorPlayers, round, seats: seats.length, spectators: spectatorPlayers.length, maxSpectators, adminCreated: doc.adminCreated === true,
      // 本服：房间的游戏版本（默认版本在房间状态里被省略）
      version: typeof doc.version === 'string' && doc.version ? doc.version : 'act2autochess' };
  } catch { return null; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** 客户端真实 IP：nginx 会带上 X-Real-IP / X-Forwarded-For（取最后一个，即最近一跳写的）。 */
function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',').pop().trim();
  return (req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 8192) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

function auth(ticket, id, secret) {
  return ticket && ticket.id === id && ticket.secret === secret;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);

  // ---- 账号与用户偏好（/api/auth/*、/api/prefs*）----
  if (pathname.startsWith('/api/auth') || pathname.startsWith('/api/prefs') || pathname.startsWith('/api/account') || pathname.startsWith('/api/admin')) {
    try {
      const handled = await account.handle(req, res, pathname);
      if (handled !== false) return;
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (e) {
      const code = e && e.message === 'BODY_TOO_LARGE' ? 413 : (e && e.message === 'BAD_JSON' ? 400 : 500);
      try { json(res, code, { ok: false, error: e && e.message ? e.message : 'server_error' }); } catch { /* 已发送 */ }
      return;
    }
  }

  if (pathname === '/api/join' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 12);
    const difficulty = String(body.difficulty || '');
    const capacity = body.capacity == null ? SEATS : Number(body.capacity);
    if (!name) return json(res, 400, { error: '请先填写博士代号' });
    if (!DIFFICULTIES.includes(difficulty)) return json(res, 400, { error: '难度不正确' });
    if (!isSeatCount(capacity)) return json(res, 400, { error: '匹配人数不正确' });
    const ip = clientIp(req);
    // 防刷：同一网络最多 3 个待匹配票据；全服最多 500 个
    const mine = [...tickets.values()].filter((x) => x.ip === ip && !x.matchId).length;
    if (mine >= 3) return json(res, 429, { error: '同一网络排队人数过多，请稍后再试' });
    if (tickets.size >= 500) return json(res, 429, { error: '匹配队列已满，请稍后再试' });
    const t = { id: rid(), secret: rid(), name, difficulty, capacity, ip, createdAt: Date.now(), lastSeen: Date.now(), matchId: null, node: null };
    tickets.set(t.id, t);
    console.log(`[mm] 排队 ${name} (${DIFF_NAMES[difficulty]}, ${capacity}人) 票据=${t.id.slice(0, 8)}`);
    return json(res, 200, { ok: true, id: t.id, secret: t.secret, state: publicState(t) });
  }

  if (pathname === '/api/state') {
    const t = tickets.get(url.searchParams.get('id') || '');
    if (!auth(t, url.searchParams.get('id'), url.searchParams.get('secret'))) return json(res, 404, { error: 'ticket not found' });
    t.lastSeen = Date.now();
    return json(res, 200, publicState(t));
  }

  if (pathname === '/api/leave' && req.method === 'POST') {
    const body = await readBody(req);
    const t = tickets.get(body.id);
    if (!auth(t, body.id, body.secret)) return json(res, 404, { error: 'ticket not found' });
    if (t.matchId) return json(res, 409, { error: '已匹配成功，不能取消' });
    tickets.delete(t.id);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/room' && req.method === 'POST') {
    const body = await readBody(req);
    const t = tickets.get(body.ticketId);
    if (!auth(t, body.ticketId, body.secret)) return json(res, 404, { error: 'ticket not found' });
    const m = matches.get(body.matchId);
    if (!m || m.hostId !== t.id) return json(res, 403, { error: 'not the host of this match' });
    const code = String(body.code || '');
    if (!CODE_RE.test(code)) return json(res, 400, { error: 'bad room code' });
    m.code = code;
    console.log(`[mm] 房间已就绪 ${m.id.slice(0, 8)} → ${code} @ 节点${m.node}`);
    return json(res, 200, { ok: true });
  }

  // ---- 房间整队匹配 ----
  if (pathname === '/api/gate') {
    return json(res, 200, gameGate());
  }
  if (pathname === '/api/party/join' && req.method === 'POST') {
    if (!gameGate().match) return json(res, 503, { error: 'maintenance', message: '匹配队友维护中' });
    const body = await readBody(req);
    const code = String(body.roomCode || '').toUpperCase();
    const node = Number(body.node);
    const difficulty = String(body.difficulty || '');
    const info = await roomInfo(code, node);
    const actualCapacity = info && isSeatCount(Number(info.capacity)) ? Number(info.capacity) : null;
    const requestedCapacity = isSeatCount(Number(body.capacity)) ? Number(body.capacity) : null;
    // Never fall back to 4 when an old page omitted capacity: that is exactly how a
    // 20-person room used to be mixed with 4-person rooms. Make the old page refresh.
    if (!actualCapacity && !requestedCapacity) {
      return json(res, 409, { error: '匹配请求已过期，请刷新页面后重试' });
    }
    const capacity = actualCapacity || requestedCapacity;
    const size = Math.max(1, Math.min(capacity, Number(body.size) || 1));
    const clientId = String(body.clientId || '');
    if (!CODE_RE.test(code) || !Number.isInteger(node) || node < 1 || node > NODES || !DIFFICULTIES.includes(difficulty) || !clientId) {
      return json(res, 400, { error: 'bad party request' });
    }
    if (size >= capacity) return json(res, 409, { error: '房间已满，直接开始模拟即可' });
    const key = partyKey(code, node);
    // 本服：匹配按游戏版本隔离。优先用房间自己的版本（服务端权威），
    // 房间信息取不到时才用客户端上报的版本，都没有则按默认版本。
    const roomVersion = info && typeof info.version === 'string' ? info.version : null;
    const version = normVersion(roomVersion || body.version);
    let p = parties.get(key);
    if (!p) {
      p = { key, roomCode: code, node, difficulty, size, capacity, version, leaderClientId: clientId, guest: !!body.guest, createdAt: Date.now(), lastSeen: Date.now(), matchId: null };
      parties.set(key, p);
      console.log(`[mm] 房间 ${code}@${node} 开始匹配 · ${size}/${capacity} 人 · ${difficulty}`);
    } else {
      p.size = size;
      p.capacity = capacity;
      p.difficulty = difficulty;
      // 房间可以在排队期间切换版本；以最新版本为准，避免旧版本被配进新版本的局
      p.version = version;
      p.lastSeen = Date.now();
    }
    scheduleWriteRoomDir();
    return json(res, 200, { ok: true, partyId: key, state: partyState(p, clientId) });
  }

  if (pathname === '/api/party/state') {
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    const node = Number(url.searchParams.get('node'));
    const clientId = String(url.searchParams.get('client') || '');
    // byCodeFallback：成局后队伍被切到新节点，旧键查不到时按房间码回退
    let p = parties.get(partyKey(code, node));
    if (!p) { for (const x of parties.values()) if (x.roomCode === code) { p = x; break; } }
    if (!p) return json(res, 200, { state: 'idle' });
    p.lastSeen = Date.now();
    return json(res, 200, partyState(p, clientId));
  }

  if (pathname === '/api/party/leave' && req.method === 'POST') {
    const body = await readBody(req);
    let key = partyKey(String(body.roomCode || ''), Number(body.node));
    // byCodeFallback
    if (!parties.has(key)) { const rc = String(body.roomCode || '').toUpperCase(); for (const x of parties.values()) if (x.roomCode === rc) { key = x.key; break; } }
    const p = parties.get(key);
    if (!p) return json(res, 200, { ok: true });
    if (p.matchId) return json(res, 409, { error: '已匹配成功，不能取消' });
    // 房间里的任何成员都可以取消（页面刷新后领队身份会变，按房间码放行即可）
    parties.delete(key);
    scheduleWriteRoomDir();
    console.log(`[mm] 房间 ${p.roomCode}@${p.node} 取消匹配`);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/party/room' && req.method === 'POST') {
    const body = await readBody(req);
    const m = matches.get(body.matchId);
    if (!m) return json(res, 404, { error: 'no such match' });
    if (m.hostClientId !== body.clientId) return json(res, 403, { error: 'not the host' });
    const code = String(body.code || '');
    if (!CODE_RE.test(code)) return json(res, 400, { error: 'bad room code' });
    m.code = code;
    console.log(`[mm] 组队房间已就绪 ${m.id.slice(0, 8)} → ${code} @ 节点${m.node}`);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/party/pin') {
    const m = matches.get(url.searchParams.get('matchId') || '');
    const node = Number(url.searchParams.get('node'));
    if (!m || !m.party) return json(res, 404, { error: 'no such match' });
    if (node !== m.node) return json(res, 400, { error: 'bad node' });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': pinCookies(node),
    });
    return res.end(JSON.stringify({ ok: true, node }));
  }

  // 邀请链接用：把浏览器钉到指定节点（?n=），不需要票据
  if (pathname === '/api/pin-node') {
    const node = Number(url.searchParams.get('node'));
    if (!Number.isInteger(node) || node < 1 || node > NODES) return json(res, 400, { error: 'bad node' });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': pinCookies(node),
    });
    return res.end(JSON.stringify({ ok: true, node }));
  }

  // 把玩家钉到指定节点：写 sp_node + sp_route Cookie（由 nginx 透传给浏览器）
  if (pathname === '/api/pin') {
    const t = tickets.get(url.searchParams.get('id') || '');
    if (!auth(t, url.searchParams.get('id'), url.searchParams.get('secret'))) return json(res, 404, { error: 'ticket not found' });
    const node = Number(url.searchParams.get('node'));
    if (!Number.isInteger(node) || node < 1 || node > NODES || node !== t.node) return json(res, 400, { error: 'bad node' });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': pinCookies(node),
    });
    return res.end(JSON.stringify({ ok: true, node }));
  }

  if (pathname === '/api/announcement') {
    try {
      const raw = fs.readFileSync(path.join(ROOT_DIR, 'guard', 'announcement.json'), 'utf8');
      return json(res, 200, JSON.parse(raw));
    } catch { return json(res, 200, { enabled: false, text: '' }); }
  }

  if (pathname === '/api/announcements') {
    try {
      const raw = fs.readFileSync(path.join(ROOT_DIR, 'content', 'announcements.json'), 'utf8');
      const list = JSON.parse(raw);
      const body = JSON.stringify(Array.isArray(list) ? list : []);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end('[]');
    }
    return;
  }

  if (pathname === '/api/room-ttl') {
    try {
      const raw = fs.readFileSync(path.join(ROOT_DIR, 'shared', 'data', 'room-ttl.json'), 'utf8');
      return json(res, 200, JSON.parse(raw));
    } catch { return json(res, 200, { minutes: 15 }); }
  }

  if (pathname === '/api/update') {
    const doc = updateFile ? updateFile.readUpdate() : { enabled: false, text: '' };
    const body = JSON.stringify(doc);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }

// 房间目录：各节点每 10 秒上报自己的房间码，跨节点按房号找人
const roomDir = new Map(); // node -> { codes: string[], at: number }

  if (pathname === '/api/rooms/report' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const d = JSON.parse(body || "{}");
        const node = Number(d.node) | 0;
        if (node > 0 && Array.isArray(d.codes)) roomDirModule.set(node, { codes: d.codes.filter((c) => typeof c === "string"), at: Date.now() });
        scheduleWriteRoomDir();
      } catch { /* ignore */ }
      return json(res, 200, { ok: true });
    });
    return;
  }

  if (pathname === '/api/resolve-room') {
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    let found = null;
    for (const [node, v] of roomDirModule) {
      if (Date.now() - v.at > 45000) continue;
      if (v.codes.includes(code)) { found = node; break; }
    }
    if (!found) { res.writeHead(403, { 'cache-control': 'no-store' }); return res.end(); }
    res.writeHead(204, { 'X-SP-Node': String(found), 'X-SP-Room': code, 'cache-control': 'no-store' });
    return res.end();
  }

  if (pathname === '/api/room-redirect') {
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    if (!/^[A-Z0-9]{4,6}$/.test(code)) { res.writeHead(302, { Location: '/', 'cache-control': 'no-store' }); return res.end(); }
    let found = null;
    for (const [node, v] of roomDirModule) {
      if (Date.now() - v.at > 45000) continue;
      if (v.codes.includes(code)) { found = node; break; }
    }
    if (!found) { res.writeHead(302, { Location: '/', 'cache-control': 'no-store' }); return res.end(); }
    const adminNode = Number(url.searchParams.get('adminNode'));
    const node = Number.isInteger(adminNode) && adminNode >= 1 && adminNode <= 30 ? adminNode : found;
    const params = new URLSearchParams(url.searchParams);
    params.delete('code');
    params.delete('adminNode');
    const qs = params.toString();
    res.writeHead(302, {
      Location: `/?room=${encodeURIComponent(code)}${qs ? '&' + qs : ''}`,
      'Set-Cookie': [
        `sp_route=${node}; Path=/; Max-Age=2592000; SameSite=Lax`,
        `sp_node=${node}; Path=/; Max-Age=2592000; SameSite=Lax`,
        `sp_join=${code}; Path=/; Max-Age=120; SameSite=Lax`,
      ],
      'cache-control': 'no-store',
    });
    return res.end();
  }

  if (pathname === '/api/find-room') {
    const code = String(url.searchParams.get("code") || "").toUpperCase();
    let found = null;
    for (const [node, v] of roomDirModule) {
      if (Date.now() - v.at > 45000) continue;
      if (v.codes.includes(code)) { found = node; break; }
    }
    if (!found) return json(res, 200, { code, node: null });
    let info = null;
    try { info = await roomInfo(code, found); } catch { /* ignore */ }
    return json(res, 200, { code, node: found, ...(info || {}) });
  }

  if (pathname === '/api/node-status') {
    return nodeStatus().then((data) => json(res, 200, data));
  }

  if (pathname === '/api/stats') {
    return json(res, 200, {
      waiting: [...tickets.values()].filter((t) => !t.matchId).length,
      tickets: tickets.size,
      matches: matches.size,
      parties: parties.size,
      partyWaiting: [...parties.values()].filter((p) => !p.matchId).reduce((n, p) => n + p.size, 0),
      byDifficulty: Object.fromEntries(DIFFICULTIES.map((difficulty) => {
        const queued = [...tickets.values()].filter((t) => !t.matchId && t.difficulty === difficulty);
        const queuedParties = [...parties.values()].filter((p) => !p.matchId && p.difficulty === difficulty);
        // 本服：按容量细分。★ capacities 必须把「正在排队的组队」也算进来，
        // 否则只有 4 人房（SEATS）会被列出，5–20 人房的组队排队在后台/控制台看不见。
        const partyCapacity = (p) => (isSeatCount(p.capacity) ? p.capacity : SEATS);
        const capacities = [...new Set([
          SEATS,
          ...[...tickets.values()].filter((t) => t.difficulty === difficulty).map((t) => t.capacity),
          ...queuedParties.map(partyCapacity),
          ...[...matches.values()].filter((m) => m.difficulty === difficulty).map((m) => m.capacity == null ? SEATS : m.capacity),
        ])].sort((a, b) => a - b);
        return [difficulty, {
          waiting: queued.length,
          parties: queuedParties.length,
          partyWaiting: queuedParties.reduce((n, p) => n + p.size, 0),
          matches: [...matches.values()].filter((m) => m.difficulty === difficulty).length,
          // 本服：按游戏版本细分（匹配已按版本隔离，后台/控制台要能看出来）
          byVersion: (() => {
            const vers = [...new Set([
              ...[...queued].map((t) => normVersion(t.version)),
              ...[...queuedParties].map((p) => normVersion(p.version)),
              ...[...matches.values()].filter((m) => m.difficulty === difficulty).map((m) => normVersion(m.version)),
            ])];
            vers.sort();
            return vers.map((v) => {
              const q = queued.filter((t) => normVersion(t.version) === v);
              const qp = queuedParties.filter((p) => normVersion(p.version) === v);
              return {
                version: v,
                waiting: q.length,
                parties: qp.length,
                partyWaiting: qp.reduce((n, p) => n + p.size, 0),
                matches: [...matches.values()].filter((m) => m.difficulty === difficulty && normVersion(m.version) === v).length,
              };
            });
          })(),
          // ★ 每个容量都统计组队排队。以前这里是 `capacity === SEATS ? … : 0`，
          //   只有 4 人房有数据，5–20 人房永远显示 0 人排队 ——
          //   后台与节点控制台的「匹配队列」对多人大厅完全失明。
          byCapacity: capacities.map((capacity) => {
            const qp = queuedParties.filter((p) => partyCapacity(p) === capacity);
            return {
              capacity,
              waiting: queued.filter((t) => t.capacity === capacity).length,
              parties: qp.length,
              partyWaiting: qp.reduce((n, p) => n + p.size, 0),
              matches: [...matches.values()].filter((m) => m.difficulty === difficulty && (m.capacity == null ? SEATS : m.capacity) === capacity).length,
            };
          }),
        }];
      })),
      nodes: [...nodeLoad.entries()].map(([n, v]) => ({ n, ...v, disabled: DISABLED_NODES.has(n) })),
    });
  }

  if (pathname === '/api/health') return json(res, 200, { ok: true, ts: Date.now() });

  // 管理页面：没有管理员权限时连页面存在性都不暴露，直接 404
  if (pathname === '/admin.html' || pathname === '/admin') {
    const ok = await account.adminGate(req);
    if (!ok) {
      res.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
      });
      return res.end('Not Found');
    }
  }

  return serveStatic(res, pathname);
});

setInterval(() => { formMatches(); formPartyMatches(); sweep(); sweepParties(); }, 1000);
setInterval(refreshNodes, 3000);
// Room details (players/spectator limit) change without a room-directory event; keep the
// console snapshot fresh so a dynamic maxSpectators is not stuck at the old value.
setInterval(() => scheduleWriteRoomDir(), 5000).unref?.();
refreshNodes();

// 账号库初始化（表不存在时自动创建），失败不阻塞匹配服务
account.ensureSchema()
  .then(() => console.log('[mm] account schema ready'))
  .catch((e) => console.warn('[mm] account schema init failed:', e && e.message));

server.listen(PORT, HOST, () => {
  console.log(`[mm] matchmaking on http://${HOST}:${PORT}/`);
  if (DISABLED_NODES.size) {
    console.log(`[mm] 暂停接收新对局的节点: ${[...DISABLED_NODES].sort((a, b) => a - b).join(',')}`);
  }
});


// ---------------------------------------------------------------- 账号接口

function readJsonBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendAuthJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function clientIp(req) {
  return String(req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

