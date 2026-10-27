// Recover an explicitly selected local seat; nickname and IP never identify a player.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, Icon, Modal } from './components.js';
import { identity, net } from '../net.js';
import { store } from '../store.js';
import { requestAccountResume } from './accountObserver.js';
import { t } from '../../../shared/i18n.js';
import { toast } from './toasts.js';

async function findAccountRoom() {
  let name = window.__SP_ACCOUNT_USER || '';
  if (!name) {
    try {
      const me = await fetch('/mm/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (me.ok) {
        const j = await me.json();
        name = String(j?.user?.name || j?.user?.nickname || '');
      }
    } catch { /* ignore */ }
  }
  if (!name) return null;
  try {
    const r = await fetch('/mm/api/account/room', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.room?.code || null;
  } catch { /* ignore */ }
  return null;
}

export function ResumeMatchButton() {
  const [items, setItems] = useState(() => identity.recoverable());
  const [account, setAccount] = useState(() => !!window.__SP_ACCOUNT_USER);
  const [accountRoom, setAccountRoom] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 对局在别的节点上：恢复失败后不再自动跳转，改为在这里提示，由玩家再点一次才跳。
  const [elsewhere, setElsewhere] = useState(null);
  const [restartPending, setRestartPending] = useState(() => {
    try { return !!localStorage.getItem('sp.matchInterrupted') || !!window.__SP_RESTART_PENDING; } catch { return false; }
  });
  useEffect(() => {
    let alive = true;
    const checkAccountRoom = async () => {
      if (!window.__SP_ACCOUNT_USER) { if (alive) setAccountRoom(false); return; }
      try {
        const r = await fetch('/mm/api/account/room', { credentials: 'same-origin', cache: 'no-store' });
        const j = r.ok ? await r.json() : null;
        if (alive) setAccountRoom(!!j?.room?.code);
      } catch { if (alive) setAccountRoom(false); }
    };
    const refresh = () => {
      setItems(identity.recoverable());
      setAccount(!!window.__SP_ACCOUNT_USER);
      try { setRestartPending(!!localStorage.getItem('sp.matchInterrupted') || !!window.__SP_RESTART_PENDING); } catch { setRestartPending(false); }
      checkAccountRoom();
    };
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('sp-account-token', refresh);
    window.addEventListener('sp-room-left', refresh);
    const timer = setInterval(refresh, 5000);
    refresh();
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('sp-account-token', refresh);
      window.removeEventListener('sp-room-left', refresh);
    };
  }, []);
  // After a node restart the interrupted-alliance panel owns recovery; do not offer the
  // account-resume button (it could start a fresh match instead).
  if (restartPending) return null;
  if (!items.length && !(account && accountRoom)) return null;
  const accountResume = account && accountRoom;
  const resumeLabel = accountResume ? t('恢复账号对局') : t('恢复本机对局');
  const resume = async (item) => {
    if (busy) return;
    setBusy(true);
    if (await identity.resume(item.id)) {
      identity.setEntered(true);
      store.patch('session', { entered: true });
      // Keep the tentative token in this document until welcome persists it. Reloading here
      // would either lose the selection or falsely turn it into an established session claim.
      net.close();
      net.setName(item.name);
      net.connect();
      setOpen(false);
      setBusy(false);
    } else {
      setBusy(false);
      // 这句话会误导：identity.resume() 返回 false 的真实原因通常是
      //   * 那个对局早就没了（节点重启 / 正常结束 / 会话过期），本机只剩一条过期记录；
      //   * 或者令牌在别的标签页被轮换走了。
      // 「仍在其他窗口」只在少数情况成立（另一个标签页正连着同一个座位）。
      // 实测玩家看到的场景是「刷新页面 → 对局已不存在 → 点了恢复 → 被说成‘关掉原窗口’」，
      // 按提示关窗口毫无用处。据实说明并给出下一步。
      toast(t('这条记录对应的对局已经不在了（可能已结束或所在节点重启过）。回到大厅重新开始吧。'), 'warn', { ttl: 8000 });
    }
  };
  const resumeAccount = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await requestAccountResume();
      setOpen(false);
    } catch {
      // 这台浏览器连的节点上没有该账号的会话（座位在别的节点上）。
      //
      // ★ 2026-10-27：以前这里在失败后**自动** location.assign 到 /r/CODE，玩家只是点了一下
      //   「恢复对局」，紧接着页面自己跳走，看上去像抽搐；而且 /r/CODE 落地后又走自动恢复，
      //   失败时还会再跳，来回几跳。现在的规则是：**所有跳转都必须由玩家亲手点**。
      //   所以这里不跳，而是把「去那个房间所在节点继续」变成一个玩家再点一次的按钮
      //   （goToRoom 就是那次点击的处理函数）。
      const code = await findAccountRoom();
      if (code) {
        setElsewhere(code);
        setBusy(false);
        return;
      }
      toast(t('没有找到可恢复的账号对局。'), 'warn');
    } finally {
      setBusy(false);
    }
  };
  // 玩家**再次点击**才真正跳到房间所在节点（手动跳转，不再自动）。
  // 落地后需要再发一次 account.resume 才能把已开局的对局接回来（room.join 对已开局
  // 的房间只会回 ROOM_STARTED）。这里写入的 sp.accountResume 是**本次点击**产生的意图，
  // 与以前那种「刷新/换设备自动探测就置位」完全不同 —— 只有玩家点了才会写。
  const goToRoom = () => {
    if (!elsewhere) return;
    try { sessionStorage.setItem('sp.accountResume', '1'); } catch { /* ignore */ }
    location.assign(`/r/${encodeURIComponent(elsewhere)}?accountResume=1`);
  };
  return html`<button type="button" class="verchip" data-testid="resume-local-match" onClick=${() => setOpen(true)} title=${resumeLabel}>
      <${Icon} name="refresh" /><span class="verchip__label">${resumeLabel}</span>
    </button>
    <${Modal} open=${open} onClose=${() => !busy && setOpen(false)} title=${resumeLabel}>
      <p>${t('选择已关闭窗口的对局。服务器重启或对局过期后无法恢复。')}</p>
      ${accountResume ? html`<${Button} variant="primary" block=${true} disabled=${busy} onClick=${resumeAccount}>${t('通过账号恢复当前对局')}<//>` : null}
      ${elsewhere ? html`<div class="resume-elsewhere">
        <p>${t('这个页面对应的节点上没有你的对局，它在另一个节点（房间 {code}）。点下面的按钮过去继续。', { code: elsewhere })}</p>
        <${Button} variant="primary" block=${true} onClick=${goToRoom}>${t('前往该房间继续对局')}<//>
      <//>` : null}
      ${items.length ? items.map((item) => html`<${Button} key=${item.id} variant="secondary" block=${true} disabled=${busy} onClick=${() => resume(item)}>
        ${t('{name} · 同盟 {code}', { name: item.name || t('博士'), code: item.code || '—' })}<//>`) : null}
    <//>`;
}
