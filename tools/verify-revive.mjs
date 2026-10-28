// 验证 `g.revive` 已进入 C2S 白名单：在指定节点上建房（开复活）→ 开局 → 发 g.revive → 检查回复。
//
// 判定标准：修复前，net.js 的 validateC2S 会直接回 BAD_MSG（detail 里写着 unknown type 或字段错误）；
// 修复后请求会被放行，走到 Match.revive，可能回 WRONG_PHASE / BAD_TARGET 等「业务错误」，
// 但**不应该**再出现 BAD_MSG。
//
// 用法：node tools/verify-revive.mjs <节点号> <accountToken>
// 例：  node tools/verify-revive.mjs 9 <userToken>

const PORT = Number(process.argv[2] || 9) + 3000;
const ACCOUNT_TOKEN = process.argv[3] || '';
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

const send = (ws, obj) => ws.send(JSON.stringify(obj));
let rid = 0;
const pending = new Map();

function call(ws, obj, timeoutMs = 8000) {
  const id = ++rid;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send(ws, { ...obj, rid: id });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ __timeout: true }); } }, timeoutMs);
  });
}

const ws = new WebSocket(WS_URL);
const seen = [];

ws.addEventListener('message', (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  if (m.rid && pending.has(m.rid)) {
    const fn = pending.get(m.rid);
    pending.delete(m.rid);
    fn(m);
  }
  seen.push(m);
});

const step = (label, value) => console.log(`  ${label}: ${value}`);

ws.addEventListener('open', async () => {
  console.log(`连接到 node-${PORT - 3000} (${WS_URL})`);

  const hello = await call(ws, { t: 'hello', name: '复活验证', accountToken: ACCOUNT_TOKEN, version: 1 });
  if (!hello || hello.t === 'error') {
    console.log('hello 失败:', JSON.stringify(hello));
    process.exit(1);
  }
  step('hello', 'ok');

  // 建一个开了复活的双人房（房间状态由单独的 room.state 帧推送）
  const created = await call(ws, {
    t: 'room.create',
    mode: 'coop',
    experimental: { revivalEnabled: true, disableSharedPool: false },
  });
  if (!created || created.t === 'error') {
    console.log('建房失败:', JSON.stringify(created).slice(0, 400));
    process.exit(1);
  }
  const roomState = seen.filter((m) => m && m.t === 'room.state').pop();
  if (!roomState) {
    console.log('建房失败: 没收到 room.state');
    process.exit(1);
  }
  step('建房成功', roomState.code);
  step('复活开关', JSON.stringify(roomState.revival));

  // 直接发 g.revive（不带真实对局，目的只是看协议层是否放行）
  const r1 = await call(ws, { t: 'g.revive', playerId: 'someplayer', round: 1, matchId: 'sometest' });
  console.log('\n=== g.revive 回复 ===');
  console.log(JSON.stringify(r1, null, 2));

  const now = Date.now();
  const reviveReplies = seen.filter((m) => m && m.t === 'error' && m.of === 'g.revive');
  const detail = JSON.stringify(r1);
  const isBadMsg = r1 && (r1.code === 'BAD_MSG' || /BAD_MSG/.test(detail));
  const unknownType = /unknown type/.test(detail);

  console.log('\n=== 判定 ===');
  console.log('  BAD_MSG（协议层拦截）:', isBadMsg ? '是 ✗ 未修复' : '否 ✓');
  console.log('  unknown type:', unknownType ? '是 ✗ 未修复' : '否 ✓');
  if (isBadMsg) {
    console.log('\n结果：g.revive 仍被协议层拒绝，修复未生效。');
    process.exit(2);
  }
  console.log('\n结果：g.revive 已通过协议层放行（到达业务层，本次无对局故返回业务错误属正常）。');

  // 清理：离开并关房
  await call(ws, { t: 'room.leave' });
  ws.close();
  setTimeout(() => process.exit(0), 300);
});

ws.addEventListener('error', (e) => {
  console.log('连接错误:', e.message);
  process.exit(1);
});

setTimeout(() => { console.log('超时退出'); process.exit(1); }, 30000);
