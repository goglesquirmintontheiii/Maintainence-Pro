import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The built app is served by Flask from mpro/static/app. In dev, Vite proxies the API.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../mpro/static/app", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/healthz": "http://127.0.0.1:8080",
    },
  },
});
