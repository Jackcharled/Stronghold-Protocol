// Chrome shared by every in-match screen: the step header of the pre-game screens (exit + ping +
// difficulty | "1/2 确认本局信息" | countdown) and the exit flow (confirm with 暂离 / 放弃, AI 托管 overlay).
//
// 暂离 (co-op): turns on AI 托管 (g.autoplay on) so the seat keeps playing; the overlay's 返回模拟 turns it
// off. 放弃模拟: g.leave then room.leave (the platform treats it as a quit), back to the lobby.

import { useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal, PingPill, DifficultyTag, Countdown, MicroLabel } from './components.js';
import { actions } from './gameActions.js';
import { toastError } from './toasts.js';
import { net } from '../net.js';
import { store, useStore, shallowEqual, emptyMatch, createStore, isSpectating } from '../store.js';
import { GIcon } from './gameComponents.js';
import { GuideButton } from './guide.js';
import { recordQuit } from './stats.js';
import { t, tParts, N_ } from '../../../shared/i18n.js';
import { TestMark } from './testConsole.js';

/**
 * Exit dialog lines. 放弃模拟 (g.leave → room.leave) ends the run on the server as 'abandoned' and returns to the
 * lobby straight away — no settlement screen follows, so the solo text must not promise one.
 */
export const EXIT_TEXT = Object.freeze({
  soloRest: N_('独立模拟的休整期没有时间限制，你可以随时继续。'),
  soloQuit: N_('放弃模拟将立即结束本局并返回大厅，本局进度不会保留，也不会进行结算。'),
});

/** Local "暂离 / AI 托管" flag (the server keeps no per-client autoplay view). */
export const awayStore = createStore({ away: false });

/**
 * Whether a store change ends the match the 暂离 flag belongs to: its state was cleared (result → 返回同盟, 放弃模拟, a
 * new match starting, the room closing, a new server session) or its settlement arrived. The next match must never
 * open under the previous one's "AI 托管中" overlay (the server starts every match with autoplay off).
 * @param {any} s store state
 * @param {any} prev previous store state
 */
export const awayEnds = (s, prev) => (!!prev?.match?.public && !s?.match?.public) || (!!s?.match?.result && !prev?.match?.result);
store.subscribe((s, prev) => { if (awayStore.get().away && awayEnds(s, prev)) awayStore.set({ away: false }); });

/**
 * Leave the match for good (g.leave → room.leave), then drop local room/match state. The server sends a leaver no
 * settlement, so the page records the match itself before it is cleared (本机统计, ui/stats.js recordQuit: a 中途退出
 * entry of the history; it counts only when a round had been cleared) — once the leave went through.
 * @returns {Promise<void>}
 */
