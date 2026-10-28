'use strict';
// 卫戍协议 · 节点管理面板（无第三方依赖）
// 端口 DASH_PORT（默认 3080）。数据来源：
//   * `pm2 jlist`  —— 进程状态、CPU、内存、重启次数、启动时间
//   * 各节点 /healthz —— 在线人数、房间数、运行时长
// 操作走 pm2 命令行：start / stop / restart（all 或单个 node-N）。

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
// ★ 2026-10-27 修复：原来这一行在 path require 之前就用了 path / BASE，启动即抛
//   `ReferenceError: Cannot access 'path' before initialization`，dashboard 无限重启。
//   一直没暴露是因为它从 10-26 起就没重启过（跑内存里的旧版本）。
//   BASE = 部署根（含 node-1 的那一级），优先 SP_ROOT。
const BASE = process.env.SP_ROOT || (() => {
  const up = path.resolve(__dirname, '..');
  return fs.existsSync(path.join(up, 'node-1')) ? up : __dirname;
})();
const updateFile = require(path.join(BASE, 'guard', 'update-file.cjs'));

// 防护 / 补丁相关的本地路径（面板只监听 127.0.0.1，这些操作不会被外网触发）
const GUARD = {
  heartbeat: path.join(BASE, 'guard', 'heartbeat.txt'),
  state: path.join(BASE, 'guard', 'state.json'),
  task: 'SP-Nginx-AutoBan',
};
const SCHTASKS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
const GATE_PATH = path.join(BASE, 'content', 'game-gate.json');
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

// 部署根目录：优先环境变量 SP_ROOT，否则由本文件位置推导（dashboard/ 的上一级）。
// 不写死盘符与用户名，仓库公开时不会泄露部署机的目录结构。
// ⚠ BASE 已在文件顶部定义（那里要先 require guard 模块），这里不再重复声明。
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

// nginx 的路径：跟着部署根走，不要写死旧目录。
// ⚠ 2026-10-28：这里原来写的是 D:\sp-nginx（迁移前的旧路径），
//   于是控制台上的「启动 / 重载配置 / 停止」按钮全都指向一个不存在的 exe，
//   点了没有任何效果 —— 维护者以为能重载，其实什么都没发生。
const NGINX = {
  exe: path.join(BASE, 'nginx', 'nginx.exe'),
  prefix: BASE + path.sep + 'nginx' + path.sep,
  pid: path.join(BASE, 'nginx', 'logs', 'nginx.pid'),
  portal: 'https://stronghold.luobomiao.love/',
};
const nodeName = (n) => `node-${n}`;
const nodePort = (n) => 3000 + n;
const nodeUrl = (n, host) => `http://${host}:${nodePort(n)}/`;

let snapshot = { ts: 0, nodes: [], summary: { online: 0, total: NODES, players: 0, rooms: 0, mem: 0 }, error: null };
// ---- 指标历史（点线图用）：30 秒采样一次，保留 24 小时 ----
const HISTORY_FILE = path.join(BASE, 'content', 'metrics-history.json');
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
// PM2 CLI 位置：优先 SP_PM2_JS，否则按当前用户的 npm 全局目录推导（不写死用户名）。
const PM2_JS = process.env.SP_PM2_JS
  || require('node:path').join(process.env.APPDATA || '', 'npm', 'node_modules', 'pm2', 'bin', 'pm2');

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
    // cwd 必须是部署根：pm2 是相对「当前进程的工作目录」找 ecosystem 文件的，
    // dashboard 由 pm2 从别处拉起时 cwd 不一定是 BASE，会报
    // `[PM2][ERROR] File ecosystem.config.cjs not found`。
    execFile(process.execPath, [PM2_JS, ...args],
      { timeout: 30000, windowsHide: true, cwd: BASE, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout || '').slice(-4000), err: String(stderr || '').slice(-2000) });
      });
  });
}

