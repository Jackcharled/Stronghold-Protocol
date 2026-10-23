// Recover an explicitly selected local seat; nickname and IP never identify a player.
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal } from './components.js';
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
      toast(t('此对局仍在其他窗口中，或当前浏览器无法安全恢复。请关闭原窗口后重试。'), 'warn');
    }
  };
  const resumeAccount = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await requestAccountResume();
      setOpen(false);
    } catch {
      // This browser may be connected to a different node than the seat. Find the room in the
      // matchmaker directory, open its /r/CODE route, and let the target page resume automatically.
      const code = await findAccountRoom();
      if (code) {
        setBusy(false);
        // Nginx may consume the query string on /r/CODE; keep the intent in this tab as well.
        try { sessionStorage.setItem('sp.accountResume', '1'); } catch { /* ignore */ }
        location.assign(`/r/${encodeURIComponent(code)}?accountResume=1`);
        return;
      }
      toast(t('没有找到可恢复的账号对局。'), 'warn');
    } finally {
      setBusy(false);
    }
  };
  return html`<${Button} variant="secondary" size="sm" data-testid="resume-local-match" onClick=${() => setOpen(true)}>${resumeLabel}<//>
    <${Modal} open=${open} onClose=${() => !busy && setOpen(false)} title=${resumeLabel}>
      <p>${t('选择已关闭窗口的对局。服务器重启或对局过期后无法恢复。')}</p>
      ${accountResume ? html`<${Button} variant="primary" block=${true} disabled=${busy} onClick=${resumeAccount}>${t('通过账号恢复当前对局')}<//>` : null}
      ${items.length ? items.map((item) => html`<${Button} key=${item.id} variant="secondary" block=${true} disabled=${busy} onClick=${() => resume(item)}>
        ${t('{name} · 同盟 {code}', { name: item.name || t('博士'), code: item.code || '—' })}<//>`) : null}
    <//>`;
}