export async function quitMatch() {
  const before = store.get();
  const adminWatch = (() => {
    try {
      return /(?:^|[?&])adminWatch=1(?:&|$)/.test(location.search) || !!sessionStorage.getItem('sp_admin_watch_code');
    } catch { return false; }
  })();
  let left = false;
  try {
    try { await net.request('g.leave', {}); } catch (err) {
      if (err?.code !== 'NOT_IN_ROOM' && err?.code !== 'WRONG_PHASE' && err?.code !== 'OFFLINE') throw err;
    }
    try { await net.request('room.leave', {}); } catch (err) { if (err?.code !== 'NOT_IN_ROOM' && err?.code !== 'OFFLINE') throw err; }
    left = true;
    // 记录「刚刚主动离开对局」：账号观察者据此在一段时间内不把玩家自动送回对局，
    // 否则服务端房间尚未清理时，一退出就会被 /api/account/room 重新导航回去，页面反复刷新。
    try { sessionStorage.setItem('sp.matchExitAt', String(Date.now())); } catch { /* ignore */ }
    // sessionStorage 是每个标签页各自一份：换设备/新标签页打开时看不到上面这条，
    // 于是「退出对局后在新标签页里又被送回对局」。这里再写一份到 localStorage，
    // 账号观察者的自动恢复据此同样在 2 分钟内退让。
    try { localStorage.setItem('sp.matchExitAtShared', String(Date.now())); } catch { /* ignore */ }
    // 主动退出对局 = 不是要回这个房间。必须清掉 sp.lastRoom：
    // matchmaker/public/client.js 的 installAutoRejoin 每 1.5 秒检查一次，
    // 只要 store 里没有 room 就会用它自动 room.join 回旧房间 ——
    // 表现为「退出对局回到大厅后又自己刷新/跳回去一次」。
    // （以前这句只写在下面的 adminWatch 分支里，普通玩家从来不会被清。）
    try { localStorage.removeItem('sp.lastRoom'); } catch { /* ignore */ }
    try { sessionStorage.removeItem('sp.accountResume'); } catch { /* ignore */ }
    try { sessionStorage.removeItem('sp.accountResumeSilent'); } catch { /* ignore */ }
    if (adminWatch) {
      // A hidden watcher is not a room member: after leaving, do not let auto-rejoin/deep-link
      // try to room.join the started match on the way back to the lobby.
      // （sp.lastRoom 已在上面为所有玩家清除，这里不用再清一次。）
      try {
        localStorage.removeItem('sp_watch_token');
        localStorage.removeItem('sp_admin_watch_code');
        localStorage.removeItem('sp_admin_watch_node');
        localStorage.removeItem('sp_admin_watch_name');
        // Shared marker for tabs opened after the watch closes: suppress stale join/account
        // recovery toasts and pending joins for a short cooldown.
        localStorage.setItem('sp_admin_watch_closed_at', String(Date.now()));
      } catch { /* ignore */ }
      try {
        sessionStorage.removeItem('sp_admin_watch_code');
        sessionStorage.removeItem('sp_admin_watch_token');
        sessionStorage.removeItem('sp.accountResume');
        sessionStorage.removeItem('sp.accountResumeSilent');
        sessionStorage.removeItem('sp.accountResumeHopAt');
      } catch { /* ignore */ }
      try {
        for (const name of ['sp_admin_watch_code', 'sp_admin_watch_node', 'sp_admin_watch_name', 'sp_watch_token']) {
          document.cookie = name + '=; Path=/; Max-Age=0; SameSite=Lax';
        }
      } catch { /* ignore */ }
      try {
        const u = new URL(location.href);
        u.searchParams.delete('room');
        u.searchParams.delete('adminWatch');
        u.searchParams.delete('watchToken');
        u.searchParams.delete('accountResume');
        history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      } catch { /* ignore */ }
      store.patch('ui', { pendingJoin: null, pendingSpectate: false });
      // The game runs inside /mm/watch.html: closing the hidden-watch action closes that tab
      // instead of leaving its admin-watch title/favicon behind or returning to the admin console.
      try {
        if (window.top && window.top !== window) { window.top.close(); return; }
        window.close();
        return;
      } catch { /* ignore */ }
    }
    try { window.dispatchEvent(new Event('sp-room-left')); } catch { /* ignore */ }
  } catch (err) {
    toastError(err);
  } finally {
    // (a settlement that arrived while the leave was in flight is the match's record already)
    if (left && !store.get().match.result) {
      try { recordQuit(before); } catch (err) { console.warn('[stats] quit record failed', err); }
    }
    store.set({ room: null, match: emptyMatch() });
    // Leaving a room must not leave a "正在同步同盟状态…" or build-refresh banner behind.
    store.patch('ui', { restoring: false, buildStale: false });
  }
}

/**
 * Exit confirmation modal.
 * @param {{ open: boolean, onClose: Function, solo: boolean, onAway?: Function }} props
 */
