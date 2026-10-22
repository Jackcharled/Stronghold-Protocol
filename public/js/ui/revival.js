// Post-unite rescue controls (ported from the reference team panel): the server owns eligibility,
// the window and the one-use limit; these components only explain and send g.revive.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { PHASE } from '../../../shared/constants.js';
import { html, Button, Icon, Tooltip, Countdown, confirmDialog } from './components.js';
import { net } from '../net.js';
import { store, useStore, serverNow } from '../store.js';
import { toast, toastError } from './toasts.js';
import { t } from '../../../shared/i18n.js';

function reasonText(reason) {
  return ({
    disabled: t('本局未开启复活'),
    'no-helper': t('本轮没有满足未漏怪且实际参与联防的救援者'),
    'donor-lp': t('本轮合格联防队友的生命值都不足 11，无法支付救援'),
    'window-expired': t('本次 15 秒救援窗口已结束，死亡已经结算'),
    'window-closed': t('救援阶段已经结束，死亡已经结算'),
    'already-used': t('该队友本局复活次数已经用完'),
    left: t('队友已经主动退出'),
    'match-ended': t('本局模拟已经结束，无法救援'),
  })[reason] || t('当前无法救援');
}

/** A UI hint only: the authority rechecks every predicate. */
export function revivalReason(pub, myId, targetId, online = true, now = serverNow()) {
  const rule = pub?.revival;
  const me = pub?.players?.find((p) => p.playerId === myId);
  const target = pub?.players?.find((p) => p.playerId === targetId);
  if (!rule?.enabled) return t('本局未开启复活');
  if (!online) return t('连接中断，等待重连');
  if (!target || target.playerId === myId || target.alive !== false) return t('只能复活已经死亡的队友');
  if (target.left) return t('队友已经主动退出');
  if (target.revived) return t('该队友本局复活次数已经用完');
  if (!target.pendingDeath) return reasonText(target.revivalUnavailableReason);
  if (pub.phase !== PHASE.SETTLE || !rule.windowOpen || !(rule.deadline > now)) return t('等待联防结算后的救援窗口');
  if (!me?.alive || me.left || me.isBot) return t('只有存活玩家可以提供救援');
  if (!(me.lp >= 11)) return t('至少需要 11 点生命值（支付 10 点）');
  if (!rule.eligible?.includes(myId)) return t('仅限本轮未漏怪且实际参与联防的队友');
  return null;
}

export function RevivalNotice({ pub }) {
  if (!pub?.revival?.enabled || !pub.revival.windowOpen) return null;
  return html`<div class="team-rescue" role="status">
    <strong><${Icon} name="plus" /> ${t('联防救援窗口')}</strong>
    <${Countdown} deadline=${pub.revival.deadline} size="sm" gauge=${false} label=${t('救援剩余')} />
    <small>${t('符合资格且至少 11 生命，可支付 10 点救援')}</small>
  </div>`;
}

export function ReviveAction({ pub, myId, target, compact = false }) {
  const online = useStore((s) => s.connection.status === 'online');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  if (!pub?.revival?.enabled || target.alive !== false || target.playerId === myId) return null;
  const reason = revivalReason(pub, myId, target.playerId, online);
  const revive = async () => {
    if (inFlight.current || reason) return;
    inFlight.current = true;
    setBusy(true);
    const round = pub.round;
    const matchId = pub.revival.matchId;
    try {
      const me = pub.players.find((p) => p.playerId === myId);
      const confirmed = await confirmDialog({
        title: t('复活 {name}', { name: target.name || t('队友') }),
        text: t('支付你自己的 10 点生命，抵消队友这次死亡，将其恢复到 1 点生命；干员、装备和其他状态完整保留。每人每局最多获救一次。支付后你将剩余 {lp} 点生命。', { lp: me.lp - 10 }),
        okText: t('支付 10 生命复活'),
      });
      if (!confirmed) return;
      const current = store.get();
      const latest = current.match.public;
      const invalid = latest?.revival?.matchId !== matchId || latest?.round !== round
        ? t('救援窗口已经变更')
        : revivalReason(latest, myId, target.playerId, current.connection.status === 'online');
      if (invalid) { toast(invalid, 'warn'); return; }
      await net.request('g.revive', { playerId: target.playerId, round, matchId });
    } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return html`<div class=${compact ? 'team-rescue-action team-rescue-action--compact' : 'team-rescue-action'}>
    <${Tooltip} text=${reason || t('至少持有 11 生命，支付 10 点抵消队友死亡')}>
      <${Button} variant="secondary" size="sm" icon="plus" disabled=${!!reason || busy} loading=${busy} onClick=${revive}
        aria-label=${target.revived ? t('复活已用') : t('复活 · −10')}>
        ${compact ? null : target.revived ? t('复活已用') : t('复活 · −10')}
      <//>
    <//>
    ${reason && !compact ? html`<small>${reason}</small>` : null}
  </div>`;
}
