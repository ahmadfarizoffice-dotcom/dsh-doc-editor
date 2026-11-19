# Testing

Everything below is executed locally and in CI. Commands are run from the
repository root after `pnpm install`.

```bash
pnpm test              # all suites (unit + integration + fixture + MCP)
pnpm run test:fixture  # golden DOCX acceptance tests
pnpm run test:unit     # engine/model/adapter unit tests
pnpm run test:integration
pnpm run test:mcp      # MCP protocol tests
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run build
node tools/check-skills.mjs
node tools/validate-mcp-schemas.mjs
```

## Latest executed results

Verified locally on 2026-11-18 (Node 24, Windows; CI runs the same commands on
Linux with Node 22):

| Command                                                       | Result                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `vitest run` (whole workspace)                                | **21 files / 126 tests passed**                                                                        |
| `tsc -p packages/core/tsconfig.json --noEmit`                 | pass                                                                                                   |
| `tsc -b packages/core apps/mcp apps/cli`                      | pass                                                                                                   |
| `tsc -p apps/web/tsconfig.json --noEmit` (client)             | pass                                                                                                   |
| `tsc -p apps/web/tsconfig.server.json --noEmit` (server)      | pass                                                                                                   |
| `eslint .`                                                    | 0 errors (warnings only for unused type imports)                                                       |
| `prettier --check .`                                          | pass                                                                                                   |
| `pnpm --filter <pkg> run build` (core, mcp, cli, web)         | pass                                                                                                   |
| `node tools/check-skills.mjs`                                 | OK — 12 skills, 50 canonical tools                                                                     |
| `node tools/validate-mcp-schemas.mjs`                         | OK — 50 tools, 8 resources, 8 prompts                                                                  |
| `node tools/build-dsh-plugin.mjs`                             | 3.97 MiB single-file engine, 50 tools, PDF smoke pass                                                  |
| `node tools/check-dsh-plugin.mjs`                             | OK — manifest, 14 files, 26 tools, locale/icon/detail checks                                           |
| `node --test dsh-plugin/test/*.mjs`                           | **102 tests passed** (host API, browse/workspace, late Web server, ribbon, logic, panel)               |
| `node tools/measure-ribbon.mjs`                               | ribbon height 50.31 px on all 7 tabs at 805 px viewport (= 1/16)                                       |
| `node tools/probe-panel.mjs`                                  | File backstage opens without changing height; folder open → title, workspace and chat session prepared |
| `node tools/check-integrations.mjs`                           | OK — Claude plugin (12 skills, 3 commands), Codex, Antigravity, OpenCode                               |
| DSH install (Plugins → Add plugin, GitHub link)               | `application: applied`; 26 `document_*` tools + Documents panel                                        |
| DSH Documents API (`/api/dsh-documents`)                      | bootstrap/op/ops/save/search, plus browse/workspace/open-path                                          |
| `node apps/cli/dist/main.js verify <fixture>`                 | 6/6 checks pass (9 pages, 21,704-byte PDF)                                                             |
| `node apps/cli/dist/main.js roundtrip <fixture>`              | text identical, 310→310 paragraphs, 3→3 sections                                                       |
| stdio MCP smoke (real `apps/mcp/dist/main.js` via SDK client) | 50 tools listed, create/read/resource/prompt all OK                                                    |
| web server smoke (`:4317`)                                    | health, create, list, export PDF/HTML, render PDF/HTML all 200                                         |

## The fixture family

### 1. Supplied acceptance fixture

`fixtures/docx_docs_renderer_feature_test_cases.docx` — the supplied golden
document. `test/fixture/` verifies:

- **import**: 3 sections, correct page geometry per section (Letter portrait,
  A4 landscape, A4 portrait), 310 paragraphs, 5 tables, header/footer
  inherited, 165 styles, numbering definitions.
- **structure**: section/block/table geometry and paragraph text/styles are
  compared against expectations.
- **layout/pagination**: pages are produced, every paragraph is reachable via
  `pageNumberByBlock`, header/footer text appears, the `PAGE` field resolves,
  and page text covers the document text.
- **render**: HTML contains page markers and document text; SVG is produced per
  page; PDF starts with `%PDF-`.
- **round-trip**: `DOCX → model → DOCX → model` preserves text exactly,
  paragraph count, section geometry, outline, header/footer blocks and table
  dimensions.

Run it and inspect artifacts:

```bash
pnpm run test:fixture
ls test-output/     # fixture-preview.html, fixture-page1.svg, fixture.pdf
```

### 2. Extended acceptance fixture

The supplied fixture's written checklist describes images, footnotes,
endnotes, comments, tracked changes, equations, text boxes and a generated TOC
but the file contains none of those constructs. `tools/extend-fixture.mjs`
generates `fixtures/docx_docs_renderer_feature_test_cases_extended.docx` from
hand-authored OOXML (independent of our exporter) with:

