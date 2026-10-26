// 用真实 rooms.json 数据渲染后台房间表，检查布局：
// 玩家列宽度是否足够、玩家名是否被挤成竖排、各列是否对齐。
//   node test\admin-layout-render.cjs
const fs = require('node:fs');
const puppeteer = require('D:/Stronghold-Protocol/shared/node_modules/puppeteer-core');

(async () => {
  const html = fs.readFileSync('D:/Stronghold-Protocol/matchmaker/public/admin.html', 'utf8');
  const data = JSON.parse(fs.readFileSync('D:/Stronghold-Protocol/content/rooms.json', 'utf8'));
  const rooms = [];
  for (const n of data.nodes) for (const r of n.rooms) rooms.push({ ...r, node: n.n });

  let fail = 0;
  const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const W = Number(process.argv[2] || 1880);
  await page.setViewport({ width: W, height: 980 });

  // 直接注入后台页面，跳过 adminGate（只验证布局）
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('/admin.html')) {
      return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    return req.continue();
  });
  await page.goto('http://127.0.0.1:3090/admin.html', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  // 手动渲染真实数据（页面自身因为没登录拿不到数据）
  const result = await page.evaluate((rooms) => {
    const body = document.getElementById('roomBody');
    if (!body) return { err: 'no roomBody' };
    // 卡片默认可能是隐藏的（页签未激活）：强制显示，否则量到的都是 0
    const card = document.getElementById('roomsCard');
    let el = card;
    while (el) { el.classList.remove('hide'); if (el.style) el.style.display = ''; el = el.parentElement; }
    if (card) card.style.display = 'block';
    // 截图只看房间卡片：把其它卡片和登录区都藏起来
    for (const other of document.querySelectorAll('.card')) {
      if (other.id !== 'roomsCard') other.style.display = 'none';
    }
    document.querySelectorAll('.tabs, #tabbar').forEach((t) => { t.style.display = 'none'; });
    window.scrollTo(0, 0);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const VERSION_LABELS = { act2autochess: '第二期下半', 'act2autochess@V2_1': '第二期上半', act1autochess: '第一期下半', 'act1autochess@V1_1': '第一期上半' };
    const DIFF = { FUNNY: '标准模拟', NORMAL: '险境模拟', HARD: '绝境模拟', ABYSS: '终极模拟' };
    body.innerHTML = rooms.map((r) => {
      const state = r.started ? '对局中' : (r.queued ? '匹配中' : '等待中');
      const stateClass = r.started ? ' is-live' : (r.queued ? ' is-queued' : '');
      const playerHtml = (r.players || []).map((p) =>
        '<span class="room-player' + (p.host ? ' is-host' : '') + '">' +
        '<span class="room-kind is-player">玩家</span>' + esc(p.name || '') +
        (p.host ? '<em>房主</em>' : '') + '</span>').join('') || '<span class="room-empty">—</span>';
      const spectatorHtml = '<span class="room-empty">—</span>';
      const count = (n) => '<span class="room-count">' + (n == null ? '—' : n) + '</span>';
      const spectate = r.mode === 'solo' ? '<span class="room-empty">—</span>' : '<span class="room-count">' + (r.spectators || 0) + '</span>';
      const cap = Number(r.seats) || 4;
      const verId = r.version || 'act2autochess';
      const verCell = '<span class="room-ver' + (verId !== 'act2autochess' ? ' is-other' : '') + '">' + esc(VERSION_LABELS[verId] || verId) + '</span>';
      const roundText = r.round > 0 ? 'R' + r.round : '—';
      return '<tr><td><span class="room-code">' + esc(r.code) + '</span></td>' +
        '<td><span class="room-node">N' + r.node + '</span></td>' +
        '<td><span class="room-mode">' + (r.mode === 'solo' ? '单人模拟' : '同盟模拟') + '</span></td>' +
        '<td><span class="room-diff">' + (DIFF[r.difficulty] || '—') + '</span></td>' +
        '<td>' + verCell + '</td>' +
        '<td><span class="room-state' + stateClass + '">' + state + '</span></td>' +
        '<td><span class="room-round">' + roundText + '</span></td>' +
        '<td><div class="room-players">' + playerHtml + '</div></td>' +
        '<td>' + count(r.humans) + '</td><td>' + count(r.bots) + '</td>' +
        '<td>' + spectate + '</td><td>' + spectatorHtml + '</td>' +
        '<td><button class="ghost">隐身观战</button></td></tr>';
    }).join('');

    // 测量：玩家列宽度、每个玩家小卡的高度、表格是否溢出
    const wrap = document.querySelector('#roomsCard .room-table-wrap');
    const row1 = body.querySelector('tr');
    const tds = row1 ? [...row1.children] : [];
    const names = ['房间号', '节点', '类型', '难度', '版本', '状态', '回合', '玩家', '真人', 'AI', '观战', '旁观者', '操作'];
    const widths = tds.map((td, i) => ({ col: names[i] || ('#' + (i + 1)), w: Math.round(td.getBoundingClientRect().width) }));
    const chips = [...body.querySelectorAll('.room-player')].slice(0, 6).map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const overCols = widths.filter(c => c.w <= 0).map(c => c.col);
    return {
      widths, overCols,
      chips,
      tableW: Math.round(document.querySelector('#roomsCard table').getBoundingClientRect().width),
      wrapW: Math.round(wrap.getBoundingClientRect().width),
      scrollW: Math.round(wrap.scrollWidth),
      rows: body.querySelectorAll('tr').length,
    };
  }, rooms);

  if (result.err) { console.log('渲染失败:', result.err); await browser.close(); process.exit(1); }

  console.log('列宽（px）:');
  for (const c of result.widths) console.log(`  ${c.col.padEnd(4)} ${c.w}`);
  console.log('\n玩家小卡:');
  for (const c of result.chips) console.log(`  "${c.text}"  w=${c.w} h=${c.h}`);

  const playerCol = result.widths.find((c) => c.col === '玩家');
  console.log(`\n表格宽=${result.tableW} 容器宽=${result.wrapW} scrollW=${result.scrollW}`);

  check('玩家列宽度足够（>=120px）', playerCol && playerCol.w >= 120, `实际=${playerCol ? playerCol.w : '?'}px`);
  check('★ 玩家名没有被挤成竖排（小卡高度 <= 32px）',
    result.chips.every((c) => c.h <= 32),
    result.chips.map((c) => `"${c.text}"=${c.h}px`).join(' '));
  check('★ 玩家小卡保持一行（宽 > 高）',
    result.chips.every((c) => c.w > c.h),
    result.chips.map((c) => `${c.w}x${c.h}`).join(' '));
  // 宽屏不能溢出；窄屏允许表格内部横向滚动（而不是撑破页面）
  const of = await page.evaluate(() => {
    const w = document.querySelector('#roomsCard .room-table-wrap');
    return {
      ox: getComputedStyle(w).overflowX,
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  check('★ 表格不撑破页面（宽屏放下 / 窄屏内部滚动）',
    !of.docOverflow && (result.scrollW <= result.wrapW + 2 || ['auto', 'scroll'].includes(of.ox)),
    `overflowX=${of.ox} 页面溢出=${of.docOverflow}`);

  await page.screenshot({ path: 'D:/Stronghold-Protocol/dist/_admin-layout-' + W + '.png' });
  await browser.close();
  console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})();
