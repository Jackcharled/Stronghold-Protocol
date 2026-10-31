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

# 不对外接新玩家的节点（逗号分隔节点号）。它们仍然留在 map 里，
# 所以已经在那台上的人刷新 / 重连都不受影响，只是新访客不会再被分过去。
# 用法：临时维护某台节点（例如开 SP_TEST_MODE 做排查）时把它加进来，
#       维护完记得删掉，否则它永远接不到新玩家。
# 当前为空 —— 2026-10-31 的莱恩哈特伤害排查已结束，node-30 恢复开放。
$EXCLUDE = @()

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

# ── 1.5) 哪些节点还在跑旧代码 ──────────────────────────────────────
# ★ 这是「新玩家不往旧代码节点发」的依据，也是本脚本与维护者需求的接口。
#
#   维护者要的是：「根据代码判断，不要我手动管每个节点」——
#   跑旧代码的节点自动不接新玩家，但那台上**已经在玩的人完全不受影响**。
#
#   所以两个块分开写，这是本脚本最要紧的设计：
#     · split_clients（新访客去哪） → 只写「活着 且 新代码」
#     · map $cookie_sp_route（老 cookie 还算不算有效） → 写「活着」的**全部**节点
#
#   为什么 map 必须包含旧代码节点：map 决定的是「浏览器带来的 sp_route cookie 还算不算有效」。
#   一旦把旧代码节点从 map 里摘掉，那台机器上的玩家刷新页面时 cookie 就被判无效、
#   被随机分到别的节点，而新节点上没有他的会话 → 掉回大厅。
#   这正是 2026-10-31 上午的事故（当时白名单漏了 node-1）。详见 MAINTENANCE.md §9.34。
#
#   那旧代码节点上的人刷新怎么办？刷新时地址栏带着 ?room=CODE（进房时写进 URL 的），
#   nginx 的 `if ($arg_room ~ ...) { set $sp_node $cookie_sp_route; }` 会强制回原节点，
#   不受开放列表影响。所以「只挡住新访客」和「里面的人不受影响」可以同时成立。
#
#   数据源：dashboard 的 /api/ops/state（它读 pm2 的进程启动时间，比 /healthz 的 build 字段准
#   —— build 只覆盖 public/js、server/sim、shared、data，**不含 server/net.js、server/lobby.js**）。
$stale = @()
$codeUnknown = $false
try {
  $st = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/api/ops/state' -TimeoutSec 20 -ErrorAction Stop
  if ($st.stale) { $stale = @($st.stale) }
} catch {
  # 拿不到就**不下判断**：宁可按「全部算新代码」放行（新玩家照进旧代码节点），
  # 也不能反过来把旧代码节点判成"不开放"后误伤 map —— 那会直接造成刷新掉大厅。
  $codeUnknown = $true
}

$lines = @()
$lines += ('节点探测: 存活 {0} / 挂掉 {1}' -f $alive.Count, $dead.Count)
if ($dead.Count -gt 0) { $lines += ('  挂掉: {0}' -f ($dead -join ',')) }
if ($codeUnknown) {
  $lines += '★ 读不到 /api/ops/state，无法判断代码新旧：本次不做「新访客过滤」（旧代码节点照常接新玩家）'
} elseif ($stale.Count -gt 0) {
  $lines += ('  跑旧代码: {0}（不接新玩家，但其中的人刷新/重连不受影响）' -f ($stale -join ','))
}

if ($alive.Count -eq 0) {
  $lines += '★ 没有任何节点存活，不修改配置（否则会把所有人锁在外面）'
  Log-Pair $lines
  exit 1
}

# 新访客可以去的节点 = 活着 且 跑新代码。挂掉的、跑旧代码的都挡在外面。
$accept = @($alive | Where-Object { $stale -notcontains $_ -and $EXCLUDE -notcontains $_ })
$excludedAlive = @($alive | Where-Object { $EXCLUDE -contains $_ })
if ($excludedAlive.Count -gt 0) {
  $lines += ('  维护者保留（不接新玩家）: {0}' -f ($excludedAlive -join ','))
}
# 极端兜底：如果所有人都"跑旧代码"（比如代码刚更新、一台都还没重启），
# 这时如果严格过滤，新玩家会无处可去 —— 站点等于关停。
# 按「可用性优先」放行全部存活节点，并把这件事写进日志提醒去重启。
if ($accept.Count -eq 0) {
  $accept = @($alive | Where-Object { $EXCLUDE -notcontains $_ })
  if ($accept.Count -eq 0) { $accept = $alive }   # 连排除后都空了，只能全放
  $lines += '★ 所有存活节点都还在跑旧代码：本次放行全部存活节点接新玩家（否则新玩家将无处可去）'
  $lines += '  → 请尽快重启这些节点（面板「重启这 N 个空闲节点」）'
}

