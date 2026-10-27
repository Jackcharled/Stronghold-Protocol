<#
  卫戍协议 · 运维面板（双击 运维.bat 运行）

  维护者的要求：「都写成脚本让我操作」—— 所以这里把日常运维动作做成菜单，
  不用记任何命令，双击 → 选数字 → 完成。

  设计原则：
    * 所有会「改动系统」的操作（重启节点、改 nginx 开放列表、重启 nginx / pm2）
      都先显示影响范围，并要求确认；
    * 只读操作（看状态、看日志）随便点，不会有副作用；
    * 重启 nginx / 启动 pm2 一律走**计划任务（SYSTEM → Session 0）**，
      保证不挂在当前窗口的会话上（手册 §9.9）。
#>
$ErrorActionPreference = 'SilentlyContinue'
$Host.UI.RawUI.WindowTitle = '卫戍协议 · 运维面板'
$root = Split-Path -Parent $PSCommandPath
if (-not $root -or -not (Test-Path (Join-Path $root 'node-1'))) { $root = 'D:\Stronghold-Protocol' }
Set-Location $root

function C([string]$t, [string]$c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Line { C ('─' * 66) DarkGray }
function Pause2 { C ''; Read-Host '  按回车继续' | Out-Null }
function Banner([string]$t) { C ''; Line; C "  $t" Cyan; Line; C '' }

# PowerShell 5.1（双击 .bat 时实际用的就是它）不支持 ?? 运算符，所以用函数取默认值。
function N($v) { if ($null -eq $v) { return 0 }; return [double]$v }

# pm2 必须用 .cmd：pm2.ps1 会把参数拆坏（--only 传不进去），
# 导致 startOrReload 变成无参数调用，把所有节点都重启一遍。
function Get-Pm2 {
  $c = Join-Path $env:APPDATA 'npm\pm2.cmd'
  if (Test-Path $c) { return $c }
  return (Get-Command pm2.cmd -ErrorAction SilentlyContinue).Source
}

# ---------- 只读：状态 ----------
function Show-Status {
  Banner '服务器状态'
  $ok = 0; $rooms = 0; $matches = 0; $humans = 0; $rows = @()
  $mt = (Get-ChildItem 'node-1\server' -Recurse -File -Include *.js | Measure-Object LastWriteTime -Maximum).Maximum
  $now = Get-Date
  foreach ($n in 1..30) {
    try {
      $h = Invoke-RestMethod "http://127.0.0.1:$((3000 + $n))/healthz" -TimeoutSec 2
      $ok++
      $rooms += (N $h.rooms); $matches += (N $h.matches); $humans += (N $h.humans)
      $started = $now.AddSeconds(-[double]$h.uptimeSec)
      $fresh = $started -ge $mt
      $rows += [pscustomobject]@{ 节点 = "node-$n"; 代码 = $(if ($fresh) { '新' } else { '旧' }); 房间 = (N $h.rooms); 对局 = (N $h.matches); 玩家 = (N $h.humans); 连接 = (N $h.sockets); 运行 = "$([int]($h.uptimeSec / 60))分" }
    } catch { $rows += [pscustomobject]@{ 节点 = "node-$n"; 代码 = 'X'; 房间 = '-'; 对局 = '-'; 玩家 = '-'; 连接 = '-'; 运行 = '无响应' } }
  }
  C "  节点响应 $ok/30    房间 $rooms    对局 $matches    在线玩家 $humans" White
  C ''
  $rows | Format-Table -AutoSize | Out-String -Width 200 | ForEach-Object { C $_ }
  C '  代码列: 新 = 已加载最新代码，旧 = 还在跑旧代码，X = 无响应' DarkGray
  C ''
  # nginx
  $ng = Get-Process nginx -ErrorAction SilentlyContinue
  $master = Get-CimInstance Win32_Process -Filter "Name='nginx.exe'" | Sort-Object CreationDate | Select-Object -First 1
  $ngTxt = if ($ng) { "nginx: $($ng.Count) 个进程, master SessionId=$($master.SessionId)" } else { 'nginx: 未运行' }
  $ngOk = $ng -and ($master.SessionId -eq 0) -and ($ng.Count -le 4)
  C "  $ngTxt $(if (-not $ngOk) { ' ⚠ 异常（见菜单 5）' } else { ' ✓' })" $(if ($ngOk) { 'Green' } else { 'Yellow' })
  # pm2
  $pm2 = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'pm2[\\/]lib[\\/]Daemon\.js' } | Select-Object -First 1
  if ($pm2) { C "  pm2: pid=$($pm2.ProcessId) SessionId=$($pm2.SessionId) $(if ($pm2.SessionId -eq 0) { '✓' } else { '⚠' })" $(if ($pm2.SessionId -eq 0) { 'Green' } else { 'Yellow' }) }
  else { C '  pm2: 未运行 ⚠（菜单 4 可启动）' Red }
  # 对外服务
  $web = try { (Invoke-WebRequest 'https://127.0.0.1/' -UseBasicParsing -SkipCertificateCheck -TimeoutSec 6).StatusCode } catch { 'FAIL' }
  C "  网站首页: $web $(if ($web -eq 200) { '✓' } else { '⚠' })" $(if ($web -eq 200) { 'Green' } else { 'Red' })
}