// ===================================================================
// 运维（原 `运维.bat` 菜单的网页版）
//
// 判断「节点跑的是新代码还是旧代码」用的是同一个口径：进程启动时间 vs
// 该节点 server/ 下所有 .js 的最新 mtime。pm2 的 pm_uptime 来自 jlist，
// 比 /healthz 的 uptimeSec 更准（后者会被节点自己算错）。
//
// 安全规则（手册 §9.9 / 重启纪律）：
//   * matches > 0 的节点【永远】不动，前端传什么都不行 —— 这里再复查一次；
//   * matches = 0 的节点即使有房间/连接也安全，浏览器会自动重连；
//   * 重启必须 confirm:true，不做静默执行。
// ===================================================================
const OPS_STALE_MS = 3000;
let opsCache = { at: 0, data: null };

/** 所有节点 server/ 下 .js 的最新 mtime —— 超过它启动的进程才算载入了新代码。 */
function latestCodeMtime() {
  let max = 0;
  for (let n = 1; n <= NODES; n++) {
    const dir = path.join(BASE, `node-${n}`, 'server');
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let ents;
      try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { stack.push(full); continue; }
        if (!e.name.endsWith('.js')) continue;
        try {
          const t = fs.statSync(full).mtimeMs;
          if (t > max) max = t;
        } catch { /* 权限/正在写 */ }
      }
    }
  }
  return max;
}

/** nginx.conf 里当前对外开放的节点（解析 split_clients 的权重行）。 */
function readOpenList() {
  try {
    const conf = fs.readFileSync(path.join(BASE, 'nginx', 'conf', 'nginx.conf'), 'utf8');
    const out = [];
    const re = /^\s*[\d.]+%\s+(?:\$sp_route_)?(\d+);/gm;
    let m;
    while ((m = re.exec(conf))) out.push(Number(m[1]));
    return Array.from(new Set(out)).sort((a, b) => a - b);
  } catch {
    return null;
  }
}

async function opsState() {
  if (opsCache.data && Date.now() - opsCache.at < OPS_STALE_MS) return opsCache.data;
  const codeAt = latestCodeMtime();
  const list = await pm2Jlist();
  const byName = new Map((list || []).map((p) => [p.name, p]));
  const nodes = await Promise.all(Array.from({ length: NODES }, async (_, i) => {
    const n = i + 1;
    const app = byName.get(nodeName(n));
    const env = (app && app.pm2_env) || {};
    const pr = await probe(n);
    const h = pr.health || {};
    const startedAt = env.pm_uptime || null;
    const fresh = !!(startedAt && codeAt && startedAt >= codeAt);
    return {
      n,
      name: nodeName(n),
      status: env.status || 'missing',
      fresh,
      startedAt,
      matches: Number(h.matches) || 0,
      rooms: Number(h.rooms) || 0,
      sockets: Number(h.sockets) || 0,
      players: (Number(h.humans) || 0) + (Number(h.bots) || 0),
      alive: pr.httpOk,
      // 只有「跑旧代码 + 没对局 + 进程活着」才允许重启
      restartable: !fresh && Number(h.matches) === 0 && pr.httpOk,
    };
  }));
  const restartable = nodes.filter((x) => x.restartable).map((x) => x.n);
  const stale = nodes.filter((x) => !x.fresh && x.alive).map((x) => x.n);
  const data = {
    at: Date.now(),
    codeAt,
    nodes,
    restartable,
    stale,
    fresh: nodes.filter((x) => x.fresh).map((x) => x.n),
    openList: readOpenList(),
    summary: {
      alive: nodes.filter((x) => x.alive).length,
      matches: nodes.reduce((s, x) => s + x.matches, 0),
      rooms: nodes.reduce((s, x) => s + x.rooms, 0),
      players: nodes.reduce((s, x) => s + x.players, 0),
    },
  };
  opsCache = { at: data.at, data };
  return data;
}

