#!/usr/bin/env node
/**
 * Shared repository resolver and build check for the dsh-doc integrations.
 *
 * Every host integration (Claude Code, Codex, Antigravity, OpenCode and the
 * shared CLI bridge) needs the same three facts:
 *
 *   1. where the `dsh-doc-editor` checkout lives,
 *   2. whether the build outputs it launches exist, and
 *   3. which workspace directory to hand to the MCP server.
 *
 * This module answers those questions. It never builds, installs, downloads or
 * spawns anything: callers print its diagnostics and exit with their own status.
 *
 * Run it directly for a JSON status report:
 *
 *   node integrations/shared/resolve-repo.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Repository-relative paths of the build outputs the integrations launch. */
export const MCP_ENTRY = "apps/mcp/dist/main.js";
export const CLI_ENTRY = "apps/cli/dist/main.js";
export const WEB_ENTRY = "apps/web/dist-server/server.js";

/** How many parent directories to inspect before giving up. */
const MAX_WALK_UP = 16;

const BUILD_TARGETS = {
  [MCP_ENTRY]: "pnpm --filter @dsh-doc/mcp build",
  [CLI_ENTRY]: "pnpm --filter @dsh-doc/cli build",
  [WEB_ENTRY]: "pnpm --filter @dsh-doc/web build",
};

/** Thrown when the repository root cannot be located. */
export class RepoRootError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RepoRootError";
    this.code = "REPO_ROOT_NOT_FOUND";
    this.details = details;
  }
}

/** Thrown when a required build output is missing. */
export class BuildMissingError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "BuildMissingError";
    this.code = "BUILD_MISSING";
    this.details = details;
  }
}

function readPackageJson(directory) {
  const file = path.join(directory, "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * True when `directory` looks like the dsh-doc-editor checkout root: a
 * package.json, a workspace declaration (pnpm-workspace.yaml or a
 * `workspaces` field) and the MCP app package. The MCP app check keeps the
 * resolver from stopping at an unrelated parent monorepo.
 */
export function isRepoRoot(directory) {
  const resolved = path.resolve(directory);
  const manifest = readPackageJson(resolved);
  if (!manifest) return false;
  const hasWorkspaceFile = existsSync(
    path.join(resolved, "pnpm-workspace.yaml"),
  );
  const declaresWorkspaces = manifest.workspaces !== undefined;
  if (!hasWorkspaceFile && !declaresWorkspaces) return false;
  return existsSync(path.join(resolved, "apps", "mcp", "package.json"));
}

/**
 * Walk up from `startDirectory` looking for the checkout root.
 *
 * `DSH_DOC_REPO` short-circuits the walk when it points at a valid root, which
 * is useful when the plugin directory has been copied away from the checkout.
 */
export function findRepoRoot(
  startDirectory = process.cwd(),
  env = process.env,
) {
  const override =
    typeof env.DSH_DOC_REPO === "string" ? env.DSH_DOC_REPO.trim() : "";
  if (override) {
    const resolved = path.resolve(override);
    if (isRepoRoot(resolved)) return resolved;
    throw new RepoRootError(
      [
        `DSH_DOC_REPO is set to ${resolved}, but that is not the dsh-doc-editor repository root.`,
        "Expected a package.json, a pnpm-workspace.yaml (or workspaces field) and apps/mcp/package.json.",
        "Unset DSH_DOC_REPO or point it at the checkout.",
      ].join("\n"),
      { startDirectory: path.resolve(startDirectory), checked: resolved },
    );
  }

  const checked = [];
  let current = path.resolve(startDirectory);
  for (let depth = 0; depth <= MAX_WALK_UP; depth += 1) {
    checked.push(current);
    if (isRepoRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new RepoRootError(
    [
      `dsh-doc: could not locate the dsh-doc-editor repository root from:`,
      `  ${path.resolve(startDirectory)}`,
      "",
      "Looked for a directory containing package.json, pnpm-workspace.yaml",
      "(or a workspaces field) and apps/mcp/package.json.",
      "",
      "Fix one of the following:",
      "  - clone the repository and copy this integration from inside it;",
      "  - set DSH_DOC_REPO to the absolute path of the checkout;",
      "  - run the integration from inside the checkout.",
    ].join("\n"),
    { startDirectory: path.resolve(startDirectory), checked },
  );
}

/** Absolute path of the built MCP stdio server. */
export function mcpEntryPath(repoRoot) {
  return path.resolve(repoRoot, MCP_ENTRY);
}

/** Absolute path of the built CLI. */
export function cliEntryPath(repoRoot) {
  return path.resolve(repoRoot, CLI_ENTRY);
}

/** Absolute path of the built editor HTTP server. */
export function webEntryPath(repoRoot) {
  return path.resolve(repoRoot, WEB_ENTRY);
}

/**
 * Human-readable, copy-pasteable build instruction for one missing output.
 * The caller decides how to surface it; nothing is built here.
 */
export function formatBuildHint(repoRoot, relativeEntry = MCP_ENTRY) {
  const root = path.resolve(repoRoot);
  const entry = path.resolve(root, relativeEntry);
  const build = BUILD_TARGETS[relativeEntry] ?? `pnpm --filter <package> build`;
  return [
    `dsh-doc: required build output is missing: ${relativeEntry}`,
    "",
    `  repository: ${root}`,
    `  expected:   ${entry}`,
    "",
    "Build it from the repository root, then retry:",
    "",
    "  pnpm install",
    `  ${build}`,
    "",
    "To build every artifact at once: pnpm run build",
    "Nothing was installed or built automatically.",
  ].join("\n");
}

/** Returns the absolute entry path or throws a BuildMissingError. */
export function assertBuild(
  repoRoot,
  relativeEntry = MCP_ENTRY,
  label = "dsh-doc",
) {
  const entry = path.resolve(repoRoot, relativeEntry);
  if (!existsSync(entry)) {
    throw new BuildMissingError(formatBuildHint(repoRoot, relativeEntry), {
      label,
      repoRoot: path.resolve(repoRoot),
      relativeEntry,
      entry,
    });
  }
  return entry;
}

/**
 * Workspace handed to the MCP server: `DSH_DOC_WORKSPACE` when set, otherwise
 * `<repo>/.workspace` (git-ignored, created by the server on first start).
 */
export function resolveWorkspace(repoRoot, env = process.env) {
  const configured =
    typeof env.DSH_DOC_WORKSPACE === "string"
      ? env.DSH_DOC_WORKSPACE.trim()
      : "";
  if (configured) return path.resolve(configured);
  return path.join(path.resolve(repoRoot), ".workspace");
}

/** Resolved existence facts for the integrations, without running anything. */
export function buildStatus(repoRoot) {
  const root = path.resolve(repoRoot);
  const entry = (relativeEntry) => {
    const absolute = path.resolve(root, relativeEntry);
    return { relativeEntry, path: absolute, exists: existsSync(absolute) };
  };
  return {
    repoRoot: root,
    workspace: resolveWorkspace(root),
    mcp: entry(MCP_ENTRY),
    cli: entry(CLI_ENTRY),
    web: entry(WEB_ENTRY),
  };
}

function main() {
  let repoRoot;
  try {
    repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(buildStatus(repoRoot), null, 2)}\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = main();
}
