import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  // `pnpm --filter @breakfix/web dev` talks to a server started with `pnpm server`.
  server: { proxy: { "/api": { target: "http://127.0.0.1:8480", ws: true } } },
});
