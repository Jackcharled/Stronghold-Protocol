# 重启判定：用「进程启动时间」对比「服务端代码最后修改时间」。
#
# 为什么不用 healthz 的 build？
#   buildTag 的 BUILD_INPUTS 只含 public/index.html、public/js、public/css、
#   server/sim、shared、data —— **不包含 server/net.js、server/lobby.js、server/match/**。
#   所以改了这些服务端文件后，所有节点的 build 仍然完全一样，用 build 判断
#   「是否需要重启」会漏掉它们（以为都是最新的）。
#
# 规则（维护者 2026-10-26 决定）：
#   只看有没有**正在进行的对局**（matches>0）。没有对局就可以重启——
#   包括开着房间未开局、只有停留页面连接的情况。有对局一律不动。
$ErrorActionPreference = 'Stop'
$root = 'D:\Stronghold-Protocol'
$probeNode = Join-Path $root 'node-1'

# 服务端代码里最新的修改时间（只看会影响进程逻辑的目录）
$watchDirs = @('server', 'shared')
$newest = [datetime]::MinValue
$newestFile = ''
foreach ($d in $watchDirs) {
  $p = Join-Path $probeNode $d
  if (-not (Test-Path $p)) { continue }
  Get-ChildItem $p -Recurse -Include '*.js','*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.LastWriteTime -gt $newest) { $newest = $_.LastWriteTime; $newestFile = $_.FullName.Replace($root, '') }
  }
}
Write-Host ("服务端最新改动: {0}  {1}" -f $newest.ToString('MM-dd HH:mm:ss'), $newestFile)

$safe = @(); $busy = @(); $current = @()
foreach ($n in 1..30) {
  $p = 3000 + $n
  try { $h = Invoke-RestMethod "http://127.0.0.1:$p/healthz" -TimeoutSec 2 } catch { Write-Host "  node-$n 无响应，跳过"; continue }
  $startedAt = (Get-Date).AddSeconds(-[double]$h.uptimeSec)
  $stale = $startedAt -lt $newest
  if (-not $stale) { $current += $n; continue }
  if ($h.matches -gt 0) {
    $busy += "node-$n(m=$($h.matches) r=$($h.rooms) h=$($h.humans) 启动于 $($startedAt.ToString('HH:mm:ss')))"
  } else { $safe += $n }
}

Write-Host "`n=== 已在最新代码上: $($current.Count) 个 ==="
Write-Host "=== 是旧代码但空闲，可重启: $($safe.Count) 个 ==="
if ($safe.Count -gt 0) { Write-Host "  " + (($safe | ForEach-Object { "node-$_" }) -join ', ') }
if ($busy.Count -gt 0) {
  Write-Host "=== 是旧代码且仍有对局，跳过: $($busy.Count) 个 ==="
  $busy | ForEach-Object { Write-Host "  $_" }
}

if ($safe.Count -eq 0) { Write-Host "`n没有可安全重启的节点"; exit 0 }

$names = ($safe | ForEach-Object { "node-$_" }) -join ','
Write-Host "`n=== 重启: $names ==="
& pm2 startOrReload ecosystem.config.cjs --only $names --update-env 2>&1 | Out-Null
& pm2 save 2>&1 | Out-Null
Start-Sleep -Seconds 6

Write-Host "`n=== 重启后校验 ==="
foreach ($n in $safe) {
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$(3000+$n)/healthz" -TimeoutSec 5
    Write-Host ("  node-{0,-3} ok={1} uptime={2}s matches={3}" -f $n, $h.ok, $h.uptimeSec, $h.matches)
  } catch { Write-Host "  node-$n 未起来" }
}
