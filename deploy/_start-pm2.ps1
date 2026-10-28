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
$env:PM2_HOME = $env:PM2_HOME
if (-not $env:PM2_HOME) {
  # 与上面同样的道理：SYSTEM 身份的 USERPROFILE 不是管理员目录。
  # PM2 的 dump（进程表）在那个用户自己的 .pm2 下，必须指向同一处，
  # 否则 resurrect 会「成功但什么都没恢复」——比直接失败更难查。
  $homes = @(
    (Join-Path $env:USERPROFILE '.pm2'),
    'C:\Users\Administrator\.pm2'
  )
  foreach ($h in $homes) {
    if ($h -and (Test-Path (Join-Path $h 'dump.pm2'))) { $env:PM2_HOME = $h; break }
  }
  if (-not $env:PM2_HOME) { $env:PM2_HOME = $homes[0] }
}
$pm2Cmd = $env:SP_PM2
if (-not $pm2Cmd) {
  # ⚠ 这个脚本通常以 SYSTEM 身份运行，此时 $env:APPDATA 是
  #   C:\WINDOWS\system32\config\systemprofile\AppData\Roaming —— npm 全局包**不在那里**，
  #   于是找不到 pm2（实测日志：PM2 not found at ...systemprofile...）。
  #   旧版硬编码了管理员路径所以能跑。这里改成按候选顺序探测，谁存在用谁。
  $cands = @(
    (Join-Path $env:APPDATA 'npm\pm2.cmd'),
    'C:\ProgramData\npm\pm2.cmd'
  )
  # 所有用户目录下的 npm\pm2.cmd（SYSTEM 也能读）
  Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $cands += (Join-Path $_.FullName 'AppData\Roaming\npm\pm2.cmd')
  }
  $cands += 'C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd'
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { $pm2Cmd = $c; break } }
}
if (-not $pm2Cmd) {
  # 最后兜底：从 PATH 里找
  $w = Get-Command pm2.cmd -ErrorAction SilentlyContinue
  if ($w) { $pm2Cmd = $w.Source }
}
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
    # ⚠ 要先 WaitForExit 再 ReadToEnd：反过来的话，子进程若一直不关 stdout，
    #   ReadToEnd 会永远阻塞，WaitForExit 的超时根本没机会生效（实测卡死 5 分钟）。
    #   这里读流放到「已确认退出」之后，并且给一个硬超时兜底 kill。
    $done = $p.WaitForExit(45000)
    if (-not $done) {
      try { $p.Kill() } catch { /* ignore */ }
      return @{ code = -1; note = 'timeout' }
    }
    try {
      $null = $p.StandardOutput.ReadToEnd()
      $null = $p.StandardError.ReadToEnd()
    } catch { /* ignore */ }
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
  # resurrect 会打印一整张 pm2 表格，没必要进日志（吵且难 grep）。只记退出码。
  $r = Invoke-Hidden ('/c ""' + $pm2Cmd + '" resurrect >nul 2>&1"')
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
  # ⚠ 这里也必须「先等退出、再读流」。原来写成 ReadToEnd() 在前、WaitForExit() 在后，
  #   子进程只要不关 stdout 就会永久阻塞 —— 计划任务实例就是这么卡住的（实测 63s+ 不结束，
  #   下一次触发被 IgnoreNew 跳过，看起来像"自启动失灵"）。
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $nodeExe
    $psi.Arguments = '"' + $probe + '" "' + $tmp + '"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    if ($p.WaitForExit(20000)) {
      $out = ''
      try { $out = $p.StandardOutput.ReadToEnd() } catch { /* ignore */ }
      $null = $p.StandardError.ReadToEnd()
      if ($p.ExitCode -eq 0) { $online = @($out -split ',') }
    } else {
      try { $p.Kill() } catch { /* ignore */ }
      Write-Log 'probe timeout (20s), skipped'
    }
  } catch {
    Write-Log ('probe failed: ' + $_.Exception.Message)
  }
}

# 真正必须活着的应用。
# ⚠ nginx-gateway 不在其中：它是 pm2 里包一层 nginx 的 wrapper，会反复
#   「waiting restart」（实测 28 次）。nginx 本体是独立进程（计划任务 SP-Nginx-Start
#   负责），只要 `Get-Process nginx` 有结果、HTTPS 能回 200，nginx 就是好的。
#   把它算进 expected 会让每次检查都徒劳去 start 一个永远起不来的 wrapper。
$expected = @('matchmaker', 'dashboard')
1..30 | ForEach-Object { $expected += ('node-' + $_) }

# ⚠ 2026-10-28 事故：$online 为空时，下面会把**全部 32 个应用**判成「缺失」，
#   然后逐个 start —— 等于每分钟都有可能全量重启一次，玩家对局被反复打断。
#   `pm2 jlist` 会间歇性失败（尤其 pm2 忙的时候），而这里没有「读不到就别动」的保护。
#   现在：读不到 / 读到的东西明显不完整 → 这一轮什么都不做。
if ($online.Count -eq 0) {
  Write-Log 'ALERT cannot read PM2 status -> skip (no action)'
  exit 0
}
if ($online.Count -lt [Math]::Floor($expected.Count / 2)) {
  Write-Log ('ALERT only ' + $online.Count + '/' + $expected.Count + ' apps visible -> treated as a read problem, skip')
  exit 0
}

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
