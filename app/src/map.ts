import L from "leaflet";

export type LatLon = { lat: number; lon: number };

const ICONS = {
  teleport: pinIcon("#2f88ff"),
  from: pinIcon("#34c759"),
  to: pinIcon("#d8443b"),
  live: pinIcon("#2f88ff", true),
};

function pinIcon(color: string, live = false): L.DivIcon {
  const size = live ? 14 : 18;
  const ring = live ? `box-shadow: 0 0 0 4px ${color}33, 0 0 0 8px ${color}11;` : `box-shadow: 0 2px 6px rgba(0,0,0,.6);`;
  const pulse = live ? "animation: livepulse 1.5s infinite;" : "";
  const html = `<div style="
    width:${size}px;height:${size}px;border-radius:50%;
    background:${color};border:3px solid #fff;${ring}${pulse}
  "></div>`;
  return L.divIcon({ html, className: "", iconSize: [size + 6, size + 6], iconAnchor: [(size + 6) / 2, (size + 6) / 2] });
}

const TILES = {
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: '&copy; OSM &copy; CARTO',
    subdomains: "abcd",
    maxZoom: 20,
  },
  light: {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: '&copy; OSM &copy; CARTO',
    subdomains: "abcd",
    maxZoom: 20,
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: 'Tiles &copy; Esri, Maxar, Earthstar Geographics',
    subdomains: "",
    maxZoom: 19,
  },
};

export type TileStyle = keyof typeof TILES;

export class MapView {
  private map!: L.Map;
  private tileLayer!: L.TileLayer;
  private pin: L.Marker | null = null;
  private fromPin: L.Marker | null = null;
  private toPin: L.Marker | null = null;
  private bluePin: L.Marker | null = null;
  private route: L.Polyline | null = null;
  private onClick: ((p: LatLon) => void) | null = null;

  constructor(private el: HTMLElement) {}

  async init(_token: string | null = null, center: LatLon = { lat: 40.7589, lon: -73.9851 }): Promise<void> {
    this.map = L.map(this.el, { zoomControl: true, attributionControl: true }).setView([center.lat, center.lon], 13);
    this.setTileStyle("dark");
    this.map.on("click", (e: L.LeafletMouseEvent) => {
      this.onClick?.({ lat: e.latlng.lat, lon: e.latlng.lng });
    });
  }

  setTileStyle(style: TileStyle): void {
    const cfg = TILES[style];
    if (this.tileLayer) this.map.removeLayer(this.tileLayer);
    this.tileLayer = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      subdomains: cfg.subdomains || "abc",
      maxZoom: cfg.maxZoom,
    }).addTo(this.map);
  }

  onMapClick(fn: (p: LatLon) => void): void { this.onClick = fn; }

  setPin(p: LatLon, kind: "teleport" | "from" | "to" = "teleport"): void {
    const m = L.marker([p.lat, p.lon], { icon: ICONS[kind] }).addTo(this.map);
    if (kind === "teleport") { this.pin && this.map.removeLayer(this.pin); this.pin = m; }
    else if (kind === "from") { this.fromPin && this.map.removeLayer(this.fromPin); this.fromPin = m; }
    else { this.toPin && this.map.removeLayer(this.toPin); this.toPin = m; }
  }

  clearRoute(): void {
    for (const m of [this.fromPin, this.toPin]) if (m) this.map.removeLayer(m);
    this.fromPin = this.toPin = null;
    if (this.route) { this.map.removeLayer(this.route); this.route = null; }
  }

  drawRoute(poly: LatLon[], color = "#2f88ff"): void {
    if (this.route) this.map.removeLayer(this.route);
    const latlngs = poly.map((p) => [p.lat, p.lon] as [number, number]);
    this.route = L.polyline(latlngs, { color, weight: 5, opacity: 0.85, lineCap: "round" }).addTo(this.map);
    this.map.fitBounds(this.route.getBounds(), { padding: [60, 60] });
  }

  centerOn(p: LatLon, zoom = 14): void {
    this.map.setView([p.lat, p.lon], zoom);
  }

  setLiveLocation(p: LatLon): void {
    if (!this.bluePin) {
      this.bluePin = L.marker([p.lat, p.lon], { icon: ICONS.live, zIndexOffset: 1000 }).addTo(this.map);
    } else {
      this.bluePin.setLatLng([p.lat, p.lon]);
    }
  }

  panToLive(p: LatLon): void {
    this.map.panTo([p.lat, p.lon], { animate: true, duration: 0.4 });
  }

  removeLiveLocation(): void {
    if (this.bluePin) { this.map.removeLayer(this.bluePin); this.bluePin = null; }
  }
}
