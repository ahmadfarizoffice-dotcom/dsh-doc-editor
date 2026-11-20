# Quality Gates

This document defines what "release quality" means for `dsh-doc-editor`, which
gates block a release, and how each gate produces **measured** evidence. It is
the companion to [`docs/RELEASE-CHECKLIST.md`](RELEASE-CHECKLIST.md): the
checklist is the go/no-go instrument, this file is the rulebook behind it.

Every number below was produced by running the command next to it on
2026-11-19 (Windows, Node `v24.21.0`, vitest `3.2.7`,
`@vitest/coverage-v8` `3.2.7`). Anything not executed is marked
`NOT MEASURED` or `UNAVAILABLE` — never filled in from a previous claim.

## 1. Purpose and scope

The scope is the repository as shipped: `packages/core`, `apps/mcp`,
`apps/cli`, `apps/web`, the bundled DSH plugin (`dsh-plugin/`), and the
fixture/render regression suites. The gates exist to make three things
auditable:

1. **Regression safety** — the existing behaviour still works (unit,
   integration, fixture, render, plugin).
2. **Test adequacy** — coverage floors with a ratchet, plus a decision-table
   discipline standing in for MC/DC, which JavaScript tooling cannot measure.
3. **Fault tolerance** — fuzzing, differential testing and anomaly (chaos)
   injection. These are specified here but are **not implemented yet**; the
   gates that depend on them are marked `BLOCKED`, not `PASS`.

## 2. What this stack can actually measure

| Layer               | Tool                                                       | Status                                       | Evidence command                                                                    |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Core / apps / tests | `vitest` (v8)                                              | **implemented**                              | `npx --no-install vitest run`                                                       |
| DSH plugin          | `node --test` (built-in test runner)                       | **implemented**                              | `node --test "dsh-plugin/test/*.test.mjs"`                                          |
| Coverage            | `@vitest/coverage-v8` → `json-summary`                     | **implemented**                              | `node tools/coverage.mjs`                                                           |
| Real-browser E2E    | headless Chromium over CDP                                 | **partial**                                  | `node tools/measure-ribbon.mjs`, `node tools/probe-panel.mjs`                       |
| Fuzzing (seeded)    | vitest property suite, 150 cases, `FUZZ_SEED`/`FUZZ_CASES` | **exists, currently red**                    | `FUZZ_SEED=1337 FUZZ_CASES=150 npx --no-install vitest run packages/core/test/fuzz` |
| Differential        | vitest differential suite, 150 op scripts                  | **exists, currently red**                    | same command (all suites in the fuzz directory)                                     |
| Chaos / anomaly     | vitest fault-injection suite, 10 s per case                | **exists, currently red**                    | same command                                                                        |
| MC/DC               | vitest decision-table suite, 8 cases                       | **exists, currently red; no predicate JSON** | same command; `coverage/decision-table.json` stays a stub                           |

Notes that matter for honesty:

- `tools/fuzz/probe.mjs`…`probe6.mjs` are ad-hoc probe scripts that import the
  built engine. There is no runner or assertion harness, and no package script
  invokes them. They must not be counted as a fuzz suite.
- `tools/e2e-panel.mjs` **does not exist**. The CDP evidence today comes from
  `tools/measure-ribbon.mjs` and `tools/probe-panel.mjs`.
- `pnpm` was not on `PATH` in the environment where these numbers were taken,
  so the commands were executed through the installed binaries
  (`npx --no-install …`, `node …`). CI uses `pnpm` on Linux with Node 22; the
  commands are equivalent, and floor margins account for cross-platform drift.

## 3. Gate definitions

A gate is `PASS` only when its evidence command has been run and its expected
observable result was observed. `BLOCKED` means the gate cannot be evaluated
because the harness does not exist yet.