export function ExitModal({ open, onClose, solo, onAway }) {
  const [busy, setBusy] = useState(null);
  // a spectator seat (community report #26) only leaves its seat: nothing of the match is given up
  // hidden admin watchers are not in room.spectators by design, but must use the same leave copy
  const adminWatch = (() => {
    try {
      return /(?:^|[?&])adminWatch=1(?:&|$)/.test(location.search) || !!sessionStorage.getItem('sp_admin_watch_code');
    } catch { return false; }
  })();
  const spectator = useStore((s) => isSpectating(s.room, s.me.playerId)) || adminWatch;
  const quit = async () => {
    setBusy('quit');
    await quitMatch();
    setBusy(null);
    onClose();
  };
  if (spectator) {
    return html`<${Modal} open=${open} onClose=${onClose} tone="red" title=${t('离开观战')} micro="LEAVE SPECTATING" width="6.8rem"
      actions=${html`<${Button} variant="secondary" onClick=${onClose}>${t('取消')}<//>
        <${Button} variant="danger" icon="exit" loading=${busy === 'quit'} onClick=${quit}>${t('离开观战')}<//>`}>
      <div class="exitm"><p>${t('离开观战席并返回大厅，本局模拟不受影响；观战席空着时可以凭同盟密钥再次观战。')}</p></div>
    <//>`;
  }
  const away = async () => {
    setBusy('away');
    const ok = await actions.autoplay(true);
    setBusy(null);
    onClose();
    if (ok) { awayStore.set({ away: true }); onAway?.(); }
  };
  return html`<${Modal} open=${open} onClose=${onClose} tone="red" title=${t('离开模拟')} micro="LEAVE SIMULATION" width="6.8rem"
    actions=${html`
      <${Button} variant="secondary" onClick=${onClose}>${t('取消')}<//>
      ${!solo ? html`<${Button} variant="ice" icon="robot" loading=${busy === 'away'} onClick=${away}>${t('暂离（AI 托管）')}<//>` : null}
      <${Button} variant="danger" icon="exit" loading=${busy === 'quit'} onClick=${quit}>${t('放弃模拟')}<//>`}>
    <div class="exitm">
      ${solo
        ? html`<p>${t(EXIT_TEXT.soloRest)}</p><p class="t-lo">${t(EXIT_TEXT.soloQuit)}</p>`
        : html`<p>${tParts('{away}：由 AI 托管你的席位（自动部署、准备与选择），随时可以返回。', { away: html`<b class="t-ice">${t('暂离')}</b>` })}</p>
               <p>${tParts('{quit}：离开后无法返回本局，你的干员将回到共享卡池。', { quit: html`<b class="t-red">${t('放弃模拟')}</b>` })}</p>`}
    </div>
  <//>`;
}

/** Full-screen "AI 托管中" overlay with 返回模拟. */
export function AwayOverlay({ onBack = () => {} }) {
  const [busy, setBusy] = useState(false);
  return html`<div class="awayov" role="dialog" aria-label=${t('AI 托管中')}>
    <div class="awayov__box brackets">
      <${GIcon} name="robot" class="awayov__icon" />
      <${MicroLabel} tone="mint">${t('AUTOPILOT // AI 托管')}</${MicroLabel}>
      <h2>${t('AI 托管中')}</h2>
      <p class="t-lo">${t('AI 正在代为操作你的席位')}</p>
      <${Button} variant="primary" size="lg" icon="play" loading=${busy} onClick=${async () => { setBusy(true); const ok = await actions.autoplay(false); setBusy(false); if (ok) { awayStore.set({ away: false }); onBack(); } }}>${t('返回模拟')}<//>
    </div>
  </div>`;
}

/**
 * Pre-game step header.
 * @param {{ step: number, of: number, title: string, micro: string, pub: any, total?: number|null, onExit: Function, extra?: any }} props
 */
export function StepHeader({ step, of, title, micro, pub, total, onExit, extra = null }) {
  const conn = useStore((s) => s.connection, shallowEqual);
  return html`<header class="stephead">
    <div class="stephead__left">
      <${Button} variant="danger" size="lg" square=${true} icon="exit" onClick=${onExit} aria-label=${t('离开')} title=${t('离开')} />
      <div class="stephead__meta">
        <${PingPill} ms=${conn.ping} online=${conn.status === 'online'} />
        ${pub?.difficulty ? html`<${DifficultyTag} difficulty=${pub.difficulty} />` : null}
        ${pub?.test ? html`<${TestMark} />` : null}
      </div>
    </div>
    <div class="stephead__center">
      <${MicroLabel} tone="mint">${micro}</${MicroLabel}>
      <h1 class="stephead__title"><b class="num">${step}</b><span class="num stephead__of">/${of}</span>${title}</h1>
    </div>
    <div class="stephead__right">
      ${extra}
      <${GuideButton} class="stephead__guide" variant="secondary" />
      <${Countdown} deadline=${pub?.deadline} total=${total ?? undefined} size="md" />
    </div>
  </header>`;
}

