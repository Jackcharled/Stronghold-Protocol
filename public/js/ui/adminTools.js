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
// 入口：对局中点击左上角的「节点状态」胶囊（mm/client.js 派发 sp-open-admin-tools，
// ui/hud.js 监听）。★ 不是延迟胶囊：PingPill 只是个延迟显示，没有点击事件。
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Icon } from './components.js';
import { store, useStore } from '../store.js';
import { data, useData } from '../data.js';
import { net } from '../net.js';
import { toast } from './toasts.js';
import { t } from '../../../shared/i18n.js';

/** 全部 16 条 g.test 指令（server/match/match/testCommands.js 的 _applyTest 一一对应）。 */
// 管理员指令的服务端回执 → 给使用者看的一句话。
// 只登记「玩家看到会困惑」的那些；写清原因和下一步，不要只说失败。
const ERR_HINT = {
  TEST_FORBIDDEN: t('没有使用权限。请确认本局你的座位带管理员身份（重新登录游戏账号后进房）；或到管理后台生成验证码。'),
  TEST_DISABLED: t('这个节点没有开启测试指令开关。换一个节点（例如 node-1）再试。'),
  SPECTATOR: t('观战席只能观看，不能执行管理指令。'),
  // ★ 2026-10-31：服务端已放行管理员（不再要求房主），所以这条现在只在两种情况下出现：
  //   ① 座位上的 admin 标记没同步上（例如刚兑换完验证码、还没重连）；
  //   ② 测试模式房间里由非房主、非管理员的人下命令。
  NOT_HOST: t('这条指令需要管理员身份或房主身份。若你刚兑换了验证码，刷新一次页面再试。'),
  WRONG_PHASE: t('当前阶段不允许这条操作（例如战斗中不能改经济或棋子）。'),
  NOT_IN_ROOM: t('你不在房间里。'),
  RATE: t('操作太频繁，稍等一下再点。'),
  BAD_MSG: t('指令参数不对，检查填的数值或 ID。'),
  INTERNAL: t('服务端出错了，请看节点日志。'),
};

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

// 换来的验码令牌在 sessionStorage 里的键。刷新/重连后靠它恢复
// （只放内存会在 location.reload() 后丢失，见 verify() 里的说明）。
const ADMIN_TOKEN_KEY = 'sp.adminToken';

// ★ 2026-10-31：模块一加载就把上次兑换的令牌放回 window.__SP_ADMIN_TOKEN。
//   必须放在模块顶层（而不是组件里）：面板只在打开时才挂载，而 net 的 hello
//   在页面一加载就发出去了 —— 等面板挂载再恢复就太晚了，那次 hello 已经不带令牌。
//   net.js 的 hello 只从 window.__SP_ADMIN_TOKEN 取这个值。
//
//   ⚠ 恢复之前先看**有没有过期**：过期的令牌绝不能恢复，
//   否则「4 小时到了」这件事只在面板打开时才被发现，没开面板时页面仍带着一枚
//   服务端已经不认（或刚好还在认）的旧令牌，状态很混乱。
//   sp.adminCodeExp 记的是兑换那一刻 + ttl，过期就当没换过。
try {
  const expAt = Number((globalThis.localStorage && globalThis.localStorage.getItem('sp.adminCodeExp')) || 0);
  const expired = !Number.isFinite(expAt) || expAt <= Date.now();
  if (expired) {
    // 授权已到期：连存下来的令牌一起清掉，回到「必须先输码」的状态。
    try { globalThis.sessionStorage && globalThis.sessionStorage.removeItem(ADMIN_TOKEN_KEY); } catch { /* ignore */ }
    try { globalThis.localStorage && globalThis.localStorage.removeItem('sp.adminCodeExp'); } catch { /* ignore */ }
    if (typeof window.__SP_ADMIN_TOKEN === 'string') window.__SP_ADMIN_TOKEN = '';
  } else {
    const saved = globalThis.sessionStorage && globalThis.sessionStorage.getItem(ADMIN_TOKEN_KEY);
    if (saved && !(typeof window.__SP_ADMIN_TOKEN === 'string' && window.__SP_ADMIN_TOKEN)) {
      window.__SP_ADMIN_TOKEN = saved;
    }
  }
} catch { /* 隐私模式：忽略 */ }

