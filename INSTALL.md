# Install the DSH Document Engine

One document engine — [DOCX/DOTX/DOCM import and export](SUPPORTED_FORMATS.md),
a layout engine, PDF/HTML/Markdown rendering, conversion, and 50 MCP tools —
installable into several coding agents. Pick your host, run the build once, then
follow one section.

| Host                   | Route                                                   |
| ---------------------- | ------------------------------------------------------- |
| DeepSeek Harness (DSH) | Plugin bundle (published separately) or MCP connection  |
| Claude Code            | Plugin + marketplace, or a plain `.mcp.json`            |
| Codex CLI              | `config.toml` block or `integrations/codex/install.mjs` |
| Google Antigravity     | In-app "Add MCP server", or `mcp_config.json`           |
| OpenCode               | `opencode.json` MCP entry, optional 3-tool plugin       |
| Standalone editor      | `pnpm run web:start` → `http://127.0.0.1:4317`          |

Everything below launches the **same** built artifacts. There is no second
engine and no separate cloud service.

## 0. Prerequisites

- **Node.js ≥ 22** (the repository declares `"engines": { "node": ">=22" }`).
- **pnpm 11** (the repository pins `packageManager: pnpm@11.28.5`).
- This checkout, cloned locally.

Check versions:

```powershell
node --version        # v22.x or newer
pnpm --version        # 11.x
```

If `pnpm` is missing, install it with Corepack (ships with Node) or npm:

```powershell
corepack enable
corepack prepare pnpm@11.28.5 --activate
# or: npm install --global pnpm@11
```

In this guide `<REPO>` means the absolute path of your clone. On Windows that
looks like `C:\Users\you\Documents\dsh-doc-editor`; set it once per shell:

```powershell
$REPO = "C:\Users\you\Documents\dsh-doc-editor"
```

In bash/zsh: `REPO="$HOME/dsh-doc-editor"`.

## 0.1 Build the artifacts

From `<REPO>`:

```powershell
pnpm install
pnpm --filter @dsh-doc/mcp build     # MCP server  -> apps/mcp/dist/main.js
pnpm --filter @dsh-doc/cli build     # CLI         -> apps/cli/dist/main.js
pnpm --filter @dsh-doc/web build     # editor      -> apps/web/dist-server/server.js
```

`pnpm run build` builds all three (and the core library) in order.

| Artifact                         | Used by                                                               |
| -------------------------------- | --------------------------------------------------------------------- |
| `apps/mcp/dist/main.js`          | Every MCP route, Claude Code plugin, Codex, Antigravity, OpenCode MCP |
| `apps/mcp/dist/tools.json`       | Tool manifest written by the same build                               |
| `apps/cli/dist/main.js`          | CLI, `integrations/shared/cli-bridge.mjs`, OpenCode plugin            |
| `apps/web/dist-server/server.js` | Standalone editor + HTTP API                                          |

Verify:

```powershell
Test-Path "$REPO\apps\mcp\dist\main.js"          # True
node "$REPO\apps\mcp\dist\main.js"               # prints "… ready (workspace: …)" then waits on stdin
```

Press `Ctrl+C` after the ready line. Every integration below refuses to start
when `apps/mcp/dist/main.js` is missing and prints the exact build command; none
of them installs or builds anything silently.

The MCP server creates its workspace (`<workspace>/documents`) on first start.
Copy documents you want it to touch into `DSH_DOC_WORKSPACE`.

## 1. DeepSeek Harness (DSH)

DSH installs **plugin bundles** from a package spec. This repository builds the
bundle from [`dsh-plugin/`](dsh-plugin) and it is published at:

**https://github.com/ahmadfarizoffice-dotcom/dsh-doc-editor-plugin**

The published bundle is self-contained (`engine.js` inlines this engine), has no
dependencies and no install scripts. Verified on DSH **0.2.2-rc.3**: installing
it applies immediately under HMR, registers **17 `document_*` tools**, and adds
a **Documents** panel in the main column.

### Route A — the DSH UI

1. Open **Plugins** in the DeepSeek Harness GUI.
2. Choose **Add plugin**.
3. Paste the repository URL:

   ```text
   https://github.com/ahmadfarizoffice-dotcom/dsh-doc-editor-plugin
   ```

4. Confirm, then enable **Documents** if it is not enabled automatically.

A `github:ahmadfarizoffice-dotcom/dsh-doc-editor-plugin` spec is equivalent. If
the install stops with `failedAt: "spec-host"` and “connection to github.com
timed out”, the pre-install reachability check failed before pnpm ran: retry, or
paste the `github:` form.