# ---------- 只读：谁可以重启 ----------
function Show-Restartable {
  Banner '可以重启的节点（跑旧代码 + 没有对局）'
  $mt = (Get-ChildItem 'node-1\server' -Recurse -File -Include *.js | Measure-Object LastWriteTime -Maximum).Maximum
  $now = Get-Date
  $free = @(); $busy = @(); $done = @()
  foreach ($n in 1..30) {
    try {
      $h = Invoke-RestMethod "http://127.0.0.1:$((3000 + $n))/healthz" -TimeoutSec 2
      $started = $now.AddSeconds(-[double]$h.uptimeSec)
      if ($started -ge $mt) { $done += $n }
      elseif ((N $h.matches) -eq 0) { $free += $n }
      else { $busy += "node-$n($($h.matches)局)" }
    } catch { }
  }
  C "  已跑最新代码: $($done.Count) 个" Green
  C ''
  if ($free.Count) {
    C "  ✅ 可以重启: $($free.Count) 个" Green
    C "     $($free -join ', ')" White
    C ''
    C '  → 选菜单 2 来重启它们' DarkGray
  } else { C '  （暂时没有空闲节点，全部在对局中）' DarkGray }
  if ($busy.Count) { C ''; C "  ⛔ 有几局在打，不能动: $($busy -join ', ')" Yellow }
  C ''
  C "  已开放给新玩家: $(if (Test-Path 'nginx\conf\nginx.conf') { (Select-String -Path 'nginx\conf\nginx.conf' -Pattern '^\s+[\d.]+% \d+;' | Measure-Object).Count } else { '?' }) 个（nginx 里）" DarkGray
}

