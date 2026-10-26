'use strict';
// 由 nginx 注入到游戏首页的「匹配衔接脚本」（不改动任何游戏本体文件）。
//
// 入口只在「同盟房间」里：房主在「开始模拟」旁边看到「匹配队友」按钮，点它把整个房间丢进全局匹配池。
// 搜寻中 / 搜寻成功的界面按 fork（Stronghold-Protocol-master）的 ui/matchFlow.js 复刻：
// 品牌标、像素侦察兵、等待人数、提示语、停止搜寻；成局后绿色「搜寻成功！」面板。
//
// 匹配成局后所有人被钉到同一个节点：房主自动建房，其余人拿房间码自动加入。
// 另外兼容 /mm/ 单人页（?name=&room= / ?mmhost=1&mid=…）与邀请链接（?room=CODE&n=节点）。

(function () {
  const q = new URLSearchParams(location.search);
  const NAME = (q.get('name') || '').trim().slice(0, 12);
  const ROOM = q.get('room');
  const IS_HOST = q.get('mmhost') === '1';
  const MID = q.get('mid');
  const TICKET = q.get('t');
  const SECRET = q.get('tk');
  const DIFF = q.get('d');
  const CAPACITY = Math.min(20, Math.max(4, Number(q.get('c')) || 4));
  const PMID = q.get('pmid');
  const PCID = q.get('pcid');
  const PDIFF = q.get('pd');
  const PIN_NODE = Number(q.get('n')) || null;
  const AUTO_START = q.get('mm') === '1';
  const ADMIN_WATCH = q.get('adminWatch') === '1';
  const WATCH_GUEST = q.get('watchGuest') === '1';
  const WATCH_TOKEN = q.get('watchToken') || '';
  const WATCH_CODE = (() => {
    try { return sessionStorage.getItem('sp_admin_watch_code') || null; } catch { return null; }
  })();
  // Watch markers are shared through localStorage by the admin console; other open game tabs
  // must not surface their own auto-join errors while an admin watch is active.
  function adminWatchActive() {
    if (ADMIN_WATCH || WATCH_GUEST || WATCH_TOKEN || WATCH_CODE) return true;
    try {
      return !!localStorage.getItem('sp_admin_watch_code') || !!localStorage.getItem('sp_watch_token');
    } catch { return false; }
  }
  // Closing the hidden-watch tab clears the shared watch markers immediately. A normal tab
  // opened right afterwards must not replay its old pending join / account-resume failures.
  function watchExitRecent(ms = 60_000) {
    try {
      const at = Number(localStorage.getItem('sp_admin_watch_closed_at') || 0);
      return at > 0 && Date.now() - at < ms;
    } catch { return false; }
  }
  let GATE = { start: true, match: true };
  // 只有带 &n=<节点> 的完整邀请链接才自动加入；只贴房号的链接不生效
  const ROOM_PINNED = !!(q.get('room') && Number(q.get('n')) > 0);
const SPECTATE = q.get('spectate') === '1';
// 跨节点加入/观战：不把房间码写进地址栏，暂存在本标签页的 sessionStorage，跳转根路径后自动加入
const PENDING_JOIN = (() => {
  try {
    const raw = sessionStorage.getItem('mm.pendingRoom');
    if (!raw) return null;
    sessionStorage.removeItem('mm.pendingRoom');
    const p = JSON.parse(raw);
    return p && typeof p.code === 'string' ? { code: p.code, spectate: !!p.spectate } : null;
  } catch { return null; }
})();
// 邀请短链 /r/CODE：nginx 已把页面路由到正确节点，并用 sp_join cookie 传房号（地址栏只有 /r/CODE）
const JOIN_COOKIE = (() => {
  try {
    const m = document.cookie.match(/(?:^|;\s*)sp_join=([A-Za-z0-9]{4,6})/);
    if (!m) return null;
    document.cookie = 'sp_join=; Path=/; Max-Age=0; SameSite=Lax';
    return m[1].toUpperCase();
  } catch { return null; }
})();

  // 每个标签页一个稳定 id：刷新后仍然是「同一个客户端」，避免丢领队身份
  const CLIENT_ID = (() => {
    try {
      let v = sessionStorage.getItem('mm.cid');
      if (!v) {
        v = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
        sessionStorage.setItem('mm.cid', v);
      }
      return v;
    } catch (e) {
      return String(Math.random()).slice(2) + Date.now();
    }
  })();
  const nodeOf = () => {
    const m = document.cookie.match(/(?:^|;\s*)sp_node=(\d+)/);
    return m ? Number(m[1]) : 1;
  };
  // 切节点：sp_node 给 nodeOf() 读，sp_route 给 nginx 选上游，两者必须一致
  const setNodeCookie = (node) => {
    document.cookie = `sp_node=${node}; path=/; max-age=86400; SameSite=Lax`;
    document.cookie = `sp_route=${node}; path=/; max-age=86400; SameSite=Lax`;
  };
  const seatsOf = (room) => (room && Array.isArray(room.seats) ? room.seats.filter(Boolean).length : 0);

  const TIPS = [
    '联合模拟在选择策略时可以进行一次跳过',
    '调度中心即使冻结，依然可以主动刷新',
    '两件同名装备可以合成一件更强力的装备',
    '只有达成完美作战的队友可以进行联防',
  ];
  const DIFF_NAMES = { FUNNY: '标准模拟', NORMAL: '险境模拟', HARD: '绝境模拟', ABYSS: '终极模拟' };
  const DIFF_COLORS = { FUNNY: '#f6a329', NORMAL: '#e85a1a', HARD: '#e73118', ABYSS: '#ff0024' };

  let tries = 0;
  const wait = setInterval(() => {
    const sp = window.__SP__;
    if (!sp || !sp.net || !sp.store) {
      if (++tries > 400) clearInterval(wait);
      return;
    }
    clearInterval(wait);
    try { boot(sp); } catch (e) { console.warn('[mm] boot failed', e); }
  }, 100);

  function cleanUrl() {
    try {
      const u = new URL(location.href);
      const keepName = !(window.__SP__ && window.__SP__.store && window.__SP__.store.get().session.entered);
      ['room', 'n', 'name', 'mmhost', 'mid', 't', 'tk', 'd', 'c', 'pmid', 'pcid', 'pd', 'mm', 'spectate'].forEach((k) => {
        if (k === 'name' && keepName) return;   // 还没进入大厅前保留名字，进房后再清
        u.searchParams.delete(k);
      });
      const qs = u.searchParams.toString();
      // /r/CODE 是邀请短链的形式：进过房间之后它就没有意义了，留着会让
      // 页面每次刷新都重新触发一次 room.join（对局已开始时表现为反复「加入失败」）。
      let pathname = u.pathname;
      if (/^\/r\/[^/]+$/i.test(pathname)) pathname = '/';
      else if (/^\/room\/[^/]+$/i.test(pathname)) pathname = '/';
      history.replaceState(history.state, '', pathname + (qs ? '?' + qs : '') + u.hash);
    } catch (e) { /* ignore */ }
  }

  const __mmResponsiveCss = `
/* mm-responsive-v1：注入元素的尺寸随窗口缩放 */
/* 同盟模拟 / 独立模拟 顶栏：左侧「标题 + 当前延迟 + 节点状态」比右侧按钮块高，
   .proto-top 是 align-items:flex-start，导致左侧按自己的 65px 高居中、右侧按钮按 42px 高居中，
   两者中心线差 ~5px。让左侧内容与右侧按钮的中心线对齐。 */
/* 大厅顶栏：节点状态「30/30 · 正常 · N 人在线」与右侧方形按钮同高对齐。
   大厅是 [返回][ping][当前延迟][状态栏][Q群] | [统计][设置][玩法说明]，
   左侧 chip 高 24、右侧按钮高 42，需要让 chip 的中心线落在按钮的中心线上，
   而不是按各自文本基线排。 */
.lobby-screen .topbar__left{align-items:center!important}
.lobby-screen .topbar__left > #mm-nodes,
.lobby-screen .topbar__left > #mm-qq-lobby{align-self:center!important;margin-block:0!important}
/* 顶栏是 flex + gap:10px，节点状态如果自带 margin-left:10px 会叠加成 20px，
   在延迟与状态条之间留出多余空白。这里统一清零，间距只由 gap 决定。 */
.lobby-screen .topbar__left > #mm-nodes{margin:0!important}
/* 延迟胶囊（.ping）的宽度随毫秒数位数变化，会把右侧工具组整体推动，表现为 2~3px 的漂移。
   给固定最小宽度并让内容居中，布局就稳定了。 */
.lobby-screen .topbar__left > .ping{min-width:84px!important;justify-content:center!important}
/* 弹窗（同盟模拟 / 独立模拟）里的节点状态：与大按钮同高、垂直居中 */
.mm-proto-meter{display:flex!important;align-items:center!important;gap:10px!important;flex:none!important;align-self:center!important}
.mm-proto-meter > #mm-nodes{display:inline-flex!important;align-items:center!important;height:42px!important;max-height:42px!important;line-height:1!important;flex:none!important;margin:0!important;align-self:center!important}
.mm-proto-meter > #mm-nodes > .chip{display:inline-flex!important;align-items:center!important;justify-content:center!important;height:42px!important;min-height:42px!important;max-height:42px!important;box-sizing:border-box!important;padding:0 16px!important;line-height:1!important;margin:0!important}
.mm-proto-meter > #mm-nodes > .chip > *{line-height:1!important;display:inline-flex!important;align-items:center!important}

/* 节点状态 chip：位于大厅顶栏左侧（延迟之后、分隔线之前），与右侧按钮同一中心线 */
.lobby-screen .topbar__left > #mm-nodes{display:inline-flex!important;align-items:center!important;height:42px!important;line-height:1!important;flex:none!important;align-self:center!important}
.lobby-screen .topbar__left > #mm-nodes > .chip{display:inline-flex!important;align-items:center!important;justify-content:center!important;height:42px!important;min-height:42px!important;box-sizing:border-box!important;padding:0 16px!important;line-height:1!important;margin:0!important}
.lobby-screen .topbar__left > #mm-nodes > .chip > *{line-height:1!important;display:inline-flex!important;align-items:center!important}
.lobby-screen .topbar__tools > #mm-qq-lobby{margin-left:0!important;margin-right:0!important}
/* 节点状态的宽度：原先用 min-width:230px + justify-content:flex-end 锁宽度防止抖动，
   但那样会在胶囊左侧留出一大片空白（看起来像多了一段间距）。
   改为按内容自适应并居中——位置稳定性由 .ping 的固定宽度保证。 */
.lobby-screen .topbar__left > #mm-nodes{justify-content:center!important}
.lobby-screen .topbar__left > #mm-qq-lobby{flex:none!important}
.lobby-screen .topbar__left > #mm-nodes{flex:none!important}
#mm-nodes:not(.topbar) .chip{height:clamp(26px,2.2vw,32px);padding:0 clamp(9px,0.9vw,14px) 0 clamp(7px,0.75vw,11px)}
#mm-nodes:not(.topbar) .chip .num,#mm-nodes:not(.topbar) .chip span{font-size:clamp(11px,1.05vw,14px)}
#mm-room-timer{box-sizing:border-box;gap:2px;flex:none;line-height:1.15}
#mm-room-timer .mm-timer-time{color:var(--mint-400,#5ee0b9);font-weight:700;font-family:var(--font-num,monospace);font-variant-numeric:tabular-nums;line-height:1.1}
#mm-room-timer .mm-timer-label{color:var(--text-lo,#a8c0b9);letter-spacing:.02em;opacity:.9}
#mm-ticker{height:clamp(26px,2.2vw,32px)!important}
#mm-ticker .line{font-size:clamp(11px,1.05vw,15px)!important}
`;

  // ---------------------------------------------------------------- 底栏「已就绪」自动避让



  // ---------------------------------------------------------------- 底栏保持游戏默认

  function installRoomBarShrink() {
    // 说明：按需求，底栏文字与按钮都保持游戏默认布局（整体居中），
    // 不做任何位移/缩放，因此这里只清理早期版本可能留下的内联样式。
    const clear = () => {
      const center = document.querySelector('.room-bar__center');
      if (!center) return;
      center.style.position = '';
      center.style.left = '';
      center.style.top = '';
      center.style.transform = '';
      center.style.width = '';
    };
    clear();
    setInterval(clear, 1500);
  }

  // 新版（0.3.3）悬停提示外观：深色底 + 左侧薄荷竖条 + 直角 + 同字号投影。
  // 用它替代浏览器原生 title（系统气泡，样式改不了），覆盖我们插入的按钮。
  let mmTipEl = null;
  let mmTipAnchor = null;
  function mmTipCss() {
    if (document.getElementById('mm-tip-css')) return;
    const st = document.createElement('style');
    st.id = 'mm-tip-css';
    st.textContent = `
      #mm-tip{position:fixed;z-index:2147483000;max-width:min(340px,70vw);padding:6px 9px;
        border:1px solid var(--line-2,rgba(255,255,255,.14));border-left:2px solid var(--mint-500,#5ee0b9);border-radius:0;
        background:rgba(10,13,12,.97);color:var(--text-md,#cfe9e0);
        font-size:calc(.15 * var(--t,11px));line-height:1.55;letter-spacing:0;white-space:normal;text-align:center;
        pointer-events:none;box-shadow:0 .06rem .2rem rgba(0,0,0,.55);opacity:0;transition:opacity .12s ease-out}
      #mm-tip.is-shown{opacity:1}
    `;
    (document.head || document.documentElement).appendChild(st);
  }
  function mmTipShow(anchor, text) {
    if (!anchor || !text || !document.body.contains(anchor)) return;
    mmTipCss();
    if (!mmTipEl) {
      mmTipEl = document.createElement('div');
      mmTipEl.id = 'mm-tip';
      mmTipEl.className = 'tooltip';
      mmTipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(mmTipEl);
    }
    mmTipEl.textContent = text;
    mmTipAnchor = anchor;
    const r = anchor.getBoundingClientRect();
    const box = mmTipEl.getBoundingClientRect();
    const top = Math.max(6, r.top - box.height - 8);
    const left = Math.min(Math.max(6, r.left + r.width / 2 - box.width / 2), Math.max(6, innerWidth - box.width - 6));
    mmTipEl.style.top = top + 'px';
    mmTipEl.style.left = left + 'px';
    mmTipEl.classList.add('is-shown');
  }
  function mmTipHide() {
    mmTipAnchor = null;
    if (mmTipEl) mmTipEl.classList.remove('is-shown');
  }
  /** 给元素挂上「悬停显示新版样式提示」的行为（不用原生 title）。 */
  function mmTipBind(el, text) {
    if (!el || el.dataset.mmTipBound === '1') {
      if (el) el.dataset.mmTipText = text || '';
      return;
    }
    el.dataset.mmTipBound = '1';
    el.dataset.mmTipText = text || '';
    el.removeAttribute('title'); // 原生气泡会盖住自绘提示，且样式无法统一
    const show = () => mmTipShow(el, el.dataset.mmTipText);
    el.addEventListener('mouseenter', show);
    el.addEventListener('focus', show);
    el.addEventListener('pointerdown', show);
    el.addEventListener('mouseleave', mmTipHide);
    el.addEventListener('blur', mmTipHide);
    el.addEventListener('click', () => setTimeout(mmTipHide, 0));
  }

  function refreshGate() {
    fetch('/mm/api/gate', { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (!j) return;
        GATE = { start: j.start !== false, match: j.match !== false };
        // 管理员/服主无视维护开关（服务端 session.admin 同样放行）
        // 管理员/服主无视维护开关（服务端 session.admin 同样放行）。
        // 角色变量由账号接口异步写入，也可能只有后台下发的 adminToken，两者任一即可。
        const isAdmin = (() => {
          try {
            const r = window.__SP_ACCOUNT_ROLE;
            if (r && r !== 'player') return true;
            if (typeof window.__SP_ADMIN_TOKEN === 'string' && window.__SP_ADMIN_TOKEN.length > 0) return true;
            return false;
          } catch { return false; }
        })();
        const b = [...document.querySelectorAll('button')].find((x) => /开始模拟/.test(x.textContent || ''));
        if (!b) return;
        if (GATE.start === false && !isAdmin) {
          b.disabled = true;
          b.dataset.mmGate = '1';
          // 与新版同款悬停提示，而不是浏览器原生 title 气泡
          b.dataset.mmTipText = '服务器暂时关闭了开始游戏，请稍后再试';
          b.dataset.mmTipBound = '1';
          b.removeAttribute('title');
          mmTipBind(b, b.dataset.mmTipText);
        } else if (b.dataset.mmGate) {
          b.disabled = false;
          delete b.dataset.mmGate;
          b.dataset.mmTipText = '';
          b.removeAttribute('title');
        }
      })
      .catch(() => {});
  }

  function boot(sp) {
    try { refreshGate(); setInterval(refreshGate, 5000); } catch { /* ignore */ }
    document.addEventListener('click', (e) => {
      if (GATE.start !== false) return;
      // 管理员/服主无视维护开关：服务端 start 分支按 session.admin 放行，
      // 前端这里也必须放行，否则会把管理员的点击拦下来并弹提示。
      try {
        const r = window.__SP_ACCOUNT_ROLE;
        if (r && r !== 'player') return;
        if (typeof window.__SP_ADMIN_TOKEN === 'string' && window.__SP_ADMIN_TOKEN.length > 0) return;
      } catch { /* 隐私模式：按普通玩家处理 */ }
      const b = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!b || !/开始模拟/.test(b.textContent || '')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // 与新版一致：被拦截时用顶部 toast 说明原因，而不是静默无反应。
      showStyledToast('服务器暂时关闭了开始游戏，请稍后再试', 'warn');
    }, true);
    try {
      if (!document.getElementById('mm-responsive-css')) {
        const s = document.createElement('style');
        s.id = 'mm-responsive-css';
        s.textContent = __mmResponsiveCss;
        document.head.appendChild(s);
      }
    } catch { /* ignore */ }
    const { store, net } = sp;
    // 复制链接按钮交给房间页自己处理（保持按钮尺寸/文案不变，由它弹出「已复制邀请链接」提示）

    installOverlayStyle();

    if (PIN_NODE && nodeOf() !== PIN_NODE) {
      api(`/mm/api/pin-node?node=${PIN_NODE}`).then(() => location.reload()).catch(() => {});
      return;
    }
    // 参数已经读进常量了：客人立刻把 ?room=&n=&name= 从地址栏抹掉，房主等建房回报后再清
    // 隐身观战保留完整 URL：手机刷新后仍能重新进入 hidden spectator。
    if (ROOM && !ADMIN_WATCH) cleanUrl();
    else if (PIN_NODE && !IS_HOST && !ADMIN_WATCH) cleanUrl();

    if (NAME && !store.get().session.entered) {
      try { store.set((s) => ({ ...s, me: { ...s.me, name: NAME }, session: { ...s.session, entered: true } })); } catch (e) { /* ignore */ }
      try { net.setName(NAME); } catch (e) { /* ignore */ }
    }

    if ((ADMIN_WATCH || WATCH_GUEST) && (ROOM || WATCH_CODE)) { adminWatchFlow(sp); roomUi(sp); }
    else if (IS_HOST && PMID && PCID) { partyHostFlow(sp); roomUi(sp); }
    else {
      // 玩家刚主动退出对局时，不要因为地址栏/邀请 cookie 还留着房号就自动再进一次：
      // 对局已经开始，重进必然失败（ROOM_STARTED），表现就是「回到大厅还在反复提示加入失败」。
      // 2 分钟冷却由 ui/matchChrome.js quitMatch() 写入的 sp.matchExitAt 提供。
      const recentExit = (() => {
        try {
          const t = Number(sessionStorage.getItem('sp.matchExitAt') || 0);
          return t > 0 && Date.now() - t < 120000;
        } catch { return false; }
      })();
      if (recentExit) {
        try { sp.store.patch('ui', { pendingJoin: null, pendingSpectate: false }); } catch { /* ignore */ }
        try { sessionStorage.removeItem('mm.pendingRoom'); } catch { /* ignore */ }
        // 顺手把 /r/CODE 从地址里清掉，避免下次刷新又触发一遍
        try {
          if (/^\/r\/[^/]+$/i.test(location.pathname) || /^\/room\/[^/]+$/i.test(location.pathname)) {
            history.replaceState(history.state, '', '/');
          }
        } catch { /* ignore */ }
      } else if (IS_HOST && MID && TICKET && SECRET && DIFF) hostFlow(sp);
      // 手输密钥/点「加入同盟」跨节点跳转时，目标房间记在 mm.pendingRoom 里。
      // 它必须**排在 JOIN_COOKIE 之前**：刷新后 sp_join 里可能还留着上一次的邀请码，
      // 若先走 JOIN_COOKIE 就会去解析旧码（甚至再跳一次节点），玩家就得多输一次密钥。
      else if (PENDING_JOIN) joinFlow(sp, PENDING_JOIN.code, PENDING_JOIN.spectate);
      // sp_join 只带房号、不带观战意图，所以观战一律回到 PENDING_JOIN（它记了 spectate）。
      // 走到这里说明是纯邀请链接，按加入处理。
      else if (JOIN_COOKIE) resolveRoomNode(JOIN_COOKIE, () => joinFlow(sp, JOIN_COOKIE, false));
      else if (ROOM && ROOM_PINNED) joinFlow(sp, ROOM, SPECTATE);
      else if (ROOM) resolveRoomNode(ROOM, () => joinFlow(sp, ROOM, SPECTATE), SPECTATE);
      roomUi(sp);
    }
    // 匹配成功的对局：不等房主手动点，自动准备 + 自动开始
    warnUnpinnedRoom();
    installJoinRedirect();
    installNodeBadge();
    installAdminEntry();
    /* @sp-strip-icp:start */
    /* @sp-strip-icp:end */
  installQQGroup();
  setInterval(cleanTopExtras, 1200);
  installAnnouncement();
  installResumeButton();
  installTempNotice();
  installRoomBarShrink();

  installUnifiedStyle();

  installBackToAlliance();
  installAutoRejoin();
  installRoomCountdown();

  hideLatencyLabel();
  fixCenterButtons();
  // Once a room is actually in the matchmaking pool, every member defaults to ready.
  installMatchmakingAutoReady(sp);
    if (AUTO_START) { installAutoStart(sp); showTransition(); }
  }

  // 管理后台“隐身观战”：不占观战席、不出现在房间/对局名单里，只收状态与对局帧。
  function adminWatchFlow(sp) {
    const code = ROOM || WATCH_CODE;
    if (!code) return;    let token = '';
    try {
      const cookieToken = (() => {
        try { const m = document.cookie.match(/(?:^|;\s*)sp_watch_token=([^;]*)/); return m ? decodeURIComponent(m[1]) : ''; } catch { return ''; }
      })();
      token = WATCH_TOKEN || localStorage.getItem('sp_watch_token') || sessionStorage.getItem('sp_admin_watch_token') || cookieToken || '';
      if (token) sessionStorage.setItem('sp_admin_watch_token', token);
      // The token is only needed for this hidden-watch handoff; keep it out of the visible iframe URL after use.
      if (WATCH_TOKEN) {
        try {
          const u = new URL(location.href);
          u.searchParams.delete('watchToken');
          history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
        } catch { /* ignore */ }
      }
      sessionStorage.setItem('sp_admin_watch_code', code);
    } catch { /* ignore */ }
    if (!token) return;
    // Keep the lobby/title flash out of the admin watch: cover the page while the
    // hidden spectator joins, then reveal the room as soon as its state arrives.
    let curtain = null;
    const closeCurtain = () => { if (curtain) { curtain.remove(); curtain = null; } };
    try {
      curtain = document.createElement('div');
      curtain.id = 'mm-admin-watch-curtain';
      curtain.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:#071012;color:#d9f7ef;font:600 16px/1.5 "Noto Sans SC",system-ui,sans-serif;letter-spacing:.08em';
      curtain.innerHTML = '<div style="text-align:center"><div style="font:11px/1.6 ui-monospace,monospace;color:#4ed8af;letter-spacing:.3em">[♜] STRONGHOLD PROTOCOL</div><div style="margin-top:12px">正在进入房间观战…</div></div>';
      document.body.appendChild(curtain);
      let stop = null;
      stop = sp.store.subscribe(() => {
        if (sp.store.get().room || sp.store.get().match?.public) { closeCurtain(); if (stop) stop(); }
      });
      setTimeout(closeCurtain, 10000);
    } catch { /* ignore */ }
    let tries = 0;
    const send = () => {
      // Already watching: do not re-request on every socket status event.
      if (sp.store.get().room || sp.store.get().match?.public) return;
      // The watch page is opened before the game socket has necessarily finished
      // its hello; sending room.spectate too early is silently lost on refresh.
      if (sp.net.status !== 'online') {
        if (tries++ < 60) setTimeout(send, 500);
        return;
      }
      tries += 1;
      sp.net.request('room.spectate', { code, hidden: true, adminToken: token })
        .catch(() => { if (tries < 8) setTimeout(send, 1200); });
    };
    send();
    // A transient network drop/reconnect must re-establish the hidden spectator,
    // otherwise the node falls back to the lobby after the socket comes back.
    try {
      sp.net.on?.('status', (snap) => {
        if (snap && snap.status === 'online') { tries = 0; send(); }
      });
    } catch { /* ignore */ }
  }

  // 进入对局时的全屏过渡，盖住中间的「同盟等待室」，开局后自动消失
  function showTransition() {
    if (document.getElementById('mm-transition')) return;
    const ov = document.createElement('div');
    ov.id = 'mm-transition';
    ov.className = 'mm-ov';
    ov.innerHTML = `
      <div class="mm-ov__found">
        <div class="mm-ov__brand"><span class="mm-ov__rook">[♜]</span>STRONGHOLD PROTOCOL</div>
        <svg class="mm-ov__face" viewBox="0 0 64 64" aria-hidden="true">
          <rect x="6" y="8" width="52" height="48" rx="8" /><rect class="mm-ov__faceeye" x="18" y="24" width="7" height="8" />
          <path class="mm-ov__facewink" d="M37 29h10" /><path class="mm-ov__facesmile" d="M22 42q10 7 20 0" />
        </svg>
        <b class="mm-ov__foundtitle">匹配成功</b>
        <span class="mm-ov__foundsub" id="mm-transition-sub">正在进入模拟…</span>
      </div>`;
    document.body.appendChild(ov);
    // 兜底：90 秒还没开局就把界面让出来，避免卡死
    setTimeout(() => hideTransition(), 90_000);
  }

  function hideTransition() {
    const el = document.getElementById('mm-transition');
    if (el) el.remove();
  }

  try { if (!document.querySelector('meta[name="mm-no-referrer"]')) { const m = document.createElement('meta'); m.name = 'mm-no-referrer'; m.setAttribute('name', 'referrer'); m.content = 'no-referrer'; document.head.appendChild(m); } } catch { /* ignore */ }
  // ---------------------------------------------------------------- 匹配成局后自动开局

  function installMatchmakingAutoReady(sp) {
    const { store, net } = sp;
    let lastAt = 0;
    const tick = () => {
      const s = store.get();
      const room = s.room;
      // Only after the host has put this room into the pool. The pre-match rule still
      // requires everyone to be ready before the host can click 匹配队友.
      if (!room || !room.matchmaking) return;
      if (room.hostId === s.me.playerId) return;
      const mine = (room.seats || []).find((x) => x && x.playerId === s.me.playerId);
      if (!mine || mine.ready) return;
      if (Date.now() - lastAt < 1200) return;
      lastAt = Date.now();
      net.request('room.ready', { ready: true }).catch(() => { lastAt = 0; });
    };
    store.subscribe(() => setTimeout(tick, 80));
    setInterval(tick, 900);
    tick();
  }

  function installAutoStart(sp) {
    const { store, net } = sp;
    let readySent = false, startSent = false, enteredAt = Date.now(), autoDone = false;

    const tick = () => {
      const s = store.get();
      const room = s.room;
      if (window.__SP_RESTART_PENDING) return; // 返回同盟提示还在：不要自动开下一局
      // A started / in-match room already moved to the game: do not leave the transition
      // overlay covering it while waiting for the first m.public frame.
      if (s.room?.inMatch || s.match?.public) { autoDone = true; hideTransition(); return; }
      if (autoDone) return;   // 已经开过一局：返回房间后不要自动重开
      if (!room) { enteredAt = Date.now(); readySent = false; startSent = false; return; }
      const me = s.me.playerId;
      const humans = (room.seats || []).filter(Boolean);
      const isHost = room.hostId === me;

      if (!isHost) {
        const mine = humans.find((x) => x.playerId === me);
        // Re-send readiness if the room state still says unready (a room.state update or
        // a dropped request used to leave us waiting forever behind the transition).
        if (mine && !mine.ready && (!readySent || Date.now() - (tick._readyAt || 0) > 2500)) {
          readySent = true;
          tick._readyAt = Date.now();
          net.request('room.ready', { ready: true }).catch(() => { readySent = false; });
        }
        return;
      }
      if (startSent) return;
      const others = humans.filter((x) => x.playerId !== me);
      const allReady = others.every((x) => x.ready && x.connected !== false);
      const full = humans.length >= (Number(room.capacity) || 4);
      const waited = Date.now() - enteredAt;

      // Only a genuinely disconnected matched player may be removed. A connected player
      // who is still loading must never be kicked from a successful match.
      if (waited > 60_000) {
        const stuck = others.filter((x) => x.connected === false);
        if (stuck.length) {
          for (const x of stuck) {
            try { net.request('room.kick', { seat: x.seat, playerId: x.playerId }).catch(() => {}); } catch { /* ignore */ }
          }
          return;
        }
      }
      // 4 人齐且都准备 → 立刻开始；有人掉队时 30 秒后按已到人数开始。
      if (allReady && (full || waited > 30_000)) {
        startSent = true;
        net.request('room.start').catch(() => { startSent = false; });
      }
    };

    store.subscribe(() => { clearTimeout(tick._t); tick._t = setTimeout(tick, 80); });
    setInterval(tick, 900);
    tick();
  }


  const MODE_NAMES = { FUNNY: '标准模拟', NORMAL: '险境模拟', HARD: '绝境模拟', ABYSS: '终极模拟' };

  /**
   * 按房号查房间在哪个节点；不在本节点就写 cookie 切过去，同节点则继续本地加入。
   * @param {string} code 房号
   * @param {Function} onSameNode 已在本节点时继续
   * @param {boolean} [spectate] 观战意图。跨节点跳转会把地址栏清成 `/`，`?spectate=1` 随之消失，
   *   所以必须显式带上并写进 mm.pendingRoom —— 否则观战会退化成「加入」。
   */
  function resolveRoomNode(code, onSameNode, spectate = SPECTATE) {
    fetch('/mm/api/find-room?code=' + encodeURIComponent(code))
      .then((r) => r.json())
      .then((d) => {
        const cur = nodeOf();
        if (d && d.node && d.node !== cur) {
          setNodeCookie(d.node);
          try {
            sessionStorage.setItem('mm.pendingRoom', JSON.stringify({ code, spectate: !!spectate }));
          } catch { /* ignore */ }
          location.replace('/');
          return;
        }
        if (d && d.node === cur) { onSameNode && onSameNode(); return; }
        onSameNode && onSameNode();   // 目录里还没有（刚建），交给本节点尝试
      })
      .catch(() => { onSameNode && onSameNode(); });
  }

  function mmToast(text) {
    try {
      const div = document.createElement('div');
      div.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:90;background:rgba(40,20,10,.95);border:1px solid #7a5a2a;color:#ffd9a8;padding:8px 14px;border-radius:10px;font:13px/1.6 "Noto Sans SC",sans-serif;max-width:90vw';
      div.textContent = text;
      document.body.appendChild(div);
      setTimeout(() => div.remove(), 6000);
    } catch { /* ignore */ }
  }

  // 优先复用游戏自带的 toast（与「房间已满」等提示同一套样式）；模块加载失败才退回 mmToast
  let gameToastFn = null;
  function showStyledToast(text, kind = 'error') {
    // Hidden admin watch must never surface player join/spectate failures (room full, disconnected, etc.):
    // it has no player seat and reports its own watch errors in the watch page.
    if ((adminWatchActive() || watchExitRecent()) && /^(加入失败|观战失败)/.test(String(text || ''))) return;
    const call = (fn) => { try { fn(text, kind); } catch { mmToast(text); } };
    if (gameToastFn) return call(gameToastFn);
    import('/js/ui/toasts.js')
      .then((m) => { gameToastFn = m.toast; call(gameToastFn); })
      .catch(() => mmToast(text));
  }

  /** 大厅「加入同盟 / 观战」：先在当前页面查房间状态（人数/是否开局/节点），能进才跳转；满员/已开局直接提示。 */
  function installJoinRedirect() {
    let bypass = false;
    const codeFrom = (s) => { const m = String(s || '').toUpperCase().match(/\b([A-Z]{4})\b/); return m ? m[1] : null; };
    const findBtn = (spec) => [...document.querySelectorAll('button')].find((b) => {
      const t = b.textContent || '';
      return spec ? (/观战/.test(t) && !/加入同盟/.test(t)) : /加入同盟/.test(t);
    });
    const clickLocal = (spec) => {
      const btn = findBtn(spec);
      if (!btn) return;
      bypass = true;
      btn.click();
      setTimeout(() => { bypass = false; }, 500);
    };
    const checkAndGo = (code, spec, btn) => {
      fetch('/mm/api/find-room?code=' + encodeURIComponent(code))
        .then((r) => r.json())
        .then((d) => {
          if (d && d.node) {
            if (d.mode === 'solo') { showStyledToast(spec ? '独立模拟房间不支持观战（观战只对同盟房间开放）' : '独立模拟房间无法加入'); return; }
            if (spec && Number(d.spectators) >= 2) { showStyledToast('观战席位已满（2/2），请稍后再试'); return; }
            if (!spec && d.started) { showStyledToast('该同盟已开始对局，无法加入；可以点「观战」进入'); return; }
            if (!spec && d.full) { showStyledToast('该同盟人数已满，无法加入；可以点「观战」进入'); return; }
            if (d.node === nodeOf()) { if (btn) { bypass = true; btn.click(); setTimeout(() => { bypass = false; }, 500); } else clickLocal(spec); return; }
            setNodeCookie(d.node);
            try { sessionStorage.setItem('mm.pendingRoom', JSON.stringify({ code, spectate: spec })); } catch { /* ignore */ }
            location.replace('/');
            return;
          }
          if (btn) { bypass = true; btn.click(); setTimeout(() => { bypass = false; }, 500); } else clickLocal(spec);
        })
        .catch(() => { if (btn) { bypass = true; btn.click(); setTimeout(() => { bypass = false; }, 500); } else clickLocal(spec); });
    };
    document.addEventListener('click', (e) => {
      if (bypass) return;
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      const label = btn.textContent || '';
      const spec = /观战/.test(label) && !/加入同盟/.test(label);
      if (!/加入同盟/.test(label) && !spec) return;
      const input = document.querySelector('input[placeholder*="密钥"]')
        || [...document.querySelectorAll('input')].find((i) => i.offsetWidth > 0);
      const code = codeFrom(input && input.value);
      if (!code) return;
      e.preventDefault();
      e.stopPropagation();
      checkAndGo(code, spec, btn);
    }, true);
    // 回车提交同样先检查（游戏自己的 onEnter 会直接在当前节点加入，绕过按钮）
    // 注意：回车**必须按实际意图**处理。这里原先写死 false（当作加入），
    // 于是在「观战」模式下按回车会丢掉观战意图，跨节点后变成加入，甚至失败后要重输。
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || bypass) return;
      const el = document.activeElement;
      if (!el || el.tagName !== 'INPUT' || !/密钥|邀请链接/.test(el.placeholder || '')) return;
      const code = codeFrom(el.value);
      if (!code) return;
      // 当前是否处于观战模式：以界面上可见的观战按钮标签为准（与点击路径同一判据）
      const specBtn = findBtn(true);
      const specMode = !!specBtn && !/加入同盟/.test(specBtn.textContent || '');
      e.preventDefault();
      e.stopPropagation();
      checkAndGo(code, specMode, specMode ? specBtn : findBtn(false));
    }, true);
  }

  function warnUnpinnedRoom() {
    if (!ROOM || ROOM_PINNED) return;
    return;   // 现在会自动按房号找节点，不再提示
    setTimeout(() => {
      try {
        const div = document.createElement('div');
        div.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:90;background:rgba(40,20,10,.95);border:1px solid #7a5a2a;color:#ffd9a8;padding:8px 14px;border-radius:10px;font:13px/1.6 "Noto Sans SC",sans-serif';
        div.textContent = '请使用完整的邀请链接加入同盟（链接里需要带节点参数 &n=）';
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 6000);
      } catch { /* ignore */ }
    }, 1500);
  }

  // ---------------------------------------------------------------- 邀请链接

  /** 复制文本：https/localhost 用 Clipboard API，纯 http 的 IP 访问回退到 execCommand（否则会静默失败） */
  function copyText(text) {
    return new Promise((resolve) => {
      const fallback = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
          document.body.appendChild(ta);
          ta.select();
          ta.setSelectionRange(0, text.length);
          const ok = document.execCommand('copy');
          ta.remove();
          resolve(ok);
        } catch (e) { resolve(false); }
      };
      if (navigator.clipboard && window.isSecureContext && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => resolve(true), fallback);
      } else fallback();
    });
  }

  function installInviteCopy() {
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn) return;
      const label = btn.querySelector('.btn__label') || btn;
      if (!/复制链接|已复制|复制失败/.test(label.textContent || '')) return;
      const s = window.__SP__ && window.__SP__.store.get();
      if (!s || !s.room) return;
      e.preventDefault();
      e.stopPropagation();
      const link = `${location.origin}/?room=${encodeURIComponent(s.room.code)}`;
      const who = (s.me && s.me.name) || '博士';
      const MODE = { FUNNY: '标准模拟', NORMAL: '险境模拟', HARD: '绝境模拟', ABYSS: '终极模拟' };
      const mode = MODE[s.room.difficulty] || '同盟模拟';
      const text = `${link} ${who}邀请你加入卫戍协议：盟约【${mode}】`;
      const old = label.textContent;
      copyText(text).then((ok) => {
        label.textContent = ok ? '已复制邀请链接' : '复制失败';
        setTimeout(() => { label.textContent = old; }, 1400);
        if (!ok) window.prompt('复制这段邀请链接发给队友：', link);
      });
    }, true);
  }

  // ---------------------------------------------------------------- 房间里的「匹配」按钮 + 搜寻界面

  function roomUi(sp) {
    const { store } = sp;
    if (!document.getElementById('mm-room-tip-css')) {
      const st = document.createElement('style');
      st.id = 'mm-room-tip-css';
      st.textContent = `.mm-room-tip{display:none}
#mm-room-anchor:not(.is-tip-off):hover>.mm-room-tip,#mm-room-anchor:not(.is-tip-off):focus-within>.mm-room-tip{display:block!important}`;
      document.head.appendChild(st);
    }
    let queued = false, matched = false, polling = false, entering = false;
    let lastPartyRoomCode = '';
    let enteringAt = 0, lastCode = '';
    let startedAt = 0, tipIndex = 0, timerId = null, tipId = null;
    // 自动开局流程进行中先别显示「匹配队友」，对局开始后（或超时）恢复；对局结束后回到房间能再次匹配
    let autoArmed = AUTO_START;
    const autoArmedUntil = Date.now() + 90_000;

    const stopTimers = () => { clearInterval(timerId); clearInterval(tipId); timerId = null; tipId = null; };

    const ensureButton = () => {
      const s = store.get();
      const room = s.room;
      if (s.match && s.match.public) autoArmed = false;
      if (Date.now() > autoArmedUntil) autoArmed = false;
      // 只按房间状态判断：对局结束后 store 里的 match 可能还残留，不能拿它当「正在对局」
      const inMatch = !!(room && room.inMatch);
      const full = seatsOf(room) >= (Number(room && room.capacity) || 4); // exp8-exp
      const isHost = !!room && room.hostId === s.me.playerId;
      const humans = (room && room.seats || []).filter((x) => x && !x.isBot);
      const others = humans.filter((x) => x.playerId !== (room && room.hostId));
      const allReady = others.every((x) => x.ready && x.connected !== false);
      // 观战者（含隐身观战）没有席位、不能匹配/开始，不该看到「匹配队友」按钮。
      // 以前只看 inMatch/full，观战时按钮仍会出现并飘到错误位置（玩家反馈）。
      const myId = s.me && s.me.playerId;
      const isSpectator = !!room && myId != null
        && ((room.spectators || []).some((x) => x && x.playerId === myId)
          || (typeof room.hostId === 'string' && room.hostId !== myId
            && !(room.seats || []).some((x) => x && x.playerId === myId)));
      // 每个同盟房间都显示「匹配队友」，但只有房主可以点（其余人置灰）
      const show = !!room && !inMatch && !full && !autoArmed && !isSpectator;
      let el = document.getElementById('mm-room-btn');
      if (!show) { if (el) el.remove(); return; }
      if (!el || !document.body.contains(el)) {
        const anchor = document.createElement('span');
        anchor.id = 'mm-room-anchor';
        anchor.className = 'tt-anchor';
        anchor.style.cssText = 'margin-right:10px';
        const bar = document.querySelector('.room-bar');
        if (!bar) return;
        // 与「开始模拟」同款：proto-start 的结构是 mark(图标/字样) + label(主文字) + deco(斜纹)。
        // 直接克隆会把旧文案残留在 mark 里，所以按结构重建一遍。
        const startBtn = [...bar.querySelectorAll('button')]
          .find((b) => /开始模拟|准备就绪|已就绪/.test(b.textContent || '') && b.offsetParent);
        const b = document.createElement('button');
        b.type = 'button';
        b.id = 'mm-room-btn';
        b.className = startBtn ? startBtn.className.replace(/\bis-ready\b/g, '').trim() : 'proto-start rs-go';
        b.setAttribute('aria-busy', 'false');
        // 左侧标记块：沿用开始模拟的 [城堡] + STRONGHOLD PROTOCOL
        const mark = startBtn ? startBtn.querySelector('.proto-start__mark') : null;
        if (mark) {
          b.appendChild(mark.cloneNode(true));
        } else {
          const m = document.createElement('span');
          m.className = 'proto-start__mark';
          m.setAttribute('aria-hidden', 'true');
          b.appendChild(m);
        }
        const label = document.createElement('span');
        label.className = 'proto-start__label';
        label.textContent = '匹配队友';
        b.appendChild(label);
        const deco = document.createElement('span');
        deco.className = 'proto-start__deco';
        deco.setAttribute('aria-hidden', 'true');
        b.appendChild(deco);
        anchor.appendChild(b);
        // 放在右侧「开始模拟」按钮左边（与它成对）。
        // 观战/非房主时没有「开始模拟」，退而找右侧栏的其它按钮（观战中 / 取消观战等），
        // 否则会 bar.appendChild 到最左端，按钮飘到屏幕角落（玩家反馈的位置不对）。
        const action = [...bar.querySelectorAll('button')].find((b2) => /开始模拟|准备就绪|已就绪/.test(b2.textContent || ''));
        const rightAction = action || [...bar.querySelectorAll('button')]
          .find((b2) => /观战中|取消观战|离开观战/.test(b2.textContent || ''));
        const target = rightAction ? (rightAction.closest('.tt-anchor') || rightAction) : null;
        if (target) target.parentElement.insertBefore(anchor, target);
        else {
          // 兜底：放进右下角的按钮容器，而不是裸 append 到 bar
          const right = bar.querySelector('.rs-foot__right, .room-bar__right');
          if (right) right.insertBefore(anchor, right.firstChild);
          else bar.appendChild(anchor);
        }
        el = document.getElementById('mm-room-btn');
        el.addEventListener('click', onClick);
      }
      // 同步开始模拟按钮的样式（主按钮、同尺寸）
      try {
        const startBtn = [...document.querySelectorAll('button')].find((b) => /开始模拟|准备就绪|已就绪/.test(b.textContent || '') && b.offsetParent);
        if (startBtn && startBtn.className) {
          el.className = startBtn.className.replace(/\bis-ready\b/g, '').trim();
          el.id = 'mm-room-btn';
        }
      } catch { /* ignore */ }
      const mmLabel = el.querySelector('.proto-start__label, .btn__label');
      if (mmLabel) mmLabel.textContent = matched ? '正在分配…' : queued ? '取消匹配' : '匹配队友';
      else el.textContent = matched ? '正在分配…' : queued ? '取消匹配' : '匹配队友';
      // 旧结构（只有文字、没有 mark/deco）就地补齐，避免一直显示成空白底板
      if (!el.querySelector('.proto-start__mark')) {
        const startBtn0 = [...document.querySelectorAll('button')].find((x) => /开始模拟|准备就绪|已就绪/.test(x.textContent || ''));
        const mark0 = startBtn0 && startBtn0.querySelector('.proto-start__mark');
        if (mark0 && mmLabel && mmLabel.parentElement === el) el.insertBefore(mark0.cloneNode(true), mmLabel);
      }
      if (!el.querySelector('.proto-start__deco')) {
        const d = document.createElement('span');
        d.className = 'proto-start__deco';
        d.setAttribute('aria-hidden', 'true');
        el.appendChild(d);
      }
      const hasBot = (room && (room.seats || []).some((x) => x && x.isBot)) === true;
      // 管理员/服主无视「匹配队友」维护开关（服务端 matchmaking 分支同样按 session.admin 放行）。
      // 角色变量是账号接口异步写入的，这里每次渲染都重新读，令牌晚到也能正确解锁。
      const gateAdmin = (() => {
        try {
          const r = window.__SP_ACCOUNT_ROLE;
          if (r && r !== 'player') return true;
          if (typeof window.__SP_ADMIN_TOKEN === 'string' && window.__SP_ADMIN_TOKEN.length > 0) return true;
          return false;
        } catch { return false; }
      })();
      const matchBlocked = GATE.match === false && !gateAdmin;
      el.disabled = matched || !isHost || hasBot || !allReady || matchBlocked;
      let tipText = '';
      if (matchBlocked) tipText = '维护中，暂时无法匹配队友';
      else if (hasBot) tipText = '房间内有 AI 队友，无法匹配（请先移除 AI 队友）';
      else if (!isHost) tipText = '仅房主可以发起匹配';
      else if (!allReady) tipText = '仍有博士未准备就绪';
      // Same hover/focus hint style as the start button. A disabled button still lets
      // its .tt-anchor parent receive hover, so the hint stays readable.
      let tip = el.parentElement && el.parentElement.querySelector('.mm-room-tip');
      if (!tip && el.parentElement) {
        tip = document.createElement('span');
        tip.className = 'mm-room-tip';
        tip.setAttribute('role', 'tooltip');
        // 与 0.3.3 原生 .tooltip 同款：深色底、左侧薄荷竖条、直角、同字号与投影，
        // 不再用早期自绘的圆角小气泡。
        tip.style.cssText = 'position:absolute;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%);z-index:60;'
          + 'display:none;max-width:min(320px,60vw);padding:6px 9px;border:1px solid var(--line-2,rgba(255,255,255,.14));'
          + 'border-left:2px solid var(--mint-500,#5ee0b9);border-radius:0;'
          + 'background:rgba(10,13,12,.97);color:var(--text-md,#cfe9e0);'
          + 'font-size:calc(.15 * var(--t,11px));line-height:1.55;letter-spacing:0;'
          + 'white-space:normal;text-align:center;pointer-events:none;box-shadow:0 .06rem .2rem rgba(0,0,0,.55)';
        el.parentElement.style.position = 'relative';
        el.parentElement.appendChild(tip);
      }
      if (tip) {
        tip.textContent = tipText;
        tip.style.display = '';
        if (el.parentElement) el.parentElement.classList.toggle('is-tip-off', !tipText || matched || queued);
      }
      el.title = '';
    };

    const onClick = async () => {
      const s = store.get();
      const room = s.room;
      if (!room || room.hostId !== s.me.playerId) return;
      const others = (room.seats || []).filter((x) => x && !x.isBot && x.playerId !== room.hostId);
      if (others.some((x) => !x.ready || x.connected === false)) return;
      try {
        if (!queued) {
          const r = await api('/mm/api/party/join', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ guest: !window.__SP_ACCOUNT_USER,
              roomCode: room.code, node: nodeOf(), difficulty: room.difficulty,
              size: Math.max(1, seatsOf(room)), capacity: Number(room.capacity) || 4, clientId: CLIENT_ID,
              // 本服：上报房间的游戏版本，匹配只会在同版本之间成局
              version: room.version || undefined,
            }),
          });
          if (r.error) { showStyledToast(r.error, 'warn'); return; }
          // Do not leave the party queued if the node refuses matchmaking because a
          // teammate is not ready.
          try { await sp.net.request('room.matchmaking', { on: true }); }
          catch (e) {
            try { await api('/mm/api/party/leave', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roomCode: room.code, node: nodeOf(), clientId: CLIENT_ID }) }); } catch { /* ignore */ }
            showStyledToast((e && (e.message || e.msg)) || '所有队友准备后才能匹配队友', 'warn');
            return;
          }
          queued = true;
          showSearch(room.difficulty, r.state && r.state.waiting, true);
        } else {
          await api('/mm/api/party/leave', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ roomCode: room.code, node: nodeOf(), clientId: CLIENT_ID }),
          });
          queued = false;
          try { await sp.net.request('room.matchmaking', { on: false }); } catch { /* ignore */ }
          hideOverlay();
        }
      } catch (e) {
        // 取消时出错也先把界面收起来（下一轮轮询会纠正真实状态），避免弹出让人卡住的对话框
        if (queued) {
          queued = false; hideOverlay();
          try { await sp.net.request('room.matchmaking', { on: false }); } catch { /* ignore */ }
        } else { showStyledToast((e && (e.message || e.msg)) || '匹配队友失败，请稍后再试', 'warn'); }
      }
      ensureButton();
    };

    const tick = async () => {
      installModeHint();
      ensureButton();
      const s = store.get();
      const room = s.room;
      // 地址栏只保留域名：房间码 / 节点 / 代号这些参数处理完就清掉
      if (room && (location.search.includes('room=') || location.search.includes('n=') || location.search.includes('name='))) {
        if (!ADMIN_WATCH) cleanUrl();
      }
      // 房号留一份：成局后 room 可能被替换 / 清空，仍要按原房号继续拿 matched 状态
      if (room && room.code) lastCode = room.code;
      const code = (room && room.code) || lastCode;
      // A new room must not inherit the previous match's "正在分配…" state.
      if (code !== lastPartyRoomCode) {
        lastPartyRoomCode = code;
        queued = false; matched = false; entering = false;
        try { hideOverlay(); } catch { /* ignore */ }
        ensureButton();
      }
      if (room && room.inMatch) {
        // 5 分钟超时由节点直接开局：收起搜寻面板，进入对局
        if (queued || matched) { queued = false; matched = false; hideOverlay(); }
        return;
      }
      if (!code || polling) return;
      // matched 之后席位数量可能变化，但还要继续拿房间码用于跳转，不能因「满员」提前停下
      // ★ 用房间自己的容量，不能写死 4：5–20 人房按真实人数判断，
      //   否则 8 人房坐到 4 人就不再轮询状态，匹配成功后也永远拿不到结果、卡在搜寻界面。
      if (!matched && seatsOf(room) >= (Number(room?.capacity) || 4)) return;
      // 房间里有 AI 队友时不参与匹配（AI 无法跨节点加入）
      if ((room && room.seats || []).some((x) => x && x.isBot)) {
        if (queued) {
          queued = false; matched = false; hideOverlay();
          try { await sp.net.request('room.matchmaking', { on: false }); } catch { /* ignore */ }
        }
        ensureButton();
        return;
      }
      polling = true;
      try {
        const st = await api(`/mm/api/party/state?code=${encodeURIComponent(code)}&node=${nodeOf()}&client=${encodeURIComponent(CLIENT_ID)}`);
        if (st.state === 'queued') {
          if (!queued) { queued = true; showSearch(room.difficulty, st.waiting, room.hostId === s.me.playerId); }
          updateSearch(st.waiting);
          ensureButton();
        } else if (st.state === 'matched') {
          queued = false;
          matched = true;
          ensureButton();
          // 搜索结果面板只画一次，避免每轮轮询重画导致闪烁
          if (!document.getElementById('mm-ov-foundsub')) showFound(st.leader ? '正在创建对局…' : '正在连接游戏节点…');
          // 补偿触发：轮询还在跑 = 页面还没跳走。只要拿到领队身份或房间码，
          // 每轮都重试一次 enterParty；跳转超过 4 秒还没发生（pin 失败 / 被拦）就解锁重试。
          if (entering && Date.now() - enteringAt > 4000) entering = false;
          if (!entering && (st.leader || st.code)) {
            entering = true;
            enteringAt = Date.now();
            console.info('[mm-debug] party matched → enterParty', { leader: !!st.leader, code: st.code || null, node: st.node });
            enterParty(st).then((ok) => { if (!ok) entering = false; });
          }
        } else if (st.state === 'idle' && (queued || matched)) {
          queued = false;
          matched = false;
          entering = false;
          hideOverlay();
          try { await sp.net.request('room.matchmaking', { on: false }); } catch { /* ignore */ }
          ensureButton();
        }
      } catch (e) { /* 下轮再试 */ } finally { polling = false; }
    };

    const showSearch = (difficulty, waiting, canCancel) => {
      const d = DIFF_NAMES[difficulty] || '险境模拟';
      const color = DIFF_COLORS[difficulty] || '#e85a1a';
      if (!document.getElementById('mm-overlay')) {
        const ov = document.createElement('div');
        ov.id = 'mm-overlay';
        ov.className = 'mm-ov';
        ov.innerHTML = `
          <div class="mm-ov__panel" id="mm-ov-panel">
            <div class="mm-ov__brand"><span class="mm-ov__rook">[♜]</span>STRONGHOLD PROTOCOL</div>
            <div class="mm-ov__title">搜寻中<span class="mm-ov__dots" id="mm-ov-dots">.</span><small id="mm-ov-clock">(0s)</small></div>
            <div class="mm-ov__tags" id="mm-ov-tags"></div>
            <div class="mm-ov__scene">
              <svg class="mm-ov__scout" viewBox="0 0 240 90" aria-hidden="true">
                <path class="mm-ov__wave" d="M0 58 C30 40 50 76 80 58 S130 40 160 58 S210 76 240 58" />
                <g class="mm-ov__sky"><path d="M10 70h8v-14h6v14h10v-24h6v24h12v-10h6v10h20v-18h4v-6h4v24h18v-12h6v12h10v-20h6v20h14v-8h8v8" />
                  <path d="M130 70h8v-14h6v14h10v-24h6v24h12v-10h6v10h20v-18h4v-6h4v24h18v-12h6v12h10v-20h6v20h14v-8h8v8" /></g>
                <g class="mm-ov__bot"><rect x="104" y="34" width="26" height="22" rx="3" />
                  <rect class="mm-ov__eye" x="110" y="41" width="4" height="5" /><rect class="mm-ov__eye" x="120" y="41" width="4" height="5" />
                  <rect x="114" y="26" width="6" height="8" /><rect x="112" y="22" width="10" height="4" />
                  <rect class="mm-ov__leg" x="108" y="56" width="5" height="7" /><rect class="mm-ov__leg mm-ov__leg--b" x="121" y="56" width="5" height="7" /></g>
                <line class="mm-ov__ground" x1="60" y1="70" x2="180" y2="70" />
                <text x="120" y="84" text-anchor="middle">SCANNING · · ·</text>
              </svg>
            </div>
            <div class="mm-ov__pop">本难度等待队列 <b id="mm-ov-pop">0</b> 人</div>
            <p class="mm-ov__tip" id="mm-ov-tip"></p>
            <button type="button" class="mm-ov__stop" id="mm-ov-stop">停止搜寻</button>
          </div>`;
        document.body.appendChild(ov);
        document.getElementById('mm-ov-stop').addEventListener('click', () => { if (canCancel) onClick(); });
        startedAt = Date.now();
        tipIndex = Math.floor(Math.random() * TIPS.length);
        const tipEl = document.getElementById('mm-ov-tip');
        if (tipEl) tipEl.textContent = TIPS[tipIndex];
        timerId = setInterval(() => {
          const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
          const clock = document.getElementById('mm-ov-clock');
          const dots = document.getElementById('mm-ov-dots');
          if (clock) clock.textContent = `(${s < 60 ? s + 's' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')})`;
          if (dots) dots.textContent = '.'.repeat((s % 3) + 1);
        }, 1000);
        tipId = setInterval(() => { tipIndex += 1; const t = document.getElementById('mm-ov-tip'); if (t) t.textContent = TIPS[tipIndex % TIPS.length]; }, 5000);
      }
      document.getElementById('mm-ov-tags').innerHTML =
        `<span class="mm-ov__tag" style="--c:${color}">${d}</span><span class="mm-ov__tag" style="--c:#4ed8af">4 人 · 不补 AI</span>`;
      document.getElementById('mm-ov-stop').style.display = canCancel ? '' : 'none';
      updateSearch(waiting);
    };

    const updateSearch = (waiting) => {
      const pop = document.getElementById('mm-ov-pop');
      if (pop && Number.isFinite(waiting)) pop.textContent = waiting;
    };

    const showFound = (text) => {
      stopTimers();
      const ov = document.getElementById('mm-overlay');
      if (!ov) return;
      ov.innerHTML = `
        <div class="mm-ov__found">
          <div class="mm-ov__brand"><span class="mm-ov__rook">[♜]</span>STRONGHOLD PROTOCOL</div>
          <svg class="mm-ov__face" viewBox="0 0 64 64" aria-hidden="true">
            <rect x="6" y="8" width="52" height="48" rx="8" /><rect class="mm-ov__faceeye" x="18" y="24" width="7" height="8" />
            <path class="mm-ov__facewink" d="M37 29h10" /><path class="mm-ov__facesmile" d="M22 42q10 7 20 0" />
          </svg>
          <b class="mm-ov__foundtitle">搜寻成功！</b>
          <span class="mm-ov__foundsub" id="mm-ov-foundsub">${text}</span>
        </div>`;
    };

    store.subscribe(() => { clearTimeout(tick._t); tick._t = setTimeout(tick, 60); });
    setInterval(tick, 1200);
    tick();
  }





  // ---------------------------------------------------------------- 重启恢复：返回模拟确认层（第 1 步：纯客户端）


  // ---------------------------------------------------------------- 延迟标签不占高度（保证左上角模块中心一致）

  function alignPingLabel() {
    const hide = (root) => {
      const els = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of els) {
        const txt = (el.textContent || '').trim();
        if (txt !== '当前延迟') continue;
        // 只处理最深的那个节点（避免把整块导航都隐藏）
        let deeper = false;
        for (const c of el.children) if ((c.textContent || '').trim() === txt) { deeper = true; break; }
        if (deeper) continue;
        el.style.display = 'none';
        el.dataset.mmPingHideLabel = '1';
        const parent = el.parentElement;
        if (parent && parent.dataset.mmPingHideLabel !== '1') {
          parent.dataset.mmPingHideLabel = '1';
          parent.style.display = 'flex';
          parent.style.alignItems = 'center';
          parent.style.height = '36px';
          parent.dataset.mmPingAlign = '1';
        }
      }
    };
    hide(document);
    try { new MutationObserver(() => hide(document)).observe(document.body, { childList: true, subtree: true }); } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- 重启回来：提示“上一局已中断”并提供返回同盟

  function installBackToAlliance() {
    const sp = window.__SP__;
    if (!sp || !sp.store || !sp.store.subscribe) return;
    const KEY = 'sp.matchInterrupted';
    const read = () => {
      try {
        const r = JSON.parse(localStorage.getItem(KEY) || 'null');
        return r && typeof r.code === 'string' && Date.now() - Number(r.at || 0) < 30 * 60 * 1000 ? r : null;
      } catch { return null; }
    };
    const clear = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } window.__SP_RESTART_PENDING = false; };
    const matchEndedVisible = () => !!document.querySelector('.awayov:not(#mm-back)');
    const dismissBackIfMatchEnded = () => {
      if (!matchEndedVisible()) return;
      const panel = document.getElementById('mm-back');
      if (panel) panel.remove();
      clear();
    };
    setInterval(dismissBackIfMatchEnded, 300);
    let hadMatch = false;
    let offline = false;
    const mark = (s) => {
      if (!s.room || s.room.inMatch !== true || s.match?.result) return;
      try { localStorage.setItem(KEY, JSON.stringify({ code: s.room.code, at: Date.now() })); } catch { /* ignore */ }
      window.__SP_RESTART_PENDING = true;
    };
    // A reload after a node restart has no in-memory `hadMatch`; the persisted marker is what
    // lets the client still offer 返回同盟 instead of silently starting a fresh match.
    if (read()) window.__SP_RESTART_PENDING = true;
    sp.store.subscribe(() => {
      const s = sp.store.get();
      mark(s);
      if (matchEndedVisible()) { clear(); return; }
      const serverInMatch = s.room && s.room.inMatch === true;
      if (serverInMatch) window.__SP_RESTART_PENDING = false;
      if (s.match && s.match.result) clear();
      const status = s.connection && s.connection.status;
      if (status !== 'online') { offline = true; return; }
      if (!offline) return;
      offline = false;
      if (!hadMatch || !s.room || serverInMatch) return;
      hadMatch = false;
      if (s.match && s.match.result) return;
      window.__SP_RESTART_PENDING = true;
      showBackPanel();
    });
    // Fresh page (reload): wait for room + account rejoin, then offer the interrupted-alliance entry.
    const resumeTick = () => {
      const s = sp.store.get();
      if (!s || !s.session || !s.session.entered) return;
      mark(s);
      if (matchEndedVisible()) { clear(); return; }
      // The client can still hold a stale m.public from before the node stopped; the server's
      // room state is authoritative: inMatch=false means that match is gone.
      if (s.room && s.room.inMatch === true) { window.__SP_RESTART_PENDING = false; return; }
      if (s.match && s.match.result) { clear(); return; }
      const rec = read();
      if (!rec) return;
      // The interrupted room may not have been auto-rejoined yet (there is no sp.lastRoom on a
      // fresh tab). Follow the marker through the account-resume route once.
      if (!s.room) {
        if (s.connection?.status !== 'online') return;
        let tried = '';
        try { tried = sessionStorage.getItem('sp.restartJoin') || ''; } catch { /* ignore */ }
        if (tried !== rec.code) {
          try { sessionStorage.setItem('sp.restartJoin', rec.code); } catch { /* ignore */ }
          location.assign('/r/' + encodeURIComponent(rec.code) + '?accountResume=1');
        }
        return;
      }
      if (s.room.code !== rec.code) return;
      window.__SP_RESTART_PENDING = true;
      showBackPanel();
    };
    setInterval(resumeTick, 1200);
    setTimeout(resumeTick, 1400);
  }

  function showBackPanel() {
    if (document.getElementById('mm-back')) return;
    // The match ended plate already explains that the room returned to its lobby; do not stack
    // the restart panel on top of it.
    if (document.querySelector('.awayov:not(#mm-back)')) return;
    const style = document.createElement('style');
    style.textContent = `#mm-back{z-index:93}`;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = 'mm-back';
    box.className = 'awayov';
    box.innerHTML = '<div class="awayov__box brackets"><span class="micro micro--mint">SIMULATION CLOSED</span><h2>本局模拟已结束</h2><p class="t-lo">服务器重启导致对局中断，同盟已返回等待室</p><button type="button" class="btn btn--primary btn--lg"><span class="btn__icon" aria-hidden="true">‹</span><span class="btn__label">返回同盟</span></button></div>';
    box.querySelector('button').onclick = () => {
      try { localStorage.removeItem('sp.matchInterrupted'); } catch { /* ignore */ }
      window.__SP_RESTART_PENDING = false;
      box.remove();
      // Drop the stale match render as well; the restored room page is the correct view.
      location.reload();
    };


    document.body.appendChild(box);
  }



  // ---------------------------------------------------------------- 重启后自动回到上次的房间（会话丢失时兜底）

  function installAutoRejoin() {
    // 匹配转场期间不能自动回旧房间：房主要新建房间（否则会把旧房号当成新房间回报），
    // 客人要加入匹配到的房间（否则会先回旧房，joinFlow 看到已有房间就不再加入目标房）。
    if (IS_HOST && PMID && PCID) return;
    if (ROOM) return;
    try {
      const qs = new URLSearchParams(location.search);
      if (qs.get('adminWatch') === '1' || qs.get('watchGuest') === '1' || qs.get('watchToken')
        || sessionStorage.getItem('sp_admin_watch_code') || localStorage.getItem('sp_admin_watch_code')) return;
    } catch { /* ignore */ }
    const sp = window.__SP__;
    if (!sp || !sp.store || !sp.store.subscribe || !sp.net) return;
    const KEY = 'sp.lastRoom';
    let tried = false;
    // 记录最近所在房间
    sp.store.subscribe((s) => {
      try {
        if (s.room && s.room.code) localStorage.setItem(KEY, JSON.stringify({ code: s.room.code, at: Date.now() }));
        if (!s.room && !s.match.public) { /* 保留 30 分钟 */ }
      } catch { /* ignore */ }
    });
    const tick = () => {
      if (tried) return;
      if (watchExitRecent()) { tried = true; return; }
      const s = sp.store.get();
      if (!s || !s.session || !s.session.entered) return;
      if (s.room) { tried = true; return; }
      if (!sp.net || sp.net.status !== 'online') return;
      let rec = null;
      try { rec = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* ignore */ }
      if (!rec || !rec.code) { tried = true; return; }
      if (Date.now() - (rec.at || 0) > 30 * 60 * 1000) { tried = true; return; }
      tried = true;
      try { sp.net.request('room.join', { code: rec.code }).catch(() => {}); } catch { /* ignore */ }
    };
    setInterval(tick, 1500);
    setTimeout(tick, 1200);
  }


  // ---------------------------------------------------------------- 实验性功能（插件）面板：玩家自行开关




  // ---------------------------------------------------------------- 建房参数注入（实验性功能）



  // ---------------------------------------------------------------- 房间右上角：15 分钟开始倒计时

  function installRoomCountdown() {
    if (window.__mmTimerInstalled) return;
    window.__mmTimerInstalled = true;
    const sp = window.__SP__;
    if (!sp || !sp.store || !sp.store.subscribe) return;
    let LIMIT = 15 * 60 * 1000;
    // 同盟解散时间由后台配置（分钟），每 60 秒同步一次
    const syncTtl = async () => {
      try {
        const r = await fetch('/mm/api/room-ttl', { cache: 'no-store' });
        const j = await r.json();
        const m = Number(j.minutes);
        if (Number.isFinite(m) && m >= 1 && m <= 1440) { LIMIT = Math.round(m * 60000); window.__mmTtlMs = LIMIT; }
      } catch { /* ignore */ }
    };
    syncTtl(); setInterval(syncTtl, 5000);
    const fallbackCreated = new Map();
    let srvSkew = 0;
    let srvSeen = null;
    let fontProbe = null;

    const tick = () => {
      const s = sp.store.get();
      const room = s.room;
      if (!room || (s.match && s.match.public)) {
        const dead = document.getElementById('mm-room-timer');
        if (dead) dead.remove();
        return;
      }
      // 用服务器时间换算偏移，避免本机与服务器时钟不一致导致提前/延后解散
      const srvNow = Number(room.serverNow) || 0;
      if (srvNow && srvSeen !== srvNow) { srvSeen = srvNow; srvSkew = srvNow - Date.now(); }
      let createdAt = Number(room.createdAt) || 0;
      if (!createdAt) {
        const code = room.code || '(none)';
        if (!fallbackCreated.has(code)) fallbackCreated.set(code, Date.now());
        createdAt = fallbackCreated.get(code);
      }
      if (createdAt > Date.now()) createdAt = Date.now();
      const adminRoom = room.noExpire === true;
      const lim = Number(room.ttlMs) > 0 ? Number(room.ttlMs) : LIMIT;
      const left = Math.max(0, Math.min(lim, createdAt + lim - (Date.now() + srvSkew)));
      const mm = Math.floor(left / 60000);
      const ss = Math.floor((left % 60000) / 1000);
      const timeText = adminRoom ? '∞' : String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');

      // 每次都按 id 取，避免引用被移除的旧节点
      let box = document.getElementById('mm-room-timer');
      if (!box) {
        box = document.createElement('div');
        box.id = 'mm-room-timer';
        box.className = 'mm-room-timer';
        document.body.appendChild(box);
      }
      // 字号取自新版房间顶栏的密钥样式（.rs-key__code / .rs-key__k），取不到就用兜底值
      const keyFontSizes = () => {
        const codeEl = document.querySelector('.rs-key__code');
        const labelEl = document.querySelector('.rs-key__k');
        const cs = codeEl ? getComputedStyle(codeEl) : null;
        const ls = labelEl ? getComputedStyle(labelEl) : null;
        return {
          codeSize: cs ? cs.fontSize : 'calc(.2 * var(--t, 11px))',
          codeFamily: cs ? cs.fontFamily : 'var(--font-num, monospace)',
          codeWeight: cs ? cs.fontWeight : '700',
          labelSize: ls ? ls.fontSize : 'calc(.14 * var(--t, 11px))',
        };
      };
      const solo = !!document.querySelector('.solo-note');
      box.innerHTML = '<span class="mm-timer-time">' + timeText + '</span>'
        + '<span class="mm-timer-label">' + (adminRoom ? '管理员房 · 不自动销毁' : solo ? '后独立模拟将自动销毁' : '后同盟将自动销毁') + '</span>';

      // 干员调配 / 干员持有 / 自选编队 等全屏面板打开时隐藏倒计时
      try {
        const loadoutOpen = [...document.querySelectorAll('button,[role="tab"]')]
          .some((b) => b.offsetParent && /自选编队|干员持有/.test((b.textContent || '').trim()));
        if (loadoutOpen) { box.style.display = 'none'; return; }
        box.style.display = 'flex';
      } catch { /* ignore */ }

      // 与新版界面一致：作为房间顶栏右侧的一格，排在「干员调配」左边，
      // 不再用绝对定位硬算坐标。
      const rightBar = document.querySelector('.room-screen .rs-top__right');
      if (!rightBar) {
        box.style.position = 'fixed';
        box.style.left = '50%';
        box.style.top = '12px';
        box.style.transform = 'translateX(-50%)';
        box.style.display = 'flex';
        return;
      }
      box.style.position = 'static';
      box.style.left = 'auto';
      box.style.top = 'auto';
      box.style.right = 'auto';
      box.style.transform = 'none';
      box.style.zIndex = 'auto';
      box.style.width = 'auto';
      box.style.height = 'auto';
      box.style.flexDirection = 'column';
      box.style.alignItems = 'center';
      box.style.justifyContent = 'center';
      box.style.gap = '2px';
      box.style.padding = '.06rem .14rem';
      box.style.boxSizing = 'border-box';
      box.style.overflow = 'hidden';
      box.style.flex = 'none';
      box.style.background = 'rgba(0, 0, 0, .3)';
      box.style.border = '1px solid var(--line-2, rgba(255,255,255,.16))';
      box.style.borderRadius = '0';
      const loadoutBtn = rightBar.querySelector('.rs-loadout, .room-loadout, .hub-plate--loadout');
      if (loadoutBtn) {
        if (box.parentElement !== rightBar || box.nextElementSibling !== loadoutBtn) {
          rightBar.insertBefore(box, loadoutBtn);
        }
        // 与「干员调配」等高，视觉上成一组
        try {
          const lh = loadoutBtn.getBoundingClientRect().height;
          if (lh > 0) box.style.height = Math.round(lh) + 'px';
        } catch { /* ignore */ }
      } else if (box.parentElement !== rightBar) {
        rightBar.insertBefore(box, rightBar.firstElementChild);
      }
      box.style.display = 'flex';
      try {
        const fs2 = keyFontSizes();
        const tEl = box.querySelector('.mm-timer-time');
        const lEl = box.querySelector('.mm-timer-label');
        if (tEl) { tEl.style.fontSize = fs2.codeSize; tEl.style.fontFamily = fs2.codeFamily; tEl.style.fontWeight = fs2.codeWeight; tEl.style.whiteSpace = 'nowrap'; }
        if (lEl) { lEl.style.fontSize = fs2.labelSize; lEl.style.whiteSpace = 'nowrap'; }
      } catch { /* ignore */ }
    };

    sp.store.subscribe(tick);
    setInterval(tick, 200);
    setTimeout(tick, 50);
    setTimeout(tick, 300);
    window.addEventListener('resize', tick);
    document.addEventListener('click', tick, true);
    tick();
  }



  // ---------------------------------------------------------------- 实验性：复活的简易操作条

  function installRevivalControl() {
    if (window.__mmRevivalInstalled) return;
    window.__mmRevivalInstalled = true;
    const ensure = () => {
      const sp = window.__SP__;
      const s = sp?.store?.get?.();
      const pub = s?.match?.public;
      const me = pub?.players?.find((p) => p.playerId === s?.me?.playerId);
      const target = pub?.players?.find((p) => p.pendingDeath && !p.alive && p.playerId !== me?.playerId);
      let box = document.getElementById('mm-revival');
      const can = !!(pub?.revival?.enabled && pub.revival.windowOpen && me && me.alive && me.lp >= 11
        && pub.revival.eligible?.includes(me.playerId) && target);
      if (!can) { if (box) box.remove(); return; }
      if (!box) {
        box = document.createElement('div');
        box.id = 'mm-revival';
        box.style.cssText = 'position:fixed;right:24px;bottom:118px;z-index:2147482100;display:flex;flex-direction:column;' +
          'gap:5px;padding:10px 12px;border:1px solid #d5a24a;background:rgba(24,18,8,.96);color:#f4dfb0;' +
          'font:600 12px "Noto Sans SC",system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35)';
        document.body.appendChild(box);
      }
      box.innerHTML = '<span style="color:#f0c674">联防救援窗口</span>' +
        '<button type="button" style="height:26px;padding:0 12px;border:1px solid #d5a24a;border-radius:2px;' +
        'background:#3b2a12;color:#ffe1a2;font:700 11px inherit;cursor:pointer">复活 ' +
        String(target.name || '队友').replace(/[<>&]/g, '') + ' · −10</button>';
      box.querySelector('button').onclick = async () => {
        const btn = box.querySelector('button');
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await sp.net.request('g.revive', { playerId: target.playerId, round: pub.round, matchId: pub.revival.matchId });
        } catch { /* the next state refresh explains */ }
        btn.disabled = false;
      };
    };
    ensure();
    setInterval(ensure, 500);
  }

  // ---------------------------------------------------------------- 实验性：房间规则面板

  function installExperimentalPanel() {
    if (window.__mmExperimentalInstalled) return;
    window.__mmExperimentalInstalled = true;
    const role = window.__SP_ACCOUNT_ROLE;
    if (!role || role === 'player') return;
    const ensure = () => {
      const sp = window.__SP__;
      const s = sp?.store?.get?.();
      const room = s?.room;
      const host = room && room.hostId === s?.me?.playerId && !room.inMatch;
      const existing = document.getElementById('mm-exp');
      if (!host) { if (existing) existing.remove(); return; }
      if (existing) return;
      const box = document.createElement('div');
      box.id = 'mm-exp';
      box.style.cssText = 'position:fixed;left:18px;bottom:150px;z-index:2147482000;font:600 11px "Noto Sans SC",system-ui,sans-serif;' +
        'background:rgba(5,16,13,.97);border:1px solid #2f7d66;color:#cfe9e0;padding:8px 10px;min-width:190px';
      box.innerHTML = '<div style="color:#7ff0cf;margin-bottom:6px">实验性房间</div>' +
        '<label style="display:flex;justify-content:space-between;gap:8px;margin:3px 0">人数' +
        '<select data-k="capacity" style="background:#07110e;color:#cfe9e0;border:1px solid #2f4a4f">' +
        '<option value="4">4</option><option value="8">8</option><option value="12">12</option><option value="16">16</option><option value="20">20</option></select></label>' +
        '<label style="display:flex;justify-content:space-between;gap:8px;margin:3px 0">复活<input data-k="revivalEnabled" type="checkbox"></label>' +
        '<label style="display:flex;justify-content:space-between;gap:8px;margin:3px 0">独立卡池<input data-k="disableSharedPool" type="checkbox"></label>' +
        '<label style="display:flex;justify-content:space-between;gap:8px;margin:3px 0">禁用鸭爵<input data-k="disableDuckLord" type="checkbox"></label>' +
        '<button type="button" style="margin-top:6px;width:100%;height:24px;border:1px solid #7ff0cf;background:#35c79b;color:#061611;font:700 11px inherit;cursor:pointer">应用</button>';
      document.body.appendChild(box);
      const sync = () => {
        const e = room.experimental || {};
        box.querySelector('[data-k="capacity"]').value = String(room.capacity || (e.playerCapacity || 4));
        box.querySelector('[data-k="revivalEnabled"]').checked = e.revivalEnabled === true;
        box.querySelector('[data-k="disableSharedPool"]').checked = e.disableSharedPool === true;
        box.querySelector('[data-k="disableDuckLord"]').checked = e.disableDuckLord === true;
      };
      sync();
      box.querySelector('button').onclick = async () => {
        const cap = Number(box.querySelector('[data-k="capacity"]').value);
        const experimental = {
          revivalEnabled: box.querySelector('[data-k="revivalEnabled"]').checked,
          disableSharedPool: box.querySelector('[data-k="disableSharedPool"]').checked,
          ...(cap > 4 ? { playerCapacity: cap } : {}),
          ...(cap > 4 && box.querySelector('[data-k="disableDuckLord"]').checked ? { disableDuckLord: true } : {}),
        };
        try { await sp.net.request('room.setExperimental', { experimental }); } catch { /* next state explains */ }
      };
    };
    ensure();
    setInterval(ensure, 1000);
  }

  // ---------------------------------------------------------------- 统一风格（与游戏内 UI 一致）

  function installUnifiedStyle() {
    if (document.getElementById('mm-style')) return;
    const s = document.createElement('style');
    s.id = 'mm-style';
    s.textContent = `
      :root{
        --mm-mint:#4ed8af; --mm-mint2:#7ff0cf;
        --mm-bg:#0b1316; --mm-panel:#0d1619;
        --mm-line:rgba(78,216,175,.30);
        --mm-text:#cfe9e0; --mm-dim:#7d9a92;
      }
@media (max-width:1300px){
  .room-bar__center{min-width:0}
  .room-bar__status{white-space:nowrap}
}
/* 空间不足时只压缩右侧按钮，文字仍保持整体居中 */
/* 就绪文字不换行，空间不够时整体缩放而不是断行 */
/* 窄屏时等比缩小文字，但保持整体居中 */
@media (max-width:1600px){
  .ready-count{font-size:calc(.18 * var(--t))}
  .ready-count .num{font-size:calc(.22 * var(--t))}
  .room-bar__status{font-size:calc(.14 * var(--t));white-space:nowrap}
}
@media (max-width:1300px){
  .ready-count{font-size:calc(.16 * var(--t))}
  .ready-count .num{font-size:calc(.2 * var(--t))}
  .room-bar__status{font-size:calc(.13 * var(--t))}
}
/* room-bar 自适应：界面变窄时按钮缩小，给中间文字留位置 */
@media (max-width:1700px){
  .room-bar__right .btn{font-size:calc(.16 * var(--t));padding-inline:.14rem}
  .room-bar__right .btn .btn__label{font-size:calc(.17 * var(--t))}
  .room-bar__center{font-size:calc(.16 * var(--t))}
}
@media (max-width:1450px){
  .room-bar{padding:0 .3rem;gap:.18rem}
  .room-bar__right .btn{font-size:calc(.15 * var(--t));padding-inline:.1rem}
  .room-bar__right .btn .btn__label{font-size:calc(.15 * var(--t))}
  .room-bar__center{font-size:calc(.15 * var(--t))}
  .room-bar__status{font-size:calc(.13 * var(--t))}
}
/* 底栏文字随界面缩放 */
.room-bar__center{font-size:calc(.18 * var(--t))}
.ready-count{font-size:calc(.2 * var(--t))}
.ready-count .num{font-size:calc(.24 * var(--t))}
.room-bar__status{font-size:calc(.16 * var(--t))}
/* 匹配队友按钮：紧凑一些，避免挤压底栏文字 */
#mm-room-anchor{margin:0 .12rem}
/* 节点角标 */
      #mm-nodes:not(.topbar) .chip{
  display:inline-flex; align-items:center; justify-content:center; gap:.05rem;
  height:.32rem; padding:0 .14rem 0 .11rem; border-radius:99px;
  background:rgba(0,0,0,.5); border:1px solid var(--line);
  color:var(--text-hi); font:calc(.16 * var(--t))/1 "Noto Sans SC",system-ui,sans-serif;
  cursor:pointer; user-select:none; white-space:nowrap;
}
#mm-nodes .chip .num{color:var(--mint-400);font-family:var(--font-num);font-weight:700;font-variant-numeric:tabular-nums}
      #mm-nodes.topbar{gap:0!important}
      #mm-nodes.topbar .chip{color:#ffffff}
      #mm-nodes.topbar .chip .num{color:var(--mint-400)}
      #mm-nodes .chip b{color:var(--mm-mint2)}
      #mm-nodes .panel{
        background:rgba(10,18,20,.97); border:1px solid var(--mm-line); border-radius:8px;
        color:var(--mm-text); box-shadow:0 12px 32px rgba(0,0,0,.55);
        font:12px/1.6 "Noto Sans SC",system-ui,sans-serif;
      }
      #mm-nodes .head{color:var(--mm-dim); border-bottom:1px solid rgba(78,216,175,.15)}
      #mm-nodes .row{border-bottom:1px solid rgba(78,216,175,.07)}
      #mm-nodes .row span{color:var(--mm-dim)}
      #mm-nodes .row i{background:var(--mm-mint)}
      #mm-nodes[data-state=busy] .row i,#mm-nodes[data-state=busy] .chip i{background:#e8b25a}
      #mm-nodes[data-state=down] .row i,#mm-nodes[data-state=down] .chip i{background:#d9534f}

      /* 账号面板 */
      #mm-acc .card{
        background:linear-gradient(180deg,#0e181b,#0a1113);
        border:1px solid var(--mm-line); border-radius:10px;
        box-shadow:0 16px 48px rgba(0,0,0,.65);
        color:var(--mm-text); padding:22px 24px;
      }
      #mm-acc h3{color:var(--mm-mint2); letter-spacing:2px; font-weight:600; margin-bottom:16px}
      #mm-acc input{
        background:#0a1214; border:1px solid rgba(78,216,175,.22); border-radius:6px;
        color:var(--mm-text); padding:9px 12px; font-size:14px;
      }
      #mm-acc input::placeholder{color:#5d7a72}
      #mm-acc input:focus{outline:none; border-color:var(--mm-mint)}
      #mm-acc .tabs button{
        background:transparent; border:1px solid var(--mm-line); color:var(--mm-dim);
        border-radius:6px; padding:8px 12px; font-size:14px;
      }
      #mm-acc .tabs button.on{background:rgba(78,216,175,.14); border-color:var(--mm-mint); color:var(--mm-mint2)}
      #mm-acc button{
        background:transparent; border:1px solid var(--mm-line); color:var(--mm-text);
        border-radius:6px; padding:9px 14px; font-size:14px; cursor:pointer;
      }
      #mm-acc button:hover{border-color:var(--mm-mint); color:var(--mm-mint2)}
      #mm-acc button[data-a="go"]{
        width:100%; margin-top:14px; background:var(--mm-mint); border:1px solid var(--mm-mint);
        color:#062018; font-weight:700; letter-spacing:2px;
      }
      #mm-acc button[data-a="go"]:hover{background:var(--mm-mint2); color:#062018}
      #mm-acc .msg{color:#ffb4a8}

      /* 其它弹层统一 */
      #mm-back .card,#mm-update .card,#mm-ended .card{
        background:linear-gradient(180deg,#0e181b,#0a1113);
        border:1px solid var(--mm-line); border-radius:10px; color:var(--mm-text);
        box-shadow:0 16px 48px rgba(0,0,0,.65);
      }
      #mm-back h3,#mm-ended h3,#mm-update h3{color:var(--mm-mint2); letter-spacing:2px}
      #mm-back button,#mm-ended button,#mm-update button{
        background:var(--mm-mint); border:1px solid var(--mm-mint); color:#062018; font-weight:700;
        border-radius:6px; padding:9px 18px;
      }
      #mm-ann{
        background:rgba(10,18,20,.95); border:1px solid var(--mm-line); color:var(--mm-text);
        border-radius:8px; font:13px/1.6 "Noto Sans SC",system-ui,sans-serif;
      }
    `;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- 重启超时：结算面板

  // ---------------------------------------------------------------- 服务器更新公告（每个版本弹一次）



  // ---------------------------------------------------------------- 临时公告


  /* @sp-strip-icp:start */
  // ---------------------------------------------------------------- 官方 QQ 群（右上角）

  // 顶部按钮助手：克隆「统计」按钮的样式与图标位，替换图标路径与文字
  function ensureTopButton(id, label, iconPath, onClick, beforeId, allowLobby) {
    const stat = document.querySelector('button.title-stats')
      || (allowLobby ? [...document.querySelectorAll('button')].find((b) => !b.id.startsWith('mm-') && /S\.W\.E\.E\.P/i.test((b.textContent || '').trim())) : null);
    const existing = document.getElementById(id);
    // 标题页容器还在就不要因为「按钮暂时查不到」而隐藏它：页面渲染中途 stat 可能短暂缺失，
    // 这一隐藏/恢复就是右上角闪一下的来源。
    if (!stat && !document.querySelector('.title-screen')) { if (existing) existing.style.display = 'none'; return null; }
    if (!stat && existing && existing.isConnected) return existing;
    const onTitle = !!document.querySelector('.title-screen');
    const ver = !onTitle ? document.querySelector('.verchip-wrap, button.verchip[data-testid="version-switch"]') : null;
    if (existing) {
      // 只有「结构不对」才重建：有版本按钮时必须套用 verchip 样式。
      // 标题页没有 verchip（ver 为 null），此时按钮用的是另一套外观，
      // 不能再拿 verchip 当判据 —— 否则每轮都判定错误、删掉重建，
      // 表现为右上角公告按钮每 1.2 秒消失再出现。
      const wrongClass = !!ver && !existing.classList.contains('verchip');
      if (!wrongClass) {
        existing.style.display = '';
        // 位置不对就挪过去，不重建
        if (ver) {
          const slot = ver.closest('.verchip-wrap') || ver;
          const parent = slot.parentElement;
          if (parent && existing.parentElement !== parent) {
            const before = beforeId ? document.getElementById(beforeId) : null;
            parent.insertBefore(existing, before && before.parentElement === parent ? before : slot);
          }
        }
        return existing;
      }
      existing.remove();
    }
    let btn;
    if (ver) {
      // 与右上角版本切换按钮（verchip）同款同尺寸，排在版本按钮左侧。
      // beforeId 指定时插到该按钮之前，维持「管理后台 → 公告 → 版本」的顺序。
      const verBtn = ver.matches('button') ? ver : ver.querySelector('button.verchip') || ver;
      btn = verBtn.cloneNode(true);
      btn.id = id;
      btn.type = 'button';
      btn.disabled = false;
      btn.removeAttribute('data-testid');
      btn.removeAttribute('data-version');
      btn.removeAttribute('aria-haspopup');
      btn.removeAttribute('aria-busy');
      btn.className = 'verchip';
      btn.style.marginRight = '';
      btn.replaceChildren();
      // 图标沿用版本按钮自己的那个 svg，保证与相邻按钮同一套描边/尺寸
      const icon = verBtn.querySelector('svg');
      if (icon) {
        const s = icon.cloneNode(true);
        const path = s.querySelector('path');
        if (path) path.setAttribute('d', iconPath);
        btn.appendChild(s);
      }
      const span = document.createElement('span');
      span.className = 'verchip__label';
      span.textContent = label;
      btn.appendChild(span);
      btn.onclick = onClick;
      const slot = ver.closest('.verchip-wrap') || ver;
      const anchor = beforeId ? document.getElementById(beforeId) : null;
      // 首次构建时页面的 Preact 顶栏可能还没渲染出版本按钮；此时先不插，
      // 由下一轮 ensure（1~1.5s 内）插到正确位置，避免先出现在 S.W.E.E.P. 那一列再跳走。
      const place = anchor && anchor.parentElement === slot.parentElement ? anchor : slot;
      if (!place.parentElement || !place.isConnected) return existing || null;
      place.parentElement.insertBefore(btn, place);
      return btn;
    }
    if (!onTitle) {
      // 大厅：按钮必须是 verchip 胶囊并排在右上角版本按钮左侧。
      // 如果版本按钮还没渲染出来（页面刚加载），本轮先不创建，等下一轮再插 ——
      // 否则会被回退逻辑插到右侧的 S.W.E.E.P. 面板里，表现为「刷新后公告按钮跑到右边栏」。
      if (!ver) return existing || null;
      // 大厅：沿用 S.W.E.E.P. 那块浅色按钮的外框/尺寸/内边距，但内容必须整体重建。
      // 直接克隆会把原按钮的图标框（hub-plate__glyph）、标题文字和 REPORT 小字一起带过来，
      // 结果就是我们新增的按钮里同时出现「管理」「公告」和「S.W.E.E.P.报告」。
      btn = stat.cloneNode(true);
      btn.id = id;
      btn.type = 'button';
      btn.disabled = false;
      btn.style.marginRight = '0px';
      // 清掉所有子节点与残留状态，再按版式重建
      btn.replaceChildren();
      btn.removeAttribute('data-testid');
      const glyphSlot = stat.querySelector('.hub-plate__glyph');
      if (glyphSlot) {
        // 保留图标框本身（它的边框/尺寸是版式的一部分），只换里面的图标
        const box = document.createElement('span');
        box.className = glyphSlot.className;
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('viewBox', '0 0 24 24');
        s.setAttribute('aria-hidden', 'true');
        s.setAttribute('focusable', 'false');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', iconPath);
        path.setAttribute('fill', 'currentColor');
        s.appendChild(path);
        box.appendChild(s);
        btn.appendChild(box);
      }
      const name = document.createElement('span');
      name.className = 'hub-plate__name';
      name.textContent = label;
      btn.appendChild(name);
      btn.onclick = onClick;
      const before0 = beforeId ? document.getElementById(beforeId) : null;
      stat.parentElement.insertBefore(btn, before0 || stat);
      return btn;
    }
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = stat.className;
    btn.style.marginRight = '10px';
    btn.style.color = '#ffffff';
    const svg = stat.querySelector('svg');
    if (svg) {
      const s = svg.cloneNode(true);
      const path = s.querySelector('path');
      if (path) path.setAttribute('d', iconPath);
      btn.appendChild(s);
    }
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);
    btn.onclick = onClick;
    const before = beforeId ? document.getElementById(beforeId) : null;
    // 模板节点可能已被 Preact 卸载（parentElement 为 null），此时跳过本轮，等下一轮 ensure 再插，
    // 否则会抛异常并中断后面所有注入（历史 bug：公告/管理/Q群按钮一起消失）。
    if (!stat.parentElement || !stat.isConnected) return null;
    stat.parentElement.insertBefore(btn, before && before.parentElement === stat.parentElement ? before : stat);
    return btn;
  }

  function ensureTopButtonFrom(id, label, iconPath, onClick, templateRe, beforeId) {
    const tpl = [...document.querySelectorAll('button')]
      .find((b) => !b.id.startsWith('mm-') && templateRe.test((b.textContent || '').trim()));
    const existing = document.getElementById(id);
    if (!tpl) { if (existing) existing.style.display = 'none'; return null; }
    if (existing) { existing.style.display = ''; return existing; }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = tpl.className;
    btn.style.marginRight = document.querySelector('.title-screen') ? '10px' : '0px';
    const svg = tpl.querySelector('svg');
    if (svg) {
      const s = svg.cloneNode(true);
      const path = s.querySelector('path');
      if (path) path.setAttribute('d', iconPath);
      btn.appendChild(s);
    }
    const span = document.createElement('span');
    span.textContent = label;
    btn.appendChild(span);
    btn.onclick = onClick;
    const before = beforeId ? document.getElementById(beforeId) : null;
    tpl.parentElement.insertBefore(btn, before || tpl);
    return btn;
  }

  // mm-clean-top：非标题页时移除我们插入的按钮
  function cleanTopExtras() {
    // 判定「在标题页」不能只看 button.title-stats：那个按钮在标题页渲染过程中可能短暂消失，
    // 一旦查不到就会把公告按钮删掉，下一轮 ensure 再建回来 —— 表现为右上角每几秒闪一下。
    // 用 .title-screen 容器作为主判据（它才是标题页本身），按钮只是辅助。
    const onTitle = !!document.querySelector('.title-screen') || !!document.querySelector('button.title-stats');
    const inLobby = [...document.querySelectorAll('button')].some((b) => !b.id.startsWith('mm-') && /S\.W\.E\.E\.P/i.test((b.textContent || '').trim()));
    const qq = document.getElementById('mm-qq');
    if (!onTitle && qq) qq.remove();
    const notice = document.getElementById('mm-notice-btn');
    if (!onTitle && !inLobby && notice) notice.remove();
    const legacy = document.getElementById('mm-notice-lobby');
    if (legacy) legacy.remove();
  }

  function installQQGroup() {
    const QQ = '312990596';
    const LINK = 'https://qun.qq.com/universal-share/share?ac=1&authKey=f50LwALLkBM4sEW9%2Fzx%2BnaN1aT0QvIEpxEpgZ62mrdnpilQA7WCK5SgPMNtCWLfH&busi_data=eyJncm91cENvZGUiOiIzMTI5OTA1OTYiLCJ0b2tlbiI6Ik5zR2lzaTczUEp6UGNhOWNuSDF0VUp5eW9CemVvZGlib3dxbFNGeGVLSVJwZWFWb3Z4dCtHb01maDExVnZBVS8iLCJ1aW4iOiIyODExMTA0NzEifQ%3D%3D&data=MRFk_l0v2xsFWvIy0Baa-d5WJYNGXZA1tTitHhWUrEjtqcUwegXE9v7kk_-1zb_PP8c4L07-oo1AKcWjaMqjbQ&svctype=4&tempid=h5_group_info';
    // Official QQ penguin mark (Simple Icons' QQ brand path), inlined so the
    // button never depends on a third-party request.
    const PENGUIN = '<svg viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="QQ"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>';
    const open = () => window.open(LINK, '_blank', 'noopener');
    const ensure = () => {
      const onTitle = !!document.querySelector('.title-screen') || !!document.querySelector('button.title-stats');
      const lobby = document.querySelector('.lobby-screen');
      const tools = lobby && lobby.querySelector('.topbar__tools');
      const room = document.querySelector('.room-screen');
      const roomTools = room && room.querySelector('.topbar__left');
      if (!document.getElementById('mm-qq-css')) {
        const st = document.createElement('style');
        st.id = 'mm-qq-css';
        st.textContent = `
          /* 标题屏页脚：Q群按钮独占一行，贴着左下角，位于「添加到桌面」上方。
             flex 容器里 flex-basis:100% 不会自动换行，所以用一个占满整行的
             透明占位块（.mm-qq-row）把按钮顶到单独一行。 */
          .title-foot > .mm-qq-row{flex:0 0 100%;display:flex;justify-content:flex-start;align-items:center;line-height:0}
          .title-foot > .mm-qq-row ~ *{flex-grow:0}
          .title-foot .mm-qq-row > #mm-qq{position:static!important;flex:0 0 auto!important;width:auto!important;max-width:fit-content!important;align-self:center!important;margin:0!important;padding:.05rem .2rem!important;height:max(.3rem,1.75em)!important;font-size:calc(.13 * var(--t))!important;line-height:1!important;box-sizing:border-box!important;justify-content:flex-start!important}
          .title-foot .mm-qq-row > #mm-qq .mm-qq-penguin{width:1.05em!important;height:1.05em!important}
          #mm-qq{position:fixed;left:max(18px,env(safe-area-inset-left,0px));bottom:calc(82px + env(safe-area-inset-bottom,0px));z-index:2147482000;display:inline-flex;align-items:center;justify-content:center;gap:5px;border:1px solid #7ff0cf;border-radius:0;background:#35c79b;color:#061611;box-shadow:0 0 0 1px rgba(78,216,175,.18),0 4px 16px rgba(0,0,0,.28);letter-spacing:0;cursor:pointer;white-space:nowrap}
          #mm-qq:hover{background:#5ee0b9;border-color:#b6ffe9;color:#03110c}
          #mm-qq .mm-qq-penguin{display:inline-flex;align-items:center;justify-content:center;width:1.15em;height:1.15em;line-height:1;font-size:1em;flex:none}
          #mm-qq .mm-qq-penguin svg,#mm-qq .mm-qq-penguin svg path{display:block;width:100%;height:100%;fill:currentColor!important;stroke:none!important}
          /* 三处 Q 群按钮（标题页 / 大厅 / 模拟弹窗）统一为绿色实心 */
          #mm-qq,#mm-qq-lobby,#mm-qq-room{background:#35c79b!important;border:1px solid #7ff0cf!important;color:#061611!important;border-radius:0!important}
          #mm-qq:hover,#mm-qq-lobby:hover,#mm-qq-room:hover{background:#5ee0b9!important;border-color:#b6ffe9!important;color:#03110c!important}
          /* 大厅 / 同盟模拟 / 独立模拟：只显示企鹅图标的方形按钮。
             尺寸不写死 —— 由脚本量取紧邻其右侧的那个按钮，复制它的宽高/内边距/字号，
             保证各界面与其他工具栏按钮完全一致。 */
          #mm-qq-lobby,#mm-qq-room{display:inline-flex!important;align-items:center!important;justify-content:center!important;flex:none!important;letter-spacing:0!important;border-radius:0!important;box-sizing:border-box!important}
          #mm-qq-lobby .mm-qq-penguin,#mm-qq-room .mm-qq-penguin{display:inline-flex!important;align-items:center!important;justify-content:center!important;line-height:1!important;margin:0!important;flex:none!important;font-size:1em!important;color:currentColor!important}
          #mm-qq-lobby .mm-qq-penguin svg,#mm-qq-room .mm-qq-penguin svg,
          #mm-qq-lobby .mm-qq-penguin svg path,#mm-qq-room .mm-qq-penguin svg path{display:block!important;width:100%!important;height:100%!important;fill:currentColor!important;stroke:none!important}
        `;
        (document.head || document.documentElement).appendChild(st);
      }

      // 三处界面（大厅 / 同盟模拟 / 独立模拟）共用同一个构造：只有企鹅图标，不显示群号文字。
      const QQTEXT = '<span class="mm-qq-penguin" aria-hidden="true">' + PENGUIN + '</span>';
      const makeQqBtn = (id, cls) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = id;
        b.className = 'btn btn--secondary btn--sm btn--square ' + (cls || '');
        b.title = '加入官方Q群';
        b.setAttribute('aria-label', '加入官方Q群：' + QQ);
        b.innerHTML = QQTEXT;
        b.onclick = open;
        return b;
      };
      const syncQqBtn = (b) => {
        if (b.dataset.mmQqText !== '3') { b.innerHTML = QQTEXT; b.dataset.mmQqText = '3'; }
        return b;
      };
      /**
       * 让按钮与给定的参照按钮同尺寸（宽、高、内边距、字号、圆角、边框宽度），
       * 图标尺寸也对齐参照按钮里的图标。比按“相邻元素”猜测更可靠。
       */
      const matchNeighbourTo = (b, ref) => {
        try {
          if (!b || !ref || !ref.isConnected) return;
          const cs = getComputedStyle(ref);
          const r = ref.getBoundingClientRect();
          if (r.width > 0) { b.style.setProperty('width', r.width + 'px', 'important'); b.style.setProperty('min-width', r.width + 'px', 'important'); }
          if (r.height > 0) { b.style.setProperty('height', r.height + 'px', 'important'); b.style.setProperty('min-height', r.height + 'px', 'important'); }
          b.style.setProperty('padding', cs.padding, 'important');
          b.style.setProperty('font-size', cs.fontSize, 'important');
          b.style.setProperty('border-radius', cs.borderRadius, 'important');
          b.style.setProperty('border-width', cs.borderWidth, 'important');
          const refIcon = ref.querySelector('svg');
          const icon = b.querySelector('.mm-qq-penguin');
          if (refIcon && icon) {
            const ir = refIcon.getBoundingClientRect();
            if (ir.width > 0) {
              icon.style.setProperty('width', ir.width + 'px', 'important');
              icon.style.setProperty('height', ir.height + 'px', 'important');
            }
          }
        } catch { /* 量不到就沿用默认尺寸 */ }
      };

      /**
       * 让 Q 群按钮与它右侧紧邻的那个按钮同尺寸（宽、高、内边距、字号、圆角、边框宽度）。
       * 各界面工具栏按钮规格不同（大厅 42px、弹窗顶栏可能不同），所以量取而不是写死。
       */
      const matchNeighbour = (b) => {
        try {
          // 右侧紧邻可能不是按钮（大厅这里是分隔线 + 工具组），向后找到第一个真正的按钮
          let next = b.nextElementSibling;
          let guard = 0;
          while (next && !next.matches('button') && guard++ < 6) {
            next = next.matches('.topbar__tools') || next.querySelector?.('button')
              ? (next.matches('button') ? next : next.querySelector('button'))
              : next.nextElementSibling;
          }
          if (!next || !next.matches('button')) return;
          const cs = getComputedStyle(next);
          const r = next.getBoundingClientRect();
          // 用计算后的固定像素值，避免不同父容器下的 rem 解析差异
          if (r.width > 0) { b.style.setProperty('width', r.width + 'px', 'important'); b.style.setProperty('min-width', r.width + 'px', 'important'); }
          if (r.height > 0) { b.style.setProperty('height', r.height + 'px', 'important'); b.style.setProperty('min-height', r.height + 'px', 'important'); }
          b.style.setProperty('padding', cs.padding, 'important');
          b.style.setProperty('font-size', cs.fontSize, 'important');
          b.style.setProperty('border-radius', cs.borderRadius, 'important');
          b.style.setProperty('border-width', cs.borderWidth, 'important');
          // 图标尺寸对齐右侧按钮里的图标（而不是写死 28px）
          const nbIcon = next.querySelector('svg');
          if (nbIcon) {
            const ir = nbIcon.getBoundingClientRect();
            const icon = b.querySelector('.mm-qq-penguin');
            if (icon && ir.width > 0) {
              icon.style.setProperty('width', ir.width + 'px', 'important');
              icon.style.setProperty('height', ir.height + 'px', 'important');
            }
          }
        } catch { /* 量不到就沿用默认尺寸 */ }
      };

      // 大厅顶栏顺序（维护者指定）：
      //   [返回] [延迟] [节点状态] | [Q群] [统计][设置][玩法说明]… [版本]
      // 节点状态留在延迟旁边（原位置），Q群放在工具组最前面。
      const lobbyBtn = document.getElementById('mm-qq-lobby');
      const lobbyBar = document.querySelector('.lobby-screen .topbar__left') || tools;
      if (!lobbyBar) {
        if (lobbyBtn) lobbyBtn.remove();
      } else {
        const b = syncQqBtn(lobbyBtn || makeQqBtn('mm-qq-lobby'));
        const toolsBox = lobbyBar.querySelector('.topbar__tools');
        if (toolsBox) {
          // Q群：工具组第一位
          if (b.parentElement !== toolsBox || b !== toolsBox.firstElementChild) {
            toolsBox.insertBefore(b, toolsBox.firstElementChild);
          }
        }
        // 节点状态：放回延迟之后（分隔线之前），保持原位置。
        // 注意：这里绝对不能无条件抢回来——同盟模拟 / 独立模拟 弹窗打开时，
        // place() 会把它移进弹窗自己的顶栏；本函数每 1.5s 跑一次，
        // 若无条件搬回大厅就会和 place() 互相抢占（表现为闪烁在大厅/弹窗之间）。
        // 所以只在“当前没有全屏弹窗在显示”时才归位。
        const nodesEl = document.getElementById('mm-nodes');
        const sep = lobbyBar.querySelector('.topbar__sep');
        const rsClock = document.querySelector('.room-screen .rs-clock') || document.querySelector('.rs-top__left .rs-clock');
        if (nodesEl && !rsClock && nodesEl.parentElement !== lobbyBar) {
          lobbyBar.insertBefore(nodesEl, sep || null);
        }
        // 分隔线紧跟节点状态之后，再往右才是工具组，避免出现一条孤立的竖线和大片空白
        if (sep && nodesEl && !rsClock && sep.previousElementSibling !== nodesEl) {
          nodesEl.insertAdjacentElement('afterend', sep);
        }
        if (!toolsBox && b.parentElement !== lobbyBar) {
          const anchor = sep || null;
          if (anchor) lobbyBar.insertBefore(b, anchor); else lobbyBar.appendChild(b);
        }
        // 尺寸对齐它右侧紧邻的按钮（这里就是「设置」）
        matchNeighbourTo(b, toolsBox ? toolsBox.querySelector('button') : null);
        matchNeighbour(b);
        // 统一为绿色实心（matchNeighbour 会复制相邻按钮的深色底，这里覆盖回来）
        try {
          const h = parseFloat(getComputedStyle(b).height) || 42;
          b.style.setProperty('background', '#35c79b', 'important');
          b.style.setProperty('border', '1px solid #7ff0cf', 'important');
          b.style.setProperty('color', '#061611', 'important');
          b.style.setProperty('border-radius', '0', 'important');
          b.style.setProperty('width', h + 'px', 'important');
          b.style.setProperty('min-width', h + 'px', 'important');
          const ic = b.querySelector('.mm-qq-penguin');
          if (ic) {
            const px = Math.round(h * 0.55);
            ic.style.setProperty('width', px + 'px', 'important');
            ic.style.setProperty('height', px + 'px', 'important');
            ic.style.setProperty('color', 'inherit', 'important');
          }
        } catch { /* ignore */ }
      }

      // 房间页（同盟模拟 / 独立模拟 房间）：顶栏的「柱状图 / 齿轮 / 书本」属于 .rs-tools，
      // Q群按钮放在这一排的最前面，即「统计数据」左边。
      const roomBarQq = document.getElementById('mm-qq-roombar');
      const rsTools = document.querySelector('.room-screen .rs-tools');
      if (!rsTools) {
        if (roomBarQq) roomBarQq.remove();
      } else {
        const q = syncQqBtn(roomBarQq || makeQqBtn('mm-qq-roombar'));
        if (q.parentElement !== rsTools || q !== rsTools.firstElementChild) {
          rsTools.insertBefore(q, rsTools.firstElementChild);
        }
        const ref = rsTools.querySelector('.stats-entry') || rsTools.querySelector('button');
        try {
          const rr = ref ? ref.getBoundingClientRect() : null;
          const side = rr && rr.height > 0 ? Math.round(rr.height) : 42;
          q.style.setProperty('height', side + 'px', 'important');
          q.style.setProperty('min-height', side + 'px', 'important');
          q.style.setProperty('width', side + 'px', 'important');
          q.style.setProperty('min-width', side + 'px', 'important');
          q.style.setProperty('border-radius', '0', 'important');
          q.style.setProperty('margin', '0', 'important');
          q.style.setProperty('padding', '0', 'important');
          q.style.setProperty('display', 'inline-flex', 'important');
          q.style.setProperty('align-items', 'center', 'important');
          q.style.setProperty('justify-content', 'center', 'important');
          q.style.setProperty('background', '#35c79b', 'important');
          q.style.setProperty('border', '1px solid #7ff0cf', 'important');
          q.style.setProperty('color', '#061611', 'important');
          const ic = q.querySelector('.mm-qq-penguin');
          if (ic) {
            const px = Math.round(side * 0.55);
            ic.style.setProperty('width', px + 'px', 'important');
            ic.style.setProperty('height', px + 'px', 'important');
            ic.style.setProperty('color', 'inherit', 'important');
            ic.style.setProperty('display', 'inline-flex', 'important');
            const svg = ic.querySelector('svg');
            if (svg) { svg.style.setProperty('width', '100%', 'important'); svg.style.setProperty('height', '100%', 'important'); }
          }
        } catch { /* ignore */ }
      }

      // 同盟模拟 / 独立模拟：弹窗是全屏覆盖层，不需要再放一份按钮 ——
      // 大厅顶栏工具组里已经有一个（Q群在设置左侧），弹窗关闭后就能看到。
      // 这里只清理历史遗留的弹窗内按钮。
      const staleRoomBtn = document.getElementById('mm-qq-room');
      if (staleRoomBtn) staleRoomBtn.remove();
      const staleRow = document.querySelector('.mm-proto-right');
      if (staleRow) {
        // 把被包进容器的标题还原回 .proto-top，避免影响弹窗自身布局
        const titleEl = staleRow.querySelector('.proto-title');
        if (titleEl && staleRow.parentElement) staleRow.parentElement.insertBefore(titleEl, staleRow);
        if (!staleRow.children.length) staleRow.remove();
      }

      // Title screen: put the QQ button in the footer flow instead of a fixed overlay, so it
      // cannot cover the download/import hints, 添加到桌面 or the footer itself.
      const titleBtn = document.getElementById('mm-qq');
      if (!onTitle) {
        if (titleBtn) titleBtn.remove();
        const staleRow = document.querySelector('.title-foot > .mm-qq-row');
        if (staleRow) staleRow.remove();
        return;
      }
      // On phones the title footer is cramped; the lobby/room top bars still carry the QQ
      // entry, so remove this one instead of letting it cover 游客访问.
      // NB 0.3.3: do NOT treat maxTouchPoints>0 as "phone" — touch-screen laptops/desktop
      // Edge report 10 touch points, which used to hide the button on real desktops.
      const phoneTitle = window.matchMedia?.('(max-width: 900px)').matches
        || (window.matchMedia?.('(pointer: coarse)').matches
          && (window.matchMedia?.('(hover: none)').matches));
      if (phoneTitle) {
        if (titleBtn) titleBtn.remove();
        return;
      }
      let btn = titleBtn;
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'mm-qq';
        btn.className = 'btn btn--secondary btn--sm';
        btn.title = '加入官方Q群';
        btn.setAttribute('aria-label', '加入官方Q群：' + QQ);
        btn.innerHTML = '<span class="mm-qq-penguin" aria-hidden="true">' + PENGUIN + '</span><span>官方Q群：' + QQ + '</span>';
        btn.onclick = open;
      }
      const foot = document.querySelector('.title-foot');
      if (foot) {
        // 标题屏左下角：「添加到桌面」上方独占一行。页脚是 flex 换行容器，
        // 用一行占位块把按钮顶到最左边单独一行，原按钮组位置保持不变。
        let row = foot.querySelector('.mm-qq-row');
        if (!row) {
          row = document.createElement('span');
          row.className = 'mm-qq-row';
          row.setAttribute('aria-hidden', 'false');
        }
        if (row.parentElement !== foot || row !== foot.firstElementChild) {
          foot.insertBefore(row, foot.firstElementChild);
        }
        if (btn.parentElement !== row) row.appendChild(btn);
        btn.style.position = 'static';
        btn.style.left = '';
        btn.style.bottom = '';
        return;
      }
      if (btn.parentElement !== document.body) document.body.appendChild(btn);
      btn.style.left = '';
      btn.style.bottom = '';
    };
    ensure();
    setInterval(ensure, 1200);
    window.addEventListener('resize', ensure);
  }




  // ---------------------------------------------------------------- 临时公告（后台即时推送，滚动两遍后消失）

  function installTempNotice() {
    // 移植参考版 ticker：顶部条内每行从右侧滑入、停留约 4.8 秒、向左滑出
    if (!document.getElementById('mm-ticker-css')) {
      const st = document.createElement('style');
      st.id = 'mm-ticker-css';
      st.textContent = `
#mm-ticker{position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);left:50%;transform:translateX(-50%);
  width:calc(100% - 24px);max-width:1040px;min-height:48px;box-sizing:border-box;z-index:2147483647;
  display:flex;align-items:center;gap:12px;padding:8px 10px 8px 16px;border:1px solid #34d399;border-left:4px solid #34d399;
  border-radius:3px;background:#050606;color:#f4fff9;pointer-events:none;box-shadow:0 4px 20px rgba(0,0,0,.6);
  font-size:clamp(19px,1.8vw,23px);line-height:1.5}
#mm-ticker:empty{display:none}
#mm-ticker::before{content:'提醒';color:#34d399;font-size:15px;font-weight:700;white-space:nowrap;flex:none;letter-spacing:.04em}
#mm-ticker .line{flex:1;min-width:0;overflow:hidden;position:relative;height:auto}
#mm-ticker .line > span{display:block;width:max-content;white-space:nowrap;font-weight:600;letter-spacing:.03em}
#mm-ticker .line.is-scrolling > span{animation:mm-notice-scroll var(--notice-duration,18s) linear infinite}
#mm-ticker .mm-ticker__close{width:38px;height:38px;min-width:38px;flex:none;padding:0;border:0;border-radius:0;
  background:transparent;color:#34d399;font:400 26px/1 "Noto Sans SC",system-ui,sans-serif;cursor:pointer;pointer-events:auto}
#mm-ticker .mm-ticker__close:hover{color:#9dffe2}
@keyframes mm-notice-scroll{
  0%,15%{transform:translateX(0)}
  85%,100%{transform:translateX(var(--notice-distance,0px))}
}
@media (max-width:700px){
  #mm-ticker{top:calc(env(safe-area-inset-top,0px) + 6px);width:calc(100% - 16px);min-height:44px;gap:8px;padding:6px 7px 6px 10px;
    font-size:clamp(15px,3.9vw,18px)}
  #mm-ticker::before{font-size:13px}
  #mm-ticker .mm-ticker__close{width:32px;height:32px;min-width:32px;font-size:22px}
}
`;
      document.head.appendChild(st);
    }

    let queue = [];
    let showing = false;
    let current = null;
    let stopFlag = false;
    let lastKey = '';
    let overlayOpen = false;
    let pauseStarted = 0;
    let guardStarted = false;

    // Any real dialog/overlay (settings, bulletin, guide, loadout, match popups) hides the ticker.
    const OVERLAY_SELECTOR = '.modal, [role="dialog"][aria-modal="true"], .mm-ov, .announcement-board, .guide, .lo, .spov, .awayov, .pauseov, .exp-pop';
    const isShown = (node) => {
      try {
        const r = node.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(node);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
      } catch { return false; }
    };
    const hasOverlay = () => {
      const nodes = document.querySelectorAll(OVERLAY_SELECTOR);
      for (const node of nodes) if (isShown(node)) return true;
      return false;
    };
    const syncOverlay = () => {
      const el = document.getElementById('mm-ticker');
      if (!el) return;
      const open = hasOverlay();
      if (open === overlayOpen) return;
      overlayOpen = open;
      if (open) {
        pauseStarted = performance.now();
        el.style.display = 'none';
      } else {
        el.style.display = '';
      }
    };
    const startOverlayGuard = () => {
      if (guardStarted) return;
      guardStarted = true;
      let raf = 0;
      const kick = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; syncOverlay(); });
      };
      try {
        new MutationObserver(kick).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden'] });
      } catch { /* ignore */ }
      syncOverlay();
    };

    const closeTicker = () => {
      queue = [];
      showing = false;
      current = null;
      stopFlag = true;
      const el = document.getElementById('mm-ticker');
      if (el) { try { el.replaceChildren(); } catch { el.innerHTML = ''; } }
    };

    const strip = () => {
      let el = document.getElementById('mm-ticker');
      if (!el) {
        el = document.createElement('div');
        el.id = 'mm-ticker';
        document.body.appendChild(el);
      }
      if (!el.querySelector('.mm-ticker__close')) {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'mm-ticker__close';
        close.setAttribute('aria-label', '关闭提醒');
        close.title = '关闭提醒';
        close.textContent = '×';
        close.addEventListener('click', closeTicker);
        el.appendChild(close);
      }
      syncOverlay();
      return el;
    };

    // Reference-style horizontal notice: static when it fits, slow scroll when it does not.
    const play = (item) => {
      if (!item || showing) return;
      showing = true;
      stopFlag = false;
      current = item;
      const el = strip();
      const line = document.createElement('div');
      line.className = 'line';
      const text = document.createElement('span');
      text.textContent = item.text;
      line.appendChild(text);
      line.title = item.text;
      const close = el.querySelector('.mm-ticker__close');
      if (close) el.insertBefore(line, close); else el.appendChild(line);
      requestAnimationFrame(() => {
        if (!line.isConnected) return;
        const overflow = Math.ceil(text.scrollWidth - line.clientWidth);
        if (overflow > 4) {
          line.style.setProperty('--notice-distance', `-${overflow}px`);
          const seconds = Math.max(14, Math.min(36, (text.scrollWidth + line.clientWidth) / 55));
          line.style.setProperty('--notice-duration', `${seconds.toFixed(1)}s`);
          line.classList.add('is-scrolling');
        }
      });
    };

    const showNext = () => {
      if (showing) return;
      const item = queue.shift();
      if (item) play(item);
    };

    const enqueue = (lines, key) => {
      const text = lines.join('　');
      if (!text) return;
      if (current && current.text === text && current.key === key) return;
      queue.push({ text, key });
      showNext();
    };

    const poll = () => fetch('/mm/api/announcement', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      const enabled = !!(d && d.enabled && d.text);
      if (!enabled) {
        // 关闭公告：停止当前这条并清空排队，不再显示
        lastKey = '';
        closeTicker();
        return;
      }
      const key = String(d.updatedAt || d.text);
      if (key === lastKey) return;
      lastKey = key;
      const lines = String(d.text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      // New content replaces the previous reminder; the player can close each one.
      if (showing) closeTicker();
      enqueue(lines, key);
    }).catch(() => {});
    startOverlayGuard();
    poll();
    setInterval(poll, 5000);
  }


  function installAnnouncement() {
    let cache = null;
    let revision = '';
    let dotPending = false;
    const ICON = 'M12 2a1 1 0 0 1 1 1v1.1a6 6 0 0 1 5 5.9v4l2 2v2H4v-2l2-2v-4a6 6 0 0 1 5-5.9V3a1 1 0 0 1 1-1zm0 20a3 3 0 0 1-3-3h6a3 3 0 0 1-3 3z';
    const hash = (s) => {
      let a = 2166136261;
      for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 16777619);
      return 'ann1:' + (a >>> 0).toString(16) + ':' + s.length.toString(16);
    };

    if (!document.getElementById('mm-ann-css')) {
      const st = document.createElement('style');
      st.id = 'mm-ann-css';
      st.textContent = `
.announcement-list { display: flex; flex-direction: column; gap: .24rem; }
.announcement-entry { overflow-wrap: anywhere; }
.announcement-entry + .announcement-entry { border-top: 1px solid var(--line); padding-top: .22rem; }
.announcement-entry header { display: flex; flex-wrap: wrap; align-items: baseline; gap: .1rem .2rem; margin-bottom: .12rem; }
.announcement-entry h3 { font-size: max(calc(.23 * var(--t)), 16px); color: var(--text-hi); }
.announcement-date { font-size: max(calc(.14 * var(--t)), 12px); color: var(--text-lo); }
.announcement-entry p { white-space: pre-wrap; font-size: max(calc(.18 * var(--t)), 14px); line-height: 1.7; }
.announcement-entry p + p { margin-top: .12rem; }
.announcement-tag { color: var(--mint-400); font-weight: 700; margin-right: .06rem; }
.announcement-state { display: flex; flex-direction: column; align-items: center; gap: .14rem; padding-block: .36rem; text-align: center; }
.announcement-state h3 { color: var(--text-hi); font-size: max(calc(.22 * var(--t)), 16px); }
.announcement-state p { font-size: max(calc(.17 * var(--t)), 14px); line-height: 1.6; }
.announcement-board .modal__body { display: flex; flex-direction: column; flex: 1; gap: 12px; overflow: hidden; }
.announcement-scroll { min-height: 0; flex: 1; overflow-y: scroll; overscroll-behavior: contain; scrollbar-gutter: stable; padding-right: 12px; }
.announcement-board .modal__actions .btn { min-height: 40px; font-size: max(calc(.17 * var(--t)), 14px); padding-inline: 16px; }
`;
      document.head.appendChild(st);
    }

    const markRead = () => {
      try { localStorage.setItem('mm.annDismissed', revision); } catch { /* ignore */ }
      dotPending = false;
      const dot = document.querySelector('#mm-notice-btn .mm-dot');
      if (dot) dot.remove();
    };

    const open = () => {
      if (document.getElementById('mm-notice-modal')) { markRead(); return; }
      const veil = document.createElement('div');
      veil.id = 'mm-notice-modal';
      veil.className = 'modal lobby-dialog';
      veil.innerHTML = '<div class="modal__box brackets modal__box--mint lobby-dialog announcement-board" role="dialog" aria-modal="true" tabindex="-1">'
        + '<div class="modal__stripe" aria-hidden="true"></div>'
        + '<header class="modal__head"><span class="micro">BULLETIN BOARD</span><h2 class="modal__title">公告板</h2></header>'
        + '<div class="modal__body"><div class="announcement-scroll" role="region" tabindex="0"><div class="announcement-list"></div></div></div>'
        + '<footer class="modal__actions"><button type="button" class="btn btn--secondary" data-mm-close>关闭公告</button></footer>'
        + '</div>';
      const listEl = veil.querySelector('.announcement-list');
      const list = Array.isArray(cache) ? cache : [];
      if (!list.length) {
        listEl.outerHTML = '<div class="announcement-state"><h3>暂无公告</h3><p>新的公告会在这里显示。</p></div>';
      } else {
        for (const en of list) {
          const art = document.createElement('article');
          art.className = 'announcement-entry';
          const head = document.createElement('header');
          const h3 = document.createElement('h3');
          h3.textContent = String(en.title || '');
          head.appendChild(h3);
          if (en.date) {
            const d = document.createElement('span');
            d.className = 'announcement-date num';
            d.textContent = String(en.date);
            head.appendChild(d);
          }
          art.appendChild(head);
          for (const para of (en.paragraphs || [])) {
            const pn = document.createElement('p');
            const text = String(para);
            const m = /^【([^】]{1,20})】/.exec(text);
            if (m) {
              const strong = document.createElement('strong');
              strong.className = 'announcement-tag';
              strong.textContent = '【' + m[1] + '】';
              pn.appendChild(strong);
              pn.appendChild(document.createTextNode(text.slice(m[0].length)));
            } else {
              pn.textContent = text;
            }
            art.appendChild(pn);
          }
          listEl.appendChild(art);
        }
      }
      const close = () => veil.remove();
      veil.querySelector('[data-mm-close]').onclick = close;
      veil.addEventListener('click', (e) => { if (e.target === veil) close(); });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
      });
      document.body.appendChild(veil);
      markRead();
    };

    const ensure = () => {
      const btn = ensureTopButton('mm-notice-btn', '公告', ICON, open, 'mm-admin-btn', true);
      if (!btn) return;
      let dot = btn.querySelector('.mm-dot');
      if (dotPending && !dot) {
        dot = document.createElement('span');
        dot.className = 'mm-dot';
        dot.style.cssText = 'display:inline-block;width:6px;height:6px;border-radius:50%;background:#e8b25a;margin-left:6px;vertical-align:middle';
        btn.appendChild(dot);
      }
      if (dot) dot.style.display = dotPending ? 'inline-block' : 'none';
    };

    const load = async () => {
      try {
        const r = await fetch('/mm/api/announcements', { cache: 'no-store' });
        const list = await r.json();
        if (!Array.isArray(list)) return;
        cache = list;
        const rev = hash(JSON.stringify(list));
        if (rev !== revision) {
          revision = rev;
          let dismissed = '';
          try { dismissed = localStorage.getItem('mm.annDismissed') || ''; } catch { /* ignore */ }
          dotPending = !!(list.length) && dismissed !== rev;
        }
      } catch { /* ignore */ }
    };

    ensure();
    setInterval(ensure, 1200);
    // New announcements open once when the player reaches 选择模拟节点 (the lobby),
    // not while still on the title or inside a room/match.
    const maybeAutoOpen = () => {
      if (!dotPending) return;
      if (document.getElementById('mm-notice-modal')) { markRead(); return; }
      if (!document.querySelector('.lobby-screen')) return;
      const modal = [...document.querySelectorAll('.modal')].some((el) => {
        try { return el.getClientRects().length > 0; } catch { return false; }
      });
      if (modal) return;
      open();
    };
    setInterval(maybeAutoOpen, 800);
    load();
    setInterval(load, 60000);
  }

  // ---------------------------------------------------------------- 「恢复对局」按钮（标题页 / 大厅）
  // 账号在别的节点还有一场进行中的对局时（例如换了网络、换了设备、页面被关掉又打开），
  // 自动恢复并不一定成功：它只在能拿到账号令牌、且房间还没被判定结束时才会跳转。
  // 这里额外给一个**手动入口**：只要有可恢复的对局就显示「恢复对局」，排在「公告」右边。
  // 点它 = 带着 accountResume=1 跳到 /r/CODE，由 accountObserver 接管座位。
  function installResumeButton() {
    const ID = 'mm-resume-btn';
    const existing = () => document.getElementById(ID);
    const removeBtn = () => { const b = existing(); if (b) b.remove(); };
    // 正在房间里 / 对局里：不需要入口
    const inRoom = () => {
      try {
        const sp = window.__SP__;
        const room = sp && sp.store && sp.store.get ? sp.store.get().room : null;
        return !!(room && room.code);
      } catch { return false; }
    };
    // 账号观察者已经在自动恢复中：别抢
    const autoBusy = () => window.__SP_ACCOUNT_RESUME_PENDING === true;
    let lastCode = null;
    let lastCheck = 0;

    const probe = async () => {
      const role = window.__SP_ACCOUNT_ROLE || '';
      if (!window.__SP_ACCOUNT_TOKEN || !role || role === 'guest') { removeBtn(); return; }
      if (inRoom() || autoBusy()) { removeBtn(); return; }
      // 主动退出对局后的一段时间内不显示（与自动恢复同一套闸）
      try {
        const now = Date.now();
        const a = Number(sessionStorage.getItem('sp.matchExitAt') || 0);
        const b2 = Number(localStorage.getItem('sp.matchExitAtShared') || 0);
        if ((a && now - a < 120000) || (b2 && now - b2 < 120000)) { removeBtn(); return; }
      } catch { /* ignore */ }
      if (Date.now() - lastCheck < 15000 && (lastCode || !existing())) return;   // 15 秒最多查一次
      lastCheck = Date.now();
      let code = null;
      try {
        const r = await fetch('/mm/api/account/room', { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          code = j && j.room && typeof j.room.code === 'string' ? j.room.code : null;
        }
      } catch { code = null; }
      lastCode = code;
      if (!code) { removeBtn(); return; }
      if (existing()) return;
      // 锚点：优先「公告」按钮（恢复对局排在它**左边**，与「管理后台」同一侧、管理后台更靠左）。
      // 公告按钮偶发还没建出来（版本按钮未就绪的瞬间），这时退回到右上角工具条的锚点，
      // 不让入口因为时序问题而消失。
      const notice = document.getElementById('mm-notice-btn');
      const anchor = notice
        || document.querySelector('.verchip-wrap, button.verchip[data-testid="version-switch"]')
        || [...document.querySelectorAll('button')].find((b) => !b.id.startsWith('mm-') && /S\.W\.E\.E\.P/i.test((b.textContent || '').trim()));
      if (!anchor || !anchor.parentElement) return;
      const btn = (notice || anchor).cloneNode(true);
      btn.id = ID;
      btn.type = 'button';
      btn.disabled = false;
      btn.replaceChildren();
      const dot = btn.querySelector('.mm-dot');
      if (dot) dot.remove();
      // 图标：返回箭头，和「公告」同一套描边
      const icon = (notice || anchor).querySelector('svg');
      if (icon) {
        const s = icon.cloneNode(true);
        const path = s.querySelector('path');
        if (path) path.setAttribute('d', 'M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4M14 4h6m0 0v6m0-6L10 14');
        btn.appendChild(s);
      }
      const label = document.createElement('span');
      label.className = 'verchip__label';
      label.textContent = '恢复对局';
      btn.appendChild(label);
      btn.title = `返回进行中的对局（${code}）`;
      btn.onclick = () => {
        try { sessionStorage.setItem('sp.accountResume', '1'); } catch { /* ignore */ }
        window.location.assign('/r/' + encodeURIComponent(code) + '?accountResume=1');
      };
      // 排在锚点左边
      anchor.parentElement.insertBefore(btn, anchor);
    };

    // 页面刚起来时账号令牌/角色可能还没到，多试几轮
    setTimeout(probe, 1500);
    setTimeout(probe, 4000);
    setTimeout(probe, 8000);
    setInterval(probe, 6000);
    window.addEventListener('sp:account-changed', () => { lastCheck = 0; setTimeout(probe, 300); });
  }




  // ---------------------------------------------------------------- 节点状态角标（延迟旁边：大厅/房间看集群，对局看本节点）

  const LOAD_TEXT = { normal: '正常', busy: '繁忙', down: '异常' };

  function fixCenterButtons() {
    // 让“停止搜寻”等按钮的文字垂直/水平居中
    const walk = () => {
      for (const el of document.querySelectorAll('button')) {
        const txt = (el.textContent || '').trim();
        if (txt !== '停止搜寻' && txt !== '取消匹配') continue;
        if (el.dataset.mmCenter === '1') continue;
        el.dataset.mmCenter = '1';
        el.style.display = 'inline-flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.lineHeight = '1';
        el.style.paddingTop = '0';
        el.style.paddingBottom = '0';
      }
    };
    walk();
    try { new MutationObserver(walk).observe(document.body, { childList: true, subtree: true }); } catch { /* ignore */ }
  }

  function hideLatencyLabel() {
    // mm-hide-latency：隐藏 ping 下方的“当前延迟”小字，让左上行保持单行
    const walk = () => {
      for (const el of document.querySelectorAll('span,div,p')) {
        if (el.childElementCount) continue;
        if ((el.textContent || '').trim() !== '当前延迟') continue;
        el.style.display = 'none';
      }
    };
    walk();
    try { new MutationObserver(walk).observe(document.body, { childList: true, subtree: true }); } catch { /* ignore */ }
  }

  const __mmStatusCss = `
#mm-nodes .panel{padding:18px 20px;background:rgba(6,10,12,.97);border:1px solid var(--line);border-radius:12px;min-width:480px}
#mm-nodes .server-status__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;
  padding-bottom:14px;border-bottom:1px solid var(--line);font-size:14px;color:var(--text-hi)}
#mm-nodes .server-status__window{font-size:11px;color:var(--text-lo)}
#mm-nodes .server-status__table-wrap{overflow-x:auto;max-width:100%}
#mm-nodes .server-status__table{border-collapse:collapse;width:100%;font-size:13px;white-space:nowrap;table-layout:fixed}
#mm-nodes .server-status__table th:nth-child(1),#mm-nodes .server-status__table td:nth-child(1){width:44%}
#mm-nodes .server-status__table th:nth-child(2),#mm-nodes .server-status__table td:nth-child(2){width:20%}
#mm-nodes .server-status__table th:nth-child(3),#mm-nodes .server-status__table td:nth-child(3){width:18%}
#mm-nodes .server-status__table th:nth-child(4),#mm-nodes .server-status__table td:nth-child(4){width:18%}
#mm-nodes .server-status__table th,#mm-nodes .server-status__table td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:right;font-weight:400;line-height:1.5}
#mm-nodes .server-status__table th:first-child,#mm-nodes .server-status__table td:first-child{text-align:left}
#mm-nodes .server-status__table thead{color:var(--text-lo);font-size:12px;letter-spacing:.5px}
#mm-nodes .server-status__table tbody{color:var(--text-hi)}
#mm-nodes .server-status__table td.num{font-family:var(--font-num);font-variant-numeric:tabular-nums;color:var(--mint-400);font-weight:700}
#mm-nodes .server-status__table tr.off td{color:var(--red-premium,#c98b8b)}
#mm-nodes .server-status__dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--mint-400);margin-right:10px;vertical-align:middle}
#mm-nodes .server-status__table tr.off .server-status__dot{background:#8a4b4b}
`;
  const __mmStatusModalCss = `
#mm-nodes .panel{display:none!important}
.mm-status.modal{position:fixed;inset:0;z-index:130;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72)}
.mm-status .modal__box{width:min(700px,calc(100vw - 32px));max-height:calc(100vh - 64px);display:flex;flex-direction:column;
  background:#0a1114;border:1px solid var(--line);border-radius:10px;overflow:hidden;color:var(--text-hi)}
.mm-status .modal__head{display:flex;flex-direction:column;gap:2px;padding:16px 20px 12px;border-bottom:1px solid var(--line)}
.mm-status .modal__head .micro{font-size:10px;letter-spacing:3px;color:var(--text-dim)}
.mm-status .modal__title{margin:0;font-size:18px;color:var(--text-hi)}
.mm-status .modal__body{padding:16px 20px;overflow:auto}
.mm-status .modal__actions{display:flex;justify-content:flex-end;padding:12px 20px;border-top:1px solid var(--line)}
.mm-status .server-status__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;
  padding-bottom:14px;border-bottom:1px solid var(--line);font-size:14px}
.mm-status .server-status__window{font-size:11px;color:var(--text-lo)}
.mm-status .server-status__table-wrap{overflow-x:auto}
.mm-status .server-status__table{border-collapse:collapse;width:100%;font-size:13px;white-space:nowrap;table-layout:fixed}
.mm-status .server-status__table th,.mm-status .server-status__table td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:right;font-weight:400}
.mm-status .server-status__table th:first-child,.mm-status .server-status__table td:first-child{text-align:left;width:44%}
.mm-status .server-status__table th:nth-child(2),.mm-status .server-status__table td:nth-child(2){width:20%}
.mm-status .server-status__table th:nth-child(3),.mm-status .server-status__table td:nth-child(3){width:18%}
.mm-status .server-status__table th:nth-child(4),.mm-status .server-status__table td:nth-child(4){width:18%}
.mm-status .server-status__table thead{color:var(--text-lo)}
.mm-status .server-status__table td.num{font-family:var(--font-num);font-variant-numeric:tabular-nums;color:var(--mint-400);font-weight:700}
.mm-status .server-status__dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--mint-400);margin-right:10px;vertical-align:middle}
.mm-status tr.off td{color:#c98b8b}
`;
  const __mmStatusCss2 = `
.server-status-modal{width:min(700px,calc(100vw - 32px));max-height:calc(100vh - 64px)}
.server-status-modal .modal__body{display:flex;flex-direction:column;gap:12px;overflow:hidden;min-height:0}
.server-status__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:max(calc(.15 * var(--t)),12px);color:var(--text-hi)}
.server-status__window{font-size:11px;color:var(--text-lo)}
.server-status__table-wrap{overflow:auto;min-height:0;flex:1}
.server-status__table{border-collapse:collapse;width:100%;font-size:max(calc(.14 * var(--t)),12px);white-space:nowrap;table-layout:fixed}
.server-status__table th,.server-status__table td{padding:10px 10px;border-bottom:1px solid var(--line);text-align:right;font-weight:400}
.server-status__table th:first-child,.server-status__table td:first-child{text-align:left;width:44%}
.server-status__table th:nth-child(2),.server-status__table td:nth-child(2){width:20%}
.server-status__table th:nth-child(3),.server-status__table td:nth-child(3){width:18%}
.server-status__table th:nth-child(4),.server-status__table td:nth-child(4){width:18%}
.server-status__table thead{color:var(--text-lo)}
.server-status__table td.num{font-family:var(--font-num);font-variant-numeric:tabular-nums;color:var(--mint-400);font-weight:700}
.server-status__dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--mint-400);margin-right:10px;vertical-align:middle}
.server-status__table tr.off td{color:#c98b8b}
`;
  // 管理员账号：仅在大厅（选择模拟协议）的「公告」旁加「管理后台」按钮
  function installAdminEntry() {
    const role = (typeof window !== 'undefined' && window.__SP_ACCOUNT_ROLE) || '';
    const notice = document.getElementById('mm-notice-btn');
    const old = document.getElementById('mm-admin-btn');
    const onTitle = !!document.querySelector('.title-screen');
    if (onTitle || !notice || !role || role === 'player') { if (old) old.remove(); return; }
    if (old && document.body.contains(old)) return;
    const btn = notice.cloneNode(true);
    btn.id = 'mm-admin-btn';
    btn.type = 'button';
    btn.disabled = false;
    btn.replaceChildren();
    const dot = btn.querySelector('.mm-dot');
    if (dot) dot.remove();
    // 与相邻的公告/版本按钮同一套胶囊样式：图标 + 文字，排在公告左侧。
    const icon = notice.querySelector('svg');
    if (icon) {
      const s = icon.cloneNode(true);
      const path = s.querySelector('path');
      // 盾牌图标，与管理权限语义一致
      if (path) path.setAttribute('d', 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3zm0 5.5 3 2.6v3.3c0 2.3-1.3 4.4-3 5.3-1.7-.9-3-3-3-5.3V10l3-2.5z');
      btn.appendChild(s);
    }
    const name = document.createElement('span');
    name.className = 'verchip__label';
    name.textContent = '管理后台';
    btn.appendChild(name);
    btn.onclick = () => window.open('/mm/admin.html?v=20261021', '_blank');
    notice.parentElement.insertBefore(btn, notice);
  }
  let __mmTagProbeDone = false;
  async function probeAccountTag() {
    if (__mmTagProbeDone) return;
    if (window.__SP_ACCOUNT_TAG) { __mmTagProbeDone = true; return; }
    __mmTagProbeDone = true;
    try {
      const r = await fetch('/mm/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.user && j.user.tag) {
        window.__SP_ACCOUNT_TAG = String(j.user.tag);
        window.__SP_ACCOUNT_ROLE = String(j.user.role || '');
        try { localStorage.setItem('mm.tag', String(j.user.tag)); } catch { /* 忽略 */ }
        window.dispatchEvent(new Event('resize'));
      }
    } catch { /* 忽略 */ }
  }
  setTimeout(() => { try { probeAccountTag(); } catch { /* 忽略 */ } }, 800);
  setInterval(() => { try { installAdminEntry(); } catch { /* 忽略 */ } }, 1500);

  function installNodeBadge() {
    try {
      if (!document.getElementById('mm-status-css2')) {
        const s2 = document.createElement('style');
        s2.id = 'mm-status-css2';
        s2.textContent = __mmStatusCss2;
        document.head.appendChild(s2);
      }
    } catch { /* ignore */ }
    try {
      if (!document.getElementById('mm-status-modal-css')) {
        const s1 = document.createElement('style');
        s1.id = 'mm-status-modal-css';
        s1.textContent = __mmStatusModalCss;
        document.head.appendChild(s1);
      }
    } catch { /* ignore */ }
    if (!document.getElementById('mm-status-css')) {
      const s0 = document.createElement('style');
      s0.id = 'mm-status-css';
      s0.textContent = __mmStatusCss;
      document.head.appendChild(s0);
    }
    if (document.getElementById('mm-nodes')) return;
    const style = document.createElement('style');
    style.textContent = `
      #mm-nodes{position:fixed;z-index:46;display:inline-flex;align-items:center;font:12px/1.5 "Noto Sans SC",system-ui,sans-serif}
      div:has(> #mm-nodes){align-items:center}
      #mm-nodes:not(.topbar) .chip{display:inline-flex;align-items:center;justify-content:center;gap:.05rem;height:.32rem;padding:0 .14rem 0 .11rem;border-radius:99px;background:rgba(0,0,0,.5);border:1px solid var(--line);color:var(--text-hi);font:calc(.16 * var(--t))/1 "Noto Sans SC",system-ui,sans-serif;cursor:pointer;user-select:none;white-space:nowrap}
#mm-nodes .chip .num{color:var(--mint-400);font-family:var(--font-num);font-weight:700;font-variant-numeric:tabular-nums}
      #mm-nodes .chip i{width:7px;height:7px;border-radius:50%;background:#4ed8af;box-shadow:0 0 6px #4ed8af}
      #mm-nodes[data-state=busy] .chip i{background:#e8b25a;box-shadow:0 0 6px #e8b25a}
      #mm-nodes[data-state=down] .chip i{background:#d9534f;box-shadow:0 0 6px #d9534f}
      #mm-nodes .chip b{font-weight:700;color:#e6fff7}
      #mm-nodes.match .chip i{background:#e8b25a;box-shadow:0 0 6px #e8b25a}
      /* 手机（1rem 被钳到 40px）上 .16 × --t 只有 6px，字几乎看不见；
         高度 .32rem 也只有 12.8px，和旁边动辄 30px 的按钮不成比例。
         这里给字号和高度都加一个像素下限：小屏上反而要略微变小、但不能小到看不清。
         （玩家反馈「手机左上角节点状态按钮显示有点大」—— 实际是比例失衡，
         大屏 36px 高、小屏只有 14px 却字更小，看起来又大又糊。） */
      @media (max-width: 1100px) {
        #mm-nodes:not(.topbar) .chip{
          height: max(.28rem, 18px);
          padding: 0 max(.1rem, 8px) 0 max(.08rem, 6px);
          gap: max(.04rem, 3px);
          font-size: max(calc(.13 * var(--t)), 11px);
        }
        #mm-nodes .chip i{width: max(5px, .5vw); height: max(5px, .5vw)}
      }
      #mm-nodes .panel{position:absolute;top:calc(100% + 8px);left:0;z-index:60;min-width:360px;max-height:min(calc(100vh - 120px),920px);overflow:auto;background:rgba(0,0,0,.62);border:1px solid var(--line);border-radius:14px;padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.5);backdrop-filter:blur(6px);color:var(--text-hi);font:calc(.15 * var(--t))/1.5 "Noto Sans SC",system-ui,sans-serif}
      #mm-nodes .panel[hidden]{display:none}
      #mm-nodes .head{display:grid;grid-template-columns:14px 1fr 56px 56px 56px;gap:6px;padding:2px 4px 8px;color:var(--text-dim);font-size:calc(.12 * var(--t));border-bottom:1px solid var(--line);margin-bottom:6px}
      #mm-nodes .head span{text-align:right}
      #mm-nodes .head span:first-child{text-align:left;grid-column:1 / span 2}
      #mm-nodes .row{display:grid;grid-template-columns:14px 1fr 56px 56px 56px;align-items:center;gap:6px;padding:2px 6px;color:#9fd8c6;white-space:nowrap}
      #mm-nodes .row b{font-weight:600;overflow:hidden;text-overflow:ellipsis}
      #mm-nodes .row i{width:6px;height:6px;border-radius:50%;background:#4ed8af}
      #mm-nodes .row span{color:var(--text-lo);font-size:calc(.13 * var(--t));text-align:right}
      #mm-nodes .row span.num{color:var(--mint-400);font-family:var(--font-num);font-weight:700;font-variant-numeric:tabular-nums}
      #mm-nodes .row.off{color:#c98b8b}
      #mm-nodes .row.off i{background:#8a4b4b}
    `;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.id = 'mm-nodes';
    el.innerHTML = '<div class="panel" hidden></div><div class="chip"><i></i><span id="mm-nodes-text">节点状态…</span></div>';
    const panel = el.querySelector('.panel');
    const chip = el.querySelector('.chip');
    const text = el.querySelector('#mm-nodes-text');
    let data = null, open = false;

    const summary = () => {
      if (!data) return { state: 'normal', humans: 0, ready: 0, total: 0 };
      const ready = data.online;
      const humans = data.nodes.reduce((a, x) => a + (x.humans || 0), 0);
      const state = ready < data.total ? 'down' : humans >= 5000 ? 'busy' : 'normal';
      return { state, humans, ready, total: data.total };
    };

    // 固定定位：不参与任何布局，避免把标题页的“已连接服务器”挤成竖排
    const place = () => {
      const start = [...document.querySelectorAll('button')].find((b) => /^开始\s*»?$/.test((b.textContent || '').trim()) && b.offsetParent);
      const ping = document.querySelector('.ping');
      // 标题页登录态会隐藏「开始」按钮，这里改用标题页本身判断，避免节点状态被一起藏掉
      const onTitle = !!document.querySelector('.title-screen');
      // 同盟模拟 / 独立模拟 的【房间】顶栏：.rs-top__left > .rs-clock 里有
      // 「当前延迟 <PingPill>」，节点状态要作为同款药丸紧跟在它右边。
      // 注意：不是协议选择弹窗（.proto-top），那是另外一屏。
      const rsClock = document.querySelector('.room-screen .rs-clock') || document.querySelector('.rs-top__left .rs-clock');
      if (!onTitle && rsClock) {
        const pingRow = rsClock.querySelector('.rs-clock__ping');
        if (pingRow) {
          // 每轮都确认归属：房间顶栏会随状态重渲染，节点状态可能被挪走，这里重新挂上
          if (el.parentElement !== pingRow) pingRow.appendChild(el);
          const force = (elm, props) => { for (const [k, v] of Object.entries(props)) elm.style.setProperty(k, v, 'important'); };
          // 外观交给全局规则 `#mm-nodes:not(.topbar) .chip`（黑底 + 薄荷绿描边 + 99px 圆角），
          // 这里只做定位。以前在 .chip 上内联写了 padding/background/border/字号，
          // 等于给房间顶栏另做一套外观，和标题页/大厅不一致。
          el.classList.remove('topbar');
          force(el, {
            display: 'inline-flex', 'align-items': 'center', position: 'static',
            left: 'auto', right: 'auto', top: 'auto', transform: 'none',
            'z-index': 'auto',                 // 清掉全局的 46，别盖住上层的返回键
            height: 'auto',
            'border-radius': '99px', background: 'transparent',
            border: '0', 'align-self': 'center', flex: 'none',
            margin: '0',
          });
          const chipEl = el.querySelector('.chip');
          if (chipEl) {
            // 清掉历史遗留的内联覆盖，让全局 .chip 规则重新生效
            for (const k of ['padding', 'font-size', 'font-weight', 'background', 'border',
              'border-radius', 'box-sizing', 'line-height', 'color', 'white-space', 'justify-content', 'min-height']) {
              chipEl.style.removeProperty(k);
            }
            for (const dot of chipEl.querySelectorAll('i')) {
              dot.style.removeProperty('width');
              dot.style.removeProperty('height');
              dot.style.removeProperty('margin-right');
              dot.style.removeProperty('border-radius');
            }
          }
          // 药丸之间的间距交给 .rs-clock__ping 的 gap，这里不留外边距
          // ★ 防遮挡：顶栏被塞进第三个药丸后，窄屏（手机横屏）会把它挤到
          // 「回合 / LP / 兵力」那一栏上面去。这里让它可收缩、可裁切，
          // 永远不撑破所在的行；同时给父行加 flex-wrap:nowrap + min-width:0。
          force(el, { 'max-width': 'min(24rem, 38vw)', overflow: 'hidden', 'flex-shrink': '1' });
          if (pingRow) force(pingRow, { 'flex-wrap': 'nowrap', 'min-width': '0', 'max-width': '100%' });
          if (!pingRow.dataset.mmCal) {
            pingRow.dataset.mmCal = '1';
            setTimeout(place, 120);
            setTimeout(place, 400);
          }
          return;
        }
      }
      // 离开房间后清理临时容器
      const staleMeter = document.querySelector('.mm-proto-meter');
      if (staleMeter) staleMeter.remove();
      el.classList.remove('ping');
      for (const k of ['min-height', 'max-height', 'padding-top', 'padding-bottom', 'border-radius',
        'background', 'border', 'font-family', 'font-weight', 'font-size',
        'z-index', 'max-width', 'overflow', 'flex-shrink']) {
        el.style.removeProperty(k);
      }
      // .chip 上的药丸样式也要撤掉，否则回到大厅/标题页时会带着对局的框和底色
      {
        const c = el.querySelector('.chip');
        if (c) {
          for (const k of ['background', 'border', 'border-radius', 'padding', 'min-height', 'box-sizing']) {
            c.style.removeProperty(k);
          }
        }
      }

      if (onTitle || (start && start.getClientRects().length)) {
        // 标题页：放进右上角工具条，排在「公告」按钮左边，样式与按钮一致。
        // 锚点必须是「不会自我重建」的元素：公告按钮 mm-notice-btn 由另一处定时器维护，
        // 偶尔会被移除重建，用它当 insertBefore 锚点会让节点状态在 984/1087 两个位置来回跳。
        // 这里优先用稳定的 .title-stats / 语言选择器，退而求其次才用公告按钮。
        const notice = document.getElementById('mm-notice-btn');
        const hostBtn = document.querySelector('button.title-stats')
          || document.querySelector('.title-corner__tools .title-lang')
          || notice
          || [...document.querySelectorAll('button')].find((b) => /S\.W\.E\.E\.P/i.test((b.textContent || '').trim()));
        // 真正要排在左边的那个按钮（视觉上与「公告」相邻）
        const anchor = notice && notice.parentElement === hostBtn?.parentElement ? notice : hostBtn;
        if (anchor && anchor.parentElement) {
          // 只在顺序真的不对时才移动：位置正确就一个 DOM 操作都不做
          if (el.parentElement !== anchor.parentElement || el.nextElementSibling !== anchor) {
            anchor.parentElement.insertBefore(el, anchor);
          }
          // 只在值真的变化时才写：place() 每 1.2s 跑一次，无条件赋值 style/class 会让浏览器
          // 反复重排重绘，表现为右上角按钮持续「抖一下」的刷新感。
          const setIf = (k, v) => { if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); };
          setIf('display', 'inline-flex');
          setIf('position', 'static');
          setIf('left', 'auto');
          setIf('right', 'auto');
          setIf('top', 'auto');
          setIf('transform', 'none');
          setIf('margin', '0 8px 0 0');
          if (!el.classList.contains('topbar')) el.classList.add('topbar');
          // 直接沿用「公告」按钮的图标与文字排版，保证同款
          try {
            const chipEl = el.querySelector('.chip');
            if (chipEl) {
              const dot = chipEl.querySelector('i');
              if (dot) dot.style.display = 'none';
              let icon = chipEl.querySelector('svg.mm-chip-icon');
              if (!icon && anchor.querySelector('svg')) {
                icon = anchor.querySelector('svg').cloneNode(true);
                icon.classList.add('mm-chip-icon');
                icon.style.marginRight = '6px';
                chipEl.insertBefore(icon, chipEl.firstChild);
              }
            }
          } catch { /* ignore */ }
          // 外观与「公告」按钮完全一致：直接套用它自己的 class（含 hover 效果）
          try {
            // 注意：CSSStyleDeclaration 读回的是「计算后的规范值」——颜色变 rgb()、
            // margin 变 "0px 10px 0px 0px"，拿写进去的字面量去比对永远不等，
            // 于是每轮都重写一遍 style，浏览器就一直重排重绘（右键头闪的来源）。
            // 这里统一用「解析后的规范值」比较，或干脆按已存在就跳过。
            const setStyleOnce = (elm, prop, canon) => {
              const cur = elm.style.getPropertyValue(prop);
              if (cur === canon) return;
              // 把写进去的值交给浏览器解析一次，再读回规范形式来比
              const probe = document.createElement('div');
              probe.style.setProperty(prop, canon);
              if (cur === probe.style.getPropertyValue(prop)) return;
              elm.style.setProperty(prop, canon);
            };
            setStyleOnce(el, 'color', '#ffffff');
            setStyleOnce(el, 'background', 'transparent');
            const chipEl = el.querySelector('.chip');
            if (chipEl) {
              // className 整体赋值会重建所有 class 触发重绘：值没变就不要写
              const want = anchor.className + ' chip';
              if (chipEl.className !== want) chipEl.className = want;
              setStyleOnce(chipEl, 'cursor', 'pointer');
              // 与公告/统计等按钮使用同一套间距（克隆按钮自带 10px 右边距）
              setStyleOnce(el, 'margin', '0 10px 0 0');
              setStyleOnce(el, 'padding', '0');
              setStyleOnce(el, 'height', 'auto');
            }
          } catch { /* ignore */ }
          return;
        }
        // 工具条还没渲染出来：先固定在左上角，下个周期再归位
        el.style.display = '';
        el.style.position = 'fixed';
        el.style.left = '16px';
        el.style.top = '16px';
        el.style.transform = 'none';
        el.style.margin = '0';
        el.classList.remove('topbar');
        setTimeout(place, 500);
        return;
      }
      if (!ping || !ping.getClientRects().length) { if (el.style.display !== 'none') el.style.display = 'none'; return; }

      // ★ 对局中（.gtop 顶栏）：只作为一个安静的小药丸待在延迟旁边，
      //   **绝不改动它父容器的布局**。
      //   以前这里会无条件把父容器设成 display:flex + gap:10px，
      //   而 .gtop__net 里除了延迟还并排放着 .gtop__meta 下的「难度标签」（截图里的「维多利亚 正常」）。
      // ★ 对局中（.gtop 顶栏）：**只做定位，不改外观**。
      //   胶囊的外观由 `#mm-nodes:not(.topbar) .chip` 这条全局规则统一决定
      //   （黑底、薄荷绿 1px 描边、99px 圆角）—— 标题页、大厅、房间、对局中
      //   应该是同一个样子，只有里面的字在不同界面显示不同内容
      //   （大厅显示「30/30 · 正常 · N 人在线」，对局中显示「当前节点名 · 状态」）。
      //
      //   之前这里写死了 padding / font-size / background / border / color，
      //   等于给对局中另做了一套外观，和别处不一致 —— 玩家反馈
      //   「电脑端的节点状态按钮外观直接跟原来不一样了」。
      //
      //   真正需要修的只有布局：以前无条件把父容器改成 display:flex + gap:10px，
      //   把「难度标签」挤到了右边、压住「回合」进度条。现在只把胶囊放进
      //   .gtop__net，不动父容器，并清掉 #mm-nodes 全局的 position:fixed / z-index:46
      //   残留（否则会盖住顶栏按钮）。
      if (ping.closest('.gtop')) {
        const net = ping.parentElement;                 // .gtop__net
        if (net && el.parentElement !== net) net.appendChild(el);
        const s = (k, v) => { if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); };
        s('position', 'static');
        s('left', 'auto'); s('right', 'auto'); s('top', 'auto');
        s('transform', 'none');
        s('display', 'inline-flex');
        s('align-items', 'center');
        s('z-index', 'auto');                            // 清掉全局的 46，别盖住顶栏
        s('margin', '0 0 0 8px');                        // 与延迟药丸的间距
        s('flex', '0 1 auto');
        s('max-width', 'min(24rem, 42vw)');              // 窄屏不撑破那一行
        s('overflow', 'hidden');
        // 用非 topbar 的那套统一外观（和标题页/大厅/房间一致）
        if (el.classList.contains('topbar')) el.classList.remove('topbar');
        // ★ 清掉历史上可能残留的内联覆盖（旧版本写过 padding/background/border/字号），
        //   让全局规则重新生效。只清这几个，不动布局相关的。
        {
          const chipEl = el.querySelector('.chip');
          if (chipEl) {
            for (const k of ['padding', 'font-size', 'font-weight', 'background', 'border', 'border-radius', 'box-sizing', 'line-height', 'color', 'white-space', 'justify-content']) {
              chipEl.style.removeProperty(k);
            }
            // 内部小圆点也交回全局规则
            for (const dot of chipEl.querySelectorAll('i')) {
              dot.style.removeProperty('width');
              dot.style.removeProperty('height');
              dot.style.removeProperty('margin-right');
              dot.style.removeProperty('border-radius');
            }
          }
        }
        return;
      }

      // 其它界面：插到延迟后面作为行内元素。大厅里 Q群按钮和节点状态同处一行，
      // 顺序固定为 [延迟] [Q群] [节点状态] | [工具组]；
      // 注意不能每轮都把节点状态硬插到 ping 后面 —— 那会把 Q群挤到后面，
      // 两个元素互相抢位置，表现出来就是「一跳一跳」。
      // 同理，style 只在值变化时才写，否则每 1.2s 的无条件赋值本身就是一次重绘。
      const setIf2 = (k, v) => { if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); };
      setIf2('position', 'relative');
      setIf2('left', 'auto');
      setIf2('right', 'auto');
      setIf2('top', 'auto');
      setIf2('transform', 'none');
      setIf2('margin', '0 0 0 10px');
      setIf2('display', 'inline-flex');
      if (el.classList.contains('topbar')) el.classList.remove('topbar');
      // 把“延迟 + 角标”强制排成一行（与选择模拟协议界面一致）
      let host = ping.parentElement;
      for (let k = 0; k < 3 && host && host.getBoundingClientRect().width < 60; k++) host = host.parentElement;
      if (host) {
        if (host.dataset.mmRow !== '1') {
          host.dataset.mmRow = '1';
          host.style.display = 'flex';
          host.style.flexDirection = 'row';
          host.style.alignItems = 'center';
          host.style.gap = '10px';
        }
        // 期望顺序：ping → 本节点状态（大厅里 Q群在右侧工具组，不参与这里）
        const qq = document.getElementById('mm-qq-lobby');
        const inTools = qq && qq.parentElement && qq.parentElement.classList.contains('topbar__tools');
        const wantPrev = inTools ? ping : ((qq && qq.parentElement === host && qq.isConnected) ? qq : ping);
        // 只有「位置确实不对」时才动 DOM，且只动一次，避免周期性重排造成的跳动
        if (el.parentElement !== host) host.appendChild(el);
        if (el.previousElementSibling !== wantPrev) {
          wantPrev.insertAdjacentElement('afterend', el);
        }
      } else if (ping.nextElementSibling !== el && ping.parentElement) {
        ping.insertAdjacentElement('afterend', el);
      }
    };
    const attach = () => {
      if (!el.isConnected) document.body.appendChild(el);
      place();
      // 定时器只注册一次：attach 会被 render() 每秒调用，若在这里 setInterval，
      // 会不断叠加定时器，多个 place() 同时抢位置 —— 界面就会「一跳一跳」。
      if (!attach.__timers) {
        attach.__timers = true;
        setInterval(place, 1200);
        window.addEventListener('resize', place);
      }
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);


    const openStatusModal = () => {
      if (!data) return;
      if (document.getElementById('mm-status-modal')) return;
      const veil = document.createElement('div');
      veil.id = 'mm-status-modal';
      veil.className = 'modal lobby-dialog';
      veil.innerHTML = '<div class="modal__box brackets modal__box--mint lobby-dialog server-status-modal server-status-modal--cluster" role="dialog" aria-modal="true" tabindex="-1">'
        + '<div class="modal__stripe" aria-hidden="true"></div>'
        + '<header class="modal__head"><span class="micro">SERVER STATUS</span><h2 class="modal__title">节点状态</h2></header>'
        + '<div class="modal__body"></div>'
        + '<footer class="modal__actions"><button type="button" class="btn btn--secondary">关闭</button></footer>'
        + '</div>';
      const body = veil.querySelector('.modal__body');
      const ready = data.online, total = data.total;
      body.innerHTML = '<div class="server-status__heading"><span>' + ready + ' / ' + total + ' 节点就绪</span>'
        + '<span class="server-status__window">刚刚更新</span></div>'
        + '<div class="server-status__table-wrap"><table class="server-status__table"><thead><tr>'
        + '<th>节点</th><th>状态</th><th>人数</th><th>对局</th></tr></thead><tbody>'
        + data.nodes.map((x) => '<tr class="' + (x.ok ? 'ok' : 'off') + '">'
          + '<td><span class="server-status__dot"></span>' + x.name + '</td>'
          + '<td>' + (x.ok ? '正常' : '离线') + '</td>'
          + '<td class="num">' + (x.ok ? x.humans : '--') + '</td>'
          + '<td class="num">' + (x.ok ? x.matches : '--') + '</td></tr>').join('')
        + '</tbody></table></div>';
      const close = () => veil.remove();
      veil.querySelector('.modal__actions button').onclick = close;
      veil.addEventListener('click', (e) => { if (e.target === veil) close(); });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
      });
      document.body.appendChild(veil);
    };

    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.classList.contains('match') || !data) return;
      // 标题页只显示在线人数，不提供节点状态面板
      if (document.querySelector('.title-screen')) return;
      openStatusModal();
      return;
      open = !open;
      panel.hidden = !open;
      if (open) {
        const ready = data.online, total = data.total;
        panel.innerHTML = '<div class="server-status__heading"><span>' + ready + ' / ' + total + ' 节点就绪</span>'
          + '<span class="server-status__window">刚刚更新</span></div>'
          + '<div class="server-status__table-wrap"><table class="server-status__table"><thead><tr>'
          + '<th>节点</th><th>状态</th><th>人数</th><th>对局</th></tr></thead><tbody>'
          + data.nodes.map((x) => '<tr class="' + (x.ok ? 'ok' : 'off') + '">'
            + '<td><span class="server-status__dot"></span>' + x.name + '</td>'
            + '<td>' + (x.ok ? '正常' : '离线') + '</td>'
            + '<td class="num">' + (x.ok ? x.humans : '--') + '</td>'
            + '<td class="num">' + (x.ok ? x.matches : '--') + '</td></tr>').join('')
          + '</tbody></table></div>';
        // 定位：固定到角标下方（避免被顶栏的窄容器挤压）
        try {
          const r = el.getBoundingClientRect();
          panel.style.position = 'fixed';
          panel.style.left = Math.round(Math.min(r.left, window.innerWidth - 500)) + 'px';
          panel.style.top = Math.round(r.bottom + 8) + 'px';
          panel.style.width = '480px';
          panel.style.maxHeight = Math.min(window.innerHeight - r.bottom - 24, 720) + 'px';
        } catch { /* ignore */ }
      }
    });
    document.addEventListener('click', () => { open = false; panel.hidden = true; });

    const render = () => {
      const keep = panel.hidden ? 0 : panel.scrollTop;
      attach();
      if (!panel.hidden) panel.scrollTop = keep;
      const s = window.__SP__ && window.__SP__.store.get();
      const inMatch = !!(s && s.match && s.match.public);
      const sum = summary();
      // 只在值变化时写：tick 每 1.2s 跑一次，无条件写 dataset / classList / innerHTML
      // 会让浏览器不断重排重绘，右上角就表现为持续「刷新感」。
      const wantState = inMatch ? 'normal' : sum.state;
      if (el.dataset.state !== wantState) el.dataset.state = wantState;
      const setHtml = (node, html) => { if (node.innerHTML !== html) node.innerHTML = html; };
      if (inMatch) {
        if (!el.classList.contains('match')) el.classList.add('match');
        const n = nodeOf();
        const node = data && data.nodes.find((x) => x.n === n);
        const label = node ? node.name + ' · ' + (node.ok ? '正常' : '离线') : '当前节点';
        if (text.textContent !== label) text.textContent = label;
        panel.hidden = true;
        open = false;
        return;
      }
      if (el.classList.contains('match')) el.classList.remove('match');
      if (!data) return;
      // 标题页只显示「服务器在线总人数」，其它界面仍显示节点概览
      if (document.querySelector('.title-screen')) {
        setHtml(text, '在线 <span class="num">' + sum.humans + '</span> 人');
        return;
      }
      setHtml(text, '<span class="num">' + sum.ready + '/' + sum.total + '</span> · ' + LOAD_TEXT[sum.state] + ' · <span class="num">' + sum.humans + '</span> 人在线');
    };

    // 数据没变化就不重渲染：render() 每秒跑一次，无谓的 DOM 写入会让右上角一直「刷新」。
    let lastSig = '';
    const load = () => fetch('/mm/api/node-status')
      .then((r) => r.json())
      .then((d) => {
        data = d;
        let sig = '';
        try { sig = JSON.stringify(d); } catch { sig = String(Date.now()); }
        if (sig !== lastSig) { lastSig = sig; render(); }
      })
      .catch(() => {});
    attach();
    load();
    setInterval(load, 15000);
    setInterval(render, 1000);
    const sp = window.__SP__;
    if (sp && sp.store) sp.store.subscribe(render);
  }

  // 大厅「同盟模拟」卡片上加一句匹配提示，告诉玩家房间里可以匹配队友
  function installModeHint() {
    // 「支持匹配队友 / 可调整人数」这两句已经移到卡片**上方**的说明行
    // （public/js/screens/lobby.js 的 pointExtra，按语序排列），
    // 卡片内部不再额外塞一行 —— 以前压在里面既和标题挤在一起，又把卡片撑宽。
    // 这里只负责把旧版本残留在卡片里的 .mm-mode-hint 清掉。
    const stale = document.querySelector('.hub-entry--coop .mm-mode-hint');
    if (stale) stale.remove();
  }

  function addFoundBack() {
    const panel = document.getElementById('mm-ov-panel');
    if (!panel || panel.querySelector('#mm-ov-back')) return;
    const b = document.createElement('button');
    b.id = 'mm-ov-back';
    b.type = 'button';
    b.textContent = '返回房间';
    b.style.cssText = 'margin-top:14px;padding:8px 18px;border-radius:6px;border:1px solid rgba(78,216,175,.5);background:rgba(8,14,18,.6);color:#9fe8d2;cursor:pointer;font:13px/1.2 "Noto Sans SC",system-ui,sans-serif';
    b.onclick = () => { location.href = '/'; };
    panel.appendChild(b);
  }

  function hideOverlay() {
    const ov = document.getElementById('mm-overlay');
    if (ov) ov.remove();
  }

  // 成功返回 true（已排好跳转）；pin 失败或缺少跳转参数返回 false，让调用方下一轮重试
  async function enterParty(st) {
    const sp0 = window.__SP__;
    // 主房间成员（人数最多的一队）留在原房间，不跳转、不重新建房；
    // 显式 room.join 一次，幂等刷新房主的 room.state，避免停留在旧的 1/4 状态。
    if (st.home && st.code) {
      try { hideOverlay(); } catch { /* ignore */ }
      try { showTransition(); } catch { /* ignore */ }
      try { await sp0.net.request('room.join', { code: st.code }); } catch { /* ignore */ }
      try { installAutoStart(sp0); } catch { /* ignore */ }
      try { await sp0.net.request('room.matchmaking', { on: false }); } catch { /* ignore */ }
      return true;
    }
    // Pin first, then close the old room. Leaving before the pin used to lose the old
    // room when the pin failed; leaving at all is still required, otherwise the target
    // page's account resume restores the old room and never joins the matched one.
    try {
      await api(`/mm/api/party/pin?matchId=${encodeURIComponent(st.matchId)}&node=${st.node}`);
    } catch (e) {
      console.warn('[mm] 切换到匹配节点失败，稍后重试', e && e.message);
      return false;
    }
    try {
      if (sp0 && sp0.net && sp0.store && sp0.store.get().room) {
        await sp0.net.request('room.leave', {});
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch { /* not in a room */ }
    const sp = window.__SP__;
    const name = encodeURIComponent((sp && sp.store.get().me.name) || '');
    let target = '';
    if (st.leader) target = `/?mmhost=1&pmid=${encodeURIComponent(st.matchId)}&pcid=${encodeURIComponent(CLIENT_ID)}&pd=${encodeURIComponent(st.difficulty)}&mm=1&name=${name}`;
    else if (st.code) target = `/?room=${encodeURIComponent(st.code)}&n=${st.node}&mm=1&name=${name}`;
    if (!target) return false;
    setTimeout(() => { location.href = target; }, 900);
    return true;
  }

  // ---------------------------------------------------------------- 匹配成功后：房主自动建房


  // GUEST_HOST_GUARD：游客可以排队，但不能成为房主（不能自动建房）
  function guestHostBlocked() {
    if (typeof window !== 'undefined' && window.__SP_ACCOUNT_USER) return false;
    try { addFoundBack(); } catch { /* ignore */ }
    try {
      const t = document.querySelector('.mm-ov__foundtitle');
      if (t) t.textContent = '游客不能成为房主';
      const s = document.querySelector('.mm-ov__foundsub');
      if (s) s.textContent = '游客可以加入他人房间，但不能新建房间；请登录后再匹配';
    } catch { /* ignore */ }
    return true;
  }

  function partyHostFlow(sp) {
    console.info('[mm-debug] partyHostFlow start');
    const { store, net } = sp;
    let creating = false, createdOk = false, reported = false, attempts = 0, lastAt = 0;

    const report = (code) => {
      if (reported) return;
      reported = true;
      fetch('/mm/api/party/room', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matchId: PMID, clientId: PCID, code }),
      })
        .then((r) => r.json())
        .then((j) => { if (!j.ok) reported = false; else { console.log('[mm] 组队房间已回报', code); cleanUrl(); } })
        .catch(() => { reported = false; });
    };

    const tick = () => {
      const s = store.get();
      console.info('[mm-debug] party tick', { entered: s.session.entered, online: net.status, room: s.room && s.room.code, attempts });
      if (reported || !s.session.entered || net.status !== 'online') return;
      if (s.room && s.room.code) { report(s.room.code); return; }
      if (guestHostBlocked()) return;
      if (creating || createdOk || attempts >= 6 || Date.now() - lastAt < 2000) return;
      attempts += 1; lastAt = Date.now(); creating = true;
      net.request('room.create', { mode: 'coop', difficulty: PDIFF })
        .then(() => { createdOk = true; console.info('[mm-debug] party room.create ok'); })
        .catch((e) => { console.error('[mm] 自动建房失败', e && e.message); try { addFoundBack(); } catch { /* ignore */ } })
        .finally(() => { creating = false; });
    };

    store.subscribe(tick);
    tick();
    setInterval(() => { if (!reported) tick(); }, 1500);
  }

  // ---------------------------------------------------------------- 单人匹配（/mm/ 页面）

  function hostFlow(sp) {
    console.info('[mm-debug] hostFlow start');
    const { store, net } = sp;
    let creating = false, createdOk = false, reported = false, attempts = 0, lastAt = 0;

    const report = (code) => {
      if (reported) return;
      reported = true;
      fetch('/mm/api/room', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matchId: MID, ticketId: TICKET, secret: SECRET, code }),
      })
        .then((r) => r.json())
        .then((j) => { if (!j.ok) reported = false; else cleanUrl(); })
        .catch(() => { reported = false; });
    };

    const tick = () => {
      const s = store.get();
      if (reported || !s.session.entered || net.status !== 'online') return;
      if (s.room && s.room.code) { report(s.room.code); return; }
      if (guestHostBlocked()) return;
      if (creating || createdOk || attempts >= 3 || Date.now() - lastAt < 2000) return;
      attempts += 1; lastAt = Date.now(); creating = true;
      net.request('room.create', { mode: 'coop', difficulty: DIFF,
    ...(CAPACITY > 4 ? { experimental: { revivalEnabled: true, disableSharedPool: true, playerCapacity: CAPACITY, disableDuckLord: true } } : {}) })
        .then(() => { createdOk = true; console.info('[mm-debug] room.create ok'); })
        .catch((e) => console.warn('[mm] 自动建房失败', e && e.message))
        .finally(() => { creating = false; });
    };

    store.subscribe(tick);
    tick();
    setInterval(() => { if (!reported) tick(); }, 1500);
  }

  function mmToast(text) {
    try {
      const div = document.createElement('div');
      div.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:90;background:rgba(40,20,10,.95);border:1px solid #7a5a2a;color:#ffd9a8;padding:8px 14px;border-radius:10px;font:13px/1.6 "Noto Sans SC",sans-serif;max-width:90vw';
      div.textContent = text;
      document.body.appendChild(div);
      setTimeout(() => div.remove(), 6000);
    } catch { /* ignore */ }
  }

  function joinFlow(sp, code, spectate) {
    // 诊断：玩家反馈「跨节点后还要再输一次房间号」。每次调用都留痕，便于事后从控制台定位。
    try {
      console.info('[mm-debug] joinFlow', { code, spectate, route: (document.cookie.match(/sp_route=(\d+)/) || [])[1] });
    } catch { /* ignore */ }
    // Hidden admin watch is not a player deep-link: joining as a player would fail
    // with ROOM_FULL on a full room. A tab opened just after the watch closes must
    // discard its stale deep-link/pending join instead of surfacing an error.
    if (adminWatchActive() || watchExitRecent()) {
      try { console.info('[mm-debug] joinFlow 放弃：adminWatch 或刚退出观战'); } catch { /* ignore */ }
      try { sp.store.patch('ui', { pendingJoin: null, pendingSpectate: false }); } catch { /* ignore */ }
      try { sessionStorage.removeItem('mm.pendingRoom'); } catch { /* ignore */ }
      return;
    }
    const { store, net } = sp;
    let inFlight = false, joined = false, retries = 0;
    try { store.patch('ui', { pendingJoin: null }); } catch (e) { /* ignore */ }
    const tick = () => {
      if (adminWatchActive() || watchExitRecent()) { joined = true; return; }
      const s = store.get();
      // 跨节点跳转后不要卡在 `session.entered` 上：
      // entered 由 localStorage 里的「本机进入过」标记决定，跳到一个新节点后页面是全新上下文，
      // 它可能是 false，于是这里一直 return，room.join / room.spectate 一条都不发，
      // 玩家看到的就是「跳到新节点后又得重输一次房间号」。
      // 只要 socket 已连上（net.status === 'online'）就允许发请求；服务端会按会话状态自行处理。
      if (joined || inFlight || net.status !== 'online') return;
      // 已经在**目标房间**里才算加入完成。以前这里只判 `if (s.room)`：
      // 玩家手输密钥 → 跨节点刷新 → store 里还留着刷新前的房间（或另一个房间），
      // 于是立刻 joined = true，room.join 根本没发出去，表现为「要输第二次密钥才能进」。
      //
      // 观战还要看**席位**：自己已经在同一个房间里当玩家时，房间号相同，
      // 但 room.spectate 必须照发（否则点「观战」没有任何反应）。
      // 已经在这个房间的观战席上才算完成。
      const roomCode = s.room ? String(s.room.code).toUpperCase() : '';
      const targetCode = String(code).toUpperCase();
      const sameRoom = roomCode === targetCode;
      // 观战席的判定与游戏本体一致（store.js isSpectating）：room.spectators 里有自己
      const myId = (s.session && s.session.playerId) || null;
      const onSpectatorSeat = !!s.room && myId != null && Array.isArray(s.room.spectators)
        && s.room.spectators.some((x) => x && x.playerId === myId);
      if (sameRoom && (!spectate || onSpectatorSeat)) { joined = true; cleanUrl(); return; }
      inFlight = true;
      try {
        console.info('[mm-debug] joinFlow 发请求', {
          api: spectate ? 'room.spectate' : 'room.join', code,
          sameRoom, onSpectatorSeat, myId, roomCode,
        });
      } catch { /* ignore */ }
      net.request(spectate ? 'room.spectate' : 'room.join', { code })
        .then(() => { joined = true; cleanUrl(); })
        .catch((e) => {
          const msg = String((e && e.message) || '');
          const code2 = String((e && e.code) || '');
          try { console.warn('[mm-debug] joinFlow 失败', { api: spectate ? 'room.spectate' : 'room.join', code2, msg, retries }); } catch { /* ignore */ }
          // 确定性失败：重试多少次结果都一样，而且继续留着房号只会让玩家反复被弹提示。
          //   ROOM_STARTED  对局已经打起来了
          //   ROOM_FULL     房间满了
          //   ROOM_NOT_FOUND 房间根本不存在（已解散 / 换房 / 账号残留的旧房号）
          // 这类错误要把 /r/CODE 从地址里抹掉，并把所有"待加入"记录清空，
          // 否则玩家退回大厅或刷新时 joinFlow 会被再次触发，表现为反复提示加入失败。
          const terminal = code2 === 'ROOM_STARTED' || code2 === 'ROOM_FULL' || code2 === 'ROOM_NOT_FOUND'
            || /模拟已开始|房间已满|未找到该同盟密钥|不存在|已开始|Simulation already started|Room full|room is full|not found/i.test(msg);
          // 非终态失败（跨节点跳转后 socket 刚连上、会话还没就绪之类）先重试几次，
          // 不要一次失败就放弃 —— 那会让玩家以为「还得再输一次房间号」。
          if (!terminal && retries < 6) {
            retries++;
            return; // 交给下面的 setInterval 再 tick 一次
          }
          joined = true;
          if (terminal) {
            try { store.patch('ui', { pendingJoin: null, pendingSpectate: false }); } catch { /* ignore */ }
            // 清空所有可能让页面再次尝试加入的痕迹
            try { sessionStorage.removeItem('mm.pendingRoom'); } catch { /* ignore */ }
            try { sessionStorage.removeItem('sp.accountResume'); } catch { /* ignore */ }
            try { sessionStorage.removeItem('sp.accountResumeSilent'); } catch { /* ignore */ }
            try { localStorage.removeItem('sp.lastRoom'); } catch { /* ignore */ }
            try { document.cookie = 'sp_join=; Path=/; Max-Age=0; SameSite=Lax'; } catch { /* ignore */ }
            try {
              if (/^\/(r|room)\//i.test(location.pathname)) {
                history.replaceState(history.state, '', '/' );
              } else {
                cleanUrl();
              }
            } catch { /* ignore */ }
            // 同一对局只提示一次，避免玩家在大厅里被反复打扰
            const tagKey = 'mm.joinFail:' + code;
            let shown = false;
            try { shown = sessionStorage.getItem(tagKey) === '1'; sessionStorage.setItem(tagKey, '1'); } catch { /* ignore */ }
            if (!shown) showStyledToast((spectate ? '观战失败：' : '加入失败：') + msg);
          } else {
            showStyledToast((spectate ? '观战失败：' : '加入失败：') + (msg || '未知错误'));
          }
          console.warn('[mm] 加入房间失败', e && e.message);
        })
        .finally(() => { inFlight = false; });
    };
    store.subscribe(tick);
    tick();
    setInterval(() => { if (!joined) tick(); }, 1500);
  }

  // ---------------------------------------------------------------- 搜寻界面样式（复刻 fork 的 mf-search / mf-found）

  function installOverlayStyle() {
    if (document.getElementById('mm-ov-style')) return;
    const st = document.createElement('style');
    st.id = 'mm-ov-style';
    st.textContent = `
.mm-ov{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:rgba(4,8,7,.86);backdrop-filter:blur(6px);font:15px/1.6 "Microsoft YaHei",system-ui,sans-serif;color:#eef0ef}
.mm-ov__panel{display:flex;flex-direction:column;align-items:center;gap:12px;padding:26px 34px;text-align:center;
  background:linear-gradient(180deg,rgba(16,24,21,.96),rgba(8,12,11,.98));border:1px solid #24312c;min-width:min(92vw,560px)}
.mm-ov__brand{display:flex;gap:8px;align-items:center;font-size:12px;letter-spacing:.14em;color:#8d9391}
.mm-ov__rook{color:#4ed8af}
.mm-ov__title{display:flex;align-items:baseline;gap:10px;font-size:40px;font-weight:900;letter-spacing:.08em;text-shadow:0 0 24px rgba(255,255,255,.3)}
.mm-ov__dots{display:inline-block;width:1.2em;text-align:left}
.mm-ov__title small{font-size:.42em;font-weight:700;color:#c9cecc;font-family:Consolas,monospace}
.mm-ov__tags{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
.mm-ov__tag{padding:4px 16px;border-radius:999px;font-size:13px;font-weight:700;color:#eef0ef;
  background:color-mix(in srgb,var(--c) 26%,#1b1d1d);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 55%,transparent)}
.mm-ov__scene{position:relative;width:min(100%,420px);padding:10px 20px;overflow:hidden;contain:paint;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent);
  mask-image:linear-gradient(90deg,transparent,#000 10%,#000 90%,transparent)}
.mm-ov__scout{display:block;width:100%;height:auto;overflow:visible}
.mm-ov__wave{fill:none;stroke:rgba(78,216,175,.35);stroke-width:6;filter:blur(2px);animation:mmWave 3s ease-in-out infinite alternate}
@keyframes mmWave{to{transform:translateX(-12px)}}
.mm-ov__sky{fill:#48e2b6;opacity:.9;animation:mmSky 4s linear infinite}
@keyframes mmSky{from{transform:translateX(0)}to{transform:translateX(-120px)}}
.mm-ov__bot rect{fill:#5df0c6}.mm-ov__bot{animation:mmHop .5s steps(2) infinite}
@keyframes mmHop{50%{transform:translateY(-3px)}}
.mm-ov__eye{fill:#0b2620!important;animation:mmBlink 3s steps(1) infinite}
@keyframes mmBlink{0%,92%{opacity:1}94%,100%{opacity:0}}
.mm-ov__leg{animation:mmLeg .3s steps(2) infinite}.mm-ov__leg--b{animation-direction:reverse}
@keyframes mmLeg{50%{transform:translateY(-3px)}}
.mm-ov__ground{stroke:rgba(93,240,198,.5);stroke-width:2;stroke-dasharray:6 4}
.mm-ov__scout text{fill:#5df0c6;font:700 8px Consolas,monospace;letter-spacing:2px;opacity:.85}
.mm-ov__pop{color:#8d9391;font-size:13px}.mm-ov__pop b{color:#4ed8af;font-size:24px;font-family:Consolas,monospace;margin:0 4px}
.mm-ov__tip{margin:0;min-height:2.6em;max-width:520px;font-size:14px;color:#e6e9e8}
.mm-ov__stop{display:inline-flex;align-items:center;gap:10px;height:44px;padding:0 24px 0 12px;cursor:pointer;font:inherit;
  font-size:15px;font-weight:800;color:#ffd9d9;background:linear-gradient(90deg,rgba(120,24,34,.9),rgba(70,14,20,.9));
  border:1px solid rgba(255,120,130,.55)}
.mm-ov__stop:hover{filter:brightness(1.15)}
.mm-ov__found{display:flex;flex-direction:column;align-items:center;gap:10px;padding:34px 40px;text-align:center;min-width:min(92vw,520px);
  background:radial-gradient(80% 50% at 50% 30%,rgba(90,255,205,.3),transparent 70%),linear-gradient(180deg,#2bb892,#155f4d 55%,#0d3b31);
  animation:mmFoundIn .26s ease-out backwards}
@keyframes mmFoundIn{from{opacity:0;transform:translateX(24px)}}
.mm-ov__found .mm-ov__brand{color:#c9fff0}
.mm-ov__face{width:84px;height:84px}.mm-ov__face rect:first-child{fill:#5df0c6}
.mm-ov__faceeye{fill:#0d3b31}
.mm-ov__facewink,.mm-ov__facesmile{fill:none;stroke:#0d3b31;stroke-width:4;stroke-linecap:round}
.mm-ov__foundtitle{font-size:34px;font-weight:900;letter-spacing:.08em;color:#b7ffe8}
.mm-ov__foundsub{font-size:14px;color:#d5fff2}`;
    document.head.appendChild(st);
  }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opts));
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
    return j;
  }
})();

