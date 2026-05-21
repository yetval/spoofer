import type { LatLon } from "./map";

const KEY = "spoofer.favorites";
const MAX = 12;

export interface Favorite {
  name: string;
  lat: number;
  lon: number;
  ts: number;
}

export function list(): Favorite[] {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
}

export function add(name: string, p: LatLon): Favorite[] {
  const items = list().filter(f => !(Math.abs(f.lat - p.lat) < 1e-6 && Math.abs(f.lon - p.lon) < 1e-6));
  items.unshift({ name, lat: p.lat, lon: p.lon, ts: Date.now() });
  const trimmed = items.slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(trimmed));
  return trimmed;
}

export function remove(idx: number): Favorite[] {
  const items = list();
  items.splice(idx, 1);
  localStorage.setItem(KEY, JSON.stringify(items));
  return items;
}
