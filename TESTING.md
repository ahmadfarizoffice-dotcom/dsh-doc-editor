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

## Quality gates and how to run them

The rulebook is [`docs/QUALITY-GATES.md`](docs/QUALITY-GATES.md): gate
definitions, coverage floors, the MC/DC approximation and the acceptance rules.
The go/no-go instrument is
[`docs/RELEASE-CHECKLIST.md`](docs/RELEASE-CHECKLIST.md). Read both before
calling anything "release ready".

### Commands

| What                         | Command                                                                                                                                     | Notes                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Core/apps/fixture suites     | `pnpm test` (or `npx --no-install vitest run`)                                                                                              | `pnpm` is absent on some Windows machines; the `npx` form is verified here. |
| Plugin suite                 | `node --test "dsh-plugin/test/*.test.mjs"` (or `pnpm run test:plugin`)                                                                      | Uses Node's built-in runner, not vitest.                                    |
| Fixture regression           | `pnpm run test:fixture`                                                                                                                     | 5 tests against the golden DOCX.                                            |
| Render regression            | `npx --no-install vitest run test/render`                                                                                                   | 1 test, 9 pages, HTML/SVG/PDF.                                              |
| Coverage gate                | `node tools/coverage.mjs` (or `pnpm run coverage:gate`)                                                                                     | Real v8 coverage; exits 0 when the tooling is genuinely missing.            |
| Coverage gate (machine)      | `node tools/coverage.mjs --json`                                                                                                            | JSON only; safe to pipe.                                                    |
| Release docs gate            | `node tools/coverage.mjs --docs` (or `pnpm run quality:docs`)                                                                               | Validates both docs and their required headings.                            |
| Seeded quality suites        | `FUZZ_REPORT_DIR=coverage/fuzz FUZZ_SEED=1337 FUZZ_CASES=150 npx --no-install vitest run packages/core/test/fuzz` (or `pnpm run test:fuzz`) | Four suites (property, differential, anomaly, MC/DC); currently red.        |
| Real-browser ribbon evidence | `node tools/measure-ribbon.mjs --url http://127.0.0.1:4399/ --height 900`                                                                   | Needs Chrome and a served app.                                              |
| Real-browser panel evidence  | `node tools/probe-panel.mjs --url http://127.0.0.1:4399/ --height 900`                                                                      | Needs Chrome and a served app.                                              |

`tools/e2e-panel.mjs` is referenced in earlier discussions but **does not
exist** in this repository today. The CDP evidence comes from
`tools/measure-ribbon.mjs` and `tools/probe-panel.mjs`; when an `e2e-panel.mjs`
lands, run it as `node tools/e2e-panel.mjs --url http://127.0.0.1:4399/` and add
its counts here.

Four seeded quality suites **do** exist under `packages/core/test/fuzz/`:
property fuzzing (`roundtrip.property.test.ts`, 150 documents), differential
(`differential.test.ts`, 150 op scripts comparing service calls with the tool
layer), anomaly/fault injection (`anomaly.test.ts`, 150 hostile inputs with a
10 s per-case limit) and MC/DC decision tables (`mcdc.test.ts`, 8 cases over 5
predicates). All four are currently red; see the measured rows below. Set
`FUZZ_REPORT_DIR=coverage/fuzz` to make each suite write a case-summary JSON.
The CI `fuzz` job walks `test/quality`, `test/fuzz` and
`packages/core/test/fuzz` and runs what it finds.

### Measured results

Everything below was executed on 2026-11-19 (Windows, Node `v24.21.0`,
vitest `3.2.7`, `@vitest/coverage-v8` `3.2.7`). Items without a measurement are
marked `NOT MEASURED` — they were not run, and guessing is not evidence.

