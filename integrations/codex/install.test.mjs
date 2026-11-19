/**
 * Tests for the Codex installer merge logic.
 *
 * Run with Node's built-in runner (no network, no pnpm):
 *
 *   node --test integrations/codex/install.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ExistingBlockError,
  findBlock,
  formatSummary,
  installConfig,
  listOtherServerHeaders,
  mergeConfig,
  renderBlock,
  resolveConfigPath,
  stripManagedBlocks,
  tomlString,
} from "./install.mjs";

const MCP_ENTRY = "C:\\Users\\me\\dsh-doc-editor\\apps\\mcp\\dist\\main.js";
const WORKSPACE = "C:\\Users\\me\\Documents\\dsh-docs";

function block(overrides = {}) {
  return renderBlock({
    mcpEntry: MCP_ENTRY,
    workspace: WORKSPACE,
    readOnly: false,
    ...overrides,
  });
}

async function withTempDir(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-doc-codex-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("tomlString normalizes Windows paths and escapes quotes", () => {
  assert.equal(tomlString("C:\\Users\\me\\a b"), '"C:/Users/me/a b"');
  assert.equal(tomlString('a"b'), '"a\\"b"');
  assert.throws(() => tomlString("bad\npath"), /control characters/);
});

test("renderBlock emits the documented Codex table shape", () => {
  const text = block();
  const lines = text.split("\n");
  assert.equal(lines[0], "[mcp_servers.dsh-doc]");
  assert.equal(lines[1], 'command = "node"');
  assert.match(
    lines[2],
    /^args = \["C:\/Users\/me\/dsh-doc-editor\/apps\/mcp\/dist\/main\.js"\]$/,
  );
  assert.match(
    lines[3],
    /^env = \{ DSH_DOC_WORKSPACE = "C:\/Users\/me\/Documents\/dsh-docs", DSH_DOC_READ_ONLY = "0" \}$/,
  );
});

test("findBlock locates the table and its sub-tables, stopping at the next table", () => {
  const lines = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.dsh-doc]",
    'command = "node"',
    "",
    "[mcp_servers.dsh-doc.env]",
    'DSH_DOC_READ_ONLY = "1"',
    "",
    "[mcp_servers.other]",
    'command = "npx"',
  ];
  const found = findBlock(lines);
  assert.deepEqual(found, { start: 2, end: 7 });
  assert.equal(stripManagedBlocks(lines).join("\n").includes("dsh-doc"), false);
});

test("mergeConfig appends one block to an empty file", () => {
  const result = mergeConfig("", block());
  assert.equal(result.action, "appended");
  assert.equal(result.text, `${block()}\n`);
});

test("mergeConfig preserves every other server and profile", () => {
  const existing = [
    "# my config",
    'model = "gpt-5"',
    "",
    "[mcp_servers.other]",
    'command = "npx"',
    'args = ["-y", "other-server"]',
    "",
    "[profiles.fast]",
    'model = "gpt-5-mini"',
    "",
  ].join("\n");

  const result = mergeConfig(existing, block());
  assert.equal(result.action, "appended");
  assert.match(
    result.text,
    /\[mcp_servers\.other\]\ncommand = "npx"\nargs = \["-y", "other-server"\]\n\n\[profiles\.fast\]\nmodel = "gpt-5-mini"/,
  );
  assert.equal(result.text.split("[mcp_servers.dsh-doc]").length, 2);
  const names = listOtherServerHeaders(result.text.split("\n"));
  assert.deepEqual(names, ["other"]);
});

test("mergeConfig is idempotent for an identical block", () => {
  const first = mergeConfig("", block());
  const second = mergeConfig(first.text, block());
  assert.equal(second.action, "unchanged");
  assert.equal(second.text, first.text);

  const forced = mergeConfig(first.text, block(), { force: true });
  assert.equal(forced.action, "unchanged");
  assert.equal(forced.text, first.text);
});

test("mergeConfig refuses to clobber a different block without --force", () => {
  const first = mergeConfig("", block());
  const other = renderBlock({
    mcpEntry: MCP_ENTRY,
    workspace: "D:\\elsewhere",
    readOnly: false,
  });
  assert.throws(
    () => mergeConfig(first.text, other),
    (error) => {
      assert.ok(error instanceof ExistingBlockError);
      assert.match(error.message, /--force/);
      return true;
    },
  );
});

test("mergeConfig --force replaces only the managed block", () => {
  const existing = [
    "[mcp_servers.other]",
    'command = "npx"',
    "",
    "[mcp_servers.dsh-doc]",
    'command = "node"',
    'args = ["C:/old/main.js"]',
    "",
    "[profiles.slow]",
    'model = "o3"',
  ].join("\n");

  const replacement = block({ workspace: "C:\\Users\\me\\new-workspace" });
  const result = mergeConfig(existing, replacement, { force: true });
  assert.equal(result.action, "replaced");
  assert.match(result.text, /C:\/Users\/me\/new-workspace/);
  assert.match(result.text, /\[mcp_servers\.other\]\ncommand = "npx"/);
  assert.match(result.text, /\[profiles\.slow\]\nmodel = "o3"/);
  assert.equal(result.text.includes("C:/old/main.js"), false);
});

test("mergeConfig --force collapses duplicate managed blocks", () => {
  const duplicate = [
    "[mcp_servers.dsh-doc]",
    'command = "node"',
    'args = ["C:/one/main.js"]',
    "",
    "[mcp_servers.other]",
    'command = "npx"',
    "",
    "[mcp_servers.dsh-doc]",
    'command = "node"',
    'args = ["C:/two/main.js"]',
    "",
  ].join("\n");

  const result = mergeConfig(duplicate, block(), { force: true });
  assert.equal(result.text.split("[mcp_servers.dsh-doc]").length, 2);
  assert.equal(result.text.includes("C:/two/main.js"), false);
  assert.match(result.text, /\[mcp_servers\.other\]\ncommand = "npx"/);
});

test("mergeConfig keeps CRLF line endings", () => {
  const existing = ["[mcp_servers.other]", 'command = "npx"', ""].join("\r\n");
  const result = mergeConfig(existing, block());
  assert.equal(result.text.includes("\r\n"), true);
  assert.equal(/[^\r]\n/.test(result.text), false);
});

test("installConfig creates missing directories and is idempotent on disk", async () => {
  await withTempDir(async (directory) => {
    const configPath = path.join(directory, ".codex", "config.toml");

    const first = await installConfig({ configPath, block: block() });
    assert.equal(first.written, true);
    assert.equal(first.existed, false);
    const written = await readFile(configPath, "utf8");
    assert.equal(written, `${block()}\n`);

    const second = await installConfig({ configPath, block: block() });
    assert.equal(second.written, false);
    assert.equal(second.action, "unchanged");
    assert.equal(await readFile(configPath, "utf8"), written);
  });
});

test("installConfig dryRun leaves the file untouched", async () => {
  await withTempDir(async (directory) => {
    const configPath = path.join(directory, "config.toml");
    const original = '[mcp_servers.other]\ncommand = "npx"\n';
    await writeFile(configPath, original, "utf8");

    const result = await installConfig({
      configPath,
      block: block(),
      dryRun: true,
    });
    assert.equal(result.written, false);
    assert.equal(result.action, "appended");
    assert.equal(await readFile(configPath, "utf8"), original);
  });
});

test("installConfig refuses a conflicting block and leaves bytes untouched", async () => {
  await withTempDir(async (directory) => {
    const configPath = path.join(directory, "config.toml");
    const original = `${block()}\n`;
    await writeFile(configPath, original, "utf8");

    const conflicting = block({ workspace: "E:\\other" });
    await assert.rejects(
      installConfig({ configPath, block: conflicting }),
      ExistingBlockError,
    );
    assert.equal(await readFile(configPath, "utf8"), original);
  });
});

test("resolveConfigPath honours --config, then CODEX_HOME, then the home default", () => {
  const home = path.join("C:", "Users", "me");
  assert.equal(
    resolveConfigPath({ config: "D:\\cfg\\config.toml", env: {}, home }),
    path.resolve("D:\\cfg\\config.toml"),
  );
  assert.equal(
    resolveConfigPath({ env: { CODEX_HOME: "C:\\codex-home" }, home }),
    path.join(path.resolve("C:\\codex-home"), "config.toml"),
  );
  assert.equal(
    resolveConfigPath({ env: {}, home }),
    path.join(home, ".codex", "config.toml"),
  );
});

test("formatSummary shows +/- lines and marks other servers untouched", () => {
  const summary = formatSummary({
    action: "replaced",
    oldLines: ["[mcp_servers.dsh-doc]", 'command = "node"'],
    newLines: ["[mcp_servers.dsh-doc]", 'command = "node"'],
  });
  assert.match(summary, /^action: replaced/);
  assert.match(summary, /- \[mcp_servers\.dsh-doc\]/);
  assert.match(summary, /\+ \[mcp_servers\.dsh-doc\]/);
  assert.match(summary, /every other server is untouched/);

  assert.match(formatSummary({ action: "unchanged" }), /already current/);
});
