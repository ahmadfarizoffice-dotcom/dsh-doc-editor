# Shared integration helpers

Two dependency-free ES modules used by the host integrations in this
directory. They run with the repository's minimum Node version (Node ≥ 22) and
use only Node built-ins.

| File               | Purpose                                                         |
| ------------------ | --------------------------------------------------------------- |
| `resolve-repo.mjs` | Locate the checkout, check build outputs, default the workspace |
| `cli-bridge.mjs`   | JSON wrapper around the existing `dsh-doc` CLI commands         |

Neither file builds, installs, downloads, spawns a package manager or modifies
the checkout. When something is missing they print an actionable message and
let the caller exit non-zero.

## `resolve-repo.mjs`

```js
import {
  findRepoRoot,
  assertBuild,
  mcpEntryPath,
  CLI_ENTRY,
  MCP_ENTRY,
  resolveWorkspace,
  formatBuildHint,
  buildStatus,
} from "./resolve-repo.mjs";

const repoRoot = findRepoRoot(import.meta.dirname); // walks up
const entry = assertBuild(repoRoot, MCP_ENTRY); // throws BuildMissingError
const workspace = resolveWorkspace(repoRoot); // env override or <repo>/.workspace
```

A directory is treated as the repository root when it contains
`package.json`, a workspace declaration (`pnpm-workspace.yaml` or a
`workspaces` field) **and** `apps/mcp/package.json`. The last check keeps the
resolver from stopping at an unrelated parent monorepo.

`DSH_DOC_REPO` overrides the walk when the plugin has been copied away from the
checkout. `DSH_DOC_WORKSPACE` overrides the default workspace.

Run it directly for a status report (exit code 1 when the root is not found):

```bash
node integrations/shared/resolve-repo.mjs
```

## `cli-bridge.mjs`

```bash
node integrations/shared/cli-bridge.mjs --help
node integrations/shared/cli-bridge.mjs info fixtures/docx_docs_renderer_feature_test_cases.docx
node integrations/shared/cli-bridge.mjs text fixtures/docx_docs_renderer_feature_test_cases.docx --max-chars 2000
node integrations/shared/cli-bridge.mjs search fixtures/docx_docs_renderer_feature_test_cases.docx --query "Table"
node integrations/shared/cli-bridge.mjs verify fixtures/docx_docs_renderer_feature_test_cases.docx
```

Every call prints exactly one JSON object on stdout:

```json
{ "ok": true, "command": "info", "file": "…", "data": { } }
{ "ok": false, "command": "info", "error": { "code": "BUILD_MISSING", "message": "…" } }
```

| Command     | Maps to                     | Notes                                                 |
| ----------- | --------------------------- | ----------------------------------------------------- |
| `info`      | `dsh-doc info --json`       | Metadata, stats, sections, outline, compatibility     |
| `text`      | `dsh-doc text`              | Truncated at `--max-chars` (default 200000)           |
| `outline`   | `dsh-doc outline`           | JSON outline                                          |
| `search`    | `dsh-doc text` + local scan | Literal/regex scan; **not** the MCP search tool       |
| `render`    | `dsh-doc render`            | `--format html\|pdf\|svg`, output verified on disk    |
| `convert`   | `dsh-doc convert`           | `--to docx\|dotx\|docm\|pdf\|html\|md\|txt\|odt\|rtf` |
| `roundtrip` | `dsh-doc roundtrip`         | Fails when fidelity differs                           |
| `verify`    | `dsh-doc verify`            | Structure, layout, render and round-trip checks       |

Options: `--repo`, `--workspace`, `--out`, `--max-chars`, `--limit`,
`--context`, `--case-sensitive`, `--regex`, `--help`. Exit codes: `0` success,
`1` command/build failure, `2` invalid arguments.

### Not a security boundary

The CLI (and therefore this bridge) reads any file the operating system permits
and writes wherever `--out` points. The **MCP server is the confined surface**:
it restricts reads to `DSH_DOC_WORKSPACE` plus `DSH_DOC_ALLOWED_ROOTS`, confines
writes to the workspace, and records an audit log. Use the bridge only in hosts
that cannot launch the MCP server, and prefer absolute paths inside the
workspace.

`search` is also weaker than the MCP `document_search` tool: it scans the plain
text, so it has no block ids, page numbers or document session state.
