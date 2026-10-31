// server/http/buildTag.js — the build tag of the browser runtime this process serves (/healthz `build`).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './config.js';

// ---------------------------------------------------------------------------------------------------
// build tag — the "your page is stale" signal (public/js/ui/buildGuard.js)
// ---------------------------------------------------------------------------------------------------

/**
 * The files that make up the runtime the BROWSER loads. A change in any of them is a new build: an already-open page
 * keeps the modules it imported at load time (ES modules live in the page's module map for its whole lifetime), so
 * without this signal a deployed fix could never reach a player who does not reload — a client-only battle fix
 * shipped exactly that way and stayed invisible on a page that had been opened before the deploy.
 *
 * The browser also imports `/sim/` from `server/sim/` and `/shared/`, and caches JSON from `/data/`. Include those
 * trees so a simulation-only or data-only deploy reaches old pages after the server restarts. `buildTag()` caches
 * this fingerprint for the process lifetime: files changing on disk do not advertise a new build before restart.
 * The rest of `server/` and downloaded media are not included.
 */
export const BUILD_INPUTS = Object.freeze(['public/index.html', 'public/js', 'public/css', 'server/sim', 'shared', 'data']);

/** Names the static server never serves: dot files (`.DS_Store`, `.main.js.swp`) and editor backups (`main.js~`). */
const isIgnoredBuildName = (name) => name.startsWith('.') || name.endsWith('~');

/**
 * Trees under BUILD_INPUTS the browser is served only in part: the official versions' data (DESIGN §35.22, §35.23) — a
 * child of data/versions/ counts only when this process serves it (`servedVersionDirs`: the enabled versions'
 * directories, server/versions.js), so rebuilding a version the server does not offer is no new build.
 */
const VERSIONS_BUILD_DIR = 'data/versions';

/**
 * ★ 2026-10-31（本服）：**每台机器各自不同的运行时配置，不能参与 build 指纹。**
 *
 * 为什么需要：指纹是 `[相对路径, 大小, mtimeMs]`。上游是单机部署，`data/` 下的东西
 * 天然全站一致；但本服是 30 个独立目录，下面这些文件**本来就应该各机不同**：
 *
 *   * `data/create-room.json`  建房开关（维护者可能临时关掉某台机器的建房）
 *   * `data/room-ttl.json`     房间 TTL
 *   * `data/assets.json`       资源清单（各机素材挂载点 / 重建时间不同）
 *
 * 一旦参与指纹，同一份代码在 30 台机器上会算出不同的 build，
 * 玩家跨节点浏览时 `ui/buildGuard.js` 就以为「服务器更新了」并触发一次刷新。
 * 实测：30 个节点分成 4 种指纹，node-1 和多数节点不同，于是反复「刷一下」。
 *
 * 排除它们是安全的：浏览器读的是 `data/` 下的具体数据文件（关卡、干员…），
 * 不读这三个配置；「部署后旧页面能收到新版本」这个目的不受影响。
 */
const LOCAL_RUNTIME_FILES = new Set([
  'data/create-room.json',
  'data/room-ttl.json',
  'data/assets.json',
]);

/** 维护者手工副本（`*.bak-xxx` / `*.old` / `*.orig`）也不算版本。 */
const isBackupName = (rel) => /(?:\.bak|\.old|\.orig)(?:$|[-.])/i.test(path.posix.basename(rel));

/** Whether a BUILD_INPUTS-relative path takes part in the build tag. */
const isBuildInput = (rel) => !LOCAL_RUNTIME_FILES.has(rel) && !isBackupName(rel);

/** @type {{ tag: string|null }|null} */
let buildCache = null;

/**
 * Every file under `abs` (or `abs` itself), as `[relative path, size, mtimeMs]`, sorted by path. Missing → [].
 * @param {string} abs @param {string} rel @param {any[]} out @param {Set<string>} served the served data/versions children
 */
function buildEntries(abs, rel, out, served) {
  let stat;
  try { stat = fs.statSync(abs); } catch { return; }
  if (stat.isFile()) { if (isBuildInput(rel)) out.push([rel, stat.size, stat.mtimeMs]); return; }
  if (!stat.isDirectory()) return;
  let names;
  try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const d of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (isIgnoredBuildName(d.name)) continue;
    const child = path.join(abs, d.name);
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      if (rel === VERSIONS_BUILD_DIR && !served.has(childRel)) continue;
      buildEntries(child, childRel, out, served);
    }
    else if (d.isFile()) {
      if (!isBuildInput(childRel)) continue;
      try { const s = fs.statSync(child); out.push([childRel, s.size, s.mtimeMs]); } catch { /* ignore */ }
    }
  }
}

/**
 * Short hash of the served browser runtime (size + mtime of every BUILD_INPUTS file); null when nothing is readable.
 * @param {string} [root]
 * @param {{ servedVersionDirs?: string[] }} [opts] the absolute data/versions/<slug>/ directories this process serves
 */
export function computeBuildTag(root = ROOT, { servedVersionDirs = [] } = {}) {
  const out = [];
  const versionsAbs = path.join(root, ...VERSIONS_BUILD_DIR.split('/'));
  const served = new Set(servedVersionDirs.map((d) => path.relative(versionsAbs, path.resolve(d)))
    .filter((r) => r && !r.startsWith('..') && !path.isAbsolute(r) && !r.includes(path.sep)).map((r) => `${VERSIONS_BUILD_DIR}/${r}`));
  for (const rel of BUILD_INPUTS) buildEntries(path.join(root, rel), rel, out, served);
  if (!out.length) return null;
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = createHash('sha1');
  for (const [rel, size, mtime] of out) h.update(`${rel}\0${size}\0${Math.floor(mtime)}\n`);
  return h.digest('hex').slice(0, 12);
}

/**
 * The build tag of THIS process. Computed once (`startServer` warms it at startup): the tag describes the files the
 * process is actually serving, every update restarts the server (DEPLOY.md), and re-reading the tree on a timer would
 * let a half-finished deploy — or a file that changed while the process kept running — move the tag under a page.
 * @param {string} [root] used by the first call only (tests)
 * @param {{ servedVersionDirs?: string[] }} [opts] used by the first call only (computeBuildTag)
 */
export function buildTag(root = ROOT, opts = {}) {
  if (buildCache === null) buildCache = { tag: computeBuildTag(root, opts) };
  return buildCache.tag;
}

/** Drop the cache: the next `buildTag()` re-reads the tree (tests, and `startServer`). */
export function resetBuildTag() { buildCache = null; }
