// Explicit title-screen predownload. Reuse the game's HTTP cache and exact manifest URLs;
// never decode every model/image/audio file into RAM or persist an unverified "complete" flag.
// A URL already stored by a local import (assetPack.js) is marked done and not requested again.
import { mediaUrl } from './media.js';
import { listImportedPaths } from './assetCache.js';

/**
 * Collect only same-origin art files, including all Spine pages and optional local scenes.
 * The served 0.3.0 views are walked as they are: hashed `/assets/~…` and `/fonts/~…` URLs, the extra dub banks
 * (`voiceEn` / `voiceKr` / `voiceNative`), statistics-page art, and local groups such as the 射击台 mesh. A cosmetic
 * plugin's own files are `/p/<id>/<hash8>/…` and are not in these manifests, so they are not queued here. The official
 * battle effects (DESIGN §33) come in their own manifest, /data/local-fx.json, read the same way when the host has them.
 */
export function collectAssetUrls(...manifests) {
  const urls = new Set();
  const remote = /^https?:\/\/assets\.luobomiao\.love\/assets\//i;
  const gameUrl = (value) => remote.test(value) ? '/assets-cdn/' + value.replace(remote, '') : value;
  const visit = (value) => {
    if (typeof value === 'string') {
      let path = value;
      if (/^https?:\/\//i.test(path)) {
        try { path = new URL(path).pathname; } catch { return; }
      }
      if (/^\/(?:assets|fonts)\/[^/]/.test(path) && !/[?#\\]/.test(value)) urls.add(mediaUrl(gameUrl(value)));
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child);
    }
  };
  manifests.forEach(visit);
  // Fetch models/images before audio, so an interrupted download still improves battle visuals.
  return [...urls].sort((a, b) => Number(a.startsWith('/media/')) - Number(b.startsWith('/media/')) || a.localeCompare(b));
}

/**
 * localStorage 的安全包装：隐私模式 / 存储被禁用时读写都会抛异常，
 * 这时退化成一次性内存存储，下载功能照常可用，只是刷新后不再记得。
 */
function safeLocalStorage() {
  const memory = new Map();
  try {
    const probe = '__sp_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return {
      get: (k) => globalThis.localStorage.getItem(k),
      set: (k, v) => globalThis.localStorage.setItem(k, v),
      remove: (k) => globalThis.localStorage.removeItem(k),
    };
  } catch {
    return {
      get: (k) => (memory.has(k) ? memory.get(k) : null),
      set: (k, v) => { memory.set(k, v); },
      remove: (k) => { memory.delete(k); },
    };
  }
}

