# Contributing to the DSH Document Engine

Thanks for helping improve the document platform. This guide covers local
setup, the repository layout, the coding rules that keep documents safe and
reproducible, and the four extension points: format adapters, MCP tools,
skills, and shared tests.

The project is one engine behind four interfaces: the web editor, the MCP
server, native agent tool definitions and the skill pack. A change is only
complete when every interface that exposes it stays consistent.

## Prerequisites and local setup

- **Node.js >= 22** (`node --version`). Node 20 and older are unsupported.
- **pnpm** (the version is pinned by `packageManager` in `package.json`).
  Enable it with `corepack enable`, then run `pnpm install`.
- A C toolchain is not required; there are no native build dependencies.

```bash
corepack enable
pnpm install
pnpm run build:core        # compile the engine first; apps import it
pnpm test                  # unit + integration suites
```

`pnpm install --frozen-lockfile` is what CI runs. Commit lockfile changes with
any dependency change, never by hand.

## Repository layout

```
packages/core/          @dsh-doc/core - the engine
  src/model/            versioned JSON document model + deterministic operations
  src/docx/             OOXML (DOCX/DOTX/DOCM) import and export
  src/formats/          HTML, Markdown, RTF, ODT, legacy DOC, XLSX/PPTX preview
  src/layout/           pagination, line breaking, table and float layout
  src/render/           HTML, SVG and PDF renderers
  src/convert/          conversion engine, capability matrix, loss reporting
  src/service/          document service: workspace, sessions, undo/redo, tools
  src/ai/               provider-independent AI assistant (offline/openai/ollama)
  src/tools/            single MCP/agent tool registry with typed schemas
apps/mcp/               stdio MCP server (build output: dist/main.js, dist/tools.json)
apps/web/               editor UI (build output: dist-client/, dist-server/)
apps/cli/               command line interface (build output: dist/main.js)
skills/                 agent skill pack (one directory per skill)
tools/                  repository check scripts (Node, dependency-free)
test/fixture/           golden DOCX fixture regression tests
fixtures/               checked-in document fixtures
```

## Running the components

| Component        | Command                                    | Notes                                         |
| ---------------- | ------------------------------------------ | --------------------------------------------- |
| Editor (dev)     | `pnpm run web:dev`                         | Vite dev server for `apps/web`                |
| Editor (built)   | `pnpm run web:start`                       | Serves `apps/web/dist-server/server.js`       |
| MCP server       | `pnpm run build` then `pnpm run mcp:start` | `node apps/mcp/dist/main.js`, stdio transport |
| CLI              | `pnpm run build` then `pnpm run cli`       | `node apps/cli/dist/main.js`                  |
| Skills check     | `node tools/check-skills.mjs`              | Validates `skills/**`                         |
| MCP schema check | `node tools/validate-mcp-schemas.mjs`      | Needs `apps/mcp/dist/tools.json`              |

The MCP server talks over stdio and must not print anything but protocol
messages to stdout; log to stderr instead. Copy `.env.example` to `.env` for
local configuration. Never commit `.env`, keys, or document data.

## Coding standards

- **TypeScript strict**, ESM only, `module: NodeNext`. Relative imports end in
  `.js` (for example `import { documentText } from "./text.js"`) because the
  compiled output is ESM.
- **The model is the source of truth.** Features are represented as typed
  nodes in the versioned document model; renderers and exporters read the
  model. Do not serialize HTML into the model or round-trip through HTML to
  edit a document.
- **Edits are structured operations.** Mutations go through the model
  operations (insert/replace/delete/format/table/style) and are recorded for
  undo/redo. "Replace this region with this HTML string" is not an accepted
  operation.
- **Deterministic operations.** Given the same input document and the same
  operation, the result must be byte-stable except for fields explicitly
  documented as non-deterministic (timestamps, ids of newly created nodes).
  No `Math.random()`, `Date.now()`, locale-dependent sorting or filesystem
  order in document transforms.
- **Nothing is silently dropped.** Every element the adapter cannot interpret
  is preserved (raw/unknown) and reported in the compatibility report. A
  lossy conversion must say what was lost, where, and whether the original
  content survived. Tests assert `transparent`/`losses`, not just output size.
- **Capability reporting.** Import, export, conversion and AI features report
  what they actually support: full, partial, fallback or unsupported, with
  occurrences and notes. Never claim a capability that the adapter does not
  implement.
