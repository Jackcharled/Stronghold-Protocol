'use strict';

const NODES = 30;

// 30 个节点用《明日方舟》泰拉地理的地名显示（顺序对应 node-1 … node-30）
// 来源：PRTS 泰拉大典:地理 — 19 个国家 + 独立城邦汐斯塔 + 6 座城市 + 4 个地区
const NAMES = [
  '阿戈尔', '玻利瓦尔', '东', '杜林', '哥伦比亚',
  '卡西米尔', '卡兹戴尔', '拉特兰', '莱塔尼亚', '雷姆必拓',
  '米诺斯', '萨尔贡', '萨米', '维多利亚', '乌萨斯',
  '谢拉格', '叙拉古', '炎', '伊比利亚', '汐斯塔',
  '龙门', '伦蒂尼姆', '切尔诺伯格', '沃伦姆德', '长泉镇',
  '多索雷斯', '阿卡胡拉', '因非冰原', '焚风热土', '瓦伊凡',
];
const $ = (id) => document.getElementById(id);
// 游戏版本 id → 显示名（匹配按版本隔离，控制台也要看得出来）
const VERSION_LABELS = {
  act2autochess: '第二期下半',
  'act2autochess@V2_1': '第二期上半',
  act1autochess: '第一期下半',
  'act1autochess@V1_1': '第一期上半',
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nodeLabel = (target) => {
  if (target === 'all') return '全部 30 个节点';
  const n = Number(String(target).replace(/^node-/, ''));
  return NAMES[n - 1] || String(target);
};
const grid = $('grid');
const cards = new Map();
let logsTimer = null;
let logsName = null;
const ROOMS_PAGE_SIZE = 20;
let roomsCache = [];
let roomsPage = 1;

const SITE = 'https://stronghold.luobomiao.love';
// 打开节点：用公网站点的节点固定参数（?n=N），而不是本机的 127.0.0.1:端口
const urlFor = (n) => `${SITE}/?n=${n}`;

function fmtMem(bytes) {
  const mb = (bytes || 0) / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + 'G' : Math.round(mb) + 'M';
}

function fmtUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
}

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function buildCards() {
  for (let n = 1; n <= NODES; n++) {
    const port = 3000 + n;
    const el = document.createElement('article');
    el.className = 'card down';
    el.innerHTML = `
      <div class="row"><span class="dot"></span><h3>${NAMES[n - 1]}</h3><span class="port">端口 ${port}</span></div>
      <div class="stats">
        <div><b class="cpu">—</b><span>CPU</span></div>
        <div><b class="mem">—</b><span>内存</span></div>
        <div><b class="up">—</b><span>运行</span></div>
        <div><b class="rs">—</b><span>重启</span></div>
      </div>
      <div class="game">
        <span class="players">—</span>
        <span class="rooms">—</span>
        <span class="matches">—</span>
        <span class="lat"></span>
      </div>
      <div class="btns">
        <a class="open" target="_blank" rel="noreferrer">打开</a>
        <button class="restart">重启</button>
        <button class="stop"></button>
        <button class="logs">日志</button>
      </div>`;
    el.querySelector('.open').href = urlFor(n);
    el.querySelector('.restart').onclick = () => act('restart', `node-${n}`, el.querySelector('.restart'));
    el.querySelector('.stop').onclick = (e) => {
      const stopping = e.target.dataset.stopping === '1';
      act(stopping ? 'start' : 'stop', `node-${n}`, e.target);
    };
    el.querySelector('.logs').onclick = () => openLogs(`node-${n}`);
    grid.appendChild(el);
    cards.set(n, el);
  }
}

function updateCard(el, d) {
  const cls = d.status !== 'online' ? (d.status === 'errored' ? 'bad' : 'down')
    : (d.httpOk ? 'online' : 'warn');
  el.className = 'card ' + cls;
  el.querySelector('.cpu').textContent = d.status === 'online' ? (d.cpu || 0).toFixed(0) + '%' : '—';
  el.querySelector('.mem').textContent = d.status === 'online' ? fmtMem(d.mem) : '—';
  el.querySelector('.up').textContent = d.status === 'online' ? fmtUptime(d.uptimeMs) : '—';
  el.querySelector('.rs').textContent = d.restarts;

  const h = d.health;
  const players = h ? (h.humans ?? 0) : 0;
  const rooms = h ? (h.rooms ?? 0) : 0;
  const matches = h ? (h.matches ?? 0) : 0;
  el.querySelector('.players').textContent = `${players} 玩家`;
  el.querySelector('.rooms').textContent = `${rooms} 房间`;
  el.querySelector('.matches').textContent = `${matches} 对局`;
  const lat = el.querySelector('.lat');
  lat.textContent = d.httpOk ? `${d.latencyMs} ms` : (d.status === 'online' ? '无响应' : '');
  lat.className = 'lat' + (players > 0 ? ' live' : '');

  const stopBtn = el.querySelector('.stop');
  stopBtn.textContent = d.status === 'online' ? '停止' : '启动';
  stopBtn.dataset.stopping = d.status === 'online' ? '1' : '0';
}

function updateNginx(ng) {
  const bar = $('ngx-bar');
  if (!bar) return;
  const on = !!(ng && ng.running);
  bar.classList.toggle('up', on);
  bar.classList.toggle('down', !on);
  $('ngx-state').textContent = on ? '运行中' : '未运行';
  const portal = $('ngx-portal');
  if (portal && ng && ng.portal) portal.href = ng.portal;
  $('ngx-pid').textContent = on && ng.pid
    ? `PID ${ng.pid}${ng.portalOk ? ' · 门户正常' : ' · 门户无响应'}`
    : '';
}