# ---------- 写：重启节点 ----------
function Restart-Idle {
  Banner '重启空闲节点'
  $mt = (Get-ChildItem 'node-1\server' -Recurse -File -Include *.js | Measure-Object LastWriteTime -Maximum).Maximum
  $now = Get-Date
  $free = @(); $busy = 0
  foreach ($n in 1..30) {
    try {
      $h = Invoke-RestMethod "http://127.0.0.1:$((3000 + $n))/healthz" -TimeoutSec 2
      $started = $now.AddSeconds(-[double]$h.uptimeSec)
      if ($started -lt $mt -and (N $h.matches) -eq 0) { $free += $n }
      elseif ((N $h.matches) -gt 0) { $busy++ }
    } catch { }
  }
  if (-not $free.Count) { C '  没有空闲且需要更新的节点。' Yellow; return }
  C "  将重启 $($free.Count) 个: $($free -join ', ')" White
  C "  （另有 $busy 个节点还有对局，不会动）" DarkGray
  C ''
  C '  影响：这些节点上的玩家会断线 1–2 秒，浏览器自动重连。' Yellow
  $ans = Read-Host '  确认重启？输入 y 回车'
  if ($ans -ne 'y') { C '  已取消' DarkGray; return }
  C ''
  $names = ($free | ForEach-Object { "node-$_" }) -join ','
  C "  正在重启 $names ..." Yellow
  $pm2 = Get-Pm2
  if (-not $pm2) { C '  找不到 pm2.cmd，请确认已安装 pm2' Red; return }
  # 用引号包住 --only 的值，避免逗号被当成数组分隔符；
  # ecosystem 用绝对路径 —— 相对路径依赖当前目录，控制台版就因为这个报过
  # `[PM2][ERROR] File ecosystem.config.cjs not found`。
  $eco = Join-Path $root 'ecosystem.config.cjs'
  $pm2Out = & $pm2 startOrReload $eco --only "$names" --update-env 2>&1
  $pm2Ok = ($LASTEXITCODE -eq 0) -and -not ($pm2Out -match '\[PM2\]\[ERROR\]')
  if (-not $pm2Ok) {
    C '  ⚠ pm2 报错，没有节点被重启：' Red
    $pm2Out | Select-Object -Last 5 | ForEach-Object { C "    $_" Red }
    return
  }
  & $pm2 save 2>&1 | Out-Null
  Start-Sleep -Seconds 10
  C ''
  $okn = 0
  foreach ($n in $free) {
    try { $h = Invoke-RestMethod "http://127.0.0.1:$((3000 + $n))/healthz" -TimeoutSec 5; C ("    node-{0,-2} ok={1} uptime={2}s" -f $n, $h.ok, [int]$h.uptimeSec) Green; $okn++ }
    catch { C "    node-$n 未起来 ⚠" Red }
  }
  C ''
  C "  完成：$okn / $($free.Count) 起来" $(if ($okn -eq $free.Count) { 'Green' } else { 'Yellow' })
  C '  → 别忘了菜单 3 更新 nginx 开放列表' DarkGray
}

# ---------- 写：更新开放列表 ----------
function Update-Open {
  Banner '更新对外开放的节点'
  $mt = (Get-ChildItem 'node-1\server' -Recurse -File -Include *.js | Measure-Object LastWriteTime -Maximum).Maximum
  $now = Get-Date
  $open = @()
  foreach ($n in 1..30) {
    try {
      $h = Invoke-RestMethod "http://127.0.0.1:$((3000 + $n))/healthz" -TimeoutSec 2
      $started = $now.AddSeconds(-[double]$h.uptimeSec)
      if ($started -ge $mt) { $open += $n }
    } catch { }
  }
  if (-not $open.Count) { C '  没有任何已更新的节点，拒绝执行（会把站点关掉）' Red; return }
  C "  已跑最新代码的节点: $($open.Count) 个" Green
  C "     $($open -join ', ')" White
  C ''
  C '  规则：只开放「已重启到最新代码」的节点；其余关闭新玩家进入。' DarkGray
  C '  正在打对局的玩家不受影响（sp_route cookie 和房间直连永远回原节点）。' DarkGray
  C ''
  $ans = Read-Host '  确认更新 nginx 开放列表？输入 y 回车'
  if ($ans -ne 'y') { C '  已取消' DarkGray; return }
  C ''
  Copy-Item 'nginx\conf\nginx.conf' "nginx\conf\nginx.conf.bak-$(Get-Date -Format 'MMdd-HHmmss')" -Force
  $list = $open -join ','
  node tools\_set-open-nodes.mjs $list
  C ''
  C '  完成' Green
}