- inline and floating images (real PNG payloads, alt text, wrap)
- footnote and endnote with reference markers
- a review comment with range anchors
- tracked insertion and deletion by an author
- an OMML equation (fraction, superscript, radical)
- a text box shape with block content
- a TOC field with cached entries (converted to a generated block)
- bookmark + `PAGEREF` and `SEQ` fields, hyperlink, page border, page break
- a table with a repeating header row and a horizontally merged cell

`test/fixture/extended.test.ts` asserts every construct survives import, that
the layout places images/shapes/math/footnotes/TOC page numbers, and that the
round-trip preserves text, media, notes, comments, shapes, math, revisions and
table geometry.

Regenerate after changing the generator:

```bash
node tools/extend-fixture.mjs
```

## Test coverage matrix

| Spec area                                                                                         | Coverage                       | Where                                                         |
| ------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------- |
| DOCX import (text, styles, lists, tables, sections, header/footer, fields, hyperlink)             | ✅ automated                   | `test/fixture/smoke.test.ts`                                  |
| DOCX export + round-trip fidelity                                                                 | ✅ automated                   | `test/fixture/roundtrip.test.ts`                              |
| Images, notes, comments, revisions, math, text boxes, TOC                                         | ✅ automated                   | `test/fixture/extended.test.ts`                               |
| Pagination, line breaking, tables, floats, header/footer fields, footnote region                  | ✅ automated                   | `test/render/layout.test.ts`, `test/fixture/extended.test.ts` |
| HTML/SVG/PDF renderers                                                                            | ✅ automated                   | `test/render/layout.test.ts`                                  |
| Editing operations (insert/replace/delete/format/style/lists/tables/sections/notes/TOC/equations) | ✅ automated                   | model/operation tests, MCP protocol tests                     |
| Comments + tracked changes + accept/reject                                                        | ✅ automated                   | MCP protocol test, review unit tests                          |
| Compare documents                                                                                 | ✅ automated                   | model compare tests                                           |
| MCP tools/resources/prompts/security/audit                                                        | ✅ automated                   | `apps/mcp/test/protocol.test.ts`                              |
| Format adapters (HTML, Markdown, TXT, RTF, ODT, legacy DOC, XLSX/PPTX preview)                    | ✅ automated                   | `packages/core/test/formats/*`                                |
| Conversion engine capability matrix + loss reporting                                              | ✅ automated                   | `packages/core/test/formats/*` conversion tests               |
| Editor selection/ops/session                                                                      | ✅ automated                   | `apps/web/test/*`                                             |
| PDF import                                                                                        | ✖ not implemented (documented) | —                                                             |
| Google Docs API                                                                                   | ✖ not implemented (documented) | —                                                             |
| Collaborative editing                                                                             | ✖ not implemented (documented) | —                                                             |

## MCP schema validation

```bash
pnpm run build
node tools/validate-mcp-schemas.mjs
```

Validates `apps/mcp/dist/tools.json`: every name matches
`^document_[a-z_]+$`, every tool has an object input schema, names are unique,
and at least 40 tools are present. Missing manifests fail unless
`ALLOW_MISSING_MCP_MANIFEST=1`.

## Skills validation

```bash
node tools/check-skills.mjs
```

Checks frontmatter (name/description/allowed-tools/license), directory/name
agreement, all required sections in order, at least three example prompts, and
rejects placeholder text.

## Regression policy

A feature is only "done" when: the operation exists in the model, the renderer
shows it, import/export preserves it where the format supports it, MCP exposes
it where applicable, and a test exercises that path. Changes that alter
pagination must update the fixture expectations intentionally; a failing
fixture test is never silenced.

## CI

`.github/workflows/ci.yml` runs on push/PR:

1. **quality** — install (frozen lockfile), lint, typecheck, formatting check
2. **test** — build core, `pnpm test`, fixture regression, coverage artifact
3. **build** — full build, asserts `apps/web/dist-client/index.html` and
   `apps/mcp/dist/main.js`
4. **mcp-schemas** — tool manifest validation
5. **doc-fixture** — explicit fixture run, uploads render artifacts

CI fails when tests fail; there is no `continue-on-error` on test steps.

## Manual QA of the fixture

1. `pnpm run web:dev`, open the editor, import the fixture.
2. Compare page count with Word/Google Docs (the fixture itself asks for this).
3. Check the test-case register table renders with all 39 rows and 5 columns.
4. Check the header on every page, the footer page number, the landscape
   section, and the page break before "Page-break verification page".
5. Export PDF and compare print output with the preview.
6. Use the "Roundtrip" CLI command for a text-level fidelity check.
