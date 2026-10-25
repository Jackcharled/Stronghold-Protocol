// Account takeover: after another device claims this account's seat, this tab becomes a read-only
// spectator of the same room instead of being logged out. The account cookie is untouched.
import { identity, net } from '../net.js';
import { store } from '../store.js';
import { toast } from './toasts.js';
import { t } from '../../../shared/i18n.js';

let installed = false;
let pendingRoom = null;
let switching = false;
let resumePromise = null;
let autoRedirected = false;
let silentResume = false;
const RESUME_HOP_KEY = 'sp.accountResumeHopAt';

function watchExitRecent(ms = 60_000) {
  try {
    const at = Number(localStorage.getItem('sp_admin_watch_closed_at') || 0);
    return at > 0 && Date.now() - at < ms;
  } catch { return false; }
}

function clearResumeFlags() {
  try {
    sessionStorage.removeItem('sp.accountResume');
    sessionStorage.removeItem('sp.accountResumeSilent');
    sessionStorage.removeItem(RESUME_HOP_KEY);
  } catch { /* ignore */ }
  try { window.__SP_ACCOUNT_RESUME_PENDING = false; } catch { /* ignore */ }
}

async function accountRoomCode() {
  try {
    const r = await fetch('/mm/api/account/room', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j?.room?.code === 'string' ? j.room.code : null;
  } catch { return null; }
}

function adoptAccountSeat(msg) {
  if (!msg || typeof msg.token !== 'string' || !identity.adopt(msg.token)) return false;
  identity.setEntered(true);
  store.patch('session', { entered: true });
  net.close();
  net.setName(msg.name || net.name);
  net.connect();
  return true;
}

/** Ask the current node for this account's seat; resolves only after the takeover event was adopted. */
export function requestAccountResume() {
  if (resumePromise) return resumePromise;
  try { window.__SP_ACCOUNT_RESUME_PENDING = true; } catch { /* ignore */ }
  resumePromise = new Promise((resolve, reject) => {
    let off = () => {};
    let timer = null;
    const done = (fn, value) => {
      if (timer) clearTimeout(timer);
      off();
      try { window.__SP_ACCOUNT_RESUME_PENDING = false; } catch { /* ignore */ }
      resumePromise = null;
      fn(value);
    };
    off = net.on('account.resume', (msg) => {
      if (adoptAccountSeat(msg)) done(resolve, msg);
      else done(reject, new Error('seat token missing'));
    });
    timer = setTimeout(() => done(reject, new Error('account resume timeout')), 3500);
    net.request('account.resume').catch((e) => done(reject, e));
  });
  return resumePromise;
}

function autoResumeFromQuery() {
  let params;
  try { params = new URLSearchParams(location.search); } catch { params = null; }
  let wanted = false;
  try {
    wanted = params?.get('accountResume') === '1' || sessionStorage.getItem('sp.accountResume') === '1';
    silentResume = sessionStorage.getItem('sp.accountResumeSilent') === '1';
    sessionStorage.removeItem('sp.accountResume');
    sessionStorage.removeItem('sp.accountResumeSilent');
  } catch { /* ignore */ }
  if (!wanted) return false;
  if (params) {
    params.delete('accountResume');
    try {
      const q = params.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    } catch { /* ignore */ }
  }
  return true;
}

export function installAccountObserver() {
  if (installed) return;
  // The hidden admin watch is a guest observer: do not auto-resume a player account or
  // show account-recovery toasts in that page.
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('adminWatch') === '1' || qs.get('watchGuest') === '1' || !!qs.get('watchToken')
      || !!sessionStorage.getItem('sp_admin_watch_code') || !!localStorage.getItem('sp_admin_watch_code')
      || watchExitRecent()) {
      clearResumeFlags();
      installed = true;
      return;
    }
  } catch { /* ignore */ }
  installed = true;
  const log = (event, extra = {}) => {
    try { (window.__SP_AUTO_LOG ||= []).push({ event, at: Date.now(), ...extra }); } catch { /* ignore */ }
  };
  const autoResume = autoResumeFromQuery();
  log('install', { autoResume, token: !!window.__SP_ACCOUNT_TOKEN, status: net.status });
  let autoWanted = autoResume;
  let autoAttempts = 0;
  if (autoResume) {
    // A fresh device can be sitting on the title screen: net is only connected, not online, until
    // the player enters. Enter the lobby with the account name so account.resume can be sent.
    try {
      identity.setEntered(true);
      store.patch('session', { entered: true });
      if (!net.name && window.__SP_ACCOUNT_USER) net.setName(window.__SP_ACCOUNT_USER);
    } catch { /* ignore */ }
  }
  // Block the /r/CODE pending-join from creating a second seat before account.resume runs.
  if (autoResume) { try { window.__SP_ACCOUNT_RESUME_PENDING = true; } catch { /* ignore */ } }
  const tryAuto = () => {
    if (!autoWanted) return;
    if (watchExitRecent()) { autoWanted = false; clearResumeFlags(); log('watch-exit-cooldown'); return; }
    if (!window.__SP_ACCOUNT_TOKEN) { log('no-token'); return; }
    if (autoAttempts >= 4) { autoWanted = false; log('gave-up'); return; }
    if (net.status !== 'online' && window.__SP_ACCOUNT_USER) {
      // The title screen has not entered the lobby yet on a target page restored from the account path.
      try {
        identity.setEntered(true);
        store.patch('session', { entered: true });
        if (!net.name) net.setName(window.__SP_ACCOUNT_USER);
      } catch { /* ignore */ }
    }
    autoAttempts++;
    log('request', { attempt: autoAttempts, status: net.status });
    requestAccountResume().then(() => { autoWanted = false; silentResume = false; log('success'); try { sessionStorage.removeItem(RESUME_HOP_KEY); } catch { /* ignore */ } }).catch(async (e) => {
      log('failed', { attempt: autoAttempts, code: e?.code || String(e?.message || e) });
      // If this page started on a random node, follow the account's room to the node that owns it.
      // One hop only: a room that keeps refusing the takeover must not reload between /r/CODE and
      // /?room=CODE forever (the old tab/device can still be reclaiming the seat).
      if (!autoRedirected && !silentResume) {
        const code = await accountRoomCode();
        if (code && !location.pathname.endsWith('/r/' + code)) {
          let lastHop = 0;
          try { lastHop = Number(sessionStorage.getItem(RESUME_HOP_KEY) || 0); } catch { /* ignore */ }
          if (Date.now() - lastHop < 15000) {
            autoWanted = false;
            try { window.__SP_ACCOUNT_RESUME_PENDING = false; } catch { /* ignore */ }
            toast(t('恢复对局失败：请关闭其他设备/标签页中的同一账号后重试'), 'warn', { ttl: 6000 });
            return;
          }
          autoRedirected = true;
          try { sessionStorage.setItem(RESUME_HOP_KEY, String(Date.now())); } catch { /* ignore */ }
          try { sessionStorage.setItem('sp.accountResume', '1'); } catch { /* ignore */ }
          location.assign('/r/' + encodeURIComponent(code) + '?accountResume=1');
          return;
        }
      }
      // The first request can race the signed-token reconnect (the session was still a guest).
      // Retry a few times; the target node may also be restoring the room.
      if (autoWanted && autoAttempts < 4) setTimeout(tryAuto, 700);
      else {
        autoWanted = false;
        try { window.__SP_ACCOUNT_RESUME_PENDING = false; } catch { /* ignore */ }
        // A local refresh is silent: never tell the player to close their other device for their own reload.
        if (!silentResume) toast(t('当前节点没有可恢复的账号对局'), 'warn');
      }
    });
  };
  net.on('status', (snap) => {
    if (snap && snap.status === 'online') { log('status-online'); setTimeout(tryAuto, 500); maybeAutoResumeOnReload(); }
  });
  window.addEventListener('sp-account-token', () => { log('token-event'); setTimeout(tryAuto, 800); maybeAutoResumeOnReload(); });
  // The status/welcome events can fire before this listener when the page is restored from bfcache;
  // a couple of delayed attempts make the target page deterministic.
  if (autoResume) { setTimeout(tryAuto, 1200); setTimeout(tryAuto, 3500); }
  // A normal refresh of a page that was inside a room used to land on the title: the URL often has
  // no accountResume flag. On reload only, probe the signed account's active seat and follow it
  // back through /r/CODE (the short link pins the room node).
  const reloadNav = (() => {
    try {
      const nav = performance.getEntriesByType?.('navigation')?.[0];
      if (nav) return nav.type === 'reload';
      return performance.navigation?.type === 1;
    } catch { return false; }
  })();
  let bootProbe = false;
  async function maybeAutoResumeOnReload() {
    if (autoResume || bootProbe || !reloadNav || !window.__SP_ACCOUNT_TOKEN) return;
    if (watchExitRecent()) { clearResumeFlags(); return; }
    try { if (new URLSearchParams(location.search).get('adminWatch') === '1') return; } catch { /* ignore */ }
    bootProbe = true;
    const code = await accountRoomCode();
    if (!code) return;
    let current = '';
    try { current = String(new URLSearchParams(location.search).get('room') || '').toUpperCase(); } catch { /* ignore */ }
    if (current && current !== code) return;
    if (location.pathname.endsWith('/r/' + code)) {
      autoWanted = true;
      try {
        identity.setEntered(true);
        store.patch('session', { entered: true });
        if (!net.name && window.__SP_ACCOUNT_USER) net.setName(window.__SP_ACCOUNT_USER);
      } catch { /* ignore */ }
      tryAuto();
      return;
    }
    try { sessionStorage.setItem('sp.accountResume', '1'); } catch { /* ignore */ }
    try { sessionStorage.setItem('sp.accountResumeSilent', '1'); } catch { /* ignore */ }
    location.assign('/r/' + encodeURIComponent(code) + '?accountResume=1');
  }
  if (reloadNav && !autoResume) { setTimeout(maybeAutoResumeOnReload, 1200); setTimeout(maybeAutoResumeOnReload, 3500); }
  net.on('account.detached', (msg) => {
    pendingRoom = typeof msg?.roomCode === 'string' ? msg.roomCode : pendingRoom;
    if (!pendingRoom) return;
    toast(t('对局已转移到另一设备，当前设备改为只读观战'), 'warn', { ttl: 6000 });
    switching = true;
    // The old socket is about to be replaced; open a fresh session and join as a spectator.
    setTimeout(() => {
      try { net.close(); net.connect(); } catch { /* next status event reports it */ }
    }, 200);
  });
  net.on('welcome', () => {
    if (switching && pendingRoom) {
      const code = pendingRoom;
      pendingRoom = null;
      switching = false;
      net.request('room.spectate', { code }).catch(() => {
        toast(t('对局已转移，但观战席不可用'), 'warn');
      });
      return;
    }
    if (autoResume) {
      // The account-title script may still be fetching /auth/me; the status/token retries above
      // wait for the signed token and the next online/welcome cycle.
      tryAuto();
    }
  });
}
