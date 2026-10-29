# 等节点空闲时逐个重启，让新的 server/ 代码生效。
#
# 背景（2026-10-28）：server/ 下的改动（例如 lobby.js 的座位保护）**必须重启节点**
# 才生效。而重启会打断对局，所以只能在节点空闲时做。
#
# 这个脚本每 30 分钟跑一次：找出「跑着旧代码 + 当前没有对局也没有连接」的节点，
# 逐个 startOrReload。有玩家在的节点一律跳过 —— 重启纪律不变。
#
# 由计划任务 SP-Rolling-Restart 以 SYSTEM 身份每 30 分钟调用。
$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\Stronghold-Protocol'
$log = Join-Path $root 'logs\rolling-restart.log'
$marker = Join-Path $root 'data\rolling-restart-disabled'
$pm2 = Join-Path $env:APPDATA '..\..\npm\pm2.cmd'
if (-not (Test-Path $pm2)) { $pm2 = 'C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd' }

function Write-Log([string]$text) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

# 一键关闭开关（维护者要求人性化停止）
if (Test-Path -LiteralPath $marker) { exit 0 }

# ---- 1) 新代码的时间：server/ 下最新的 .js ----
# ⚠ 2026-10-29：这里原来只取最新 mtime。问题是 `sync-nodes --apply` 每分发一次就会
#   刷新 mtime（即使内容一模一样），于是 codeAt 不断前移，而进程启动时间不动，
#   节点就永远被判成「旧代码」。node-8/10/30 因此卡了 23 小时没被重启：
#   每次都判旧、又恰好轮流有对局，一直等不到窗口。
#   现在补一层内容指纹：server/ 树内容没变就把 codeAt 压回部署时刻，避免无意义重启。
$serverDir = Join-Path $root 'node-1\server'
# 单行：5.1 对管道跨行续行（行尾 | 后换行）容易出问题，实测会算出 null 然后静默 exit。
$newest = Get-ChildItem $serverDir -Recurse -File -Filter '*.js' | Measure-Object LastWriteTime -Maximum
$codeAt = $newest.Maximum
if (-not $codeAt) { Write-Log 'cannot read code mtime -> skip'; exit 0 }

$stampPath = Join-Path $root 'content\rolling-code-stamp.json'
# ⚠ 2026-10-29：这段踩了三个 5.1 的坑，记录一下别再犯：
#   ① Get-FileHash 逐文件调用 537 次，实测卡到几分钟不出结果；
#   ② `$ErrorActionPreference='SilentlyContinue'` 会把异常全吞掉，指纹算不出来时
#      脚本只是「无候选」退出，看不出任何异常 —— 所以下面临时改成 Stop；
#   ③ `[System.Text.Encoding]::UTF8.GetBytes()` / `[System.Text.Encoding]::UTF8` 这种
#      静态属性访问在计划任务的精简环境下可能返回 null，于是 `.Length` 直接抛
#      「You cannot call a method on a null-valued expression」。
#   改成纯 PowerShell 的字符串拼接 + Get-FileHash 之外的哈希：用 .NET 的 SHA256
#   但输入交给 [System.IO.File]::ReadAllBytes 的返回值拼成字符串再算。
#   实测 537 文件约 1 秒。
$ErrorActionPreference = 'Stop'
try {
  $parts = New-Object System.Collections.Generic.List[string]
  $shaF = [System.Security.Cryptography.SHA256]::Create()
  if ($null -eq $shaF) { throw 'SHA256.Create returned null' }
  foreach ($f in (Get-ChildItem $serverDir -Recurse -File -Filter '*.js' | Sort-Object FullName)) {
    $rel8 = $f.FullName.Substring($serverDir.Length)
    # 不用 Get-FileHash：它来自 Microsoft.PowerShell.Utility 模块，在计划任务的
    # 精简环境里可能整个模块都没加载（实测报 "Get-FileHash is not recognized"）。
    # 直接用 .NET 的 SHA256 读字节算，任何宿主都可用。
    $b = [System.IO.File]::ReadAllBytes($f.FullName)
    $h = [System.BitConverter]::ToString($shaF.ComputeHash($b)).Replace('-', '').ToLower()
    $parts.Add($rel8 + '=' + $h)
  }
  $joined = [string]::Join(';', $parts)
  # ⚠ 三个 5.1 的坑，全部实测踩过（2026-10-29）：
  #   ① [System.Text.Encoding]::UTF8.GetBytes() 在某些宿主下返回 null；
  #   ② New-Object System.Text.UTF8Encoding $false —— 位置参数传 $false 会静默返回 null；
  #   ③ 上面两种失败都被全局 SilentlyContinue 吞掉，表现成「无候选直接退出」。
  #   所以用 -ArgumentList 显式传参，并在拿不到对象时立刻抛出。
  #   ⚠ throw 的消息保持 ASCII：本文件若无 BOM，5.1 会按 GBK 解析中文，
  #     引号和括号配对会错乱、整个脚本语法崩掉（这是 2026-10-29 真正的元凶）。
  $enc = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false)
  if ($null -eq $enc) { throw 'UTF8Encoding ctor returned null' }
  $fpBytes = $enc.GetBytes($joined)
  if ($null -eq $fpBytes) { throw 'UTF8Encoding.GetBytes returned null' }
  $fingerprint = [System.BitConverter]::ToString($shaF.ComputeHash($fpBytes)).Replace('-', '').ToLower()
  $shaF.Dispose()
} catch {
  Write-Log ('fingerprint error: ' + $_.Exception.Message)
  $fingerprint = ''
}
$ErrorActionPreference = 'SilentlyContinue'
if (-not $fingerprint) {
  Write-Log 'fingerprint failed -> fall back to mtime (no stamp written)'
  $fingerprint = ''
}

