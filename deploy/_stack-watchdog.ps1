$ErrorActionPreference = 'SilentlyContinue'
$root = 'D:\Stronghold-Protocol'
$pm2 = 'C:\Users\Administrator\AppData\Roaming\npm\pm2.cmd'
$env:PM2_HOME = 'C:\Users\Administrator\.pm2'
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
$nodeExe = 'D:\nodejs\node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = 'node' }
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
