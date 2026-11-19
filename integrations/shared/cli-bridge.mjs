#!/usr/bin/env node
/**
 * JSON bridge from a host agent's shell to the `dsh-doc` CLI.
 *
 * The MCP server (`apps/mcp/dist/main.js`) is the primary, workspace-confined
 * integration surface. This bridge exists for hosts whose plugin API can only
 * run shell commands (for example the OpenCode plugin in
 * `integrations/opencode`): it maps a small command set to the existing
 * `apps/cli/dist/main.js` commands and prints one JSON object on stdout.
 *
 *   node integrations/shared/cli-bridge.mjs info   <file.docx>
 *   node integrations/shared/cli-bridge.mjs text   <file.docx> [--max-chars 200000]
 *   node integrations/shared/cli-bridge.mjs outline<file.docx>
 *   node integrations/shared/cli-bridge.mjs search <file.docx> --query <text> [--regex]
 *   node integrations/shared/cli-bridge.mjs render <file.docx> --format html|pdf|svg [--out <path>]
 *   node integrations/shared/cli-bridge.mjs convert<file.docx> --to docx|pdf|html|md|txt|odt|rtf [--out <path>]
 *   node integrations/shared/cli-bridge.mjs roundtrip <file.docx>
 *   node integrations/shared/cli-bridge.mjs verify <file.docx>
 *
 * Every response has the shape `{ ok: true, command, ... }` or
 * `{ ok: false, command, error: { code, message } }` and sets a non-zero exit
 * code on failure.
 *
 * This is deliberately NOT a replacement for the MCP server:
 *   - the CLI reads any path the OS permits, so this bridge is not a security
 *     boundary and does not confine reads to DSH_DOC_WORKSPACE;
 *   - `search` is a literal/regex scan over the CLI's plain text, not the MCP
 *     `document_search` (no page numbers, block ids or document sessions);
 *   - render/convert write files and are not tracked in the MCP audit log.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertBuild,
  BuildMissingError,
  CLI_ENTRY,
  findRepoRoot,
  RepoRootError,
  resolveWorkspace,
} from "./resolve-repo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_SEARCH_LIMIT = 20;

const RENDER_FORMATS = new Set(["html", "pdf", "svg"]);
const CONVERT_FORMATS = new Set([
  "docx",
  "dotx",
  "docm",
  "pdf",
  "html",
  "md",
  "txt",
  "odt",
  "rtf",
]);

const HELP = `dsh-doc CLI bridge (JSON output)

Usage:
  node integrations/shared/cli-bridge.mjs <command> [file] [options]

Commands:
  info <file>                       Metadata, stats, sections, outline, compatibility
  text <file>                       Plain text (truncated at --max-chars)
  outline <file>                    Heading outline
  search <file> --query <text>      Literal scan of the plain text (or regex with --regex)
  render <file> --format <name>     Render html|pdf|svg to --out
  convert <file> --to <format>      Convert to docx|dotx|docm|pdf|html|md|txt|odt|rtf
  roundtrip <file>                  DOCX -> model -> DOCX -> model fidelity check
  verify <file>                     Structure, layout, render and round-trip checks

Options:
  --repo <path>        Repository root (default: resolved from this script)
  --workspace <path>   Base directory for relative --out paths
                       (default: DSH_DOC_WORKSPACE or <repo>/.workspace)
  --out <path>         Output file for render/convert (relative paths resolve
                       under the workspace)
  --max-chars <n>      Text truncation limit (default: ${DEFAULT_MAX_CHARS})
  --limit <n>          Maximum search matches (default: ${DEFAULT_SEARCH_LIMIT})
  --context <n>        Characters of context around a search match (default: 40)
  --case-sensitive     Case-sensitive search
  --regex              Treat --query as a JavaScript regular expression
  --help               Show this help and exit 0 (works without a build)

Exit codes: 0 success, 1 command or build failure, 2 invalid arguments.
`;

class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command: positional.shift() ?? "help", positional, flags };
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function numberFlag(flags, key, fallback, minimum = 0) {
  if (flags[key] === undefined) return fallback;
  const value = Number(flags[key]);
  if (!Number.isFinite(value) || value < minimum) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `--${key} expects a number >= ${minimum}, received: ${String(flags[key])}`,
    );
  }
  return Math.floor(value);
}

function requireFile(positional, command) {
  const file = positional[0];
  if (!file) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `${command} requires a file path (relative paths resolve against the current directory: ${process.cwd()})`,
    );
  }
  const absolute = path.resolve(file);
  if (!existsSync(absolute)) {
    throw new BridgeError(
      "FILE_NOT_FOUND",
      `No such file: ${absolute} (the bridge resolves relative paths against ${process.cwd()})`,
      { file: absolute },
    );
  }
  return absolute;
}

function runCli(cliEntry, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let overflow = false;

    const collect = (chunk, sink) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT_BYTES) {
        overflow = true;
        child.kill();
        return;
      }
      sink.push(chunk);
    };

    child.stdout.on("data", (chunk) => collect(chunk, stdout));
    child.stderr.on("data", (chunk) => collect(chunk, stderr));
    child.on("error", (error) => {
      reject(
        new BridgeError(
          "COMMAND_FAILED",
          `Failed to start the CLI: ${error.message}`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      resolve({
        code: typeof code === "number" ? code : 1,
        signal: signal ?? null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        overflow,
      });
    });
  });
}

function failOnCommand(result, command, detail) {
  if (result.code === 0 && !result.overflow) return;
  throw new BridgeError(
    "COMMAND_FAILED",
    [
      `dsh-doc ${command} failed (exit ${result.code}${result.signal ? `, signal ${result.signal}` : ""}).`,
      result.overflow ? "Output exceeded the 64 MiB bridge limit." : "",
      detail ?? "",
      result.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
    { exitCode: result.code, signal: result.signal },
  );
}

function resolveOutputPath(flags, workspace, fallbackName) {
  const requested =
    typeof flags.out === "string" && flags.out.length > 0 ? flags.out : null;
  const absolute = requested
    ? path.resolve(process.cwd(), requested)
    : path.join(workspace, "bridge-out", fallbackName);
  return absolute;
}

function fileSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

function lineIndex(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function locate(lines, index) {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (
      lines[middle] <= index &&
      (middle === lines.length - 1 || lines[middle + 1] > index)
    ) {
      return { line: middle + 1, column: index - lines[middle] + 1 };
    }
    if (lines[middle] > index) high = middle - 1;
    else low = middle + 1;
  }
  return { line: lines.length, column: 1 };
}

function searchText(text, options) {
  const { query, regex, caseSensitive, limit, context } = options;
  let pattern;
  if (regex) {
    try {
      pattern = new RegExp(query, caseSensitive ? "g" : "gi");
    } catch (error) {
      throw new BridgeError(
        "INVALID_ARGUMENTS",
        `Invalid regular expression: ${error.message}`,
      );
    }
  }
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const lines = lineIndex(text);
  const matches = [];
  let total = 0;

  if (pattern) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      total += 1;
      if (matches.length < limit) {
        const start = match.index;
        const end = start + match[0].length;
        const position = locate(lines, start);
        matches.push({
          index: start,
          end,
          line: position.line,
          column: position.column,
          text: text.slice(
            Math.max(0, start - context),
            Math.min(text.length, end + context),
          ),
        });
      }
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  } else {
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) break;
      total += 1;
      if (matches.length < limit) {
        const end = index + needle.length;
        const position = locate(lines, index);
        matches.push({
          index,
          end,
          line: position.line,
          column: position.column,
          text: text.slice(
            Math.max(0, index - context),
            Math.min(text.length, end + context),
          ),
        });
      }
      from = index + Math.max(1, needle.length);
    }
  }

  return {
    query,
    regex,
    caseSensitive,
    totalMatches: total,
    truncated: total > matches.length,
    matches,
  };
}

async function commandInfo(cliEntry, file) {
  const result = await runCli(cliEntry, ["info", file, "--json"]);
  failOnCommand(result, "info");
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new BridgeError(
      "COMMAND_FAILED",
      "dsh-doc info --json did not return parseable JSON",
      { stdout: result.stdout.slice(0, 2000) },
    );
  }
  return { file, data };
}

async function commandText(cliEntry, file, flags) {
  const result = await runCli(cliEntry, ["text", file]);
  failOnCommand(result, "text");
  const maxChars = numberFlag(flags, "max-chars", DEFAULT_MAX_CHARS, 1);
  const text = result.stdout;
  const truncated = text.length > maxChars;
  return {
    file,
    data: {
      text: truncated ? text.slice(0, maxChars) : text,
      characters: text.length,
      returnedCharacters: truncated ? maxChars : text.length,
      truncated,
    },
  };
}

async function commandOutline(cliEntry, file) {
  const result = await runCli(cliEntry, ["outline", file]);
  failOnCommand(result, "outline");
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new BridgeError(
      "COMMAND_FAILED",
      "dsh-doc outline did not return parseable JSON",
      { stdout: result.stdout.slice(0, 2000) },
    );
  }
  return { file, data };
}

async function commandSearch(cliEntry, file, flags) {
  if (typeof flags.query !== "string" || flags.query.length === 0) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      "search requires --query <text>",
    );
  }
  const result = await runCli(cliEntry, ["text", file]);
  failOnCommand(result, "search");
  const matches = searchText(result.stdout, {
    query: flags.query,
    regex: flags.regex === true,
    caseSensitive: flags["case-sensitive"] === true,
    limit: numberFlag(flags, "limit", DEFAULT_SEARCH_LIMIT, 1),
    context: numberFlag(flags, "context", 40, 0),
  });
  return {
    file,
    data: {
      ...matches,
      // The MCP document_search returns page/block geometry this scan cannot.
      source: "cli-bridge plain-text scan (not the MCP document_search tool)",
    },
  };
}

async function commandRender(cliEntry, file, flags, workspace) {
  const format =
    typeof flags.format === "string" ? flags.format.toLowerCase() : "html";
  if (!RENDER_FORMATS.has(format)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `--format must be one of ${[...RENDER_FORMATS].join(", ")}, received: ${format}`,
    );
  }
  const base = path.basename(file, path.extname(file));
  const out = resolveOutputPath(flags, workspace, `${base}.${format}`);
  const result = await runCli(cliEntry, [
    "render",
    file,
    "--format",
    format,
    "--out",
    out,
  ]);
  failOnCommand(result, "render");
  if (!existsSync(out)) {
    throw new BridgeError(
      "OUTPUT_MISSING",
      `Renderer reported success but ${out} does not exist`,
    );
  }
  return {
    file,
    data: {
      format,
      output: { path: out, bytes: fileSize(out) },
      stdout: result.stdout.trim(),
    },
  };
}

async function commandConvert(cliEntry, file, flags, workspace) {
  const to = typeof flags.to === "string" ? flags.to.toLowerCase() : "";
  if (!CONVERT_FORMATS.has(to)) {
    throw new BridgeError(
      "INVALID_ARGUMENTS",
      `--to must be one of ${[...CONVERT_FORMATS].join(", ")}, received: ${to || "(missing)"}`,
    );
  }
  const base = path.basename(file, path.extname(file));
  const out = resolveOutputPath(flags, workspace, `${base}.${to}`);
  const result = await runCli(cliEntry, [
    "convert",
    file,
    "--to",
    to,
    "--out",
    out,
  ]);
  failOnCommand(result, "convert");
  if (!existsSync(out)) {
    throw new BridgeError(
      "OUTPUT_MISSING",
      `Converter reported success but ${out} does not exist`,
    );
  }
  return {
    file,
    data: {
      to,
      output: { path: out, bytes: fileSize(out) },
      stdout: result.stdout.trim(),
    },
  };
}

async function commandRoundtrip(cliEntry, file) {
  const result = await runCli(cliEntry, ["roundtrip", file]);
  failOnCommand(result, "roundtrip");
  return { file, data: { passed: true, report: result.stdout.trim() } };
}

async function commandVerify(cliEntry, file) {
  const result = await runCli(cliEntry, ["verify", file]);
  failOnCommand(result, "verify");
  return { file, data: { passed: true, report: result.stdout.trim() } };
}

const COMMANDS = {
  info: {
    run: (cliEntry, positional) =>
      commandInfo(cliEntry, requireFile(positional, "info")),
  },
  text: {
    run: (cliEntry, positional, flags) =>
      commandText(cliEntry, requireFile(positional, "text"), flags),
  },
  outline: {
    run: (cliEntry, positional) =>
      commandOutline(cliEntry, requireFile(positional, "outline")),
  },
  search: {
    run: (cliEntry, positional, flags) =>
      commandSearch(cliEntry, requireFile(positional, "search"), flags),
  },
  render: {
    run: (cliEntry, positional, flags, workspace) =>
      commandRender(
        cliEntry,
        requireFile(positional, "render"),
        flags,
        workspace,
      ),
  },
  convert: {
    run: (cliEntry, positional, flags, workspace) =>
      commandConvert(
        cliEntry,
        requireFile(positional, "convert"),
        flags,
        workspace,
      ),
  },
  roundtrip: {
    run: (cliEntry, positional) =>
      commandRoundtrip(cliEntry, requireFile(positional, "roundtrip")),
  },
  verify: {
    run: (cliEntry, positional) =>
      commandVerify(cliEntry, requireFile(positional, "verify")),
  },
};

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (command === "help" || flags.help === true) {
    process.stdout.write(HELP);
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }

  try {
    const start =
      typeof flags.repo === "string" ? path.resolve(flags.repo) : HERE;
    const repoRoot = findRepoRoot(start);
    const cliEntry = assertBuild(repoRoot, CLI_ENTRY, "dsh-doc CLI");
    const workspace =
      typeof flags.workspace === "string"
        ? path.resolve(flags.workspace)
        : resolveWorkspace(repoRoot);
    const result = await handler.run(cliEntry, positional, flags, workspace);
    emit({ ok: true, command, repoRoot, ...result });
    return 0;
  } catch (error) {
    if (error instanceof BuildMissingError || error instanceof RepoRootError) {
      process.stderr.write(`${error.message}\n`);
      emit({
        ok: false,
        command,
        error: { code: error.code, message: error.message },
      });
      return 1;
    }
    if (error instanceof BridgeError) {
      process.stderr.write(`${error.message}\n`);
      emit({
        ok: false,
        command,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
      return error.code === "INVALID_ARGUMENTS" ? 2 : 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`dsh-doc bridge failed: ${message}\n`);
    emit({
      ok: false,
      command,
      error: { code: "BRIDGE_FAILED", message },
    });
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`dsh-doc bridge crashed: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  },
);
