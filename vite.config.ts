import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = "http://127.0.0.1:8000";
// changeOrigin must stay off: the fixture backend compares the browser Origin with
// the Host it receives, exactly as the deployed Function compares it with the site URL.
// /storage/v1 carries the signed upload and download URLs the Function hands out, so the
// browser PUT has to reach the fixture just like it reaches the gateway when deployed.
const proxy = { "/functions/v1/app": { target, changeOrigin: false }, "/storage/v1": { target, changeOrigin: false } };

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: { host: "127.0.0.1", proxy },
  preview: { host: "127.0.0.1", proxy },
  build: { outDir: "dist" },
});
