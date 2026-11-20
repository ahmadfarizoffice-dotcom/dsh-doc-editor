# Known issues found by the fuzz suites

These are **real engine defects** found by `packages/core/test/fuzz/*` against
the public surface of `packages/core/src/dsh-entry.ts`.

**Current status: no open defects.** Every issue previously recorded here was
fixed in `packages/core/src/**`; the failing cases now pass and are pinned by
`packages/core/test/fuzz/regressions.test.ts` (plus the property suites). The
per-case seeds below are kept so any regression can be reproduced.

Run everything:

```bash
node tools/fuzz/run.mjs --seed 1337 --cases 150
```

On Windows PowerShell the same environment variables are used directly:

```powershell
$env:FUZZ_SEED="1337"; $env:FUZZ_CASES="150"
node_modules\.bin\vitest.CMD run packages/core/test/fuzz/roundtrip.property.test.ts
node_modules\.bin\vitest.CMD run packages/core/test/fuzz/anomaly.test.ts
node_modules\.bin\vitest.CMD run packages/core/test/fuzz/differential.test.ts
node_modules\.bin\vitest.CMD run packages/core/test/fuzz/mcdc.test.ts
node_modules\.bin\vitest.CMD run packages/core/test/fuzz/regressions.test.ts
```

Per-case seeds are derived as `caseSeed(FUZZ_SEED, caseIndex)`; the suites print
the seed of every failing case together with its full op script.

## Status summary (seed 1337, 150 generated cases per suite)

| Suite          | Cases | Passed | Failed | Documented losses |
| -------------- | ----: | -----: | -----: | ----------------: |
| `roundtrip`    |   150 |    150 |      0 |                 0 |
| `anomaly`      |   150 |    150 |      0 |                 0 |
| `differential` |   150 |     82 |      0 |                68 |
| `mcdc`         |    11 |     11 |      0 |                 0 |
| `soak`         |   150 |    150 |      0 |                 0 |

`differential` "documented" cases are conversion-chain divergences where every
structural probe is covered by a loss entry reported by the participating
adapter: ODT/HTML have no multi-section model, ODT flattens TOCs, and HTML
re-emits TOC entries through the layout engine. Those are honest, reported
losses, not silent corruption.

## Resolved defects (kept for reproduction)

### A. Input parsing and error typing

- **A1 corrupt/truncated ZIP-DOCX** (`truncated-docx#0..#11` seeds
  `3322469804`, `568145783`, `300908626`, `218010680`, `4189413654`,
  `896670380`, `443643571`, `73917667`, `57873189`, `1243795648`, `1651763636`,
  `837080448`; `garbage-pk#16..#19` seeds `329549950`, `2096502365`,
  `2409883146`, `824445760`): `readPackage` now wraps every archive failure as
  `FormatError` with a stable code (`FORMAT_CORRUPT` / `FORMAT_BOMB` /
  `FORMAT_TOO_LARGE`) and a message naming the document, never JSZip internals.
  Proved by `anomaly` and `regressions.test.ts` ("corrupt or undeclared DOCX").
- **A2 missing/wrong `[Content_Types].xml`** (seeds `1490467769`...): the DOCX
  importer requires an `Override` declaring a WordprocessingML main part and
  rejects otherwise with `FORMAT_CORRUPT`.
- **A3 declared 512 MiB part** (seeds `411668100`, `3030672924`): typed
  `FORMAT_BOMB`/`FORMAT_TOO_LARGE`, checked before decompression cost is paid.
- **A4 binary bytes with a `.txt` extension** (`mcdc` `P3.importExtensionList`,
  `mask=0`): the text adapter rejects NUL/control-heavy or invalid-UTF-8 input
  with `FORMAT_CORRUPT` instead of decoding it.
- **A5 lone surrogates** (`lone-surrogate#46..#51` seeds `2453978285`,
  `1843079967`, `3208785298`, `1587826772`, `1940412039`, `2281083456`): text
  edits no longer split surrogate pairs, so emoji survive the DOCX path intact.
  A raw lone surrogate cannot be represented in XML 1.0; that case is preserved
  in the JSON snapshot and reported as a `text.unicode` **loss** on DOCX import
  (the chosen contract, asserted by `anomaly` and `regressions.test.ts`).

### B. Range / offset validation

- **B1/B2 reversed, negative and out-of-text ranges** (`invalid-range#*` seeds
  `625734555`, `2728889414`, `552074164`, `1053245144`, `3602815803`,
  `2221378167`, `1096233018`, `4235203040`, `1896730573`, `3329627438`):
  `DocumentService` validates every position and the start/end order before any
  mutation and raises typed `INVALID_RANGE`; the model is left byte-identical.
  Proved by `anomaly` and `regressions.test.ts` ("reversed replaceText range").
- **B3 unknown blocks** still raise typed `BLOCK_NOT_FOUND`.

### C. Table operations

- **C1 invalid `mergeCells` regions** (`table-bad-region#*`,
  `merge-non-adjacent#*` seeds `3555401774`, `2359863690`, `2157739933`,
  `3048909050`, `1496882593`, `1163314309`, `895201145`, `4085728979`,
  `3467669948`, `418332797`, `694552633`, `1985453474`): reversed, negative,
  out-of-grid and overlapping regions raise typed `INVALID_RANGE`; legitimate
  merges still work. Proved by `anomaly` and `regressions.test.ts`
  ("invalid mergeCells regions").
