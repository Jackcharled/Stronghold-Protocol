# 以 SYSTEM 身份、脱离任何用户会话启动 nginx
#
# ★ 2026-10-27：这个脚本原本用 `cmd /c start "" /b nginx.exe` 启动 —— 那是**从当前会话
#   派生**进程。如果它由计划任务（SYSTEM/ServiceAccount）调用，SessionId 就是 0（正确）；
#   但如果是人在桌面终端里执行，nginx 就挂到桌面会话上。
#
#   实测发现 nginx master 的 SessionId = 2（桌面会话），父进程已退出 —— 说明当初是从
#   交互式会话启动的，不是这个计划任务。维护者要求：**必须以 SYSTEM 启动，不能挂在任何
#   用户会话下**（否则注销/重启桌面应用可能带走它，和 pm2 那次事故同理）。
#
# 正确调用方式（务必这样）：
#   schtasks /Run /TN "SP-Nginx-Start"
# 或本脚本由该计划任务以 SYSTEM 运行。**不要**在终端里直接跑它来启动 nginx。
#
# 验证（启动后）：
#   (Get-CimInstance Win32_Process -Filter "Name='nginx.exe'" | Sort-Object CreationDate |
#     Select-Object -First 1).SessionId     # 必须是 0
$ErrorActionPreference = 'SilentlyContinue'
$root = if ($env:SP_ROOT) { $env:SP_ROOT } else { Split-Path -Parent (Split-Path -Parent $PSCommandPath) }
$exe = Join-Path $root 'nginx\nginx.exe'
$prefix = Join-Path $root 'nginx'
$conf = 'conf/nginx.conf'
$log = Join-Path $root 'logs\nginx-start.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

function Write-Log([string]$text) {
  "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text | Out-File -FilePath $log -Append -Encoding utf8
}

if (-not (Test-Path $exe)) { Write-Log "nginx.exe not found at $exe"; exit 1 }

# 已经在跑：只做健康确认，不重复启动（重复启动会报 bind 错误）
$running = Get-Process nginx -ErrorAction SilentlyContinue
if ($running) {
  $master = Get-CimInstance Win32_Process -Filter "Name='nginx.exe'" | Sort-Object CreationDate | Select-Object -First 1
  Write-Log ("nginx already running (master pid " + $master.ProcessId + ", session " + $master.SessionId + ")")
  if ($master.SessionId -ne 0) {
    Write-Log 'ALERT nginx is NOT in session 0 (started from an interactive session). Restart it via this scheduled task to detach.'
  }
  exit 0
}

Write-Log 'nginx not running -> start'
# 用 ProcessStartInfo 而不是 `cmd /c start`：能控制 CreateNoWindow，且不经过 cmd 这一层。
# 关键是本脚本本身由 SYSTEM 计划任务执行，所以新进程自然落在 Session 0。
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = '-p "' + $prefix + '" -c "' + $conf + '"'
  $psi.WorkingDirectory = $prefix
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  Write-Log ('started pid ' + $p.Id)
} catch {
  Write-Log ('start failed: ' + $_.Exception.Message)
  exit 1
}

Start-Sleep -Seconds 3
$check = Get-Process nginx -ErrorAction SilentlyContinue
if ($check) {
  $master = Get-CimInstance Win32_Process -Filter "Name='nginx.exe'" | Sort-Object CreationDate | Select-Object -First 1
  Write-Log ('nginx up: ' + $check.Count + ' process(es), master session ' + $master.SessionId)
} else {
  Write-Log 'ALERT nginx did not start'
  exit 1
}
