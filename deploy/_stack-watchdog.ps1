$ErrorActionPreference = 'SilentlyContinue'
# 根目录：优先环境变量 SP_ROOT，否则由脚本位置推导（deploy/ 的上一级）。
# 不写死盘符和用户名，仓库公开时不会泄露部署机的账号与目录结构。
$root = if ($env:SP_ROOT) { $env:SP_ROOT } else { Split-Path -Parent $PSScriptRoot }
# pm2 / PM2_HOME：优先环境变量，否则按当前用户的 npm 全局目录推导。
$pm2 = if ($env:SP_PM2) { $env:SP_PM2 } else { Join-Path $env:APPDATA 'npm\pm2.cmd' }
$env:PM2_HOME = if ($env:PM2_HOME) { $env:PM2_HOME } else { Join-Path $env:USERPROFILE '.pm2' }
$log = Join-Path $root 'logs\stack-watchdog.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Write-Log([string]$text) {
  "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text | Out-File -FilePath $log -Append -Encoding utf8
}
if (Test-Path (Join-Path $root '.maintenance')) { exit 0 }

# Alert only: this watchdog never starts or restarts nginx / PM2 / game nodes.
if (-not (Get-Process nginx -ErrorAction SilentlyContinue)) {
  Write-Log 'ALERT nginx is not running'
}

$tmp = Join-Path $env:TEMP 'sp-pm2-jlist.json'
# Run external commands without a console window.
# `& cmd.exe` / `& node` in an interactive session flash a black box; start them
# with CreateNoWindow instead (this task runs as SYSTEM, but the same fix applies).
function Invoke-HiddenOut([string]$exe, [string]$argLine) {
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = $argLine
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd()
    $null = $p.StandardError.ReadToEnd()
    $p.WaitForExit(30000) | Out-Null
    return @{ code = $p.ExitCode; out = $out }
  } catch {
    Write-Log ("Invoke-HiddenOut failed: " + $_.Exception.Message)
    return @{ code = 1; out = '' }
  }
}
$null = Invoke-HiddenOut 'cmd.exe' ('/c ""' + $pm2 + '" jlist > "' + $tmp + '" 2>nul"')
# node 可执行文件：优先环境变量 SP_NODE，否则依次尝试常见安装位置，最后退回 PATH 上的 node。
$nodeExe = if ($env:SP_NODE) { $env:SP_NODE } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodeExe -or -not (Test-Path $nodeExe)) { $nodeExe = 'node' }
$r = Invoke-HiddenOut $nodeExe ('"' + (Join-Path $root 'deploy\_pm2-online.cjs') + '" "' + $tmp + '"')
$onlineRaw = $r.out
if ($r.code -ne 0) {
  Write-Log 'ALERT cannot read PM2 status'
  exit 0
}
$online = @($onlineRaw -split ',')
$expected = @('matchmaker', 'dashboard')
1..30 | ForEach-Object { $expected += ('node-' + $_) }
$missing = @($expected | Where-Object { $online -notcontains $_ })
if ($missing.Count -gt 0) {
  Write-Log ('ALERT missing PM2 apps: ' + ($missing -join ', '))
}
