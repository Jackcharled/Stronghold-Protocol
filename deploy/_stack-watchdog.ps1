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

# ---- nginx：只报警（重启 nginx 会切断所有连接，风险高，交给人判断） ----
if (-not (Get-Process nginx -ErrorAction SilentlyContinue)) {
  Write-Log 'ALERT nginx is not running'
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
$tmp = Join-Path $env:TEMP 'sp-pm2-jlist.json'
$null = Invoke-HiddenOut 'cmd.exe' ('/c ""' + $pm2 + '" jlist > "' + $tmp + '" 2>nul"')
$nodeExe = 'D:\nodejs\node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = 'node' }
$r = Invoke-HiddenOut $nodeExe ('"' + (Join-Path $root 'deploy\_pm2-online.cjs') + '" "' + $tmp + '"')
if ($r.code -ne 0) {
  # 读不到状态时不要盲目 start（会把正在跑的进程重复拉起），只记录。
  Write-Log 'ALERT cannot read PM2 status'
  exit 0
}
$online = @($r.out -split ',')
$expected = @('matchmaker', 'dashboard')
1..30 | ForEach-Object { $expected += ('node-' + $_) }
$missing = @($expected | Where-Object { $online -notcontains $_ })

if ($missing.Count -gt 0) {
  Write-Log ('PM2 apps missing (' + $missing.Count + '): ' + ($missing -join ', ') + ' -> start')

  # 先试「恢复上次保存的进程表」——最快、且只补缺的部分。
  $null = Invoke-HiddenOut 'cmd.exe' ('/c ""' + $pm2 + '" resurrect >nul 2>nul"')
  Start-Sleep -Seconds 6

  # 再复核一次：还缺的单独 start（--update-env 保证环境变量与 ecosystem 一致）。
  $null = Invoke-HiddenOut 'cmd.exe' ('/c ""' + $pm2 + '" jlist > "' + $tmp + '" 2>nul"')
  $r2 = Invoke-HiddenOut $nodeExe ('"' + (Join-Path $root 'deploy\_pm2-online.cjs') + '" "' + $tmp + '"')
  if ($r2.code -eq 0) {
    $online2 = @($r2.out -split ',')
    $still = @($expected | Where-Object { $online2 -notcontains $_ })
    if ($still.Count -gt 0) {
      foreach ($name in $still) {
        Write-Log ('  start ' + $name)
        $null = Invoke-HiddenOut 'cmd.exe' ('/c ""' + $pm2 + '" start "' + (Join-Path $root 'ecosystem.config.cjs') + '" --only ' + $name + ' --update-env >nul 2>nul"')
      }
    }
    $null = Invoke-HiddenOut 'cmd.exe' ('/c ""' + $pm2 + '" save >nul 2>nul"')
    Write-Log 'PM2 recovered and saved'
  }
}
