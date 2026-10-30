# 节点存活巡检：把「当前可用的节点」写成 nginx 的 split_clients / cookie 映射，
# 并自动 reload。节点挂了自动摘掉，节点回来了自动加回。
#
#   powershell -NoProfile -File tools\sync-open-nodes.ps1              # 只报告
#   powershell -NoProfile -File tools\sync-open-nodes.ps1 -Apply       # 真的改配置并 reload
#   powershell -NoProfile -File tools\sync-open-nodes.ps1 -Apply -Force # 无变化也 reload
#
# ★ 为什么需要它：
#   2026-10-31 修「刷新掉回大厅」时，把 nginx 的 open 节点列表从 11 个改成了全部 30 个。
#   那样确实解决了「玩家在 node-1 打对局、cookie 却因 node-1 不在列表而被判无效、
#   于是被改派到别的节点、回不了房间」的问题，**但丢掉了「关闭某节点」的能力**：
#   一旦某台节点挂了/被停，新玩家仍可能被 split_clients 分过去。
#
#   nginx 社区版没有「动态读节点列表」的机制（1.31.7 也不行），include 的文件也要
#   reload 才生效。所以这里做成：**主动探测 + 重写 include 文件 + 自动 reload**。
#
#   探测方式与 matchmaker 的 nodeStatus 一致：GET /healthz，900ms 超时。
#   写进 nginx/conf/open-nodes.conf：split_clients 与 map 都在里面，
#   主配置用 include 引它，本脚本是唯一改这份文件的地方。
#
# ★ 安全约束（与重启纪律一致）：
#   * 只 READ /healthz，绝不重启任何东西
#   * 改了配置先 nginx -t，**验证不过就回滚，绝不 reload 一个坏配置**
#   * 列表无变化时不 reload（reload 会踢掉所有 WebSocket）

param([switch]$Apply, [switch]$Force)

$ErrorActionPreference = 'Continue'

# ★ 输出编码：被 dashboard 以子进程方式调用时，stdout 是管道，PowerShell 默认按控制台
#   代码页（中文系统 = GBK/936）写出去，而 dashboard 按 UTF-8 读 → 面板上显示成
#   「ڵ�̽��」这样的乱码。这里强制管道输出用 UTF-8。
#   直接写 UTF8 无 BOM：带 BOM 时某些调用方会在第一行前面看到一个多余字符。
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

$root = Split-Path -Parent $PSScriptRoot
$nginxExe = Join-Path $root 'nginx\nginx.exe'
$nginxPrefix = Join-Path $root 'nginx'
$confFile = Join-Path $root 'nginx\conf\open-nodes.conf'
$backupDir = Join-Path $root 'backups\open-nodes'
$logFile = Join-Path $root 'logs\open-nodes.log'
$TOTAL = 30
$TIMEOUT_MS = 900

function Log-Pair {
  param([string[]]$Lines)
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $out = @("===== $stamp =====") + $Lines
  $out | ForEach-Object { Write-Output $_ }
  try {
    if (-not (Test-Path (Split-Path -Parent $logFile))) { New-Item -ItemType Directory -Path (Split-Path -Parent $logFile) -Force | Out-Null }
    $out | Out-File -FilePath $logFile -Append -Encoding UTF8
  } catch { }
}

# ── 1) 探测所有节点 ────────────────────────────────────────────────
$alive = @()
$dead = @()
for ($n = 1; $n -le $TOTAL; $n++) {
  $ok = $false
  try {
    $r = Invoke-RestMethod -Uri ('http://127.0.0.1:{0}/healthz' -f (3000 + $n)) -TimeoutSec 2 -ErrorAction Stop
    $ok = ($r.ok -eq $true)
  } catch { $ok = $false }
  if ($ok) { $alive += $n } else { $dead += $n }
}

$lines = @()
$lines += ('节点探测: 存活 {0} / 挂掉 {1}' -f $alive.Count, $dead.Count)
if ($dead.Count -gt 0) { $lines += ('  挂掉: {0}' -f ($dead -join ',')) }

if ($alive.Count -eq 0) {
  $lines += '★ 没有任何节点存活，不修改配置（否则会把所有人锁在外面）'
  Log-Pair $lines
  exit 1
}

