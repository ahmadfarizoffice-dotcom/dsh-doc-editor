import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

/**
 * The repository root vitest config only aliases `@dsh-doc/core`. The web app
 * imports the model subpath (`@dsh-doc/core/model`), so the same alias used by
 * Vite and by tsconfig is repeated here:
 *
 *   vitest run --root apps/web
 *   pnpm --filter @dsh-doc/web test
 */
export default defineConfig({
  resolve: {
    alias: {
      "@dsh-doc/core/model": path.resolve(
        repoRoot,
        "packages/core/src/model/index.ts",
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    pool: "forks",
    reporters: ["default"],
  },
});
