# 以 SYSTEM 身份、脱离任何用户会话启动 PM2 及其全部应用
#
# 为什么需要这个脚本（2026-10-27）：
#   维护者反馈「不要让我必须启动你我才能启动服务器」。
#   根因：pm2 曾经是在某个交互式 shell（AI 助手的 pwsh）里启动的，父进程链挂在那个
#   应用下面。应用一重启，shell 被杀，pm2 收到退出信号跟着死，30 个节点全部断开，
#   玩家看到「与服务器的连接已中断，正在重连」。
#
#   这个脚本由计划任务 SP-PM2-Resurrect 以 SYSTEM 身份运行，父进程是任务计划程序，
#   与任何登录会话无关 —— 注销、重启桌面应用、关闭终端都不影响它。
#
# 用法（通常由计划任务调用，也可手动）：
#   schtasks /Run /TN "SP-PM2-Resurrect"
#   或  powershell -File deploy\_start-pm2.ps1
#
# 路径不写死（仓库是公开的）：优先环境变量，否则由脚本位置推导。
$ErrorActionPreference = 'SilentlyContinue'
# 注意用 $PSCommandPath 而不是 $MyInvocation.MyCommand.Path —— 后者在脚本被
# 其它脚本 dot-source / 嵌套调用时可能是空值，会让下面的 Join-Path 得到 null
# （实测报 ParameterArgumentValidationErrorNullNotAllowed）。
$scriptDir = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { (Get-Location).Path }
# 部署根 = 含 node-1 的那一级。脚本可能在仓库里（repo-sync/deploy/）也可能在
# 部署根的 deploy/ 下，两种都要能找对，所以用「有没有 node-1」来判定。
$root = $env:SP_ROOT
if (-not $root) {
  $try = Split-Path -Parent $scriptDir          # deploy/ → 上一级
  $root = if (Test-Path (Join-Path $try 'node-1')) { $try } else { $scriptDir }
}
$env:PM2_HOME = if ($env:PM2_HOME) { $env:PM2_HOME } else { Join-Path $env:USERPROFILE '.pm2' }
$pm2Cmd = if ($env:SP_PM2) { $env:SP_PM2 } else { Join-Path $env:APPDATA 'npm\pm2.cmd' }
$log = Join-Path $root 'logs\pm2-resurrect.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Write-Log([string]$text) {
  "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text | Out-File -FilePath $log -Append -Encoding utf8
}
Write-Log 'start-pm2 invoked'

function Invoke-Hidden([string]$argLine) {
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $null = $p.StandardOutput.ReadToEnd()
    $null = $p.StandardError.ReadToEnd()
    $p.WaitForExit(60000) | Out-Null
    return @{ code = $p.ExitCode }
  } catch {
    Write-Log ('Invoke-Hidden failed: ' + $_.Exception.Message)
    return @{ code = 1 }
  }
}

if (-not (Test-Path $pm2Cmd)) {
  Write-Log ('PM2 not found at ' + $pm2Cmd + ' —— set SP_PM2 or install pm2 globally')
  exit 1
}

# PM2 守护进程已经在跑就不重复启动（resurrect 对已运行的守护进程是安全的，
# 但会刷日志，这里先判断一次）。
$god = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'pm2[\\/]lib[\\/]Daemon\.js' }

if ($god) {
  Write-Log ('PM2 daemon already running (pid ' + ($god | Select-Object -First 1).ProcessId + ')')
} else {
  Write-Log 'PM2 daemon not running -> resurrect'
  $r = Invoke-Hidden ('/c ""' + $pm2Cmd + '" resurrect >> "' + $log + '" 2>&1"')
  Write-Log ('resurrect exit=' + $r.code)
  Start-Sleep -Seconds 8
}