/** A bounded, pausable download queue. A file counts only after its entire body arrives. */
export function createAssetDownload({ fetch: doFetch = (...args) => globalThis.fetch(...args),
  concurrency = 4, timeoutMs = 60000, retries = 2, lookupImported = listImportedPaths,
  store = safeLocalStorage() } = {}) {
  let state = { phase: 'idle', total: 0, done: 0, bytes: 0, failures: [], localMissing: false, cached: 0 };
  let urls = null, running = null, controller = null, paused = false, lastNotice = 0;
  const complete = new Set(), failures = new Map(), listeners = new Set();

  // ---- 已完成状态持久化 ----------------------------------------------------------------
  // 以前只有内存里一个 phase:'complete'：玩家一刷新页面就忘了，再点「下载完整素材」
  // 会把全部素材重新请求一遍（实测一次 10742 个请求、三分钟打满上传带宽，
  // 玩家在对局里 ping 飙高、R5 掉线）。这里把「已经完成」和「已完成到哪个清单版本」
  // 记在 localStorage，刷新后认得出来。
  // 只记清单指纹，不记「每个文件都在」——浏览器清掉 HTTP 缓存后文件其实没了，
  // 所以命中记录时仍要用 HEAD + cache:'only-if-cached' 逐个确认，
  // 缓存被清理的文件会重新排队下载（玩家的正常诉求必须保留）。
  const KEY = 'sp.assetDownload.done';
  const readDone = () => {
    try {
      const raw = store.get(KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data.fingerprint !== 'string' || !Number.isFinite(data.count)) return null;
      return data;
    } catch { return null; }
  };
  const writeDone = (fingerprint, count) => {
    try { store.set(KEY, JSON.stringify({ fingerprint, count, at: Date.now() })); } catch { /* 隐私模式：不持久化也能用 */ }
  };
  const clearDone = () => { try { store.remove(KEY); } catch { /* ignore */ } };

  /** 清单指纹：文件数 + 首尾若干 URL。清单变了（服主上新素材）就不再算「已完成」。 */
  const fingerprintOf = (list) => {
    const pick = (i) => list[i] || '';
    return `${list.length}|${pick(0)}|${pick(list.length - 1)}|${pick(Math.floor(list.length / 2))}`;
  };

  /**
   * 这个 URL 是否真的还在浏览器的 HTTP 缓存里。
   * cache:'only-if-cached' 不会发网络请求，命中缓存才有响应；没命中会 reject。
   * 因此「玩家清理了缓存」会自然变成 false → 重新下载。
   */
  async function stillCached(url) {
    try {
      const response = await doFetch(url, { cache: 'only-if-cached', mode: 'same-origin' });
      if (!response) return false;
      await response.body?.cancel?.();
      return response.ok;
    } catch { return false; }
  }

  const emit = (force = false) => {
    if (!force && Date.now() - lastNotice < 100) return;
    lastNotice = Date.now();
    state = { ...state, done: complete.size, failures: [...failures.values()] };
    for (const listener of listeners) listener(state);
  };

  async function request(url, json = false, optional = false) {
    let forceNoCache = false;
    for (let attempt = 0; ; attempt++) {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
      const timer = setTimeout(cancel, timeoutMs);
      // 第一次用默认缓存策略（快）；一旦失败就用 no-cache 绕过浏览器缓存再试。
      // 原因：素材带 Cache-Control: immutable + 30 天，服务器曾经返回过的 404 会被浏览器
      // 长期记住且不再回源。服主修好之后，玩家重试仍然拿到那个旧 404
      // （就是「服务器 200、玩家还是 404」的根因）。强制回源才能拿到最新结果。
      const cacheMode = json ? 'no-cache' : (forceNoCache ? 'no-cache' : 'default');
      try {
        const response = await doFetch(url, { signal: abort.signal, cache: cacheMode });
        if (optional && response.status === 404) { await response.body?.cancel(); return null; }
        if (!response.ok || response.status === 206) {
          await response.body?.cancel();
          // 可能是缓存的旧 404：下一轮强制回源
          if (response.status === 404 || response.status === 410) forceNoCache = true;
          throw Object.assign(new Error('Asset request failed'), { status: response.status });
        }
        // Static hosts sometimes send their HTML fallback with status 200 for missing art.
        if (/text\/html/i.test(response.headers.get('content-type') || '')) {
          await response.body?.cancel();
          throw Object.assign(new Error('Unexpected HTML response'), { status: 'html' });
        }
        if (json) return await response.json();
        let size = 0;
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              state = { ...state, bytes: state.bytes + value.byteLength };
              emit();
            }
          } finally { reader.releaseLock(); }
        } else {
          size = (await response.arrayBuffer()).byteLength;
          state = { ...state, bytes: state.bytes + size };
        }
        if (!size) throw Object.assign(new Error('Empty asset response'), { status: 'empty' });
        return;
      } catch (error) {
        if (paused) throw error;
        // 404/410 以前算「永久失败」直接放弃。但服务器的 404 也可能是浏览器缓存里的旧结论
        // （素材带 immutable + 30 天，服务器修好后浏览器也不会回源），所以 404 也要重试一次 ——
        // 上面已经把下一轮的 cache 改成 no-cache，重试就是真正回源确认。
        const transient = !error.status || error.status >= 500 || [408, 429, 404, 410].includes(error.status);
        if (!transient || attempt >= retries) throw Object.assign(error, { url });
        // Keep retries bounded and avoid hammering a struggling server.
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        if (paused) throw error;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', cancel);
      }
    }
  }

  async function run() {
    try {
      if (!urls) {
        state = { ...state, phase: 'preparing', error: null };
        emit(true);
        // Sequential manifest reads keep cancellation simple and never leave a rejected sibling promise.
        const assets = await request('/data/assets.json', true);
        const local = await request('/data/local-assets.json', true, true);
        // the official battle effects' files (DESIGN §33): optional, like the local manifest
        const fx = await request('/data/local-fx.json', true, true);
        if (!assets || typeof assets !== 'object' || Array.isArray(assets)
          || (local !== null && (!local || typeof local !== 'object' || !local.groups))
          || (fx !== null && (!fx || typeof fx !== 'object' || !fx.groups))) throw new Error('Invalid asset manifest');
        const list = collectAssetUrls(assets, local, fx);
        if (!list.length) throw new Error('Empty asset manifest');
        urls = list;
        state = { ...state, total: urls.length, localMissing: local === null };
      }
      if (paused) return;

      // 上次已经把这一版清单下完（记录在 localStorage）：这次不再是「全量重验」。
      // 但要确认文件真的还在缓存里 —— 玩家清理过缓存就必须重新下载。
      // 用 cache:'only-if-cached' 逐个确认，不产生网络请求，清理过的会自动落回下面的正常队列。
      const saved = readDone();
      const fp = fingerprintOf(urls);
      if (saved && saved.fingerprint === fp) {
        state = { ...state, phase: 'verifying' };
        emit(true);
        let verifyNext = 0;
        let still = 0;
        const verify = async () => {
          for (;;) {
            if (paused) return;
            const url = urls[verifyNext++];
            if (url === undefined) return;
            if (await stillCached(url)) { complete.add(url); still++; } else complete.delete(url);
            emit();
          }
        };
        await Promise.all(Array.from({ length: 8 }, verify));
        if (paused) return;
        state = { ...state, cached: still };
        if (complete.size >= urls.length) {
          // 全都还在缓存里：直接算完成，不发任何素材请求
          state = { ...state, phase: 'complete' };
          writeDone(fp, urls.length);
          return;
        }
        // 有文件被清掉了（或清单变了）：只补这些，已确认在缓存里的不重复下载
      }

      let imported = null;
      try { imported = await lookupImported(); } catch { imported = null; }
      if (paused) return;
      let cached = 0;
      if (imported && typeof imported.has === 'function') {
        for (const url of urls) {
          let path = url;
          try { path = new URL(url, 'http://localhost').pathname; } catch { /* keep the queue string */ }
          if (imported.has(url) || imported.has(path)) {
            cached++;
            complete.add(url);
          }
        }
      }
      state = { ...state, cached };
      if (paused) return;
      state = { ...state, phase: 'downloading' };
      failures.clear();
      emit(true);
      const queue = urls.filter((url) => !complete.has(url));
      let next = 0;
      const worker = async () => {
        while (!paused && next < queue.length) {
          const url = queue[next++];
          try {
            await request(url);
            complete.add(url);
          } catch (error) {
            if (!paused) failures.set(url, { url, status: error.status || 'network' });
          }
          emit();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, worker));
      if (!paused) {
        state = { ...state, phase: failures.size ? 'partial' : 'complete' };
        // 下完了就记住这一版清单，下次不再全量重跑
        if (!failures.size) writeDone(fp, urls.length);
        else clearDone();   // 有失败就不算完成，下次仍然要跑
      }
    } catch (error) {
      if (!paused) state = { ...state, phase: 'error', error: { url: error.url, status: error.status || 'manifest' } };
    } finally {
      if (paused) state = { ...state, phase: 'paused' };
      emit(true);
    }
  }

  return {
    get: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start() {
      if (running) return running;
      paused = false;
      controller = new AbortController();
      // 以前这里只要 phase 是 complete 就 urls = null、complete.clear()，
      // 把「已完成」整个抹掉重新走一遍 —— 玩家点一次就重新请求全部素材（实测 10742 个请求）。
      // 现在：不清空计数，只让 run() 用「已完成记录 + 缓存逐个确认」的方式判断
      // 哪些真的还在缓存里；清理过缓存的文件会被重新排队，功能不受影响。
      running = run().finally(() => { running = null; });
      return running;
    },
    /** 清掉「已完成」记录（设置页/调试用），下次 start 会完整重下。 */
    forget() { clearDone(); urls = null; complete.clear(); failures.clear(); },
    pause() { if (running) { paused = true; controller.abort(); } },
  };
}

export const assetDownload = createAssetDownload();
