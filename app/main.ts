import { app, BrowserWindow, ipcMain, session } from "electron";
import { spawn, ChildProcess, execFile } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";

const DEV = !app.isPackaged;
const isWin = process.platform === "win32";
const BACKEND_PORT = 8765;
const TUNNELD_URL = "http://127.0.0.1:49151";

const backendDir = DEV
  ? resolve(__dirname, "..", "..", "backend")
  : join(process.resourcesPath, "backend");
const scriptsDir = DEV
  ? resolve(__dirname, "..", "..", "scripts")
  : join(process.resourcesPath, "scripts");

let backendProc: ChildProcess | null = null;
let tunneldProc: ChildProcess | null = null;
let win: BrowserWindow | null = null;

async function tunnelUp(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(TUNNELD_URL + "/", { signal: ctl.signal });
    clearTimeout(t);
    return r.status < 500;
  } catch {
    return false;
  }
}

async function ensureTunneld(): Promise<"already" | "started" | "denied"> {
  if (await tunnelUp()) return "already";
  return new Promise((resolveP) => {
    if (isWin) {
      // Elevate via UAC: Start-Process the PowerShell launcher with -Verb RunAs.
      const script = join(scriptsDir, "start-tunneld.ps1");
      const inner = `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script}'`;
      tunneldProc = execFile(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", inner],
        (err) => {
          if (err) resolveP("denied");
        }
      );
    } else {
      // macOS: osascript prompts for admin and runs the bash launcher.
      const script = join(scriptsDir, "start-tunneld.sh");
      const osa = `do shell script "bash ${script.replace(/"/g, '\\"')}" with administrator privileges`;
      tunneldProc = execFile("osascript", ["-e", osa], (err) => {
        if (err) resolveP("denied");
      });
    }
    const t0 = Date.now();
    const poll = setInterval(async () => {
      if (await tunnelUp()) {
        clearInterval(poll);
        resolveP("started");
      } else if (Date.now() - t0 > 15000) {
        clearInterval(poll);
        resolveP("denied");
      }
    }, 500);
  });
}

function spawnBackend(): void {
  if (backendProc) return;
  const venvPy = isWin
    ? join(backendDir, ".venv", "Scripts", "python.exe")
    : join(backendDir, ".venv", "bin", "python");
  const py = existsSync(venvPy) ? venvPy : isWin ? "python" : "python3";
  backendProc = spawn(
    py,
    ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)],
    { cwd: backendDir, stdio: "inherit", env: { ...process.env, PYTHONUNBUFFERED: "1" } }
  );
  backendProc.on("exit", (code) => {
    console.error("backend exited", code);
    backendProc = null;
  });
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (DEV) {
    await win.loadURL("http://127.0.0.1:5173");
  } else {
    await win.loadFile(join(__dirname, "..", "dist-renderer", "index.html"));
  }
}

ipcMain.handle("backend:port", () => BACKEND_PORT);
ipcMain.handle("tunnel:status", async () => ((await tunnelUp()) ? "up" : "down"));
ipcMain.handle("tunnel:start", () => ensureTunneld());

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, callback) => {
    callback(perm === "geolocation" || perm === "media" || perm === "notifications");
  });
  if (!DEV) {
    // Packaged app: launch tunneld + backend ourselves.
    await ensureTunneld();
    spawnBackend();
  }
  // Dev: dev.sh already owns tunneld + backend. Skip to avoid :8765 collision.
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (backendProc) backendProc.kill();
});
