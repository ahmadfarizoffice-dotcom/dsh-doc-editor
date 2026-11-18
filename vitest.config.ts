import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const core = path.resolve(root, "packages/core/src");
const subpath =
  /^@dsh-doc\/core\/(model|docx|formats|layout|render|convert|service|ai|tools)$/;

export default defineConfig({
  resolve: {
    alias: [
      {
        find: subpath,
        replacement: path.join(core, "$1/index.ts"),
      },
      {
        find: "@dsh-doc/core",
        replacement: path.resolve(core, "index.ts"),
      },
    ],
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.scratch/**"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    reporters: ["default"],
  },
});
