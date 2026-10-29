// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * /studio and /studio/… → the plugin studio (server/studio/index.js: for this machine and the local network only — any
//     other client gets the 404 page; its API also takes POST / PUT / DELETE), when the server has one;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, the vanilla content
//     hash `content.vanilla`, the modded content sets in use `content.sets` and — only when there are some — how many
//     unofficial plugins the server has, `content.plugins` (the title screen's count before any hello) — DESIGN §32 —,
//     sockets, sessions,
//     rooms, matches; `versions: { enabled, default, hosts }` only when the server enables another official version than
//     第二期下半 — DESIGN §35.23), never cached; `?traffic=1` adds the traffic counters (traffic.js: bytes by category since the
//     start, WebSocket wire and payload bytes) for a loopback or private-network client only — the maintainer's
//     decision of 2026-10-12: the figures are the host's, so any other client, also one a tunnel or proxy on this
//     machine forwards, gets the plain report (net.js clientAddress, honouring TRUST_PROXY like the WebSocket limits);
//   * everything else → the static files (static.js).
// Every response's body bytes count in the traffic counters (traffic.js meter). A route that throws is logged and
// answers 500.

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';
import { clientAddress, isLocalIp } from '../net.js';
import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';

/** 后台维护开关（与 server/lobby.js 的 maintenanceGate 读同一批文件）；任何读取失败都按“开放”处理。 */
let __gateStatus = { at: 0, value: { create: true, start: true, match: true } };
function maintenanceStatus() {
  if (Date.now() - __gateStatus.at > 5000) {
    let create = true, start = true, match = true;
    try {
      // 本文件在 node-N/server/http/ 下：上两级是节点根，上三级是项目根（content/ 在项目根）。
      const j = JSON.parse(readFileSync(new URL('../../data/create-room.json', import.meta.url), 'utf8'));
      if (j && j.enabled === false) create = false;
    } catch { /* 缺失 = 开放 */ }
    try {
      const j = JSON.parse(readFileSync(new URL('../../../content/game-gate.json', import.meta.url), 'utf8'));
      if (j && j.start === false) start = false;
      if (j && j.match === false) match = false;
    } catch { /* 缺失 = 开放 */ }
    __gateStatus = { at: Date.now(), value: { create, start, match } };
  }
  return __gateStatus.value;
}

const MAX_URL_LENGTH = 4096;

/** `{ plugins: n }` when the server has n > 0 unofficial plugins (the lobby's visual sets count them), else nothing. */
function pluginCount(lobby) {
  let n;
  try { n = Number(lobby?.plugins?.unofficial?.()) || 0; } catch { n = 0; }
  let notices = false;
  try { notices = lobby?.plugins?.hasNotices?.() === true; } catch { /* optional catalogue hint */ }
  return { ...(n > 0 ? { plugins: n } : {}), ...(notices ? { notices: true } : {}) };
}

/** The content sets with gameplay plugins rooms hold now (DESIGN §32.6; 0 without any). */
function contentSets(lobby) {
  try { return Number(lobby?.plugins?.contentInUse?.()) || 0; } catch { return 0; }
}

/**
 * The GET /healthz body (`withTraffic`: plus the traffic counters and the asset index's state, `?traffic=1`).
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, content?: { cs: string } | null,
 *           traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *           assetIndex?: ReturnType<typeof import('./assetIndex.js').createAssetIndex> | null,
 *           views?: ReturnType<typeof import('./assetViews.js').createManifestViews> | null, trusted?: any,
 *           versions?: ReturnType<typeof import('../versions.js').createVersionSets> | null,
 *           versionHosts?: { stats: () => object } | null }} health
 *   content: the server's vanilla content (server/plugins/identity.js); versions / versionHosts: the official versions
 *   and their match hosts (DESIGN §35.23)
 * @param {boolean} [withTraffic]
 */