- **Typed failures.** Return the typed error codes the service already uses
  (for example `INVALID_RANGE`, `UNSUPPORTED_FORMAT`, `WORKSPACE_PATH_DENIED`,
  `AI_NOT_CONFIGURED`) instead of generic exceptions, and never swallow an
  error to keep a batch going.
- **Workspace confinement.** All file access goes through the workspace
  resolver. Do not join paths by hand, do not follow symlinks out of the root,
  and do not add a code path that reads outside `DSH_DOC_WORKSPACE`.
- **Never execute document content.** No macros, embedded scripts, OLE
  objects, external links or `altChunk` payloads. Preserve and report them.
- `pnpm run lint`, `pnpm run typecheck` and `pnpm run format:check` must pass.
  `pnpm run format` applies Prettier.

## Adding a format adapter

A format adapter translates between bytes and the document model. It lives in
`packages/core/src/formats/` (or `packages/core/src/docx/` for OOXML) and
registers itself in the adapter registry with the format ids and file
extensions it owns.

An adapter declares, per direction:

1. **Import** — package bytes plus a file name in, a `DocDocument` and a
   `CompatibilityReport` out. The report lists supported features with their
   level and occurrence count, every loss with its location and whether the
   content was preserved, and every unknown element.
2. **Export** — a `DocDocument` in, bytes plus warnings out. Export must not
   invent content: if the model cannot express something, report it.
3. **Capability matrix entry** — read/write/round-trip support, the fidelity
   level per feature family, and whether the format is **preview-only**. The
   preview-only adapters (spreadsheets, presentations, legacy binary formats)
   may be rendered and converted but must not be advertised as editable, and
   they must refuse structured edits with `CAPABILITY_UNAVAILABLE` rather than
   corrupting the file.

Checklist for a new adapter:

- [ ] Format id, extensions and MIME types added to the registry and to
      `document_list_formats`.
- [ ] Import produces a compatibility report; every unsupported construct is
      either preserved in the model or reported as a loss.
- [ ] Export writes valid output that the same adapter re-imports.
- [ ] Round-trip test: import → export → import preserves text, outline,
      structure and styles (see `test/fixture/roundtrip.test.ts`).
- [ ] Lossy-conversion test: unsupported input produces a non-empty `losses`
      array with useful locations, and `transparent` reflects reality.
- [ ] Malformed input test: truncated/corrupt bytes fail with `PARSE_FAILED`,
      no partial document and no unhandled rejection.
- [ ] Hostile-input test: traversal entries, oversized parts and unknown parts
      are rejected or preserved safely (see `SECURITY.md`).
- [ ] The conversion engine and `document_convert` expose the new pair, with
      losses surfaced in the result.

## Adding an MCP tool

There is exactly **one tool registry** (`packages/core/src/tools/`). The MCP
server, the CLI and the native agent tool definitions are generated from it;
never hand-write a tool schema in `apps/mcp`.

1. **Schema.** Define the input with zod next to the existing tools: named
   arguments, enums for closed sets, a short description, and a documented
   default for every optional field. The schema is the only source of the
   JSON Schema published to MCP clients.
2. **Handler.** Implement the behavior in the document service (not in the
   MCP transport layer) so the web UI, CLI and MCP server share it. Resolve
   the document id through the session, validate ranges against the live
   model, and return the same envelope for every tool: result payload,
   warnings, compatibility/loss notes where relevant, and a typed error code
   on failure.
3. **Registry entry.** Register name, title, description, input schema,
   output description, and the resource links the tool touches. Tool names
   follow the `document_<verb>_<noun>` convention of the existing inventory.
4. **Manifest.** Build the server; `apps/mcp/dist/tools.json` must contain the
   new tool with a JSON Schema `object` input schema. Run
   `node tools/validate-mcp-schemas.mjs` (requires the build).
5. **Resources and prompts.** If the tool changes what clients see, update the
   `dshdoc://` resource payloads and the MCP prompt templates that reference
   it.
6. **Tests.** Unit-test the schema (rejects missing/invalid arguments) and the
   handler (happy path, invalid range, read-only mode, workspace escape).
   Add a transport-level test under `test/mcp/` that lists the manifest and
   calls the tool over the shared service.
7. **Documentation.** Update the tool inventory wherever the project publishes
   it, and mention optional configuration (AI provider, read-only mode,
   preview-only formats) in the description.

## Adding a skill

