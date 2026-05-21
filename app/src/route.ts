import type { LatLon } from "./map";

const OSRM = "https://router.project-osrm.org";

export type RouteProfile = "driving" | "walking" | "cycling";

export interface Route {
  polyline: LatLon[];
  segment_speeds_mps?: number[];
  distance_m: number;
  duration_s: number;
  fallback?: "straight-line";
}

async function snapToRoad(p: LatLon): Promise<LatLon> {
  try {
    const r = await fetch(`${OSRM}/nearest/v1/driving/${p.lon},${p.lat}?number=1`);
    if (!r.ok) return p;
    const j = await r.json();
    const loc = j?.waypoints?.[0]?.location;
    if (!loc) return p;
    return { lat: loc[1], lon: loc[0] };
  } catch {
    return p;
  }
}

function haversine(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function straightLine(from: LatLon, to: LatLon, steps = 40): Route {
  const poly: LatLon[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    poly.push({ lat: from.lat + (to.lat - from.lat) * t, lon: from.lon + (to.lon - from.lon) * t });
  }
  const d = haversine(from, to);
  return { polyline: poly, distance_m: d, duration_s: d / 13.9, fallback: "straight-line" };
}

export async function fetchRoute(
  fromIn: LatLon,
  toIn: LatLon,
  _profile: RouteProfile = "driving",
): Promise<Route> {
  // Demo OSRM supports only "driving" profile.
  const [from, to] = await Promise.all([snapToRoad(fromIn), snapToRoad(toIn)]);

  if (haversine(from, to) < 5) {
    throw new Error("Start and end too close");
  }

  const url = `${OSRM}/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&annotations=speed,distance,duration&steps=false`;
  const r = await fetch(url);
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json()).message || ""; } catch {}
    console.warn(`[spoofer] OSRM ${r.status}: ${detail}. Falling back to straight line.`);
    return straightLine(from, to);
  }
  const j = await r.json();
  if (!j.routes?.length) {
    console.warn("[spoofer] OSRM no route. Falling back to straight line.");
    return straightLine(from, to);
  }
  const route = j.routes[0];
  const coords: [number, number][] = route.geometry.coordinates;
  // Concat annotation.speed arrays across all legs. Length = polyline.length - 1.
  const speeds: number[] = [];
  for (const leg of route.legs ?? []) {
    if (leg?.annotation?.speed) speeds.push(...leg.annotation.speed);
  }
  return {
    polyline: coords.map(([lon, lat]) => ({ lat, lon })),
    segment_speeds_mps: speeds.length === coords.length - 1 ? speeds : undefined,
    distance_m: route.distance,
    duration_s: route.duration,
  };
}
