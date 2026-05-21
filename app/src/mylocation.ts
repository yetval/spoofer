import type { LatLon } from "./map";

export interface MyLocation {
  lat: number;
  lon: number;
  source: "gps" | "ip";
  label?: string;
}

function gps(): Promise<MyLocation> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("no geolocation API")); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, source: "gps" }),
      (e) => reject(new Error(e.message || `code ${e.code}`)),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 },
    );
  });
}

async function ipLookup(): Promise<MyLocation> {
  // Try ipapi.co first (HTTPS, JSON, no key, generous free tier).
  try {
    const r = await fetch("https://ipapi.co/json/");
    if (r.ok) {
      const j = await r.json();
      if (j.latitude && j.longitude) {
        return { lat: j.latitude, lon: j.longitude, source: "ip",
                 label: [j.city, j.region, j.country_name].filter(Boolean).join(", ") };
      }
    }
  } catch {}
  // Fallback: ipwho.is
  try {
    const r = await fetch("https://ipwho.is/");
    if (r.ok) {
      const j = await r.json();
      if (j.success && j.latitude && j.longitude) {
        return { lat: j.latitude, lon: j.longitude, source: "ip",
                 label: [j.city, j.region, j.country].filter(Boolean).join(", ") };
      }
    }
  } catch {}
  throw new Error("IP geolocation failed");
}

export async function detect(): Promise<MyLocation> {
  try {
    return await gps();
  } catch (e) {
    console.warn("[spoofer] GPS failed, falling back to IP:", (e as Error).message);
    return await ipLookup();
  }
}

export async function detectIpOnly(): Promise<MyLocation> {
  return ipLookup();
}
