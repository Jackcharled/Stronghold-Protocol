'use strict';
// 卫戍协议 · 节点管理面板（无第三方依赖）
// 端口 DASH_PORT（默认 3080）。数据来源：
//   * `pm2 jlist`  —— 进程状态、CPU、内存、重启次数、启动时间
//   * 各节点 /healthz —— 在线人数、房间数、运行时长
// 操作走 pm2 命令行：start / stop / restart（all 或单个 node-N）。

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const updateFile = require('D:/Stronghold-Protocol/guard/update-file.cjs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

// 防护 / 补丁相关的本地路径（面板只监听 127.0.0.1，这些操作不会被外网触发）
const GUARD = {
  heartbeat: 'D:\\Stronghold-Protocol\\guard\\heartbeat.txt',
  state: 'D:\\Stronghold-Protocol\\guard\\state.json',
  task: 'SP-Nginx-AutoBan',
};
const SCHTASKS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
const GATE_PATH = 'D:\\Stronghold-Protocol\\content\\game-gate.json';
function readGameGate() {
  try {
    const j = JSON.parse(fs.readFileSync(GATE_PATH, 'utf8'));
    return { start: j.start !== false, match: j.match !== false, reason: String(j.reason || ''), updatedAt: j.updatedAt || 0 };
  } catch {
    return { start: true, match: true, reason: '', updatedAt: 0 };
  }
}

function run(file, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '').slice(-3000), err: String(stderr || (err && err.message) || '').slice(-2000) }));
  });
}

/** 自动封 IP 守护状态，供面板展示。 */
function protectionSnapshot() {
  const snap = { autoban: { running: false, heartbeat: null, bans: [] } };
  try {
    const t = new Date(fs.readFileSync(GUARD.heartbeat, 'utf8').trim());
    snap.autoban.heartbeat = t.toISOString();
    snap.autoban.running = Date.now() - t.getTime() < 45_000;
  } catch { /* 没心跳文件 */ }
  try {
    const s = JSON.parse(fs.readFileSync(GUARD.state, 'utf8'));
    for (const [ip, v] of Object.entries(s.bans || {})) snap.autoban.bans.push({ ip, until: v.until });
  } catch { /* 没封禁状态 */ }
  return snap;
}

const BASE = 'D:\\Stronghold-Protocol';
const NODES = 30;

// ---- 节点一致性检查（只读）：对比 node-2..30 与 node-1 的关键服务端文件 ----
const CONSISTENCY_FILES = [
  'server/lobby.js',
  'server/http/config.js',
  'server/net.js',
  'server/persist/index.js',
  'server/persist/persister.js',
  'shared/constants.js',
];
let consistencyCache = { at: 0, data: null };
function sha256File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; }
}
function consistencySnapshot(force = false) {
  if (!force && consistencyCache.data && Date.now() - consistencyCache.at < 20_000) return consistencyCache.data;
  const base = {};
  for (const rel of CONSISTENCY_FILES) base[rel] = sha256File(path.join(BASE, 'node-1', rel));
  const bad = [];
  for (let n = 2; n <= NODES; n++) {
    const diffs = [];
    for (const rel of CONSISTENCY_FILES) {
      const h = sha256File(path.join(BASE, `node-${n}`, rel));
      if (!h || h !== base[rel]) diffs.push(rel);
    }
    if (diffs.length) bad.push({ n, diffs });
  }
  const data = { at: Date.now(), files: CONSISTENCY_FILES, total: NODES - 1, differing: bad.length, nodes: bad };
  consistencyCache = { at: data.at, data };
  return data;
}

