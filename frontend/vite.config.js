import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// The built app is served by Flask from mpro/static/app. In dev, Vite proxies the API.
export default defineConfig({
    plugins: [react()],
    build: { outDir: "../mpro/static/app", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
    // MPRO_API / VITE_PORT let several dev servers run side by side (e.g. MPRO_API=http://127.0.0.1:8091 VITE_PORT=5191)
    server: {
        port: Number(process.env.VITE_PORT || 5173),
        proxy: {
            "/api": process.env.MPRO_API || "http://127.0.0.1:8080",
            "/healthz": process.env.MPRO_API || "http://127.0.0.1:8080",
        },
    },
});
