# Release Checklist

Aviation-style go/no-go instrument for a `dsh-doc-editor` release. The rulebook
behind these items is [`docs/QUALITY-GATES.md`](QUALITY-GATES.md); read it
before signing anything.

A release is **GO** only when every blocking item is `PASS`. Any `FAIL` is
**NO-GO**. Any item that is `BLOCKED` — including every gate whose harness does
not exist yet — is **NO-GO** unless the release manager records a written,
dated waiver in §9 explaining why shipping without it is acceptable. Partial
passes do not exist: an item is run, and it passes or it does not.

Nothing in this document is decorative. Each row names the exact command or the
exact ordered steps, and the observable that proves it. "Verify manually" is
never a step.

## 1. How to use this checklist

1. Read §8 **Known limitations** first. Signing the sheet asserts you accept
   them.
2. Work top to bottom. Do not skip a section because a later one passed.
3. For every row: run the command (or the numbered steps), observe the result,
   then fill `Result` with `PASS`, `FAIL` or `BLOCKED`.
4. Fill `Evidence command` with what you actually ran, `Artifact SHA-256` with
   the digest the command printed (`Get-FileHash` / `sha256sum`), and `Date`
   with the run date. An empty evidence cell is a `FAIL`.
5. If a row is `BLOCKED`, record the waiver in §9. Do not mark it `PASS`.
6. Only measured output goes in the sheet. This file's baseline numbers were
   produced on 2026-11-19 (Windows, Node v24.21.0); your release re-measures
   them, and a different count is a finding, not a typo.

Commands are written for the repository root. On this machine `pnpm` was not on
`PATH`, so the verified equivalent invocations are shown as
`npx --no-install …`; CI runs the `pnpm` form with `pnpm install
--frozen-lockfile` already done.

## 2. Pre-flight

| ID    | Check                                    | Exact command or ordered steps                                                                                              | Expected observable                                                                                                                                                                                                                                                    | Result | Evidence command | Artifact SHA-256 | Date |
| ----- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- | ---------------- | ---- |
| PF-01 | Working tree is clean                    | `git status --porcelain`                                                                                                    | Prints nothing. Any line means uncommitted work ships or is lost: STOP.                                                                                                                                                                                                |        |                  |                  |      |
| PF-02 | Runtime version is supported             | `node -v`                                                                                                                   | `v22.*` or newer (CI uses Node 22; baseline measured on v24.21.0).                                                                                                                                                                                                     |        |                  |                  |      |
| PF-03 | Dependencies match the lockfile          | `pnpm install --frozen-lockfile`                                                                                            | Exit code 0; no "lockfile is out of date" message.                                                                                                                                                                                                                     |        |                  |                  |      |
| PF-04 | Core suites pass with no silent skips    | `npx --no-install vitest run`                                                                                               | 0 failed and 0 skipped, exit code 0. Record the file/test counts; the pre-concurrent baseline was `Test Files 21 passed (21)` / `Tests 126 passed (126)`, and a larger count is expected once the LibreOffice suite lands. A skip without a recorded reason is a FAIL. |        |                  |                  |      |
| PF-05 | Plugin suite passes with no silent skips | `node --test "dsh-plugin/test/*.test.mjs"`                                                                                  | Summary shows `tests 102`, `pass 102`, `fail 0`, `skipped 0`, `todo 0`; exit code 0.                                                                                                                                                                                   |        |                  |                  |      |
| PF-06 | Deterministic core run                   | Run `npx --no-install vitest run` twice and compare the `Tests` and `Test Files` counts                                     | Both runs report the identical counts and 0 skips. Any difference is non-determinism: FAIL.                                                                                                                                                                            |        |                  |                  |      |
| PF-07 | Seeded fuzz/corpus runs                  | `FUZZ_REPORT_DIR=coverage/fuzz FUZZ_SEED=1337 FUZZ_CASES=150 npx --no-install vitest run packages/core/test/fuzz` run twice | Both runs exit 0 with identical seed/case counts per suite. **BLOCKED today**: all four suites are red, and a red seeded run proves nothing about determinism. Record the waiver in §9; do not mark PASS.                                                              |        |                  |                  |      |
| PF-08 | Release docs satisfy the gate            | `node tools/coverage.mjs --docs`                                                                                            | Prints `release docs OK: 2 files, 16 required headings present.` and exits 0.                                                                                                                                                                                          |        |                  |                  |      |
| PF-09 | Coverage floors parse from the doc       | `node tools/coverage.mjs --json`                                                                                            | Exit code 0 or 1 (never 2); the JSON contains a `coverageFloors`-derived `floors` array with 3 scopes. Exit 2 means the doc block is broken: STOP.                                                                                                                     |        |                  |                  |      |