# ── 2) 生成新配置内容 ──────────────────────────────────────────────
$pct = [math]::Round(100.0 / $accept.Count, 2)
$newLines = @(
  '# 由 tools\sync-open-nodes.ps1 自动生成，请勿手改。'
  '# split_clients = 新访客去哪（只含：存活 且 已跑新代码）'
  '# map           = 老 cookie 还算不算有效（含全部存活节点，含旧代码节点）'
  '#'
  '# ⚠ 两个块的口径**故意不同**，不要为了「整齐」把它们改成一样：'
  '#   把旧代码节点从 map 里摘掉 = 那台上的玩家一刷新就掉回大厅（2026-10-31 事故，手册 §9.34）。'
  ''
  '# 新访客（无 cookie）随机分到哪：只在「存活 且 新代码」的节点里随机'
  'split_clients "$request_id" $sp_rand_node {'
)
for ($i = 0; $i -lt $accept.Count; $i++) {
  $v = if ($i -eq $accept.Count - 1) { [math]::Round(100.0 - ($pct * ($accept.Count - 1)), 2) } else { $pct }
  $newLines += ('  {0}% {1};' -f $v.ToString('0.00'), $accept[$i])
}
$newLines += '}'
$newLines += ''
$newLines += '# sp_route cookie 指向存活节点 → 视为有效（粘住它）；指向挂掉的节点 → 无效 → 重新分流'
$newLines += '# ★ 这里必须是「存活」的全部节点，不能只写 $accept：'
$newLines += '#   旧代码节点上正在对局的玩家刷新时必须能回到自己那台，否则掉回大厅。'
$newLines += 'map $cookie_sp_route $sp_cookie_open {'
$newLines += '  default 0;'
$newLines += ('  {0}' -f (($alive | ForEach-Object { "$_ 1;" }) -join ' '))
$newLines += '}'
$newLines += ''
$newLines += '# 「当前这个请求落在的节点，还接不接新玩家」→ 1 接 / 0 不接。'
$newLines += '# 用途：前端拿来给那台上的玩家提示「这局打完刷新一下可换到新版本」'
$newLines += '# （结算页的提示，见 public/js/ui/nodeCodeHint.js）。纯展示用，不参与路由。'
$newLines += 'map $sp_node $sp_node_accepts_new {'
$newLines += '  default 0;'
$newLines += ('  {0}' -f (($accept | ForEach-Object { "$_ 1;" }) -join ' '))
$newLines += '}'
$newLines += ''
$newLines += '# 「老 cookie 指向的这个节点，接不接新玩家」→ 1 接（新代码）/ 0 不接（旧代码）。'
$newLines += '# 与 map $sp_node $sp_node_accepts_new 同源，只是 key 换成 cookie。'
$newLines += '# 用途（2026-10-31）：cookie 指向旧代码节点时，只有「正开着对局」的玩家才允许粘住，'
$newLines += '# 其余人改派到新代码节点 —— 否则 30 天有效的老 cookie 会把玩家永久锁在旧版本上。'
$newLines += 'map $cookie_sp_route $sp_cookie_accepts_new {'
$newLines += '  default 0;'
$newLines += ('  {0}' -f (($accept | ForEach-Object { "$_ 1;" }) -join ' '))
$newLines += '}'
$newLines += ''

$newContent = ($newLines -join "`n") + "`n"
$oldContent = if (Test-Path $confFile) { [System.IO.File]::ReadAllText($confFile, [System.Text.Encoding]::UTF8) } else { '' }

# ★ 只有「内容相同」且「没加 -Force」才跳过。
#   -Force 的用途：改的是 nginx.conf 本身（open-nodes.conf 没变），仍然要 reload 一次才生效。
#   踩过：改了 nginx.conf 跑 -Apply，被这里短路成「配置无变化」，新配置一直没上线，白测半天。
if ($oldContent -eq $newContent -and -not $Force) {
  $lines += '配置无变化，不 reload'
  Log-Pair $lines
  exit 0
}
if ($oldContent -eq $newContent) {
  $lines += '配置无变化，但 -Force 指定了强制 reload'
}

$lines += ('节点列表变化: {0} -> 新访客可去 [{1}]' -f `
    $(if ($oldContent) { '（旧文件存在）' } else { '（新文件）' }), `
    ($accept -join ','))

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
