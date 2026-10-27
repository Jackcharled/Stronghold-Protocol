// Account takeover: after another device claims this account's seat, this tab becomes a read-only
// spectator of the same room instead of being logged out. The account cookie is untouched.
import { identity, net } from '../net.js';
import { store } from '../store.js';
import { toast } from './toasts.js';
import { t } from '../../../shared/i18n.js';

let installed = false;
let pendingRoom = null;
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

/** 等 socket 进入 online 的最长时间：页面刚打开时 hello 可能还没走完。 */
const RESUME_WAIT_ONLINE_MS = 6000;
/** 单次 account.resume 的等待上限（服务端处理 + 回包）。 */
const RESUME_TIMEOUT_MS = 8000;

/**
 * Ask the current node for this account's seat; resolves only after the takeover event was adopted.
 *
 * 这里修过三个会让「恢复对局」莫名其妙失败的问题：
 *
 * 1) **socket 还没 online 就发请求**。刚打开页面时 hello/welcome 可能还没完成，
 *    服务端这时收到的 account.resume 里 session.accountId 还是空的（或根本没建会话），
 *    于是回 'account login required' / 'guest cannot resume'。
 *    现在先等 net 进入 online（最多 RESUME_WAIT_ONLINE_MS），等不到才算失败。
 *
 * 2) **accountToken 还没送到服务端**。令牌由账号接口异步取回后随 hello 补发，
 *    比 socket 连上更晚。令牌没到时 resumeAccount 会把我们当游客拒绝。
 *    现在要求 window.__SP_ACCOUNT_TOKEN 已存在再发（同样有上限）。
 *
 * 3) **3.5 秒就放弃**。跨境/弱网下服务端回包经常超过 3.5 秒，
 *    以前会在回来的前一刻主动 reject，前端于是以为"对局没了"。
 *    现在放到 RESUME_TIMEOUT_MS，并且在超时后**重试一次**
 *    （服务端 resumeAccount 是幂等的：拿不到候选会话就拒绝，不会重复占用座位）。
 */
export function requestAccountResume() {
  if (resumePromise) return resumePromise;
  try { window.__SP_ACCOUNT_RESUME_PENDING = true; } catch { /* ignore */ }

  const waitFor = (pred, ms) => new Promise((resolve) => {
    if (pred()) { resolve(true); return; }
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(true); return; }
      if (Date.now() - t0 >= ms) { clearInterval(iv); resolve(false); }
    }, 100);
    // 同时监听状态变化，比轮询更早反应
    try {
      const off = net.on('status', () => { if (pred()) { clearInterval(iv); off(); resolve(true); } });
    } catch { /* ignore */ }
  });

  const attempt = () => new Promise((resolve, reject) => {
    let off = () => {};
    let timer = null;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      off();
      fn(value);
    };
    off = net.on('account.resume', (msg) => {
      if (adoptAccountSeat(msg)) done(resolve, msg);
      else done(reject, new Error('seat token missing'));
    });
    timer = setTimeout(() => done(reject, new Error('account resume timeout')), RESUME_TIMEOUT_MS);
    net.request('account.resume').catch((e) => done(reject, e));
  });

  resumePromise = (async () => {
    try {
      // 1+2：等 online 且令牌已就绪
      const ready = await waitFor(
        () => net.status === 'online' && !!window.__SP_ACCOUNT_TOKEN,
        RESUME_WAIT_ONLINE_MS,
      );
      if (!ready) {
        // 令牌或连线没到位：这不是"对局没了"，属于可重试的暂时状态
        const e = new Error('account resume not ready');
        e.code = 'NOT_READY';
        e.detail = { online: net.status === 'online', token: !!window.__SP_ACCOUNT_TOKEN };
        throw e;
      }
      try {
        return await attempt();
      } catch (e1) {
        // 超时/连接抖动才重试；服务端明确拒绝（无候选会话、游客）重试也没用
        const code = String((e1 && (e1.code || e1.message)) || '');
        const retriable = /timeout|DISCONNECTED|REPLACED/i.test(code);
        if (!retriable) throw e1;
        await new Promise((r) => setTimeout(r, 400));
        return await attempt();
      }
    } finally {
      try { window.__SP_ACCOUNT_RESUME_PENDING = false; } catch { /* ignore */ }
      resumePromise = null;
    }
  })();

  return resumePromise;
}