$oldStamp = $null
try {
  if (Test-Path -LiteralPath $stampPath) {
    $oldStamp = Get-Content -LiteralPath $stampPath -Raw | ConvertFrom-Json
  }
} catch { $oldStamp = $null }

if ($oldStamp -and $fingerprint -and $oldStamp.fingerprint -eq $fingerprint -and $oldStamp.at) {
  # 内容没变：沿用上次记录的部署时刻，不让刷新过的 mtime 造成误判
  $codeAt = [datetime]::Parse($oldStamp.at)
} elseif ($fingerprint) {
  # 内容变了（或首次运行）：记下这次的部署时刻
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stampPath) | Out-Null
  $stampObj = [ordered]@{ fingerprint = $fingerprint; at = (Get-Date).ToString('o') }
  ($stampObj | ConvertTo-Json) | Set-Content -LiteralPath $stampPath -Encoding UTF8
  Write-Log ('server/ content changed -> new stamp ' + $fingerprint.Substring(0, 12))
}

# ---- 2) 每个节点的进程启动时间 ----
$tmp = Join-Path $env:TEMP 'sp-rolling.json'
if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
$null = & cmd.exe /c ('""' + $pm2 + '" jlist > "' + $tmp + '" 2>nul"')
if (-not (Test-Path -LiteralPath $tmp) -or (Get-Item -LiteralPath $tmp).Length -lt 1000) {
  Write-Log 'cannot read pm2 status -> skip'
  exit 0
}
$started = @{}
try {
  # ⚠ 两个坑，都是 2026-10-28 踩到的：
  #   ① pm2 的 jlist 里同时有 username / USERNAME 两个键，ConvertFrom-Json 会抛
  #      「无法转换 JSON 字符串，因为它包含具有不同大小写的键」。
  #   ② `-AsHashtable` 是 PowerShell **7** 的参数。本脚本由计划任务以 SYSTEM 运行时用的是
  #      `WindowsPowerShell\v1.0\powershell.exe`（5.1），传它会报
  #      「找不到与参数名称 AsHashtable 匹配的参数」。
  #   所以先把重复的大小写键名改写掉，再用 5.1 也能解析的普通 ConvertFrom-Json。
  $raw = Get-Content -LiteralPath $tmp -Raw
  $raw = $raw -replace '"username"\s*:', '"user_name_lc":'
  $raw = $raw -replace '"USERNAME"\s*:', '"user_name_uc":'
  $raw = $raw -replace '"USERPROFILE"\s*:', '"user_profile_uc":'
  $j = $raw | ConvertFrom-Json
  foreach ($a in @($j)) {
    $name = [string]$a.name
    if (-not ($name -match '^node-(\d+)$')) { continue }
    $n = [int]$Matches[1]
    $up = $a.pm2_env.pm_uptime
    if ($up) { $started[$n] = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$up).LocalDateTime }
  }
} catch {
  Write-Log ('pm2 json unreadable -> skip: ' + $_.Exception.Message)
  exit 0
}
if ($started.Count -eq 0) { Write-Log 'no node processes visible -> skip'; exit 0 }

# ---- 3) 找出「旧代码 + 完全空闲」的节点 ----
$candidates = @()
for ($n = 1; $n -le 30; $n++) {
  if (-not $started.ContainsKey($n)) { continue }        # 进程都看不到，不动
  if ($started[$n] -ge $codeAt) { continue }             # 已经是新代码
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$((3000 + $n))/healthz?traffic=1" -TimeoutSec 3
  } catch { continue }                                    # 无响应，不动
  # 重启纪律：有对局或有任何连接都不碰
  if ([int]$h.matches -ne 0) { continue }
  if ([int]$h.sockets -ne 0) { continue }
  if ([int]$h.rooms -ne 0) { continue }
  $candidates += $n
}

if ($candidates.Count -eq 0) { exit 0 }   # 没有可动的，不写日志避免噪音

# ---- 4) 逐个重启（每轮最多 6 个，避免一次抖动太大）----
$batch = $candidates | Select-Object -First 6
$names = ($batch | ForEach-Object { "node-$_" }) -join ','
Write-Log ('idle + old code: ' + ($batch -join ',') + ' -> startOrReload')

$out = & cmd.exe /c ('""' + $pm2 + '" startOrReload "' + (Join-Path $root 'ecosystem.config.cjs') + '" --only ' + $names + ' --update-env 2>&1"')
$code = $LASTEXITCODE
if ($code -ne 0 -or ($out -join "`n") -match '\[PM2\]\[ERROR\]') {
  Write-Log ('ALERT startOrReload failed: ' + (($out | Select-Object -Last 3) -join ' '))
  exit 0
}
$null = & cmd.exe /c ('""' + $pm2 + '" save >nul 2>nul"')

Start-Sleep -Seconds 8

# ---- 5) 复查 ----
$okn = 0
foreach ($n in $batch) {
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$((3000 + $n))/healthz" -TimeoutSec 5
    if ([int]$h.uptimeSec -lt 120) { $okn++ }
  } catch { Write-Log ("node-$n did not come back") }
}
Write-Log ('restarted ' + $okn + '/' + $batch.Count + ' (' + ($batch -join ',') + ')')