// ---- 房间号（只读）：matchmaker 把各节点上报的房间目录写到 content/rooms.json ----
const ROOMS_FILE = path.join(BASE, 'content', 'rooms.json');
let roomsCache = { at: 0, data: null };
function roomsSnapshot() {
  if (roomsCache.data && Date.now() - roomsCache.at < 3000) return roomsCache.data;
  let data = { at: 0, total: 0, nodes: [] };
  try {
    const j = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    const now = Date.now();
    const nodes = (j.nodes || [])
      .filter((x) => x && now - (Number(x.at) || 0) < 120_000)
      .map((x) => ({ n: x.n, rooms: Array.isArray(x.rooms) ? x.rooms : (x.codes || []).map((code) => ({ code })) }))
      .filter((x) => x.rooms.length);
    data = { at: j.at || 0, total: nodes.reduce((s, x) => s + x.rooms.length, 0), nodes };
  } catch { /* 还没有文件 */ }
  roomsCache = { at: Date.now(), data };
  return data;
}
const PORT = Number(process.env.DASH_PORT || 3080);
const HOST = process.env.DASH_HOST || '127.0.0.1';
const TOKEN = process.env.DASH_TOKEN || '';
const LOG_DIR = path.join(BASE, 'logs');
const PUB = path.join(__dirname, 'public');

// nginx 走 ASCII 联接路径，避免中文路径在部分命令行环境下乱码
const NGINX = {
  exe: 'D:\\sp-nginx\\nginx.exe',
  prefix: 'D:\\sp-nginx\\',
  pid: 'D:\\sp-nginx\\logs\\nginx.pid',
  portal: 'https://stronghold.luobomiao.love/',
};
const nodeName = (n) => `node-${n}`;
const nodePort = (n) => 3000 + n;
const nodeUrl = (n, host) => `http://${host}:${nodePort(n)}/`;

let snapshot = { ts: 0, nodes: [], summary: { online: 0, total: NODES, players: 0, rooms: 0, mem: 0 }, error: null };
// ---- 指标历史（点线图用）：30 秒采样一次，保留 24 小时 ----
const HISTORY_FILE = 'D:/Stronghold-Protocol/content/metrics-history.json';
const HISTORY_STEP_MS = 30_000;
const HISTORY_MAX = 2880; // 24h / 30s
let history = [];
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); if (!Array.isArray(history)) history = []; } catch { history = []; }
let historyWrites = 0;
function pushHistory(s) {
  const now = Date.now();
  const last = history[history.length - 1];
  if (last && now - last.t < HISTORY_STEP_MS - 1000) return;
  history.push({ t: now, players: s.players | 0, ai: s.ai | 0, rooms: s.rooms | 0, online: s.online | 0 });
  if (history.length > HISTORY_MAX) history = history.slice(history.length - HISTORY_MAX);
  if (++historyWrites % 10 === 0) {
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch { /* 忽略 */ }
  }
}

let refreshing = false;

// 直接调用 pm2 的 node 入口，避免 shell:true（Node 24 会报 DEP0190，也避免参数拼接风险）
const PM2_JS = 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\pm2\\bin\\pm2';

