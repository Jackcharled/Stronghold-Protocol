// public/js/ui/nodeCodeHint.js — 「这个节点还在跑旧代码，打完这局刷新一下」的结算页提示。
//
// 为什么需要它：为了让跑旧代码的节点不再接新玩家，nginx 的 split_clients（新访客去哪）
// 只写「已跑新代码」的节点；但 map $cookie_sp_route（老 cookie 还算不算有效）仍然包含
// 全部存活节点 —— 否则那台上的玩家一刷新就掉回大厅（2026-10-31 事故，手册 §9.34）。
//
// 于是旧代码节点上的人会一直留在旧节点上：能玩、刷新也不掉线，但拿不到最近的修复。
// 维护者要的收尾办法是「玩家打完这局，刷新一次就会到新节点」——
// nginx 的 cookie 只把他粘在**仍开放**的节点上，而旧代码节点已经不在 split_clients / 新访客名单里，
// 所以刷新时 map 之外的分支会把他重新分到一台新代码节点上（前提是这个页面本身不再带 ?room=）。
//
// 怎么知道「我这个节点是不是旧代码」：nginx 在每个响应上带 `X-SP-Accepts-New`，
// 1 = 接新玩家（新代码），0 = 不接（旧代码）。它来自 open-nodes.conf 的
// map $sp_node $sp_node_accepts_new，由 tools/sync-open-nodes.ps1 按 /api/ops/state 的 stale 生成。
//
// 这里只在**结算页**提示，不在对局中打扰：对局中刷新是有风险的操作（要重新连、可能丢观战视角），
// 而提示的意义只是「什么时候方便就刷新」，所以放在人已经闲下来的那一刻。
//
// Kept dependency-free and injectable so test/ui/nodeCodeHint.test.js can drive it.

import { useState, useEffect } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { t } from '../../../shared/i18n.js';

/** nginx 响应头名（小写，Headers 的取值方式）。 */
export const ACCEPTS_HEADER = 'x-sp-accepts-new';

/**
 * 从响应头判断本页所在的节点还接不接新玩家。
 * @param {{ headers?: { get: (n: string) => string|null } } | null} res
 * @returns {boolean|null} true 接新（新代码）/ false 不接（旧代码）/ null 判断不了
 *
 * ⚠ 拿不到就返回 null，**不能当成 false**：那会让所有玩家（包括新代码节点上的）都看到
 * 「刷新一下换新版本」的提示，而刷新对没有任何待更新的玩家只是白重载一次。
 */
export function nodeAcceptsNew(res) {
  try {
    const raw = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(ACCEPTS_HEADER) : null;
    if (raw == null) return null;
    const v = String(raw).trim();
    if (v === '1') return true;
    if (v === '0') return false;
    return null;
  } catch {
    return null;
  }
}

/**
 * 问一次服务器：本页所在节点还接不接新玩家。
 * 复用页面自己发出的任意一个请求即可（nginx 会给所有响应加这个头），
 * 这里打 `/healthz`：它很小、本来就被 buildGuard 周期性调用，不会造成额外负担，也不会被缓存。
 * @param {Function} fetchFn
 * @param {{ timeoutMs?: number, setTimeout?: Function, clearTimeout?: Function }} [o]
 * @returns {Promise<boolean|null>} 同 nodeAcceptsNew；失败一律 null
 */
export async function checkNodeAcceptsNew(fetchFn, o = {}) {
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : 5000;
  const setT = o.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = o.clearTimeout || ((h) => globalThis.clearTimeout(h));
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const tooSlow = new Promise((resolve) => {
    timer = setT(() => { try { ctrl?.abort(); } catch { /* ignore */ } resolve(null); }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchFn('/healthz', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }),
      tooSlow,
    ]);
    return nodeAcceptsNew(res);
  } catch {
    return null;
  } finally {
    if (timer != null) clearT(timer);
  }
}

/**
 * 结算页上的一行提示：本节点还在跑旧代码时，建议玩家刷新一次换到新节点。
 * 不在旧代码节点上就什么也不渲染（返回 null）。
 *
 * 只在结算页出现：这时对局已经结束，刷新不会打断任何人。
 */
export function NodeCodeHint() {
  const [staleNode, setStaleNode] = useState(false);
  useEffect(() => {
    // 只在浏览器里跑；测试环境没有 fetch 时静默跳过。
    let alive = true;
    const f = globalThis.fetch;
    if (typeof f !== 'function') return undefined;
    checkNodeAcceptsNew((u, o) => f(u, o)).then((accepts) => {
      if (alive && accepts === false) setStaleNode(true);
    }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, []);
  if (!staleNode) return null;
  return html`<p class="result__nodehint t-dim" data-testid="result-node-hint">
    ${t('这台服务器还在使用旧版本。本局已结束，刷新页面即可换到新版本（不会影响你的账号和对局记录）。')}
  </p>`;
}

