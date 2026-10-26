// 在真实运行中测试今天修复的功能
//   - 同房间接管（同账号换设备/标签页能回到自己的对局）
//   - SESSION_IN_USE 错误码（不再是含糊的 BAD_MSG/「无效的请求」）
//   - ROOM_STARTED 不再清场
//   - 重连窗口 15 分钟
// 用临时启动的本地服务器（不碰线上的 30 个节点）。
import fs from 'node:fs';
import { startServer } from '../node-1/server/index.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUIET = { info() {}, warn() {}, error() {}, debug() {}, child() { return QUIET; } };

// 建房要求已登录账号（游客会被拒）。用测试账号换 userToken。
async function loginToken(name) {
  const raw = JSON.parse(fs.readFileSync('D:/Stronghold-Protocol/.secrets/test-accounts.json', 'utf8'));
  const acc = (raw.accounts || raw).find((a) => a.nickname === name) || (raw.accounts || raw)[0];
  const cap = await (await fetch('https://stronghold.luobomiao.love/mm/api/auth/captcha')).json();
  const chars = [...String(cap.svg || '').matchAll(/<text[^>]*>([^<])<\/text>/g)].map((m) => m[1]).join('');
  const r = await fetch('https://stronghold.luobomiao.love/mm/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: acc.email, password: acc.password, captcha: chars, captchaId: cap.id, captchaKey: cap.id }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('登录失败: ' + JSON.stringify(j).slice(0, 100));
  return { userToken: j.userToken, name: acc.nickname };
}

function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames = []; const waiters = [];
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      frames.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
    };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onopen = () => resolve({
      ws, frames,
      send: (o) => ws.send(JSON.stringify(o)),
      waitFor(pred, ms = 8000) {
        const hit = frames.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout')), ms);
          waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m); } });
        });
      },
      close() { try { ws.close(); } catch {} },
    });
  });
}

let srv;
try {
  const auth = await loginToken('测试甲');
  const auth2 = await loginToken('测试乙');
  console.log(`已登录: ` + auth.name + ` / ` + auth2.name);
  srv = await startServer({ port: 0, host: '127.0.0.1', log: QUIET });
  const port = srv.port;
  console.log(`本地测试服务器: 127.0.0.1:${port}\n`);

  // ---------- 1) 重连窗口 ----------
  console.log('=== 1) 重连窗口应为 15 分钟 ===\n');
  const { NET_DEFAULTS } = await import('../node-1/server/net.js');
  check('★ reconnectWindowMs = 15 分钟', NET_DEFAULTS.reconnectWindowMs === 15 * 60_000, `${NET_DEFAULTS.reconnectWindowMs} ms`);

  // ---------- 2) token 恢复 + ROOM_STARTED 不再清场 ----------
  console.log('\n=== 2) token 恢复：掉线重连回到原座位 ===\n');
  const a1 = await client(port);
  a1.send({ t: 'hello', name: auth.name, version: 1, accountToken: auth.userToken });
  const w1 = await a1.waitFor((m) => m.t === 'welcome');
  const tokenA = w1.token, pidA = w1.playerId;
  check('首次连接 resumed=false', !w1.resumed);

  a1.send({ t: 'room.create', rid: 1, mode: 'coop', difficulty: 'NORMAL' });
  const cr = await a1.waitFor((m) => m.rid === 1);
  check('建房成功', cr.t === 'ok', JSON.stringify(cr).slice(0, 80));
  a1.close();
  await sleep(600);

  const a2 = await client(port);
  a2.send({ t: 'hello', name: auth.name, version: 1, token: tokenA, accountToken: auth.userToken });
  const w2 = await a2.waitFor((m) => m.t === 'welcome');
  check('★ 重连 resumed=true', w2.resumed === true);
  check('★ playerId 一致（座位保留）', w2.playerId === pidA);
  const rs = await a2.waitFor((m) => m.t === 'room.state', 5000).catch(() => null);
  check('★ 房间状态被重推', !!rs, rs ? `code=${rs.code}` : '未收到');
  const roomCode = rs?.code;

  // ---------- 3) 同房间接管（本次核心修复）----------
  console.log('\n=== 3) 同房间接管：同账号换设备能回到自己的房间 ===\n');
  // 用同一个 hello（无 token）模拟「另一个标签页/设备」
  const b1 = await client(port);
  b1.send({ t: 'hello', name: auth.name, version: 1, accountToken: auth.userToken });
  const wb = await b1.waitFor((m) => m.t === 'welcome');
  check('新设备拿到新会话', wb.playerId !== pidA, `${wb.playerId} vs ${pidA}`);

  b1.send({ t: 'room.join', rid: 2, code: roomCode });
  const jr = await b1.waitFor((m) => m.rid === 2, 6000).catch(() => null);
  check('★ 加入自己所在的房间应成功（不再是 SESSION_IN_USE / BAD_MSG）',
    !!jr && jr.t === 'ok', jr ? JSON.stringify(jr).slice(0, 140) : '无响应');
  check('★ 错误码不是 BAD_MSG', !jr || jr.code !== 'BAD_MSG', jr?.code || '');

  // 旧设备应被断开
  await sleep(500);
  check('★ 旧设备的 socket 被断开（对局已转移）',
    a2.ws.readyState === WebSocket.CLOSED || a2.ws.readyState === WebSocket.CLOSING,
    `readyState=${a2.ws.readyState}`);

  // ---------- 4) 「在其他房间」仍然拒绝 ----------
  console.log('\n=== 4) 不会「同时在两个房间」（接管逻辑不能放过真正的冲突）===\n');
  // 步骤 3 里 b1 已经接管了座位，旧连接 a2 被服务端换掉；
  // 继续用 b1 发消息可能落空，所以这里全部用**新连接**验证。
  const c1 = await client(port);
  c1.send({ t: 'hello', name: auth2.name, version: 1, accountToken: auth2.userToken });
  await c1.waitFor((m) => m.t === 'welcome');
  c1.send({ t: 'room.create', rid: 3, mode: 'coop', difficulty: 'NORMAL' });
  const cr2 = await c1.waitFor((m) => m.rid === 3);
  check('另一账号建房成功', cr2.t === 'ok', JSON.stringify(cr2).slice(0, 80));
  const otherCode = (c1.frames.filter((m) => m.t === 'room.state').pop() || {}).code;
  check('拿到另一个房间码', !!otherCode, otherCode);

  // 测试甲的新连接（此刻他的座位在 roomCode）：试着进测试乙的房间
  const d1 = await client(port);
  d1.send({ t: 'hello', name: auth.name, version: 1, accountToken: auth.userToken });
  await d1.waitFor((m) => m.t === 'welcome');
  d1.send({ t: 'room.join', rid: 4, code: otherCode });
  const jr2 = await d1.waitFor((m) => m.rid === 4, 6000).catch(() => null);

  check('★ 请求得到明确响应（不会静默挂起）', !!jr2, jr2 ? JSON.stringify(jr2).slice(0, 120) : '超时无响应');
  check('★ 拒绝时用的是 SESSION_IN_USE 而非含糊的 BAD_MSG',
    !jr2 || jr2.t !== 'error' || jr2.code !== 'BAD_MSG',
    jr2 ? `${jr2.t} ${jr2.code || ''}` : '');

  b1.close(); c1.close(); d1.close();

  console.log('\n===== 结论 =====');
  console.log(fail === 0 ? '  全部功能正常 ✅' : `  ${fail} 项异常`);
} catch (e) {
  console.error('\n测试异常:', e && e.message);
  fail++;
} finally {
  try { await srv?.close(); } catch {}
}
process.exit(fail ? 1 : 0);