Installing a bundle changes the profile and needs full-access permission in DSH;
grant it only for a source you trust. This bundle runs no build scripts and has
no dependencies, so there is nothing to approve.

### Route B — agent-driven install

In a DSH session:

```text
plugin_manager(action: "install_bundle",
               target: "github:ahmadfarizoffice-dotcom/dsh-doc-editor-plugin")
```

Then confirm the tools appear in the session and the **Documents** icon in the
left rail. Rebuild and republish the bundle after engine changes:

```powershell
pnpm run build:core
pnpm run build:plugin     # dist/dsh-plugin, with a fresh engine.js
pnpm run plugin:check     # manifest, icons, locales, 17 tools, PDF smoke
```

Copy `dist/dsh-plugin/` over the plugin repository and push. Installed copies
update with `plugin_manager` `updateBundle` (pin the full commit) or by removing
and reinstalling the bundle.

### Route C — MCP connection without a plugin

If you only want the tools and not the plugin UI, register this checkout's MCP
server in DSH's MCP settings as a **stdio** server:

```json
{
  "command": "node",
  "args": ["C:/Users/you/Documents/dsh-doc-editor/apps/mcp/dist/main.js"],
  "env": {
    "DSH_DOC_WORKSPACE": "C:/Users/you/Documents/dsh-doc-editor/.workspace"
  }
}
```

Exact DSH MCP settings labels vary by release; the values above are the ones
that matter.

### What to expect

- A connected server exposing 50 `document_*` tools, `dshdoc://` resources and
  8 prompts (`MCP.md` has the inventory).
- The agent can read and edit documents only inside the configured workspace.
- AI tools return **proposals**; they never write to the document.

### Uninstall

```text
plugin_manager(action: "remove_bundle", target: "<installed-bundle-name>")
```

For a manual MCP connection, remove the server entry. The workspace is not
deleted.

## 2. Claude Code

The plugin root is [`integrations/claude-code`](integrations/claude-code/README.md)
(it contains `.claude-plugin/plugin.json`, `.mcp.json`, `skills/` and
`commands/`).

Prerequisite: `apps/mcp/dist/main.js` built (section 0.1).

In Claude Code:

```text
/plugin marketplace add C:\Users\you\Documents\dsh-doc-editor\integrations\claude-code
/plugin install dsh-doc@dsh-doc-marketplace
```

Then `/mcp` should list `dsh-doc` as connected, and `/plugin` should show the 12
skills and 3 commands (`read-doc`, `convert-doc`, `review-doc`, invoked through
the plugin namespace).

Why the local directory: `marketplace.json` lives in
`<plugin>/.claude-plugin/` with `"source": "./"`, so the marketplace root is the
plugin directory itself. `/plugin marketplace add` with a git URL would need
that file at that repository's root; the DSH bundle repository is separate, so
use the local path (or publish `integrations/claude-code` as its own repo).

Alternatives and troubleshooting: [integrations/claude-code/README.md](integrations/claude-code/README.md).

Uninstall:

```text
/plugin uninstall dsh-doc@dsh-doc-marketplace
/plugin marketplace remove dsh-doc-marketplace
```

## 3. Codex CLI

Prerequisite: `apps/mcp/dist/main.js` built.

### Route A — installer (merges one block, idempotent)

```powershell
node "$REPO\integrations\codex\install.mjs"
```

It writes `$CODEX_HOME/config.toml` (or `~/.codex/config.toml`), creating the
directory if needed, prints a `- / +` summary, refuses to replace an existing
`[mcp_servers.dsh-doc]` block without `--force`, and asserts that every other
server and profile is untouched.

Useful flags:

```powershell
node "$REPO\integrations\codex\install.mjs" --workspace "C:\Users\you\Documents\dsh-docs"
node "$REPO\integrations\codex\install.mjs" --read-only
node "$REPO\integrations\codex\install.mjs" --print
node "$REPO\integrations\codex\install.mjs" --force
```

### Route B — paste the block

```toml
[mcp_servers.dsh-doc]
command = "node"
args = ["C:/Users/you/Documents/dsh-doc-editor/apps/mcp/dist/main.js"]
env = { DSH_DOC_WORKSPACE = "C:/Users/you/Documents/dsh-doc-editor/.workspace", DSH_DOC_READ_ONLY = "0" }
```