## 3. Build

| ID   | Check                               | Exact command or ordered steps                                                                                                  | Expected observable                                                                                                                                                                                                        | Result | Evidence command | Artifact SHA-256 | Date |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- | ---------------- | ---- |
| B-01 | Core typechecks                     | `npx --no-install tsc -p packages/core/tsconfig.json --noEmit`                                                                  | Exit code 0 and no diagnostics.                                                                                                                                                                                            |        |                  |                  |      |
| B-02 | MCP typechecks                      | `npx --no-install tsc -p apps/mcp/tsconfig.json --noEmit`                                                                       | Exit code 0 and no diagnostics.                                                                                                                                                                                            |        |                  |                  |      |
| B-03 | CLI typechecks                      | `npx --no-install tsc -p apps/cli/tsconfig.json --noEmit`                                                                       | Exit code 0 and no diagnostics.                                                                                                                                                                                            |        |                  |                  |      |
| B-04 | Web client and server typecheck     | `npx --no-install tsc -p apps/web/tsconfig.json --noEmit` then `npx --no-install tsc -p apps/web/tsconfig.server.json --noEmit` | Both exit 0, no diagnostics.                                                                                                                                                                                               |        |                  |                  |      |
| B-05 | Workspace builds                    | `pnpm run build`                                                                                                                | Exit code 0; `apps/web/dist-client/index.html` and `apps/mcp/dist/main.js` both exist afterward.                                                                                                                           |        |                  |                  |      |
| B-06 | Build artifacts exist               | `Test-Path apps/web/dist-client/index.html; Test-Path apps/mcp/dist/main.js` (Windows) or `test -f …` (POSIX)                   | Both print `True` / both `test` calls exit 0.                                                                                                                                                                              |        |                  |                  |      |
| B-07 | DSH plugin bundle builds            | `node tools/build-dsh-plugin.mjs`                                                                                               | Exit code 0; prints the single-file engine size in MiB and a PDF smoke result.                                                                                                                                             |        |                  |                  |      |
| B-08 | Bundle stays inside its size budget | `Get-Item dsh-plugin/engine.js \| Select-Object Length` (Windows) or `stat -c%s dsh-plugin/engine.js` (POSIX)                   | Byte count at or below **6,291,456 bytes (6 MiB)**. Basis: the last recorded engine size was 3.97 MiB (`TESTING.md`, not re-measured by the authoring agent), so 6 MiB gives roughly 50% headroom. Record the exact bytes. |        |                  |                  |      |
| B-09 | Plugin bundle validates             | `node tools/check-dsh-plugin.mjs`                                                                                               | Exit code 0; reports the manifest, 14 files and 26 tools as OK.                                                                                                                                                            |        |                  |                  |      |
| B-10 | Ellipsis/lint sanity                | `npx --no-install eslint .`                                                                                                     | Exit code 0 with zero errors (warnings are acceptable and recorded).                                                                                                                                                       |        |                  |                  |      |

## 4. Automated evidence

Baseline recorded 2026-11-19 (Windows, Node v24.21.0). Re-measure at release.