async function nginxAct(action, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch('/api/nginx', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const j = await res.json();
    toast(`nginx ${action} ${j.ok ? '已执行' : '失败：' + (j.err || '')}`);
  } catch (e) {
    toast('nginx 操作失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    setTimeout(refresh, 600);
  }
}

function updateMatchmaking(mm) {
  const bar = $('mm-bar');
  if (!bar) return;
  const on = !!(mm && mm.ok);
  bar.classList.toggle('up', on);
  bar.classList.toggle('down', !on);
  $('mm-waiting').textContent = on ? mm.waiting : '–';
  $('mm-matches').textContent = on ? mm.matches : '–';
  $('mm-parties').textContent = on ? (mm.parties ?? 0) : '–';
  $('mm-partywait').textContent = on ? (mm.partyWaiting ?? 0) : '–';
  $('mm-totalwait').textContent = on ? ((Number(mm.waiting) || 0) + (Number(mm.partyWaiting) || 0)) : '–';
  const expEl = $('mm-exp20');
  if (expEl) {
    if (!on) { expEl.textContent = ''; expEl.hidden = true; }
    else {
      let expWaiting = 0, expMatches = 0, expParties = 0;
      const expByDiff = [];
      const shortDiff = { FUNNY: '标准', NORMAL: '险境', HARD: '绝境', ABYSS: '终极' };
      for (const [d, data] of Object.entries(mm.byDifficulty || {})) {
        let dw = 0, dm = 0, dteam = 0;
        for (const c of (Array.isArray(data.byCapacity) ? data.byCapacity : [])) {
          if (Number(c.capacity) > 4) {
            // 单人票据 + 组队房间里的人数都要算（同上：以前漏了组队）
            dw += (Number(c.waiting) || 0) + (Number(c.partyWaiting) || 0);
            dm += Number(c.matches) || 0;
            dteam += Number(c.parties) || 0;
          }
        }
        expWaiting += dw;
        expMatches += dm;
        expParties += dteam;
        if (dw || dm) expByDiff.push(`${shortDiff[d] || d} ${dw}人/${dm}局`);
      }
      expEl.innerHTML = `实验池（分难度） <b>${expWaiting}</b> 人排队 · <b>${expParties}</b> 队 · <b>${expMatches}</b> 局`;
      expEl.title = expByDiff.length ? `按难度：${expByDiff.join(' · ')}（同难度内再按具体人数）` : '5～20 人实验池，按难度和具体人数分开';
      expEl.hidden = false;
    }
  }
  const pools = $('mm-pools');
  if (pools) {
    if (!on || !mm.byDifficulty) pools.innerHTML = '';
    else {
      const labels = { FUNNY: '标准模拟', NORMAL: '险境模拟', HARD: '绝境模拟', ABYSS: '终极模拟' };
      pools.innerHTML = Object.keys(labels).map((d) => {
        const x = mm.byDifficulty[d] || {};
        const caps = Array.isArray(x.byCapacity) ? x.byCapacity : null;
        // 匹配按游戏版本隔离：同一难度下有多个版本时，标出「多版本」并列出各版本明细
        const vers = Array.isArray(x.byVersion) ? x.byVersion : [];
        const verTip = vers.map((v) => `${VERSION_LABELS[v.version] || v.version}：排队 ${Number(v.partyWaiting) || Number(v.waiting) || 0} 人 / 已开 ${Number(v.matches) || 0} 局`).join(' · ');
        const verTag = vers.length > 1 ? `<i class="mm-ver" title="${verTip.replace(/"/g, '&quot;')}">多版本</i>` : '';
        const exp = caps ? caps.filter((c) => Number(c.capacity) > 4 && (Number(c.waiting) || Number(c.parties) || Number(c.matches))) : [];
        if (exp.length) {
          // ★ 实验池（5–20 人）的排队人数必须同时算「单人票据」和「组队房间」。
          //   以前只累加 c.waiting，房间里点「匹配队友」的玩家在后台是看不见的。
          const expWaiting = exp.reduce((n, c) => n + (Number(c.waiting) || 0) + (Number(c.partyWaiting) || 0), 0);
          const expMatches = exp.reduce((n, c) => n + (Number(c.matches) || 0), 0);
          const expParties = exp.reduce((n, c) => n + (Number(c.parties) || 0), 0);
          const detail = exp.map((c) => {
            const w = (Number(c.waiting) || 0) + (Number(c.partyWaiting) || 0);
            const team = Number(c.parties) || 0;
            return `${Number(c.capacity)}人 ${w}/${Number(c.capacity)}${team ? `（${team} 队）` : ''}`;
          }).join(' · ');
          const base = caps.find((c) => Number(c.capacity) === 4);
          return `<span class="mm-pool diff-${d}"><b>${labels[d]}</b>${verTag}<i>4人 单人 <b>${Number(base?.waiting) || 0}</b></i>`
            + `<i>房间 <b>${Number(base?.parties) || 0}</b> 队/<b>${Number(base?.partyWaiting) || 0}</b> 人</i>`
            + `<i>已开 <b>${Number(base?.matches) || 0}</b></i>`
            + `<span class="mm-cap is-exp" title="${detail || '5～20 人实验池'}"><b>实验池 5～20人</b>`
            + `<i>排队 <b>${expWaiting}</b></i><i>房间 <b>${expParties}</b> 队</i><i>已开 <b>${expMatches}</b></i></span></span>`;
        }
        return `<span class="mm-pool diff-${d}"><b>${labels[d]}</b>${verTag}<i>单人 <b>${Number(x.waiting) || 0}</b></i><i>房间 <b>${Number(x.parties) || 0}</b> 队/<b>${Number(x.partyWaiting) || 0}</b> 人</i><i>已开 <b>${Number(x.matches) || 0}</b></i></span>`;
      }).join('');
    }
  }
  $('mm-state').textContent = on ? '' : '匹配服务未运行';
}

function updateProtection(p) {
  if (!p) return;
  const ab = p.autoban || { running: false, bans: [] };
  const abBar = $('ab-bar');
  abBar.classList.toggle('up', !!ab.running);
  abBar.classList.toggle('down', !ab.running);
  $('ab-state').textContent = ab.running ? '守护运行中' : '守护未运行';
  const bans = ab.bans || [];
  $('ab-bans').innerHTML = bans.length
    ? '已封 ' + bans.length + ' 个：' + bans.map((b) => `<span class="banchip">${b.ip}<button data-ip="${b.ip}" title="解封">✕</button></span>`).join(' ')
    : '当前没有封禁';
}

function updateConsistency(c) {
  const bar = $('consistency-bar');
  if (!bar || !c) return;
  const ok = c.differing === 0;
  bar.classList.toggle('up', ok);
  bar.classList.toggle('down', !ok);
  const files = (c.files || []).length;
  $('consistency-state').textContent = ok ? `全部一致（${c.total}/${c.total} 节点 · ${files} 个文件）` : `${c.differing} 个节点与 node-1 不一致`;
  $('consistency-detail').textContent = ok
    ? '只读对比 lobby.js / persist / net.js / shared/constants.js'
    : (c.nodes || []).slice(0, 4).map((n) => `node-${n.n}: ${n.diffs.join(', ')}`).join(' · ') + (c.differing > 4 ? ` … 共 ${c.differing} 个` : '');
}

function updateRooms(r) {
  const count = $('rooms-count');
  if (!count) return;
  const nodes = (r && r.nodes) || [];
  const bar = $('rooms-bar');
  if (bar) bar.classList.toggle('up', nodes.length > 0);
  const rooms = [];
  for (const n of nodes) for (const rm of (n.rooms || [])) rooms.push({ ...rm, node: n.n });
  rooms.sort((a, b) => (a.node - b.node) || String(a.code).localeCompare(String(b.code)));
  roomsCache = rooms;
  const pages = Math.max(1, Math.ceil(rooms.length / ROOMS_PAGE_SIZE));
  if (roomsPage > pages) roomsPage = pages;
  if (roomsPage < 1) roomsPage = 1;
  const solo = rooms.filter((x) => x.mode === 'solo').length;
  const coop = rooms.filter((x) => x.mode === 'coop').length;
  const queued = rooms.filter((x) => x.queued && !x.started).length;
  count.textContent = rooms.length ? `${rooms.length} 个房间 / ${nodes.length} 个节点（单人 ${solo} · 同盟 ${coop} · 匹配中 ${queued}）` : '暂无房间';
  renderRoomsTable();
}

function renderRoomsTable() {
  const body = $('rooms-body');
  const pager = $('roomsPager');
  if (!body) return;
  const rooms = roomsCache;
  const pages = Math.max(1, Math.ceil(rooms.length / ROOMS_PAGE_SIZE));
  if (roomsPage > pages) roomsPage = pages;
  if (roomsPage < 1) roomsPage = 1;
  const start = (roomsPage - 1) * ROOMS_PAGE_SIZE;
  const pageRows = rooms.slice(start, start + ROOMS_PAGE_SIZE);
  body.innerHTML = pageRows.length ? pageRows.map((x) => {
    const state = x.started ? '对局中' : (x.queued ? '匹配中' : '等待中');
    const stateClass = x.started ? ' is-live' : (x.queued ? ' is-queued' : '');
    const playerHtml = (x.players || []).map((p) => {
      // 身份标签：管理员/服主 > 游客 > 玩家
      const kind = p.admin ? { cls: 'is-admin', text: '管理员' } : p.guest ? { cls: 'is-guest', text: '游客' } : { cls: 'is-player', text: '玩家' };
      return '<span class="room-player' + (p.host ? ' is-host' : '') + '" title="' + esc(p.name || '') + '">'
        + '<span class="room-kind ' + kind.cls + '">' + kind.text + '</span>'
        + esc(p.name || '') + (p.host ? '<em>房主</em>' : '') + (p.connected === false ? '<i>离线</i>' : '')
        + '</span>';
    }).join('') || '<span class="room-empty">—</span>';
    const spectatorHtml = (x.spectatorPlayers || []).map((p) => '<span class="room-spectator">' + esc(p.name || '') + (p.connected === false ? '<i>离线</i>' : '') + '</span>').join('') || '<span class="room-empty">—</span>';
    const count = (n) => '<span class="room-count' + (!n ? ' is-zero' : '') + '">' + (n == null ? '—' : n) + '</span>';
    const spectate = x.mode === 'solo' ? '<span class="room-empty">—</span>' : '<span class="room-count' + (!x.spectators ? ' is-zero' : '') + '">' + (x.spectators != null ? x.spectators : 0) + (x.maxSpectators ? '/' + x.maxSpectators : '') + '</span>';
    const roundText = x.round > 0 ? 'R' + x.round : (x.started && x.round === 0 ? '准备中' : '—');
    const diffName = ({ FUNNY: '标准模拟', NORMAL: '险境模拟', HARD: '绝境模拟', ABYSS: '终极模拟' })[x.difficulty] || (x.difficulty || '—');
    const cap = Number(x.seats) || 4;
    const capBadge = cap > 4 ? '<span class="room-cap">' + cap + '人</span>' : '';
    const adminBadge = x.adminCreated ? '<span class="room-admin">管理员房</span>' : '';
    // 房间所用的游戏版本：默认版本（第二期下半）显示成低调的灰字，其它版本高亮 ——
    // 匹配是按版本隔离的，后台一眼能看出这局到底跑的是哪个版本。
    const verId = typeof x.version === 'string' && x.version ? x.version : 'act2autochess';
    const verName = VERSION_LABELS[verId] || verId;
    const verCell = '<span class="room-ver' + (verId !== 'act2autochess' ? ' is-other' : '') + '" title="' + esc(verId) + '">' + esc(verName) + '</span>';
    // 关闭这间房：房间归某台节点所有，必须带上 node 才能打到对的那台。
    const closeBtn = '<button class="room-close" data-close="' + esc(x.code) + '" data-node="' + Number(x.node)
      + '" data-humans="' + (Number(x.humans) || 0) + '" data-running="' + (x.started ? 1 : 0) + '"'
      + ' title="关闭这个房间">关闭</button>';
    return '<tr><td><span class="room-code">' + esc(x.code) + '</span>' + capBadge + adminBadge + '</td><td title="node-' + x.node + '"><span class="room-node">' + esc(NAMES[x.node - 1] || ('节点 ' + x.node)) + '</span></td><td><span class="room-mode">' + (x.mode === 'solo' ? '单人模拟' : x.mode === 'coop' ? '同盟模拟' : '—') + '</span></td><td><span class="room-diff' + (x.difficulty ? ' diff-' + esc(x.difficulty) : '') + '">' + esc(diffName) + '</span></td><td>' + verCell + '</td><td><span class="room-state' + stateClass + '">' + state + '</span></td><td><span class="room-round' + (x.round > 0 ? '' : ' is-empty') + '" title="' + (x.round > 0 ? '第 ' + x.round + ' 回合' : (x.started ? '对局准备中' : '暂无对局')) + '">' + roundText + '</span></td><td><div class="room-players' + (cap > 4 ? ' room-players--large' : '') + '">' + playerHtml + '</div></td><td>' + count(x.humans) + '</td><td>' + count(x.bots) + '</td><td>' + spectate + '</td><td><div class="room-spectators">' + spectatorHtml + '</div></td><td>' + closeBtn + '</td></tr>';
  }).join('') : '<tr><td colspan="13" class="muted">暂无房间</td></tr>';
  // 关闭按钮（每次重绘表格都会重建，所以在这里绑定）
  body.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => closeRoom(b.dataset.close, Number(b.dataset.node), {
      humans: Number(b.dataset.humans) || 0,
      running: b.dataset.running === '1',
      btn: b,
    });
  });
  if (!pager) return;
  if (rooms.length <= ROOMS_PAGE_SIZE) { pager.innerHTML = rooms.length ? `<span class="muted">共 ${rooms.length} 间</span>` : ''; return; }
  pager.innerHTML = `<button data-p="-1"${roomsPage <= 1 ? ' disabled' : ''}>上一页</button>`
    + `<span class="muted">第 ${roomsPage} / ${pages} 页 · 共 ${rooms.length} 间</span>`
    + `<button data-p="1"${roomsPage >= pages ? ' disabled' : ''}>下一页</button>`;
  pager.querySelectorAll('[data-p]').forEach((b) => {
    b.onclick = () => {
      roomsPage += Number(b.dataset.p);
      renderRoomsTable();
    };
  });
}