| Gate | Name                      | Blocking | Pass condition                                                                             | Status today                                                                       |
| ---- | ------------------------- | -------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| G0   | Clean tree                | yes      | `git status --porcelain` prints nothing                                                    | operator-run                                                                       |
| G1   | Static checks             | yes      | `tsc -b packages/core apps/mcp apps/cli` and web typechecks pass; `eslint .` has no errors | operator-run                                                                       |
| G2   | Core unit/integration     | yes      | `vitest run` exits 0 with 0 failed and 0 skipped **without a recorded reason**             | **measured PASS** (§7)                                                             |
| G3   | Plugin suite              | yes      | `node --test "dsh-plugin/test/*.test.mjs"` exits 0 with `fail 0`, `skipped 0`              | **measured PASS** (§7)                                                             |
| G4   | Real-browser CDP evidence | yes      | ribbon height and panel probes return the expected observables                             | operator-run                                                                       |
| G5   | Coverage floors           | yes      | `node tools/coverage.mjs` exits 0 and every scope meets §4                                 | **measured, floor-based** (§7)                                                     |
| G6   | MC/DC decision tables     | yes      | every new predicate has a truth table with independent-condition evidence                  | **suite red; artifact absent** — 4/8 MC/DC cases fail and no predicate JSON (§7.5) |
| G7   | Differential testing      | yes      | no unexplained divergence between implementations/round-trips                              | **suite red** — 137/150 cases fail (§7.5)                                          |
| G8   | Fuzzing                   | yes      | fuzz suites run a fixed seed/corpus and exit 0                                             | **suite red** — 42/150 cases fail (§7.5)                                           |
| G9   | Chaos / anomaly injection | yes      | zero crashes/hangs under the 10 s anomaly timeout                                          | **suite red** — 81/150 cases fail (§7.5)                                           |
| G10  | Docs and packaging gates  | yes      | both release docs exist with required headings; bundle checks pass                         | operator-run                                                                       |

`G6`–`G9` being `BLOCKED` is the accurate state, not a formality. A release may
only claim those gates after the harnesses land and the evidence columns in the
checklist are filled with real output.

## 4. Coverage floors (machine-readable)

`tools/coverage.mjs` parses the fenced JSON block below. Change a floor here and
the script picks it up; do not encode thresholds anywhere else.

The floors are **ratchets**: they sit a small margin below today's measured
baseline so that cross-platform drift (Node 22 in CI vs Node 24 locally) does
not produce false failures, while any real regression fails the gate. When
coverage improves, raise the floor to the new measured value minus the same
margin. Never lower a floor without recording why in the release checklist.

```json
{
  "coverageFloors": [
    {
      "scope": "packages/core/src",
      "statements": 67,
      "branches": 65,
      "functions": 70,
      "lines": 67
    },
    {
      "scope": "packages/core/src/model",
      "statements": 47,
      "branches": 67,
      "functions": 49,
      "lines": 47
    },
    {
      "scope": "packages/core/src/service",
      "statements": 39,
      "branches": 56,
      "functions": 49,
      "lines": 39
    }
  ]
}
```

These floors were derived from the **stable baseline run** documented in
§7.3 (the 21 test files that existed before concurrent work landed) minus
roughly two percentage points. They were deliberately not derived from the
whole-workspace run, because during authoring that run was red (see §7.4) and a
red run produces no coverage summary to trust.

The floors are measured over the **whole workspace** test run, because the
`apps/web` and `apps/mcp` suites are what exercise `packages/core/src/service`.
Narrowing the run (for example `--tests=packages/core`) will legitimately show
`service` near zero and must not be used to evaluate the service floor.

### Why 100% is not the current gate

The stated target is 100% statement/branch/line/function on `model` and
`service` **where achievable**. It is not achieved today, and the honest gate is
a floor plus a ratchet rather than a number someone wrote down:

| Scope                       | Statements | Branches | Functions | Meets 100% target? |
| --------------------------- | ---------- | -------- | --------- | ------------------ |
| `packages/core/src/model`   | 49.18%     | 69.90%   | 51.37%    | **No**             |
| `packages/core/src/service` | 41.13%     | 58.04%   | 51.00%    | **No**             |
| `packages/core/src` (all)   | 69.19%     | 67.73%   | 72.79%    | **No**             |

The 100% target stays in §6 as an acceptance rule for new code and as the
direction of travel; the floors in §4 are what CI enforces today.

### v8 caveat: "declared" is not "called"

V8 counts function and branch coverage when a module is evaluated, not only
when behaviour executes. Measured example: when the coverage run was narrowed to
`packages/core` tests only, `service/service.ts` reported
`statements 0%`, `branches 100%`, `functions 100%`. The module was imported
(so declarations counted) but its services were never exercised. Treat
statement/line percentages as the primary signal, and never present a
function/branch percentage alone as proof of tested behaviour.

