#!/usr/bin/env node
/**
 * Codex installer for the `dsh-doc` MCP server.
 *
 * Merges one `[mcp_servers.dsh-doc]` block into a Codex `config.toml`
 * (`$CODEX_HOME/config.toml` or `~/.codex/config.toml`):
 *
 *   - creates `~/.codex` when it is absent;
 *   - refuses to replace an existing `dsh-doc` block without `--force`;
 *   - prints a `+ added / - removed` summary before writing;
 *   - never rewrites, reorders or re-emits any other server's block (a
 *     post-merge assertion verifies the other `[mcp_servers.*]` content is
 *     byte-identical);
 *   - never installs packages, runs the server or touches the network.
 *
 * Usage (from the repository root):
 *
 *   node integrations/codex/install.mjs
 *   node integrations/codex/install.mjs --workspace C:\Users\me\Documents\dsh-docs
 *   node integrations/codex/install.mjs --read-only
 *   node integrations/codex/install.mjs --force
 *   node integrations/codex/install.mjs --print
 *   node integrations/codex/install.mjs --config C:\tmp\config.toml
 *
 * Exit codes: 0 written/unchanged, 1 refused or build missing, 2 usage error.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
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
} from "../shared/resolve-repo.mjs";

export const SERVER_KEY = "dsh-doc";
export const HEADER = `[mcp_servers.${SERVER_KEY}]`;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Thrown when a `dsh-doc` block already exists and `--force` was not passed. */
export class ExistingBlockError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ExistingBlockError";
    this.code = "EXISTING_DSH_DOC_BLOCK";
    this.details = details;
  }
}

/** Quote a TOML basic string. Paths are normalized to forward slashes first. */
export function tomlString(value) {
  const text = String(value).replace(/\\/g, "/");
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code < 0x20 || code === 0x7f) {
      throw new Error(
        "Refusing to write a path containing control characters into config.toml",
      );
    }
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

/** The exact block this installer owns. */
export function renderBlock({ mcpEntry, workspace, readOnly = false }) {
  return [
    HEADER,
    'command = "node"',
    `args = [${tomlString(mcpEntry)}]`,
    `env = { DSH_DOC_WORKSPACE = ${tomlString(workspace)}, DSH_DOC_READ_ONLY = ${tomlString(
      readOnly ? "1" : "0",
    )} }`,
  ].join("\n");
}

const DSH_DOC_NAME = String.raw`(?:dsh-doc|"dsh-doc"|'dsh-doc')`;
const HEADER_RE = new RegExp(
  String.raw`^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*${DSH_DOC_NAME}[ \t]*\][ \t]*(?:#.*)?$`,
);
const OUR_ANY_TABLE_RE = new RegExp(
  String.raw`^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*${DSH_DOC_NAME}[ \t]*[.\]]`,
);
const ANY_TABLE_RE = /^[ \t]*\[/;

/**
 * Locate the `dsh-doc` table plus any of its sub-tables.
 * Returns `{ start, end }` as half-open line indices, or null.
 */
export function findBlock(lines) {
  const start = lines.findIndex((line) => HEADER_RE.test(line));
  if (start === -1) return null;

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (ANY_TABLE_RE.test(line) && !OUR_ANY_TABLE_RE.test(line)) break;
    end += 1;
  }
  while (end > start + 1 && lines[end - 1].trim() === "") end -= 1;
  return { start, end };
}

/** Remove every managed `dsh-doc` block so the rest of the file can be compared. */
export function stripManagedBlocks(lines) {
  const kept = [];
  let index = 0;
  while (index < lines.length) {
    const block = findBlock(lines.slice(index));
    if (!block) {
      kept.push(...lines.slice(index));
      break;
    }
    kept.push(...lines.slice(index, index + block.start));
    index += block.end;
  }
  return kept;
}

/** Merge the managed block into config text. Pure: no filesystem access. */
export function mergeConfig(existing, block, { force = false } = {}) {
  const normalized = String(existing ?? "").replace(/\r\n/g, "\n");
  const eol = /\r\n/.test(String(existing ?? "")) ? "\r\n" : "\n";
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const blockLines = block.trimEnd().split("\n");
  const found = findBlock(lines);
  // Compare everything outside the managed block, ignoring only trailing blank
  // lines (appending legitimately adds one blank separator).
  const outside = (values) =>
    stripManagedBlocks(values).join("\n").replace(/\n+$/, "");
  const before = outside(lines);

  let next;
  let action;
  let oldLines = [];

  if (found) {
    oldLines = lines.slice(found.start, found.end);
    const identical =
      oldLines.length === blockLines.length &&
      oldLines.every((line, index) => line === blockLines[index]);
    if (identical && !force) {
      return {
        text: lines.join(eol) + eol,
        action: "unchanged",
        oldLines,
        newLines: blockLines,
      };
    }
    if (!force) {
      throw new ExistingBlockError(
        [
          `A ${HEADER} block already exists in the target config.`,
          "",
          ...oldLines.map((line) => `  ${line}`),
          "",
          "Nothing was written. Re-run with --force to replace exactly this block,",
          "or remove it by hand and run the installer again.",
        ].join("\n"),
        { existingLines: oldLines, header: HEADER },
      );
    }
    action = identical ? "unchanged" : "replaced";

    // Rebuild the file, dropping every managed block and inserting this one at
    // the position of the first, so a duplicated block cannot survive.
    const rebuilt = [];
    let inserted = false;
    let index = 0;
    while (index < lines.length) {
      const block = findBlock(lines.slice(index));
      if (!block) {
        rebuilt.push(...lines.slice(index));
        break;
      }
      rebuilt.push(...lines.slice(index, index + block.start));
      if (!inserted) {
        rebuilt.push(...blockLines);
        inserted = true;
      }
      index += block.end;
    }
    next = rebuilt;
  } else {
    action = "appended";
    const prefix = [...lines];
    while (prefix.length > 0 && prefix[prefix.length - 1] === "") prefix.pop();
    next = prefix.length > 0 ? [...prefix, "", ...blockLines] : [...blockLines];
  }

  const after = outside(next);
  if (before !== after) {
    throw new Error(
      "Refusing to write: the merge would have modified content outside the dsh-doc block",
    );
  }

  return {
    text: next.join(eol) + eol,
    action,
    oldLines,
    newLines: blockLines,
  };
}