# ---------- 写：重启 nginx ----------
function Restart-Nginx {
  Banner '重启 nginx（清理残留 worker，并确保不挂在任何用户会话上）'
  $ng = Get-Process nginx -ErrorAction SilentlyContinue
  $master = Get-CimInstance Win32_Process -Filter "Name='nginx.exe'" | Sort-Object CreationDate | Select-Object -First 1
  if ($ng) {
    C "  当前: $($ng.Count) 个进程，master SessionId=$($master.SessionId)" White
    if ($master.SessionId -ne 0) { C '  ⚠ 不在 Session 0（挂在桌面会话，有被带走的风险）' Yellow }
    if ($ng.Count -gt 4) { C '  ⚠ 进程数偏多，说明有残留 worker（会拖慢素材加载）' Yellow }
  } else { C '  nginx 未运行' Yellow }
  C ''
  $m = 0; $hm = 0
  foreach ($n in 1..30) { try { $h = Invoke-RestMethod "http://127.0.0.1:$((3000 + $n))/healthz" -TimeoutSec 2; $m += (N $h.matches); $hm += (N $h.humans) } catch { } }
  C "  影响：$m 局对局、$hm 位玩家会断线（浏览器自动重连，对局数据不丢）" Yellow
  C '        站点会中断大约 5–20 秒（脚本要先清干净再启动，不会新旧混在一起）' Yellow
  C ''
  C '  流程（顺序不能改，2026-10-27 踩过坑）：' DarkGray
  C '    1. quit 让正在传输的请求收尾' DarkGray
  C '    2. 等进程归零，没退的强制结束 —— 不归零就不启动' DarkGray
  C '    3. 确认 443 释放' DarkGray
  C '    4. 触发计划任务（SYSTEM → Session 0）' DarkGray
  C '    5. 校验进程数 / session 0 / HTTPS 200 / 素材加载速度' DarkGray
  C ''
  C '  ⚠ 不要在 nginx 还在跑的时候点重启：残留 worker 会让计划任务的「已在运行」保护跳过启动，' Yellow
  C '    结果进程越积越多（实测从 14 涨到 17）。本脚本已经避免了这个顺序。' Yellow
  $ans = Read-Host '  确认重启 nginx？输入 y 回车'
  if ($ans -ne 'y') { C '  已取消' DarkGray; return }
  C ''
  node tools\restart-nginx.mjs --apply
}

# ---------- 写：启停 pm2 ----------
function Pm2Menu {
  Banner 'PM2（30 个游戏节点的管理器）'
  $pm2 = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'pm2[\\/]lib[\\/]Daemon\.js' } | Select-Object -First 1
  if ($pm2) { C "  当前: pid=$($pm2.ProcessId) SessionId=$($pm2.SessionId) $(if ($pm2.SessionId -eq 0) { '✓ 正确' } else { '⚠ 挂在会话上' })" Green }
  else { C '  当前: 未运行' Yellow }
  C ''
  C '  1) 启动 / 恢复（走计划任务，SYSTEM 身份）' White
  C '  2) 查看进程列表' White
  C '  3) 返回' DarkGray
  $c = Read-Host '  选择'
  if ($c -eq '1') {
    C ''
    C '  通过计划任务启动（不会挂在当前窗口）...' Yellow
    Start-ScheduledTask -TaskName 'SP-PM2-Resurrect' -ErrorAction SilentlyContinue
    for ($i = 20; $i -gt 0; $i--) { Write-Host "`r  等待 $i 秒   " -NoNewline -ForegroundColor DarkGray; Start-Sleep -Seconds 1 }
    Write-Host "`r               " -ForegroundColor DarkGray
    C '  已发起'
  } elseif ($c -eq '2') { $pm2 = Get-Pm2; if ($pm2) { & $pm2 list } else { C '  找不到 pm2.cmd' Red } }
}