## 5. MC/DC approximation by decision tables

JavaScript coverage tooling measures **statement, branch, function and line**
coverage. It does not measure Modified Condition/Decision Coverage: a branch
being "covered" says nothing about whether each condition independently
influenced the decision. There is no maintained MC/DC instrumentation for
TypeScript/vitest in this repository.

We approximate MC/DC with **decision tables plus independent-condition
evidence**:

1. For every predicate with `n` conditions, record a table with either
   - the full truth table (`2^n` rows), or
   - the minimal MC/DC set (`n + 1` rows),
     where each row states which single condition it flips, and the row that
     demonstrates a condition's independence names the test that exercises it.
2. Every row must map to a named automated test. A row without a test is not
   evidence and the predicate is not covered.
3. Tables live in a machine-readable file (see contract below), so
   `tools/coverage.mjs` can report predicate and row counts without parsing
   prose.

### File contract

`tools/coverage.mjs` reads the first existing producer, in this order:

1. `coverage/decision-table.source.json`
2. `test/quality/decision-table.json`
3. `test/fuzz/decision-tables.json`

and writes the normalized result to `coverage/decision-table.json`. Accepted
shape (an array, or an object with a `predicates` array):

```json
{
  "predicates": [
    {
      "id": "ribbon.clampHeight",
      "location": "dsh-plugin/client.js:clampRibbonHeight",
      "conditions": [
        "height is finite",
        "height below floor",
        "height above cap"
      ],
      "rows": [
        {
          "inputs": { "finite": true, "belowFloor": false, "aboveCap": false },
          "outcome": false,
          "test": "clamp honours the 1/10 rule"
        }
      ]
    }
  ]
}
```

`truthTableRowCount` and `mcdcMinimumRows` are **derived** from the condition
count, not measured, and the report labels them as such by construction: they
are the size the table is required to have, not proof that it has been filled.

**Current status:** the MC/DC suite (`packages/core/test/fuzz/mcdc.test.ts`)
exists and prints truth tables, but it does not write the normalized predicate
artifact, so `coverage/decision-table.json` remains an explicit empty stub with
`status: "unavailable"`. That is the accurate record. The file must never be
hand-filled to make a gate look green.

## 6. Acceptance rules

These rules bind every change that ships:

- **AR1 — predicates need truth tables.** Every new or modified boolean
  predicate (guard, validator, clamp, branch on capability/format/flag) needs a
  truth-table test in the shape of §5. A predicate without a table is a
  review blocker.
- **AR2 — coverage target.** 100% statement/branch/line/function on
  `packages/core/src/model` and `packages/core/src/service` where achievable.
  Where not yet achievable, the §4 floors are the enforced minimum and may only
  ratchet upward.
- **AR3 — no unexplained differential divergence.** Any comparison between two
  implementations of the same behaviour (round-trip DOCX, adapter conversions,
  plugin vs core tool results) must report zero divergence, or the divergence
  must be explained in the release checklist with a linked test. The harness to
  produce this evidence is **not implemented**; until it is, this rule cannot
  be satisfied and the related gate is `BLOCKED`.
- **AR4 — no crashes or hangs under anomaly injection.** A 10-second anomaly
  timeout applies: injected faults must produce a handled error within 10 s,
  never a crash or a hung promise. The harness is **not implemented**; the gate
  is `BLOCKED`.
- **AR5 — no silent skips.** A skipped test is a failure unless the release
  checklist records why it is skipped and who owns re-enabling it.
- **AR6 — honest reporting.** Numbers in the docs are pasted from commands that
  were actually run. Unrun items are marked `NOT MEASURED`; absent harnesses
  are `BLOCKED`, never `PASS`.

## 7. Measured baseline (2026-11-19)

Environment: Windows, Node `v24.21.0`, vitest `3.2.7`,
`@vitest/coverage-v8` `3.2.7`. Elapsed times are wall-clock.

### 7.1 Core, apps and fixture suites

Command: `npx --no-install vitest run` (equivalent to `pnpm test`)