export function healthReport({ startedAt, network, registry, lobby, content = null, traffic, assetIndex, views, trusted, versions = null, versionHosts = null }, withTraffic = false) {
  const report = {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: buildTag(),
    // what its rooms play (DESIGN §32): the vanilla content hash, and how many content sets with gameplay plugins rooms
    // hold now (P1c, §32.6 — a room's cosmetic plugins leave its cs the vanilla one, §32.3); how many unofficial plugins
    // it has, when it has some (a page's title screen says so; P1a)
    ...(content ? { content: { vanilla: content.cs, sets: contentSets(lobby), ...pluginCount(lobby) } } : {}),
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
  };
  if (trusted && Object.keys(trusted).length) report.plugins = trusted;
  // the official versions (DESIGN §35.23): only when another one than 第二期下半 is enabled
  if (versions && versions.nonDefault.length) {
    report.versions = { enabled: [...versions.ids], default: versions.defaultId,
      hosts: versionHosts ? versionHosts.stats() : { workers: 0, matches: 0, transport: 'process' } };
  }
  if (withTraffic && traffic) report.traffic = traffic.snapshot();
  // content-hashed asset URLs (assetIndex.js / assetViews.js): off, building, or ready with how many files and URLs
  if (withTraffic) report.assetHashes = assetIndex ? { ...assetIndex.stats(), views: views ? views.stats() : null } : null;
  return report;
}

/** Does the query ask for the traffic counters (`traffic`, `traffic=1`, `traffic=true`)? */
const wantsTraffic = (query) => /(?:^|&)traffic(?:=(?:1|true|yes))?(?:&|$)/i.test(query || '');