# ---------- 只读：日志 ----------
function LogMenu {
  Banner '日志'
  C '  1) 素材加载失败（地图/模型没加载出来看这个）' White
  C '  2) 最慢的素材加载' White
  C '  3) nginx 启动日志' White
  C '  4) 看门狗日志' White
  C '  5) 某个节点的错误日志' White
  C '  6) 返回' DarkGray
  $c = Read-Host '  选择'
  C ''
  if ($c -eq '1') {
    $f = 'nginx\logs\assets.log'
    if (Test-Path $f) {
      $bad = Get-Content $f | Select-String ' \d{3} .* ' | Where-Object { $_.Line -match '^\S+ (4\d\d|5\d\d) ' }
      if ($bad) { C "  失败 $($bad.Count) 条（最近 20 条）:" Yellow; $bad | Select-Object -Last 20 | ForEach-Object { C "  $($_.Line)" } }
      else { C '  ✓ 没有失败记录' Green }
    } else { C '  日志文件不存在（素材日志可能已关闭）' Yellow }
  } elseif ($c -eq '2') {
    $f = 'nginx\logs\assets.log'
    if (Test-Path $f) {
      Get-Content $f | ForEach-Object { if ($_ -match '^\S+ (\d{3}) (\d+)B ([\d.]+)s src=(\S*) uri=(\S+)') { [pscustomobject]@{ 耗时 = [double]$matches[3]; 大小KB = [int]([int]$matches[2] / 1024); 地址 = $matches[5] } } } |
        Sort-Object 耗时 -Descending | Select-Object -First 20 | Format-Table -AutoSize | Out-String -Width 200 | ForEach-Object { C $_ }
      C '  正常应该都是 0.0xx 秒；如果出现 60 秒以上，说明 nginx 有残留 worker（菜单 5 重启）' DarkGray
    } else { C '  日志文件不存在' Yellow }
  } elseif ($c -eq '3') { if (Test-Path 'logs\nginx-start.log') { Get-Content 'logs\nginx-start.log' -Tail 30 | ForEach-Object { C "  $_" } } else { C '  没有 nginx 启动日志（可能还没用计划任务启动过）' Yellow } }
  elseif ($c -eq '4') { @('logs\stack-watchdog.log', 'logs\pm2-resurrect.log') | ForEach-Object { if (Test-Path $_) { C "  --- $_ ---" DarkCyan; Get-Content $_ -Tail 10 | ForEach-Object { C "  $_" } } } }
  elseif ($c -eq '5') {
    $n = Read-Host '  节点号（1-30）'
    $f = Get-ChildItem "logs\node-$n.error-*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f -and $f.Length -gt 0) { Get-Content $f.FullName -Tail 30 | ForEach-Object { C "  $_" } }
    else { C "  node-$n 没有错误日志 ✓" Green }
  }
}

# ---------- 主循环 ----------
while ($true) {
  Clear-Host
  C ''
  C '  ╔══════════════════════════════════════════════════════════════╗' Cyan
  C '  ║              卫戍协议 · 运维面板                              ║' Cyan
  C '  ╚══════════════════════════════════════════════════════════════╝' Cyan
  C ''
  C '  ── 查看状态（只读，随便点）──' DarkGray
  C '   1) 服务器总览（节点 / 对局 / nginx / 网站）' White
  C '   2) 看哪些节点可以重启' White
  C ''
  C '  ── 日常操作 ──' DarkGray
  C '   3) 重启空闲节点' Green
  C '   4) 更新对外开放的节点（改 nginx）' Green
  C '   5) 重启 nginx（清理残留 worker）' Green
  C '   6) PM2（启动 / 查看）' Green
  C ''
  C '  ── 排查 ──' DarkGray
  C '   7) 看日志' White
  C ''
  C '   0) 退出' DarkGray
  C ''
  $c = Read-Host '  请输入数字'

  switch ($c) {
    '1' { Show-Status; Pause2 }
    '2' { Show-Restartable; Pause2 }
    '3' { Restart-Idle; Pause2 }
    '4' { Update-Open; Pause2 }
    '5' { Restart-Nginx; Pause2 }
    '6' { Pm2Menu; Pause2 }
    '7' { LogMenu; Pause2 }
    '0' { break }
    default { }
  }
  if ($c -eq '0') { break }
}
