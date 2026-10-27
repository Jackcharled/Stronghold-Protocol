# 卫戍协议 · 启动服务器（双击「启动服务器.bat」调用本脚本）
#
# 为什么要有这个脚本：维护者不想记命令，只想双击一下就把服务器起来。
#
# 关键点：服务器由计划任务（SYSTEM 身份）托管，**不挂在当前窗口上**，
# 所以这个窗口关掉、注销、重启桌面应用都不会影响服务器。
$ErrorActionPreference = 'SilentlyContinue'
$Host.UI.RawUI.WindowTitle = '卫戍协议 - 启动服务器'
$root = Split-Path -Parent $PSCommandPath

function Line([string]$text, [string]$color = 'Gray') {
  Write-Host $text -ForegroundColor $color
}

Clear-Host
Line ''
Line '  ============================================' Cyan
Line '      卫戍协议 . 启动服务器' Cyan
Line '  ============================================' Cyan
Line ''

# ---- 1/3 启动 ----
$task = 'SP-PM2-Resurrect'
$hasTask = $null -ne (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)
if ($hasTask) {
  Line "  [1/3] 通过计划任务启动（SYSTEM 身份，独立于本窗口）..." Yellow
  Start-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
} else {
  Line '  [1/3] 未找到计划任务，直接启动 PM2...' Yellow
  $pm2 = Join-Path $env:APPDATA 'npm\pm2.cmd'
  if (-not (Test-Path $pm2)) {
    Line ''
    Line "  [错误] 找不到 pm2：$pm2" Red
    Line '         请先安装：npm i -g pm2' Red
    Line ''
    Read-Host '  按回车关闭'
    exit 1
  }
  & $pm2 resurrect *> $null
  & $pm2 start (Join-Path $root 'ecosystem.config.cjs') --update-env *> $null
}

# ---- 2/3 等待 ----
Line '  [2/3] 等待应用就绪（约 25 秒，请勿关闭窗口）...' Yellow
for ($i = 25; $i -gt 0; $i--) {
  Write-Host "`r        剩余 $i 秒   " -NoNewline -ForegroundColor DarkGray
  Start-Sleep -Seconds 1
}
Write-Host "`r        等待完成      " -ForegroundColor DarkGray

# ---- 3/3 检查 ----
Line '  [3/3] 检查结果' Yellow
Line ''

Line '  ---------- PM2 进程 ---------- ' DarkCyan
$pm2cmd = Join-Path $env:APPDATA 'npm\pm2.cmd'
if (Test-Path $pm2cmd) { & $pm2cmd list }
Line ''

Line '  ---------- 服务检查 ---------- ' DarkCyan
$ok = 0
foreach ($n in 1..30) {
  try {
    Invoke-RestMethod ("http://127.0.0.1:" + (3000 + $n) + '/healthz') -TimeoutSec 2 | Out-Null
    $ok++
  } catch { }
}
if ($ok -eq 30) { Line ('   游戏节点: ' + $ok + ' / 30  全部正常') Green }
elseif ($ok -gt 0) { Line ('   游戏节点: ' + $ok + ' / 30  （部分未响应，稍等可能还在启动）') Yellow }
else { Line '   游戏节点: 0 / 30  （全部未响应，请检查日志）' Red }

foreach ($p in 3080, 3090) {
  try {
    $null = Invoke-WebRequest ("http://127.0.0.1:" + $p + '/') -TimeoutSec 3 -UseBasicParsing
    Line ('   端口 ' + $p + ': 正常') Green
  } catch {
    Line ('   端口 ' + $p + ': 未响应') Yellow
  }
}

Line ''
Line '  ============================================' Cyan
Line '      已启动。这个窗口可以关掉。' Green
Line '      服务器由计划任务托管，不受本窗口影响。' Green
Line '  ============================================' Cyan
Line ''
Read-Host '  按回车关闭'
