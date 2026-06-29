# Spoofer one-command setup (Windows).
# Installs everything missing, builds the backend venv, installs the app, then verifies.
# Run from a normal shell (it elevates only if it has to install something):
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#
# Idempotent: re-running skips anything already present.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root "backend\.venv"
$venvPy = Join-Path $venv "Scripts\python.exe"

function Step($m) { Write-Host ""; Write-Host ">> $m" -ForegroundColor Cyan }
function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

Write-Host "Spoofer setup" -ForegroundColor Cyan
Write-Host "============="

if (-not (Have winget)) {
  Write-Error "winget not found. Update Windows / install 'App Installer' from the Microsoft Store, then re-run."
  exit 1
}

# --- 1. Python 3.12 (python.org). lzfse (a pymobiledevice3 dep) has no wheel past 3.12. ---
Step "Python 3.12"
$havePy312 = $false
if (Have py) {
  & py -3.12 -c "exit(0)" 2>$null
  if ($LASTEXITCODE -eq 0) { $havePy312 = $true }
}
if ($havePy312) {
  Write-Host "  already installed"
} else {
  Write-Host "  installing Python.Python.3.12 ..."
  winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
  # py launcher may need a fresh PATH; the venv step below tolerates this.
}

# --- 2. Node.js ---
Step "Node.js"
if (Have node) {
  Write-Host "  already installed ($((& node --version) 2>$null))"
} else {
  Write-Host "  installing OpenJS.NodeJS ..."
  winget install --id OpenJS.NodeJS -e --accept-source-agreements --accept-package-agreements
  $env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
}

# --- 3. Apple Mobile Device driver (the 'you need iTunes' piece) ---
# Without Apple's USB driver, pymobiledevice3 never sees the iPhone. It ships with iTunes.
Step "Apple Mobile Device driver (via iTunes)"
$amds = Get-Service -Name "Apple Mobile Device Service" -ErrorAction SilentlyContinue
$amdsDir = "C:\Program Files\Common Files\Apple\Mobile Device Support"
if ($amds -or (Test-Path $amdsDir)) {
  Write-Host "  already installed"
} else {
  Write-Host "  installing Apple.iTunes (provides the Apple Mobile Device USB driver) ..."
  winget install --id Apple.iTunes -e --accept-source-agreements --accept-package-agreements
  Write-Host "  NOTE: a reboot is sometimes needed before Windows loads the new USB driver." -ForegroundColor Yellow
}

# --- 4. Backend venv + deps ---
Step "Backend virtualenv + dependencies"
function Resolve-BasePython {
  if (Have py) {
    foreach ($v in @("3.12", "3.11")) {
      $exe = & py "-$v" -c "import sys; print(sys.executable)" 2>$null
      if ($LASTEXITCODE -eq 0 -and $exe) { return $exe.Trim() }
    }
  }
  $exe = & python -c "import sys; print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0 -and $exe) { return $exe.Trim() }
  return $null
}

# Rebuild if the venv's native modules don't import (split-brain / wrong Python).
$healthy = $false
if (Test-Path $venvPy) {
  & $venvPy -c "import pydantic_core, pymobiledevice3" 2>$null
  if ($LASTEXITCODE -eq 0) { $healthy = $true } else { Write-Host "  existing venv broken - rebuilding" }
}
if (-not $healthy) {
  if (Test-Path $venv) { Remove-Item -Recurse -Force $venv }
  $base = Resolve-BasePython
  if (-not $base) { Write-Error "No usable Python found. Open a NEW shell so Python is on PATH, then re-run setup.ps1."; exit 1 }
  Write-Host "  creating venv with $base"
  & $base -m venv $venv
  & $venvPy -m pip install --upgrade pip
  & $venvPy -m pip install -r (Join-Path $root "backend\requirements.txt")
  & $venvPy -c "import pydantic_core, pymobiledevice3" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Backend deps failed to import. You're likely not on Python 3.12 (lzfse wheel). See README."
    exit 1
  }
} else {
  Write-Host "  already healthy"
}

# --- 5. App deps ---
Step "App dependencies (npm install)"
Push-Location (Join-Path $root "app")
try {
  if (Test-Path "node_modules") { Write-Host "  already installed" } else { npm install }
} finally { Pop-Location }

# --- 6. Verify ---
Step "Verifying with doctor.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "doctor.ps1")

Write-Host ""
Write-Host "Setup done. Plug in your iPhone (unlock + Trust), then launch:" -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\dev.ps1" -ForegroundColor Green