| ID    | Check                                     | Exact command                                                                                                     | Expected observable                                                                                                                                                                                                                                                                                                                                                   | Result | Evidence command | Artifact SHA-256 | Date |
| ----- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- | ---------------- | ---- |
| AE-01 | Core/apps/fixture suites pass             | `npx --no-install vitest run`                                                                                     | 0 failed, 0 skipped, exit 0. Record the exact counts; the pre-concurrent baseline was `Test Files 21 passed (21)`, `Tests 126 passed (126)`. At authoring time this row is **BLOCKED**: the tree grew to 27 files / 603 tests, of which the four quality suites fail (599 pass), and one LibreOffice case is environment-dependent. See `QUALITY-GATES.md` §7.4–§7.5. |        |                  |                  |      |
| AE-02 | Plugin suite passes                       | `node --test "dsh-plugin/test/*.test.mjs"`                                                                        | `tests 102`, `pass 102`, `fail 0`, `skipped 0`, exit 0.                                                                                                                                                                                                                                                                                                               |        |                  |                  |      |
| AE-03 | Golden DOCX fixture regression            | `npx --no-install vitest run test/fixture`                                                                        | 5 tests pass; output states 3 sections, 310 paragraphs, 5 tables, 165 styles.                                                                                                                                                                                                                                                                                         |        |                  |                  |      |
| AE-04 | Render regression (9 pages, HTML/SVG/PDF) | `npx --no-install vitest run test/render`                                                                         | 1 test passes; output states `pages: 9`, `warnings: 0`, PDF starts `%PDF-`.                                                                                                                                                                                                                                                                                           |        |                  |                  |      |
| AE-05 | Coverage gate meets every floor           | `node tools/coverage.mjs`                                                                                         | Exit 0 and every scope row says `PASS`; the printed table covers `packages/core/src`, `…/model`, `…/service`. If exit 0 with `status: unavailable`, coverage tooling is missing: that is not a pass, record the waiver. If the whole-suite run is red it exits 1 with `status: tests_failed` and reports no numbers — fix the tests first.                            |        |                  |                  |      |
| AE-06 | Fuzz suite (seeded, 150 cases)            | `FUZZ_REPORT_DIR=coverage/fuzz FUZZ_SEED=1337 FUZZ_CASES=150 npx --no-install vitest run packages/core/test/fuzz` | Exit 0 with 4 node:test files passed. **RED today**: exit 1; property 108/150 passed, 42 failed. Record as BLOCKED; never as PASS.                                                                                                                                                                                                                                    |        |                  |                  |      |
| AE-07 | Differential suite                        | same command as AE-06                                                                                             | Exit 0 with no unexplained divergence. **RED today**: 2/150 passed, 137 failed, 11 documented. Waiver required.                                                                                                                                                                                                                                                       |        |                  |                  |      |
| AE-08 | Chaos / anomaly run under a 10 s timeout  | same command as AE-06                                                                                             | Exit 0 with zero crashes/hangs and typed errors. **RED today**: 69/150 passed, 81 failed. Waiver required.                                                                                                                                                                                                                                                            |        |                  |                  |      |
| AE-09 | MC/DC decision tables complete            | `node tools/coverage.mjs` then read `coverage/decision-table.json`                                                | File exists. Today it must say `"status": "unavailable"` with `"predicateCount": 0`, because `packages/core/test/fuzz/mcdc.test.ts` prints tables but writes only a case summary. `BLOCKED`; never hand-edited to look complete.                                                                                                                                      |        |                  |                  |      |
| AE-10 | MCP tool manifest validates               | `node tools/validate-mcp-schemas.mjs` (after `pnpm run build`)                                                    | Exit 0; reports the tool/resource/prompt counts.                                                                                                                                                                                                                                                                                                                      |        |                  |                  |      |

### 150-case per-feature suites

These are required by the quality policy and **do not exist yet**. The command
column is the reserved convention from `QUALITY-GATES.md` §8; every row is
`BLOCKED` until the file exists and reports 150 passing cases. Do not replace
these rows with the smaller suites that do exist — those are covered separately
in §5 and are not a substitute.

