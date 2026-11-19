# OpenCode integration: `dsh-doc`

Two routes:

1. **MCP (primary, recommended).** `opencode.json` declares the `dsh-doc` stdio
   MCP server; OpenCode exposes its 50 `document_*` tools. This is the
   workspace-confined, audited surface.
2. **Plugin (optional).** `.opencode/plugin/dsh-doc.js` registers three tools
   (`doc_read`, `doc_convert`, `doc_search`) that shell out to
   `integrations/shared/cli-bridge.mjs`. Use it only when the MCP route is not
   available.

```
opencode.json                    MCP route
.opencode/plugin/dsh-doc.js      optional plugin (3 tools, CLI bridge)
```

## Prerequisites

- Node.js ≥ 22 (`node --version`).
- Built artifacts, from the repository root:

  ```bash
  pnpm install
  pnpm --filter @dsh-doc/mcp build     # MCP route
  pnpm --filter @dsh-doc/cli build     # plugin route (cli-bridge runs the CLI)
  ```

  Nothing is built automatically by either route.

## Route A — MCP via `opencode.json` (primary)

Merge this into your project's `opencode.json` (or OpenCode's global config),
keeping any other keys you already have:

```json
{
  "mcp": {
    "dsh-doc": {
      "type": "local",
      "command": [
        "node",
        "C:/Users/<you>/Documents/dsh-doc-editor/apps/mcp/dist/main.js"
      ],
      "environment": {
        "DSH_DOC_WORKSPACE": "C:/Users/<you>/Documents/dsh-doc-editor/.workspace",
        "DSH_DOC_READ_ONLY": "0"
      },
      "enabled": true
    }
  }
}
```

- `type: "local"` means OpenCode launches the command itself and speaks MCP
  over stdio. Do not add a `url`; this server is not HTTP.
- `command[0]` must be `node` (or an absolute node executable) and
  `command[1]` the **built** `apps/mcp/dist/main.js`, never a `.ts` file.
- `environment` is the per-server env table. Add `DSH_DOC_AI_PROVIDER` and
  friends there if you want AI tools; keep keys out of a committed config.

Restart OpenCode (or start a new session) after editing the config.

> Shape note: `mcp` → name → `type` / `command` / `environment` / `enabled` was
> written from OpenCode's documented MCP configuration style but **could not be
> re-verified against a live OpenCode release from this environment** (no
> network access). If your build rejects the block, check `opencode --help` /
> the config schema for the key names it expects and keep the values the same.

## Route B — plugin (3 tools)

Copy the plugin into your project:

```text
<project>/.opencode/plugin/dsh-doc.js
```

Some OpenCode builds also accept a `plugin` array in `opencode.json`; if yours
does, point it at the absolute file path instead of copying. That entry was not
verified, so copying is the safer instruction.

The plugin resolves the checkout by walking up from the OpenCode project
directory; set `DSH_DOC_REPO` to the absolute checkout path if the plugin lives
outside a checkout. It then runs:

```text
node <repo>/integrations/shared/cli-bridge.mjs info|text|outline|search|convert <file> …
```

Tools:

| Tool          | Arguments                          | Returns                                            |
| ------------- | ---------------------------------- | -------------------------------------------------- |
| `doc_read`    | `path`, `mode` = text/outline/info | JSON from `info`, `outline` or `text`              |
| `doc_convert` | `path`, `format`, `out` (optional) | JSON with output path, byte size and loss report   |
| `doc_search`  | `path`, `query`, `regex`, `limit`  | JSON matches with line/column and surrounding text |

Limits of the plugin route, stated plainly:

- It is **not** the MCP server: the CLI reads any path the OS permits, writes
  wherever `--out` points, and is not covered by the MCP audit log or workspace
  confinement. Prefer paths inside the workspace.
- `doc_search` scans plain text; it has no page numbers, block ids or document
  sessions.
- The plugin signature targeted here is
  `export const DshDoc = async ({ project, $, directory, worktree }) => ({
tool: { … } })`. It was **not verified against a specific OpenCode release**.
  If the tools do not appear, use Route A; do not patch OpenCode internals.

## Configuration

| Variable                | Default                  | Meaning                                   |
| ----------------------- | ------------------------ | ----------------------------------------- |
| `DSH_DOC_WORKSPACE`     | `<repo>/.workspace`      | Documents read/written by the MCP server  |
| `DSH_DOC_READ_ONLY`     | unset                    | `1` blocks every mutation and save        |
| `DSH_DOC_AUDIT_LOG`     | `<workspace>/audit.log`  | JSON Lines audit log                      |
| `DSH_DOC_ALLOWED_ROOTS` | `<repo>`                 | Extra readable roots (path-delimited)     |
| `DSH_DOC_REPO`          | auto-detected            | Checkout path used by the plugin          |
| `DSH_DOC_AI_PROVIDER`   | `offline`                | `offline`, `openai` or `ollama`           |
| `DSH_DOC_AI_MODEL`      | provider default         | Model id                                  |
| `OPENAI_API_KEY`        | unset                    | OpenAI-compatible key (keep out of files) |
| `OPENAI_BASE_URL`       | provider default         | OpenAI-compatible endpoint                |
| `OLLAMA_HOST`           | `http://127.0.0.1:11434` | Local Ollama endpoint                     |

## Verify

1. Restart OpenCode.
2. Ask the model to call `document_list_formats` (Route A) or `doc_read` on a
   small file (Route B). Route A should return the capability matrix; Route B
   should return a JSON object with `"ok": true`.
3. If nothing appears, run the underlying process manually and read stderr:

   ```bash
   node apps/mcp/dist/main.js
   node integrations/shared/cli-bridge.mjs --help
   ```

## Troubleshooting

| Symptom                                  | Fix                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| MCP server listed but no tools           | Check `command[1]` points at the built `dist/main.js`; run it manually to see stderr. |
| Config ignored                           | OpenCode may be reading a different config file; confirm which one your build loads.  |
| Plugin tools missing                     | The plugin API differs on your build — use Route A.                                   |
| `BRIDGE_MISSING` / `REPO_ROOT_NOT_FOUND` | Build the CLI, or set `DSH_DOC_REPO` to the checkout path.                            |
| `PATH_OUTSIDE_WORKSPACE` (Route A)       | Copy the file into `DSH_DOC_WORKSPACE`.                                               |
| `READ_ONLY_MODE`                         | Remove `DSH_DOC_READ_ONLY` from `environment` if mutations are intended.              |

## Uninstall

Route A: delete the `dsh-doc` key from `mcp` in `opencode.json` and restart.
Route B: delete `.opencode/plugin/dsh-doc.js` (and the `plugin` entry, if you
added one) and restart. Build outputs and the workspace are untouched.
