# Spoofer preflight doctor (Windows).
# Checks every prerequisite and prints PASS/WARN/FAIL with the exact fix for each,
# so you never have to "rerun dev.ps1 and guess what broke."
#   powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root "backend\.venv"
$venvPy = Join-Path $venv "Scripts\python.exe"

$script:fails = 0
$script:warns = 0

function Ok  ($m) { Write-Host "  [ OK ] $m" -ForegroundColor Green }
function Warn($m, $fix) {
  Write-Host "  [WARN] $m" -ForegroundColor Yellow
  if ($fix) { Write-Host "         fix: $fix" -ForegroundColor DarkGray }
  $script:warns++
}
function Fail($m, $fix) {
  Write-Host "  [FAIL] $m" -ForegroundColor Red
  if ($fix) { Write-Host "         fix: $fix" -ForegroundColor DarkGray }
  $script:fails++
}

Write-Host ""
Write-Host "Spoofer doctor - checking your setup" -ForegroundColor Cyan
Write-Host "===================================="

# --- 1. Python 3.12 (python.org, not Microsoft Store) ---
$basePy = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
  $exe = & py -3.12 -c "import sys; print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0 -and $exe) { $basePy = $exe.Trim() }
}
if ($basePy) {
  Ok "Python 3.12 found ($basePy)"
} else {
  $py313 = $null
  if (Get-Command py -ErrorAction SilentlyContinue) {
    $py313 = (& py -3 -c "import sys; print(sys.version.split()[0])" 2>$null)
  }
  if ($py313) {
    Warn "Python 3.12 not found (have $py313). pymobiledevice3's lzfse dep has no wheel past 3.12." `
         "winget install Python.Python.3.12   (or run scripts\setup.ps1)"
  } else {
    Fail "No Python found." "winget install Python.Python.3.12   (or run scripts\setup.ps1)"
  }
}

# Microsoft Store Python produces broken venvs (WindowsApps stub path).
$storePy = Get-Command python.exe -ErrorAction SilentlyContinue
if ($storePy -and $storePy.Source -like "*WindowsApps*") {
  Warn "'python' resolves to the Microsoft Store stub ($($storePy.Source)) - it makes broken venvs." `
       "Install python.org 3.12 and let setup.ps1 use 'py -3.12' instead."
}

# --- 2. Node.js + npm ---
if (Get-Command node -ErrorAction SilentlyContinue) {
  Ok "Node.js found ($((& node --version) 2>$null))"
} else {
  Fail "Node.js not found." "winget install OpenJS.NodeJS   (or run scripts\setup.ps1)"
}

# --- 3. Apple Mobile Device driver (the 'you need iTunes' piece) ---
# pymobiledevice3 can't enumerate the iPhone over USB without Apple's USB driver,
# which ships with iTunes / Apple Mobile Device Support.
$amdsService = Get-Service -Name "Apple Mobile Device Service" -ErrorAction SilentlyContinue
$amdsDir = "C:\Program Files\Common Files\Apple\Mobile Device Support"
if ($amdsService) {
  if ($amdsService.Status -eq "Running") {
    Ok "Apple Mobile Device Service is running"
  } else {
    Warn "Apple Mobile Device Service is installed but $($amdsService.Status)." `
         "Start it: Start-Service 'Apple Mobile Device Service'"
  }
} elseif (Test-Path $amdsDir) {
  Warn "Apple Mobile Device Support folder exists but the service isn't registered." `
       "Reinstall iTunes: winget install Apple.iTunes"
} else {
  Fail "Apple Mobile Device driver missing - the iPhone will never appear over USB." `
       "winget install Apple.iTunes   (or run scripts\setup.ps1)"
}

# --- 4. Backend venv health (native modules must actually import) ---
if (Test-Path $venvPy) {
  & $venvPy -c "import pydantic_core, pymobiledevice3" 2>$null
  if ($LASTEXITCODE -eq 0) {
    Ok "Backend venv healthy (pymobiledevice3 imports)"
  } else {
    Fail "Backend venv is broken (interpreter/package mismatch or missing deps)." `
         "Delete backend\.venv and run scripts\setup.ps1"
  }
} else {
  Fail "Backend venv not created." "Run scripts\setup.ps1"
}

# --- 5. App dependencies ---
if (Test-Path (Join-Path $root "app\node_modules")) {
  Ok "App dependencies installed (app\node_modules)"
} else {
  Fail "App dependencies not installed." "cd app; npm install   (or run scripts\setup.ps1)"
}

# --- 6. Live state (informational - only meaningful with phone plugged in) ---
Write-Host ""
Write-Host "Live checks (plug in your unlocked iPhone first):" -ForegroundColor Cyan

# Is a device visible to Apple's USB stack / pymobiledevice3?
if (Test-Path $venvPy) {
  $devs = & $venvPy -m pymobiledevice3 usbmux list 2>$null
  if ($LASTEXITCODE -eq 0 -and $devs -and $devs.Trim() -ne "[]") {
    Ok "iPhone detected over USB"
  } else {
    Warn "No iPhone detected over USB." `
         "Plug in, unlock, tap Trust. If still nothing, the Apple driver isn't installed (see above)."
  }
}

# tunneld up?
$tunnelUp = $false
try { Invoke-WebRequest "http://127.0.0.1:49151/" -TimeoutSec 1 -UseBasicParsing | Out-Null; $tunnelUp = $true } catch {}
if ($tunnelUp) {
  Ok "tunneld is running on :49151"
} else {
  Warn "tunneld not running (normal until you launch the app)." `
       "dev.ps1 / the packaged app start it automatically (one UAC prompt)."
}

# --- Summary ---
Write-Host ""
Write-Host "===================================="
if ($script:fails -gt 0) {
  Write-Host "$($script:fails) blocker(s), $($script:warns) warning(s). Fix the [FAIL] items above (or run setup.ps1)." -ForegroundColor Red
  exit 1
} elseif ($script:warns -gt 0) {
  Write-Host "Ready, with $($script:warns) warning(s) above. You can try: scripts\dev.ps1" -ForegroundColor Yellow
  exit 0
} else {
  Write-Host "All good. Launch with: powershell -ExecutionPolicy Bypass -File scripts\dev.ps1" -ForegroundColor Green
  exit 0
}
