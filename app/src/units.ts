export type UnitSystem = "metric" | "imperial";

const KEY = "spoofer.units";

export function getUnits(): UnitSystem {
  return (localStorage.getItem(KEY) as UnitSystem) || "metric";
}
export function setUnits(u: UnitSystem): void {
  localStorage.setItem(KEY, u);
}

export function fmtSpeed(mps: number, u: UnitSystem = getUnits()): string {
  if (u === "imperial") return `${(mps * 2.23694).toFixed(0)} mph`;
  return `${(mps * 3.6).toFixed(0)} km/h`;
}

export function speedUnit(u: UnitSystem = getUnits()): string {
  return u === "imperial" ? "mph" : "km/h";
}

export function speedToMps(val: number, u: UnitSystem = getUnits()): number {
  return u === "imperial" ? val / 2.23694 : val / 3.6;
}

export function mpsToSpeed(mps: number, u: UnitSystem = getUnits()): number {
  return u === "imperial" ? mps * 2.23694 : mps * 3.6;
}

export function fmtDist(m: number, u: UnitSystem = getUnits()): string {
  if (u === "imperial") {
    const ft = m * 3.28084;
    if (ft < 1000) return `${ft.toFixed(0)} ft`;
    return `${(m / 1609.34).toFixed(2)} mi`;
  }
  return m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`;
}

export function fmtTime(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  if (m < 60) return `${m}m ${ss}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
