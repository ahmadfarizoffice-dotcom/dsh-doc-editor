# Google Antigravity integration: `dsh-doc`

Antigravity is a Google IDE/agent host that can attach stdio MCP servers. This
directory ships a ready `mcp_config.json` and agent guidance.

```
mcp_config.json   { "mcpServers": { "dsh-doc": { command, args, env } } }
AGENTS.md         usage and safety guidance for the Antigravity agent
```

> **Verified vs. unverified.** The JSON shape below (`mcpServers` → name →
> `command` / `args` / `env`) is the shape this repository ships and is common
> to MCP hosts. The **exact file location and UI labels in Antigravity are
> version-dependent and were not verified against an official Antigravity
> document for your release.** Use the in-app UI route first; it is
> authoritative for your build. Treat every path named below as a _common_
> location, not a guarantee.

## Prerequisites

- Node.js ≥ 22 available to Antigravity (`node --version` in the same shell or
  a normal system install).
- The built server, from the repository root:

  ```bash
  pnpm install
  pnpm --filter @dsh-doc/mcp build
  ```

  Confirm `apps/mcp/dist/main.js` exists. The server is a stdio process; there is
  nothing to host or port-forward.

## Route 1 — in-app "Add MCP server" (recommended)

Open Antigravity's agent/MCP settings and choose **Add MCP server** (the label
may be "MCP servers", "Tools", or similar on your release). Fill in:

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Name        | `dsh-doc`                                                              |
| Transport   | `stdio` / local command                                                |
| Command     | `node`                                                                 |
| Argument    | `C:/Users/<you>/Documents/dsh-doc-editor/apps/mcp/dist/main.js`        |
| Environment | `DSH_DOC_WORKSPACE=C:/Users/<you>/Documents/dsh-doc-editor/.workspace` |
| Environment | `DSH_DOC_READ_ONLY=0` (optional; `1` for read-only)                    |

If your release only accepts a single command line, use:

```text
node "C:/Users/<you>/Documents/dsh-doc-editor/apps/mcp/dist/main.js"
```

`apps/mcp/dist/main.js` is a stdio MCP server. It prints diagnostics to stderr
and speaks the protocol on stdout; a host that tries to parse stdout as logs
will break the session, and a host that shows you "no tools" usually means the
process exited — check its stderr.

## Route 2 — `mcp_config.json`

Copy [`mcp_config.json`](mcp_config.json) to the MCP config file your release
uses and replace the `<you>` placeholders.

Common locations reported for Antigravity-family tools are
`%USERPROFILE%\.antigravity\mcp_config.json` and an MCP section inside the
application's settings directory. **Neither was verified for this release.**
Before creating a file, look for an "Edit config", "Open MCP config" or "Show
config file" action in the UI — if one exists, use it so you write to the path
the app actually reads. If the UI only offers a form, use Route 1.

The file must contain the same JSON shape:

```json
{
  "mcpServers": {
    "dsh-doc": {
      "command": "node",
      "args": ["C:/Users/<you>/Documents/dsh-doc-editor/apps/mcp/dist/main.js"],
      "env": {
        "DSH_DOC_WORKSPACE": "C:/Users/<you>/Documents/dsh-doc-editor/.workspace",
        "DSH_DOC_READ_ONLY": "0"
      }
    }
  }
}
```

If your config already has an `mcpServers` object, add only the `dsh-doc` key;
do not replace the whole file.

## Verify

1. Reload the Antigravity window (or restart it) so the config is re-read.
2. Ask the agent to call `document_list_formats`. A working server returns the
   import/export capability matrix.
3. Create `example.docx` in the workspace with any other tool, then ask the
   agent to `document_open` it and read the outline.
4. If the server does not appear, run it manually and read stderr:

   ```bash
   node apps/mcp/dist/main.js
   ```

   Expected first line: `dsh-doc-mcp <version> ready (workspace: <path>)`.
   Ctrl+C to stop.

## Configuration

| Variable                | Default                  | Meaning                                   |
| ----------------------- | ------------------------ | ----------------------------------------- |
| `DSH_DOC_WORKSPACE`     | `<repo>/.workspace`      | Documents read/written by the server      |
| `DSH_DOC_READ_ONLY`     | unset                    | `1` blocks every mutation and save        |
| `DSH_DOC_AUDIT_LOG`     | `<workspace>/audit.log`  | JSON Lines audit log                      |
| `DSH_DOC_ALLOWED_ROOTS` | `<repo>`                 | Extra readable roots (path-delimited)     |
| `DSH_DOC_AI_PROVIDER`   | `offline`                | `offline`, `openai` or `ollama`           |
| `DSH_DOC_AI_MODEL`      | provider default         | Model id                                  |
| `OPENAI_API_KEY`        | unset                    | OpenAI-compatible key (keep out of files) |
| `OPENAI_BASE_URL`       | provider default         | OpenAI-compatible endpoint                |
| `OLLAMA_HOST`           | `http://127.0.0.1:11434` | Local Ollama endpoint                     |

The server only reads/writes inside `DSH_DOC_WORKSPACE` (plus
`DSH_DOC_ALLOWED_ROOTS` for reads). Point it at a folder you are comfortable
giving the agent, not at your whole home directory.

## Troubleshooting

| Symptom                                | Fix                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `dsh-doc-mcp` exits immediately        | Run it manually; usually a missing `pnpm install`/build or an invalid workspace path.       |
| No tools listed                        | Confirm the command points at `apps/mcp/dist/main.js`, not at TypeScript source.            |
| `PATH_OUTSIDE_WORKSPACE`               | The file is outside the workspace; copy it in or change `DSH_DOC_WORKSPACE`.                |
| Config edits ignored                   | The UI may hold its own copy of the server list, or the file path is wrong for this build.  |
| `READ_ONLY_MODE`                       | Remove `DSH_DOC_READ_ONLY` (or set `0`) if mutations are intended.                          |
| Workspace permission errors on Windows | Pick a workspace outside OneDrive/Defender-locked folders and grant your user write access. |

## Uninstall

Remove the `dsh-doc` entry from the MCP settings UI, or delete its key from
`mcp_config.json`, then reload the window. The build outputs and the workspace
are left in place.
