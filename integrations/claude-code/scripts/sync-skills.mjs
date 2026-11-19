#!/usr/bin/env node
/**
 * Copies the canonical skill pack (`<repo>/skills`) into this Claude Code
 * plugin (`integrations/claude-code/skills`).
 *
 * Claude Code discovers plugin skills as `skills/<name>/SKILL.md`, and plugin
 * directories must not rely on symlinks, so the 12 skills are committed as
 * real copies. Run this after editing anything under `<repo>/skills`:
 *
 *   node integrations/claude-code/scripts/sync-skills.mjs
 *   node integrations/claude-code/scripts/sync-skills.mjs --check   # CI
 *
 * The script only writes inside `<plugin>/skills`. It validates every source
 * skill (frontmatter + matching name) before copying and removes stale skill
 * directories that no longer exist upstream. Exit codes: 0 synced/in sync,
 * 1 drift (with `--check`) or validation failure.
 */
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { findRepoRoot, RepoRootError } from "../../shared/resolve-repo.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const SKILL_FILE = "SKILL.md";

function parseFlags(argv) {
  const flags = { check: false, dryRun: false, repo: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") flags.check = true;
    else if (token === "--dry-run") flags.dryRun = true;
    else if (token === "--repo") {
      flags.repo = argv[index + 1];
      index += 1;
    } else if (token === "--help" || token === "-h") flags.help = true;
    else if (token.startsWith("--")) {
      process.stderr.write(`Unknown option: ${token}\n`);
      process.exitCode = 2;
      return null;
    }
  }
  return flags;
}

const HELP = `Usage: node integrations/claude-code/scripts/sync-skills.mjs [options]

Copies <repo>/skills/<name>/SKILL.md into <plugin>/skills/<name>/SKILL.md.

Options:
  --check      Verify the copies are byte-identical; do not write. Exit 1 on drift.
  --dry-run    Report what would change; do not write.
  --repo <p>   Repository root (default: resolved by walking up from this script).
  --help       Show this help.
`;

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function listSourceSkills(sourceRoot) {
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!(await exists(path.join(sourceRoot, entry.name, SKILL_FILE))))
      continue;
    const body = await readFile(
      path.join(sourceRoot, entry.name, SKILL_FILE),
      "utf8",
    );
    if (!body.startsWith("---\n")) {
      throw new Error(
        `${entry.name}/${SKILL_FILE} does not start with YAML frontmatter`,
      );
    }
    const declared = /^name:\s*(.+)$/m.exec(body.split("\n---")[0]);
    if (!declared || declared[1].trim() !== entry.name) {
      throw new Error(
        `${entry.name}/${SKILL_FILE} declares name=${declared?.[1]?.trim() ?? "(missing)"}, expected ${entry.name}`,
      );
    }
    names.push(entry.name);
  }
  names.sort();
  if (names.length === 0) throw new Error(`No skills found in ${sourceRoot}`);
  return names;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags) return 2;
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let repoRoot;
  try {
    repoRoot = flags.repo
      ? path.resolve(flags.repo)
      : findRepoRoot(PLUGIN_ROOT);
  } catch (error) {
    if (error instanceof RepoRootError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const sourceRoot = path.join(repoRoot, "skills");
  const targetRoot = path.join(PLUGIN_ROOT, "skills");

  let names;
  try {
    names = await listSourceSkills(sourceRoot);
  } catch (error) {
    process.stderr.write(`sync-skills: ${error.message}\n`);
    return 1;
  }

  const added = [];
  const updated = [];
  const unchanged = [];
  const removed = [];

  const existing = (await exists(targetRoot))
    ? (await readdir(targetRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .map((entry) => entry.name)
    : [];

  for (const name of existing) {
    if (!names.includes(name)) removed.push(name);
  }

  for (const name of names) {
    const sourceFile = path.join(sourceRoot, name, SKILL_FILE);
    const targetFile = path.join(targetRoot, name, SKILL_FILE);
    const sourceBytes = await readFile(sourceFile);
    const targetExists = await exists(targetFile);
    if (targetExists) {
      const targetBytes = await readFile(targetFile);
      if (sourceBytes.equals(targetBytes)) {
        unchanged.push(name);
        continue;
      }
      updated.push(name);
    } else {
      added.push(name);
    }
    if (!flags.check && !flags.dryRun) {
      await mkdir(path.dirname(targetFile), { recursive: true });
      await writeFile(targetFile, sourceBytes);
    }
  }

  if (removed.length > 0 && !flags.check && !flags.dryRun) {
    for (const name of removed) {
      await rm(path.join(targetRoot, name), { recursive: true, force: true });
    }
  }

  const changed = added.length + updated.length + removed.length;
  const report = [
    `sync-skills: ${names.length} source skill(s) in ${sourceRoot}`,
    `  target:   ${targetRoot}`,
    `  added:    ${added.length}${added.length ? ` (${added.join(", ")})` : ""}`,
    `  updated:  ${updated.length}${updated.length ? ` (${updated.join(", ")})` : ""}`,
    `  removed:  ${removed.length}${removed.length ? ` (${removed.join(", ")})` : ""}`,
    `  unchanged:${unchanged.length ? ` ${unchanged.length}` : " 0"}`,
  ];

  if (flags.check) {
    report.push(
      changed === 0
        ? "  result:   in sync"
        : "  result:   DRIFT — run node integrations/claude-code/scripts/sync-skills.mjs",
    );
    process.stdout.write(`${report.join("\n")}\n`);
    return changed === 0 ? 0 : 1;
  }

  report.push(
    flags.dryRun
      ? "  result:   dry run, nothing written"
      : "  result:   synced",
  );
  process.stdout.write(`${report.join("\n")}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `sync-skills: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}
