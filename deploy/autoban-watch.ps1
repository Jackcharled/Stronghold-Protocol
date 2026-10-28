# 自动封 IP 守护的自愈：每 5 分钟检查一次，没在跑就拉起来。
#
# 为什么需要（2026-10-28 发现）：
#   守护任务 SP-Nginx-AutoBan 原来设了 72 小时执行上限（ExecutionTimeLimit PT72H），
#   而它只有 Boot 触发器 —— 于是从 10-25 14:58 启动到 10-28 14:58 满 72 小时就被系统终止，
#   之后**再也不会自己回来**，控制台一直显示「守护未运行」。
#   上限已经改成 PT0S（不限）；这个脚本是第二道保险：
#   不管因为什么原因停掉（被杀、崩溃、手动结束），5 分钟内自动恢复。
#
# 由计划任务 SP-AutoBan-Watch 以 SYSTEM 身份每 5 分钟调用。
$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\Stronghold-Protocol'
$log = Join-Path $root 'logs\autoban-watch.log'
$hb = Join-Path $root 'guard\heartbeat.txt'

function Write-Log([string]$text) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

# 已经在跑吗？用命令行匹配，避免误判其它 powershell
$running = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'nginx-autoban\.ps1' })
if ($running.Count -gt 0) { exit 0 }   # 正常，不写日志（避免每 5 分钟一行噪音）

# 心跳还新鲜吗（3 分钟内）？脚本每 20 秒写一次，新鲜说明刚被别的实例接手
$fresh = $false
if (Test-Path -LiteralPath $hb) {
  try {
    $t = [datetime](Get-Content -LiteralPath $hb -Raw).Trim()
    $fresh = ((Get-Date) - $t).TotalMinutes -lt 3
  } catch { /* 心跳文件坏了就当不新鲜 */ }
}
if ($fresh) {
  # 心跳很新但进程不在 —— 可能是刚被拉起还在初始化，这一轮先别插手
  Write-Log 'heartbeat is fresh but no process found -> wait one round'
  exit 0
}

Write-Log 'autoban daemon is not running -> start via SP-Nginx-AutoBan'

# 走计划任务启动（SYSTEM / Session 0），不在当前会话里 spawn
$null = & schtasks.exe /Run /TN 'SP-Nginx-AutoBan' 2>&1
Start-Sleep -Seconds 8

$after = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'nginx-autoban\.ps1' })
if ($after.Count -gt 0) { Write-Log ('recovered (pid ' + ($after[0].ProcessId) + ')') }
else { Write-Log 'ALERT still not running after start attempt' }