| ID   | Feature                        | Exact command (reserved convention)                                | Expected observable                                      | Result | Evidence command | Artifact SHA-256 | Date |
| ---- | ------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------- | ------ | ---------------- | ---------------- | ---- |
| F-01 | Ribbon height drag and persist | `npx --no-install vitest run test/quality/ribbon.150.test.ts`      | 150 passing cases, 0 failed. File absent today: BLOCKED. |        |                  |                  |      |
| F-02 | Icons 22 px and theme colours  | `npx --no-install vitest run test/quality/icons.150.test.ts`       | 150 passing cases, 0 failed. File absent today: BLOCKED. |        |                  |                  |      |
| F-03 | Open from any folder / Ctrl+O  | `npx --no-install vitest run test/quality/open-folder.150.test.ts` | 150 passing cases, 0 failed. File absent today: BLOCKED. |        |                  |                  |      |
| F-04 | Shortcuts inside the panel     | `npx --no-install vitest run test/quality/shortcuts.150.test.ts`   | 150 passing cases, 0 failed. File absent today: BLOCKED. |        |                  |                  |      |
| F-05 | Multi-paragraph selection      | `npx --no-install vitest run test/quality/selection.150.test.ts`   | 150 passing cases, 0 failed. File absent today: BLOCKED. |        |                  |                  |      |
| F-06 | Typing integrity               | `npx --no-install vitest run test/quality/typing.150.test.ts`      | 150 passing cases, 0 failed. File absent today: BLOCKED. |        |                  |                  |      |

## 5. Manual and visual evidence

The CDP tools drive a real headless Chromium; the plugin unit suite asserts the
DOM/geometry contracts with a stubbed environment. Neither replaces a human
looking at the panel, so each item below pairs an automated command with
ordered human steps. All steps assume the DSH app is running with the Documents
plugin installed and the panel open, and the web dev server is reachable
(`pnpm run web:dev`).

| ID    | Check                                    | Exact command or ordered steps                                                                                                                                                                                                                                                                               | Expected observable                                                                                                                                                                                                                                                                                                                             | Result | Evidence command | Artifact SHA-256 | Date |
| ----- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------- | ---------------- | ---- |
| MV-01 | Ribbon height drag and persist           | 1. `node tools/measure-ribbon.mjs --url http://127.0.0.1:4399/ --height 900`. 2. In the panel, drag the ribbon's top edge down ~40 px. 3. Reload the app (F5). 4. Drag the top edge back up to the original position.                                                                                        | Step 1 prints JSON where the height is identical on all 7 tabs and equals 1/16 of the viewport (50.31 px at 805 px is the recorded reference). Step 3: the dragged height persists after reload. Step 4: height returns and persisting is symmetric.                                                                                            |        |                  |                  |      |
| MV-02 | Icons 22 px, theme colours               | 1. `node --test "dsh-plugin/test/ribbon.test.mjs"`. 2. In the panel, hover a tool icon; inspect it in DevTools. 3. Switch the app theme light→dark→light.                                                                                                                                                    | Step 1: all ribbon tests pass, including "tool icons are 22px with the 1.9 stroke and currentColor" and the palette-follows-theme-tokens test. Step 2: computed width and height are `22px`, stroke is `1.9`, fill/stroke resolve to `currentColor`. Step 3: icons change colour with the theme in both directions and never become invisible.  |        |                  |                  |      |
| MV-03 | Open from any folder, chooser and Ctrl+O | 1. `node tools/probe-panel.mjs --url http://127.0.0.1:4399/ --height 900`. 2. In the panel press Ctrl+O, pick a folder outside the default documents directory, open a `.docx`. 3. Open the File tab → "Open file…" and repeat with a different folder. 4. Use the native folder picker with a third folder. | Step 1 prints that the File backstage opens without changing ribbon height and that opening from a folder prepares the workspace and chat session. Steps 2–4: each route opens the document, the title matches the file, the workspace switches to that folder, and a chat session is prepared. No route is limited to the default folder.      |        |                  |                  |      |
| MV-04 | Shortcuts inside the panel               | 1. `node --test "dsh-plugin/test/logic.test.mjs"`. 2. In the panel press Ctrl+O, then Escape. 3. Focus the ribbon and use the keyboard resize keys (down grows, up shrinks).                                                                                                                                 | Step 1 passes, including "Ctrl+O opens the in-panel file chooser from the panel root", "Escape closes the File backstage even when focus is outside it" and "keyboard resize follows the drag direction". Step 2: the chooser opens and Escape closes it. Step 3: height grows on down, shrinks on up, and matches the drag behaviour.          |        |                  |                  |      |
| MV-05 | Multi-paragraph selection                | 1. `npx --no-install vitest run apps/web/test/selection.test.ts` (8 cases). 2. In the panel, press the mouse at the start of a paragraph, drag across at least three paragraphs, release. 3. Apply bold. 4. Press Backspace.                                                                                 | Step 1: 8 tests pass. Step 2: the highlight spans all three paragraphs, including the paragraph marks, and the selection readout reports the full range. Step 3: bold applies to the whole selected range. Step 4: the selected text is removed and the document remains structurally valid (no orphan blocks, undo restores it).               |        |                  |                  |      |
| MV-06 | Typing integrity                         | 1. `npx --no-install vitest run apps/web/test/editing.test.ts` (13 cases). 2. Type two paragraphs in the panel. 3. Press Shift+Enter mid-paragraph. 4. Type 200 characters quickly. 5. Undo twice.                                                                                                           | Step 1: 13 tests pass. Step 2: characters appear in order, no dropped or duplicated keystrokes. Step 3: a soft line break appears inside the same paragraph (rendered as a real `<br>`), while plain Enter still splits paragraphs. Step 4: all 200 characters are present in order. Step 5: undo reverses cleanly to the expected prior state. |        |                  |                  |      |

