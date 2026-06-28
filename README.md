# Spoofer

Desktop app: plug iPhone via USB, spoof its GPS to anywhere. Three modes:

- **Teleport** — click pin, jump there.
- **Walk** — pick A and B, watch it walk/run/cycle/drive.
- **Joystick** — onscreen stick + WASD, live move.

iOS 17+ only. **macOS or Windows host.** Uses `pymobiledevice3`'s `DTSimulateLocation` over the RemoteXPC tunnel. No jailbreak. Frontend uses Leaflet + OpenStreetMap (free, no API key).

## One-time setup

### 1. iPhone

Settings → Privacy & Security → **Developer Mode** → On → reboot phone.

Plug it into the computer. Tap **Trust** when prompted.

### 2. Toolchain

**macOS**

```bash
brew install python@3.13 node
cd spoofer/backend && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
cd ../app          && npm install
```

**Windows** (PowerShell)

```powershell
winget install Python.Python.3.13 OpenJS.NodeJS
cd spoofer\backend; python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt
cd ..\app;          npm install
```

> **Windows extra:** `tunneld` needs Administrator rights (you'll get a UAC prompt). For **iOS 17.0–17.3.1** you must also install the **Wintun** driver — download `wintun.dll` from [wintun.net](https://www.wintun.net) and drop it next to the venv's `pymobiledevice3.exe` (or anywhere on `PATH`). iOS **17.4+** needs no extra driver. See the [pymobiledevice3 iOS 17 tunnel guide](https://github.com/doronz88/pymobiledevice3/blob/master/docs/guides/ios17-tunnels.md).

## Run (dev)

**macOS**

```bash
./scripts/dev.sh
```

**Windows** (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

Either command:
1. Starts `pymobiledevice3 remote tunneld` elevated — macOS asks for your password (`sudo`), Windows shows a UAC prompt. Once per session.
2. Boots FastAPI backend on `:8765`.
3. Boots Vite + Electron on the renderer.

The window opens. Status pills (`tunnel`, `ws`) should turn green. Device name appears top-left.

## Run (packaged)

**macOS**

```bash
cd app && npm run dist
open dist/mac-arm64/Spoofer.app
```

**Windows** (PowerShell)

```powershell
cd app; npm run dist
# Run the generated installer, then launch Spoofer from the Start menu:
.\dist\Spoofer Setup 0.1.0.exe
```

`npm run dist` builds for whichever OS you run it on (a `.app`/`.dmg` on macOS, an NSIS `.exe` installer on Windows). The app spawns its own backend and prompts for admin (UAC / password) to start `tunneld`.

## Reset

Big red **Reset to real** button in the top-right. Also clears automatically if you yank the cable.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `tunnel` pill stays red | Start it manually in an **admin** shell: `pymobiledevice3 remote tunneld` (macOS: prefix with `sudo`) |
| UAC prompt dismissed (Windows) | Re-run and click **Yes** — `tunneld` cannot start without elevation |
| `No tunneld device` | Trust dialog dismissed on phone — unlock and replug |
| `pymobiledevice3 not found` | Use the venv binary (`backend/.venv/Scripts/pymobiledevice3.exe` on Windows, `backend/.venv/bin/pymobiledevice3` on macOS) or reinstall requirements |
| Wintun / TUN device error (Windows) | Install the Wintun driver (`wintun.dll`) — required for iOS 17.0–17.3.1, see setup note above |
| `python` not found (Windows) | Install Python and re-open the shell so it's on `PATH` (`winget install Python.Python.3.13`) |
| `InvalidServiceError` | DDI not mounted: `pymobiledevice3 mounter auto-mount` |
| Map blank | Check renderer console for tile errors. Confirm internet reachable. |
| Blue dot doesn't move on phone | Open Apple Maps once after teleport — CoreLocation publishes on first read |

## Architecture

```
Electron renderer (Leaflet + OSM UI)
        ↕ WebSocket
FastAPI backend (uvicorn :8765)
        ↕ LocationSimulation
pymobiledevice3 RemoteXPC tunnel
        ↕ USB
       iPhone
```

Backend pushes lat/lon at ~8 Hz (CoreLocation coalesces faster). Walk mode interpolates great-circle via `geographiclib`. Joystick converts (n,e) m/s vector into bearing+distance steps every 125 ms.

Cross-platform launchers live in `scripts/`: `dev.sh` / `start-tunneld.sh` (macOS) and `dev.ps1` / `start-tunneld.ps1` (Windows). They are behavior-equivalent — the Electron app picks the right one automatically.

## Out of scope (v1)

- Linux host
- Multiple devices at once
- GPX file import/export (one-line add — `LocationSimulation.play_gpx`)
- Altitude / heading / speed metadata (Apple's instrument doesn't expose them)