/** 关闭一个房间。房间归某台节点所有，必须把 node 一起发过去。 */
async function closeRoom(code, node, { humans = 0, running = false, btn = null } = {}) {
  let msg = `关闭房间 ${code}（node-${node}）？`;
  if (humans) msg += `\n\n里面有 ${humans} 名玩家，会被移出同盟。`;
  if (running) msg += '\n\n⚠ 这个房间正在对局中，关闭会立即终止该对局。';
  if (!confirm(msg)) return;
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '关闭中…'; }
  try {
    const r = await fetch('/api/rooms/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, node, confirm: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.ok) {
      toast(`已关闭 ${code}（移出 ${j.humans || 0} 名玩家）`);
    } else {
      // hint 由服务端翻译好（例如「node-1 还没重启，不支持关闭房间」），有就直接用它
      const zh = j.hint || {
        forbidden: '没有权限', no_room: '房间已不存在', room_not_found: '找不到该房间',
        timeout: '节点无响应', no_secret: '缺少密钥文件', bad_code: '房间号无效', close_failed: '关闭失败',
        node_not_ready: '节点需要重启才能用这个功能',
      }[j.error] || j.error || `HTTP ${r.status}`;
      toast(`关闭失败：${zh}`, 6000);
    }
  } catch (e) {
    toast(`关闭失败：${e && e.message ? e.message : e}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
    refresh();
  }
}

async function protectionAction(action, ip, btn) {
  const label = btn ? btn.textContent : '';  if (btn) { btn.disabled = true; btn.textContent = '执行中…'; }
  try {
    const res = await fetch('/api/protection/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ip }),
    });
    const j = await res.json();
    toast(`${action} ${j.ok ? '完成' : '失败：' + (j.err || j.error || '')}`, j.ok ? 2600 : 6000);
  } catch (e) {
    toast('操作失败：' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
    setTimeout(refresh, 800);
  }
}

async function refresh() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    for (const d of data.nodes) {
      const el = cards.get(d.n);
      if (el) updateCard(el, d);
    }
    const s = data.summary;
    $('s-online').textContent = `${s.online}/${s.total}`;
    $('s-players').textContent = s.players;
    $('s-guests').textContent = s.guests ?? 0;
    $('s-other').textContent = Math.max(0, (s.connections || 0) - (s.players || 0) - (s.guests || 0));
    $('s-total').textContent = s.connections ?? 0;
    $('s-rooms').textContent = s.rooms;
    $('s-matches').textContent = s.matches != null ? s.matches : 0;
    $('s-ai').textContent = s.ai != null ? s.ai : 0;
    $('s-mem').textContent = fmtMem(s.mem);
    $('s-time').textContent = new Date(data.ts).toLocaleTimeString('zh-CN', { hour12: false });
    $('err').textContent = data.error || '';
    updateNginx(data.nginx);
    updateMatchmaking(data.matchmaking);
    updateConsistency(data.consistency);
    updateRooms(data.rooms);
    updateProtection(data.protection);
  } catch (e) {
    $('err').textContent = '面板读取失败：' + e.message;
  }
}

async function act(action, target, btn) {
  const label = btn ? btn.textContent : '';
  if (action === 'restart') {
    if (!confirm(`确定重启 ${nodeLabel(target)}？该节点上的玩家会断线，进行中的对局会中断。`)) return;
    if (!confirm(`再次确认：现在重启 ${nodeLabel(target)}？`)) return;
  }
  if (action === 'stop') {
    if (!confirm(`确定停止 ${nodeLabel(target)}？该节点上的玩家会断线，进行中的对局会中断。`)) return;
    if (!confirm(`再次确认：现在停止 ${nodeLabel(target)}？`)) return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, target }),
    });
    const j = await res.json();
    toast(`${action} ${nodeLabel(target)} ${j.ok ? '已执行' : '失败：' + (j.err || '')}`);
  } catch (e) {
    toast('操作失败：' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
    setTimeout(refresh, 1200);
  }
}

async function openLogs(name) {
  logsName = name;
  $('logs-title').textContent = `${name} · 日志（最后 64 KB）`;
  $('logs').classList.remove('hidden');
  await loadLogs();
  clearInterval(logsTimer);
  logsTimer = setInterval(loadLogs, 3000);
}

async function loadLogs() {
  if (!logsName) return;
  try {
    const res = await fetch(`/api/logs?name=${encodeURIComponent(logsName)}`);
    const j = await res.json();
    $('logs-out').textContent = j.out || '（空）';
    $('logs-err').textContent = j.err || '（空）';
  } catch (e) {
    $('logs-out').textContent = '读取失败：' + e.message;
  }
}

function closeLogs() {
  $('logs').classList.add('hidden');
  clearInterval(logsTimer);
  logsTimer = null;
  logsName = null;
}

buildCards();

document.querySelectorAll('.act').forEach((b) => {
  b.onclick = () => act(b.dataset.act, b.dataset.target, b);
});
$('ngx-start').onclick = (e) => nginxAct('start', e.target);
$('ngx-stop').onclick = (e) => nginxAct('stop', e.target);
$('ngx-reload').onclick = (e) => nginxAct('reload', e.target);
$('ab-start').onclick = (e) => protectionAction('autoban-start', null, e.target);
$('ab-stop').onclick = (e) => protectionAction('autoban-stop', null, e.target);
$('ab-bans').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ip]');
  if (b) protectionAction('autoban-unban', b.dataset.ip, b);
});
$('consistency-check').onclick = async (e) => {
  const b = e.target;
  const label = b.textContent;
  b.disabled = true; b.textContent = '检查中…';
  try {
    const r = await fetch('/api/consistency', { cache: 'no-store' });
    const j = await r.json();
    if (j.ok) updateConsistency(j);
    else toast('一致性检查失败');
  } catch (err) { toast('一致性检查失败：' + err.message); }
  finally { b.disabled = false; b.textContent = label; }
};
$('logs-close').onclick = closeLogs;
$('logs').onclick = (e) => { if (e.target.id === 'logs') closeLogs(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLogs(); });

let timer = setInterval(() => { if ($('auto').checked) refresh(); }, 3000);
$('auto').onchange = () => { if ($('auto').checked) refresh(); };

refresh();

// ---- 临时公告 ----
let annClearAt = 0; // 兼容旧逻辑
let annFilled = false; // 本页面是否已经把服务端内容填进输入框

function annStats() {
  const el = $('ann-text');
  const lines = (el.value || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const chars = lines.join('').length;
  const c = $('ann-count');
  if (c) c.textContent = lines.length + ' 条 · ' + chars + ' 字';
  return lines;
}

async function loadAnnouncement() {
  try {
    const j = await (await fetch('/api/announcement')).json();
    if (!annFilled) { $('ann-text').value = j.text || ''; annFilled = true; annStats(); }
    $('ann-on').checked = !!j.enabled;
    const up = $('ann-updated');
    if (up) up.textContent = j.updatedAt ? ('上次更新 ' + new Date(j.updatedAt).toLocaleString('zh-CN')) : '尚未发布';
  } catch { /* ignore */ }
}
async function saveAnnouncement(enabled, text) {
  const j = await (await fetch('/api/announcement', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled, text }),
  })).json();
  toast(j.ok ? '公告已保存' : '保存失败', j.ok ? 2000 : 4000);
  annFilled = true;
  loadAnnouncement();
}

const annEl = $('ann-text');
if (annEl) {
  annEl.addEventListener('input', annStats);
  annEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    $('ann-save').click();
  });
}

$('ann-save').onclick = () => {
  const lines = annStats();
  if (!lines.length) { toast('公告内容不能为空', 2000); return; }
  $('ann-on').checked = true;
  saveAnnouncement(true, $('ann-text').value.trim());
  const el = $('ann-text');
  el.style.background = 'rgba(78,216,175,.18)';
  setTimeout(() => { el.style.background = ''; }, 220);
};
$('ann-clear').onclick = () => {
  $('ann-text').value = '';
  annStats();
  $('ann-on').checked = false;
  saveAnnouncement(false, '');
};
annStats();
setTimeout(loadAnnouncement, 800);

// ---- 公告板（content/announcements.json） ----
// 友好编辑器：卡片列表 + 表单；高级模式保留原始 JSON。
let annList = [];
let annEditIndex = -1;

function annMsg(text, ok) {
  const msg = $('ann-board-msg');
  if (!msg) return;
  msg.textContent = text || '';
  msg.style.color = ok === false ? '#ffb4a8' : (ok ? '#7ff0cf' : '');
}

async function saveAnnList(list) {
  const r = await fetch('/api/announcements', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(list),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || '未知错误');
  annList = list;
  renderAnnBoard();
  annMsg('已保存 ' + j.count + ' 条公告');
  toast('公告板已保存', 2000);
}

function renderAnnBoard() {
  const box = $('ann-board-list');
  if (!box) return;
  box.innerHTML = '';
  if (!annList.length) {
    box.innerHTML = '<div class="muted" style="padding:14px;border:1px dashed #27393b;border-radius:10px">还没有公告，点右上角「＋ 新增公告」。</div>';
    return;
  }
  annList.forEach((en, i) => {
    const card = document.createElement('div');
    card.style.cssText = 'display:flex;gap:12px;align-items:center;border:1px solid #27393b;border-radius:10px;padding:12px 14px;background:#0b1214';
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px';
    const title = document.createElement('b');
    title.textContent = en.title || '(无标题)';
    title.style.cssText = 'font-size:14px;color:#dff3ee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.style.fontSize = '12px';
    meta.textContent = (en.date || '无日期') + ' · ' + (en.paragraphs || []).length + ' 段';
    info.appendChild(title);
    info.appendChild(meta);
    card.appendChild(info);

    const mk = (label, fn, color) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'background:#131c1f;border:1px solid #27393b;color:' + (color || '#9fb4b8') + ';border-radius:8px;padding:6px 10px;font-size:12px';
      b.onclick = fn;
      return b;
    };
    card.appendChild(mk('↑', () => moveAnn(i, -1)));
    card.appendChild(mk('↓', () => moveAnn(i, 1)));
    card.appendChild(mk('编辑', () => openAnnEditor(i), '#7ff0cf'));
    card.appendChild(mk('删除', async () => {
      if (!confirm('删除这条公告？\n\n' + (annList[i].title || ''))) return;
      const next = annList.slice();
      next.splice(i, 1);
      try { await saveAnnList(next); } catch (e) { annMsg('保存失败：' + e.message, false); }
    }, '#ffb4a8'));
    box.appendChild(card);
  });
}

async function moveAnn(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= annList.length) return;
  const next = annList.slice();
  [next[i], next[j]] = [next[j], next[i]];
  try { await saveAnnList(next); } catch (e) { annMsg('保存失败：' + e.message, false); }
}

function openAnnEditor(i) {
  annEditIndex = i;
  const en = i >= 0 ? annList[i] : { title: '', date: new Date().toISOString().slice(0, 10), paragraphs: [] };
  $('ann-edit-title').value = en.title || '';
  $('ann-edit-date').value = en.date || new Date().toISOString().slice(0, 10);
  $('ann-edit-body').value = (en.paragraphs || []).join('\n');
  const ed = $('ann-board-editor');
  ed.style.display = 'flex';
  $('ann-edit-title').focus();
}

function closeAnnEditor() {
  $('ann-board-editor').style.display = 'none';
  annEditIndex = -1;
}

async function loadAnnBoard() {
  try {
    const list = await (await fetch('/api/announcements')).json();
    annList = Array.isArray(list) ? list : [];
    renderAnnBoard();
    const el = $('ann-board-text');
    if (el) el.value = JSON.stringify(annList, null, 2);
  } catch { /* ignore */ }
}

function bindAnnBoard() {
  const newBtn = $('ann-board-new');
  if (newBtn) newBtn.onclick = () => openAnnEditor(-1);
  const cancel = $('ann-edit-cancel');
  if (cancel) cancel.onclick = closeAnnEditor;

  const save = $('ann-edit-save');
  if (save) save.onclick = async () => {
    const title = ($('ann-edit-title').value || '').trim();
    const date = ($('ann-edit-date').value || '').trim();
    const paragraphs = ($('ann-edit-body').value || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!title) { annMsg('标题不能为空', false); return; }
    if (!paragraphs.length) { annMsg('正文至少要有一段', false); return; }
    const entry = { title, date, paragraphs };
    const next = annList.slice();
    if (annEditIndex >= 0) next[annEditIndex] = entry; else next.unshift(entry);
    try {
      await saveAnnList(next);
      closeAnnEditor();
    } catch (e) { annMsg('保存失败：' + e.message, false); }
  };

  const toggle = $('ann-board-json-toggle');
  if (toggle) toggle.onclick = () => {
    const box = $('ann-board-json');
    const show = box.style.display === 'none' || !box.style.display;
    box.style.display = show ? 'flex' : 'none';
    if (show) $('ann-board-text').value = JSON.stringify(annList, null, 2);
  };

  const reload = $('ann-board-reload');
  if (reload) reload.onclick = loadAnnBoard;

  const btn = $('ann-board-save');
  if (btn) btn.onclick = async () => {
    let list;
    try {
      list = JSON.parse($('ann-board-text').value || '[]');
      if (!Array.isArray(list)) throw new Error('必须是数组');
    } catch (e) { annMsg('JSON 格式错误：' + e.message, false); return; }
    try { await saveAnnList(list); } catch (e) { annMsg('保存失败：' + e.message, false); }
  };
}
loadAnnBoard();
bindAnnBoard();

// ---- 更新公告 ----
async function loadUpdate() {
  try {
    const j = await (await fetch('/api/update')).json();
    $('upd-version').value = j.version || '';
    $('upd-text').value = j.text || '';
    $('upd-on').checked = !!j.enabled;
  } catch { /* ignore */ }
}
async function saveUpdate(enabled, version, text) {
  const j = await (await fetch('/api/update', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled, version, text }),
  })).json();
  toast(j.ok ? '更新公告已保存' : '保存失败', j.ok ? 2000 : 4000);
  loadUpdate();
}
$('upd-save').onclick = () => saveUpdate($('upd-on').checked, $('upd-version').value.trim(), $('upd-text').value.trim());
$('upd-clear').onclick = () => { $('upd-version').value = ''; $('upd-text').value = ''; $('upd-on').checked = false; saveUpdate(false, '', ''); };
setTimeout(loadUpdate, 900);

// ---- 同盟解散时间 ----
async function loadCreateRoom() {
  try {
    const res = await fetch('/api/create-room', { cache: 'no-store' });
    const j = await res.json();
    const el = document.getElementById('create-room-toggle');
    if (el) el.checked = j.enabled !== false;
  } catch { /* 忽略 */ }
}

function bindCreateRoom() {
  loadCreateRoom();
}

async function loadGameGate() {
  try {
    const res = await fetch('/api/game-gate', { cache: 'no-store' });
    const j = await res.json();
    const s = document.getElementById('gate-start');
    const m = document.getElementById('gate-match');
    if (s) s.checked = j.start !== false;
    if (m) m.checked = j.match !== false;
    const create = !!document.getElementById('create-room-toggle')?.checked;
    const st = document.getElementById('gate-state');
    if (st) st.textContent = (create ? '创建房间开放' : '创建房间已关闭') + ' · ' + (j.start === false ? '开始游戏已关闭' : '开始游戏开放') + ' · ' + (j.match === false ? '匹配队友已关闭' : '匹配队友开放');
  } catch { /* ignore */ }
}

function bindGameGate() {
  const btn = document.getElementById('gate-save');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.onclick = async () => {
    const start = !!document.getElementById('gate-start')?.checked;
    const match = !!document.getElementById('gate-match')?.checked;
    const create = !!document.getElementById('create-room-toggle')?.checked;
    const st = document.getElementById('gate-state');
    try {
      const [gateRes, createRes] = await Promise.all([
        fetch('/api/game-gate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ start, match }),
        }),
        fetch('/api/create-room', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: create }),
        }),
      ]);
      const j = gateRes.ok ? await gateRes.json().catch(() => ({})) : {};
      const c = createRes.ok ? await createRes.json().catch(() => ({})) : {};
      if (st) {
        const createOk = c.enabled !== false;
        st.textContent = (createOk ? '创建房间开放' : '创建房间已关闭') + ' · '
          + (j.start === false ? '开始游戏已关闭' : '开始游戏开放') + ' · '
          + (j.match === false ? '匹配队友已关闭' : '匹配队友开放');
      }
    } catch { if (st) st.textContent = '保存失败'; }
  };
  loadGameGate();
}

async function loadRoomTtl() {
  try {
    const res = await fetch('/api/room-ttl');
    const d = await res.json();
    const el = document.getElementById('ttl-min');
    if (el) el.value = d.minutes || 15;
  } catch { /* ignore */ }
}
function bindRoomTtl() {
  const btn = document.getElementById('ttl-save');
  if (!btn) return;
  btn.onclick = async () => {
    const msg = document.getElementById('ttl-msg');
    const m = Number(document.getElementById('ttl-min').value);
    if (!Number.isFinite(m) || m < 1 || m > 1440) { if (msg) msg.textContent = '请输入 1~1440'; return; }
    const r = await fetch('/api/room-ttl', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutes: m }),
    });
    const d = await r.json().catch(() => ({}));
    if (msg) {
      msg.textContent = d.ok ? ('已保存：' + d.minutes + ' 分钟') : ('失败：' + (d.error || '未知'));
      msg.style.color = d.ok ? '#7ff0cf' : '#ffb4a8';
    }
    if (d.ok) toast('同盟解散时间已更新', 2000);
  };
}
loadRoomTtl();
bindRoomTtl();
bindCreateRoom();
bindGameGate();

// ---------------------------------------------------------------- 指标趋势（点线图）
const TREND_COLORS = { players: '#6fe0c0', ai: '#f0c674', rooms: '#7aa7ff' };

function drawTrend(points) {
  const svg = document.getElementById('trendSvg');
  const tip = document.getElementById('trendTip');
  if (!svg) return;
  const W = 800, H = 220, PAD = 26;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!points || !points.length) {
    svg.innerHTML = '<text x="400" y="110" fill="#6c8a84" font-size="14" text-anchor="middle">暂无数据，稍后自动采集</text>';
    return;
  }
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const maxY = Math.max(4, ...points.map((p) => Math.max(p.players, p.ai, p.rooms)));
  const xOf = (t) => PAD + ((t - t0) / span) * (W - PAD * 2);
  const yOf = (v) => H - PAD - (v / maxY) * (H - PAD * 2);
  const keys = ['players', 'ai', 'rooms'];
  let out = '';
  // 网格
  for (let i = 0; i <= 4; i++) {
    const y = PAD + (i * (H - PAD * 2)) / 4;
    const v = Math.round(maxY * (1 - i / 4));
    out += `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="#1e3234" stroke-width="1"/>`;
    out += `<text x="${PAD - 6}" y="${y + 4}" fill="#6c8a84" font-size="10" text-anchor="end">${v}</text>`;
  }
  // 折线 + 点
  for (const k of keys) {
    const color = TREND_COLORS[k];
    const pts = points.map((p) => `${xOf(p.t).toFixed(1)},${yOf(p[k]).toFixed(1)}`).join(' ');
    out += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" opacity="0.9"/>`;
    for (const p of points) {
      const d = new Date(p.t);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      out += `<circle cx="${xOf(p.t).toFixed(1)}" cy="${yOf(p[k]).toFixed(1)}" r="3" fill="${color}" data-tip="${hh}:${mm} · 玩家 ${p.players} · AI ${p.ai} · 房间 ${p.rooms}"/>`;
    }
  }
  svg.innerHTML = out;
  // 悬停显示该点数据
  svg.querySelectorAll('circle[data-tip]').forEach((c) => {
    c.style.cursor = 'pointer';
    c.addEventListener('mouseenter', (e) => {
      if (!tip) return;
      tip.textContent = c.getAttribute('data-tip');
      tip.style.display = 'block';
      const wrap = document.getElementById('trendWrap').getBoundingClientRect();
      tip.style.left = Math.min(wrap.width - 150, Math.max(0, e.clientX - wrap.left + 12)) + 'px';
      tip.style.top = Math.max(0, e.clientY - wrap.top - 30) + 'px';
    });
    c.addEventListener('mouseleave', () => { if (tip) tip.style.display = 'none'; });
  });
}

