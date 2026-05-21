import { MapView, LatLon } from "./map";
import { Backend } from "./ws";
import { Joystick } from "./joystick";
import { fetchRoute, Route } from "./route";
import { search, Place, debounce } from "./geocode";
import * as fav from "./favorites";
import { fmtDist, fmtTime, fmtSpeed, mpsToSpeed, speedToMps, speedUnit, getUnits, setUnits, UnitSystem } from "./units";
import { detect } from "./mylocation";

type Mode = "teleport" | "walk" | "drive" | "joystick";
type Slot = "from" | "to" | null;

const log = (...a: unknown[]) => console.log("[spoofer]", ...a);

function flash(msg: string): void {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout((flash as any)._t);
  (flash as any)._t = setTimeout(() => el.classList.remove("show"), 1800);
}

export class Controls {
  private mode: Mode = "teleport";
  private teleportPin: LatLon | null = null;
  private teleportLabel: string | null = null;
  private walk: { from: LatLon | null; to: LatLon | null; armed: Slot } = { from: null, to: null, armed: null };
  private drive: { from: LatLon | null; to: LatLon | null; armed: Slot; route: Route | null } =
    { from: null, to: null, armed: null, route: null };
  private joystick: Joystick | null = null;
  private currentSpoofed: LatLon | null = null;
  private realLocation: LatLon | null = null;
  private lockOn = false;

  constructor(private map: MapView, private backend: Backend) {}

