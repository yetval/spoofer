# Spoofer

Desktop app: plug iPhone via USB, spoof its GPS to anywhere. Three modes:

- **Teleport** — click pin, jump there.
- **Walk** — pick A and B, watch it walk/run/cycle/drive.
- **Joystick** — onscreen stick + WASD, live move.

iOS 17+ only. macOS host. Uses `pymobiledevice3`'s `DTSimulateLocation` over the RemoteXPC tunnel. No jailbreak. Frontend uses Leaflet + OpenStreetMap (free, no API key).

## One-time setup

### 1. iPhone

Settings → Privacy & Security → **Developer Mode** → On → reboot phone.

Plug it into the Mac. Tap **Trust** when prompted.

### 2. Toolchain

```bash
brew install python@3.13 node
cd spoofer/backend && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
cd ../app          && npm install
```

## Run (dev)

```bash
./scripts/dev.sh
```

That command:
1. Starts `pymobiledevice3 remote tunneld` as sudo (asks for password once).
2. Boots FastAPI backend on `:8765`.
3. Boots Vite + Electron on the renderer.

The window opens. Status pills (`tunnel`, `ws`) should turn green. Device name appears top-left.

## Run (packaged)

```bash
cd app && npm run dist
open dist/mac-arm64/Spoofer.app
```

The app spawns its own backend and prompts for admin to start `tunneld`.

## Reset

Big red **Reset to real** button in the top-right. Also clears automatically if you yank the cable.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `tunnel` pill stays red | `sudo pymobiledevice3 remote tunneld` manually in a Terminal |
| `No tunneld device` | Trust dialog dismissed on phone — unlock and replug |
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

## Out of scope (v1)

- Windows / Linux host
- Multiple devices at once
- GPX file import/export (one-line add — `LocationSimulation.play_gpx`)
- Altitude / heading / speed metadata (Apple's instrument doesn't expose them)
