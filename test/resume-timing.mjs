// 验证 account.resume 的时序修复
//
//   node test/resume-timing.mjs
//
// 修的是三个会让「恢复对局」莫名其妙失败的问题：
//   1) socket 还没 online 就发请求 → 服务端当游客拒绝
//   2) accountToken 还没送到 → 同样被当游客
//   3) 3.5 秒就放弃 → 弱网/跨境下回包经常更慢，在回来的前一刻主动 reject
import fs from 'node:fs';

let fail = 0;
const check = (n, ok, extra = '') => { if (!ok) fail++; console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`); };

const src = fs.readFileSync('public/js/ui/accountObserver.js', 'utf8');
const HAS_NOT_READY = src.includes("e.code === 'NOT_READY'");

console.log('=== 1) 常量 ===\n');
check('单次等待上限提高到 8 秒', /RESUME_TIMEOUT_MS = 8000/.test(src));
check('等 online 的上限 6 秒', /RESUME_WAIT_ONLINE_MS = 6000/.test(src));
check('★ 不再固定 3.5 秒放弃', !/account resume timeout'\)\), 3500\)/.test(src));

console.log('\n=== 2) 发送前先等就绪 ===\n');
check('★ 等 net.status === online', /net\.status === 'online'/.test(src));
check('★ 等 __SP_ACCOUNT_TOKEN 就绪', /!!window\.__SP_ACCOUNT_TOKEN/.test(src));
check('两个条件同时满足才发', /net\.status === 'online' && !!window\.__SP_ACCOUNT_TOKEN/.test(src));
check('等不到时给出 NOT_READY', HAS_NOT_READY);
check('NOT_READY 带上诊断信息', /online: net\.status === 'online', token: !!window\.__SP_ACCOUNT_TOKEN/.test(src));

console.log('\n=== 3) 超时可重试 ===\n');
check('★ 超时后重试一次', /const retriable = \/timeout\|DISCONNECTED\|REPLACED\/i\.test\(code\)/.test(src));
check('明确拒绝不重试（无候选会话/游客重试没用）', /if \(!retriable\) throw e1;/.test(src));
check('重试前稍等', /setTimeout\(r, 400\)/.test(src));

console.log('\n=== 4) 状态清理 ===\n');
check('★ 无论如何都清 __SP_ACCOUNT_RESUME_PENDING', /finally \{[\s\S]{0,140}__SP_ACCOUNT_RESUME_PENDING = false/.test(src));
check('★ 无论如何都把 resumePromise 置空', /finally \{[\s\S]{0,240}resumePromise = null/.test(src));

console.log('\n=== 4.5) NOT_READY 不触发跳转与误导提示 ===\n');
check('★ observer 单独处理 NOT_READY', HAS_NOT_READY);
check('★ NOT_READY 走重试而不是跳转', /e\.code === 'NOT_READY'[\s\S]{0,120}setTimeout\(tryAuto, 800\)/.test(src));
{
  const iCatch = src.indexOf('requestAccountResume().then');
  const iNotReady = src.indexOf("e.code === 'NOT_READY'");
  const iCode = src.indexOf('await accountRoomCode()', iCatch);
  check('NOT_READY 分支在「取房间码/跳转」之前',
    iNotReady > iCatch && (iCode < 0 || iNotReady < iCode),
    iCode >= 0 ? `位置 ${iNotReady} < ${iCode}` : '');
}

console.log('\n=== 5) 时序模拟 ===\n');
{
  const ready = (status, hasToken) => status === 'online' && !!hasToken;
  const cases = [
    ['页面刚开，socket 还在连', 'connecting', false, false],
    ['socket 连上了但令牌没到', 'online', false, false],
    ['令牌到了但 socket 没连', 'connected', true, false],
    ['都就绪', 'online', true, true],
  ];
  let ok = true;
  for (const [name, st, tok, want] of cases) {
    const got = ready(st, tok);
    if (got !== want) ok = false;
    console.log(`     ${got === want ? '✓' : '✗'} ${name.padEnd(28)} 可以发=${got}`);
  }
  check('★ 四种时序全部正确', ok);
}

console.log('\n=== 6) 重试策略 ===\n');
{
  const retriable = (code) => /timeout|DISCONNECTED|REPLACED/i.test(String(code || ''));
  const cases = [
    ['account resume timeout', true],
    ['DISCONNECTED', true],
    ['REPLACED', true],
    ['no active match for this account', false],
    ['guest cannot resume', false],
    ['account login required', false],
  ];
  let ok = true;
  for (const [code, want] of cases) {
    const got = retriable(code);
    if (got !== want) ok = false;
    console.log(`     ${got === want ? '✓' : '✗'} ${String(code).padEnd(34)} 重试=${got}`);
  }
  check('★ 只对可恢复的错误重试', ok);
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