# ── 2) 生成新配置内容 ──────────────────────────────────────────────
$pct = [math]::Round(100.0 / $alive.Count, 2)
$newLines = @(
  '# 由 tools\sync-open-nodes.ps1 自动生成，请勿手改。'
  '# 内容 = 当前存活（/healthz 可用）的节点。节点挂了会被自动摘掉，回来会自动加回。'
  ''
  '# sp_route cookie 缺失/无效时去哪：只在存活节点里随机'
  'split_clients "$request_id" $sp_rand_node {'
)
for ($i = 0; $i -lt $alive.Count; $i++) {
  $v = if ($i -eq $alive.Count - 1) { [math]::Round(100.0 - ($pct * ($alive.Count - 1)), 2) } else { $pct }
  $newLines += ('  {0}% {1};' -f $v.ToString('0.00'), $alive[$i])
}
$newLines += '}'
$newLines += ''
$newLines += '# sp_route cookie 指向存活节点 → 视为有效（粘住它）；指向挂掉的节点 → 无效 → 重新分流'
$newLines += 'map $cookie_sp_route $sp_cookie_open {'
$newLines += '  default 0;'
$newLines += ('  {0}' -f (($alive | ForEach-Object { "$_ 1;" }) -join ' '))
$newLines += '}'
$newLines += ''

$newContent = ($newLines -join "`n") + "`n"
$oldContent = if (Test-Path $confFile) { [System.IO.File]::ReadAllText($confFile, [System.Text.Encoding]::UTF8) } else { '' }

if ($oldContent -eq $newContent) {
  $lines += '配置无变化，不 reload'
  Log-Pair $lines
  exit 0
}

$lines += ('节点列表变化: {0} -> {1}' -f `
    $(if ($oldContent) { '（旧文件存在）' } else { '（新文件）' }), `
    ('[' + ($alive -join ',') + ']'))

if (-not $Apply) {
  $lines += '（只报告。加 -Apply 才会写文件并 reload）'
  Log-Pair $lines
  exit 0
}

# ── 3) 备份 → 写入 → nginx -t → 失败回滚 ──────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if ($oldContent) {
  if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null }
  [System.IO.File]::WriteAllText((Join-Path $backupDir ("open-nodes.conf.$stamp")), $oldContent, (New-Object System.Text.UTF8Encoding($false)))
}

[System.IO.File]::WriteAllText($confFile, $newContent, (New-Object System.Text.UTF8Encoding($false)))
$lines += '已写入 open-nodes.conf'

$test = & $nginxExe -t -p $nginxPrefix -c 'conf/nginx.conf' 2>&1 | Out-String
if ($LASTEXITCODE -ne 0 -or $test -notmatch 'test is successful') {
  $lines += '★ nginx -t 失败，回滚'
  ($test -split "`r?`n") | Where-Object { $_ } | Select-Object -First 4 | ForEach-Object { $lines += ('    ' + $_.Trim()) }
  if ($oldContent) {
    [System.IO.File]::WriteAllText($confFile, $oldContent, (New-Object System.Text.UTF8Encoding($false)))
    $lines += '已回滚到旧配置'
  } else {
    Remove-Item $confFile -Force -ErrorAction SilentlyContinue
    $lines += '已删除新文件'
  }
  Log-Pair $lines
  exit 1
}
$lines += 'nginx -t 通过'

# ── 4) reload（只 reload，不重启；干净退出旧 worker）────────────────
# ★ reload 必须走 SYSTEM 计划任务：nginx 主进程是 SYSTEM，普通 shell 发 reload 会得到
#   nginx: [error] OpenEvent("Global\ngx_reload_<pid>") failed (5: Access is denied)
#   配置改了却没生效，而且还容易误报成功（踩过）。
$lines += '正在通过 SYSTEM 计划任务 reload nginx…'
schtasks /Run /TN "SP-Nginx-Reload" 2>&1 | Out-Null
Start-Sleep -Seconds 8

# 校验：读 reload 日志的最后一次结果
$reloadLog = Join-Path $root 'logs\nginx-reload.log'
if (Test-Path $reloadLog) {
  $tail = Get-Content $reloadLog -Tail 6 -ErrorAction SilentlyContinue
  $tail | ForEach-Object { $lines += ('    ' + $_) }
  if (($tail -join "`n") -match 'HTTPS 首页: 200') {
    $lines += 'reload 成功，HTTPS 正常'
  } else {
    $lines += '★ reload 结果存疑，请查 logs\nginx-reload.log'
  }
} else {
  $lines += '★ 没有 reload 日志，请确认 SP-Nginx-Reload 计划任务存在'
}
$lines += ('★ 当前开放节点: {0}' -f ($alive -join ','))
Log-Pair $lines