/**
 * 管理员工具面板。
 * @param {{ open: boolean, onClose: () => void }} props
 */
export function AdminTools({ open, onClose, anchor = null }) {
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
  // 验证码区（仅未授权时渲染）。已授权时整块不出现，只留顶部状态行与「退出授权」。
  const [showCode, setShowCode] = useState(false);
  // ★ 「已授权」必须反映**验证码**的状态，而不是登录身份。
  //   owner/admin 账号登录时 welcome.adminTools 就是 true，那是账号身份，跟验证码无关；
  //   以前拿它当「已授权」显示，于是明明没换码也写着已授权，等于误导。
  //   这里读 localStorage 里兑换成功时记下的到期时间。
  const readLeftMin = () => {
    try {
      const exp = Number(localStorage.getItem('sp.adminCodeExp') || 0);
      if (!Number.isFinite(exp) || exp <= Date.now()) return 0;
      return Math.max(1, Math.ceil((exp - Date.now()) / 60000));
    } catch { return 0; }
  };
  const [codeAuthed, setCodeAuthed] = useState(() => readLeftMin() > 0);
  const [codeLeftMin, setCodeLeftMin] = useState(() => readLeftMin());
  // 必须订阅才会真正去加载 data/*.json；否则下面 list() 拿到的永远是空表。
  // 一次订阅全部列表数据集，切页签不会又变回空白。
  useData('chess', 'items', 'bonds', 'bands', 'enemies');
  // 每 5 秒核对一次有效期。到点要做的不只是「改一个布尔值」：
  // 必须把令牌一起清掉并重新握手，否则 window.__SP_ADMIN_TOKEN 还留着，
  // 服务端也还认它（服务端只看令牌 exp）—— 面板会退回取码界面，
  // 但手里那枚过期令牌还在，属于「以为退出了其实没有」的隐患。
  useEffect(() => {
    const t2 = setInterval(() => {
      const m = readLeftMin();
      setCodeAuthed((prev) => (prev === (m > 0) ? prev : m > 0));
      setCodeLeftMin((prev) => (prev === m ? prev : m));
      if (m <= 0) {
        // 4 小时（或测试时的短时长）到期：彻底清掉授权，回到「未授权」状态。
        try {
          if (typeof window.__SP_ADMIN_TOKEN === 'string' && window.__SP_ADMIN_TOKEN) {
            window.__SP_ADMIN_TOKEN = '';
            try { sessionStorage.removeItem(ADMIN_TOKEN_KEY); } catch { /* ignore */ }
            try { localStorage.removeItem('sp.adminCodeExp'); } catch { /* ignore */ }
            try { net.rehandshake?.(); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }
    }, 5000);
    return () => clearInterval(t2);
  }, []);
  // 订阅 adminTools 只为触发重渲染（退出授权 / 重新验码后界面要跟着更新），值本身不用。
  useStore((s) => s.adminTools === true);
  // 身份门：是 owner/admin 账号（不看有没有验证码）。面板的「能不能打开」用它判断。
  const adminId = useStore((s) => s.adminId === true);
  // 权限门（2026-10-31）：这个管理员账号有没有 tools.game 权限。owner 恒真。
  // 没有权限的 admin 连取码框都不该看到 —— 见下面 `if (!adminId || !gameTool)`。
  const gameTool = useStore((s) => s.gameTool === true);
  // 验码门：✱ 2026-10-31 维护者重新明确规则 ✱
  //   「打开第一次先输入授权码，超过 4 小时过期了就需要重新输入」
  //   ——所以光有身份不够，必须**兑换过验证码**，而且必须在有效期内。
  //
  //   判据同时看两处，缺一不可：
  //   · 服务端这一次连接认不认（adminCode，来自 welcome）—— 决定功能点下去会不会被拒；
  //   · 本机记的兑换截止时刻（sp.adminCodeExp）—— 决定 4 小时到没到。
  //   只看服务端：/api/auth/me 以前会自动发令牌，登录即有权限（已修）。
  //   只看 localStorage：前端说已生效、点功能却回没有权限（2026-10-31 实测过）。
  const adminCode = useStore((s) => s.adminCode === true);
  // codeAuthed 由上面那个 5 秒轮询跟着 sp.adminCodeExp 走，过期会自己变 false。
  const codeValid = adminCode && codeAuthed;
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
      // 原始错误码对使用者没有意义（"TEST_FORBIDDEN" 看不出该怎么办），所以翻成一句话再说。
      // 未登记的新码仍然原样显示并标注来源，免得排查时找不到线索。
      const why = ERR_HINT[code] || t('服务端拒绝：{code}', { code });
      push(false, `${note || cmd} — ${why}`);
      toast(why, 'error');
    } finally {
      setBusy('');
    }
  };

  async function verify() {
    const c = String(code || '').trim();
    if (!/^[0-9]{6}$/.test(c)) { setCodeMsg(t('请输入 6 位数字')); return; }
    // ★ 2026-10-31：**不再把 email 发给服务端**。
    //   兑换的身份由服务端从登录会话取（cookie），前端传什么都不算数 ——
    //   否则谁都能把 email 改成别人的，去用别人的码。
    //   这里只做一次「有没有登录」的前置提示，真正的判定在服务端。
    if (!window.__SP_ACCOUNT_TOKEN) { setCodeMsg(t('请先登录账号')); return; }
    setCodeMsg(t('验证中…'));
    try {
      const r = await fetch('/mm/api/admintool/exchange', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: c }),
      });
      const j = await r.json().catch(() => null);
      if (!j || !j.ok || !j.adminToken) {
        setCodeMsg(j?.error === 'code_wrong' ? t('验证码不对')
          : j?.error === 'code_expired' ? t('验证码已过期，请到后台重新生成')
          : j?.error === 'not_your_code' ? t('这个验证码不是你的，请用自己后台生成的码')
          : j?.error === 'login_required' ? t('请先登录账号')
          : j?.error === 'not_admin' ? t('这个账号不是管理员')
          : t('验证失败'));
        return;
      }
      window.__SP_ADMIN_TOKEN = j.adminToken;
      try {
        // ★ 2026-10-31：换来的令牌必须落盘（sessionStorage）。
        //   原来只放内存，紧接着下面 location.reload() 一刷就没了 ——
        //   于是「验证成功 → 重连 → 刷新 → 又要求输码」（维护者实测撞到）。
        //   用 sessionStorage 而不是 localStorage：关掉标签页授权就结束，符合「4 小时临时授权」的语义。
        sessionStorage.setItem(ADMIN_TOKEN_KEY, String(j.adminToken));
        // ★ 有效期以**服务端**为准：服务端回 ttlMs（默认 4 小时，测试时可调短）。
        //   前端不要再写死 4 小时 —— 两边必须一致，否则会出现
        //   「服务端已过期、前端还以为能用」或反过来「前端先退回、服务端还认」。
        const ttlMs = Number(j.ttlMs) > 0 ? Number(j.ttlMs) : (Number(j.hours) || 4) * 3600_000;
        localStorage.setItem('sp.adminCodeExp', String(Date.now() + ttlMs));
        setCodeAuthed(true);
        setCodeLeftMin(Math.max(1, Math.ceil(ttlMs / 60000)));
      } catch { /* ignore */ }
      // ★ 2026-10-31：**不再刷新页面**（维护者：刷新很影响体验）。
      //   只要在**同一条连接上重发一次 hello**，服务端就会重新校验令牌、
      //   并通过 welcome 把 adminCode / adminTools 推下来 —— 界面自动就切到功能面板。
      //   （rehandshake 就是干这个的：net.js 注释写明「服务端接受同一连接上的重复 hello」
      //   并重新同步身份。）
      setCodeMsg(t('验证成功'));
      try { net.rehandshake?.(); } catch { /* 老版本没有 */ }
      // 兜底：真的没连上（离线/重连中）时，等它连上会自动带令牌握手，不必刷新。
      // 但如果 3 秒后服务端还是没认，起码给个明确的提示，别让人对着「验证成功」发呆。
      setTimeout(() => {
        let ok;
        try { ok = store.get().adminCode === true; } catch { ok = false; }
        if (!ok) setCodeMsg(t('验证成功，但服务端还没确认。请确认已连接后关掉面板重开。'));
      }, 3000);
    } catch { setCodeMsg(t('网络错误')); }
  }

  // 验证码区块：未验证时是面板里的唯一内容；已验证时这块不渲染，
  // 因为 owner/admin 账号只要登录游戏就自带 session.admin —— 他们不需要验证码也能用，
  // 但仍然应该能换一枚 4 小时的 adminToken（比如游戏账号换了设备、或想让授权自动过期）。
  const codeBox = (autoOpen) => html`<div class=${'admintools__code' + (autoOpen ? ' is-open' : '')}>
    <div class="admintools__codehead">
      <span>${t('验证码授权')}</span>
      <b class="admintools__stick--on">${t('● 验码已生效')}</b>
      ${codeLeftMin > 0
        ? html`<span class="admintools__stick--id">${t('剩余 {m} 分钟', { m: codeLeftMin })}</span>`
        : html`<span class="admintools__stick--id" title=${t('本机没记剩余时间，以服务端授权为准')}>${t('服务端已授权')}</span>`}
      <button type="button" class="admintools__mini" onClick=${async () => {
          // 退出授权：调服务端吊销接口，让**所有已签发**的验码令牌失效。
          // 令牌是无状态 HMAC，前端删不干净 —— 必须由服务端记一个吊销时间点，
          // 节点校验时拒绝 iat 早于该时刻的令牌（见 account.cjs /api/admintool/revoke + server/adminAuth.js）。
          try {
            await fetch('/mm/api/admintool/revoke', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
          } catch { /* 网络失败也继续清本地 */ }
          try { localStorage.removeItem('sp.adminCodeExp'); } catch { /* ignore */ }
          try { sessionStorage.removeItem(ADMIN_TOKEN_KEY); } catch { /* ignore */ }
          try { window.__SP_ADMIN_TOKEN = ''; } catch { /* ignore */ }
          // ★ 2026-10-31：退出授权也**不再刷新页面**。
          //   重发 hello 后服务端会拿「没有令牌」重算 → welcome.adminCode/adminTools 变 false，
          //   界面自己就退回取码框。刷新只是为了「让状态生效」，而重握手已经能做到。
          try { net.rehandshake?.(); } catch { /* ignore */ }
          setCodeAuthed(false); setCodeLeftMin(0);
          // 退出后直接把取码框展开：不刷新页面时，用户不用再点一次「验证码授权」才看到输入框。
          setShowCode(true);
          setCodeMsg(t('已退出授权'));
        }} title=${t('已吊销全部验码令牌，下次要重新输码')}>${t('退出授权')}</button>
    </div>
    ${(autoOpen || showCode) ? html`
      <p class="admintools__note">${t('到管理后台点「生成游戏内验证码」，把 6 位码填在下面。码 10 分钟内有效，兑换后本面板可用 4 小时。')}</p>
      <div class="admintools__funds">
        <input value=${code} onInput=${(e) => setCode(e.target.value)} inputmode="numeric" maxlength="6"
          placeholder="000000" aria-label=${t('验证码')} />
        <button type="button" onClick=${verify}>${t('验证')}</button>
      </div>
      ${codeMsg ? html`<div class="admintools__msg">${codeMsg}</div>` : null}` : null}
  </div>`;

  // ── 未验证：只显示取码提示 ──
  // ═══ 两道门，缺一不可（维护者 2026-10-31 定） ═══
  //   ① 身份门：必须是 owner/admin 账号（服务端 welcome.adminTools）；
  //   ② 验码门：必须兑换过验证码且未过期（localStorage 的 sp.adminCodeExp）。
  // 只过第一道 → 只能看见取码框，功能全部不渲染；
  // 只过第二道 → 身份门已挡在前面，连面板入口都不会出现（hud 用 store.adminTools 判）。
  // ★ 必须在所有 return 之前定义：const 有 TDZ，声明在使用之后会抛
  //   "Cannot access 'panelStyle' before initialization"，面板整个渲染不出来。
  const panelStyle = (() => {
    if (!anchor) return '';
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const W = Math.min(340, vw - 32);
    const H = Math.min(540, Math.round(vh * 0.62));
    // 用**右对齐**：面板右边缘贴住胶囊右边缘。
    // 之前用 left 定位，胶囊在屏幕右侧时面板会从胶囊左边缘往右铺，
    // 结果整块落到屏幕中间（DevTools 里 inset: 69px auto auto 225px 就是这现象）。
    // anchor.left + anchor.width = 胶囊右边缘；从右边量就是 vw - 这个值。
    const pillRight = anchor.left + (anchor.width || 0);
    let right = Math.max(16, Math.round(vw - pillRight));
    // 面板宽度不能把左边界顶出屏幕
    right = Math.min(right, Math.max(16, Math.round(vw - W - 16)));
    let top = Math.round(anchor.top);
    // 下方空间不够就往上翻
    if (top + H > vh - 16) top = Math.max(16, Math.round(anchor.top - H - 16));
    return `right:${right}px;top:${top}px;left:auto;bottom:auto;`;
  })();

  if (!adminId || !gameTool) {
    // ① 不是管理员，或 ①b 管理员但没被授予 tools.game 权限：
    //    都**返回 null，连面板外壳都不渲染**。
    //    维护者 2026-10-31：「管理员如果没有权限也不能打开授权界面和管理员工具界面」——
    //    连取码框都不给看，因为展示它本身就是在透露「这里有管理员工具」。
    // 以前这里返回一个「本账号不是管理员」的提示面板 —— 那等于告诉普通玩家
    // 「这里有个管理员工具」，属于信息泄露。
    // 真正的拦截在更外层：hud.js / adminGate.js / mm/client.js 都会先判
    // adminId && gameTool；这里是最后一层兜底（防止有人直接渲染本组件）。
    // ★ 判据用 adminId + gameTool（身份+权限），**不是** adminTools（三道门全过）：
    //   用 adminTools 会让「管理员退出授权后」看不到取码框 —— 死锁。
    return null;
  }
  if (!codeValid) {
    // 是管理员，但还没兑换 / 码已过期 / 4 小时到期：只给取码框，功能一律不渲染。
    return html`<div class="admintools" style=${panelStyle} data-testid="admin-tools" role="dialog" aria-label=${t('管理员工具')}>
      <header class="admintools__head">
        <b>${t('管理员工具')}</b>
        <button type="button" class="admintools__x" onClick=${onClose} aria-label=${t('关闭')}><${Icon} name="close" /></button>
      </header>
      <p class="admintools__note">${t('需要验证码才能使用。到管理后台点「生成游戏内验证码」，把 6 位码填在下面。码 10 分钟内有效，兑换后本面板可用 4 小时。')}</p>
      <div class="admintools__funds">
        <input value=${code} onInput=${(e) => setCode(e.target.value)} inputmode="numeric" maxlength="6"
          placeholder="000000" aria-label=${t('验证码')} />
        <button type="button" onClick=${verify}>${t('验证')}</button>
      </div>
      ${codeMsg ? html`<div class="admintools__msg">${codeMsg}</div>` : null}
    </div>`;
  }

  // 面板定位：优先贴在触发它的胶囊正下方；拿不到坐标时退回右侧固定位置。
  // 用 fixed + 计算出的 left/top，并夹在视口内，保证任何屏幕宽度都不会跑出去。

  const list = () => {
    const tabDef = TABS.find((x) => x.id === tab);
    if (!tabDef || !tabDef.field) return [];
    const raw = data.get(tabDef.field);
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw).filter(([k, v]) => v && typeof v === 'object' && k !== 'name' && k !== 'displayName');
  };
  const shown = (() => {
    const all = list();
    const f = q ? all.filter(([k, rec]) => (k + ' ' + nameOf(rec, k)).toLowerCase().includes(q.toLowerCase())) : all;
    return f.slice(0, 80);
  })();

  return html`<div class="admintools" style=${panelStyle} data-testid="admin-tools" role="dialog" aria-label=${t('管理员工具')}>
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

    ${codeBox(false)}

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