Skills live in `skills/<kebab-case-name>/SKILL.md`. They are instructions for
an agent, not code, so accuracy matters more than volume.

1. Create `skills/<name>/SKILL.md` with frontmatter:

   ```yaml
   ---
   name: document-reader
   description: Reads and navigates an open document when the user needs content, structure or search results.
   allowed-tools: document_open, document_get_text, document_get_outline
   license: MIT
   ---
   ```

   `name` must equal the directory, `description` is one third-person sentence
   that says when to use the skill, and `allowed-tools` lists only canonical
   MCP tool names (a comma-separated line).

2. Include every required section, in order: `## Description`,
   `## When to use it`, `## Supported input formats`, `## Required tools`,
   `## Instructions`, `## Example prompts`, `## Expected outputs`,
   `## Error handling`, `## Limitations`, `## Safety considerations`.
3. The Required tools table must document exactly the tools in
   `allowed-tools`. Number the instructions, resolve document ids explicitly,
   validate ranges from tool results, and end by re-reading the document to
   verify the change.
4. Do not invent argument names. If a schema detail is not stable, describe
   the input generically ("the range selector returned by `document_search`").
5. Add the skill to the routing table in `skills/README.md`.
6. Run `node tools/check-skills.mjs` and make it pass; CI runs it too.

## Testing requirements

| Layer       | Location                         | What it must cover                                                                      |
| ----------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| Unit        | `packages/**/test`               | Model operations, parsers, layout math, schemas; deterministic and fast                 |
| Integration | `test/`                          | Service workflows: open → edit → save, workspace confinement, read-only mode, undo/redo |
| Fixture     | `test/fixture/`                  | Golden DOCX regression over `fixtures/`; must stay green                                |
| Round-trip  | `test/fixture/roundtrip.test.ts` | import → export → import equality of text, structure, outline                           |
| MCP         | `test/mcp/`                      | Tool manifest, argument validation, error codes over the shared service                 |

Commands: `pnpm test` (all), `pnpm run test:unit`, `pnpm run test:integration`,
`pnpm run test:fixture`, `pnpm run test:mcp`, `pnpm run test:render`,
`pnpm run coverage`.

Rules:

- New behavior needs a test that fails without the change. A bug fix needs a
  test for the bug, not just for the happy path.
- Fixture changes are reviewed like code: if a golden fixture must change,
  explain why in the pull request and keep the old behavior covered.
- Do not weaken an assertion, skip a fixture, or add `.only`/`.skip` to get CI
  green.
- Run the checks CI runs before opening a pull request: `pnpm run lint`,
  `pnpm run typecheck`, `pnpm run format:check`, `pnpm test`, and
  `node tools/check-skills.mjs`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>
```

- Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`,
  `chore`, `security`.
- Scopes: `core`, `model`, `docx`, `formats`, `layout`, `render`, `convert`,
  `service`, `ai`, `mcp`, `web`, `cli`, `skills`, `tools`, `ci`, `docs`.
- Summary in the imperative mood, lowercase, no trailing period, <= 72
  characters. Explain the "why" in the body; reference issues with
  `Refs: #123`.
- Examples:
  - `feat(mcp): expose document_edit_table with typed row selectors`
  - `fix(docx): preserve unknown w:sdt blocks instead of dropping them`
  - `security(service): reject symlink escapes in workspace resolver`
  - `docs(skills): clarify preview-only XLSX capability in reader skill`

Breaking changes use `!` and a `BREAKING CHANGE:` footer that states the
migration.

## Pull request checklist

- [ ] The change does what the linked issue asks and nothing unrelated.
- [ ] `pnpm run lint`, `pnpm run typecheck`, `pnpm run format:check` pass.
- [ ] `pnpm test` passes, including the fixture and round-trip suites.
- [ ] `node tools/check-skills.mjs` passes when `skills/` changed.
- [ ] MCP tool changes rebuilt `apps/mcp/dist/tools.json` and passed
      `node tools/validate-mcp-schemas.mjs`.
- [ ] No document element is silently dropped; compatibility/loss reporting is
      updated and tested.
- [ ] No new capability is claimed without an adapter or test behind it.
- [ ] No secrets, tokens, real customer documents or audit logs are committed.
- [ ] Security-relevant changes follow `SECURITY.md` and include a regression
      fixture.
- [ ] Public behavior changes are described in the pull request body,
      including any optional configuration they depend on.
