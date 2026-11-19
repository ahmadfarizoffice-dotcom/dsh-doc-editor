#!/usr/bin/env node
/**
 * Claude Code plugin launcher for the dsh-doc MCP server.
 *
 * `.mcp.json` starts this script with `node`. It:
 *
 *   1. resolves the dsh-doc-editor checkout from this plugin directory
 *      (walking up to pnpm-workspace.yaml + apps/mcp/package.json),
 *   2. refuses to start when `apps/mcp/dist/main.js` has not been built,
 *      printing the exact build command on stderr (it never builds or
 *      installs anything),
 *   3. exports `DSH_DOC_WORKSPACE` (existing value, else `<repo>/.workspace`),
 *   4. loads the built stdio server in this process so stdin/stdout are the
 *      protocol streams with no wrapper process in between.
 *
 * Diagnostics go to stderr only: stdout belongs to the MCP protocol.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertBuild,
  BuildMissingError,
  findRepoRoot,
  MCP_ENTRY,
  RepoRootError,
  resolveWorkspace,
} from "../../shared/resolve-repo.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");

function fail(message) {
  process.stderr.write(`${message}\n`);
  return 1;
}

async function main() {
  let repoRoot;
  try {
    repoRoot = findRepoRoot(PLUGIN_ROOT);
  } catch (error) {
    if (error instanceof RepoRootError) return fail(error.message);
    throw error;
  }

  let entry;
  try {
    entry = assertBuild(repoRoot, MCP_ENTRY, "dsh-doc MCP server");
  } catch (error) {
    if (error instanceof BuildMissingError) return fail(error.message);
    throw error;
  }

  const workspace = resolveWorkspace(repoRoot);
  process.env.DSH_DOC_WORKSPACE = workspace;

  process.stderr.write(
    [
      "dsh-doc: starting MCP server",
      `  entry:     ${entry}`,
      `  workspace: ${workspace}`,
      `  read-only: ${process.env.DSH_DOC_READ_ONLY === "1" ? "yes" : "no"}`,
    ].join("\n") + "\n",
  );

  try {
    await import(pathToFileURL(entry).href);
  } catch (error) {
    const cause =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    return fail(
      [
        "dsh-doc: the MCP server failed to load.",
        `  entry: ${entry}`,
        `  cause: ${cause}`,
        "",
        "If this checkout was just cloned, its dependencies are not installed yet.",
        "From the repository root, run:",
        "",
        "  pnpm install",
        "  pnpm --filter @dsh-doc/mcp build",
      ].join("\n"),
    );
  }

  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.exitCode = fail(
    `dsh-doc: unexpected launcher failure: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }`,
  );
}
