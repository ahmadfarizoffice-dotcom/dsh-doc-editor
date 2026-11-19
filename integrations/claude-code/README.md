# Claude Code plugin: `dsh-doc`

This directory **is** the Claude Code plugin root. It contains:

```
.claude-plugin/plugin.json        plugin manifest
.claude-plugin/marketplace.json   marketplace entry for this directory
.mcp.json                         starts the MCP server via scripts/start-mcp.mjs
scripts/start-mcp.mjs             repository/build resolver + MCP launcher
scripts/sync-skills.mjs           copies <repo>/skills into skills/
skills/<name>/SKILL.md            12 committed copies of the canonical skill pack
commands/read-doc.md              /read-doc  — read a document
commands/convert-doc.md           /convert-doc — convert with loss reporting
commands/review-doc.md            /review-doc — mechanical review + revisions
```

The plugin adds no code to the engine: it launches the built MCP server
(`apps/mcp/dist/main.js`) and ships the skill/command prompts.

## Prerequisites

- Node.js ≥ 22 on `PATH` (`node --version`).
- The checkout built once, from the repository root:

  ```bash
  pnpm install
  pnpm --filter @dsh-doc/mcp build
  ```

  `scripts/start-mcp.mjs` verifies `apps/mcp/dist/main.js` exists and exits with
  a build instruction if it does not. **Nothing is installed or built
  automatically.**

## Install

### Option A — local marketplace (recommended for a checkout)

In Claude Code, add this **directory** as a marketplace, then install the
plugin:

```text
/plugin marketplace add C:\Users\<you>\Documents\dsh-doc-editor\integrations\claude-code
/plugin install dsh-doc@dsh-doc-marketplace
```

Why the directory and not the repository URL: `marketplace.json` lives in
`<plugin>/.claude-plugin/` and declares `"source": "./"`, so the marketplace
root is this directory. `/plugin marketplace add ahmadfarizoffice-dotcom/dsh-doc-editor`
points at the repository root, which does not contain `.claude-plugin/`. Publish
this directory as its own repository (or a branch where it is the root) if you
want a GitHub URL to work.

### Option B — load the plugin for one session

```bash
claude --plugin-dir C:\Users\<you>\Documents\dsh-doc-editor\integrations\claude-code
```

If your Claude Code build does not expose `--plugin-dir` (`claude --help`),
use Option A.

### Option C — MCP server only, no skills or commands

Copy `.mcp.json` into a project's `.mcp.json`, replacing `${CLAUDE_PLUGIN_ROOT}`
with the absolute path to this directory — that variable only exists for
plugin-provided configuration:

```json
{
  "mcpServers": {
    "dsh-doc": {
      "command": "node",
      "args": [
        "C:/Users/<you>/Documents/dsh-doc-editor/integrations/claude-code/scripts/start-mcp.mjs"
      ]
    }
  }
}
```

## Configuration

`scripts/start-mcp.mjs` inherits the environment Claude Code was started with
and exports `DSH_DOC_WORKSPACE` before loading the server:

| Variable                | Default                 | Meaning                               |
| ----------------------- | ----------------------- | ------------------------------------- |
| `DSH_DOC_WORKSPACE`     | `<repo>/.workspace`     | Documents read/written by the server  |
| `DSH_DOC_READ_ONLY`     | unset                   | `1` blocks every mutation and save    |
| `DSH_DOC_AUDIT_LOG`     | `<workspace>/audit.log` | JSON Lines audit log                  |
| `DSH_DOC_ALLOWED_ROOTS` | `<repo>`                | Extra readable roots (path-delimited) |
| `DSH_DOC_REPO`          | resolved by walking up  | Override the checkout location        |
| `DSH_DOC_AI_PROVIDER`   | `offline`               | `offline`, `openai` or `ollama`       |

PowerShell example (set before starting `claude`):

```powershell
$env:DSH_DOC_WORKSPACE = "C:\Users\<you>\Documents\dsh-docs"
$env:DSH_DOC_READ_ONLY = "0"
```

## What to expect

- `/mcp` lists `dsh-doc` as connected with the `document_*` tool set (50 tools).
  The exact tool namespacing is client-owned; check `/mcp` for the names this
  build exposes.
- `/plugin` lists the plugin's 12 skills and 3 commands. Commands are invoked
  through the plugin namespace (for example `/dsh-doc:read-doc`); the client
  shows the exact names.
- Skills are auto-selected from their `description` frontmatter.
- Documents live in the workspace; `document_open` with a path outside it fails
  with `PATH_OUTSIDE_WORKSPACE`.

The plugin's skills are **copies** of `<repo>/skills`. After editing the
canonical pack, re-sync and commit:

```bash
node integrations/claude-code/scripts/sync-skills.mjs
node integrations/claude-code/scripts/sync-skills.mjs --check   # exits 1 on drift
```

## Troubleshooting

| Symptom                                                            | Fix                                                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `dsh-doc: required build output is missing: apps/mcp/dist/main.js` | Run `pnpm install && pnpm --filter @dsh-doc/mcp build` from the repository root.                                |
| `dsh-doc: could not locate the dsh-doc-editor repository root`     | Set `DSH_DOC_REPO` to the checkout path, or copy this directory back inside the checkout.                       |
| Server exits immediately, no tools                                 | Run `node integrations/claude-code/scripts/start-mcp.mjs` manually and read stderr; stdout is the MCP protocol. |
| Skills missing after editing `skills/`                             | `node integrations/claude-code/scripts/sync-skills.mjs` (then reinstall/reload the plugin).                     |
| `READ_ONLY_MODE` on every edit                                     | Unset `DSH_DOC_READ_ONLY`, or use a writable workspace.                                                         |
| `AI_NOT_CONFIGURED` from `document_ai_*`                           | Configure `DSH_DOC_AI_PROVIDER`/model/key; mechanical `document_ai_review` works without one.                   |

Never run the plugin scripts with `sudo`. They only read the manifest, check
`apps/mcp/dist/main.js` and `import()` it.

## Uninstall

```text
/plugin uninstall dsh-doc@dsh-doc-marketplace
/plugin marketplace remove dsh-doc-marketplace
```

For Option C, remove the `dsh-doc` entry from the project's `.mcp.json`. The
workspace directory and the built `apps/mcp/dist` stay where they are.