```
 Test Files  21 passed (21)
      Tests  126 passed (126)
   Start at  17:11:18
   Duration  2.71s
```

Exit code 0. No failures, no skips.

### 7.2 DSH plugin suite

Command: `node --test "dsh-plugin/test/*.test.mjs"`

```
ℹ tests 102
ℹ suites 0
ℹ pass 102
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1129.0313
```

Exit code 0. Six files (`host-api`, `host-browse`, `host-late-web`, `logic`,
`panel`, `ribbon`).

### 7.3 Coverage, stable baseline run

The whole-workspace run was red during authoring (§7.4), so the floors were
derived from the 21 test files that existed before the concurrent work landed.
This is the exact, reproducible command — the file list is the baseline set:

```bash
node tools/coverage.mjs \
  --tests=apps/mcp/test/protocol.test.ts \
  --tests=apps/web/test/editing.test.ts \
  --tests=apps/web/test/outline.test.ts \
  --tests=apps/web/test/pagination.test.ts \
  --tests=apps/web/test/selection.test.ts \
  --tests=apps/web/test/session.test.ts \
  --tests=apps/web/test/skins.test.ts \
  --tests=apps/web/test/workspace.test.ts \
  --tests=packages/core/test/formats/convert.test.ts \
  --tests=packages/core/test/formats/html.test.ts \
  --tests=packages/core/test/formats/legacy-doc.test.ts \
  --tests=packages/core/test/formats/markdown.test.ts \
  --tests=packages/core/test/formats/odt.test.ts \
  --tests=packages/core/test/formats/ooxml-preview.test.ts \
  --tests=packages/core/test/formats/pages.test.ts \
  --tests=packages/core/test/formats/rtf.test.ts \
  --tests=packages/core/test/formats/text.test.ts \
  --tests=test/fixture/extended.test.ts \
  --tests=test/fixture/roundtrip.test.ts \
  --tests=test/fixture/smoke.test.ts \
  --tests=test/render/layout.test.ts
```

Measured at 17:28 on 2026-11-19 (after the concurrent source edits described in
§7.4, which is why `packages/core/src` shows more statements than the 17:12
whole-suite run):

| Scope                       | Files | Statements           | Branches           | Functions         | Lines  |
| --------------------------- | ----- | -------------------- | ------------------ | ----------------- | ------ |
| `packages/core/src/model`   | 14    | 49.18% (1960/3985)   | 69.90% (360/515)   | 51.37% (94/183)   | 49.18% |
| `packages/core/src/service` | 3     | 41.13% (735/1787)    | 58.04% (83/143)    | 51.00% (51/100)   | 41.13% |
| `packages/core/src` (all)   | 59    | 69.19% (21028/30390) | 67.73% (4218/6228) | 72.79% (800/1099) | 69.19% |

These are the numbers the §4 floors are derived from (baseline minus roughly two
percentage points, floored to integers). They are **narrowed-run** numbers: the
new LibreOffice suite is excluded because it was failing while it was written,
so engine coverage in this table is lower than the whole-suite figure will be
once that suite is green. Re-measure and ratchet when the tree stabilises.

### 7.4 Tree stability during authoring

This document was written while other agents were actively changing the same
working tree. Observed on 2026-11-19 between 17:11 and 17:46:

- `packages/core/test/engine/libreoffice.test.ts` and `libreoffice-mcp.test.ts`
  appeared (hundreds of cases). They converged to 470/471 passing; the one
  remaining failure assumes no LibreOffice is installed and is
  environment-dependent on this machine (§8).
- `packages/core/test/fuzz/` appeared with four suites: `roundtrip.property`,
  `differential`, `anomaly` and `mcdc`, plus `support.ts`. All four are red
  (§7.5), and they are the reason the whole-workspace run cannot go green here.
- `packages/core/src/engine/libreoffice.ts`, `service/service.ts`,
  `tools/registry.ts` and `dsh-entry.ts` were edited, growing the measured tree
  from 29,015 to 30,390 statements — which is exactly why the §4 floors were
  re-derived rather than left at their first values.
- `tools/fuzz/probe.mjs` … `probe6.mjs` appeared, plus
  `tools/libreoffice-smoke.mjs`. These are ad-hoc probe/smoke scripts, not test
  suites: there is no runner and no assertion harness.

