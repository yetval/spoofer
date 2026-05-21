import type { LatLon } from "./map";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

export async function search(q: string, limit = 6): Promise<Place[]> {
  if (!q.trim()) return [];
  const url = `${NOMINATIM}?format=json&limit=${limit}&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { "Accept-Language": "en" } });
  if (!r.ok) throw new Error(`Nominatim ${r.status}`);
  const j: Array<{ display_name: string; lat: string; lon: string }> = await r.json();
  return j.map((p) => ({ name: p.display_name, lat: parseFloat(p.lat), lon: parseFloat(p.lon) }));
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: number | undefined;
  return (...a: A) => {
    if (t !== undefined) clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}
