# 重启巡检：每 10 分钟跑一次，记录所有节点的运行时长与重启次数。
#
# 目的：玩家反馈「一直在重启」时，需要一份不依赖人盯着的连续记录。
# 只要某台节点的运行时长比上次记录变小（归零），就说明它重启过，
# 连同当时的 pm2 重启次数一起写进 logs\restart-watch.log。
#
# 由计划任务 SP-Restart-Watch 以 SYSTEM 身份每 10 分钟调用。
$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\Stronghold-Protocol'
$log = Join-Path $root 'logs\restart-watch.log'
$stateFile = Join-Path $root 'logs\.restart-watch-state.json'
$pm2 = Join-Path $env:APPDATA '..\..\npm\pm2.cmd'
if (-not (Test-Path $pm2)) { $pm2 = 'C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd' }

function Write-WatchLog([string]$text) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

# ---- 1) 采集当前状态 ----
$now = @{}
foreach ($n in 1..30) {
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$((3000 + $n))/healthz" -TimeoutSec 3
    $now["node-$n"] = [int]$h.uptimeSec
  } catch {
    $now["node-$n"] = -1   # 无响应
  }
}

# ---- 2) 读上次的状态 ----
$prev = @{}
if (Test-Path -LiteralPath $stateFile) {
  try {
    $raw = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json -AsHashtable
    if ($raw.uptime) { foreach ($k in $raw.uptime.Keys) { $prev[$k] = [int]$raw.uptime[$k] } }
  } catch { /* 状态文件坏了就当第一次跑 */ }
}

# ---- 3) 比对：运行时长变小 = 重启过 ----
$restarted = @()
$dead = @()
foreach ($k in $now.Keys) {
  $cur = $now[$k]
  if ($cur -lt 0) { $dead += $k; continue }
  if ($prev.ContainsKey($k) -and $prev[$k] -gt 0 -and $cur -lt $prev[$k]) {
    $restarted += ('{0}({1}s->{2}s)' -f $k, $prev[$k], $cur)
  }
}

# ---- 4) 记录 ----
$alive = @($now.Values | Where-Object { $_ -ge 0 })
$avg = if ($alive.Count) { [int](($alive | Measure-Object -Average).Average) } else { 0 }
$summary = 'alive={0}/30 avg_uptime={1}s' -f $alive.Count, $avg

if ($restarted.Count -gt 0) {
  Write-WatchLog ('RESTART DETECTED: ' + ($restarted -join ', ') + ' | ' + $summary)
  # 顺带记录 pm2 的重启计数，方便判断是 pm2 重启还是进程自己挂的
  try {
    $tmp = Join-Path $env:TEMP 'sp-restart-watch-jlist.json'
    $null = & cmd.exe /c ('""' + $pm2 + '" jlist > "' + $tmp + '" 2>nul"')
    $j = Get-Content -LiteralPath $tmp -Raw | ConvertFrom-Json -AsHashtable
    $cnt = ($j | ForEach-Object { '{0}={1}' -f $_.name, $_.pm2_env.restart_time }) -join ' '
    Write-WatchLog ('  pm2 restarts: ' + $cnt)
  } catch { Write-WatchLog '  (could not read pm2 restarts)' }
} elseif ($dead.Count -gt 0) {
  Write-WatchLog ('DEAD NODES: ' + ($dead -join ', ') + ' | ' + $summary)
} else {
  # 没有异常时只保留一行心跳，避免日志无限增长
  Write-WatchLog ('ok ' + $summary)
}

# ---- 5) 保存状态 ----
try {
  @{ at = (Get-Date -Format 'o'); uptime = $now } | ConvertTo-Json -Depth 3 |
    Out-File -LiteralPath $stateFile -Encoding UTF8
} catch { Write-WatchLog ('state save failed: ' + $_.Exception.Message) }