Consequence: the default `node tools/coverage.mjs` run (whole workspace) exits
**1 with `status: "tests_failed"`** while those suites are red, and correctly
reports no coverage numbers instead of inventing them. The §7.1 and §7.3
numbers are the last runs that were green, with their exact commands, and must
be re-measured before sign-off.

### 7.5 Quality suites that exist and are red

Four suites landed during authoring under `packages/core/test/fuzz/`: property
fuzzing, differential testing, anomaly/fault injection and MC/DC decision
tables. They are real harnesses with seeded, reproducible cases — and all four
are currently failing, so none of them may be reported as a pass.

Command: `FUZZ_REPORT_DIR=coverage/fuzz FUZZ_SEED=1337 FUZZ_CASES=150 npx --no-install vitest run packages/core/test/fuzz`

```
FUZZ_SUMMARY {"suite":"mcdc","cases":8,"passed":4,"failed":4,...}
FUZZ_SUMMARY {"suite":"roundtrip","cases":150,"passed":108,"failed":42,...}
FUZZ_SUMMARY {"suite":"differential","cases":150,"passed":2,"failed":137,"documented":11,...}
FUZZ_SUMMARY {"suite":"anomaly","cases":150,"passed":69,"failed":81,...}
 Test Files  4 failed (4)
      Tests  4 failed (4)
```

| Suite           | File                         | Cases | Passed | Failed | Documented | Gate   |
| --------------- | ---------------------------- | ----- | ------ | ------ | ---------- | ------ |
| MC/DC tables    | `mcdc.test.ts`               | 8     | 4      | 4      | 0          | G6 red |
| Property fuzz   | `roundtrip.property.test.ts` | 150   | 108    | 42     | 0          | G8 red |
| Differential    | `differential.test.ts`       | 150   | 2      | 137    | 11         | G7 red |
| Anomaly / chaos | `anomaly.test.ts`            | 150   | 69     | 81     | 0          | G9 red |

Exit code 1. `FUZZ_REPORT_DIR` makes `FuzzReporter` write one summary JSON per
suite into `coverage/fuzz/`. The MC/DC suite prints a full truth table and an
independence analysis per predicate, but it does **not** emit the normalized
predicate artifact described in §5, so `coverage/decision-table.json` remains an
empty stub. That is the concrete gap behind G6.

Case counts are stable per suite because the seed is fixed, but the failure
counts moved while the suites were being edited (for example the property suite
reported 33, then 42, failures); always re-run rather than quoting a remembered
number.

## 8. Unavailable evidence and known gaps

Nothing in this section may be reported as passing.

| Gap                         | Reality (checked 2026-11-19)                                                                                                                                                                                                                                                                                                   | Consequence for a release                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fuzzing                     | `packages/core/test/fuzz/roundtrip.property.test.ts` is a real seeded suite: 150 cases, default seed 1337, configured by `FUZZ_SEED`/`FUZZ_CASES`, asserting round-trip, snapshot, undo/redo and id-uniqueness invariants. It is **red**: 42 of 150 cases fail.                                                                | G8 `BLOCKED`; robustness under malformed input is unproven.                                                                                              |
| Differential testing        | `packages/core/test/fuzz/differential.test.ts` compares direct service calls against `invokeTool` and cross-format conversions. It is **red**: 137 of 150 cases fail, 11 documented. The `tools/fuzz/probe.mjs`…`probe6.mjs` scripts remain ad-hoc probes with no runner.                                                      | G7 `BLOCKED`; AR3 cannot be satisfied.                                                                                                                   |
| Chaos / anomaly injection   | `packages/core/test/fuzz/anomaly.test.ts` injects truncated packages, path escapes, races and wrong-id operations with a 10 s per-case limit. It is **red**: 81 of 150 cases fail.                                                                                                                                             | G9 `BLOCKED`; AR4 cannot be satisfied.                                                                                                                   |
| MC/DC tables                | `packages/core/test/fuzz/mcdc.test.ts` prints truth tables and independence analysis for 5 predicates, but 4 of its 8 cases fail and it writes only a case summary, not a predicate-level artifact.                                                                                                                            | G6 `BLOCKED`; `coverage/decision-table.json` is an empty stub.                                                                                           |
| 150-case per-feature suites | The seeded fuzz suite runs 150 document cases, but no 150-case **feature** suite exists for ribbon, icons, open-from-folder, shortcuts, selection or typing. A LibreOffice error-mapping suite asserts a minimum case count and covers one adapter, not the six features.                                                      | Feature-parity rows in the release checklist are `BLOCKED`.                                                                                              |
| LibreOffice test suite      | `libreoffice.test.ts` and `libreoffice-mcp.test.ts` landed during authoring and are largely green (470/471 on the last run). One case is not hermetic: `unavailable engine (missing override with real PATH) #1` assumes no LibreOffice is reachable, but this machine has `C:\Program Files\LibreOffice\program\soffice.exe`. | Environment-dependent, not a product regression: local runs must record whether LibreOffice is installed; Linux CI without LibreOffice is the authority. |
| `tools/e2e-panel.mjs`       | File does not exist.                                                                                                                                                                                                                                                                                                           | Any reference to it is conditional; CDP evidence uses `measure-ribbon.mjs`/`probe-panel.mjs`.                                                            |
| 100% model/service coverage | Measured at 49.18% / 41.13% statements.                                                                                                                                                                                                                                                                                        | Target unmet; floors are enforced instead.                                                                                                               |

