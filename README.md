# DSH Document Engine (`dsh-doc-editor`)

A universal document platform: a Word/Google-Docs-style editor, an independent
layout and rendering engine, a conversion engine, and a programmable document
service exposed through MCP, native agent tools and reusable skills.

The whole platform operates on **one versioned, format-independent document
model**. The editor, renderer, converter, AI assistant and MCP server are all
clients of that model — there is no second parser, no HTML-only shortcut and no
duplicated business logic.

```
┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│  Editor UI │  │ MCP server │  │ Agent tools│  │    CLI     │
└─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
      └───────────────┴───────────────┴───────────────┘
                      │  DocumentService (single API)
      ┌───────────────┼───────────────┬───────────────┐
┌─────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
│ Document   │ │ Layout      │ │ Conversion  │ │ AI assistant│
│ model+ops  │ │ engine      │ │ engine      │ │ (providers) │
└─────┬──────┘ └──────┬──────┘ └──────┬──────┘ └─────────────┘
      │               │               │
┌─────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐
│ OOXML      │ │ HTML / SVG  │ │ HTML, MD,   │
│ DOCX import│ │ PDF         │ │ TXT, RTF,   │
│ / export   │ │ renderers   │ │ ODT adapters│
└────────────┘ └─────────────┘ └─────────────┘
```

## Quick start

Requirements: **Node.js ≥ 22** and **pnpm** (the repository pins
`packageManager: pnpm@11.28.5`).

```bash
pnpm install
pnpm run build          # core library, MCP server, CLI, web editor
pnpm test               # unit + integration + fixture + MCP protocol tests
```

### Editor

```bash
pnpm run web:dev        # Vite dev server (http://127.0.0.1:5173)
# or, after a build:
pnpm run web:start      # serves the built UI + HTTP API on PORT (default 4173)
```

### MCP server (stdio)

```bash
pnpm run mcp:start
# equivalent: node apps/mcp/dist/main.js
```

Add it to an MCP client:

```json
{
  "mcpServers": {
    "dsh-doc": {
      "command": "node",
      "args": ["/absolute/path/to/dsh-doc-editor/apps/mcp/dist/main.js"],
      "env": {
        "DSH_DOC_WORKSPACE": "/absolute/path/to/document-workspace"
      }
    }
  }
}
```

### CLI

```bash
node apps/cli/dist/main.js info fixtures/docx_docs_renderer_feature_test_cases.docx
node apps/cli/dist/main.js render fixtures/docx_docs_renderer_feature_test_cases.docx --format pdf --out out/fixture.pdf
node apps/cli/dist/main.js verify fixtures/docx_docs_renderer_feature_test_cases.docx
node apps/cli/dist/main.js roundtrip fixtures/docx_docs_renderer_feature_test_cases.docx
```

## The golden fixture

`fixtures/docx_docs_renderer_feature_test_cases.docx` (the supplied acceptance
fixture) is part of the test suite:

```bash
pnpm run test:fixture   # import, structure, layout/pagination, render, round-trip
```

Current result on the fixture: **3 sections** (Letter portrait, A4 landscape,
A4 portrait), **310 paragraphs**, **5 tables**, header/footer on every section,
page-number field resolved, 8 rendered pages, and a **byte-identical text
round-trip** through `DOCX → model → DOCX → model`.

