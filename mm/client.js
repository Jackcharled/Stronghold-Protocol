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
  const PMID = q.get('pmid');
  const PCID = q.get('pcid');
  const PDIFF = q.get('pd');
  const PIN_NODE = Number(q.get('n')) || null;
  const AUTO_START = q.get('mm') === '1';
  // 只有带 &n=<节点> 的完整邀请链接才自动加入；只贴房号的链接不生效
  const ROOM_PINNED = !!(q.get('room') && Number(q.get('n')) > 0);

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
      ['room', 'n', 'name', 'mmhost', 'mid', 't', 'tk', 'd', 'pmid', 'pcid', 'pd', 'mm'].forEach((k) => {
        if (k === 'name' && keepName) return;   // 还没进入大厅前保留名字，进房后再清
        u.searchParams.delete(k);
      });
      const qs = u.searchParams.toString();
      history.replaceState(history.state, '', u.pathname + (qs ? '?' + qs : '') + u.hash);
    } catch (e) { /* ignore */ }
  }

  const __mmResponsiveCss = `
/* mm-responsive-v1：注入元素的尺寸随窗口缩放 */
#mm-nodes:not(.topbar) .chip{height:clamp(26px,2.2vw,32px);padding:0 clamp(9px,0.9vw,14px) 0 clamp(7px,0.75vw,11px)}
#mm-nodes:not(.topbar) .chip .num,#mm-nodes:not(.topbar) .chip span{font-size:clamp(11px,1.05vw,14px)}
#mm-room-timer{--bk-c:var(--mint-500);background:rgba(0,0,0,.38);border:1px solid var(--line);box-sizing:border-box;overflow:hidden}
#mm-room-timer .mm-timer-time{color:#7ff0cf;font-weight:700;font-family:"Noto Sans SC",system-ui,sans-serif;line-height:1.1}
#mm-room-timer .mm-timer-label{color:#a8c0b9;letter-spacing:.5px}
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

  function boot(sp) {
    try {
      if (!document.getElementById('mm-responsive-css')) {
        const s = document.createElement('style');
        s.id = 'mm-responsive-css';
        s.textContent = __mmResponsiveCss;
        document.head.appendChild(s);
      }
    } catch { /* ignore */ }
    const { store, net } = sp;
    installInviteCopy();
    installOverlayStyle();

    if (PIN_NODE && nodeOf() !== PIN_NODE) {
      api(`/mm/api/pin-node?node=${PIN_NODE}`).then(() => location.reload()).catch(() => {});
      return;
    }
    // 参数已经读进常量了：客人立刻把 ?room=&n=&name= 从地址栏抹掉，房主等建房回报后再清
    if (ROOM) cleanUrl();
    else if (PIN_NODE && !IS_HOST) cleanUrl();

    if (NAME && !store.get().session.entered) {
      try { store.set((s) => ({ ...s, me: { ...s.me, name: NAME }, session: { ...s.session, entered: true } })); } catch (e) { /* ignore */ }
      try { net.setName(NAME); } catch (e) { /* ignore */ }
    }

    if (IS_HOST && PMID && PCID) { partyHostFlow(sp); roomUi(sp); }
    else {
      if (IS_HOST && MID && TICKET && SECRET && DIFF) hostFlow(sp);
      else if (ROOM && ROOM_PINNED) joinFlow(sp, ROOM);
      else if (ROOM) resolveRoomNode(ROOM, () => joinFlow(sp, ROOM));
      roomUi(sp);
    }
    // 匹配成功的对局：不等房主手动点，自动准备 + 自动开始
    warnUnpinnedRoom();
    installJoinRedirect();
    installNodeBadge();
  installQQGroup();
  setInterval(cleanTopExtras, 1200);
  installAnnouncement();
  installTempNotice();
  installRoomBarShrink();

  installUnifiedStyle();

  installBackToAlliance();
  installAutoRejoin();
  installRoomCountdown();

  hideLatencyLabel();
  fixCenterButtons();
    if (AUTO_START) { installAutoStart(sp); showTransition(); }
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

  function installAutoStart(sp) {
    const { store, net } = sp;
    let readySent = false, startSent = false, enteredAt = Date.now(), autoDone = false;

    const tick = () => {
      const s = store.get();
      const room = s.room;
      if (s.match && s.match.public) { autoDone = true; hideTransition(); return; }   // 已经开始
      if (autoDone) return;   // 已经开过一局：返回房间后不要自动重开
      if (!room) { enteredAt = Date.now(); readySent = false; startSent = false; return; }
      const me = s.me.playerId;
      const humans = (room.seats || []).filter(Boolean);
      const isHost = room.hostId === me;

      if (!isHost) {
        const mine = humans.find((x) => x.playerId === me);
        if (mine && !mine.ready && !readySent) {
          readySent = true;
          net.request('room.ready', { ready: true }).catch(() => { readySent = false; });
        }
        return;
      }
      if (startSent) return;
      const others = humans.filter((x) => x.playerId !== me);
      const allReady = others.length > 0 && others.every((x) => x.ready && x.connected !== false);
      const full = humans.length >= 4;
      const waited = Date.now() - enteredAt;
      // 4 人齐且都准备 → 立刻开始；有人掉队时 25 秒后按已到人数开始，避免一直等
      if (allReady && (full || waited > 25000)) {
        startSent = true;
        net.request('room.start').catch(() => { startSent = false; });
      }
    };

    store.subscribe(() => { clearTimeout(tick._t); tick._t = setTimeout(tick, 80); });
    setInterval(tick, 900);
    tick();
  }


  const MODE_NAMES = { FUNNY: '标准模拟', NORMAL: '险境模拟', HARD: '绝境模拟', ABYSS: '终极模拟' };

  /** 按房号查房间在哪个节点；不在本节点就写 cookie 切过去，同节点则继续本地加入。 */
  function resolveRoomNode(code, onSameNode) {
    fetch('/mm/api/find-room?code=' + encodeURIComponent(code))
      .then((r) => r.json())
      .then((d) => {
        const cur = nodeOf();
        if (d && d.node && d.node !== cur) {
          document.cookie = 'sp_node=' + d.node + '; path=/; max-age=86400';
          const u = new URL(location.href);
          u.searchParams.set('room', code);
          u.searchParams.delete('n');
          location.replace(u.pathname + '?' + u.searchParams.toString());
          return;
        }
        if (d && d.node === cur) { onSameNode && onSameNode(); return; }
        onSameNode && onSameNode();   // 目录里还没有（刚建），交给本节点尝试
      })
      .catch(() => { onSameNode && onSameNode(); });
  }

  /** 大厅「加入同盟」：先解析节点，必要时切过去再加入。 */
  function installJoinRedirect() {
    let bypass = false;
    document.addEventListener('click', (e) => {
      if (bypass) return;
      const btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!btn || !/加入同盟/.test(btn.textContent || '')) return;
      const input = document.querySelector('input');
      const raw = input ? String(input.value || '') : '';
      const m = raw.toUpperCase().match(/\b([A-Z]{4})\b/);
      if (!m) return;
      const code = m[1];
      e.preventDefault();
      e.stopPropagation();
      fetch('/mm/api/find-room?code=' + encodeURIComponent(code))
        .then((r) => r.json())
        .then((d) => {
          if (d && d.node && d.node !== nodeOf()) {
            document.cookie = 'sp_node=' + d.node + '; path=/; max-age=86400';
            location.replace('/?room=' + encodeURIComponent(code));
            return;
          }
          bypass = true;
          btn.click();
          setTimeout(() => { bypass = false; }, 500);
        })
        .catch(() => { bypass = true; btn.click(); setTimeout(() => { bypass = false; }, 500); });
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
    let queued = false, matched = false, polling = false, entering = false;
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
      // 每个同盟房间都显示「匹配队友」，但只有房主可以点（其余人置灰）
      const show = !!room && !inMatch && !full && !autoArmed;
      let el = document.getElementById('mm-room-btn');
      if (!show) { if (el) el.remove(); return; }
      if (!el || !document.body.contains(el)) {
        const anchor = document.createElement('span');
        anchor.id = 'mm-room-anchor';
        anchor.className = 'tt-anchor';
        anchor.style.cssText = 'margin-right:10px';
        const bar = document.querySelector('.room-bar');
        if (!bar) return;
        // 直接克隆「开始模拟」按钮，尺寸与样式完全一致
        const startBtn = [...bar.querySelectorAll('button')]
          .find((b) => /开始模拟/.test(b.textContent || '') && b.offsetParent);
        if (startBtn) {
          const clone = startBtn.cloneNode(true);
          clone.id = 'mm-room-btn';
          clone.type = 'button';
          clone.className = startBtn.className;
          clone.disabled = false;
          const label = clone.querySelector('.btn__label');
          if (label) label.textContent = '匹配队友';
          else clone.textContent = '匹配队友';
          anchor.appendChild(clone);
        } else {
          anchor.innerHTML = '<button type="button" id="mm-room-btn" class="btn btn--secondary">'
            + '<span class="btn__label">匹配队友</span></button>';
        }
        // 放在右侧「开始模拟」按钮左边（与它成对）
        const action = [...bar.querySelectorAll('button')].find((b) => /开始模拟|准备就绪|已就绪/.test(b.textContent || ''));
        const target = action ? (action.closest('.tt-anchor') || action) : null;
        if (target) target.parentElement.insertBefore(anchor, target);
        else bar.appendChild(anchor);
        el = document.getElementById('mm-room-btn');
        el.addEventListener('click', onClick);
      }
      // 同步开始模拟按钮的样式（主按钮、同尺寸）
      try {
        const startBtn = [...document.querySelectorAll('button')].find((b) => /开始模拟/.test(b.textContent || '') && b.offsetParent);
        if (startBtn && startBtn.className) {
          el.className = startBtn.className;
          el.id = 'mm-room-btn';
        }
      } catch { /* ignore */ }
      el.querySelector('.btn__label').textContent = matched ? '正在分配…' : queued ? '取消匹配' : '匹配队友';
      const hasBot = (room && (room.seats || []).some((x) => x && x.isBot)) === true;
      el.disabled = matched || !isHost || hasBot;
      if (hasBot) el.title = '房间内有 AI 队友，无法匹配（请先移除 AI 队友）';
      el.title = isHost ? '把整个房间投入匹配池' : '仅房主可以发起匹配';
    };

    const onClick = async () => {
      const s = store.get();
      const room = s.room;
      if (!room || room.hostId !== s.me.playerId) return;
      try {
        if (!queued) {
          const r = await api('/mm/api/party/join', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              roomCode: room.code, node: nodeOf(), difficulty: room.difficulty,
              size: Math.max(1, seatsOf(room)), clientId: CLIENT_ID,
            }),
          });
          if (r.error) { alert(r.error); return; }
          queued = true;
          showSearch(room.difficulty, r.state && r.state.waiting, true);
        } else {
          await api('/mm/api/party/leave', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ roomCode: room.code, node: nodeOf(), clientId: CLIENT_ID }),
          });
          queued = false;
          hideOverlay();
        }
      } catch (e) {
        // 取消时出错也先把界面收起来（下一轮轮询会纠正真实状态），避免弹出让人卡住的对话框
        if (queued) { queued = false; hideOverlay(); } else { alert(e.message); }
      }
      ensureButton();
    };

    const tick = async () => {
      installModeHint();
      ensureButton();
      const s = store.get();
      const room = s.room;
      // 地址栏只保留域名：房间码 / 节点 / 代号这些参数处理完就清掉
      if (room && (location.search.includes('room=') || location.search.includes('n=') || location.search.includes('name='))) cleanUrl();
      if (!room || polling || seatsOf(room) >= 4 || room.inMatch) return;
      // 房间里有 AI 队友时不参与匹配（AI 无法跨节点加入）
      if ((room.seats || []).some((x) => x && x.isBot)) {
        if (queued) { queued = false; matched = false; hideOverlay(); }
        ensureButton();
        return;
      }
      polling = true;
      try {
        const st = await api(`/mm/api/party/state?code=${encodeURIComponent(room.code)}&node=${nodeOf()}&client=${encodeURIComponent(CLIENT_ID)}`);
        if (st.state === 'queued') {
          if (!queued) { queued = true; showSearch(room.difficulty, st.waiting, room.hostId === s.me.playerId); }
          updateSearch(st.waiting);
          ensureButton();
        } else if (st.state === 'matched') {
          queued = false;
          matched = true;
          ensureButton();
          showFound(st.leader ? '正在创建对局…' : '正在连接游戏节点…');
          if ((st.code || st.leader) && !entering) { entering = true; await enterParty(st); }
        } else if (st.state === 'idle' && queued) {
          queued = false;
          hideOverlay();
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
        document.getElementById('mm-ov-tip').textContent = TIPS[tipIndex];
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
    let hadMatch = false;
    let offline = false;
    sp.store.subscribe(() => {
      const s = sp.store.get();
      const status = s.connection && s.connection.status;
      if (s.match && s.match.public) hadMatch = true;
      if (status !== 'online') { offline = true; return; }
      if (!offline) return;
      offline = false;
      if (!hadMatch || !s.room || (s.match && s.match.public)) return;
      hadMatch = false;
      showBackPanel();
    });
  }

  function showBackPanel() {
    if (document.getElementById('mm-back')) return;
    const style = document.createElement('style');
    style.textContent = `
      #mm-back{position:fixed;inset:0;z-index:93;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6)}
      #mm-back .card{min-width:340px;max-width:520px;background:#0c1215;border:1px solid #2c4a4e;border-radius:14px;padding:22px 24px;color:#dff5ee;font:14px/1.8 "Noto Sans SC",system-ui,sans-serif;text-align:center}
      #mm-back h3{margin:0 0 6px;color:#7ff0cf;font-size:19px}
      #mm-back p{margin:6px 0 16px;color:#b9d6cc}
      #mm-back button{background:#1b4d43;border:1px solid #2f7f6c;color:#c9ffef;border-radius:8px;padding:8px 22px;cursor:pointer;font-size:14px}
    `;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = 'mm-back';
    box.innerHTML = '<div class="card"><h3>上一局模拟已中断</h3><p>服务器重启后对局无法继续，你已回到同盟房间。</p><button>返回同盟</button></div>';
    box.querySelector('button').onclick = () => box.remove();


    document.body.appendChild(box);
  }



  // ---------------------------------------------------------------- 重启后自动回到上次的房间（会话丢失时兜底）

  function installAutoRejoin() {
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
    const LIMIT = 15 * 60 * 1000;
    const fallbackCreated = new Map();

    const tick = () => {
      const s = sp.store.get();
      const room = s.room;
      if (!room || (s.match && s.match.public)) {
        const dead = document.getElementById('mm-room-timer');
        if (dead) dead.remove();
        return;
      }
      let createdAt = Number(room.createdAt) || 0;
      if (!createdAt) {
        const code = room.code || '(none)';
        if (!fallbackCreated.has(code)) fallbackCreated.set(code, Date.now());
        createdAt = fallbackCreated.get(code);
      }
      if (createdAt > Date.now()) createdAt = Date.now();
      const left = Math.max(0, Math.min(LIMIT, createdAt + LIMIT - Date.now()));
      const mm = Math.floor(left / 60000);
      const ss = Math.floor((left % 60000) / 1000);
      const timeText = String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');

      // 每次都按 id 取，避免引用被移除的旧节点
      let box = document.getElementById('mm-room-timer');
      if (!box) {
        box = document.createElement('div');
        box.id = 'mm-room-timer';
        box.className = 'invite brackets';
        document.body.appendChild(box);
      }
      box.innerHTML = '<span class="mm-timer-time">' + timeText + '</span>'
        + '<span class="mm-timer-label">后同盟将自动销毁</span>';

      // 找到同盟密钥面板（用「复制密钥」按钮定位），尺寸/位置完全跟随它
      try {
        const copyEl = [...document.querySelectorAll('button,span,div')]
          .find((n) => (n.textContent || '').trim() === '复制密钥');
        // 向上找到真正的「同盟密钥」面板（同时包含标题与复制按钮的容器）
        let panel = copyEl;
        for (let k = 0; k < 10 && panel; k++) {
          const txt = panel.textContent || '';
          if (txt.includes('同盟密钥') && txt.includes('复制密钥')) break;
          panel = panel.parentElement;
        }
        const rect = panel ? panel.getBoundingClientRect() : null;
        if (rect && rect.width >= 140) {
          const w = Math.max(120, Math.round(rect.width * 0.45));
          const h = Math.max(48, Math.round(rect.height * 0.7));
          let left = Math.round(rect.left - w - 16);
          left = Math.max(8, Math.min(left, Math.round(rect.left - w - 8)));
          box.style.position = 'fixed';
          box.style.width = w + 'px';
          box.style.height = h + 'px';
          box.style.left = left + 'px';
          box.style.top = Math.round(rect.top + rect.height / 2 - h / 2) + 'px';
          box.style.transform = 'none';
          box.style.right = 'auto';
          box.style.display = 'flex';
          box.style.flexDirection = 'column';
          box.style.alignItems = 'center';
          box.style.justifyContent = 'center';
          box.style.padding = '0';
          box.style.fontSize = Math.round(h * 0.18) + 'px';
          const tEl = box.querySelector('.mm-timer-time');
          const lEl = box.querySelector('.mm-timer-label');
          if (tEl) tEl.style.fontSize = Math.round(h * 0.36) + 'px';
          if (lEl) lEl.style.fontSize = Math.round(h * 0.15) + 'px';
        } else {
          // 找不到面板时放到右上角，避免跑到左上角挡按钮
          box.style.position = 'fixed';
          box.style.width = '200px';
          box.style.height = '68px';
          box.style.right = '360px';
          box.style.top = '28px';
          box.style.left = 'auto';
          box.style.display = 'flex';
          box.style.flexDirection = 'column';
          box.style.alignItems = 'center';
          box.style.justifyContent = 'center';
        }
      } catch { /* ignore */ }
    };

    sp.store.subscribe(tick);
    setInterval(tick, 500);
    setTimeout(tick, 50);
    setTimeout(tick, 300);
    window.addEventListener('resize', tick);
    tick();
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


  // ---------------------------------------------------------------- 官方 QQ 群（右上角）

  // 顶部按钮助手：克隆「统计」按钮的样式与图标位，替换图标路径与文字
  function ensureTopButton(id, label, iconPath, onClick, beforeId, allowLobby) {
    const stat = document.querySelector('button.title-stats')
      || (allowLobby ? [...document.querySelectorAll('button')].find((b) => !b.id.startsWith('mm-') && /S\.W\.E\.E\.P/i.test((b.textContent || '').trim())) : null);
    const existing = document.getElementById(id);
    if (!stat) { if (existing) existing.style.display = 'none'; return null; }
    if (existing) { existing.style.display = ''; return existing; }
    const btn = document.createElement('button');
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
    stat.parentElement.insertBefore(btn, before || stat);
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
    btn.style.marginRight = '10px';
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
    const onTitle = !!document.querySelector('button.title-stats');
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
    const ICON = 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 5V6a2 2 0 0 1 2-2z';
    const ensure = () => ensureTopButton('mm-qq', '官方Q群：' + QQ, ICON, () => window.open(LINK, '_blank', 'noopener'), null, false);
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
#mm-ticker{position:fixed;top:9%;left:50%;transform:translateX(-50%);width:min(760px,92vw);height:30px;
  overflow:hidden;pointer-events:none;z-index:60}
#mm-ticker .line{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;
  white-space:nowrap;padding:0 24px;font:15px/1.3 "Noto Sans SC",system-ui,sans-serif;color:#e8f4ef;
  background:linear-gradient(90deg,transparent,rgba(10,14,12,.97) 10%,rgba(10,14,12,.97) 90%,transparent);
  border-top:1px solid rgba(255,198,0,.35);border-bottom:1px solid rgba(255,198,0,.35);
  animation:ticker-in .42s cubic-bezier(.2,.8,.2,1), ticker-out .38s ease-in-out 4.8s forwards}
@keyframes ticker-in{from{transform:translateX(80%);opacity:0}}
@keyframes ticker-out{to{transform:translateX(-40%);opacity:0}}
`;
      document.head.appendChild(st);
    }

    let queue = [];
    let showing = false;
    let lastKey = '';

    const strip = () => {
      let el = document.getElementById('mm-ticker');
      if (!el) {
        el = document.createElement('div');
        el.id = 'mm-ticker';
        document.body.appendChild(el);
      }
      return el;
    };

    const showNext = () => {
      if (showing) return;
      const text = queue.shift();
      if (!text) return;
      showing = true;
      const el = strip();
      const line = document.createElement('div');
      line.className = 'line';
      line.textContent = text;
      el.appendChild(line);
      setTimeout(() => {
        try { line.remove(); } catch { /* ignore */ }
        showing = false;
        showNext();
      }, 5600);
    };

    const poll = () => fetch('/mm/api/announcement', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      const key = d && d.enabled && d.text ? (d.updatedAt || d.text) : null;
      if (!key) { queue = []; return; }
      if (key === lastKey) return;
      lastKey = key;
      const lines = String(d.text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      queue = lines;
      showNext();
    }).catch(() => {});
    poll();
    setInterval(poll, 5000);
    setInterval(showNext, 800);
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
.announcement-state { display: flex; flex-direction: column; align-items: center; gap: .14rem; padding-block: .36rem; text-align: center; }
.announcement-state h3 { color: var(--text-hi); font-size: max(calc(.22 * var(--t)), 16px); }
.announcement-state p { font-size: max(calc(.17 * var(--t)), 14px); line-height: 1.6; }
.announcement-board .modal__body { display: flex; flex-direction: column; flex: 1; gap: 12px; overflow: hidden; }
.announcement-scroll { min-height: 0; flex: 1; overflow-y: scroll; overscroll-behavior: contain; scrollbar-gutter: stable; padding-right: 12px; }
.announcement-board .modal__actions .btn { min-height: 40px; font-size: max(calc(.17 * var(--t)), 14px); padding-inline: 16px; }
`;
      document.head.appendChild(st);
    }

    const open = () => {
      if (document.getElementById('mm-notice-modal')) return;
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
            pn.textContent = String(para);
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
      try { localStorage.setItem('mm.annDismissed', revision); } catch { /* ignore */ }
      const dot = document.querySelector('#mm-notice-btn .mm-dot');
      if (dot) dot.style.display = 'none';
    };

    const ensure = () => {
      const btn = ensureTopButton('mm-notice-btn', '公告', ICON, open, 'mm-qq', true);
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
    load();
    setInterval(load, 60000);
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
      const state = ready < data.total ? 'down' : humans >= 40 ? 'busy' : 'normal';
      return { state, humans, ready, total: data.total };
    };

    // 固定定位：不参与任何布局，避免把标题页的“已连接服务器”挤成竖排
    const place = () => {
      const start = [...document.querySelectorAll('button')].find((b) => /^开始\s*»?$/.test((b.textContent || '').trim()) && b.offsetParent);
      const ping = document.querySelector('.ping');
      if (start && start.getClientRects().length) {
        // 标题页：放进右上角工具条，排在「公告」按钮左边，样式与按钮一致
        const notice = document.getElementById('mm-notice-btn');
        const hostBtn = notice || document.querySelector('button.title-stats')
          || [...document.querySelectorAll('button')].find((b) => /S\.W\.E\.E\.P/i.test((b.textContent || '').trim()));
        if (hostBtn && hostBtn.parentElement) {
          if (el.parentElement !== hostBtn.parentElement || el.nextElementSibling !== hostBtn) {
            hostBtn.parentElement.insertBefore(el, hostBtn);
          }
          el.style.display = 'inline-flex';
          el.style.position = 'static';
          el.style.left = 'auto';
          el.style.right = 'auto';
          el.style.top = 'auto';
          el.style.transform = 'none';
          el.style.margin = '0 8px 0 0';
          el.classList.add('topbar');
          // 直接沿用「公告」按钮的图标与文字排版，保证同款
          try {
            const chipEl = el.querySelector('.chip');
            if (chipEl) {
              const dot = chipEl.querySelector('i');
              if (dot) dot.style.display = 'none';
              let icon = chipEl.querySelector('svg.mm-chip-icon');
              if (!icon && hostBtn.querySelector('svg')) {
                icon = hostBtn.querySelector('svg').cloneNode(true);
                icon.classList.add('mm-chip-icon');
                icon.style.marginRight = '6px';
                chipEl.insertBefore(icon, chipEl.firstChild);
              }
            }
          } catch { /* ignore */ }
          // 外观与「公告」按钮完全一致：直接套用它自己的 class（含 hover 效果）
          try {
            el.style.color = '#ffffff';
            el.style.background = 'transparent';
            const chipEl = el.querySelector('.chip');
            if (chipEl) {
              chipEl.className = hostBtn.className + ' chip';
              chipEl.style.cssText = 'cursor:pointer';
              // 与公告/统计等按钮使用同一套间距（克隆按钮自带 10px 右边距）
              el.style.margin = '0 10px 0 0';
              el.style.padding = '0';
              el.style.height = 'auto';
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
      if (!ping || !ping.getClientRects().length) { el.style.display = 'none'; return; }
      // 其它界面：插到延迟后面作为行内元素，让按钮自动右移，避免遮挡
      el.style.position = 'relative';
      el.style.left = 'auto';
      el.style.right = 'auto';
      el.style.top = 'auto';
      el.style.transform = 'none';
      el.style.margin = '0 0 0 10px';
      el.style.display = 'inline-flex';
      el.classList.remove('topbar');
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
        if (el.previousElementSibling !== ping) ping.insertAdjacentElement('afterend', el);
      } else if (ping.nextElementSibling !== el) {
        ping.insertAdjacentElement('afterend', el);
      }
    };
    const attach = () => {
      if (!el.isConnected) document.body.appendChild(el);
      place();
    setInterval(place, 1200);
    window.addEventListener('resize', place);
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
      el.dataset.state = inMatch ? 'normal' : sum.state;
      if (inMatch) {
        el.classList.add('match');
        const n = nodeOf();
        const node = data && data.nodes.find((x) => x.n === n);
        text.textContent = node ? node.name + ' · ' + (node.ok ? '正常' : '离线') : '当前节点';
        panel.hidden = true;
        open = false;
        return;
      }
      el.classList.remove('match');
      if (!data) return;
      text.innerHTML = '<span class="num">' + sum.ready + '/' + sum.total + '</span> · ' + LOAD_TEXT[sum.state] + ' · <span class="num">' + sum.humans + '</span> 人在线';
    };

    const load = () => fetch('/mm/api/node-status').then((r) => r.json()).then((d) => { data = d; render(); }).catch(() => {});
    attach();
    load();
    setInterval(load, 15000);
    setInterval(render, 1000);
    const sp = window.__SP__;
    if (sp && sp.store) sp.store.subscribe(render);
  }

  // 大厅「同盟模拟」卡片上加一句匹配提示，告诉玩家房间里可以匹配队友
  function installModeHint() {
    const card = [...document.querySelectorAll('.mode-card')].find((c) => /同盟模拟/.test(c.textContent || ''));
    if (!card || card.querySelector('.mm-mode-hint')) return;
    const host = card.querySelector('.mode-card__points') || card;
    // 直接作为 .mode-card__points 的子项，沿用和其它两条一样的字号/加粗/菱形标记，只把颜色改成绿色
    const hint = document.createElement('span');
    hint.className = 'mm-mode-hint';
    hint.textContent = '支持「匹配队友」· 与等待中的博士组队';
    hint.style.color = '#4ed8af';
    host.appendChild(hint);
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

  async function enterParty(st) {
    try {
      await api(`/mm/api/party/pin?matchId=${encodeURIComponent(st.matchId)}&node=${st.node}`);
    } catch (e) { return; }
    const sp = window.__SP__;
    const name = encodeURIComponent((sp && sp.store.get().me.name) || '');
    if (st.leader) {
      setTimeout(() => {
        location.href = `/?mmhost=1&pmid=${encodeURIComponent(st.matchId)}&pcid=${encodeURIComponent(CLIENT_ID)}&pd=${encodeURIComponent(st.difficulty)}&mm=1&name=${name}`;
      }, 900);
    } else if (st.code) {
      setTimeout(() => {
        location.href = `/?room=${encodeURIComponent(st.code)}&n=${st.node}&mm=1&name=${name}`;
      }, 900);
    }
  }

  // ---------------------------------------------------------------- 匹配成功后：房主自动建房

  function partyHostFlow(sp) {
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
      if (reported || !s.session.entered || net.status !== 'online') return;
      if (s.room && s.room.code) { report(s.room.code); return; }
      if (creating || createdOk || attempts >= 6 || Date.now() - lastAt < 2000) return;
      attempts += 1; lastAt = Date.now(); creating = true;
      net.request('room.create', { mode: 'coop', difficulty: PDIFF })
        .then(() => { createdOk = true; })
        .catch((e) => { console.error('[mm] 自动建房失败', e && e.message); try { addFoundBack(); } catch { /* ignore */ } })
        .finally(() => { creating = false; });
    };

    store.subscribe(tick);
    tick();
    setInterval(() => { if (!reported) tick(); }, 1500);
  }

  // ---------------------------------------------------------------- 单人匹配（/mm/ 页面）

  function hostFlow(sp) {
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
      if (creating || createdOk || attempts >= 3 || Date.now() - lastAt < 2000) return;
      attempts += 1; lastAt = Date.now(); creating = true;
      net.request('room.create', { mode: 'coop', difficulty: DIFF })
        .then(() => { createdOk = true; })
        .catch((e) => console.warn('[mm] 自动建房失败', e && e.message))
        .finally(() => { creating = false; });
    };

    store.subscribe(tick);
    tick();
    setInterval(() => { if (!reported) tick(); }, 1500);
  }

  function joinFlow(sp, code) {
    const { store, net } = sp;
    let inFlight = false, joined = false;
    try { store.patch('ui', { pendingJoin: null }); } catch (e) { /* ignore */ }
    const tick = () => {
      const s = store.get();
      if (joined || inFlight || !s.session.entered || net.status !== 'online') return;
      if (s.room) { joined = true; return; }
      inFlight = true;
      net.request('room.join', { code })
        .then(() => { joined = true; cleanUrl(); })
        .catch((e) => console.warn('[mm] 加入房间失败', e && e.message))
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