### Convention for fuzz, differential, chaos and 150-case suites

All four suite types now exist under `packages/core/test/fuzz/`, so this is the
implemented shape, not a plan:

- Seeded property/fuzz suites: `packages/core/test/fuzz/*.property.test.ts`,
  configured by `FUZZ_SEED` (default 1337) and `FUZZ_CASES` (default 150). Run:
  `FUZZ_SEED=1337 FUZZ_CASES=150 npx --no-install vitest run packages/core/test/fuzz`.
- Discovery roots: `test/quality`, `test/fuzz` and `packages/core/test/fuzz`.
  The CI `fuzz` job walks them recursively for `*.test.ts`/`*.test.mjs` and runs
  what it finds, so new suites are picked up without workflow changes.
- Reserved names for suites that do not exist yet:
  `test/quality/*.fuzz.test.ts`, `*.differential.test.ts`,
  `*.chaos.test.ts`, and `packages/core/test/fuzz/*.property.test.ts`.
- Anomaly timeout: 10 s per injected fault, asserted in the test.
- 150-case feature suites: `test/quality/<feature>.150.test.ts`, one file per
  feature, each asserting 150 discrete cases for that feature.
- Decision tables: one of the three producer paths in §5.

CI fails only when a discovered suite actually fails; a discovery root with no
suites records a notice and stays green, because absence is reported as
`BLOCKED` in the checklist rather than as a passing test.

## 9. Commands reference

```bash
# Core, apps and fixture suites
npx --no-install vitest run            # pnpm test
npx --no-install vitest run packages   # pnpm run test:unit
npx --no-install vitest run test       # pnpm run test:integration
npx --no-install vitest run test/fixture  # pnpm run test:fixture

# DSH plugin suite (node's own runner)
node --test "dsh-plugin/test/*.test.mjs"

# Seeded fuzz suite (150 cases, deterministic)
FUZZ_SEED=1337 FUZZ_CASES=150 npx --no-install vitest run packages/core/test/fuzz

# Coverage gate (real tooling; exits 0 when unavailable)
node tools/coverage.mjs
node tools/coverage.mjs --json

# Real-browser CDP evidence (needs Chrome + a served app)
node tools/measure-ribbon.mjs --url http://127.0.0.1:4399/ --height 900
node tools/probe-panel.mjs --url http://127.0.0.1:4399/ --height 900

# Static gates
npx --no-install tsc -b packages/core apps/mcp apps/cli
npx --no-install eslint .
npx --no-install prettier --check .

# Packaging
node tools/build-dsh-plugin.mjs
node tools/check-dsh-plugin.mjs
```

`tools/coverage.mjs` exit codes: `0` measured with all floors met **or**
tooling unavailable; `1` tests failed or a floor was missed; `2` configuration
error (missing docs, unparsable floors block, bad arguments). CI must fail on
`1` and `2` but must not fail merely because coverage tooling is absent.
