#!/usr/bin/env bash
# Dev launcher: tunneld (sudo) + backend (venv) + electron+vite.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$ROOT/backend/.venv"

# Free port 8765 if a stale backend is squatting on it.
STALE=$(lsof -ti :8765 2>/dev/null || true)
if [[ -n "$STALE" ]]; then
  echo "Killing stale backend on :8765 (PIDs: $STALE)"
  kill -9 $STALE 2>/dev/null || true
  sleep 1
fi

# 1. backend venv (needed for pymobiledevice3 binary path)
if [[ ! -d "$VENV" ]]; then
  echo "Creating venv…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -r "$ROOT/backend/requirements.txt"
fi
PMD="$VENV/bin/pymobiledevice3"
if [[ ! -x "$PMD" ]]; then
  echo "pymobiledevice3 missing in venv. Reinstall: $VENV/bin/pip install -r $ROOT/backend/requirements.txt" >&2
  exit 1
fi

# 2. tunneld (sudo, pass venv binary)
if ! curl -sf --max-time 1 http://127.0.0.1:49151/ >/dev/null 2>&1; then
  echo "Starting tunneld (sudo)…"
  sudo "$ROOT/scripts/start-tunneld.sh" "$PMD"
  for i in {1..20}; do
    curl -sf --max-time 1 http://127.0.0.1:49151/ >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# 3. backend
"$VENV/bin/python" -m uvicorn main:app --app-dir "$ROOT/backend" --host 127.0.0.1 --port 8765 --reload &
BACKEND_PID=$!
trap "kill $BACKEND_PID 2>/dev/null || true" EXIT

# 4. electron+vite
cd "$ROOT/app"
[[ -d node_modules ]] || npm install
npm run dev