The fixture's written checklist covers more cases than the file physically
contains (it describes images, footnotes, comments, tracked changes, equations
and text boxes but embeds none of them). We therefore also ship an **extended
fixture** generated from real OOXML that adds those constructs — see
[TESTING.md](TESTING.md#the-fixture-family).

## What is implemented

| Area                                                                                                                             | Status                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| DOCX / DOTX / DOCM import + export (round-trip)                                                                                  | ✅ implemented, fixture-verified                     |
| Shared document model with versioning, unknown-element preservation                                                              | ✅                                                   |
| Deterministic editing operations (text, formatting, lists, tables, sections, images, notes, comments, revisions, TOC, equations) | ✅                                                   |
| Layout engine (pagination, line breaking, tables, floats, headers/footers, footnotes, columns)                                   | ✅                                                   |
| HTML, SVG and PDF renderers over the layout model                                                                                | ✅                                                   |
| Conversion engine with capability matrix and loss reports                                                                        | ✅ (adapters vary — see matrix)                      |
| MCP server: 50 tools, 8 resources, 8 prompts, typed schemas                                                                      | ✅                                                   |
| Native agent tool definitions (JSON Schema)                                                                                      | ✅                                                   |
| Reusable skills (12)                                                                                                             | ✅                                                   |
| Editor UI (formatting, tables, images, comments, find/replace, outline, AI panel, print preview)                                 | ✅                                                   |
| AI assistant (Ask / Suggest / Edit), provider independent                                                                        | ✅ with provider caveats                             |
| PDF **import**                                                                                                                   | ❌ not supported (documented)                        |
| Google Drive / Google Docs API integration                                                                                       | ❌ not implemented (DOCX/HTML interoperability only) |
| Macro execution, script execution, external entity resolution                                                                    | ❌ never performed (by design)                       |

Full detail: [FEATURES.md](FEATURES.md) · [SUPPORTED_FORMATS.md](SUPPORTED_FORMATS.md) · [ARCHITECTURE.md](ARCHITECTURE.md).

## Repository layout

```
packages/core/src/
  model/     versioned document model + deterministic operations
  docx/      OOXML import/export (DOCX, DOTX, DOCM)
  formats/   HTML, Markdown, TXT, RTF, ODT, legacy DOC, XLSX/PPTX preview
  layout/    pagination and line/table/float layout (font metrics included)
  render/    HTML, SVG, PDF renderers
  convert/   conversion engine: capability matrix, fidelity, loss reports
  service/   workspace, sessions, history, auditing, the unified API
  ai/        provider independent assistant (openai-compatible, ollama, offline)
  tools/     tool/resource/prompt registry shared by MCP and agents
apps/
  web/       editor UI (React + Vite) and HTTP API server
  mcp/       Model Context Protocol server (stdio)
  cli/       `dsh-doc` command line interface
skills/      12 agent skills with routing and safety guidance
fixtures/    golden DOCX fixtures
test/        fixture, render and round-trip acceptance tests
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — components, data flow, invariants, decisions
- [FEATURES.md](FEATURES.md) — implemented feature inventory and honest status
- [SUPPORTED_FORMATS.md](SUPPORTED_FORMATS.md) — import/export matrix and fidelity notes
- [MCP.md](MCP.md) — tools, resources, prompts, security, configuration
- [AGENT_SKILLS.md](AGENT_SKILLS.md) — skills inventory, routing, integration
- [TESTING.md](TESTING.md) — fixture procedure, test suite, CI, regression policy
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow, adding adapters/tools/skills
- [SECURITY.md](SECURITY.md) — threat model and reporting

## Configuration

Copy `.env.example` to `.env` and adjust. Nothing sensitive is committed.

| Variable                            | Purpose                                           |
| ----------------------------------- | ------------------------------------------------- |
| `DSH_DOC_WORKSPACE`                 | Workspace root for documents and audit log        |
| `DSH_DOC_READ_ONLY`                 | `1` disables all mutations                        |
| `DSH_DOC_AUDIT_LOG`                 | Audit log path (JSON Lines)                       |
| `DSH_DOC_ALLOWED_ROOTS`             | Extra readable roots (path-delimited)             |
| `DSH_DOC_AI_PROVIDER`               | `offline` \| `openai` \| `ollama` (default: auto) |
| `DSH_DOC_AI_MODEL`                  | Model id for the selected provider                |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | OpenAI-compatible endpoint                        |
| `OLLAMA_HOST`                       | Local Ollama endpoint                             |
| `PORT`                              | Web server port                                   |

## License

MIT — see [LICENSE](LICENSE).