function pm2Jlist() {
  return new Promise((resolve) => {
    execFile(process.execPath, [PM2_JS, 'jlist'], { timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
  });
}

async function probe(n) {
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${nodePort(n)}/healthz`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    return { httpOk: res.ok, ms: Date.now() - started, health: data };
  } catch (e) {
    return { httpOk: false, ms: Date.now() - started, health: null, error: String(e && e.message || e) };
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function nginxStatus() {
  let pid = null;
  try { pid = Number(String(fs.readFileSync(NGINX.pid, 'utf8')).trim()) || null; } catch { /* 没有 pid 文件 */ }
  const alive = pid ? pidAlive(pid) : false;
  let portalOk = false;
  try {
    const res = await fetch(NGINX.portal, { signal: AbortSignal.timeout(1200) });
    portalOk = res.ok;
  } catch { /* 没在监听 */ }
  return { running: alive || portalOk, pid, alive, portalOk, portal: NGINX.portal };
}

function nginxSignal(signal) {
  return new Promise((resolve) => {
    execFile(NGINX.exe, ['-p', NGINX.prefix, '-s', signal], { timeout: 10000, windowsHide: true },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || (err && err.message) || '') }));
  });
}

function nginxStart() {
  return new Promise((resolve) => {
    try {
      const child = spawn(NGINX.exe, ['-p', NGINX.prefix], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      resolve({ ok: true, out: 'started' });
    } catch (e) {
      resolve({ ok: false, err: String(e && e.message || e) });
    }
  });
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const list = await pm2Jlist();
    const byName = new Map((list || []).map((p) => [p.name, p]));
    const nodes = await Promise.all(Array.from({ length: NODES }, async (_, i) => {
      const n = i + 1;
      const name = nodeName(n);
      const app = byName.get(name) || null;
      const probeResult = await probe(n);
      const env = (app && app.pm2_env) || {};
      return {
        n,
        name,
        port: nodePort(n),
        status: env.status || 'missing',
        pid: app ? app.pid : null,
        cpu: app && typeof app.monit === 'object' ? app.monit.cpu : 0,
        mem: app && typeof app.monit === 'object' ? app.monit.memory : 0,
        restarts: env.restart_time != null ? env.restart_time : 0,
        uptimeMs: env.pm_uptime ? Date.now() - env.pm_uptime : 0,
        httpOk: probeResult.httpOk,
        latencyMs: probeResult.ms,
        health: probeResult.health,
        error: probeResult.error || null,
      };
    }));
    const online = nodes.filter((x) => x.status === 'online').length;
    let matchmaking = null;
    try {
      const res = await fetch('http://127.0.0.1:3090/api/stats', { signal: AbortSignal.timeout(1500) });
      const j = await res.json();
      matchmaking = { waiting: j.waiting, tickets: j.tickets, matches: j.matches, parties: j.parties, partyWaiting: j.partyWaiting, byDifficulty: j.byDifficulty || null, ok: true };
    } catch { matchmaking = { ok: false, waiting: 0, tickets: 0, matches: 0, parties: 0, partyWaiting: 0 }; }
    snapshot = {
      ts: Date.now(),
      nodes,
      nginx: await nginxStatus(),
      matchmaking,
      protection: protectionSnapshot(),
      consistency: consistencySnapshot(),
      rooms: roomsSnapshot(),
      summary: {
        online,
        total: NODES,
        players: nodes.reduce((s, x) => s + ((x.health && x.health.humans) || 0), 0),
        connections: nodes.reduce((s, x) => s + ((x.health && x.health.sockets) || 0), 0),
        guests: nodes.reduce((s, x) => s + ((x.health && x.health.guests) || 0), 0),
    ai: nodes.reduce((s, x) => s + ((x.health && x.health.bots) || 0), 0),
        rooms: nodes.reduce((s, x) => s + ((x.health && x.health.rooms) || 0), 0),
        matches: nodes.reduce((s, x) => s + ((x.health && x.health.matches) || 0), 0),
        mem: nodes.reduce((s, x) => s + (x.mem || 0), 0),
      },
      error: list ? null : '无法读取 pm2 进程列表（pm2 未运行？）',
    };
    try { pushHistory(snapshot.summary); } catch { /* 忽略 */ }
  } finally {
    refreshing = false;
  }
}

function runPm2(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [PM2_JS, ...args], { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').slice(-4000), err: String(stderr || '').slice(-2000) });
    });
  });
}

function logFiles(name) {
  let files = [];
  try { files = fs.readdirSync(LOG_DIR); } catch { return null; }
  const pick = (kind) => {
    const m = files.filter((f) => f === `${name}.${kind}.log` || f.startsWith(`${name}.${kind}`)).sort();
    return m.length ? path.join(LOG_DIR, m[m.length - 1]) : null;
  };
  return { out: pick('out'), err: pick('error') };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

function authorized(req) {
  if (!TOKEN) return true;
  const url = new URL(req.url, 'http://x');
  return url.searchParams.get('token') === TOKEN || req.headers['x-dash-token'] === TOKEN;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/history') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const minutes = Math.min(1440, Math.max(10, Number(url.searchParams.get('minutes')) || 180));
    const since = Date.now() - minutes * 60_000;
    return sendJson(res, 200, { ok: true, minutes, points: history.filter((x) => x.t >= since) });
  }

  if (pathname === '/api/status') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, snapshot);
  }

  if (pathname === '/api/consistency') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, { ok: true, ...consistencySnapshot(true) });
  }

  if (pathname === '/api/action' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const action = payload.action;
      const target = payload.target;
      if (!['start', 'stop', 'restart', 'reload'].includes(action)) return sendJson(res, 400, { error: 'bad action' });
      if (target !== 'all' && !/^node-([1-9]|[12]\d|30)$/.test(target || '')) return sendJson(res, 400, { error: 'bad target' });
      const result = await runPm2([action, target]);
      refresh();
      return sendJson(res, 200, result);
    });
    return;
  }

  if (pathname === '/api/nginx' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const action = payload.action;
      let result;
      if (action === 'start') result = await nginxStart();
      else if (action === 'stop') result = await nginxSignal('stop');
      else if (action === 'reload' || action === 'restart') result = await nginxSignal('reload');
      else return sendJson(res, 400, { error: 'bad action' });
      await new Promise((r) => setTimeout(r, action === 'start' ? 1200 : 800));
      const status = await nginxStatus();
      refresh();
      return sendJson(res, 200, { ...result, status });
    });
    return;
  }

  if (pathname === '/api/game-gate' && req.method === 'GET') {
    return sendJson(res, 200, readGameGate());
  }
  if (pathname === '/api/game-gate' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      if (typeof payload.start !== 'boolean' || typeof payload.match !== 'boolean') {
        return sendJson(res, 400, { error: 'start and match must be boolean' });
      }
      const doc = {
        start: payload.start,
        match: payload.match,
        reason: String(payload.reason || '').slice(0, 200),
        updatedAt: Date.now(),
      };
      try { fs.writeFileSync(GATE_PATH, JSON.stringify(doc, null, 2), 'utf8'); } catch {
        return sendJson(res, 500, { error: 'write failed' });
      }
      return sendJson(res, 200, { ok: true, ...doc });
    });
    return;
  }
  if (pathname === '/api/announcements' && req.method === 'GET') {
    try {
      const raw = fs.readFileSync('D:/Stronghold-Protocol/content/announcements.json', 'utf8');
      return sendJson(res, 200, JSON.parse(raw));
    } catch { return sendJson(res, 200, []); }
  }

  if (pathname === '/api/announcements' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 500000) req.destroy(); });
    req.on('end', () => {
      try {
        const list = JSON.parse(body || '[]');
        if (!Array.isArray(list)) return sendJson(res, 400, { error: 'must be an array' });
        fs.mkdirSync('D:/Stronghold-Protocol/content', { recursive: true });
        fs.writeFileSync('D:/Stronghold-Protocol/content/announcements.json', JSON.stringify(list, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, count: list.length });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    });
    return;
  }

  if (pathname === '/api/update' && req.method === 'GET') {
    try { return sendJson(res, 200, updateFile.readUpdate()); }
    catch { return sendJson(res, 200, { enabled: false, version: '', text: '' }); }
  }

  if (pathname === '/api/update' && req.method === 'POST') {
    let body = "";
    req.on('data', (c) => { body += c; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      let doc;
      try {
        doc = updateFile.writeUpdate({ enabled: payload.enabled === true, version: payload.version, text: payload.text });
      } catch (e) { return sendJson(res, 500, { error: e.message }); }
      return sendJson(res, 200, { ok: true, update: doc });
    });
    return;
  }

  if (pathname === '/api/create-room' && req.method === 'GET') {
    try { return sendJson(res, 200, JSON.parse(fs.readFileSync('D:/Stronghold-Protocol/shared/data/create-room.json', 'utf8'))); }
    catch { return sendJson(res, 200, { enabled: true }); }
  }
  if (pathname === '/api/create-room' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const enabled = p.enabled === true;
      try {
        fs.mkdirSync('D:/Stronghold-Protocol/shared/data', { recursive: true });
        fs.writeFileSync('D:/Stronghold-Protocol/shared/data/create-room.json', JSON.stringify({ enabled }, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, enabled });
      } catch (e) { return sendJson(res, 500, { error: String(e && e.message || e) }); }
    });
    return;
  }

  if (pathname === '/api/room-ttl' && req.method === 'GET') {
    try { return sendJson(res, 200, JSON.parse(fs.readFileSync('D:/Stronghold-Protocol/shared/data/room-ttl.json', 'utf8'))); }
    catch { return sendJson(res, 200, { minutes: 15 }); }
  }
  if (pathname === '/api/room-ttl' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const m = Number(p.minutes);
      if (!Number.isFinite(m) || m < 1 || m > 1440) return sendJson(res, 400, { error: 'minutes 需为 1~1440' });
      try {
        fs.mkdirSync('D:/Stronghold-Protocol/shared/data', { recursive: true });
        fs.writeFileSync('D:/Stronghold-Protocol/shared/data/room-ttl.json', JSON.stringify({ minutes: Math.round(m) }, null, 2), 'utf8');
      } catch (e) { return sendJson(res, 500, { error: e.message }); }
      return sendJson(res, 200, { ok: true, minutes: Math.round(m) });
    });
    return;
  }

  if (pathname === '/api/announcement' && req.method === 'GET') {
    try {
      const raw = fs.readFileSync('D:\\Stronghold-Protocol\\guard\\announcement.json', 'utf8');
      return sendJson(res, 200, JSON.parse(raw));
    } catch { return sendJson(res, 200, { enabled: false, text: '' }); }
  }

  if (pathname === '/api/announcement' && req.method === 'POST') {
    let body = "";
    req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const doc = { enabled: payload.enabled === true, text: String(payload.text || "").slice(0, 2000), updatedAt: new Date().toISOString() };
      try {
        fs.mkdirSync('D:\\Stronghold-Protocol\\guard', { recursive: true });
        fs.writeFileSync('D:\\Stronghold-Protocol\\guard\\announcement.json', JSON.stringify(doc, null, 1));
      } catch (e) { return sendJson(res, 500, { error: e.message }); }
      return sendJson(res, 200, { ok: true, announcement: doc });
    });
    return;
  }

  if (pathname === '/api/protection') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, protectionSnapshot());
  }

  if (pathname === '/api/protection/action' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      const action = payload.action;
      let result;
      if (action === 'autoban-start') result = await run(SCHTASKS, ['/Run', '/TN', GUARD.task], 20000);
      else if (action === 'autoban-stop') result = await run(SCHTASKS, ['/End', '/TN', GUARD.task], 20000);
      else if (action === 'autoban-unban') {
        const ip = String(payload.ip || '');
        if (!/^[0-9a-fA-F:.]+$/.test(ip)) return sendJson(res, 400, { error: 'bad ip' });
        await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `Remove-NetFirewallRule -DisplayName 'SP-AutoBan-${ip}' -ErrorAction SilentlyContinue`], 20000);
        try {
          const st = JSON.parse(fs.readFileSync(GUARD.state, 'utf8'));
          if (st.bans && st.bans[ip]) { delete st.bans[ip]; fs.writeFileSync(GUARD.state, JSON.stringify(st, null, 1)); }
        } catch { /* ignore */ }
        result = { ok: true, out: `已解封 ${ip}` };
      } else return sendJson(res, 400, { error: 'bad action' });
      refresh();
      return sendJson(res, 200, result);
    });
    return;
  }

  if (pathname === '/api/logs') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    const name = url.searchParams.get('name') || '';
    if (!/^node-([1-9]|[12]\d|30)$/.test(name)) return sendJson(res, 400, { error: 'bad name' });
    const files = logFiles(name);
    if (!files) return sendJson(res, 200, { out: '', err: '', files: null });
    const tail = (file) => {
      if (!file) return '';
      try {
        const st = fs.statSync(file);
        const fd = fs.openSync(file, 'r');
        const len = Math.min(st.size, 64 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        return buf.toString('utf8');
      } catch { return ''; }
    };
    return sendJson(res, 200, { out: tail(files.out), err: tail(files.err), files });
  }

  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, ts: Date.now() });
  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] http://localhost:${PORT}/  (${HOST}:${PORT})`);
  refresh();
  setInterval(refresh, 3000);
});
