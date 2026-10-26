// 端到端实测两套恢复机制（真实服务器 + 真实登录账号 + 真实对局）
//   A. token 恢复   —— 同一浏览器刷新：hello{token} → byToken → resumed → resync → 回到座位
//   B. 账号恢复对局 —— 换设备：account.resume → byAccount → rotateToken 接管旧座位，旧设备被踢
//
//   node test/recovery-live.mjs
import fs from 'node:fs';
import { startServer } from '../node-1/server/index.js';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUIET = { info() {}, warn() {}, error() {}, debug() {}, child() { return QUIET; } };

function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames = [];
    const waiters = [];
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      frames.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
      }
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

// 登录测试账号拿 userToken（服务端 hello.accountToken 认这个）
async function loginToken() {
  const raw = JSON.parse(fs.readFileSync('D:/Stronghold-Protocol/.secrets/test-accounts.json', 'utf8'));
  const acc = (raw.accounts || raw)[0];
  const cap = await (await fetch('https://stronghold.luobomiao.love/mm/api/auth/captcha')).json();
  const chars = [...String(cap.svg || '').matchAll(/<text[^>]*>([^<])<\/text>/g)].map((m) => m[1]).join('');
  const r = await fetch('https://stronghold.luobomiao.love/mm/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: acc.email, password: acc.password, captcha: chars, captchaId: cap.id, captchaKey: cap.id }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('登录失败: ' + JSON.stringify(j).slice(0, 120));
  return { userToken: j.userToken, adminToken: j.adminToken, accountId: j.user && j.user.id, name: acc.nickname };
}

let srv;
try {
  const auth = await loginToken();
  console.log(`已登录: ${auth.name} (accountId=${auth.accountId})\n`);

  srv = await startServer({ port: 0, host: '127.0.0.1', log: QUIET });
  const port = srv.port;
  console.log(`服务器: 127.0.0.1:${port}\n`);

  const hello = (extra = {}) => ({ t: 'hello', name: auth.name, version: 1, accountToken: auth.userToken, ...extra });

  // ---------- A. token 恢复 ----------
  console.log('=== A. token 恢复（同一浏览器刷新）===\n');
  const a1 = await client(port);
  a1.send(hello());
  const w1 = await a1.waitFor((m) => m.t === 'welcome');
  check('首次连接拿到 welcome', !!w1.token);
  check('新会话 resumed=false', !w1.resumed, `resumed=${w1.resumed}`);
  const token = w1.token;
  const pid = w1.playerId;

  a1.send({ t: 'room.create', rid: 1, mode: 'coop', difficulty: 'NORMAL' });
  const cr = await a1.waitFor((m) => m.rid === 1);
  check('建房成功', cr.t === 'ok', JSON.stringify(cr).slice(0, 120));
  if (cr.t === 'ok') {
    a1.send({ t: 'room.addBot', rid: 2 }); await a1.waitFor((m) => m.rid === 2);
    a1.send({ t: 'room.addBot', rid: 3 }); await a1.waitFor((m) => m.rid === 3);
    a1.send({ t: 'room.ready', rid: 4, ready: true }); await a1.waitFor((m) => m.rid === 4);
    a1.send({ t: 'room.start', rid: 5 });
    const st = await a1.waitFor((m) => m.rid === 5, 10000);
    check('开局成功', st.t === 'ok', JSON.stringify(st).slice(0, 120));
    await sleep(1500);
    const pub = a1.frames.filter((m) => m.t === 'm.public').pop();
    check('进入对局', !!pub, pub ? `phase=${pub.phase}` : '');

    // 掉线
    a1.close();
    await sleep(800);
    console.log('  [旧 socket 已断开]');

    // 同 token 重连 = 刷新
    const a2 = await client(port);
    a2.send(hello({ token }));
    const w2 = await a2.waitFor((m) => m.t === 'welcome');
    check('★ resumed = true（服务端识别为恢复）', w2.resumed === true, `resumed=${w2.resumed}`);
    check('★ playerId 一致（座位保留）', w2.playerId === pid);
    const pub2 = await a2.waitFor((m) => m.t === 'm.public', 8000).catch(() => null);
    check('★ 对局状态重推（m.public）', !!pub2, pub2 ? `phase=${pub2.phase}` : '未收到');
    const priv2 = await a2.waitFor((m) => m.t === 'm.private', 8000).catch(() => null);
    check('★ 私有状态重推（m.private）', !!priv2);

    // ---------- B. 账号恢复 ----------
    console.log('\n=== B. 账号恢复对局（换设备）===\n');
    // 新设备：不同 token，但同一账号
    const b1 = await client(port);
    b1.send(hello());
    const bw = await b1.waitFor((m) => m.t === 'welcome');
    check('新设备连接成功（新会话）', !!bw.token);
    check('新设备是不同 playerId', bw.playerId !== pid, `${bw.playerId} vs ${pid}`);

    b1.send({ t: 'account.resume', rid: 20 });
    const br = await b1.waitFor((m) => m.rid === 20, 8000).catch(() => null);
    check('★ account.resume 成功接管', !!br && br.t === 'ok', br ? JSON.stringify(br).slice(0, 140) : '无响应');

    const pushed = await b1.waitFor((m) => m.t === 'account.resume', 5000).catch(() => null);
    check('★ 服务端推送 account.resume（含座位 token）', !!pushed,
      pushed ? `roomCode=${pushed.roomCode}` : '未收到');
    if (pushed) {
      check('  token 已换发（旧设备失效）', pushed.token !== token);
      check('  playerId 是原座位', pushed.playerId === pid, `${pushed.playerId} vs ${pid}`);
    }

    // 旧设备应被踢（4001 account moved）
    await sleep(600);
    check('★ 旧设备被断开（对局已转移）',
      a2.ws.readyState === WebSocket.CLOSED || a2.ws.readyState === WebSocket.CLOSING,
      `readyState=${a2.ws.readyState}`);

    b1.close();
    a2.close();
  }
} catch (e) {
  console.error('\n测试异常:', e && e.message);
  fail++;
} finally {
  try { await srv?.close(); } catch {}
}
console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