## 6. Packaging

| ID    | Check                       | Exact command or ordered steps                                                                              | Expected observable                                                                                   | Result | Evidence command | Artifact SHA-256 | Date |
| ----- | --------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ | ---------------- | ---------------- | ---- |
| PK-01 | Version bumped              | Read `version` in `dsh-plugin/package.json`; compare with the last released tag. Bump it if unchanged.      | Version is strictly greater than the last released version and matches the release notes.             |        |                  |                  |      |
| PK-02 | Install from GitHub         | In DSH: Plugins → Add plugin → GitHub link → the repository URL → install.                                  | Install completes and reports `application: applied`.                                                 |        |                  |                  |      |
| PK-03 | Bundle activates            | After install, open the Documents panel from the sidebar.                                                   | The panel opens with the seven-tab ribbon and a document can be created.                              |        |                  |                  |      |
| PK-04 | 26+ tools registered        | In a new chat, ask the agent to list its `document_*` tools; or run `node tools/check-dsh-plugin.mjs`.      | At least 26 `document_*` tools are listed; `check-dsh-plugin.mjs` exits 0 and reports 26 tools.       |        |                  |                  |      |
| PK-05 | Install digest recorded     | `Get-FileHash dsh-plugin/engine.js -Algorithm SHA256` (Windows) or `sha256sum dsh-plugin/engine.js` (POSIX) | One SHA-256 is recorded in the sign-off row. Releases with different digests are different artifacts. |        |                  |                  |      |
| PK-06 | Uninstall leaves no residue | Remove the plugin from DSH, restart, reopen Plugins.                                                        | The plugin is gone from the list, the Documents panel no longer appears, and no error is logged.      |        |                  |                  |      |

## 7. Rollback

Rollback must be rehearsed before it is needed. If the rollback path fails, the
release is not shippable regardless of other results.

| ID    | Check                            | Exact command or ordered steps                                                                                 | Expected observable                                                                                          | Result | Evidence command | Artifact SHA-256 | Date |
| ----- | -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ | ---------------- | ---------------- | ---- |
| RB-01 | Previous bundle is available     | Confirm the previous release's `engine.js` digest and install source are recorded (§9 of the prior checklist). | A previous version and digest exist and can be identified without guessing.                                  |        |                  |                  |      |
| RB-02 | Disable the bundle               | In DSH: Plugins → disable the Documents bundle → restart the app.                                              | The panel disappears, the app starts cleanly, and no Documents-related error appears in the log.             |        |                  |                  |      |
| RB-03 | Reinstall the previous version   | Install the recorded previous version from its recorded source.                                                | Install reports `application: applied`; the 26+ tools and panel return; behaviour matches the prior release. |        |                  |                  |      |
| RB-04 | Workspace data survives rollback | After RB-03, open a document created during this release cycle.                                                | The document opens with its text intact. Data loss during rollback is a hard NO-GO.                          |        |                  |                  |      |
| RB-05 | Rollback recorded                | Write the rollback version, digest and date into §9.                                                           | The sign-off sheet shows a completed rollback rehearsal, not an intention.                                   |        |                  |                  |      |

## 8. Known limitations

**Read this section before signing.** Signing asserts these are understood and
accepted for this release. They are limitations, not bugs to be silently fixed
in the checklist.

