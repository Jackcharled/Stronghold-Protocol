# 把「环境变量改过但进程还跑着旧值」的节点，在空闲时逐个 reload。
#
# 背景（2026-10-30）：
#   官方把 AI 策略、关闭超时这类配置放在环境变量里（SP_BOT_STRATEGY / SP_SHUTDOWN_TIMEOUT_MS）。
#   ecosystem.config.cjs 改了它，**不等于**运行中的进程会变 —— process.env 是启动时的快照。
#   而现有的 rolling-restart.ps1 只看「server/ 代码内容有没有变」，环境变量变了它不感知，
#   于是那些一直有对局的节点永远不会被它重启到新配置。
#
# 这个脚本补上这一块：比对「ecosystem.config.cjs 声明的值」与「pm2 里进程实际生效的值」，
# 不一致且**完全空闲**（matches=0 且 sockets=0 且 rooms=0）的节点，用 startOrReload --update-env 刷新。
#
# 由计划任务 SP-Env-Reload 每 30 分钟调用（SYSTEM）。有玩家在的节点一律跳过 —— 重启纪律不变。
#
# ⚠ PowerShell 5.1（计划任务用 WindowsPowerShell）：
#   - 本文件必须带 UTF-8 BOM，否则中文会被按 GBK 解析、引号配对错乱、整个脚本语法崩
#   - 不用 ?? / -AsHashtable / -Parallel（都是 PS7 的）
#   - New-Object 的构造参数要用 -ArgumentList，位置传参可能静默返回 $null
$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\Stronghold-Protocol'
$log = Join-Path $root 'logs\env-reload.log'
$marker = Join-Path $root 'data\env-reload-disabled'
$pm2 = Join-Path $env:APPDATA '..\..\npm\pm2.cmd'
if (-not (Test-Path $pm2)) { $pm2 = 'C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd' }

function Write-Log([string]$text) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

# 一键关闭开关
if (Test-Path -LiteralPath $marker) { exit 0 }

# ---- 1) 读 ecosystem.config.cjs 里每个节点**应该**有的环境变量 ----
$tmpCfg = Join-Path $env:TEMP 'sp-env-cfg.json'
$cfgScript = @'
const path = require('node:path');
const cfg = require(path.join(process.argv[2], 'ecosystem.config.cjs'));
const out = {};
for (const a of cfg.apps) {
  if (!/^node-\d+$/.test(a.name)) continue;
  out[a.name] = a.env || {};
}
process.stdout.write(JSON.stringify(out));
'@
$tmpJs = Join-Path $env:TEMP 'sp-env-cfg.cjs'
[System.IO.File]::WriteAllText($tmpJs, $cfgScript, (New-Object System.Text.UTF8Encoding $false))
$cfgJson = & node $tmpJs $root 2>$null
if (-not $cfgJson) { Write-Log 'cannot read ecosystem.config.cjs -> skip'; exit 0 }
try { $want = $cfgJson | ConvertFrom-Json } catch { Write-Log ('config parse failed -> skip: ' + $_.Exception.Message); exit 0 }

# ---- 2) 读 pm2 里每个节点**实际**生效的环境变量 ----
$tmp = Join-Path $env:TEMP 'sp-env-pm2.json'
if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
$null = & cmd.exe /c ('""' + $pm2 + '" jlist > "' + $tmp + '" 2>nul"')
if (-not (Test-Path -LiteralPath $tmp) -or (Get-Item -LiteralPath $tmp).Length -lt 1000) {
  Write-Log 'cannot read pm2 status -> skip'
  exit 0
}
try {
  # pm2 jlist 有大小写重复的键（username / USERNAME），5.1 的 ConvertFrom-Json 会拒绝
  $raw = Get-Content -LiteralPath $tmp -Raw
  $raw = $raw -replace '"username"\s*:', '"user_name_lc":'
  $raw = $raw -replace '"USERNAME"\s*:', '"user_name_uc":'
  $raw = $raw -replace '"USERPROFILE"\s*:', '"user_profile_uc":'
  $pm = $raw | ConvertFrom-Json
} catch {
  Write-Log ('pm2 json unreadable -> skip: ' + $_.Exception.Message)
  exit 0
}

# 只比对这两个变量：它们决定 AI 行为与关闭宽限，是我们实际会改的东西。
# 加新的比对项时把它们加进这个列表即可。
$KEYS = @('SP_BOT_STRATEGY', 'SP_SHUTDOWN_TIMEOUT_MS')

$candidates = @()
foreach ($a in @($pm)) {
  $name = [string]$a.name
  if (-not ($name -match '^node-(\d+)$')) { continue }
  $n = [int]$Matches[1]
  if ($a.pm2_env.status -ne 'online') { continue }
  $have = $a.pm2_env.env
  $expect = $want.$name
  if (-not $expect) { continue }
  $diff = @()
  foreach ($k in $KEYS) {
    $w = [string]$expect.$k
    $h = if ($have) { [string]$have.$k } else { '' }
    if ($w -ne $h) { $diff += ($k + ': ' + ($(if ($h) { $h } else { '(unset)' })) + ' -> ' + ($(if ($w) { $w } else { '(unset)' }))) }
  }
  if (-not $diff.Count) { continue }
  # 重启纪律：有对局或有任何连接都不碰
  try { $h = Invoke-RestMethod "http://127.0.0.1:$((3000 + $n))/healthz?traffic=1" -TimeoutSec 3 } catch { continue }
  if ([int]$h.matches -ne 0) { continue }
  if ([int]$h.sockets -ne 0) { continue }
  if ([int]$h.rooms -ne 0) { continue }
  $candidates += [pscustomobject]@{ N = $n; Diff = ($diff -join '; ') }
}

if ($candidates.Count -eq 0) { exit 0 }   # 没有可动的，不写日志避免噪音

# ---- 3) 逐个 reload（每轮最多 6 个，避免一次抖动太大）----
$batch = @($candidates | Select-Object -First 6)   # @() 强制数组：单元素时 PowerShell 会解包成标量，导致 $batch.Count 为空
$names = ($batch | ForEach-Object { "node-$($_.N)" }) -join ','
foreach ($c in $batch) { Write-Log ('node-' + $c.N + ' idle, env differs [' + $c.Diff + '] -> reload') }

$eco = Join-Path $root 'ecosystem.config.cjs'
$out = & cmd.exe /c ('""' + $pm2 + '" startOrReload "' + $eco + '" --only ' + $names + ' --update-env 2>&1"')
if ($LASTEXITCODE -ne 0 -or ($out -join "`n") -match '\[PM2\]\[ERROR\]') {
  Write-Log ('ALERT startOrReload failed: ' + (($out | Select-Object -Last 3) -join ' '))
  exit 0
}
$null = & cmd.exe /c ('""' + $pm2 + '" save >nul 2>nul"')

Start-Sleep -Seconds 8

# ---- 4) 复查 ----
$okn = 0
foreach ($c in $batch) {
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$((3000 + $c.N))/healthz" -TimeoutSec 5
    if ([int]$h.uptimeSec -lt 120) { $okn++ }
  } catch { Write-Log ("node-$($c.N) did not come back") }
}
Write-Log ('reloaded ' + $okn + '/' + $batch.Count + ' (' + $names + ')')
