$ErrorActionPreference = 'Continue'
$root = 'D:\Stronghold-Protocol'
$log = Join-Path $root 'logs\server-watchdog.log'
$pm2 = 'C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd'
$nginx = Join-Path $root 'nginx\nginx.exe'
# 维护者手动重启 nginx 期间先别插手（脚本自己最多 20 秒，取 90 秒留余量）。
# 2026-10-28：昨天重启 nginx 时本脚本 3 分钟内抢着「救」了两次，干扰了操作。
$restartHint = Join-Path $root 'logs\.nginx-restarting'
$restarting = (Test-Path -LiteralPath $restartHint) -and ((Get-Date) - (Get-Item -LiteralPath $restartHint).LastWriteTime).TotalSeconds -lt 90

# One-click stop creates this flag; do not fight an intentional shutdown.
if (Test-Path -LiteralPath (Join-Path $root 'data\watchdog-disabled')) { return }
if ($restarting) { return }

function Write-WatchdogLog([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

# Run an external command without a console window.
# Calling `& pm2.cmd` spawns a new console window even when this script runs with
# -WindowStyle Hidden (that flag only covers the PowerShell host, not child processes),
# which showed up on the desktop as a black box flashing every minute.
# CreateNoWindow starts the child invisible while its output is still captured.
function Invoke-Hidden([string]$exe, [string[]]$arguments) {
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = (($arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $null = $p.StandardOutput.ReadToEnd()
    $null = $p.StandardError.ReadToEnd()
    $p.WaitForExit(30000) | Out-Null
  } catch {
    Write-WatchdogLog ("Invoke-Hidden failed: " + $_.Exception.Message)
  }
}

$listening = Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue
if ($listening) {
  # The entry can be up while PM2 and the game nodes are gone; check one node too.
  try {
    $null = Invoke-RestMethod 'http://127.0.0.1:3001/healthz' -TimeoutSec 3
    return
  } catch {
    Write-WatchdogLog 'node-1 health check failed; resurrecting PM2 process list'
    if (Test-Path -LiteralPath $pm2) { Invoke-Hidden $pm2 @('resurrect') }
    return
  }
}

Write-WatchdogLog 'HTTPS 443 is not listening; restarting nginx-gateway'

if (Test-Path -LiteralPath $pm2) {
  try {
    Invoke-Hidden $pm2 @('resurrect')
    Invoke-Hidden $pm2 @('restart', 'nginx-gateway')
  } catch {
    Write-WatchdogLog ("pm2 restart failed: " + $_.Exception.Message)
  }
}

Start-Sleep -Seconds 2
$listening = Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue
if ($listening) {
  Write-WatchdogLog 'nginx-gateway recovered by pm2'
  exit 0
}

# Last-resort direct start if PM2 is unavailable.
if (Test-Path -LiteralPath $nginx) {
  Start-Process -FilePath $nginx -ArgumentList @('-p', (Join-Path $root 'nginx\')) -WorkingDirectory (Join-Path $root 'nginx') -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if (Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue) {
    Write-WatchdogLog 'nginx recovered by direct start'
    exit 0
  }
}

Write-WatchdogLog 'nginx recovery failed'
exit 1