- **C2 untyped model errors**: unknown section, unknown style and last-row
  deletion now surface typed `SECTION_NOT_FOUND` / `STYLE_NOT_FOUND` /
  `TABLE_LAST_ROW` codes (covered by `mcdc` P2 rows with `sectionExists=false`).

### D. Persistence and session consistency

- **D1 duplicated header/footer ids after `insertSectionBreak`** (25 roundtrip
  cases, e.g. seeds `1243795648`, `398053669`, `2096502365`, `3269096899`):
  cloned header/footer parts are deep re-keyed and the op asserts global id
  uniqueness. Proved by `roundtrip` and `regressions.test.ts`.
- **D2/D3 injected empty paragraphs / lost empty sections on DOCX round-trip**
  (seeds `57873189`, `2702948617`, `824445760`, `1371411368`, `1084508278`):
  synthetic section-end carriers are no longer imported as body paragraphs, an
  intentionally empty paragraph that carries a section break is marked with an
  empty run, and empty sections stay empty. Proved by `roundtrip` and
  `regressions.test.ts` ("preserves table-ending ... sections").
- **D4 save-during-mutation** (seeds `3134934831`, `187553727`, `287435135`,
  `4251735280`, `140917964`, `3578407499`, `3123251544`, `3596712066`):
  `saveDocument` snapshots the model before exporting, so JSON and DOCX always
  come from one revision.
- **D5 non-atomic three-file save** (seeds `514161083`, `1594647398`): files are
  staged to temp siblings and renamed with backups; a failed commit restores the
  previous snapshot and raises typed `SAVE_FAILED`. Proved by `anomaly` and
  `regressions.test.ts` ("failed three-file save").
- **D6 read-only bypass** (`readonly-route#saveAs-html` seed `2228237672`,
  `#export-docx-path` `3583803669`, `#export-html-path` `755019156`,
  `#convert-html-path` `3456540395`, `#export-pdf-path` `2182383031`; `mcdc`
  `P4.readOnlyRoutes`): every route that writes calls `assertWritable()` before
  touching the disk. Proved by `mcdc` P4 and `regressions.test.ts`.
- **D7 junction/symlink escape** (seeds `3882613874`, `1516279621`,
  `2275519883`): read paths are canonicalised with `realpath` and re-checked
  against the canonical roots before reading; escape raises
  `PATH_OUTSIDE_WORKSPACE`. Proved by `anomaly` and `regressions.test.ts`.

### E. Page-layout validation

- **E1/E2 `setPageLayout`** (`mcdc` P2, 39/64 rows): unknown orientation,
  negative/NaN/zero margins, margins that overflow the page and unknown section
  indexes are rejected with `INVALID_ARGUMENT`/`SECTION_NOT_FOUND`, with rollback
  of any partially applied geometry. Proved by `mcdc` and `regressions.test.ts`.

### F. Format-conversion chains

- **F1 ODT section loss** (70 chains): the ODT exporter reports
  `sections.flattened`; ODF has no multi-section model.
- **F2 HTML tabs, hard breaks and cell paragraphs**: text runs encode tabs,
  newlines and edge/multiple spaces as marker spans; cell paragraphs are emitted
  as `<p>` blocks instead of `<br>`-joined text; the importer restores them
  exactly, so no unexplained text divergence remains.
- **F3 HTML note references**: both footnote and endnote sections are registered
  as annotation containers, so note references resolve instead of becoming a
  literal number. TOC blocks round-trip as `TocBlock` values and their cached
  entries are reported as a `toc` loss (they are regenerated by the layout
  engine).

## What the suites prove is already safe (no issue)

- Entity-expansion packages: xmldom does not expand internal entities (text stays
  literal `&lol5;`), fast and bounded.
- 1000-level XML nesting: imports in a few milliseconds, no stack overflow.
- 1 MiB single paragraph and 100 000-paragraph documents: bounded (≈20 ms export
  for 1 MiB, ≈0.5 s for 100k paragraphs, heap delta well under the 700 MiB guard).
- NUL/control characters survive a DOCX round-trip unchanged.
- Concurrent `saveDocument` calls settle with valid JSON/DOCX files.
- Double close and delete-while-open raise typed `DOCUMENT_NOT_OPEN`.
- Filesystem path traversal in `openDocument` raises typed
  `PATH_OUTSIDE_WORKSPACE`.
- ZIP entries with `..` are sanitised by JSZip and never escape the package root.
- The tool layer (`invokeTool`) matched direct `DocumentService` calls on every
  one of the 150 differential op scripts (0 divergences).
- JSON snapshot reopen (`document.json`) reproduced the model hash exactly, and
  every undo/redo script returned to the expected model hashes (0 failures in
  150 documents).

## Ownership hints

- `packages/core/src/service/service.ts`: range handling, page layout, save
  snapshot, read-only routes.
- `packages/core/src/service/workspace.ts`: typed archive errors (via the DOCX
  package reader), atomic commit, `assertWritable`, realpath confinement.
- `packages/core/src/model/edit.ts`: `mergeCells` region contract,
  `insertSectionBreak` re-keying, surrogate-safe run splitting.
- `packages/core/src/docx/export.ts` / `import.ts` / `package.ts`: section-end
  paragraph handling, content-type validation, surrogate reporting.
- `packages/core/src/formats/odt.ts` / `html.ts` / `text.ts` /
  `convert/index.ts`: reported losses for sections/tabs/breaks/notes and binary
  text rejection.
