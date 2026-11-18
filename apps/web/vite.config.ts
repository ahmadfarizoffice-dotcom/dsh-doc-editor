import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

/**
 * The client bundle imports the document model only (`@dsh-doc/core/model`).
 * `@dsh-doc/core` (the full package index) stays out of the bundle on purpose:
 * it re-exports adapters (docx/convert/render) that pull Node-only dependencies.
 */
export default defineConfig({
  root: here,
  plugins: [react()],
  resolve: {
    alias: {
      "@dsh-doc/core/model": path.resolve(
        repoRoot,
        "packages/core/src/model/index.ts",
      ),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // The HTTP API is hosted by the express server (see server/server.ts).
      "/api": {
        target: process.env.DSH_DOC_SERVER ?? "http://127.0.0.1:4317",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist-client",
    emptyOutDir: true,
    sourcemap: true,
  },
});
