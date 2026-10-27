// 安全重启 nginx（清掉残留 worker），并确保新进程不挂在任何用户会话上
//
//   node tools/restart-nginx.mjs          # 只报告，不动
//   node tools/restart-nginx.mjs --apply  # 真的重启
//
// 为什么需要这个脚本（2026-10-27）：
//   1) nginx 有十几个残留 worker（配置只要 2 个），最老的活了两天，
//      导致地图场景资源加载从毫秒级恶化到 60–81 秒。
//   2) nginx master 的 SessionId = 2（桌面会话），说明当初是从交互式会话启动的。
//      维护者要求：**不能挂在任何用户会话上**（否则注销 / 重启桌面应用可能带走它）。
//
// ★ 2026-10-27 第二次事故，本脚本因此重写：
//   原来的流程是「发 quit → 等 15 秒 → 触发计划任务」。实测踩了两个坑：
//     * `nginx -s quit` 只让 master 退出，**卡住的 worker 不会自己结束**
//       （那次 16 个进程只退了 1 个）。脚本等不到归零就继续，把还活着的进程留在 Session 2。
//     * 计划任务里的 _start-nginx.ps1 开头有「已经在跑就直接退出」的保护，
//       于是看到残留进程 → 什么都不做 → 新旧混在一起，进程数从 14 涨到 17。
//   现在的流程（顺序不能改）：
//     1. quit（给正在传输的请求机会收尾）
//     2. **确认归零**：还没退完就强制结束 —— 不归零就不启动
//     3. 确认 443 已释放
//     4. 再触发计划任务（此时必然新建一套，落在 Session 0）
//     5. 校验：进程数、全部 session 0、HTTPS 200、素材加载速度
//   任何一步不达标就明确报失败，绝不说「已重启」。
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const NGX_DIR = 'D:\\Stronghold-Protocol\\nginx';
const NGX = NGX_DIR + '\\nginx.exe';
const TASK = 'SP-Nginx-Start';
/** 配置 worker_processes 2 → master + 2 worker = 3；多出来的都是残留。 */
const EXPECTED_MAX = 3;

function run(exe, args) {
  try {
    return { ok: true, out: execFileSync(exe, args, { encoding: 'utf8', stdio: 'pipe' }).trim() };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '') + e.message).trim() };
  }
}
const ps = (cmd) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** [pid, sessionId, creationDate] of every nginx process. */
function nginxProcs() {
  // 用单引号包 PowerShell 命令，内层用双引号 —— 少一层转义，避免 \\\" 被吞掉导致查询返回空。
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='nginx.exe'\" | Sort-Object CreationDate | ForEach-Object { \"$($_.ProcessId)|$($_.SessionId)|$($_.CreationDate)\" }";
  const r = ps(cmd);
  return r.out.split('\n').map((s) => s.trim()).filter(Boolean).map((p) => {
    const [pid, sid, ...rest] = p.split('|');
    return { pid, sid, created: rest.join(' ') };
  });
}

/** Is anything listening on 443? Returns the owning pid or null. */
function port443() {
  const r = ps("(Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess");
  const v = r.out.trim();
  return v && v !== '0' && /^\d+$/.test(v) ? v : null;
}

function httpsStatus() {
  const r = run('powershell.exe', ['-NoProfile', '-Command',
    "try { (Invoke-WebRequest 'https://127.0.0.1/' -UseBasicParsing -SkipCertificateCheck -TimeoutSec 10).StatusCode } catch { 'FAIL' }"]);
  return r.out.trim();
}

// ---- 0) 现状 ----
console.log('=== 当前 nginx 状态 ===');
const before = nginxProcs();
before.forEach((p) => {
  console.log(`  pid=${p.pid}  session=${p.sid}  ${p.created}${p.sid === '0' ? '' : '  ⚠ 不在 Session 0'}`);
});
console.log(`  共 ${before.length} 个进程（配置 worker_processes 2，正常应为 master + 2 worker = ${EXPECTED_MAX}）`);
if (before.length > EXPECTED_MAX) console.log(`  ⚠ 有 ${before.length - EXPECTED_MAX} 个残留 worker —— 这正是素材加载变慢的原因`);

console.log('\n=== 当前对局 ===');
const status = run('node', ['-e', `
let m=0,h=0;const http=require('http');
(async()=>{for(let n=1;n<=30;n++){await new Promise(r=>{const req=http.get('http://127.0.0.1:'+(3000+n)+'/healthz',{timeout:2000},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{const j=JSON.parse(d);m+=j.matches||0;h+=j.humans||0}catch{};r()})});req.on('error',()=>r());req.on('timeout',()=>{req.destroy();r()})})}console.log(m+' '+h)})()
`]);
const [matchCount, humans] = status.out.split(' ').map(Number);
console.log(`  对局 ${matchCount} 局，在线玩家 ${humans} 位`);
console.log('  ⚠ 重启会让这些玩家断线（浏览器自动重连，对局数据不丢）；');
console.log('    从停止到重新可用大约 5–20 秒，本脚本会强制清干净，不会新旧混在一起。');