| Command                                                                                                           | Result                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx --no-install vitest run` (baseline, 17:11)                                                                   | **21 files / 126 tests passed**, 0 failed, 0 skipped, exit 0                                                                                                                                                                      |
| `node --test "dsh-plugin/test/*.test.mjs"`                                                                        | **tests 102, pass 102, fail 0, skipped 0, todo 0**, exit 0                                                                                                                                                                        |
| `node tools/coverage.mjs` (documented baseline run)                                                               | **status `ok`, all floors met, exit 0** (numbers below)                                                                                                                                                                           |
| `node tools/coverage.mjs --docs`                                                                                  | `release docs OK: 2 files, 16 required headings present.`, exit 0                                                                                                                                                                 |
| `node tools/coverage.mjs` (whole workspace, 17:50)                                                                | **27 files / 603 tests: 4 failed, 599 passed, exit 1**, no coverage numbers emitted — the four failures are the quality suites; see the note below                                                                                |
| `node tools/build-dsh-plugin.mjs`                                                                                 | `NOT MEASURED` — building writes `dsh-plugin/**`, outside this task's write scope                                                                                                                                                 |
| Plugin bundle size budget (≤ 6 MiB)                                                                               | `NOT MEASURED` (depends on the build above)                                                                                                                                                                                       |
| `node tools/measure-ribbon.mjs` / `probe-panel.mjs`                                                               | `NOT MEASURED` — needs Chrome plus a served app                                                                                                                                                                                   |
| `FUZZ_REPORT_DIR=coverage/fuzz FUZZ_SEED=1337 FUZZ_CASES=150 npx --no-install vitest run packages/core/test/fuzz` | **4 files failed, exit 1**: property 108/150 passed (42 failed), differential 2/150 (137 failed, 11 documented), anomaly 69/150 (81 failed), MC/DC 4/8 (4 failed)                                                                 |
| `npx --no-install vitest run packages/core/test/engine`                                                           | **1 failed / 470 passed, exit 1**; the failing case assumes no LibreOffice on the real PATH (this machine has one installed). It passed in the 17:50 whole-suite run, so treat it as environment-dependent, not a stable failure. |
| Differential / chaos suites                                                                                       | measured above (both red)                                                                                                                                                                                                         |
| 150-case per-feature suites                                                                                       | `NOT MEASURED` — no per-feature suite exists (the 150-case fuzz suite covers documents, not panel features)                                                                                                                       |

Coverage from the documented baseline run (`QUALITY-GATES.md` §7.3 lists the
exact file list):

| Scope                       | Statements | Branches | Functions | Lines  |
| --------------------------- | ---------- | -------- | --------- | ------ |
| `packages/core/src/model`   | 49.18%     | 69.90%   | 51.37%    | 49.18% |
| `packages/core/src/service` | 41.13%     | 58.04%   | 51.00%    | 41.13% |
| `packages/core/src` (all)   | 69.19%     | 67.73%   | 72.79%    | 69.19% |

**Moving-tree warning.** Other agents were writing to this same checkout while
these numbers were taken. The tree grew from 21 to 27 vitest test files during
authoring: the LibreOffice suites (`packages/core/test/engine/libreoffice*.test.ts`,
now largely green) and the four seeded quality suites in
`packages/core/test/fuzz/` (all red). Those keep the whole-workspace run from
going green on this machine, so `node tools/coverage.mjs` correctly exits 1 with
`status: "tests_failed"` instead of reporting numbers. The coverage table above
is therefore from the 21-file baseline run, which excludes those suites. Re-run
`node tools/coverage.mjs` once the tree is green and ratchet the floors in
`docs/QUALITY-GATES.md` upward if coverage improved.

### What cannot be automated here

- **LibreOffice detection/conversion** depends on an optional external binary
  and on Windows/Linux process semantics; `node tools/libreoffice-smoke.mjs`
  reports honestly when the engine is absent, but it is a smoke tool, not a
  gate.
- **Ribbon drag, icon colours, chooser, shortcuts, selection and typing** need
  a human looking at a rendered panel. The CDP probes measure geometry; the
  human steps live in `docs/RELEASE-CHECKLIST.md` §5 and are `NOT MEASURED`
  unless an operator runs them.
- **MC/DC** cannot be measured by JS coverage tools. It is approximated by
  decision tables (`QUALITY-GATES.md` §5); today
  `coverage/decision-table.json` is an explicit empty stub.
