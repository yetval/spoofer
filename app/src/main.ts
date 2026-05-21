import { MapView } from "./map";
import { Backend, Msg } from "./ws";
import { Controls } from "./control";
import { fmtSpeed, fmtTime } from "./units";
import { detect } from "./mylocation";

declare global {
  interface Window {
    spoofer: {
      backendPort: () => Promise<number>;
      tunnelStatus: () => Promise<"up" | "down">;
      startTunnel: () => Promise<string>;
    };
  }
}

function fmt(n: number): string { return n.toFixed(5); }

async function boot(): Promise<void> {
  const tunnelEl = document.getElementById("tunnel")!;
  const wsEl = document.getElementById("ws")!;
  const deviceEl = document.getElementById("device")!;
  const hud = document.getElementById("hud")!;
  const hudCoord = document.getElementById("hud-coord")!;
  const hudSpeed = document.getElementById("hud-speed")!;
  const hudEta = document.getElementById("hud-eta")!;

  const port = (await window.spoofer?.backendPort?.()) ?? 8765;

  const refreshTunnel = async () => {
    const ts = await window.spoofer?.tunnelStatus?.();
    tunnelEl.classList.toggle("up", ts === "up");
    tunnelEl.classList.toggle("down", ts !== "up");
  };
  refreshTunnel(); setInterval(refreshTunnel, 5000);

  const map = new MapView(document.getElementById("map")!);
  await map.init();

  // Auto-detect real location and center the map.
  detect().then((loc) => {
    map.centerOn({ lat: loc.lat, lon: loc.lon }, loc.source === "gps" ? 15 : 11);
    const tag = loc.source === "gps" ? "GPS" : "IP";
    const label = loc.label ? ` · ${loc.label}` : "";
    console.log(`[spoofer] My location (${tag}): ${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}${label}`);
    controls.setRealLocation({ lat: loc.lat, lon: loc.lon });
  }).catch((e) => {
    console.warn("[spoofer] auto-detect failed:", e.message);
  });

  const backend = new Backend(port);
  backend.onStatusChange((up) => {
    wsEl.classList.toggle("up", up);
    wsEl.classList.toggle("down", !up);
  });

  const refreshDevice = () => {
    fetch(`http://127.0.0.1:${port}/devices`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        deviceEl.textContent = `${d.name?.startsWith("usbmux") ? "iPhone" : d.name} · iOS ${d.iosVersion}`;
        deviceEl.classList.add("connected");
      })
      .catch(() => {
        deviceEl.textContent = "No device";
        deviceEl.classList.remove("connected");
      });
  };

  const controls = new Controls(map, backend);

  let lastMode = "idle";
  backend.onMessage((m: Msg) => {
    if (m.type === "ready") refreshDevice();
    else if (m.type === "state") {
      map.setLiveLocation({ lat: m.lat, lon: m.lon });
      map.panToLive({ lat: m.lat, lon: m.lon });
      hud.classList.remove("hidden");
      hudCoord.textContent = `${fmt(m.lat)}, ${fmt(m.lon)}`;
      controls.setCurrentLocation({ lat: m.lat, lon: m.lon });
    } else if (m.type === "progress") {
      map.setLiveLocation({ lat: m.lat, lon: m.lon });
      if (m.mode !== "idle" && m.mode !== lastMode) map.panToLive({ lat: m.lat, lon: m.lon });
      lastMode = m.mode;
      controls.setCurrentLocation({ lat: m.lat, lon: m.lon });
      hud.classList.remove("hidden");
      hudCoord.textContent = `${fmt(m.lat)}, ${fmt(m.lon)}`;
      hudSpeed.textContent = m.speedMps > 0.3 ? fmtSpeed(m.speedMps) : "—";
      hudEta.textContent = m.mode === "drive" && m.etaS > 0 ? fmtTime(m.etaS) : "—";
      controls.applyProgress(m);
    } else if (m.type === "lock") {
      controls.applyLockState(m.on);
    } else if (m.type === "error") {
      console.error("[spoofer backend]", m.message);
    }
  });
  backend.connect();
  controls.mount();
}

boot();
