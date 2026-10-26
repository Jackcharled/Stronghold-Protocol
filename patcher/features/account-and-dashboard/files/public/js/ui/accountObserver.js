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
        // 只有「确实能拿到房间码、且当前页不是那个房间」才值得跳一次。
        // 如果已经在 /r/CODE 上还失败，说明问题不在节点路由（多半是这个节点重启过，
        // 内存里的会话没了 —— registry.byAccount 只查本节点），再跳只会原地打转。
        if (code && !location.pathname.endsWith('/r/' + code)) {
          let lastHop = 0;
          try { lastHop = Number(sessionStorage.getItem(RESUME_HOP_KEY) || 0); } catch { /* ignore */ }
          if (Date.now() - lastHop < 15000) {
            autoWanted = false;
            try { window.__SP_ACCOUNT_RESUME_PENDING = false; } catch { /* ignore */ }
            // 二次失败有两种完全相反的成因，不能用同一句话概括：
            //   (a) 房间还在、对局还在跑 —— 刚跳过来的这一跳本身是有效的，只是这个节点内存里
            //       还没有本账号的会话（registry.byAccount 只查本节点）。此时 matchmaker 的
            //       joinFlow 正拿 ROOM_STARTED 走「正在把你送回对局」那条路，服务端 lobby 的
            //       hello → resync → match.onReconnect 会把人拉回去。再弹「对局已结束」就是自相矛盾。
            //   (b) 房间确实没了 —— 那种情况 joinFlow 给的是 ROOM_NOT_FOUND，不是 ROOM_STARTED。
            const started = /ROOM_STARTED|模拟已开始|已开始|Simulation already started/i
              .test(String((e && (e.code || e.message)) || ''));
            if (started) {
              // 交给 joinFlow 的唯一一条提示，这里不出声。
              log('started-handoff');
              return;
            }
            // 「请关闭其他设备」这句话会误导：绝大多数失败并不是因为别的设备占着座位，
            // 而是这个节点重启过 / 对局已结束 / 会话过期。据实说明，并提示接下来怎么办。
            toast(t('恢复对局失败：本局所在节点可能刚重启过，或对局已结束。可回到大厅重新开始'), 'warn', { ttl: 8000 });
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
        // A local refresh is silent: never tell the player something is wrong for their own reload.
        if (!silentResume) toast(t('当前节点没有可恢复的账号对局'), 'warn');
      }
    });
  };
  net.on('status', (snap) => {
    if (snap && snap.status === 'online') { log('status-online'); setTimeout(tryAuto, 500); maybeAutoResumeOnReload(); }
  });
  // 账号令牌（含管理员/服主角色）通常晚于 WebSocket 就绪到达。首帧 hello 里
  // 没有令牌时，服务端的 session.admin 会一直是 false：管理员建房就不再有
  // 「不自动销毁」，维护开关也会把管理员一起拦住。所以令牌一到就重新握手，
  // 把身份补给服务端（服务端接受同一连接上的重复 hello 并重新同步）。
  // 重要：只在「身份材料真的变了」时重发 hello。
  // account-title.js 的 render() 会反复派发 sp:account-changed，而每次 hello 都会让服务端回一个
  // welcome，welcome 又会触发所有设置（调配/持有/自选/名片/皮肤）重发一遍 —— 结果是界面没改任何东西
  // 也在持续上传。这里用签名去重：令牌 + 角色都没变化就跳过。
  let lastHandshakeSig = null;
  const rehandshakeForAccount = (force = false) => {
    let tok = '';
    let role = '';
    try {
      tok = typeof window.__SP_ACCOUNT_TOKEN === 'string' ? window.__SP_ACCOUNT_TOKEN : '';
      role = window.__SP_ACCOUNT_ROLE || '';
      const adm = typeof window.__SP_ADMIN_TOKEN === 'string' ? window.__SP_ADMIN_TOKEN : '';
      const sig = `${role}|${tok ? tok.length + ':' + tok.slice(-16) : ''}|${adm ? adm.length : 0}`;
      if (!force && sig === lastHandshakeSig) return;   // 身份没变：不重发
      lastHandshakeSig = sig;
    } catch { /* 隐私模式：照常发一次 */ }
    try {
      // 先确保 net 有名字：rehandshake() 在 net.name 为空时直接返回 false，
      // 而账号名往往比页面启动晚到（client.js 启动时可能还取不到名字）。
      // 这里补一层，避免「有账号令牌却因为没有名字而永远握不上手」。
      if (!net.name) {
        const nm = (window.__SP_ACCOUNT_USER || '').trim();
        if (nm) net.setName(nm);
      }
      const sent = net.rehandshake();
      log('rehandshake', { sent, role: role || null });
    } catch { /* ignore */ }
  };
  window.addEventListener('sp-account-token', () => { log('token-event'); rehandshakeForAccount(); setTimeout(tryAuto, 800); maybeAutoResumeOnReload(); });
  // 角色变量可能比令牌事件更晚写（account-title.js 在 render() 里才赋值）。
  // 监听派发事件 + 首帧后再补两次，覆盖「令牌早到、角色晚到」和「令牌晚到」两种顺序。
  // 这三次都可能因签名相同而被跳过，只有真正拿到新身份才会握手。
  window.addEventListener('sp:account-changed', () => rehandshakeForAccount());
  setTimeout(() => rehandshakeForAccount(), 1000);
  setTimeout(() => rehandshakeForAccount(), 3000);
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
  // 换网络 / 换设备打开页面时，浏览器这次导航并不是 reload（是普通导航），
  // 之前这里用 `!reloadNav` 直接 return，导致「切网络后没有回到对局」。
  // 现在：刷新、普通打开（输网址/点书签/换设备）都要探测一次账号所在的对局；
  // 只有「浏览器前进/后退」不探测，免得从对局退出来按后退又被弹回去。
  // 防循环仍靠下面的三道闸 + accountRoomCode 只认 started===true 的房间。
  const isHistoryNav = (() => {
    try {
      const nav = performance.getEntriesByType?.('navigation')?.[0];
      if (nav) return nav.type === 'back_forward';
      return performance.navigation?.type === 2;
    } catch { return false; }
  })();
  async function maybeAutoResumeOnReload() {
    if (autoResume || bootProbe || isHistoryNav || !window.__SP_ACCOUNT_TOKEN) return;
    if (watchExitRecent()) { clearResumeFlags(); return; }
    try { if (new URLSearchParams(location.search).get('adminWatch') === '1') return; } catch { /* ignore */ }
    bootProbe = true;
    // 防循环：这个函数会把人送回对局。如果玩家是从对局里主动退出、
    // 而账号查询仍然命中那个未清理的房间，就会「退出 → 刷新 → 又被送回 → 再退出」无限循环。
    // 因此加三道闸：
    //   1) 短时间内已经跳转过一次，就不再跳（沿用 tryAuto 的 sp.accountResumeHopAt 时间戳）；
    //   2) 玩家刚主动离开对局（sp.matchExitAt），一段时间内一律不自动恢复；
    //   3) 玩家刚在对局里点过「离开」，sp.matchExitAt 在 sessionStorage 里跨标签页不同步，
    //      所以再用 localStorage 里的一份做兜底（见 markMatchExit 的写入端）。
    try {
      const lastHop = Number(sessionStorage.getItem(RESUME_HOP_KEY) || 0);
      if (lastHop && Date.now() - lastHop < 60000) return;      // 60 秒内只跳一次
    } catch { /* ignore */ }
    try {
      const exitAt = Number(sessionStorage.getItem('sp.matchExitAt') || 0);
      if (exitAt && Date.now() - exitAt < 120000) return;        // 主动退出后 2 分钟内不自动回房
      const exitAtShared = Number(localStorage.getItem('sp.matchExitAtShared') || 0);
      if (exitAtShared && Date.now() - exitAtShared < 120000) return;
    } catch { /* ignore */ }
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
    try { sessionStorage.setItem(RESUME_HOP_KEY, String(Date.now())); } catch { /* ignore */ }
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