  mount(): void {
    document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
      b.addEventListener("click", () => this.setMode(b.dataset.mode as Mode));
    });

    // Units toggle
    document.querySelectorAll<HTMLButtonElement>("#units-toggle button").forEach((b) => {
      b.classList.toggle("active", b.dataset.unit === getUnits());
      b.addEventListener("click", () => this.changeUnits(b.dataset.unit as UnitSystem));
    });
    this.refreshUnitsUI();

    // Teleport
    document.getElementById("t-go")?.addEventListener("click", () => {
      if (!this.teleportPin) { flash("Pick a place first"); return; }
      this.send({ cmd: "teleport", lat: this.teleportPin.lat, lon: this.teleportPin.lon });
      flash(`Moved to ${this.teleportPin.lat.toFixed(4)}, ${this.teleportPin.lon.toFixed(4)}`);
    });
    document.getElementById("t-my-location")?.addEventListener("click", () => this.useRealLocation("teleport"));
    document.getElementById("t-save")?.addEventListener("click", () => {
      if (!this.teleportPin) { flash("Pick a place first"); return; }
      const name = this.teleportLabel || prompt("Name this favorite", "Pin") || "Pin";
      fav.add(name, this.teleportPin);
      this.renderFavorites();
      flash(`Saved · ${name}`);
    });

    // Walk
    this.wirePicker("walk");
    document.getElementById("w-use-real")?.addEventListener("click", () => this.useRealLocation("walk"));
    document.getElementById("w-use-spoofed")?.addEventListener("click", () => this.useCurrentAsStart("walk"));
    document.getElementById("w-start")?.addEventListener("click", () => {
      if (!this.walk.from || !this.walk.to) { flash("Set From AND To"); return; }
      const speed = parseFloat((document.getElementById("w-speed") as HTMLSelectElement).value);
      this.send({ cmd: "teleport", lat: this.walk.from.lat, lon: this.walk.from.lon });
      setTimeout(() => this.send({ cmd: "walk", lat: this.walk.to!.lat, lon: this.walk.to!.lon, speed }), 250);
      flash(`Walking @ ${fmtSpeed(speed)}`);
    });
    document.getElementById("w-stop")?.addEventListener("click", () => { this.send({ cmd: "stop" }); flash("Stopped"); });

    // Drive
    this.wirePicker("drive");
    document.getElementById("d-use-real")?.addEventListener("click", () => this.useRealLocation("drive"));
    document.getElementById("d-use-spoofed")?.addEventListener("click", () => this.useCurrentAsStart("drive"));
    document.getElementById("d-preview")?.addEventListener("click", () => this.driveFetch());
    document.getElementById("d-start")?.addEventListener("click", () => this.driveStart());
    document.getElementById("d-stop")?.addEventListener("click", () => { this.send({ cmd: "stop" }); flash("Stopped"); });

    const dSpeed = document.getElementById("d-speed") as HTMLInputElement;
    dSpeed?.addEventListener("input", () => {
      document.getElementById("d-speed-val")!.textContent = dSpeed.value;
      this.updateDriveInfo();
    });

    document.getElementById("reset")?.addEventListener("click", () => { this.send({ cmd: "reset" }); flash("Reset"); });
    document.getElementById("reconnect")?.addEventListener("click", () => this.reconnect());
    document.getElementById("lock")?.addEventListener("click", () => {
      this.lockOn = !this.lockOn;
      this.send({ cmd: "lock", on: this.lockOn });
    });

    // Joystick
    document.getElementById("j-stop")?.addEventListener("click", () => { this.send({ cmd: "stop" }); flash("Joystick stopped"); });
    const jSpeed = document.getElementById("j-speed") as HTMLInputElement;
    jSpeed?.addEventListener("input", () => {
      document.getElementById("j-speed-val")!.textContent = parseFloat(jSpeed.value).toFixed(1);
      this.joystick?.setSpeed(parseFloat(jSpeed.value));
    });

    this.map.onMapClick((p) => this.handleMapClick(p));
    this.mountSearch();
    this.mountTileSwitch();
    this.renderFavorites();
  }

  private async driveStart(): Promise<void> {
    if (!this.drive.route) await this.driveFetch();
    const route = this.drive.route;
    if (!route) return;
    const capDisplay = parseFloat((document.getElementById("d-speed") as HTMLInputElement).value);
    const capMps = speedToMps(capDisplay);
    const life360 = (document.getElementById("d-life360") as HTMLInputElement).checked;
    const useLimits = (document.getElementById("d-real-limits") as HTMLInputElement).checked;
    const poly = route.polyline.map((p) => [p.lat, p.lon]);
    const payload: Record<string, unknown> = { cmd: "drive", polyline: poly, speed: capMps, life360 };
    if (useLimits && route.segment_speeds_mps) {
      payload.segment_speeds = route.segment_speeds_mps.map((s) => Math.min(s, capMps));
    }
    this.send({ cmd: "teleport", lat: route.polyline[0].lat, lon: route.polyline[0].lon });
    setTimeout(() => this.send(payload), 250);
    const realETA = useLimits && route.segment_speeds_mps ? route.duration_s : route.distance_m / capMps;
    flash(`${life360 ? "Life360" : "Drive"} · ${fmtDist(route.distance_m)} · ETA ${fmtTime(realETA)}`);
  }

  private changeUnits(u: UnitSystem): void {
    setUnits(u);
    document.querySelectorAll<HTMLButtonElement>("#units-toggle button").forEach((b) => {
      b.classList.toggle("active", b.dataset.unit === u);
    });
    this.refreshUnitsUI();
    if (this.drive.route) this.updateDriveInfo();
    flash(`Units: ${u === "imperial" ? "Imperial (mph/mi)" : "Metric (km/h/km)"}`);
  }

  private refreshUnitsUI(): void {
    const u = getUnits();
    const isImp = u === "imperial";
    // Drive speed slider: 10-160 km/h → 6-100 mph; preserve current m/s.
    const dSpeed = document.getElementById("d-speed") as HTMLInputElement;
    if (dSpeed) {
      const curMps = speedToMps(parseFloat(dSpeed.value), isImp ? "metric" : "imperial");
      dSpeed.min = isImp ? "5" : "10";
      dSpeed.max = isImp ? "100" : "160";
      dSpeed.step = isImp ? "5" : "5";
      dSpeed.value = Math.round(mpsToSpeed(curMps)).toString();
      document.getElementById("d-speed-val")!.textContent = dSpeed.value;
      document.getElementById("d-speed-unit")!.textContent = speedUnit();
    }
  }

  setCurrentLocation(p: LatLon): void { this.currentSpoofed = p; }
  setRealLocation(p: LatLon): void { this.realLocation = p; }

  applyLockState(on: boolean): void {
    this.lockOn = on;
    const b = document.getElementById("lock");
    if (!b) return;
    b.textContent = on ? "🔒 Lock: on" : "🔒 Lock: off";
    b.classList.toggle("active", on);
    flash(on ? "Lock on — pinned + auto-recover" : "Lock off");
  }

  private wirePicker(mode: "walk" | "drive"): void {
    const prefix = mode[0];
    document.getElementById(`${prefix}-pick-from`)?.addEventListener("click", () => this.arm(mode, "from"));
    document.getElementById(`${prefix}-pick-to`)?.addEventListener("click", () => this.arm(mode, "to"));
  }

  private arm(mode: "walk" | "drive", slot: Slot): void {
    const state = mode === "walk" ? this.walk : this.drive;
    state.armed = state.armed === slot ? null : slot;
    this.updateArmedUI(mode);
    if (state.armed) flash(`Click map to set ${slot}`);
  }

  private updateArmedUI(mode: "walk" | "drive"): void {
    const prefix = mode[0];
    const state = mode === "walk" ? this.walk : this.drive;
    document.getElementById(`${prefix}-pick-from`)!.classList.toggle("armed", state.armed === "from");
    document.getElementById(`${prefix}-pick-to`)!.classList.toggle("armed", state.armed === "to");
  }

  private useCurrentAsStart(mode: "walk" | "drive"): void {
    if (!this.currentSpoofed) { flash("No spoofed location yet"); return; }
    const state = mode === "walk" ? this.walk : this.drive;
    state.from = { ...this.currentSpoofed };
    this.map.setPin(state.from, "from");
    const prefix = mode[0];
    document.getElementById(`${prefix}-from`)!.textContent = `${state.from.lat.toFixed(5)}, ${state.from.lon.toFixed(5)}`;
    if (mode === "drive" && this.drive.to) this.driveFetch();
  }

  private async useRealLocation(target: "teleport" | "walk" | "drive"): Promise<void> {
    let p: LatLon;
    let source = "cached";
    if (this.realLocation) {
      p = this.realLocation;
    } else {
      flash("Detecting location…");
      try {
        const loc = await detect();
        p = { lat: loc.lat, lon: loc.lon };
        source = loc.source;
        this.realLocation = p;
      } catch (e) {
        flash(`Location failed: ${(e as Error).message}`);
        return;
      }
    }
    this.map.centerOn(p, source === "gps" ? 15 : 13);
    if (target === "teleport") {
      this.teleportPin = p;
      this.teleportLabel = "My location";
      this.map.setPin(p, "teleport");
      document.getElementById("t-coord")!.textContent = `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
    } else {
      const state = target === "walk" ? this.walk : this.drive;
      state.from = p;
      this.map.setPin(p, "from");
      const prefix = target[0];
      document.getElementById(`${prefix}-from`)!.textContent = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
      if (target === "drive" && this.drive.to) this.driveFetch();
    }
    flash(`Real location (${source}): ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`);
  }

  private send(obj: Record<string, unknown>): void {
    log("WS send", obj);
    this.backend.send(obj);
  }

  private async reconnect(): Promise<void> {
    flash("Reconnecting…");
    try {
      const port = (await window.spoofer?.backendPort?.()) ?? 8765;
      const r = await fetch(`http://127.0.0.1:${port}/reconnect`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
      const d = await r.json();
      flash(`Reconnected · ${d.name}`);
    } catch (e) {
      flash(`Reconnect failed: ${(e as Error).message}`);
    }
  }

  private mountSearch(): void {
    const input = document.getElementById("search") as HTMLInputElement;
    const list = document.getElementById("search-results") as HTMLUListElement;
    const run = debounce(async (q: string) => {
      if (!q.trim()) { list.classList.add("hidden"); list.innerHTML = ""; return; }
      try {
        const places = await search(q);
        list.innerHTML = "";
        for (const p of places) {
          const li = document.createElement("li");
          li.textContent = p.name;
          li.addEventListener("click", () => this.pickPlace(p));
          list.appendChild(li);
        }
        list.classList.toggle("hidden", places.length === 0);
      } catch (e) { log("search err", e); }
    }, 300);
    input.addEventListener("input", () => run(input.value));
    input.addEventListener("blur", () => setTimeout(() => list.classList.add("hidden"), 200));
    input.addEventListener("focus", () => { if (list.children.length) list.classList.remove("hidden"); });
  }

  private pickPlace(p: Place): void {
    const ll: LatLon = { lat: p.lat, lon: p.lon };
    this.teleportLabel = p.name.split(",")[0];
    this.map.centerOn(ll, 15);
    (document.getElementById("search") as HTMLInputElement).value = this.teleportLabel;
    document.getElementById("search-results")!.classList.add("hidden");
    this.handleMapClick(ll);
  }

  private mountTileSwitch(): void {
    document.querySelectorAll<HTMLButtonElement>("#tile-switch button").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("#tile-switch button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this.map.setTileStyle(b.dataset.tile as any);
      });
    });
  }

  private renderFavorites(): void {
    const items = fav.list();
    const list = document.getElementById("fav-list")!;
    document.getElementById("fav-count")!.textContent = items.length ? `· ${items.length}` : "";
    if (items.length === 0) {
      list.innerHTML = '<li class="empty">No favorites yet. Save from Teleport.</li>';
      return;
    }
    list.innerHTML = "";
    items.forEach((f, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="name">${escapeHtml(f.name)}</span><button class="del" title="Remove">×</button>`;
      li.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("del")) {
          fav.remove(i);
          this.renderFavorites();
        } else {
          this.teleportPin = { lat: f.lat, lon: f.lon };
          this.teleportLabel = f.name;
          this.map.centerOn(this.teleportPin, 15);
          this.map.setPin(this.teleportPin, "teleport");
          document.getElementById("t-coord")!.textContent = `${f.lat.toFixed(6)}, ${f.lon.toFixed(6)}`;
          this.setMode("teleport");
          flash(`Loaded · ${f.name}`);
        }
      });
      list.appendChild(li);
    });
  }

  private handleMapClick(p: LatLon): void {
    if (this.mode === "teleport") {
      this.teleportPin = p;
      this.map.setPin(p, "teleport");
      document.getElementById("t-coord")!.textContent = `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
      return;
    }
    if (this.mode === "walk" || this.mode === "drive") {
      const state = this.mode === "walk" ? this.walk : this.drive;
      const slot: "from" | "to" = state.armed ?? (!state.from ? "from" : "to");
      const prefix = this.mode[0];
      if (slot === "from") {
        state.from = p;
        state.to = null;
        this.map.clearRoute();
        this.map.setPin(p, "from");
        document.getElementById(`${prefix}-from`)!.textContent = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
        document.getElementById(`${prefix}-to`)!.textContent = "—";
        if (this.mode === "drive") {
          this.drive.route = null;
          document.getElementById("d-info")!.textContent = "";
        }
      } else {
        state.to = p;
        this.map.setPin(p, "to");
        document.getElementById(`${prefix}-to`)!.textContent = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
        if (this.mode === "drive") this.driveFetch();
      }
      state.armed = null;
      this.updateArmedUI(this.mode);
    }
  }

  private async driveFetch(): Promise<void> {
    if (!this.drive.from || !this.drive.to) return;
    document.getElementById("d-info")!.textContent = "Routing…";
    try {
      this.drive.route = await fetchRoute(this.drive.from, this.drive.to, "driving");
      this.map.drawRoute(this.drive.route.polyline);
      this.updateDriveInfo();
    } catch (e) {
      document.getElementById("d-info")!.textContent = `Route error: ${(e as Error).message}`;
    }
  }

  private updateDriveInfo(): void {
    if (!this.drive.route) return;
    const capDisplay = parseFloat((document.getElementById("d-speed") as HTMLInputElement).value);
    const capMps = speedToMps(capDisplay);
    const eta = this.drive.route.distance_m / capMps;
    const warn = this.drive.route.fallback === "straight-line" ? " · ⚠ straight-line" : "";
    document.getElementById("d-info")!.textContent =
      `${fmtDist(this.drive.route.distance_m)} · ETA ${fmtTime(eta)} @ ${capDisplay} ${speedUnit()}${warn}`;
  }

  applyProgress(p: { mode: string; doneM: number; totalM: number; speedMps: number; etaS: number }): void {
    if (p.mode === "drive" && p.totalM > 0) {
      const pct = Math.min(100, (p.doneM / p.totalM) * 100);
      document.getElementById("d-bar")!.style.width = `${pct}%`;
      document.getElementById("d-stat-done")!.textContent =
        `${fmtDist(p.doneM)} / ${fmtDist(p.totalM)} (${pct.toFixed(0)}%)`;
      document.getElementById("d-stat-speed")!.textContent = fmtSpeed(p.speedMps);
      document.getElementById("d-stat-eta")!.textContent = `ETA ${fmtTime(p.etaS)}`;
    } else if (p.mode === "idle") {
      document.getElementById("d-bar")!.style.width = `0%`;
      document.getElementById("d-stat-done")!.textContent = "0";
      document.getElementById("d-stat-speed")!.textContent = "—";
      document.getElementById("d-stat-eta")!.textContent = "ETA —";
    }
  }

  private setMode(m: Mode): void {
    this.mode = m;
    document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === m);
    });
    for (const id of ["pane-teleport", "pane-walk", "pane-drive", "pane-joystick"]) {
      document.getElementById(id)?.classList.add("hidden");
    }
    document.getElementById(`pane-${m}`)?.classList.remove("hidden");

    if (m === "joystick") {
      if (!this.joystick) {
        this.joystick = new Joystick(document.getElementById("stick")!);
        this.joystick.mount();
        this.joystick.onVector((v) => this.send({ cmd: "joystick_vec", n: v.n, e: v.e }));
      }
      this.send({ cmd: "joystick_start" });
    } else if (this.joystick) {
      this.joystick.unmount();
      this.joystick = null;
      this.send({ cmd: "stop" });
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
}
