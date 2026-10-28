# 卫戍协议 · 服务器看门狗（自动恢复，不只是报警）
#
# 由计划任务 SP-Stack-Watchdog 每 2 分钟以 SYSTEM 身份运行。
#
# ★ 2026-10-27 改造（维护者要求「不要让我必须启动你我才能启动服务器」）：
#   之前这个脚本只写一行 ALERT 日志，**从不拉起任何进程**。于是当 pm2 因为
#   任何原因退出（最典型的是：pm2 是在某个交互式 shell 里启动的，那个 shell
#   所属的应用一重启，pm2 就跟着死）时，30 个游戏节点全部消失，玩家看到
#   「与服务器的连接已中断，正在重连」，必须等人手动 `pm2 resurrect`。
#
#   现在：pm2 守护进程不在 → 立刻拉起；应用缺失 → 逐个 start；没保存 → save。
#   这套逻辑完全独立于任何用户会话，开机与崩溃后都能自愈。
$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\Stronghold-Protocol'
$pm2 = 'C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd'
$env:PM2_HOME = 'C:\Users\Administrator\.pm2'
$log = Join-Path $root 'logs\stack-watchdog.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Write-Log([string]$text) {
  "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text | Out-File -FilePath $log -Append -Encoding utf8
}
if (Test-Path (Join-Path $root '.maintenance')) { exit 0 }

function Invoke-HiddenOut([string]$exe, [string]$argLine) {
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd()
    $null = $p.StandardError.ReadToEnd()
    $p.WaitForExit(30000) | Out-Null
    return @{ code = $p.ExitCode; out = $out }
  } catch {
    Write-Log ("Invoke-HiddenOut failed: " + $_.Exception.Message)
    return @{ code = 1; out = '' }
  }
}

# ---- nginx：进程不在就重新拉起（2026-10-28 接手旧看门狗的职责） ----
#
# 旧的 Stronghold-Server-Watchdog 会救 nginx，但它以 Interactive 身份运行在桌面会话，
# 每分钟 flash 一个 PowerShell 窗口。现在它已 Disabled，这里补上同样的能力。
#
# 两种情况不插手：
#   * 维护者正在手动重启（logs\.nginx-restarting 标记，90 秒内有效）；
#   * 游戏入口被人为停止（data\watchdog-disabled）。
# 注意：这里只处理「进程整个没了」。nginx 卡死但进程还在的情况由人判断，
# 因为强杀会切断所有在线连接。
$restartHint = Join-Path $root 'logs\.nginx-restarting'
$busy = (Test-Path -LiteralPath $restartHint) -and ((Get-Date) - (Get-Item -LiteralPath $restartHint).LastWriteTime).TotalSeconds -lt 90
if ($busy) {
  Write-Log 'nginx restart in progress (manual) -> skip'
} elseif (-not (Get-Process nginx -ErrorAction SilentlyContinue)) {
  Write-Log 'nginx is not running -> start via SP-Nginx-Start (SYSTEM)'
  # 走计划任务启动，新进程才会落在 Session 0（直接 Start-Process 会挂在当前会话）
  $null = Invoke-HiddenOut 'schtasks.exe' '/Run /TN "SP-Nginx-Start"'
  Start-Sleep -Seconds 6
  if (Get-Process nginx -ErrorAction SilentlyContinue) { Write-Log 'nginx recovered via SP-Nginx-Start' }
  else { Write-Log 'ALERT nginx did not come back' }
}

# ---- PM2 守护进程：不在就拉起来 ----
$pm2Alive = $false
try {
  $god = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'pm2[\\/]lib[\\/]Daemon\.js' }
  $pm2Alive = ($null -ne $god)
} catch { $pm2Alive = $false }

if (-not $pm2Alive) {
  Write-Log 'PM2 daemon is down -> resurrect'
  $null = Invoke-HiddenOut 'cmd.exe' ('/c ""' + $pm2 + '" resurrect >nul 2>nul"')
  Start-Sleep -Seconds 8
}

# ---- 读取在线应用，找出缺失的 ----
# ⚠ 2026-10-28 事故：这里原本在「缺失」分支里直接 `pm2 resurrect`。
#   resurrect 会把**整张进程表重新拉起** —— 已在线（正在打对局）的节点也被连带重启，
#   实测一次中断 10 局。而触发它的常常只是 `pm2 jlist` 抖动一次：
#   `pm2-logrotate` 之类偶尔让 jlist 返回不完整，于是被误判成「应用缺失」。
#
#   现在三条防线：
#     1. jlist 必须**连着两次**读到、且两次一致，才认为读数可信（单次抖动不算）；
#     2. 只对**确实缺失**的应用逐个 start，**永不 resurrect**；
#     3. 缺失超过一半时认定是读数问题而不是真故障，直接放弃（不碰任何进程）。
$tmp = Join-Path $env:TEMP 'sp-pm2-jlist.json'
$nodeExe = 'D:\nodejs\node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = 'node' }

function Read-Online {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  $null = Invoke-HiddenOut 'cmd.exe' ('/c ""' + $pm2 + '" jlist > "' + $tmp + '" 2>nul"')
  if (-not (Test-Path -LiteralPath $tmp)) { return $null }
  # 空文件 / 明显过小的响应一律当读取失败
  if ((Get-Item -LiteralPath $tmp).Length -lt 1000) { return $null }
  $r = Invoke-HiddenOut $nodeExe ('"' + (Join-Path $root 'deploy\_pm2-online.cjs') + '" "' + $tmp + '"')
  if ($r.code -ne 0) { return $null }
  $list = @($r.out -split ',' | Where-Object { $_ })
  if ($list.Count -eq 0) { return $null }
  return $list
}

$a1 = Read-Online
if ($null -eq $a1) {
  Write-Log 'ALERT cannot read PM2 status'
  exit 0
}
Start-Sleep -Seconds 2
$a2 = Read-Online
if ($null -eq $a2 -or (($a1 -join ',') -ne ($a2 -join ','))) {
  # 两次读数不一致 = 正在变动或读数不稳，这一轮什么都不做
  Write-Log ('ALERT PM2 status unstable (' + $a1.Count + ' vs ' + $(if ($null -eq $a2) { 'null' } else { $a2.Count }) + '), skip this round')
  exit 0
}
$online = $a2
$expected = @('matchmaker', 'dashboard')
1..30 | ForEach-Object { $expected += ('node-' + $_) }
$missing = @($expected | Where-Object { $online -notcontains $_ })

# 缺失太多 → 更可能是读数问题，不是真故障。绝不动进程。
if ($missing.Count -gt [Math]::Floor($expected.Count / 2)) {
  Write-Log ('ALERT ' + $missing.Count + '/' + $expected.Count + ' apps look missing - treated as a read problem, no action')
  exit 0
}

if ($missing.Count -gt 0) {
  # 只 start 缺失的那几个。**不用 resurrect**：它会重启整张进程表，打断所有正在进行的对局。
  Write-Log ('PM2 apps missing (' + $missing.Count + '): ' + ($missing -join ', ') + ' -> start each')
  foreach ($name in $missing) {
    Write-Log ('  start ' + $name)
    $null = Invoke-HiddenOut 'cmd.exe' ('/c ""' + $pm2 + '" start "' + (Join-Path $root 'ecosystem.config.cjs') + '" --only ' + $name + ' --update-env >nul 2>nul"')
    Start-Sleep -Seconds 2
  }
  $null = Invoke-HiddenOut 'cmd.exe' ('/c ""' + $pm2 + '" save >nul 2>nul"')
  Write-Log 'PM2 recovered and saved'
}