Use forward slashes (valid TOML). Restart Codex or start a new session, then ask
for `document_list_formats`.

Tests for the merge logic (temp dirs, no network):

```powershell
node --test "$REPO\integrations\codex\install.test.mjs"
```

If your Codex build ships `codex mcp add`, check `codex mcp --help` and use it
instead; that subcommand was not verified for this guide. Details:
[integrations/codex/README.md](integrations/codex/README.md).

Uninstall: remove the `[mcp_servers.dsh-doc]` block (and any
`.env` sub-table) from `config.toml`.

## 4. Google Antigravity

Prerequisite: `apps/mcp/dist/main.js` built.

**The exact Antigravity config path and UI labels are version-dependent and
were not verified for your release.** Use the in-app route first.

Route A — **Add MCP server** in Antigravity's agent/MCP settings:

| Field       | Value                                                                |
| ----------- | -------------------------------------------------------------------- |
| Name        | `dsh-doc`                                                            |
| Transport   | stdio / local command                                                |
| Command     | `node`                                                               |
| Arguments   | `C:/Users/you/Documents/dsh-doc-editor/apps/mcp/dist/main.js`        |
| Environment | `DSH_DOC_WORKSPACE=C:/Users/you/Documents/dsh-doc-editor/.workspace` |

Route B — merge [`integrations/antigravity/mcp_config.json`](integrations/antigravity/mcp_config.json)
into the MCP config file your release reads and replace the `<you>`
placeholders. Look for an "Open MCP config" action in the UI so you write to the
path the app actually reads; `%USERPROFILE%\.antigravity\mcp_config.json` is a
commonly reported location, not a guarantee.

Agent guidance for the Antigravity workspace: [integrations/antigravity/AGENTS.md](integrations/antigravity/AGENTS.md).
Full notes: [integrations/antigravity/README.md](integrations/antigravity/README.md).

Uninstall: remove the `dsh-doc` entry in the UI or the file, then reload.

## 5. OpenCode

Prerequisite: `apps/mcp/dist/main.js` built (and `apps/cli/dist/main.js` for the
optional plugin).

Route A (primary) — merge into `opencode.json`:

```json
{
  "mcp": {
    "dsh-doc": {
      "type": "local",
      "command": [
        "node",
        "C:/Users/you/Documents/dsh-doc-editor/apps/mcp/dist/main.js"
      ],
      "environment": {
        "DSH_DOC_WORKSPACE": "C:/Users/you/Documents/dsh-doc-editor/.workspace",
        "DSH_DOC_READ_ONLY": "0"
      },
      "enabled": true
    }
  }
}
```

Route B (optional) — copy `integrations/opencode/.opencode/plugin/dsh-doc.js`
into your project's `.opencode/plugin/`. It registers `doc_read`, `doc_convert`
and `doc_search`, which call `integrations/shared/cli-bridge.mjs`. That route is
not workspace-confined and has no page/block metadata; use it only when the MCP
route is unavailable. The plugin API shape could not be verified against a
specific OpenCode release — details and caveats:
[integrations/opencode/README.md](integrations/opencode/README.md).

Uninstall: remove the `dsh-doc` MCP key and/or the plugin file, then restart.

## 6. Standalone editor

Build (section 0.1), then:

```powershell
pnpm run web:start
```

Open **http://127.0.0.1:4317** (the server defaults to port 4317; set `PORT` to
override):

```powershell
$env:PORT = "4400"; pnpm run web:start    # http://127.0.0.1:4400
```

For development with hot reload, `pnpm run web:dev` serves the Vite dev UI on
`http://127.0.0.1:5173` and proxies `/api` to `:4317`.

The editor is a client of the same document model as the MCP server; it owns its
own workspace and audit log. It is not required for any MCP integration.

## 7. AI provider (optional)

The deterministic tools (read, edit, format, convert, review) need no provider.
`document_ai_summarize` (extractive), `document_ai_review` and the mechanical
tools work offline; `document_ai_rewrite`, `_translate`, `_generate_content` and
`_suggest_edits` need a configured provider and fail with
`AI_NOT_CONFIGURED`/`AI_PROVIDER_REQUIRED` instead of inventing output.

| Variable              | Values / default                        |
| --------------------- | --------------------------------------- |
| `DSH_DOC_AI_PROVIDER` | `offline` (default), `openai`, `ollama` |
| `DSH_DOC_AI_MODEL`    | model id for the chosen provider        |
| `OPENAI_API_KEY`      | key for an OpenAI-compatible endpoint   |
| `OPENAI_BASE_URL`     | OpenAI-compatible base URL (optional)   |
| `OLLAMA_HOST`         | default `http://127.0.0.1:11434`        |

