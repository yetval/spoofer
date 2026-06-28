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

# 1. backend venv (needed for pymobiledevice3 binary path)
if (-not (Test-Path $venv)) {
  Write-Host "Creating venv..."
  python -m venv $venv
  & (Join-Path $venv "Scripts\pip.exe") install -r (Join-Path $root "backend\requirements.txt")
}
$pmd = Join-Path $venv "Scripts\pymobiledevice3.exe"
if (-not (Test-Path $pmd)) {
  Write-Error "pymobiledevice3 missing in venv. Reinstall: $venv\Scripts\pip.exe install -r $root\backend\requirements.txt"
  exit 1
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