async function refreshTrend() {
  const sel = document.getElementById('trendRange');
  const minutes = sel ? Number(sel.value) || 180 : 180;
  try {
    const r = await fetch('/api/history?minutes=' + minutes, { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    drawTrend(j.points || []);
  } catch { /* 忽略 */ }
}

if (document.getElementById('trendSvg')) {
  const sel = document.getElementById('trendRange');
  if (sel) sel.onchange = refreshTrend;
  refreshTrend();
  setInterval(refreshTrend, 30000);
}

// ---- 运维：哪些节点能安全重启 / 重启 / 更新 nginx 开放列表 ----
// 与部署根目录的 `运维.bat` 菜单是同一套判断口径，这里是网页版。
let opsData = null;

function fmtList(arr) {
  return arr && arr.length ? arr.map((n) => NAMES[n - 1] || `node-${n}`).join('、') : '—';
}

async function loadOps() {
  const box = $('ops-restartable');
  if (!box) return;
  try {
    const r = await fetch('/api/ops/state', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    opsData = await r.json();
  } catch (e) {
    $('ops-state').textContent = '读取失败：' + e.message;
    $('ops-dot').style.background = '#e05252';
    return;
  }
  const s = opsData.summary;
  $('ops-dot').style.background = '#3fb27f';
  $('ops-state').textContent = `${opsData.fresh.length} / ${NODES} 个节点已跑最新代码`;
  const codeT = opsData.codeAt ? new Date(opsData.codeAt) : null;
  $('ops-code').textContent = codeT
    ? `代码时间 ${codeT.toLocaleString('zh-CN', { hour12: false })}`
    : '读不到代码时间';
  $('ops-summary').textContent =
    `节点响应 ${s.alive}/${NODES} · 房间 ${s.rooms} · 对局 ${s.matches} · 在线 ${s.players}`;

  // 可重启：绿；跑旧代码但有对局：黄（不能动）
  const can = opsData.restartable;
  const oldBusy = opsData.nodes.filter((x) => !x.fresh && x.alive && x.matches > 0);
  box.innerHTML = can.length
    ? can.map((n) => {
        const x = opsData.nodes.find((y) => y.n === n);
        return `<span class="chip" style="display:inline-flex;align-items:center;gap:6px;margin:2px 4px 2px 0;padding:4px 10px;border:1px solid #2c6b52;border-radius:20px;background:#0f211b">
          <b style="color:#5fd39b">${esc(NAMES[n - 1])}</b><span class="muted" style="font-size:11px">node-${n} · ${x.rooms} 房 / ${x.sockets} 连</span></span>`;
      }).join('')
    : '<span class="muted">（没有空闲且需要更新的节点——都还在对局里，等空闲了刷新这里）</span>';
  $('ops-busy').textContent = oldBusy.length
    ? `⛔ 跑旧代码但正在对局，不能动（${oldBusy.length}）：` +
      oldBusy.map((x) => `${NAMES[x.n - 1]}(${x.matches}局)`).join('、')
    : '';
  $('ops-restart').disabled = !can.length;
  $('ops-restart').textContent = can.length ? `重启这 ${can.length} 个空闲节点` : '没有可重启的节点';

  const open = opsData.openList;
  $('ops-open').disabled = !opsData.fresh.length;
  $('ops-open-now').textContent = open
    ? `当前开放 ${open.length} 个；已跑新代码 ${opsData.fresh.length} 个`
    : '读不到 nginx 配置';
  if (open) {
    // 跑新代码但还没开放的节点。
    // ⚠ 不能一律说成「可再开放」：节点上可能已经有房间/玩家了（他们是通过 ?room=房间号
    // 直达进来的，nginx 的 arg_room 规则会绕过开放列表）。这时候把节点加进开放列表，
    // 等于让新访客被分到一个别人正在等待开局的房间里去。
    // 所以分开报：真的空着的才算「可开放」，有人的要单独标出来。
    const missing = opsData.fresh.filter((n) => !open.includes(n));
    const extra = open.filter((n) => !opsData.fresh.includes(n)); // 旧代码却开放 = 违反红线
    if (extra.length) {
      $('ops-open-now').textContent += `　⚠ 有 ${extra.length} 个旧代码节点还开着：${fmtList(extra)}`;
    } else if (missing.length) {
      const busy = [];
      const idle = [];
      for (const n of missing) {
        const x = opsData.nodes.find((y) => y.n === n) || {};
        const ppl = (x.rooms || 0) + (x.sockets || 0);
        (ppl > 0 ? busy : idle).push(ppl > 0 ? `${NAMES[n - 1]}(${x.rooms} 房/${x.sockets} 连)` : n);
      }
      if (idle.length) $('ops-open-now').textContent += `　可再开放 ${idle.length} 个`;
      if (busy.length) {
        $('ops-open-now').textContent += `　⚠ 有 ${busy.length} 个没开放但已经有房间/玩家：${busy.join('、')}`
          + `（他们是用房间号直达的；再开放等于让新访客进到别人的等待室）`;
      }
      if (!idle.length && !busy.length) $('ops-open-now').textContent += '　（都已开放）';
    }
  }
}

async function opsPost(path, label, btn) {
  const out = $('ops-out');
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '执行中…'; }
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    const j = await r.json();
    if (out) {
      out.style.display = 'block';
      out.textContent = [j.message || label, j.err || '', j.out || ''].filter(Boolean).join('\n');
    }
    toast(j.ok ? (j.message || label + '完成') : (j.error || j.message || label + '失败'));
  } catch (e) {
    toast(label + '失败：' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; }
    loadOps();
  }
}

if (document.getElementById('ops-bar')) {
  $('ops-restart').onclick = () => {
    const n = opsData ? opsData.restartable : [];
    if (!n.length) return toast('没有可重启的节点');
    const busy = opsData ? opsData.nodes.filter((x) => x.matches > 0).length : 0;
    if (!confirm(`将重启 ${n.length} 个空闲节点：\n${fmtList(n)}\n\n这些节点上的玩家会断线 1–2 秒，浏览器自动重连，对局数据不丢。\n另有 ${busy} 个节点正在对局，不会动。\n\n确认重启？`)) return;
    opsPost('/api/ops/restart-idle', '重启空闲节点', $('ops-restart'));
  };
  $('ops-open').onclick = () => {
    const f = opsData ? opsData.fresh : [];
    if (!f.length) return toast('没有任何已更新节点');
    // 有玩家在房间/等待室里的节点要单独讲清楚：开放之后新访客会直接落进去
    const occupied = f
      .map((n) => opsData.nodes.find((y) => y.n === n))
      .filter((x) => x && ((x.rooms || 0) > 0 || (x.sockets || 0) > 0));
    let msg = `把 nginx 开放列表改成「所有已跑新代码的节点」共 ${f.length} 个：\n${fmtList(f)}\n\n`;
    if (occupied.length) {
      msg += `⚠ 其中 ${occupied.length} 个节点上现在就有玩家：\n`
        + occupied.map((x) => `  ${NAMES[x.n - 1]}：${x.rooms} 房 / ${x.sockets} 连（${x.players} 人）`).join('\n')
        + `\n开放之后，新访客会被随机分到这些节点，直接进到那些人的等待室里。\n`
        + `已经在房间里的人不受影响（他们一直回自己的节点）。\n\n`;
    }
    msg += `自动备份配置，nginx -t 校验，失败会自动回滚。\n正在对局的玩家不受影响（sp_route 永远回原节点）。\n\n确认更新？`;
    if (!confirm(msg)) return;
    opsPost('/api/ops/open-list', '更新开放列表', $('ops-open'));
  };

  // 重启 nginx：走 tools/restart-nginx.mjs（先清进程 → 再经计划任务启动到 Session 0）
  $('ops-nginx').onclick = () => {
    const total = NODES;
    const fresh = opsData ? opsData.fresh.length : 0;
    const stale = total - fresh;
    const matches = opsData ? (opsData.summary?.matches || 0) : 0;
    let msg = `重启 nginx？\n\n`;
    msg += `影响：站点中断约 5–20 秒，所有在线玩家的连接会断开并自动重连。\n`;
    msg += `对局数据不丢 —— 30 个 node 进程不会被动到。\n\n`;
    if (matches) msg += `当前有 ${matches} 局对局在进行。\n\n`;
    if (stale > 0) {
      msg += `⚠ 注意：还有 ${stale} 个节点跑的是旧代码（未修复「对局中清理座位」）。\n`;
      msg += `   这些节点上的玩家断线重连时，仍可能丢失座位、回不到对局。\n\n`;
    } else {
      msg += `✅ ${total} 个节点都已加载最新代码，重连不会掉座位。\n\n`;
    }
    msg += `执行流程：quit → 确认进程归零（没退的强杀）→ 确认 443 释放 → 计划任务启动 → 校验。\n\n确认重启？`;
    if (!confirm(msg)) return;
    opsPost('/api/nginx/restart', '重启 nginx', $('ops-nginx'));
  };

  loadOps();
  setInterval(loadOps, 15000);
}

