import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("spoofer", {
  backendPort: () => ipcRenderer.invoke("backend:port") as Promise<number>,
  tunnelStatus: () => ipcRenderer.invoke("tunnel:status") as Promise<"up" | "down">,
  startTunnel: () => ipcRenderer.invoke("tunnel:start") as Promise<string>,
});