- **LibreOffice is optional and is installed on this machine.**
  `C:\Program Files\LibreOffice\program\soffice.exe` exists while `soffice` is
  not on `PATH`; the engine's real-PATH probe finds the installed copy, so the
  case asserting "unavailable engine (missing override with real PATH)" fails
  here. That is an environment assumption, not a product regression, but it
  means local whole-suite runs are not hermetic. Legacy `.doc`/format paths
  degrade or refuse when no engine is available; the converter reports that
  instead of crashing.
- **PDF import is unsupported.** PDFs can be exported, not imported.
- **`.gdoc` requires Google Drive.** Local `.gdoc` pointer files cannot resolve
  without Drive access; there is no offline fallback.
- **macOS is untested.** All measured evidence in this repository is Windows
  locally and Linux in CI. Nothing here certifies macOS behaviour.
- **Collaborative editing does not exist.** No real-time co-editing, presence
  or conflict resolution.
- **PDF export depends on the renderer.** If the PDF renderer is unavailable,
  conversion fails with `PDF_RENDERER_UNAVAILABLE` rather than producing a
  degraded file.
- **Plugin tests are not a real browser.** `node --test` runs the plugin suite
  with stubbed DOM/geometry. Real rendering is covered only by the CDP probes
  (which need Chrome and a served app) and by the human steps in §5.
- **The 100% coverage target is unmet.** Measured 2026-11-19: `model` 49.18%
  statements, `service` 41.13% statements. The enforced floors are lower than
  100%; see `QUALITY-GATES.md` §4.
- **A whole-suite run is currently not green on this machine.** The suite set
  grew from 21 files / 126 tests to 27 vitest test files / 603 tests while this
  checklist was written. In the last full run 599 passed and exactly the four
  quality suites failed (property, differential, anomaly, MC/DC). A LibreOffice
  case is additionally environment-dependent (it assumes no engine is
  installed). Until those are resolved or waived, PF-04 and AE-01 are BLOCKED
  and the Linux CI run is the authority.
- **The quality suites exist and are red.** Four seeded suites under
  `packages/core/test/fuzz/` (property fuzz, differential, anomaly/chaos and
  MC/DC) run real harnesses, but all four fail today: property 42/150,
  differential 137/150, anomaly 81/150, MC/DC 4/8. `coverage/decision-table.json`
  is an empty stub because the MC/DC suite writes only a case summary. Those
  gates are `BLOCKED` and need a written waiver; none may be reported as PASS.
- **No 150-case per-feature suites exist.** The §4 feature rows are `BLOCKED`.
- **`tools/e2e-panel.mjs` does not exist.** CDP evidence comes from
  `tools/measure-ribbon.mjs` and `tools/probe-panel.mjs`.
- **`pnpm` may be missing from `PATH`** on a developer machine; use
  `npx --no-install` equivalents shown above.

## 9. Sign-off

Release version: ____________________ Date: ____________

| Gate scope                 | Role            | Name | Result (PASS / FAIL / BLOCKED) | Evidence command | Artifact SHA-256 | Date |
| -------------------------- | --------------- | ---- | ------------------------------ | ---------------- | ---------------- | ---- |
| Pre-flight (§2)            | Release manager |      |                                |                  |                  |      |
| Build and budget (§3)      | Build owner     |      |                                |                  |                  |      |
| Automated evidence (§4)    | QA lead         |      |                                |                  |                  |      |
| Manual and visual (§5)     | Visual QA       |      |                                |                  |                  |      |
| Packaging and install (§6) | Packaging owner |      |                                |                  |                  |      |
| Rollback rehearsal (§7)    | Release manager |      |                                |                  |                  |      |
| Known limitations (§8)     | All signatories |      |                                |                  |                  |      |

### Waiver log (required for every BLOCKED item)

| Item | Reason | Risk accepted | Waived by | Date |
| ---- | ------ | ------------- | --------- | ---- |
|      |        |               |           |      |
|      |        |               |           |      |

### Deviations

| Item | Deviation | Follow-up owner | Due date |
| ---- | --------- | --------------- | -------- |
|      |           |                 |          |

**Final determination:** GO / NO-GO (circle one). A single `FAIL`, or a
`BLOCKED` without a recorded waiver, makes the answer NO-GO.
