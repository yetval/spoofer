#!/usr/bin/env bash
# Start pymobiledevice3 tunneld as root. Idempotent.
# Arg 1 (optional): absolute path to pymobiledevice3 binary (venv).
set -euo pipefail
if curl -sf --max-time 1 http://127.0.0.1:49151/ >/dev/null 2>&1; then
  exit 0
fi
PMD="${1:-}"
if [[ -z "$PMD" ]]; then
  PMD="$(command -v pymobiledevice3 || true)"
fi
if [[ -z "$PMD" || ! -x "$PMD" ]]; then
  echo "pymobiledevice3 not found (got: '$PMD')" >&2
  exit 1
fi
nohup "$PMD" remote tunneld >/tmp/spoofer-tunneld.log 2>&1 &
disown
