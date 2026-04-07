import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Load `.env` from monorepo root (same file as API) — must use `VITE_` prefix for client. */
const monorepoRoot = resolve(__dirname, "../..");

export default defineConfig({
  envDir: monorepoRoot,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/oauth": "http://127.0.0.1:3001",
      "/webhooks": "http://127.0.0.1:3001",
    },
  },
});
