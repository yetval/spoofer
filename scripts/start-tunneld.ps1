# Start pymobiledevice3 tunneld as Administrator. Idempotent.
# Windows mirror of start-tunneld.sh. The caller (dev.ps1 / Electron) handles UAC elevation,
# so this script assumes it is already running in an elevated shell.
$ErrorActionPreference = "Stop"

# Already up? Bail out.
try {
  Invoke-WebRequest -Uri "http://127.0.0.1:49151/" -TimeoutSec 1 -UseBasicParsing | Out-Null
  exit 0
} catch {}

$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $env:TEMP "spoofer-tunneld.log"
$errLog = Join-Path $env:TEMP "spoofer-tunneld.err.log"

# Locate pymobiledevice3: prefer the backend venv, then PATH, then `python -m`.
$venvPmd = Join-Path $root "backend\.venv\Scripts\pymobiledevice3.exe"
$pathPmd = Get-Command pymobiledevice3 -ErrorAction SilentlyContinue

if (Test-Path $venvPmd) {
  Start-Process -FilePath $venvPmd -ArgumentList "remote", "tunneld" `
    -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog
} elseif ($pathPmd) {
  Start-Process -FilePath $pathPmd.Source -ArgumentList "remote", "tunneld" `
    -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog
} else {
  $venvPy = Join-Path $root "backend\.venv\Scripts\python.exe"
  $py = if (Test-Path $venvPy) { $venvPy } else { "python" }
  Start-Process -FilePath $py -ArgumentList "-m", "pymobiledevice3", "remote", "tunneld" `
    -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $errLog
}