PowerShell examples (put them in the environment that launches the host; never
commit a key into `.mcp.json`, `config.toml` or `opencode.json`):

```powershell
$env:DSH_DOC_AI_PROVIDER = "openai"
$env:DSH_DOC_AI_MODEL = "gpt-4.1-mini"      # any model your endpoint serves
$env:OPENAI_API_KEY = "sk-…"                 # from your secret store
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"

# or a local Ollama runtime
$env:DSH_DOC_AI_PROVIDER = "ollama"
$env:DSH_DOC_AI_MODEL = "llama3.1"
$env:OLLAMA_HOST = "http://127.0.0.1:11434"
```

The full variable list is in [`.env.example`](.env.example) and
[README.md](README.md#configuration).

## 8. Troubleshooting and uninstall

### "Required build output is missing"

The integrations print:

```text
dsh-doc: required build output is missing: apps/mcp/dist/main.js
```

Run, from `<REPO>`:

```powershell
pnpm install
pnpm --filter @dsh-doc/mcp build
```

For the CLI bridge or OpenCode plugin, build the CLI too
(`pnpm --filter @dsh-doc/cli build`). Nothing is built automatically.

### "Could not locate the dsh-doc-editor repository root"

The launcher walked up from the plugin directory and found no checkout. Either
copy the integration back inside the checkout, set `DSH_DOC_REPO` to its
absolute path, or pass `--repo <path>` to the Codex installer.

### Workspace missing / permission denied

Create it and make sure your user can write there:

```powershell
New-Item -ItemType Directory -Force "C:\Users\you\Documents\dsh-doc-editor\.workspace"
```

On Windows, avoid OneDrive-synced folders, `C:\Program Files` and any
Defender-controlled directory. Point `DSH_DOC_WORKSPACE` at a normal user
folder. `READ_ONLY_MODE` means the server was started with
`DSH_DOC_READ_ONLY=1`; unset it to allow mutations.

### Path errors

- `PATH_OUTSIDE_WORKSPACE` / `PATH_TRAVERSAL`: the path escapes the workspace.
  Copy the file in; do not retry with another absolute path.
- Windows paths in TOML: use `C:/Users/...` (forward slashes) or double every
  backslash. `\U` is an escape in TOML basic strings and breaks the config.
- Paths with spaces: quote them in PowerShell (`"C:\My Docs\…"`).
- `Cannot find module '@dsh-doc/core/…'`: dependencies are not installed; run
  `pnpm install` at the repository root.
- MCP client shows the server but no tools: run
  `node apps/mcp/dist/main.js` by hand and read **stderr** — stdout is the
  protocol stream. Expect `… ready (workspace: …)`.

### Port 4317 already in use

```powershell
$env:PORT = "4400"; pnpm run web:start
```

### Uninstall everything

| Host        | Action                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| DSH         | `plugin_manager(action: "remove_bundle", target: "<bundle>")`, or remove the MCP connection          |
| Claude Code | `/plugin uninstall dsh-doc@dsh-doc-marketplace` and `/plugin marketplace remove dsh-doc-marketplace` |
| Codex       | Delete the `[mcp_servers.dsh-doc]` block from `config.toml`                                          |
| Antigravity | Remove the `dsh-doc` entry in the UI or `mcp_config.json`                                            |
| OpenCode    | Remove the `mcp.dsh-doc` key and/or `.opencode/plugin/dsh-doc.js`                                    |

Then optionally delete `DSH_DOC_WORKSPACE` and the build outputs
(`apps/*/dist`, `apps/web/dist-server`). The source tree is unaffected.

## Documentation map

- [README.md](README.md) — what the engine is, quick start, repository layout
- [MCP.md](MCP.md) — 50 tools, resources, prompts, security, error codes
- [AGENT_SKILLS.md](AGENT_SKILLS.md) — skill inventory, routing, native tool definitions
- [SUPPORTED_FORMATS.md](SUPPORTED_FORMATS.md) — format matrix and fidelity notes
- [SECURITY.md](SECURITY.md) — threat model and confinement rules
- [TESTING.md](TESTING.md) — fixtures and test suite
- [AGENTS.md](AGENTS.md) — short agent entry point
- `integrations/` — per-host install notes (`claude-code`, `codex`, `antigravity`,
  `opencode`, `shared`)