/** 重启空闲节点：重新取一次状态（不信前端传来的列表），逐个复查 matches。 */
async function opsRestartIdle(want) {
  opsCache = { at: 0, data: null };
  const st = await opsState();
  let targets = st.restartable;
  if (Array.isArray(want) && want.length) targets = targets.filter((n) => want.includes(n));
  if (!targets.length) return { ok: true, restarted: [], skipped: [], message: '没有可以重启的空闲节点' };

  // 最后一道闸：重启前立刻再逐个确认 matches=0，有变化就剔除
  const safe = [];
  const skipped = [];
  for (const n of targets) {
    const pr = await probe(n);
    const m = Number((pr.health || {}).matches) || 0;
    if (m === 0) safe.push(n); else skipped.push({ n, matches: m });
  }
  if (!safe.length) return { ok: true, restarted: [], skipped, message: '复查时有节点开始了对局，已全部跳过' };

  // 用绝对路径：不依赖 cwd，也不会被别的 ecosystem 文件抢走
  const eco = path.join(BASE, 'ecosystem.config.cjs');
  if (!fs.existsSync(eco)) {
    return { ok: false, restarted: [], skipped, error: `找不到 ${eco}`, message: '没有重启任何节点（找不到 ecosystem.config.cjs）' };
  }
  const res = await runPm2(['startOrReload', eco, '--only', safe.map(nodeName).join(','), '--update-env']);
  opsCache = { at: 0, data: null };
  if (!res.ok) {
    // pm2 失败时【绝不能】报「已重启」——之前就是这样误报，实际一个都没动
    return {
      ok: false,
      restarted: [],
      skipped,
      out: res.out.slice(-1500),
      err: res.err.slice(-1200),
      message: `重启失败，没有节点被重启：${(res.err || res.out || '').split('\n').filter(Boolean).pop() || '未知原因'}`,
    };
  }
  // 成功了才 save（失败时 save 会固化一个可能不对的进程表）
  await runPm2(['save']);
  // 复查：起来了吗？新旧对不对？
  await new Promise((r) => setTimeout(r, 6000));
  opsCache = { at: 0, data: null };
  const after = await opsState();
  const stillOld = safe.filter((n) => {
    const x = after.nodes.find((y) => y.n === n);
    return x && !x.fresh;
  });
  const dead = safe.filter((n) => {
    const x = after.nodes.find((y) => y.n === n);
    return x && !x.alive;
  });
  let message = `已重启 ${safe.length} 个：${safe.join(', ')}`;
  if (dead.length) message += `；⚠ 未响应：${dead.join(', ')}`;
  if (stillOld.length) message += `；⚠ 仍是旧代码：${stillOld.join(', ')}`;
  return {
    ok: !dead.length && !stillOld.length,
    restarted: safe,
    skipped,
    dead,
    stillOld,
    out: res.out.slice(-1500),
    err: res.err.slice(-800),
    message,
  };
}

// ===================================================================
// 关闭单个房间
//
// 房间归某个节点所有，别的节点不认识这个房间号，必须打「房间所在的那台」。
// 节点侧的 POST /admin/room/close 用 .secrets/watch-secret 的 HMAC 认人
// （server/http/routes.js），所以这里签一个 60 秒有效的凭证即可。
// ===================================================================
/**
 * 某台节点是否已经加载了 `/admin/room/close`（server/http/routes.js 里的路由）。
 *
 * 判据：进程启动时间 ≥ 该节点 routes.js 的 mtime。运维区判断「新/旧代码」用的是同一套口径。
 * 读不到任何一项时返回 ok:true（宁可发出去让它自然报 405，也不要凭空拦住维护者），
 * 但能判断出来的时候要说清楚 —— 否则维护者只会看到一个 405 和一句「关闭失败」。
 * @param {number} n
 * @returns {{ ok: boolean, why?: string }}
 */
function roomCloseCapable(n) {
  let mtime = 0;
  try { mtime = fs.statSync(path.join(BASE, `node-${n}`, 'server', 'http', 'routes.js')).mtimeMs; } catch { return { ok: true }; }
  const proc = processStarts().get(n);
  if (!proc) return { ok: true };                 // 查不到启动时间就不拦
  if (proc >= mtime) return { ok: true };
  return { ok: false, why: `node-${n} 的进程启动于 ${new Date(proc).toLocaleString('zh-CN', { hour12: false })}，`
    + `早于关闭房间接口的上线时间（${new Date(mtime).toLocaleString('zh-CN', { hour12: false })}）。`
    + '这台节点需要重启一次才能用这个功能。' };
}

