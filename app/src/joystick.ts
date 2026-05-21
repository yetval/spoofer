import nipplejs from "nipplejs";

export type Vec = { n: number; e: number };

export class Joystick {
  private nip: any;
  private keys = new Set<string>();
  private timer: number | null = null;
  private listener: ((v: Vec) => void) | null = null;
  private active = false;
  private speedMps = 3.0;

  constructor(private container: HTMLElement) {}

  mount(): void {
    this.nip = nipplejs.create({
      zone: this.container,
      mode: "static",
      position: { left: "50%", top: "50%" },
      color: "#2f88ff",
      size: 180,
    });
    this.nip.on("move", (_: unknown, data: any) => {
      const ang = data.angle.radian; // 0=east, pi/2=north
      const force = Math.min(data.force, 1);
      const n = Math.sin(ang) * force * this.speedMps;
      const e = Math.cos(ang) * force * this.speedMps;
      this.emit({ n, e });
    });
    this.nip.on("end", () => this.emit({ n: 0, e: 0 }));

    window.addEventListener("keydown", this.handleKey);
    window.addEventListener("keyup", this.handleKey);
    this.timer = window.setInterval(() => this.tick(), 80);
  }

  unmount(): void {
    this.nip?.destroy();
    window.removeEventListener("keydown", this.handleKey);
    window.removeEventListener("keyup", this.handleKey);
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  setSpeed(mps: number): void { this.speedMps = mps; }
  onVector(fn: (v: Vec) => void): void { this.listener = fn; }

  private handleKey = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    if (!"wasd".includes(k)) return;
    if (e.type === "keydown") this.keys.add(k);
    else this.keys.delete(k);
  };

  private tick(): void {
    if (this.keys.size === 0) return;
    let n = 0, e = 0;
    if (this.keys.has("w")) n += 1;
    if (this.keys.has("s")) n -= 1;
    if (this.keys.has("d")) e += 1;
    if (this.keys.has("a")) e -= 1;
    const mag = Math.hypot(n, e) || 1;
    this.emit({ n: (n / mag) * this.speedMps, e: (e / mag) * this.speedMps });
  }

  private emit(v: Vec): void {
    const moving = v.n !== 0 || v.e !== 0;
    if (!moving && !this.active) return;
    this.active = moving;
    this.listener?.(v);
  }
}
