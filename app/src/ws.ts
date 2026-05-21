export type Msg =
  | { type: "ready" }
  | { type: "state"; lat: number; lon: number }
  | { type: "progress"; lat: number; lon: number; mode: string;
      doneM: number; totalM: number; speedMps: number; etaS: number; bearingDeg: number }
  | { type: "pong" }
  | { type: "error"; message: string };

export class Backend {
  private sock: WebSocket | null = null;
  private onMsg: ((m: Msg) => void) | null = null;
  private onStatus: ((up: boolean) => void) | null = null;
  private url: string;

  constructor(port: number) {
    this.url = `ws://127.0.0.1:${port}/ws`;
  }

  connect(): void {
    this.sock = new WebSocket(this.url);
    this.sock.onopen = () => this.onStatus?.(true);
    this.sock.onclose = () => {
      this.onStatus?.(false);
      setTimeout(() => this.connect(), 1500);
    };
    this.sock.onerror = () => this.onStatus?.(false);
    this.sock.onmessage = (e) => this.onMsg?.(JSON.parse(e.data));
  }

  onMessage(fn: (m: Msg) => void): void { this.onMsg = fn; }
  onStatusChange(fn: (up: boolean) => void): void { this.onStatus = fn; }

  send(obj: Record<string, unknown>): void {
    if (this.sock?.readyState === WebSocket.OPEN) {
      this.sock.send(JSON.stringify(obj));
    } else {
      console.warn("[spoofer] WS send skipped, state=", this.sock?.readyState, obj);
    }
  }
}
