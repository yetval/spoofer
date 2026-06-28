# Dev launcher (Windows): tunneld (UAC) + backend (venv) + electron+vite.
# Mirror of scripts/dev.sh. Run from a normal shell:
#   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
# Only the tunneld step elevates (one UAC prompt), matching `sudo` in dev.sh.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $root "backend\.venv"

# Free port 8765 if a stale backend is squatting on it.
$stale = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if ($stale) {
  $stale.OwningProcess | Select-Object -Unique | ForEach-Object {
    Write-Host "Killing stale backend on :8765 (PID $_)"
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
}

# 1. backend venv (self-healing)
# Prefer a python.org Python 3.12: `lzfse` (a pymobiledevice3 dep) only ships prebuilt Windows
# wheels up to CPython 3.12. We also rebuild the venv if its native modules don't import — e.g.
# when a Conda interpreter re-stamped it to 3.13 over 3.12-built packages (split-brain venv).
$venvPy = Join-Path $venv "Scripts\python.exe"

function Resolve-BasePython {
  # python.org 3.12, then 3.11, then whatever `python` resolves to (warns about 3.13+).
  if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($v in @("3.12", "3.11")) {
      $exe = & py "-$v" -c "import sys; print(sys.executable)" 2>$null
      if ($LASTEXITCODE -eq 0 -and $exe) { return $exe.Trim() }
    }
  }
  Write-Host "  WARNING: Python 3.12 not found. Using default python; 3.13+ needs prebuilt lzfse"
  Write-Host "           wheels (currently <=3.12) or C++ Build Tools. winget install Python.Python.3.12"
  $exe = & python -c "import sys; print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0 -and $exe) { return $exe.Trim() }
  return $null
}

# Healthy = the native deps actually import under the venv interpreter.
$venvHealthy = $false
if (Test-Path $venvPy) {
  & $venvPy -c "import pydantic_core, pymobiledevice3" 2>$null
  if ($LASTEXITCODE -eq 0) { $venvHealthy = $true }
  else { Write-Host "Existing venv is broken (interpreter/package mismatch) - rebuilding..." }
}

if (-not $venvHealthy) {
  if (Test-Path $venv) { Remove-Item -Recurse -Force $venv }
  $base = Resolve-BasePython
  if (-not $base) { Write-Error "No usable Python found. Install Python 3.12: winget install Python.Python.3.12"; exit 1 }
  Write-Host "Creating venv with $base"
  & $base -m venv $venv
  # Call pip as a module — some base interpreters omit the pip.exe wrapper.
  & $venvPy -m pip install --upgrade pip
  & $venvPy -m pip install -r (Join-Path $root "backend\requirements.txt")
  & $venvPy -c "import pydantic_core, pymobiledevice3" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Backend deps failed to import after install. See the lzfse / Build Tools note in the README."
    exit 1
  }
}

# 2. tunneld (UAC elevation, pass nothing - the script self-locates the binary)
$tunnelUp = $false
try { Invoke-WebRequest "http://127.0.0.1:49151/" -TimeoutSec 1 -UseBasicParsing | Out-Null; $tunnelUp = $true } catch {}
if (-not $tunnelUp) {
  Write-Host "Starting tunneld (admin)..."
  Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList `
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root "scripts\start-tunneld.ps1")
  for ($i = 0; $i -lt 20; $i++) {
    try { Invoke-WebRequest "http://127.0.0.1:49151/" -TimeoutSec 1 -UseBasicParsing | Out-Null; break }
    catch { Start-Sleep -Milliseconds 500 }
  }
}

# 3. backend
$py = Join-Path $venv "Scripts\python.exe"
$backend = Start-Process -FilePath $py -PassThru -NoNewWindow -ArgumentList `
  "-m", "uvicorn", "main:app", "--app-dir", (Join-Path $root "backend"), `
  "--host", "127.0.0.1", "--port", "8765", "--reload"

# 4. electron+vite
try {
  Set-Location (Join-Path $root "app")
  if (-not (Test-Path "node_modules")) { npm install }
  npm run dev
} finally {
  if ($backend -and -not $backend.HasExited) {
    Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
  }
}
