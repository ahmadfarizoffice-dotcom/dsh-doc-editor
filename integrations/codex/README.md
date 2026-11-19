# Codex CLI integration: `dsh-doc`

Codex connects to MCP servers declared in `config.toml`. This directory ships
the block, an idempotent installer, and agent guidance.

```
config.toml        copy-paste [mcp_servers.dsh-doc] snippet
install.mjs        merges the block into ~/.codex/config.toml (idempotent)
install.test.mjs   15 node:test cases for the merge logic (temp dirs, no network)
AGENTS.md          agent-facing usage and safety guidance
```

## Prerequisites

- Node.js ≥ 22 on the `PATH` Codex uses.
- The built server, from the repository root:

  ```bash
  pnpm install
  pnpm --filter @dsh-doc/mcp build
  ```

Both the installer and the manual route assume `apps/mcp/dist/main.js` exists.
The installer checks it and exits with a build instruction if it is missing; it
never builds or installs anything itself.

## Route A — installer (recommended)

```bash
node integrations/codex/install.mjs
```

What it does:

- resolves the checkout from its own location (or `--repo` / `DSH_DOC_REPO`);
- writes to `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`, creating
  `~/.codex` if it does not exist;
- appends the `[mcp_servers.dsh-doc]` block, or replaces it when `--force` is
  passed and the existing block differs;
- prints a `- removed / + added` summary before writing;
- asserts that every other `[mcp_servers.*]` table and every other profile in
  the file is byte-identical afterwards, and refuses to write otherwise.

Useful flags:

```bash
node integrations/codex/install.mjs --print
node integrations/codex/install.mjs --workspace "C:/Users/you/Documents/dsh-docs"
node integrations/codex/install.mjs --read-only
node integrations/codex/install.mjs --force
node integrations/codex/install.mjs --config "C:/tmp/codex-config.toml"
```

Re-running with the same settings reports `action: unchanged` and writes
nothing (idempotent). Re-running with different settings without `--force`
exits 1 and prints the existing block; add `--force` only when you intend to
replace it.

Run the tests (no network, temp directories only):

```bash
node --test integrations/codex/install.test.mjs
```

## Route B — manual config

Copy the block from [`config.toml`](config.toml) into
`$CODEX_HOME/config.toml` (usually `%USERPROFILE%\.codex\config.toml`) and
replace the placeholders. Keep the forward slashes: they are valid TOML and
avoid `\U` escape mistakes on Windows.

```toml
[mcp_servers.dsh-doc]
command = "node"
args = ["C:/Users/<you>/Documents/dsh-doc-editor/apps/mcp/dist/main.js"]
env = { DSH_DOC_WORKSPACE = "C:/Users/<you>/Documents/dsh-doc-editor/.workspace", DSH_DOC_READ_ONLY = "0" }
```

If you prefer the inline `env` table expanded, this is equivalent:

```toml
[mcp_servers.dsh-doc]
command = "node"
args = ["C:/Users/<you>/Documents/dsh-doc-editor/apps/mcp/dist/main.js"]

[mcp_servers.dsh-doc.env]
DSH_DOC_WORKSPACE = "C:/Users/<you>/Documents/dsh-doc-editor/.workspace"
DSH_DOC_READ_ONLY = "0"
```

## Route C — `codex mcp add`, if your build has it

Newer Codex builds may expose MCP subcommands. Check first:

```bash
codex mcp --help
```

If `add` is listed, the equivalent of the block above is:

```bash
codex mcp add dsh-doc -- node "C:/Users/<you>/Documents/dsh-doc-editor/apps/mcp/dist/main.js"
```

Then set `DSH_DOC_WORKSPACE` in the environment Codex starts with, or edit the
generated entry so it carries the `env` table. **This subcommand was not
verified for this guide**: if `codex mcp add` is absent or rejects `env`, use
Route A or B. Do not mix routes for the same server name.

## Verify

1. Start a new Codex session (existing sessions keep the config they loaded).
2. Ask it to call `document_list_formats`, then
   `document_open { "path": "example.docx" }` with a file you copied into the
   workspace.
3. If the tools are missing, run the server by hand to see stderr:

   ```bash
   node apps/mcp/dist/main.js
   ```

   It prints `dsh-doc-mcp <version> ready (workspace: <path>)` and then waits on
   stdin. Press Ctrl+C to stop.

## Configuration

| Variable                | Default                  | Meaning                               |
| ----------------------- | ------------------------ | ------------------------------------- |
| `DSH_DOC_WORKSPACE`     | `<repo>/.workspace`      | Documents read/written by the server  |
| `DSH_DOC_READ_ONLY`     | unset                    | `1` blocks every mutation and save    |
| `DSH_DOC_AUDIT_LOG`     | `<workspace>/audit.log`  | JSON Lines audit log                  |
| `DSH_DOC_ALLOWED_ROOTS` | `<repo>`                 | Extra readable roots (path-delimited) |
| `DSH_DOC_AI_PROVIDER`   | `offline`                | `offline`, `openai` or `ollama`       |
| `DSH_DOC_AI_MODEL`      | provider default         | Model id                              |
| `OPENAI_API_KEY`        | unset                    | OpenAI-compatible provider key        |
| `OPENAI_BASE_URL`       | provider default         | OpenAI-compatible endpoint            |
| `OLLAMA_HOST`           | `http://127.0.0.1:11434` | Local Ollama endpoint                 |

Keep `OPENAI_API_KEY` in the shell environment, not in `config.toml`.

## Troubleshooting

| Symptom                                                   | Fix                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `required build output is missing: apps/mcp/dist/main.js` | `pnpm install && pnpm --filter @dsh-doc/mcp build` from the repository root.                 |
| `could not locate the dsh-doc-editor repository root`     | Pass `--repo <checkout>` or set `DSH_DOC_REPO`.                                              |
| `A [mcp_servers.dsh-doc] block already exists`            | Inspect it, then re-run with `--force` if replacing it is intended.                          |
| Server connects but every write fails `READ_ONLY_MODE`    | Remove `DSH_DOC_READ_ONLY = "1"` from the block (and from the environment).                  |
| `PATH_OUTSIDE_WORKSPACE` on open                          | The file is outside `DSH_DOC_WORKSPACE`; copy it in or point the variable at its parent.     |
| Codex reports an invalid TOML config                      | Re-run the installer; a hand-edited Windows path usually contains `\U` or an unclosed quote. |

## Uninstall

Remove the `[mcp_servers.dsh-doc]` block (and any `[mcp_servers.dsh-doc.env]`
sub-table) from `config.toml`, or delete the line with
`codex mcp remove dsh-doc` if your build provides that subcommand. The installer
does not offer an uninstall flag; it only ever rewrites its own block.
