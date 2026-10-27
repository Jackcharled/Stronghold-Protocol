// 安全重启 nginx（清掉残留 worker），并确保新进程不挂在任何用户会话上
// 
//   node tools/restart-nginx.mjs          # 只报告，不动
//   node tools/restart-nginx.mjs --apply  # 真的重启
// 
// 为什么需要这个脚本（2026-10-27）：
//   1) nginx 有 7 个残留 worker（配置只要 2 个），最老的活了 13 小时，
//      导致地图场景资源加载从毫秒级恶化到 60–81 秒。
//   2) nginx master 的 SessionId = 2（桌面会话），说明当初是从交互式会话启动的。
//      维护者要求：**不能挂在任何用户会话上**（否则注销 / 重启桌面应用可能带走它）。
// 
// 本脚本的做法：
//   * 用任务计划程序（SYSTEM / ServiceAccount）执行停止与启动 —— 新 nginx 必然落在 Session 0；
//   * 绝不在当前 shell 里直接 spawn，避免重蹈 pm2 那次的覆辙；
//   * 停之前检查对局数，并把影响写在输出里。
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const NGX_DIR = 'D:\\Stronghold-Protocol\\nginx';
const NGX = NGX_DIR + '\\nginx.exe';

function run(exe, args) {
  try {
    return { ok: true, out: execFileSync(exe, args, { encoding: 'utf8', stdio: 'pipe' }).trim() };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '') + e.message).trim() };
  }
}
const ps = (cmd) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd]);

console.log('=== 当前 nginx 状态 ===');
const list = ps("Get-CimInstance Win32_Process -Filter \"Name='nginx.exe'\" | Sort-Object CreationDate | ForEach-Object { \"$($_.ProcessId) $($_.SessionId) $($_.CreationDate)\" }");
const procs = list.out.split('\n').map((s) => s.trim()).filter(Boolean);
procs.forEach((p) => {
  const [pid, sid, ...rest] = p.split(/\s+/);
  const mark = sid === '0' ? '' : '  ⚠ 不在 Session 0';
  console.log(`  pid=${pid}  session=${sid}  ${rest.join(' ')}${mark}`);
});
console.log(`  共 ${procs.length} 个进程（配置 worker_processes 2，正常应为 master + 2 worker = 3 左右）`);

console.log('\n=== 当前对局 ===');
const status = run('node', ['-e', `
let m=0,h=0;const https=require('http');
(async()=>{for(let n=1;n<=30;n++){await new Promise(r=>{const req=https.get('http://127.0.0.1:'+(3000+n)+'/healthz',{timeout:2000},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{const j=JSON.parse(d);m+=j.matches||0;h+=j.humans||0}catch{};r()})});req.on('error',()=>r());req.on('timeout',()=>{req.destroy();r()})})}console.log(m+' '+h)})()
`]);
const [matchCount, humans] = status.out.split(' ').map(Number);
console.log(`  对局 ${matchCount} 局，在线玩家 ${humans} 位`);
console.log('  ⚠ 重启会让这些玩家断线 1–2 秒（浏览器自动重连，对局数据不丢）');

if (!APPLY) {
  console.log('\n（只报告。加 --apply 才真的重启）');
  process.exit(0);
}

console.log('\n=== 1) 优雅停止（通过 SYSTEM 计划任务之外的独立进程，不挂在当前会话）===');
// 注意：这里只是「发信号」，nginx master 不是当前 shell 的子进程，
// 停完重启由下面的计划任务负责，保证新进程落在 Session 0。
const quit = run(NGX, ['-p', NGX_DIR + '\\', '-c', 'conf/nginx.conf', '-s', 'quit']);
console.log('  quit:', quit.ok ? 'OK' : quit.out.split('\n')[0]);

// 等所有 worker 退出（最多 15 秒）
for (let i = 0; i < 15; i++) {
  const left = ps("(Get-Process nginx -ErrorAction SilentlyContinue).Count");
  if (left.out.trim() === '0' || left.out.trim() === '') break;
  await new Promise((r) => setTimeout(r, 1000));
}
const after = ps("(Get-Process nginx -ErrorAction SilentlyContinue).Count");
console.log(`  停止后剩余进程: ${after.out.trim() || 0}`);

console.log('\n=== 2) 用计划任务以 SYSTEM 启动（新进程必然在 Session 0）===');
const startTask = run('schtasks.exe', ['/Run', '/TN', 'SP-Nginx-Start']);
console.log('  schtasks:', startTask.ok ? 'OK' : startTask.out.split('\n')[0]);

await new Promise((r) => setTimeout(r, 6000));

console.log('\n=== 3) 校验 ===');
const final = ps("Get-CimInstance Win32_Process -Filter \"Name='nginx.exe'\" | Sort-Object CreationDate | ForEach-Object { \"$($_.ProcessId) $($_.SessionId)\" }");
const finalProcs = final.out.split('\n').map((s) => s.trim()).filter(Boolean);
finalProcs.forEach((p) => {
  const [pid, sid] = p.split(/\s+/);
  console.log(`  pid=${pid}  session=${sid}${sid === '0' ? '  ✓' : '  ✗ 不在 Session 0！'}`);
});
const allZero = finalProcs.length > 0 && finalProcs.every((p) => p.split(/\s+/)[1] === '0');
console.log(`\n  进程数: ${finalProcs.length}`);
console.log(`  全部在 Session 0: ${allZero ? '✓' : '✗'}`);

const http = run('powershell.exe', ['-NoProfile', '-Command', "try { (Invoke-WebRequest 'https://127.0.0.1/' -UseBasicParsing -SkipCertificateCheck -TimeoutSec 8).StatusCode } catch { 'FAIL' }"]);
console.log(`  HTTPS 首页: ${http.out.trim()}`);
console.log(allZero && http.out.includes('200') ? '\n✓ nginx 已重启，且不在任何用户会话下' : '\n⚠ 请检查上面的输出');