// ---- 本服新增：管理员关闭房间的签名校验 ----
// 密钥与隐身观战令牌（server/lobby.js verifyWatchToken）同源：.secrets/watch-secret。
// 节点不读账号库，凭这把共享密钥就能确认「请求来自管理后台」，不必在节点上再存管理员密码。
const __adminSecretFile = new URL('../../../.secrets/watch-secret', import.meta.url);
function adminSecret() {
  try { return readFileSync(__adminSecretFile, 'utf8').trim(); } catch { return ''; }
}
/** 签名 = base64url(HMAC-SHA256(secret, `${code}.${exp}`))；exp 是毫秒时间戳。 */
function verifyAdminSig(code, exp, sig) {
  const sec = adminSecret();
  if (!sec || typeof sig !== 'string' || !sig) return false;
  const want = createHmac('sha256', sec).update(`${code}.${exp}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /admin/room/close { code, exp } + 头 x-sp-admin-sig
 * 关掉本节点上的一个房间：通知所有座位与观战者 room.closed，然后清理。
 * 正在进行的对局会一并终止 —— 这是维护者的明确要求（要能随手关任意房间）。
 */
function handleAdminRoomClose(req, res, health, log, trustProxy) {
  return new Promise((resolve) => {
    const ip = clientAddress(req, trustProxy).ip;
    if (!isLocalIp(ip)) { sendJson(req, res, 403, { ok: false, error: 'forbidden' }); resolve(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { sendJson(req, res, 400, { ok: false, error: 'bad_json' }); resolve(); return; }
      const code = String(payload.code || '').toUpperCase();
      const exp = Number(payload.exp);
      const sig = String(req.headers['x-sp-admin-sig'] || '');
      if (!/^[A-Z0-9]{4,6}$/.test(code)) { sendJson(req, res, 400, { ok: false, error: 'bad_code' }); resolve(); return; }
      if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + 300_000) {
        sendJson(req, res, 400, { ok: false, error: 'bad_exp' }); resolve(); return;
      }
      if (!verifyAdminSig(code, exp, sig)) { sendJson(req, res, 403, { ok: false, error: 'bad_sig' }); resolve(); return; }
      const lobby = health && health.lobby;
      const room = lobby && lobby.rooms ? lobby.rooms.get(code) : null;
      if (!room) { sendJson(req, res, 404, { ok: false, error: 'no_room' }); resolve(); return; }
      const humans = room.seats.filter((s) => s && !s.isBot).length;
      const running = room.match ? 1 : 0;
      try {
        lobby.disposeRoom(room, 'admin-closed');
        log.info(`[http] room ${code} closed by admin (${humans} humans, ${running} running match) from ${ip}`);
        sendJson(req, res, 200, { ok: true, code, humans, running });
      } catch (e) {
        log.error('[http] admin close failed', e);
        sendJson(req, res, 500, { ok: false, error: 'close_failed' });
      }
      resolve();
    });
    req.on('error', () => { resolve(); });
  });
}

/**
 * 本服：POST /admin/room/abort { code, exp } + 头 x-sp-admin-sig
 *
 * 结束房间里**当前这一局**，但保留房间 —— 玩家留在房间里，可以缓过来重新开局。
 * 和 /admin/room/close 的区别就在这：close 是把整个房间销毁、玩家被送回大厅。
 *
 * 鉴权与 close 完全一致（loopback/内网 + HMAC 签名 + 60 秒时限），
 * 因为这也是「能随手打断玩家对局」的破坏性操作。
 */
function handleAdminRoomAbort(req, res, health, log, trustProxy) {
  return new Promise((resolve) => {
    const ip = clientAddress(req, trustProxy).ip;
    if (!isLocalIp(ip)) { sendJson(req, res, 403, { ok: false, error: 'forbidden' }); resolve(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { sendJson(req, res, 400, { ok: false, error: 'bad_json' }); resolve(); return; }
      const code = String(payload.code || '').toUpperCase();
      const exp = Number(payload.exp);
      const sig = String(req.headers['x-sp-admin-sig'] || '');
      if (!/^[A-Z0-9]{4,6}$/.test(code)) { sendJson(req, res, 400, { ok: false, error: 'bad_code' }); resolve(); return; }
      if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + 300_000) {
        sendJson(req, res, 400, { ok: false, error: 'bad_exp' }); resolve(); return;
      }
      if (!verifyAdminSig(code, exp, sig)) { sendJson(req, res, 403, { ok: false, error: 'bad_sig' }); resolve(); return; }
      const lobby = health && health.lobby;
      const room = lobby && lobby.rooms ? lobby.rooms.get(code) : null;
      if (!room) { sendJson(req, res, 404, { ok: false, error: 'no_room' }); resolve(); return; }
      const humans = room.seats.filter((s) => s && !s.isBot).length;
      try {
        const r = lobby.abortMatch(room, { reason: 'admin-aborted' });
        if (!r || r.ok !== true) {
          // 房间在、但这局已经结束了（或压根还没开局）：如实回报，不算失败
          sendJson(req, res, 409, { ok: false, error: 'no_match', code, humans });
          resolve();
          return;
        }
        log.info(`[http] room ${code} match aborted by admin (${humans} humans) from ${ip}`);
        sendJson(req, res, 200, { ok: true, code, humans, roomKept: true });
      } catch (e) {
        log.error('[http] admin abort failed', e);
        sendJson(req, res, 500, { ok: false, error: 'abort_failed' });
      }
      resolve();
    });
    req.on('error', () => { resolve(); });
  });
}

/**
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object, trustProxy?: 'auto' | boolean,
 *           csp?: string | null,
 *           studio?: { handles: (rawPath: string) => boolean, handle: (req: any, res: any, rawPath: string, query: string) => Promise<void> } | null }} deps
 *   trustProxy: whose forwarding headers name the client (net.js clientAddress; the server's TRUST_PROXY); studio: the
 *   plugin studio (server/studio/index.js), or none
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, trustProxy = 'auto', studio = null, csp = null, trustedRuntime = null }) {
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (trustedRuntime && parts.rawPath.startsWith('/x/') && await trustedRuntime.route(req,res,parts.rawPath)) return;
    if (studio && studio.handles(parts.rawPath)) { await studio.handle(req, res, parts.rawPath, parts.query); return; }
    // 本服新增：管理员关闭单个房间（必须在 405 之前 —— 它要 POST）。
    //   POST /admin/room/close  { code, exp }   头 x-sp-admin-sig
    //   POST /admin/room/abort  { code, exp }   头 x-sp-admin-sig   ← 只结束对局，房间留下
    // 签名 = base64url(HMAC-SHA256(secret, `${code}.${exp}`))，secret 是 .secrets/watch-secret，
    // 与隐身观战令牌同源。节点不读账号库，因此靠这把共享密钥判断「是管理后台发的」。
    // 仅本机 / 内网可调用：后台 (3080) 和管理后台都在这一台机器上。
    if (parts.rawPath === '/admin/room/close' && req.method === 'POST') {
      await handleAdminRoomClose(req, res, health, log, trustProxy);
      return;
    }
    if (parts.rawPath === '/admin/room/abort' && req.method === 'POST') {
      await handleAdminRoomAbort(req, res, health, log, trustProxy);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      const withTraffic = wantsTraffic(parts.query) && isLocalIp(clientAddress(req, trustProxy).ip);
      sendJson(req, res, 200, healthReport(health, withTraffic));
      return;
    }
    // 本服：后台维护开关的只读状态，大厅据此把「创建房间」等入口置灰并说明原因。
    // 只暴露开关本身，不含任何内部路径或账号信息；真正的拦截仍在服务端 lobby。
    if (parts.rawPath === '/maintenance.json') {
      res.setHeader('Cache-Control', 'no-store');
      sendJson(req, res, 200, maintenanceStatus());
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    if (csp) res.setHeader('Content-Security-Policy', csp);
    if (health.traffic) health.traffic.meter(res, splitUrl(req.url || '/')?.rawPath || '/');
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