if (!APPLY) {
  console.log('\n（只报告。加 --apply 才真的重启）');
  process.exit(0);
}

// ---- 1) 优雅停止 ----
console.log('\n=== 1) 优雅停止（给正在传输的请求收尾的机会）===');
const quit = run(NGX, ['-p', NGX_DIR + '\\', '-c', 'conf/nginx.conf', '-s', 'quit']);
console.log('  quit:', quit.ok ? 'OK' : (quit.out.split('\n')[0] || '失败'));

// ---- 2) 确认归零；不归零就强杀 —— 关键一步，原版没有 ----
console.log('\n=== 2) 确认进程归零（不归零就强制结束）===');
let left = nginxProcs();
for (let i = 0; i < 10 && left.length; i++) {
  await sleep(1000);
  left = nginxProcs();
  if (left.length) console.log(`  等待中… 还剩 ${left.length} 个`);
}
if (left.length) {
  console.log(`  ${left.length} 个 worker 没有自己退出（nginx 卡住的 worker 不会响应 quit）→ 强制结束`);
  ps("Get-Process nginx -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }");
  await sleep(3000);
  left = nginxProcs();
}
if (left.length) {
  console.log(`\n✗ 仍有 ${left.length} 个 nginx 进程无法结束，**已中止**，没有启动新的（避免新旧混在一起）`);
  left.forEach((p) => console.log(`  pid=${p.pid} session=${p.sid}`));
  process.exit(1);
}
console.log('  ✓ 进程已全部退出');

// ---- 3) 确认 443 释放 ----
console.log('\n=== 3) 确认 443 端口已释放 ===');
let holder = port443();
for (let i = 0; i < 10 && holder; i++) {
  await sleep(500);
  holder = port443();
}
if (holder) {
  console.log(`  ✗ 443 仍被 pid ${holder} 占用，**已中止**`);
  process.exit(1);
}
console.log('  ✓ 443 已释放');

// ---- 4) 用计划任务以 SYSTEM 启动 ----
// 只有在进程真正归零之后触发，新进程才会是一套完整的、落在 Session 0 的实例。
// （若还有残留，_start-nginx.ps1 的「已在运行」保护会直接跳过启动。）
console.log('\n=== 4) 用计划任务启动（SYSTEM / Session 0）===');
const startTask = run('schtasks.exe', ['/Run', '/TN', TASK]);
console.log('  schtasks:', startTask.ok ? 'OK' : (startTask.out.split('\n')[0] || '失败'));
if (!startTask.ok) process.exit(1);

// 等它起来并稳定
let after = [];
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  after = nginxProcs();
  if (after.length && httpsStatus() === '200') break;
}

// ---- 5) 校验 ----
console.log('\n=== 5) 校验 ===');
after.forEach((p) => {
  console.log(`  pid=${p.pid}  session=${p.sid}${p.sid === '0' ? '  ✓' : '  ✗ 不在 Session 0！'}`);
});
const allZero = after.length > 0 && after.every((p) => p.sid === '0');
const sizeOk = after.length > 0 && after.length <= EXPECTED_MAX;
const code = httpsStatus();
console.log(`\n  进程数: ${after.length}${sizeOk ? '  ✓' : `  ✗ 期望 ≤ ${EXPECTED_MAX}（还有残留）`}`);
console.log(`  全部在 Session 0: ${allZero ? '✓' : '✗'}`);
console.log(`  HTTPS 首页: ${code}`);

// 素材加载速度（这次事故的直接指标）
let assetOk = false;
if (code === '200') {
  const t = run('node', ['-e', `
const t0=Date.now();
fetch('https://127.0.0.1/assets/local/scene/act2autochess_m01/scene.bin',{headers:{'X-SP-Asset-Cache':'BYPASS'}})
 .then(r=>r.arrayBuffer()).then(b=>console.log(((Date.now()-t0)/1000).toFixed(3)+' '+(b.byteLength/1048576).toFixed(1)))
 .catch(()=>console.log('FAIL'));
`]);
  const [sec, mb] = t.out.trim().split(' ');
  if (sec && sec !== 'FAIL') {
    assetOk = Number(sec) < 5;
    console.log(`  素材加载: ${mb} MB 用时 ${sec} 秒${assetOk ? '  ✓' : '  ⚠ 仍然偏慢（残留 worker 可能没清干净）'}`);
  }
}

const ok = allZero && sizeOk && code === '200';
console.log(ok
  ? '\n✓ nginx 已干净重启：进程数正常、全部在 Session 0、站点 200'
  : '\n⚠ 未达预期，请按上面的 ✗ 逐项检查');
process.exit(ok ? 0 : 1);
