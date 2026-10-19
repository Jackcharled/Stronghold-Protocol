/* 卫戍协议：盟约 · 萝卜喵公益服 — 客户端注入脚本
 * 由 nginx sub_filter 注入到游戏页面末尾（<script src="/mm/client.js"></script>），不修改游戏本体文件。
 * 包含：节点状态角标、临时公告、更新公告、同盟密钥倒计时、匹配队友入口、界面精简。
 * 最后更新：2026-10-19
 */
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

  function boot(sp) {
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
    installAnnouncement();
    installUpdateNotice();

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
        anchor.innerHTML = '<button type="button" id="mm-room-btn" class="btn btn--secondary btn--xl">'
          + '<span class="btn__label">匹配队友</span></button>';
        const bar = document.querySelector('.room-bar');
        if (!bar) return;
        // 房主看到的是「开始模拟」，队员看到的是「准备就绪 / 已就绪」：都插在它前面
        const action = [...bar.querySelectorAll('button')].find((b) => /开始模拟|准备就绪|已就绪/.test(b.textContent || ''));
        const target = action ? (action.closest('.tt-anchor') || action) : null;
        if (target) target.parentElement.insertBefore(anchor, target);
        else bar.appendChild(anchor);
        el = document.getElementById('mm-room-btn');
        el.addEventListener('click', onClick);
      }
      el.querySelector('.btn__label').textContent = matched ? '正在分配…' : queued ? '取消匹配' : '匹配队友';
      el.classList.toggle('btn--primary', queued || matched);
      el.classList.toggle('btn--secondary', !(queued || matched));
      el.disabled = matched || !isHost;
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
    const sp = window.__SP__;
    if (!sp || !sp.store || !sp.store.subscribe) return;
    let box = null;
    const LIMIT = 15 * 60 * 1000;
    const tick = () => {
      const s = sp.store.get();
      const room = s.room;
      if (!room || s.match && s.match.public) { if (box) { box.remove(); box = null; } return; }
      let createdAt = Number(room.createdAt) || 0;
      if (!createdAt) {
        // 服务端没带创建时间时，用本机首次看到该房间的时间兜底
        const k = 'mm-room-created-' + room.code;
        try {
          createdAt = Number(localStorage.getItem(k)) || 0;
          if (!createdAt) { createdAt = Date.now(); localStorage.setItem(k, String(createdAt)); }
        } catch { createdAt = Date.now(); }
      }
      const left = createdAt + LIMIT - Date.now();
      if (!box) {
        box = document.createElement('div');
        box.id = 'mm-room-timer';
        box.style.cssText = 'position:fixed;z-index:88;padding:8px 16px;border-radius:9px;'
          + 'background:rgba(8,14,18,.94);border:1px solid rgba(78,216,175,.35);'
          + 'font:14px/1.4 "Noto Sans SC",system-ui,sans-serif;color:#9fb4ae;white-space:nowrap;'
          + 'box-shadow:0 8px 22px rgba(0,0,0,.45);';
        document.body.appendChild(box);
      }
      const leftClamped = Math.min(LIMIT, Math.max(0, left));
      const mm = Math.min(15, Math.floor(leftClamped / 60000));
      const ss = Math.floor((leftClamped % 60000) / 1000);
      const timeText = String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
      box.innerHTML = left > 0
        ? timeText + ' <span style="color:#cfe9e0">后同盟将自动销毁</span>'
        : '<span style="color:#ffb4a8">房间即将销毁</span>';
      box.style.fontWeight = '400';
      box.style.letterSpacing = '.5px';
      // 时间部分单独高亮
      try {
        if (left > 0) {
          box.innerHTML = '<span style="color:#7ff0cf;font:700 32px/1.15 &quot;Noto Sans SC&quot;,system-ui,sans-serif">' + timeText + '</span>'
            + ' <span style="color:#a8c0b9;font-size:15px;letter-spacing:.5px">后同盟将自动销毁</span>';
        }
      } catch { /* ignore */ }
      // 与密钥字母同高同宽，放在面板左侧
      try {
        const copyEl = [...document.querySelectorAll('button,span,div')]
          .find((n) => (n.textContent || '').trim() === '复制密钥');
        let panel = copyEl;
        for (let k = 0; k < 6 && panel; k++) {
          const r0 = panel.getBoundingClientRect();
          if (r0.width >= 240) break;
          panel = panel.parentElement;
        }
        const rect = panel ? panel.getBoundingClientRect() : null;
        if (rect && rect.width >= 240) {
          box.style.width = '250px';
          box.style.height = '84px';
          box.style.display = 'flex';
          box.style.flexDirection = 'column';
          box.style.alignItems = 'center';
          box.style.justifyContent = 'center';
          box.style.padding = '0';
          box.style.right = 'auto';
          box.style.left = Math.max(8, rect.left - 250 - 18) + 'px';
          box.style.top = (rect.top + 40) + 'px';
          box.style.transform = 'none';
        }
      } catch { /* ignore */ }

    };
    sp.store.subscribe(tick);
    setInterval(tick, 1000);
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
      /* 节点角标 */
      #mm-nodes .chip{
        background:rgba(10,18,20,.92); border:1px solid var(--mm-line); border-radius:6px;
        color:var(--mm-text); font:12px/1.5 "Noto Sans SC",system-ui,sans-serif;
      }
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

  function installUpdateNotice() {
    const SEEN = 'sp_update_seen';
    fetch('/mm/api/update').then((r) => r.json()).then((d) => {
      if (!d || !d.enabled || !d.text) return;
      const ver = String(d.version || '') || (d.updatedAt || '');
      try { if (localStorage.getItem(SEEN) === ver) return; } catch { /* ignore */ }
      const style = document.createElement('style');
      style.textContent = `
        #mm-update{position:fixed;inset:0;z-index:90;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62)}
        #mm-update .card{max-width:min(680px,88vw);max-height:76vh;overflow:auto;background:#0c1215;border:1px solid #2c4a4e;border-radius:14px;padding:20px 22px;color:#dff5ee;font:14px/1.75 "Noto Sans SC",system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6)}
        #mm-update h3{margin:0 0 4px;color:#7ff0cf;font-size:18px}
        #mm-update .ver{color:#6f8f88;font-size:12px;margin-bottom:12px}
        #mm-update pre{white-space:pre-wrap;margin:0 0 16px;font:inherit}
        #mm-update button{float:right;background:#1b4d43;border:1px solid #2f7f6c;color:#c9ffef;border-radius:8px;padding:6px 16px;cursor:pointer}
      `;
      document.head.appendChild(style);
      const box = document.createElement('div');
      box.id = 'mm-update';
      box.innerHTML = '<div class="card"><h3>服务器更新公告</h3><div class="ver"></div><pre></pre><button>知道了</button></div>';
      box.querySelector('.ver').textContent = d.version ? '版本 ' + d.version : '';
      box.querySelector('pre').textContent = d.text;
      box.querySelector('button').onclick = () => { box.remove(); try { localStorage.setItem(SEEN, ver); } catch { /* ignore */ } };
      document.body.appendChild(box);
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- 临时公告

  function installAnnouncement() {
    let last = null;
    let playedKey = null; // 已完整播过两遍的公告版本
    try { playedKey = localStorage.getItem('sp.annPlayed') || null; } catch { /* ignore */ }
    const style = document.createElement('style');
    style.id = 'mm-ann-style';
    style.textContent = `
      #mm-ann{position:fixed;left:50%;top:11%;transform:translateX(-50%);z-index:80;
        width:min(880px,92vw);height:36px;display:flex;align-items:center;overflow:hidden;pointer-events:none;
        background:linear-gradient(90deg,rgba(0,0,0,0),rgba(6,12,14,.72) 12%,rgba(6,12,14,.72) 88%,rgba(0,0,0,0));
        -webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);
        mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);
        font:15px/1.4 "Noto Sans SC",system-ui,sans-serif;color:#e8f4ef;white-space:nowrap;
        opacity:1;transition:opacity .6s}
      #mm-ann.gone{opacity:0}
      #mm-ann .inner{display:inline-block;padding-left:100%;animation:mm-ann-scroll var(--mm-dur,18s) linear 2 forwards}
      #mm-ann .hl{color:#7ff0cf}
      @keyframes mm-ann-scroll{from{transform:translateX(0)}to{transform:translateX(-100%)}}
    `;
    document.head.appendChild(style);

    const load = () => fetch('/mm/api/announcement').then((r) => r.json()).then((d) => {
      const key = d && d.enabled && d.text ? (d.updatedAt || d.text) : null;
      const old = document.getElementById('mm-ann');
      if (!key) { if (old) old.remove(); last = null; return; }
      if (key === playedKey) { if (old) old.remove(); return; } // 已播过就不再推送
      if (key === last && old) return;
      last = key;
      if (old) old.remove();
      const el = document.createElement('div');
      el.id = 'mm-ann';
      el.innerHTML = '<span class="inner"></span>';
      const inner = el.querySelector('.inner');
      // 时间（6:10 / 21:00）用高亮色，像官方的样式
      const text = String(d.text);
      const parts = text.split(/(\d{1,2}:\d{2})/g);
      for (const part of parts) {
        if (/^\d{1,2}:\d{2}$/.test(part)) {
          const sp = document.createElement('span');
          sp.className = 'hl';
          sp.textContent = part;
          inner.appendChild(sp);
        } else if (part) {
          inner.appendChild(document.createTextNode(part));
        }
      }
      const dur = Math.max(12, Math.min(30, Math.round(text.length / 5)));
      el.style.setProperty('--mm-dur', dur + 's');
      document.body.appendChild(el);
      // 滚动两遍后整条消失；同一版本不再重复推送
      const innerEl = el.querySelector('.inner');
      if (innerEl) {
        innerEl.addEventListener('animationend', () => {
          playedKey = key;
          try { localStorage.setItem('sp.annPlayed', key); } catch { /* ignore */ }
          el.classList.add('gone');
          setTimeout(() => { try { el.remove(); } catch { /* ignore */ } }, 600);
        });
      }

    }).catch(() => {});
    load();
    setInterval(load, 3000);
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

  function installNodeBadge() {
    if (document.getElementById('mm-nodes')) return;
    const style = document.createElement('style');
    style.textContent = `
      #mm-nodes{position:fixed;z-index:46;display:inline-flex;align-items:center;font:12px/1.5 "Noto Sans SC",system-ui,sans-serif}
      div:has(> #mm-nodes){align-items:center}
      #mm-nodes .chip{display:inline-flex;align-items:center;justify-content:center;height:36px;gap:6px;background:rgba(8,14,18,.86);border:1px solid #27393b;color:#bfe3d8;padding:4px 10px;border-radius:12px;cursor:pointer;user-select:none;white-space:nowrap}
      #mm-nodes .chip i{width:7px;height:7px;border-radius:50%;background:#4ed8af;box-shadow:0 0 6px #4ed8af}
      #mm-nodes[data-state=busy] .chip i{background:#e8b25a;box-shadow:0 0 6px #e8b25a}
      #mm-nodes[data-state=down] .chip i{background:#d9534f;box-shadow:0 0 6px #d9534f}
      #mm-nodes .chip b{font-weight:700;color:#e6fff7}
      #mm-nodes.match .chip i{background:#e8b25a;box-shadow:0 0 6px #e8b25a}
      #mm-nodes .panel{position:absolute;top:calc(100% + 8px);left:0;z-index:60;min-width:380px;max-height:min(calc(100vh - 120px),920px);overflow:auto;background:rgba(8,14,18,.97);border:1px solid #27393b;border-radius:10px;padding:8px;box-shadow:0 10px 30px rgba(0,0,0,.5)}
      #mm-nodes .panel[hidden]{display:none}
      #mm-nodes .head{display:grid;grid-template-columns:14px 1fr 56px 56px 56px;gap:6px;padding:2px 6px 6px;color:#6f8f88;font-size:11px;border-bottom:1px solid #1d2c2e;margin-bottom:4px}
      #mm-nodes .head span{text-align:right}
      #mm-nodes .head span:first-child{text-align:left;grid-column:1 / span 2}
      #mm-nodes .row{display:grid;grid-template-columns:14px 1fr 56px 56px 56px;align-items:center;gap:6px;padding:2px 6px;color:#9fd8c6;white-space:nowrap}
      #mm-nodes .row b{font-weight:600;overflow:hidden;text-overflow:ellipsis}
      #mm-nodes .row i{width:6px;height:6px;border-radius:50%;background:#4ed8af}
      #mm-nodes .row span{color:#6f8f88;font-size:11px;text-align:right}
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
        // 标题页：固定在左上角
        el.style.display = '';
        el.style.position = 'fixed';
        el.style.left = '16px';
        el.style.top = '16px';
        el.style.transform = 'none';
        el.style.margin = '0';
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
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);

    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.classList.contains('match') || !data) return;
      open = !open;
      panel.hidden = !open;
      if (open) {
        panel.innerHTML = '<div class="head"><span>节点</span><span>状态</span><span>人数</span><span>对局</span></div>'
          + data.nodes.map((x) => '<div class="row ' + (x.ok ? 'ok' : 'off') + '"><i></i>' + x.name
            + '<span>' + (x.ok ? '正常' : '离线') + '</span><span>' + (x.ok ? x.humans : '--')
            + '</span><span>' + (x.ok ? x.matches : '--') + '</span></div>').join('');
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
      text.innerHTML = '<b>' + sum.ready + '/' + sum.total + '</b> · ' + LOAD_TEXT[sum.state] + ' · <b>' + sum.humans + '</b> 人在线';
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
      if (creating || createdOk || attempts >= 3 || Date.now() - lastAt < 2000) return;
      attempts += 1; lastAt = Date.now(); creating = true;
      net.request('room.create', { mode: 'coop', difficulty: PDIFF })
        .then(() => { createdOk = true; })
        .catch((e) => console.warn('[mm] 自动建房失败', e && e.message))
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


