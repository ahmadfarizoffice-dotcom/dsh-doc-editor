/**
 * OpenCode plugin: three document tools backed by the shared CLI bridge.
 *
 * IMPORTANT — API status
 * ----------------------
 * The OpenCode plugin surface used here (`export const X = async (input) =>
 * ({ tool: { name: { description, args, execute } } })`) is the shape this
 * repository targets. It was **not verified against an OpenCode release from
 * this environment** (no network access while this file was written). The file
 * is syntactically valid JavaScript and the commands it builds are real; if your
 * OpenCode build exposes a different plugin signature, use the MCP route in
 * `integrations/opencode/opencode.json` instead — that is the primary path.
 *
 * Each tool shells out to:
 *
 *   node <repo>/integrations/shared/cli-bridge.mjs <command> <args>
 *
 * which prints one JSON object and exits non-zero on failure. See
 * `integrations/shared/README.md` for the command set and its limits (this is
 * NOT the workspace-confined MCP server).
 *
 * Install: copy `.opencode/plugin/dsh-doc.js` into your project's
 * `.opencode/plugin/` directory, or point `plugin` in `opencode.json` at this
 * file. Restart OpenCode after changing it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const BRIDGE_RELATIVE = path.join("integrations", "shared", "cli-bridge.mjs");
const MAX_WALK_UP = 16;

function processEnv() {
  return globalThis.process?.env ?? {};
}

function isRepoRoot(directory) {
  try {
    const manifest = path.join(directory, "package.json");
    if (!existsSync(manifest)) return false;
    if (!existsSync(path.join(directory, "apps", "mcp", "package.json"))) {
      return false;
    }
    if (existsSync(path.join(directory, "pnpm-workspace.yaml"))) return true;
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    return parsed.workspaces !== undefined;
  } catch {
    return false;
  }
}

/** Walk up from the OpenCode project directory to the dsh-doc-editor checkout. */
function resolveRepoRoot(startDirectory) {
  const override = String(processEnv().DSH_DOC_REPO ?? "").trim();
  if (override && isRepoRoot(override)) return path.resolve(override);

  let current = path.resolve(startDirectory);
  for (let depth = 0; depth <= MAX_WALK_UP; depth += 1) {
    if (isRepoRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function bridgeError(code, message) {
  return JSON.stringify({ ok: false, error: { code, message } }, null, 2);
}

function formatMissingRepo(startDirectory) {
  return bridgeError(
    "REPO_ROOT_NOT_FOUND",
    "dsh-doc: could not find the dsh-doc-editor checkout from " +
      startDirectory +
      ". Set DSH_DOC_REPO to its absolute path, or use the MCP route in integrations/opencode/opencode.json.",
  );
}

async function readOutput(result) {
  // Bun's shell exposes .text(); tolerate a plain string too.
  if (typeof result === "string") return result;
  if (result && typeof result.text === "function") return await result.text();
  if (result && result.stdout !== undefined) return String(result.stdout);
  return String(result ?? "");
}

/**
 * Run one bridge invocation. `makeInvocation` receives the absolute bridge path
 * and must return the shell promise (every dynamic value interpolated on its
 * own, so Bun quotes it as a single argument).
 */
async function execute($, repoRoot, makeInvocation) {
  const bridge = path.join(repoRoot, BRIDGE_RELATIVE);
  if (!existsSync(bridge)) {
    return bridgeError(
      "BRIDGE_MISSING",
      `dsh-doc: ${bridge} is missing. Use the MCP route instead.`,
    );
  }
  if (typeof $ !== "function") {
    return bridgeError(
      "SHELL_UNAVAILABLE",
      "dsh-doc: OpenCode did not provide the `$` shell helper to this plugin. Use the MCP route in integrations/opencode/opencode.json.",
    );
  }

  try {
    const invocation = makeInvocation(bridge);
    const scoped =
      typeof invocation?.cwd === "function"
        ? invocation.cwd(repoRoot)
        : invocation;
    const quiet = typeof scoped?.quiet === "function" ? scoped.quiet() : scoped;
    const result =
      typeof quiet?.nothrow === "function"
        ? await quiet.nothrow()
        : await quiet;
    const text = (await readOutput(result)).trim();
    return text.length > 0
      ? text
      : bridgeError("EMPTY_OUTPUT", "dsh-doc: the bridge printed nothing.");
  } catch (error) {
    return bridgeError(
      "BRIDGE_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * OpenCode plugin entry point.
 *
 * @param {{ project?: { worktree?: string }, $?: Function,
 *           directory?: string, worktree?: string }} input
 */
export const DshDoc = async ({ project, $, directory, worktree }) => {
  const startDirectory =
    String(processEnv().DSH_DOC_REPO ?? "").trim() ||
    worktree ||
    directory ||
    project?.worktree ||
    globalThis.process?.cwd?.() ||
    ".";

  return {
    tool: {
      doc_read: {
        description:
          "Read a DOCX/DOTX/DOCM file through the dsh-doc engine and return JSON: metadata, heading outline or plain text. Read-only.",
        args: {
          path: {
            type: "string",
            description:
              "Path to a .docx/.dotx/.docm file (absolute, or relative to the current directory).",
          },
          mode: {
            type: "string",
            enum: ["text", "outline", "info"],
            description:
              "text (default) = plain text; outline = heading tree; info = metadata, stats, sections, compatibility.",
          },
        },
        execute: async (args) => {
          const repoRoot = resolveRepoRoot(startDirectory);
          if (!repoRoot) return formatMissingRepo(startDirectory);
          const mode =
            args?.mode === "outline" || args?.mode === "info"
              ? args.mode
              : "text";
          const filePath = String(args?.path ?? "");
          return execute(
            $,
            repoRoot,
            (bridge) => $`node ${bridge} ${mode} ${filePath}`,
          );
        },
      },

      doc_convert: {
        description:
          "Convert a document with the dsh-doc conversion engine and return JSON with the output path, byte size and loss report. Does not modify the source file.",
        args: {
          path: {
            type: "string",
            description: "Source document path.",
          },
          format: {
            type: "string",
            enum: [
              "docx",
              "dotx",
              "docm",
              "pdf",
              "html",
              "md",
              "txt",
              "odt",
              "rtf",
            ],
            description: "Target format.",
          },
          out: {
            type: "string",
            description:
              "Optional output path. Defaults to <workspace>/bridge-out/<name>.<format>.",
          },
        },
        execute: async (args) => {
          const repoRoot = resolveRepoRoot(startDirectory);
          if (!repoRoot) return formatMissingRepo(startDirectory);
          const target = String(args?.format ?? "").toLowerCase();
          const filePath = String(args?.path ?? "");
          const out = args?.out ? String(args.out) : "";
          return execute($, repoRoot, (bridge) =>
            out
              ? $`node ${bridge} convert ${filePath} --to ${target} --out ${out}`
              : $`node ${bridge} convert ${filePath} --to ${target}`,
          );
        },
      },

      doc_search: {
        description:
          "Search a document's plain text (literal, or JavaScript regex with regex=true) and return JSON matches with line/column and surrounding text. This is a text scan, not the MCP document_search tool: it has no page numbers or block ids.",
        args: {
          path: {
            type: "string",
            description: "Document path.",
          },
          query: {
            type: "string",
            description: "Text to find.",
          },
          regex: {
            type: "boolean",
            description:
              "Treat query as a JavaScript regular expression (default false).",
          },
          limit: {
            type: "number",
            description: "Maximum matches to return (default 20).",
          },
        },
        execute: async (args) => {
          const repoRoot = resolveRepoRoot(startDirectory);
          if (!repoRoot) return formatMissingRepo(startDirectory);
          const filePath = String(args?.path ?? "");
          const query = String(args?.query ?? "");
          const limit = Number.isFinite(Number(args?.limit))
            ? String(Math.max(1, Math.floor(Number(args.limit))))
            : "20";
          const regex = args?.regex === true;
          return execute($, repoRoot, (bridge) =>
            regex
              ? $`node ${bridge} search ${filePath} --query ${query} --limit ${limit} --regex`
              : $`node ${bridge} search ${filePath} --query ${query} --limit ${limit}`,
          );
        },
      },
    },
  };
};

export default DshDoc;