# 无论守护进程是否新起，都检查应用齐不齐；**只补缺的，绝不动正在跑的**。
#
# ⚠ 2026-10-27 教训：这里原本无条件执行 `pm2 start ecosystem.config.cjs`。
#   它不是"启动缺失的应用"，而是对**已在跑**的应用逐个 `restartProcessId`
#   —— 正在对局的节点会被打断，玩家掉线。实测日志：
#     [PM2] Applying action restartProcessId on app [node-1](ids: [ 31 ])
#   而且碰到 pid 冲突的应用（nginx-gateway）会直接抛错退出。
#   维护者要的是「服务器自己活着」，不是「每次检查都重启一遍」。
$eco = Join-Path $root 'ecosystem.config.cjs'
$online = @()
$nodeExe = 'D:\nodejs\node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = 'node' }
$tmp = Join-Path $env:TEMP 'sp-pm2-jlist.json'
$null = Invoke-Hidden ('/c ""' + $pm2Cmd + '" jlist > "' + $tmp + '" 2>nul"')
$probe = Join-Path $root 'deploy\_pm2-online.cjs'
if (Test-Path $probe) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nodeExe
  $psi.Arguments = '"' + $probe + '" "' + $tmp + '"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEnd()
  $null = $p.StandardError.ReadToEnd()
  $p.WaitForExit(30000) | Out-Null
  if ($p.ExitCode -eq 0) { $online = @($out -split ',') }
}

# 真正必须活着的应用。
# ⚠ nginx-gateway 不在其中：它是 pm2 里包一层 nginx 的 wrapper，会反复
#   「waiting restart」（实测 28 次）。nginx 本体是独立进程（计划任务 SP-Nginx-Start
#   负责），只要 `Get-Process nginx` 有结果、HTTPS 能回 200，nginx 就是好的。
#   把它算进 expected 会让每次检查都徒劳去 start 一个永远起不来的 wrapper。
$expected = @('matchmaker', 'dashboard')
1..30 | ForEach-Object { $expected += ('node-' + $_) }
$missing = @($expected | Where-Object { $online -notcontains $_ })
# 只处理 ecosystem 里定义过的名字，避免凭空 start 不存在的东西。
# ⚠ node-1..node-30 是在 ecosystem.config.cjs 里用 Array.from({length: NODES})
#   生成的，文本里搜不到 `name: 'node-N'` —— 所以显式按 NODES 补上。
$defined = @()
if (Test-Path $eco) {
  $defined += @(Select-String -Path $eco -Pattern "name:\s*'([^']+)'" -AllMatches |
    ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value })
  $cnt = 30
  $m = Select-String -Path $eco -Pattern 'const\s+NODES\s*=\s*(\d+)' | Select-Object -First 1
  if ($m -and $m.Matches[0].Groups[1].Value) { $cnt = [int]$m.Matches[0].Groups[1].Value }
  1..$cnt | ForEach-Object { $defined += ('node-' + $_) }
  $defined += 'ai'
  $defined -= 'nginx-gateway'
}
$missing = @($missing | Where-Object { $defined -contains $_ })

if ($missing.Count -gt 0) {
  Write-Log ('missing apps (' + $missing.Count + '): ' + ($missing -join ', ') + ' -> start only those')
  foreach ($name in $missing) {
    $r = Invoke-Hidden ('/c ""' + $pm2Cmd + '" start "' + $eco + '" --only ' + $name + ' --update-env >> "' + $log + '" 2>&1"')
    Write-Log ('  start ' + $name + ' exit=' + $r.code)
  }
  $null = Invoke-Hidden ('/c ""' + $pm2Cmd + '" save >nul 2>nul"')
} else {
  Write-Log ('all ' + $expected.Count + ' apps online, nothing to do')
}

# nginx 不在 pm2 里：独立进程，由计划任务 SP-Nginx-Start 负责。
# 这里只确认它在，不在就启动那个计划任务（不直接起 nginx，避免配置/路径问题）。
if (-not (Get-Process nginx -ErrorAction SilentlyContinue)) {
  Write-Log 'nginx is not running -> run SP-Nginx-Start'
  $null = Invoke-Hidden '/c "schtasks /Run /TN ""SP-Nginx-Start"" >nul 2>nul"'
}
Write-Log 'start-pm2 done'
