import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  root: resolve(__dirname, "src"),
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist-renderer"),
    emptyOutDir: true,
  },
  // Bind to IPv4 explicitly: on Windows "localhost" can resolve to IPv6 (::1), but the dev
  // launcher's wait-on and Electron's loadURL both use 127.0.0.1. Aligning them ensures the
  // Electron window actually loads the renderer.
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
