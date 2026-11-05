import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = "http://127.0.0.1:8000";
// changeOrigin must stay off: the fixture backend compares the browser Origin with
// the Host it receives, exactly as the deployed Function compares it with the site URL.
// /storage/v1 carries the signed upload and download URLs the Function hands out, so the
// browser PUT has to reach the fixture just like it reaches the gateway when deployed.
const proxy = { "/functions/v1/app": { target, changeOrigin: false }, "/storage/v1": { target, changeOrigin: false } };

// A GitHub Pages *project* site lives under /<repo>/, so every asset URL has to carry that
// prefix or the page loads with a 404 stylesheet. Anywhere else — a custom domain at the root,
// a Qoder Site, the local dev server — the app owns "/" and nothing changes.
// VITE_BASE wins when someone wants to override the guess explicitly.
const pagesRepo = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.VITE_BASE ?? (process.env.GITHUB_ACTIONS === "true" && pagesRepo ? `/${pagesRepo}/` : "/");

export default defineConfig({
  base,
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: { host: "127.0.0.1", proxy },
  preview: { host: "127.0.0.1", proxy },
  build: { outDir: "dist" },
});