function autoResumeFromQuery() {
  // ★ 2026-10-27：**不再有任何"页面自己发起"的恢复 / 跳转**。
  // 玩家要求：「需要自己手动点恢复对局才跳转，包括换设备的情况」。
  //
  // 但有一条例外必须保留：玩家点了「恢复对局」按钮，而座位在**另一个节点**上时，
  // 按钮会把页面送到 /r/CODE?accountResume=1。落地后必须再发一次 account.resume
  // 才能把已开局的对局接回来（room.join 对已开局的房间只回 ROOM_STARTED）。
  //
  // 区分「玩家刚点的」和「以前那套自动跳的」靠**一次性标记**：
  //   * 跳转前 ui/resumeMatch.js 写入 sp.accountResume=1，
  //   * 这里读一次就立刻删掉 —— 所以之后刷新页面、换设备打开，都不会再自动恢复。
  // 不再信任 URL 上的 accountResume 参数（它可以被收藏、被分享、被回退带回来）。
  let wanted = false;
  try {
    wanted = sessionStorage.getItem('sp.accountResume') === '1';
    silentResume = false;
    sessionStorage.removeItem('sp.accountResume');
    sessionStorage.removeItem('sp.accountResumeSilent');
    sessionStorage.removeItem('sp.accountResumeHopAt');
  } catch { /* ignore */ }
  try {
    const params = new URLSearchParams(location.search);
    if (params.has('accountResume')) {
      params.delete('accountResume');
      const q = params.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    }
  } catch { /* ignore */ }
  return wanted;
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
  /** 「恢复对局失败」这条提示在本页面周期内只弹一次（tryAuto 有多处触发点，见下方去重注释）。 */
  let resumeFailShown = false;
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
      // NOT_READY = socket 还没 online 或 accountToken 还没送到。
      // 这不是"对局没了"，**绝不能**拿它去跳转 /r/CODE 或弹"对局已结束"——
      // 以前没有这个分支，页面刚打开时几乎必踩：请求在令牌到达前发出，被服务端当游客拒绝，
      // 前端随即判定恢复失败并给出误导性提示（玩家看到的"刷新后恢复对局失败"多半就是这么来的）。
      // 现在只是等一会儿再试，次数与 tryAuto 共用一个上限。
      if (e && e.code === 'NOT_READY') {
        if (autoWanted && autoAttempts < 4) setTimeout(tryAuto, 800);
        else { autoWanted = false; try { window.__SP_ACCOUNT_RESUME_PENDING = false; } catch { /* ignore */ } log('not-ready-gave-up'); }
        return;
      }
      // ★ 这里原来是「跳一次 /r/CODE 再去恢复」的自动跳转，已整段删除（2026-10-27）。
      //   玩家要求恢复对局必须自己点按钮，任何自动跳转都不要。
      //   现在失败就如实告诉玩家，由他决定要不要点大厅的「恢复对局」按钮。
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
    if (snap && snap.status === 'online') { log('status-online'); setTimeout(tryAuto, 500); }
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
  window.addEventListener('sp-account-token', () => { log('token-event'); rehandshakeForAccount(); setTimeout(tryAuto, 800); });
  // 角色变量可能比令牌事件更晚写（account-title.js 在 render() 里才赋值）。
  // 监听派发事件 + 首帧后再补两次，覆盖「令牌早到、角色晚到」和「令牌晚到」两种顺序。
  // 这三次都可能因签名相同而被跳过，只有真正拿到新身份才会握手。
  window.addEventListener('sp:account-changed', () => rehandshakeForAccount());
  setTimeout(() => rehandshakeForAccount(), 1000);
  setTimeout(() => rehandshakeForAccount(), 3000);
  // The status/welcome events can fire before this listener when the page is restored from bfcache;
  // a couple of delayed attempts make the target page deterministic.
  if (autoResume) { setTimeout(tryAuto, 1200); setTimeout(tryAuto, 3500); }
  // ★ 这里原来有一整套「刷新 / 打开页面就自动探测账号房间并跳过去」的逻辑
  //   （reloadNav / bootProbe / isHistoryNav / maybeAutoResumeOnReload 里的 location.assign）。
  //   2026-10-27 按玩家要求整段删除：**换设备、刷新、重新打开页面都不再自动跳转**。
  //   恢复对局只有一条路 —— 大厅「恢复对局」按钮（ui/resumeMatch.js），由玩家亲手点。
  //   副作用提醒：以前这套逻辑会在换设备打开页面时把原设备顶下线，删掉后不会再有。 
  net.on('account.detached', (msg) => {
    pendingRoom = typeof msg?.roomCode === 'string' ? msg.roomCode : pendingRoom;
    if (!pendingRoom) return;
    // ★ 这里以前会「重连 → 用 room.spectate 降级成旁观」，结果是必然失败：
    //   接管走的是同一个账号，房间里那个座位（现在是新设备的）accountId 还是自己，
    //   room.spectate 的 accountRoomConflict 会判成「该账号已在其他房间中」→ SESSION_IN_USE，
    //   前端只能报「观战席不可用」。玩家实测看到的就是
    //   「对局已转移到另一设备，当前设备改为只读观战」+「对局已转移，但观战席不可用」两条。
    //
    //   现在按「一台设备占用一个对局」的既定规则处理：这台设备已经让位，就回大厅，
    //   不再尝试旁观自己的座位 —— 想在这台继续玩，刷新页面走正常的恢复流程即可。
    pendingRoom = null;
    toast(t('对局已转移到另一设备，当前设备已断开局内连接。想在这台继续玩，请刷新页面。'), 'warn', { ttl: 8000 });
    try { store.set({ room: null, match: null }); } catch { /* ignore */ }
    try { store.patch('ui', { pendingJoin: null, restoring: false }); } catch { /* ignore */ }
    for (const id of ['mm-overlay', 'mm-back', 'mm-room-timer']) {
      try { document.getElementById(id)?.remove(); } catch { /* ignore */ }
    }
  });
  net.on('welcome', () => {
    // 旧的「被接管后重连 → room.spectate 降级旁观」分支已经整段删掉：
    // 那个旁观请求必然被 accountRoomConflict 拒成 SESSION_IN_USE（座位还是同一个账号的），
    // 玩家只会看到「对局已转移，但观战席不可用」。现在这台设备直接回大厅，
    // 想继续玩就刷新页面走正常的对局恢复。
    if (autoResume) {
      // The account-title script may still be fetching /auth/me; the status/token retries above
      // wait for the signed token and the next online/welcome cycle.
      tryAuto();
    }
  });
}