/** `name -> block text` for every `[mcp_servers.<name>]` table except dsh-doc. */
export function listOtherServerHeaders(lines) {
  const names = [];
  for (const line of lines) {
    if (OUR_ANY_TABLE_RE.test(line)) continue;
    const match = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*([^\]\s]+)/.exec(
      line,
    );
    if (match) names.push(match[1]);
  }
  return names;
}

/** Human-readable, non-unified diff of the managed block. */
export function formatSummary({ action, oldLines = [], newLines = [] }) {
  const out = [`action: ${action}`];
  if (action === "unchanged") {
    out.push("  = the [mcp_servers.dsh-doc] block is already current");
    return out.join("\n");
  }
  if (oldLines.length > 0) {
    for (const line of oldLines) out.push(`  - ${line}`);
  } else {
    out.push("  - (no existing [mcp_servers.dsh-doc] block)");
  }
  for (const line of newLines) out.push(`  + ${line}`);
  out.push(
    "(summary only, not a unified diff; every other server is untouched)",
  );
  return out.join("\n");
}

/** Resolve the Codex config file without reading it. */
export function resolveConfigPath({
  config,
  env = process.env,
  home = os.homedir(),
} = {}) {
  if (typeof config === "string" && config.trim().length > 0) {
    return path.resolve(config.trim());
  }
  const codexHome =
    typeof env.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  if (codexHome) return path.join(path.resolve(codexHome), "config.toml");
  return path.join(home, ".codex", "config.toml");
}

/** Read, merge and (unless dryRun) write the config. */
export async function installConfig({
  configPath,
  block,
  force = false,
  dryRun = false,
}) {
  const existed = existsSync(configPath);
  const existing = existed ? await readFile(configPath, "utf8") : "";
  const merged = mergeConfig(existing, block, { force });
  const summary = formatSummary(merged);

  if (merged.action === "unchanged" || dryRun) {
    return { configPath, existed, ...merged, summary, written: false };
  }

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, merged.text, "utf8");
  return { configPath, existed, ...merged, summary, written: true };
}

const HELP = `Codex installer for the dsh-doc MCP server

Usage: node integrations/codex/install.mjs [options]

Options:
  --config <path>       Target config.toml (default: $CODEX_HOME/config.toml
                        or ~/.codex/config.toml)
  --workspace <path>    DSH_DOC_WORKSPACE value (default: <repo>/.workspace)
  --repo <path>         Repository root (default: resolved from this script)
  --read-only           Write DSH_DOC_READ_ONLY = "1"
  --force               Replace an existing [mcp_servers.dsh-doc] block
  --print               Print the block and exit without writing
  --help                Show this help

The installer only adds or replaces the [mcp_servers.dsh-doc] block. It never
modifies another server's table and never runs pnpm, npm or the MCP server.
`;

function parseFlags(argv) {
  const flags = {
    config: undefined,
    workspace: undefined,
    repo: undefined,
    readOnly: false,
    force: false,
    print: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${token} requires a value`);
      }
      index += 1;
      return next;
    };
    if (token === "--config") flags.config = value();
    else if (token === "--workspace") flags.workspace = value();
    else if (token === "--repo") flags.repo = value();
    else if (token === "--read-only") flags.readOnly = true;
    else if (token === "--force") flags.force = true;
    else if (token === "--print") flags.print = true;
    else if (token === "--help" || token === "-h") flags.help = true;
    else throw new Error(`Unknown option: ${token}`);
  }
  return flags;
}

async function main() {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`);
    return 2;
  }
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let repoRoot;
  try {
    repoRoot = flags.repo
      ? findRepoRoot(path.resolve(flags.repo))
      : findRepoRoot(HERE);
  } catch (error) {
    if (error instanceof RepoRootError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  let mcpEntry;
  try {
    mcpEntry = assertBuild(repoRoot, MCP_ENTRY, "dsh-doc MCP server");
  } catch (error) {
    if (error instanceof BuildMissingError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const configPath = resolveConfigPath({ config: flags.config });
  const workspace = flags.workspace
    ? path.resolve(flags.workspace)
    : resolveWorkspace(repoRoot);
  const block = renderBlock({
    mcpEntry,
    workspace,
    readOnly: flags.readOnly || process.env.DSH_DOC_READ_ONLY === "1",
  });

  if (flags.print) {
    process.stdout.write(
      `# target: ${configPath}\n${block}\n\n# workspace: ${workspace}\n`,
    );
    return 0;
  }

  try {
    const result = await installConfig({
      configPath,
      block,
      force: flags.force,
    });
    process.stdout.write(
      [
        "dsh-doc Codex installer",
        `  config:    ${result.configPath}`,
        `  existed:   ${result.existed ? "yes" : "no (created)"}`,
        `  workspace: ${workspace}`,
        "",
        result.summary,
        "",
        result.written
          ? "Written. Restart Codex (or start a new session) to load the server."
          : "Nothing to write: the block is already current.",
      ].join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    if (error instanceof ExistingBlockError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    process.stderr.write(
      `dsh-doc Codex installer failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `dsh-doc Codex installer crashed: ${error?.stack ?? error}\n`,
      );
      process.exitCode = 1;
    },
  );
}
