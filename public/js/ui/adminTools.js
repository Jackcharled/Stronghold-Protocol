// public/js/ui/adminTools.js — 游戏内管理员工具（本服新增，2026-10-31）
//
// 用途：维护者用管理员账号在**正常对局**里直接改对局状态，复现玩家反馈的场景。
// 原来靠测试房（SP_TEST_MODE）做，但那等于对全服开放刷分入口，代价太大。
//
// 权限四层（前端只有第一层，后面三层才是真的）：
//   1) 前端：store.adminTools 为真才渲染。它来自 welcome.adminTools，服务端 net.js 用
//      .secrets/watch-secret 验签 adminToken 后置位 —— 前端改不了。
//   2) 验证码：adminToken 不再是「登录账号就有」，而是要用**只能在管理后台生成**的 6 位码换取，
//      有效期 4 小时。过期后面板变灰、只能输新码。
//   3) 服务端 routeGameNow：g.test 在非测试房里 session.admin 不为真就拒绝。
//   4) 服务端 Match.applyTestCommand：再查一次 ps.admin。
//
// 入口：对局中点击左上角的延迟胶囊（ui/hud.js 的 PingPill）。
import { useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { useStore } from '../store.js';
import { data } from '../data.js';
import { net } from '../net.js';
import { toast } from './toasts.js';
import { t } from '../../../shared/i18n.js';

/** 全部 16 条 g.test 指令（server/match/match/testCommands.js 的 _applyTest 一一对应）。 */
const TABS = [
  { id: 'chess', label: '干员', field: 'chess' },
  { id: 'item', label: '装备', field: 'items' },
  { id: 'bond', label: '盟约', field: 'bonds' },
  { id: 'strategy', label: '策略', field: 'bands' },
  { id: 'bounty', label: '悬赏', field: 'enemies' },
  { id: 'funds', label: '数值' },
  { id: 'phase', label: '阶段' },
  { id: 'token', label: '召唤' },
  { id: 'shop', label: '商店' },
  { id: 'choice', label: '机变' },
];

const nameOf = (rec, key) => (rec && (data.localeName?.(rec.name || rec.displayName) || rec.name)) || key;

/**
 * 管理员工具面板。
 * @param {{ open: boolean, onClose: () => void }} props
 */
export function AdminTools({ open, onClose }) {
  const [tab, setTab] = useState('chess');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState([]);
  // 数值类指令的三个输入（资金 / LP / 回合 / 商店位）
  const [num1, setNum1] = useState('999');
  const [num2, setNum2] = useState('0');
  // 验证码
  const [code, setCode] = useState('');
  const [codeMsg, setCodeMsg] = useState('');
  const adminTools = useStore((s) => s.adminTools === true);
  if (!open) return null;

  const push = (ok, text) => setLog((l) => [{ ok, text }, ...l].slice(0, 10));

  // 二次确认：按「会不会影响到别的座位 / 整局进程」分三档。
  //   全局 —— 改的是房间级状态或所有人生效的阶段推进，别的玩家会当场看见变化；
  //   他人 —— 改的是别人的座位（领队生命 / 队伍生命 / 给别人发召唤物），对方会直接受影响；
  //   自身 —— 只改自己这一份（自己的干员 / 装备 / 资金 / 商店），误点撤销即可，不打断。
  // 判定写成表而不是散在 22 个按钮里，新增指令漏登记时会落到 '自身'，再加一条测试兜住。
  const GLOBAL = new Set(['phase', 'round', 'timers', 'shop']);
  const OTHERS = new Set(['teamLp']);
  function confirmKind(cmd, args) {
    if (OTHERS.has(cmd)) return '他人';
    if (GLOBAL.has(cmd)) return '全局';
    // 给自己发东西是「自身」，指定了别人的 ownerUid 就是「他人」。
    if (cmd === 'token') {
      const mine = Number(window.__SP_SELF_UID) || 0;
      return args && args.ownerUid && mine && args.ownerUid !== mine ? '他人' : '自身';
    }
    return '自身';
  }
  // 会话内「本次不再确认」：这类指令勾过之后不再弹窗，关掉面板即失效。默认关闭。
  const [trusted, setTrusted] = useState({});
  const ask = (kind, note) => {
    if (kind === '自身') return true;              // 只动自己这一份，误点可撤销，不打断
    if (trusted[kind]) return true;
    const detail = kind === '全局'
      ? '这条会改变整个房间的状态，场上所有人立刻可见'
      : '这条会影响其他玩家的座位，对方会直接受到变化';
    // 一段式确认：确认框里直接说明影响范围。免确认走面板顶部的开关，不在弹窗里问第二次，
    // 这样每次全局操作只要一次确认，不会因为两次弹窗把人烦到养成「连点确定」的坏习惯。
    return window.confirm(`【${kind}影响】${note}\n\n${detail}。\n\n确定执行吗？`);
  };

  const send = async (cmd, args, note) => {
    const kind = confirmKind(cmd, args);
    if (kind !== '自身' && !ask(kind, note || cmd)) {
      push(false, `${note || cmd} — ${t('已取消')}`);
      return;
    }
    setBusy(cmd);
    try {
      await net.request('g.test', { cmd, args });
      push(true, note || cmd);
      toast(t('已执行'), 'info');
    } catch (e) {
      const code = e?.code || String(e?.message || e);
      // 服务端会拒绝：WRONG_PHASE（战斗中不能改经济/棋子）、NOT_HOST、RATE、TEST_FORBIDDEN…
      push(false, `${note || cmd} — ${code}`);
      toast(code, 'error');
    } finally {
      setBusy('');
    }
  };

  async function verify() {
    const c = String(code || '').trim();
    if (!/^[0-9]{6}$/.test(c)) { setCodeMsg(t('请输入 6 位数字')); return; }
    const email = window.__SP_ACCOUNT_EMAIL || '';
    if (!email) { setCodeMsg(t('请先登录账号')); return; }
    setCodeMsg(t('验证中…'));
    try {
      const r = await fetch('/mm/api/admintool/exchange', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code: c }),
      });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok || !j.adminToken) {
        setCodeMsg(j?.error === 'code_wrong' ? t('验证码不对')
          : j?.error === 'code_expired' ? t('验证码已过期，请到后台重新生成')
          : j?.error === 'not_admin' ? t('这个账号不是管理员')
          : t('验证失败'));
        return;
      }
      window.__SP_ADMIN_TOKEN = j.adminToken;
      setCodeMsg(t('验证成功，正在重连…'));
      try { net.rehandshake?.(); } catch { /* 老版本没有 */ }
      setTimeout(() => { try { location.reload(); } catch { /* ignore */ } }, 700);
    } catch { setCodeMsg(t('网络错误')); }
  }

  // ── 未验证：只显示取码提示 ──
  if (!adminTools) {
    return html`<div class="admintools" data-testid="admin-tools" role="dialog" aria-label=${t('管理员工具')}>
      <header class="admintools__head">
        <b>${t('管理员工具')}</b>
        <button type="button" class="admintools__x" onClick=${onClose} aria-label=${t('关闭')}><${Icon} name="close" /></button>
      </header>
      <p class="admintools__note">${t('需要验证码。到管理后台点「生成游戏内验证码」，把 6 位码填在下面。有效 4 小时，过期后要重新获取。')}</p>
      <div class="admintools__funds">
        <input value=${code} onInput=${(e) => setCode(e.target.value)} inputmode="numeric" maxlength="6"
          placeholder="000000" aria-label=${t('验证码')} />
        <button type="button" onClick=${verify}>${t('验证')}</button>
      </div>
      ${codeMsg ? html`<div class="admintools__msg">${codeMsg}</div>` : null}
    </div>`;
  }

  const list = () => {
    const tabDef = TABS.find((x) => x.id === tab);
    if (!tabDef || !tabDef.field) return [];
    return Object.entries(data.get(tabDef.field) || {});
  };
  const shown = (() => {
    const all = list();
    const f = q ? all.filter(([k, rec]) => (k + ' ' + nameOf(rec, k)).toLowerCase().includes(q.toLowerCase())) : all;
    return f.slice(0, 80);
  })();

  return html`<div class="admintools" data-testid="admin-tools" role="dialog" aria-label=${t('管理员工具')}>
    <header class="admintools__head">
      <b>${t('管理员工具')}</b>
      <button type="button" class="admintools__x" onClick=${onClose} aria-label=${t('关闭')}><${Icon} name="close" /></button>
    </header>

    <nav class="admintools__tabs admintools__tabs--wide">
      ${TABS.map((x) => html`<button key=${x.id} type="button"
        class=${`admintools__tab${tab === x.id ? ' is-on' : ''}`}
        onClick=${() => { setTab(x.id); setQ(''); }}>${t(x.label)}</button>`)}
    </nav>

    <div class="admintools__warn">
      <label class="admintools__chk" title=${t('默认关闭。勾上后本面板内的全局/他人指令不再弹确认；关掉面板或点「恢复确认」即复原')}>
        <input type="checkbox" checked=${!!trusted['全局'] || !!trusted['他人']}
          onChange=${(e) => setTrusted(e.target.checked ? { 全局: true, 他人: true } : {})} />
        <span>${t('免确认（全局 / 他人指令）')}</span>
      </label>
      ${(trusted['全局'] || trusted['他人']) ? html`
        <b class="admintools__warnon">${t('⚠ 正在绕过二次确认')}</b>
        <button type="button" class="admintools__mini" onClick=${() => setTrusted({})}>${t('恢复确认')}</button>` : null}
    </div>

    ${
      // 干员 / 装备 / 盟约 / 策略 / 悬赏：从数据表里挑一条
      ['chess', 'item', 'bond', 'strategy', 'bounty'].includes(tab) ? html`
        <input class="admintools__search" value=${q} onInput=${(e) => setQ(e.target.value)}
          placeholder=${t('搜索…')} aria-label=${t('搜索')} />
        <div class="admintools__list">
          ${shown.length ? shown.map(([key, rec]) => html`<button key=${key} type="button" class="admintools__row"
            disabled=${!!busy} title=${key} onClick=${() => send(tab, { id: key }, nameOf(rec, key))}>
            <span class="admintools__name">${nameOf(rec, key)}</span>
            ${rec && rec.tier ? html`<span class="admintools__tier">${rec.tier}</span>` : null}
          </button>`) : html`<div class="admintools__empty">${t('没有匹配的条目')}</div>`}
        </div>`

      // 数值：资金 / 目标生命 / 领袖生命 / 队伍生命
      : tab === 'funds' ? html`
        <label class="admintools__field">${t('数值')}
          <input value=${num1} onInput=${(e) => setNum1(e.target.value)} inputmode="numeric" />
        </label>
        <div class="admintools__row3">
          <button type="button" disabled=${!!busy} onClick=${() => send('funds', { amount: Number(num1) || 0 }, `${t('资金')}=${num1}`)}>${t('资金')}</button>
          <button type="button" disabled=${!!busy} onClick=${() => send('lp', { value: Number(num1) || 0 }, `${t('目标生命')}=${num1}`)}>${t('目标生命')}</button>
          <button type="button" disabled=${!!busy} onClick=${() => send('hp', { value: Number(num1) || 0 }, `${t('领袖生命')}=${num1}`)}>${t('领袖生命')}</button>
          <button type="button" disabled=${!!busy} onClick=${() => send('teamLp', { value: Number(num1) || 0 }, `${t('队伍生命')}=${num1}`)}>${t('队伍生命')}</button>
        </div>
        <div class="admintools__row3">
          <button type="button" disabled=${!!busy} onClick=${() => send('level', {}, t('升级调度中心'))}>${t('升级调度中心')}</button>
          <button type="button" disabled=${!!busy} onClick=${() => send('round', { round: Number(num1) || 1 }, `${t('跳到回合')} ${num1}`)}>${t('跳到该回合')}</button>
        </div>`

      // 阶段控制
      : tab === 'phase' ? html`
        <div class="admintools__row3">
          <button type="button" disabled=${!!busy} onClick=${() => send('phase', { name: 'advance' }, t('继续被暂停的阶段'))}>${t('继续阶段')}</button>
          <button type="button" disabled=${!!busy} onClick=${() => send('phase', { name: 'battleCheck' }, t('结束策略选择'))}>${t('结束策略选择')}</button>
          <button type="button" disabled=${!!busy} onClick=${() => send('phase', { name: 'prep' }, t('进入休整'))}>${t('进入休整')}</button>
          <button type="button" disabled=${!!busy} onClick=${() => send('phase', { name: 'sp' }, t('进入机变'))}>${t('进入机变')}</button>
          <button type="button" disabled=${!!busy} onClick=${() => send('phase', { name: 'combat' }, t('开始作战'))}>${t('开始作战')}</button>
        </div>
        <div class="admintools__row3">
          <button type="button" disabled=${!!busy} onClick=${() => send('timers', { on: false }, t('关闭计时'))}>${t('关闭计时')}</button>
          <button type="button" disabled=${!!busy} onClick=${() => send('timers', { on: true }, t('开启计时'))}>${t('开启计时')}</button>
        </div>`

      // 下一轮商店：逗号分隔的槽位
      : tab === 'shop' ? html`
        <p class="admintools__note">${t('输入下一轮商店的条目，逗号分隔（干员或装备 id）。留空 = 清空。')}</p>
        <label class="admintools__field">${t('槽位')}
          <input value=${num2} onInput=${(e) => setNum2(e.target.value)} placeholder="chess_char_4_14_b, chess_item_3_05_e_b" />
        </label>
        <div class="admintools__row3">
          <button type="button" disabled=${!!busy}
            onClick=${() => send('shop', { slots: String(num2 || '').split(/[,，\s]+/).filter(Boolean) }, t('设置下一轮商店'))}>${t('设置')}</button>
        </div>`

      // 机变：按序号挑
      : tab === 'choice' ? html`
        <p class="admintools__note">${t('机变选项按序号挑选（0 起）。')}</p>
        <label class="admintools__field">${t('序号')}
          <input value=${num2} onInput=${(e) => setNum2(e.target.value)} inputmode="numeric" />
        </label>
        <div class="admintools__row3">
          <button type="button" disabled=${!!busy}
            onClick=${() => send('choice', { idx: Number(num2) || 0 }, `${t('机变')} #${num2}`)}>${t('选择该项')}</button>
        </div>`

      // 召唤物：需要一个持有该召唤物的干员
      : tab === 'token' ? html`
        <p class="admintools__note">${t('给某个已上场的干员 +1 个可放置召唤物。填干员的 uid 和召唤物 id。')}</p>
        <label class="admintools__field">${t('干员 uid')}
          <input value=${num2} onInput=${(e) => setNum2(e.target.value)} inputmode="numeric" />
        </label>
        <div class="admintools__row3">
          <input class="admintools__search" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder=${t('召唤物 id…')} />
        </div>
        <div class="admintools__row3">
          <button type="button" disabled=${!!busy}
            onClick=${() => send('token', { id: String(q || '').trim(), ownerUid: Number(num2) || 0 }, t('发放召唤物'))}>${t('发放')}</button>
        </div>`
      : null
    }

    ${log.length ? html`<ul class="admintools__log">
      ${log.map((e, i) => html`<li key=${i} class=${e.ok ? 'is-ok' : 'is-bad'}>${e.text}</li>`)}
    </ul>` : null}
  </div>`;
}