/** node-N → 进程启动时间（毫秒）。来自 pm2 jlist，一次刷新内复用。 */
let procCache = { at: 0, map: new Map() };
function processStarts() {
  if (Date.now() - procCache.at < 5000) return procCache.map;
  const map = new Map();
  try {
    const out = require('node:child_process').execFileSync(process.execPath, [PM2_JS, 'jlist'],
      { timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
    for (const p of JSON.parse(out)) {
      const m = /^node-(\d+)$/.exec(p.name || '');
      if (m && p.pm2_env && p.pm2_env.pm_uptime) map.set(Number(m[1]), Number(p.pm2_env.pm_uptime));
    }
  } catch { /* 读不到就返回空表，调用方按 ok:true 处理 */ }
  procCache = { at: Date.now(), map };
  return map;
}

/** 把 405 之类的节点响应翻译成人能看懂的原因。 */
function explainCloseError(status, body, nodeN) {
  if (status === 405) return `node-${nodeN} 还没重启到最新代码，不支持关闭房间（该节点需要重启一次）`;
  if (status === 404) return '房间不存在（可能已经结束或解散）';
  if (status === 403) return '被节点拒绝（签名校验失败，请检查 .secrets/watch-secret）';
  if (status === 400) return '请求参数不对';
  if (status === 0) return `node-${nodeN} 无响应`;
  return (body && body.error) || `关闭失败（HTTP ${status}）`;
}

function closeRoom(codeIn, nodeIn) {
  return new Promise((resolve) => {
    const code = String(codeIn || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,6}$/.test(code)) return resolve({ ok: false, status: 400, error: 'bad_code' });
    let nodeN = Number(nodeIn);
    if (!(nodeN >= 1 && nodeN <= 30)) {
      // 没给节点号就从房间目录里找
      const snap = roomsSnapshot();
      for (const n of snap.nodes || []) {
        if ((n.rooms || []).some((r) => String(r && r.code).toUpperCase() === code)) { nodeN = Number(n.n); break; }
      }
    }
    if (!(nodeN >= 1 && nodeN <= 30)) return resolve({ ok: false, status: 404, error: 'room_not_found' });
    let secret = '';
    try { secret = fs.readFileSync(path.join(BASE, '.secrets', 'watch-secret'), 'utf8').trim(); } catch { /* 下面返回 */ }
    if (!secret) return resolve({ ok: false, status: 503, error: 'no_secret' });
    const exp = Date.now() + 60_000;
    const sig = crypto.createHmac('sha256', secret).update(`${code}.${exp}`).digest('base64url');
    const payload = JSON.stringify({ code, exp });
    // 这一台节点跑的是不是带 /admin/room/close 的代码？
    // 没重启的节点上这个路由不存在，请求会掉到静态文件兜底，返回 405 + 一张 HTML 错误页，
    // 页面上只显示「关闭失败」，完全猜不到原因。所以先确认能力，再决定要不要发。
    const cap = roomCloseCapable(nodeN);
    if (!cap.ok) return resolve({ ok: false, status: 409, error: 'node_not_ready', node: nodeN, hint: cap.why });
    const req = http.request({
      host: '127.0.0.1', port: 3000 + nodeN, path: '/admin/room/close', method: 'POST', timeout: 8000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-sp-admin-sig': sig },
    }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch { /* 非 JSON */ }
        if (j && j.ok) return resolve({ ok: true, code, node: nodeN, humans: j.humans, running: j.running });
        // 405 = 这台节点没有该路由（旧代码）；翻译成人能看懂的话
        resolve({
          ok: false,
          status: r.statusCode || 502,
          error: (j && j.error) || (r.statusCode === 405 ? 'node_not_ready' : 'close_failed'),
          hint: explainCloseError(r.statusCode, j, nodeN),
          node: nodeN,
        });
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: String((e && e.code) || e), node: nodeN }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout', node: nodeN }); });
    req.write(payload);
    req.end();
  });
}

/** 把 nginx 开放列表改成「所有已跑新代码的节点」。
 *
 * 开放的口径是维护者定死的：**能更新重启的节点就对外开，不能重启的不开**，
 * 所以这里取的是 `fresh`，跟节点上有没有人无关 —— 有人也照样开放，
 * 因为开放只影响「新访客被随机分到哪」，正在房间里的人一直回自己的节点。
 *
 * 但「有人」这件事必须如实告诉维护者：那台节点上可能正有玩家在等待室，
 * 开放之后新访客会直接落进去。所以下面把这些人列出来，不藏。 */
function opsSetOpenList() {
  return new Promise((resolve) => {
    const script = path.join(BASE, 'tools', '_set-open-nodes.mjs');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: '找不到 tools/_set-open-nodes.mjs' });
    opsCache = { at: 0, data: null };
    opsState().then((st) => {
      if (!st.fresh.length) return resolve({ ok: false, error: '没有任何已更新节点，拒绝执行（会把站点关掉）' });
      // 这些节点上已经有人了（房间开着 / 有连接）：开放后新访客会直接进来
      const occupied = st.nodes.filter((x) => x.fresh && (Number(x.rooms) > 0 || Number(x.sockets) > 0))
        .map((x) => ({ n: x.n, rooms: Number(x.rooms) || 0, sockets: Number(x.sockets) || 0 }));
      execFile(process.execPath, [script, st.fresh.join(',')],
        { cwd: BASE, timeout: 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          opsCache = { at: 0, data: null };
          let message = err ? '更新失败（已自动回滚）' : `已开放 ${st.fresh.length} 个节点`;
          if (!err && occupied.length) {
            message += `；其中 ${occupied.length} 个当时有玩家在房间/等待室里（开放后新访客会直接落进去）：`
              + occupied.map((o) => `node-${o.n}(${o.rooms} 房/${o.sockets} 连)`).join('、');
          }
          resolve({
            ok: !err,
            nodes: st.fresh,
            occupied,
            out: String(stdout || '').slice(-2000),
            err: String(stderr || (err && err.message) || '').slice(-1000),
            message,
          });
        });
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
      const raw = fs.readFileSync(path.join(BASE, 'content', 'announcements.json'), 'utf8');
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
        fs.mkdirSync(path.join(BASE, 'content'), { recursive: true });
        fs.writeFileSync(path.join(BASE, 'content', 'announcements.json'), JSON.stringify(list, null, 2), 'utf8');
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
    try { return sendJson(res, 200, JSON.parse(fs.readFileSync(path.join(BASE, 'shared', 'data', 'create-room.json'), 'utf8'))); }
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
        fs.mkdirSync(path.join(BASE, 'shared', 'data'), { recursive: true });
        fs.writeFileSync(path.join(BASE, 'shared', 'data', 'create-room.json'), JSON.stringify({ enabled }, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, enabled });
      } catch (e) { return sendJson(res, 500, { error: String(e && e.message || e) }); }
    });
    return;
  }

  if (pathname === '/api/room-ttl' && req.method === 'GET') {
    try { return sendJson(res, 200, JSON.parse(fs.readFileSync(path.join(BASE, 'shared', 'data', 'room-ttl.json'), 'utf8'))); }
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
        fs.mkdirSync(path.join(BASE, 'shared', 'data'), { recursive: true });
        fs.writeFileSync(path.join(BASE, 'shared', 'data', 'room-ttl.json'), JSON.stringify({ minutes: Math.round(m) }, null, 2), 'utf8');
      } catch (e) { return sendJson(res, 500, { error: e.message }); }
      return sendJson(res, 200, { ok: true, minutes: Math.round(m) });
    });
    return;
  }

  if (pathname === '/api/announcement' && req.method === 'GET') {
    try {
      const raw = fs.readFileSync(path.join(BASE, 'guard', 'announcement.json'), 'utf8');
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
        fs.mkdirSync(path.join(BASE, 'guard'), { recursive: true });
        fs.writeFileSync(path.join(BASE, 'guard', 'announcement.json'), JSON.stringify(doc, null, 1));
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

  // ---- 运维（对应 运维.bat 菜单）：判断哪些节点可以安全重启 / 一键重启 / 更新 nginx 开放列表 ----
  if (pathname === '/api/ops/state') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    return sendJson(res, 200, await opsState());
  }
  if (pathname === '/api/ops/restart-idle' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      // 前端必须显式传 confirm:true —— 这个动作会打断玩家，不做静默执行
      if (payload.confirm !== true) return sendJson(res, 400, { error: '需要 confirm:true' });
      const want = Array.isArray(payload.nodes) ? payload.nodes.map(Number) : null;
      const result = await opsRestartIdle(want);
      refresh();
      return sendJson(res, 200, result);
    });
    return;
  }
  if (pathname === '/api/ops/open-list' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      if (payload.confirm !== true) return sendJson(res, 400, { error: '需要 confirm:true' });
      const result = await opsSetOpenList();
      refresh();
      return sendJson(res, 200, result);
    });
    return;
  }

  // 重启 nginx：POST /api/nginx/restart { confirm:true }
  //
  // 走 tools\restart-nginx.mjs --apply（2026-10-28 修好的那版）：
  //   quit → 确认进程归零（没退的强杀）→ 确认 443 释放 → 计划任务启动 → 校验
  // 这样新进程必然落在 Session 0，也不会像 `-s reload` 那样留下不退出旧 worker。
  //
  // ⚠ 影响：站点中断约 5–20 秒，所有在线玩家的 socket 会断开并自动重连。
  //   对局数据不丢（node 进程没动），但未修复「对局中清座位」的节点上，
  //   玩家重连时仍可能掉座位 —— 所以这个按钮会先把风险等级报出来。
  if (pathname === '/api/nginx/restart' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      if (payload.confirm !== true) return sendJson(res, 400, { error: '需要 confirm:true' });
      const script = path.join(BASE, 'tools', 'restart-nginx.mjs');
      if (!fs.existsSync(script)) return sendJson(res, 500, { ok: false, error: 'missing_script' });
      const r = await run(process.execPath, [script, '--apply'], 180000);
      refresh();
      const text = (r.out || '') + (r.err || '');
      // 从脚本输出里抓关键结论，回给前端
      const allZero = /全部在 Session 0: ✓/.test(text);
      const procOk = /进程数: 3\s+✓/.test(text);
      const httpsOk = /HTTPS 首页: 200/.test(text);
      return sendJson(res, r.ok && allZero && procOk && httpsOk ? 200 : 500, {
        ok: r.ok && allZero && procOk && httpsOk,
        allZero, procOk, httpsOk,
        out: text.slice(-3000),
        message: allZero && procOk && httpsOk
          ? 'nginx 已重启：3 个进程，全部 Session 0，站点 200'
          : '重启未完全成功，请查看输出',
      });
    });
    return;
  }

  // 关闭单个房间：POST /api/rooms/close { code, node, confirm:true }
  // 节点侧用 .secrets/watch-secret 的 HMAC 认人（server/http/routes.js /admin/room/close），
  // 与控制台 / 管理后台同一条通道，不必在节点上再放管理员密码。
  if (pathname === '/api/rooms/close' && req.method === 'POST') {
    if (!authorized(req)) return sendJson(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { error: 'bad json' }); }
      if (payload.confirm !== true) return sendJson(res, 400, { error: '需要 confirm:true' });
      const result = await closeRoom(payload.code, payload.node);
      refresh();
      return sendJson(res, result.ok ? 200 : (result.status || 500), result);
    });
    return;
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] http://localhost:${PORT}/  (${HOST}:${PORT})`);
  refresh();
  setInterval(refresh, 3000);
});
