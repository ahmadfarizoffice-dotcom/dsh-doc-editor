#!/usr/bin/env node
/**
 * Release quality coverage gate.
 *
 * Runs the coverage tooling that is actually installed in this repository and
 * compares the result against the machine-readable floors written in
 * `docs/QUALITY-GATES.md`. It never invents numbers: if `vitest` or
 * `@vitest/coverage-v8` is missing it reports `status: "unavailable"`, prints
 * the exact install command and exits 0.
 *
 * It also writes `coverage/decision-table.json`. That file is either a
 * normalized copy of a decision table produced by a fuzz/quality suite or an
 * explicit empty stub when no producer exists yet. Today no producer exists in
 * this repository, so the stub is what gets written; that is deliberate and is
 * the honest record for the MC/DC approximation described in
 * `docs/QUALITY-GATES.md`.
 *
 * Usage:
 *   node tools/coverage.mjs                  # table + floors check
 *   node tools/coverage.mjs --json           # machine-readable report only
 *   node tools/coverage.mjs --include=...    # override the measured scope
 *   node tools/coverage.mjs --tests=test/render
 *   node tools/coverage.mjs --root=<path>
 *
 * Exit codes:
 *   0  measured and all floors met, OR tooling unavailable (no fake pass)
 *   1  tests failed, or a scope fell below its floor
 *   2  configuration error (missing docs, unparsable floors block, bad args)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..");
const DOC_PATH = "docs/QUALITY-GATES.md";
const DECISION_TABLE_OUT = "coverage/decision-table.json";
const REPORTS_DIR = "coverage/raw";
/**
 * The release gate documents and the headings the CI job requires. This is the
 * single source of truth: CI and the checklist both call `--docs` instead of
 * duplicating a heading list in YAML.
 */
const REQUIRED_DOCS = {
  "docs/RELEASE-CHECKLIST.md": [
    "# Release Checklist",
    "## 1. How to use this checklist",
    "## 2. Pre-flight",
    "## 3. Build",
    "## 4. Automated evidence",
    "## 5. Manual and visual evidence",
    "## 6. Packaging",
    "## 7. Rollback",
    "## 8. Known limitations",
    "## 9. Sign-off",
  ],
  "docs/QUALITY-GATES.md": [
    "# Quality Gates",
    "## 2. What this stack can actually measure",
    "## 3. Gate definitions",
    "## 4. Coverage floors (machine-readable)",
    "## 5. MC/DC approximation by decision tables",
    "## 6. Acceptance rules",
  ],
};
/**
 * A producer may hand us a decision table here. The first existing path wins.
 * These names are the contract published in docs/QUALITY-GATES.md.
 */
const DECISION_TABLE_SOURCES = [
  "coverage/decision-table.source.json",
  "test/quality/decision-table.json",
  "test/fuzz/decision-tables.json",
];
const METRICS = ["statements", "branches", "functions", "lines"];

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    include: "packages/core/src/**/*.ts",
    tests: [],
    json: false,
    docs: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--docs") {
      options.docs = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root") {
      options.root = path.resolve(argv[(index += 1)]);
    } else if (arg.startsWith("--root=")) {
      options.root = path.resolve(arg.slice("--root=".length));
    } else if (arg === "--include") {
      options.include = argv[(index += 1)];
    } else if (arg.startsWith("--include=")) {
      options.include = arg.slice("--include=".length);
    } else if (arg === "--tests") {
      options.tests.push(argv[(index += 1)]);
    } else if (arg.startsWith("--tests=")) {
      options.tests.push(arg.slice("--tests=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    "Usage: node tools/coverage.mjs [options]",
    "",
    "  --json                print only the machine-readable report",
    "  --docs                validate the two release docs and their headings",
    "  --include=<glob>      measured scope (default packages/core/src/**/*.ts)",
    "  --tests=<pattern>     positional test filter passed to vitest (repeatable)",
    "  --root=<dir>          repository root (default: parent of tools/)",
    "  --help                show this text",
  ].join("\n");
}

function toPosix(value) {
  return value.replace(/\\/g, "/");
}

function relativeTo(root, absolute) {
  return toPosix(path.relative(root, absolute));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function percent(covered, total) {
  if (!total) return total === 0 ? 100 : 0;
  return round((covered / total) * 100);
}

function readJsonFile(filePath) {
  return readFile(filePath, "utf8").then((text) => JSON.parse(text));
}

/**
 * Find the fenced ```json block in docs/QUALITY-GATES.md that carries the
 * floors. Markdown must not be parsed by guesswork: only a JSON block that
 * actually contains a `coverageFloors` array is accepted.
 */
async function readFloors(root) {
  const docPath = path.join(root, DOC_PATH);
  if (!existsSync(docPath)) {
    return { error: `${DOC_PATH} is missing; floors cannot be read.` };
  }
  const text = await readFile(docPath, "utf8");
  const fences = text.matchAll(/```json[^\n]*\n([\s\S]*?)```/g);
  for (const fence of fences) {
    let parsed;
    try {
      parsed = JSON.parse(fence[1]);
    } catch {
      continue;
    }
    if (Array.isArray(parsed?.coverageFloors)) {
      return { floors: parsed.coverageFloors };
    }
  }
  return {
    error: `${DOC_PATH} has no fenced json block with a "coverageFloors" array.`,
  };
}

function detectTooling(root) {
  const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
  const coveragePackage = path.join(
    root,
    "node_modules",
    "@vitest",
    "coverage-v8",
    "package.json",
  );
  const vitestPackage = path.join(
    root,
    "node_modules",
    "vitest",
    "package.json",
  );
  const state = {
    vitestEntry,
    hasVitestEntry: existsSync(vitestEntry),
    hasCoverageV8: existsSync(coveragePackage),
    vitestVersion: null,
    coverageVersion: null,
    missing: [],
  };
  if (existsSync(vitestPackage)) {
    try {
      state.vitestVersion = JSON.parse(
        readFileSync(vitestPackage, "utf8"),
      ).version;
    } catch {
      state.vitestVersion = null;
    }
  }
  if (state.hasCoverageV8) {
    try {
      state.coverageVersion = JSON.parse(
        readFileSync(coveragePackage, "utf8"),
      ).version;
    } catch {
      state.coverageVersion = null;
    }
  }
  if (!state.hasVitestEntry) state.missing.push("vitest");
  if (!state.hasCoverageV8) state.missing.push("@vitest/coverage-v8");
  return state;
}

function installInstructions(tooling, root) {
  const vitestMajor = tooling.vitestVersion
    ? tooling.vitestVersion.split(".")[0]
    : "3";
  const packageManager = existsSync(path.join(root, "pnpm-lock.yaml"))
    ? "pnpm"
    : "npm";
  const add =
    packageManager === "pnpm" ? "pnpm add -D" : "npm install --save-dev";
  const lines = [
    `Install the missing coverage tooling (vitest major ${vitestMajor}):`,
    "",
    `  ${add} @vitest/coverage-v8@^${vitestMajor}`,
    "",
    "Both packages are already declared in the root package.json devDependencies",
    "(`vitest` and `@vitest/coverage-v8`); installing the workspace is normally",
    "enough:",
    "",
    "  pnpm install --frozen-lockfile",
  ];
  return lines;
}

function runVitest(options, reportsDirectory) {
  const args = [
    options.vitestEntry,
    "run",
    "--coverage",
    "--coverage.provider=v8",
    `--coverage.include=${options.include}`,
    "--coverage.reporter=json-summary",
    `--coverage.reportsDirectory=${reportsDirectory}`,
    "--reporter=dot",
    "--silent=passed-only",
    ...options.tests,
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: options.root,
      // In --json mode only the report may reach stdout; vitest's own output is
      // discarded so consumers can pipe the JSON straight into a parser.
      stdio: options.json ? ["ignore", "ignore", "inherit"] : "inherit",
      env: { ...process.env, CI: process.env.CI ?? "" },
    });
    child.on("error", (error) => resolve({ code: 1, error }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

function buildRows(summary, root) {
  const rows = [];
  for (const [key, value] of Object.entries(summary)) {
    if (key === "total") continue;
    if (!value || typeof value !== "object") continue;
    const file = relativeTo(root, path.resolve(key));
    if (!file.startsWith("packages/core/src/")) continue;
    rows.push({
      file,
      statements: {
        pct: value.statements?.pct ?? 0,
        covered: value.statements?.covered ?? 0,
        total: value.statements?.total ?? 0,
      },
      branches: {
        pct: value.branches?.pct ?? 0,
        covered: value.branches?.covered ?? 0,
        total: value.branches?.total ?? 0,
      },
      functions: {
        pct: value.functions?.pct ?? 0,
        covered: value.functions?.covered ?? 0,
        total: value.functions?.total ?? 0,
      },
      lines: {
        pct: value.lines?.pct ?? 0,
        covered: value.lines?.covered ?? 0,
        total: value.lines?.total ?? 0,
      },
    });
  }
  rows.sort((left, right) => left.file.localeCompare(right.file));
  return rows;
}

function aggregate(rows, scope) {
  const base = toPosix(scope).replace(/\/+$/, "");
  const prefix = `${base}/`;
  const selected = rows.filter(
    (row) => row.file === base || row.file.startsWith(prefix),
  );
  const totals = {};
  for (const metric of METRICS) {
    const total = selected.reduce((sum, row) => sum + row[metric].total, 0);
    const covered = selected.reduce((sum, row) => sum + row[metric].covered, 0);
    totals[metric] = { pct: percent(covered, total), covered, total };
  }
  return { scope: base, files: selected.length, ...totals };
}

function evaluateFloors(rows, floors) {
  const violations = [];
  const checked = [];
  for (const floor of floors) {
    if (!floor || typeof floor.scope !== "string") continue;
    const summary = aggregate(rows, floor.scope);
    checked.push({ floor, summary });
    // A mistyped scope would otherwise match nothing and pass vacuously.
    if (summary.files === 0) {
      violations.push({
        scope: floor.scope,
        metric: "files",
        measured: 0,
        floor: 1,
        covered: 0,
        total: 0,
      });
    }
    for (const metric of METRICS) {
      const minimum = floor[metric];
      if (typeof minimum !== "number") continue;
      if (summary[metric].pct + 1e-9 < minimum) {
        violations.push({
          scope: floor.scope,
          metric,
          measured: summary[metric].pct,
          floor: minimum,
          covered: summary[metric].covered,
          total: summary[metric].total,
        });
      }
    }
  }
  return { checked, violations };
}

function formatTable(checked) {
  const lines = [];
  const scopeWidth = Math.max(
    12,
    ...checked.map((entry) => entry.summary.scope.length),
  );
  const header = [
    "scope".padEnd(scopeWidth),
    "files".padStart(5),
    "stmts".padStart(8),
    "branch".padStart(8),
    "funcs".padStart(8),
    "lines".padStart(8),
    "status".padStart(7),
  ].join("  ");
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const { floor, summary } of checked) {
    const failed =
      summary.files === 0 ||
      METRICS.some(
        (metric) =>
          typeof floor[metric] === "number" &&
          summary[metric].pct + 1e-9 < floor[metric],
      );
    const cells = [
      summary.scope.padEnd(scopeWidth),
      String(summary.files).padStart(5),
      `${summary.statements.pct.toFixed(2)}%`.padStart(8),
      `${summary.branches.pct.toFixed(2)}%`.padStart(8),
      `${summary.functions.pct.toFixed(2)}%`.padStart(8),
      `${summary.lines.pct.toFixed(2)}%`.padStart(8),
      (failed ? "FAIL" : "PASS").padStart(7),
    ];
    lines.push(cells.join("  "));
  }
  return lines;
}

function formatFileTable(rows) {
  const lines = [];
  const width = Math.max(8, ...rows.map((row) => row.file.length));
  lines.push(
    [
      "file".padEnd(width),
      "stmts".padStart(8),
      "branch".padStart(8),
      "funcs".padStart(8),
      "lines".padStart(8),
    ].join("  "),
  );
  lines.push("-".repeat(width + 34));
  for (const row of rows) {
    lines.push(
      [
        row.file.padEnd(width),
        `${row.statements.pct.toFixed(2)}%`.padStart(8),
        `${row.branches.pct.toFixed(2)}%`.padStart(8),
        `${row.functions.pct.toFixed(2)}%`.padStart(8),
        `${row.lines.pct.toFixed(2)}%`.padStart(8),
      ].join("  "),
    );
  }
  return lines;
}

function normalizeDecisionTable(root, sourcePath, raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.predicates)
      ? raw.predicates
      : [];
  const predicates = list.map((predicate, index) => {
    const conditions = Array.isArray(predicate?.conditions)
      ? predicate.conditions.length
      : Number(predicate?.conditionCount) || 0;
    const rows = Array.isArray(predicate?.rows)
      ? predicate.rows.length
      : Number(predicate?.rowCount) || 0;
    return {
      id: String(predicate?.id ?? predicate?.name ?? `predicate-${index + 1}`),
      location: predicate?.location ?? null,
      conditionCount: conditions || null,
      truthTableRowCount: conditions ? 2 ** conditions : null,
      mcdcMinimumRows: conditions ? conditions + 1 : null,
      recordedRows: rows,
      rowsWithTestEvidence: Array.isArray(predicate?.rows)
        ? predicate.rows.filter((row) => row && (row.test || row.testName))
            .length
        : null,
      source: relativeTo(root, sourcePath),
    };
  });
  return {
    status: "available",
    source: relativeTo(root, sourcePath),
    predicateCount: predicates.length,
    predicates,
  };
}

async function buildDecisionTable(root) {
  for (const candidate of DECISION_TABLE_SOURCES) {
    const absolute = path.join(root, candidate);
    if (!existsSync(absolute)) continue;
    try {
      const raw = await readJsonFile(absolute);
      return normalizeDecisionTable(root, absolute, raw);
    } catch (error) {
      return {
        status: "invalid",
        source: candidate,
        reason: `Could not parse decision table: ${error.message}`,
        predicateCount: 0,
        predicates: [],
      };
    }
  }
  return {
    status: "unavailable",
    reason:
      "No predicate-level decision table producer is present. The MC/DC suite " +
      "prints truth tables and writes a case summary (coverage/fuzz/mcdc.json " +
      "when FUZZ_REPORT_DIR is set), but it does not emit the predicate artifact " +
      "this gate consumes. The empty list is the honest record; do not fill it " +
      "in by hand.",
    searched: DECISION_TABLE_SOURCES,
    predicateCount: 0,
    predicates: [],
    expectedSchema: {
      predicates: [
        {
          id: "string",
          location: "path/to/source.ts:predicateName",
          conditions: ["condition labels"],
          rows: [
            {
              inputs: { condition: true },
              outcome: true,
              test: "name of the test that exercises this row",
            },
          ],
        },
      ],
    },
  };
}

function printHuman(report) {
  const out = [];
  out.push("Coverage gate (measured, not asserted)");
  out.push(`  generated: ${report.generatedAt}`);
  out.push(
    `  node: \`${report.environment.node}\` on ${report.environment.platform}`,
  );
  out.push(`  scope: ${report.coverage.scope}`);
  out.push("");
  out.push(
    ...formatTable(
      report.coverage.scopes.map((entry) => ({
        floor: entry.floor,
        summary: entry.summary,
      })),
    ),
  );
  out.push("");
  out.push("Per file");
  const fileRows = report.coverage.files.map((file) => ({
    file: file.file,
    statements: { pct: file.statements },
    branches: { pct: file.branches },
    functions: { pct: file.functions },
    lines: { pct: file.lines },
  }));
  out.push(...formatFileTable(fileRows));
  out.push("");
  out.push(
    `Decision table: ${report.decisionTable.status} (${report.decisionTable.predicateCount} predicates) -> ${DECISION_TABLE_OUT}`,
  );
  if (report.decisionTable.status === "unavailable") {
    out.push(`  ${report.decisionTable.reason}`);
  }
  out.push("");
  if (report.violations.length) {
    out.push("FLOOR VIOLATIONS");
    for (const violation of report.violations) {
      if (violation.metric === "files") {
        out.push(
          `  ${violation.scope}: matched 0 files — the floor scope does not ` +
            "exist in this run (typo, or the measured scope is too narrow).",
        );
        continue;
      }
      out.push(
        `  ${violation.scope} ${violation.metric}: measured ${violation.measured}% ` +
          `below floor ${violation.floor}% (${violation.covered}/${violation.total})`,
      );
    }
  } else {
    out.push("All configured floors met.");
  }
  out.push("");
  out.push(`status: ${report.status}`);
  return out.join("\n");
}

function printUnavailable(report) {
  const out = [];
  out.push("Coverage gate: UNAVAILABLE");
  out.push("");
  out.push(
    `Missing tooling: ${report.tooling.missing.join(", ") || "unknown"}`,
  );
  out.push("");
  out.push(...report.installInstructions);
  out.push("");
  out.push(
    `Decision table stub written to ${DECISION_TABLE_OUT} (status: ${report.decisionTable.status}).`,
  );
  out.push("status: unavailable");
  return out.join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Documentation gate: the release docs exist and contain the required
 * headings. Run through `--docs` so CI and the checklist cannot drift apart.
 */
async function validateDocs(root) {
  const missing = [];
  let headings = 0;
  for (const [relative, required] of Object.entries(REQUIRED_DOCS)) {
    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) {
      missing.push(`${relative} (file missing)`);
      continue;
    }
    const text = await readFile(absolute, "utf8");
    for (const heading of required) {
      const pattern = new RegExp(`^${escapeRegExp(heading)}$`, "m");
      if (pattern.test(text)) {
        headings += 1;
      } else {
        missing.push(`${relative} :: ${heading}`);
      }
    }
  }
  return {
    status: missing.length === 0 ? "docs_ok" : "docs_failed",
    documents: Object.keys(REQUIRED_DOCS).length,
    headings,
    missing,
  };
}

function printDocs(report) {
  const lines = [];
  if (report.status === "docs_ok") {
    lines.push(
      `release docs OK: ${report.documents} files, ${report.headings} required headings present.`,
    );
  } else {
    lines.push("release docs FAILED:");
    for (const entry of report.missing) lines.push(`  missing: ${entry}`);
  }
  return lines.join("\n");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const root = options.root;
  const generatedAt = new Date().toISOString();

  if (options.docs) {
    const report = await validateDocs(root);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${printDocs(report)}\n`,
    );
    process.exit(report.status === "docs_ok" ? 0 : 1);
  }

  const tooling = detectTooling(root);
  const decisionTable = await buildDecisionTable(root);
  const coverageDir = path.join(root, "coverage");
  await mkdir(coverageDir, { recursive: true });
  await writeFile(
    path.join(root, DECISION_TABLE_OUT),
    `${JSON.stringify(decisionTable, null, 2)}\n`,
    "utf8",
  );

  const floorsResult = await readFloors(root);
  const floorsError = floorsResult.error;
  const floors = floorsResult.floors ?? [];

  const baseReport = {
    tool: { name: "tools/coverage.mjs", version: "1.0.0" },
    generatedAt,
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    tooling: {
      vitest: tooling.vitestVersion,
      coverageV8: tooling.coverageVersion,
      missing: tooling.missing,
    },
    decisionTable,
  };

  if (tooling.missing.length > 0) {
    const report = {
      ...baseReport,
      status: "unavailable",
      reason: `Missing tooling: ${tooling.missing.join(", ")}`,
      installInstructions: installInstructions(tooling, root),
      floors,
      violations: [],
      coverage: { scope: options.include, files: [], scopes: [] },
    };
    await writeFile(
      path.join(coverageDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${printUnavailable(report)}\n`,
    );
    process.exit(0);
  }

  if (floorsError) {
    const report = {
      ...baseReport,
      status: "error",
      reason: floorsError,
      coverage: { scope: options.include, files: [], scopes: [] },
      violations: [],
    };
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `Coverage gate: ERROR\n\n${floorsError}\n`,
    );
    process.exit(2);
  }

  const reportsDirectory = path.join(root, REPORTS_DIR);
  // A previous run's summary must never be mistaken for this run's evidence.
  await rm(reportsDirectory, { recursive: true, force: true });
  const run = await runVitest(
    { ...options, vitestEntry: tooling.vitestEntry },
    reportsDirectory,
  );
  if (run.error) {
    process.stderr.write(`Failed to spawn vitest: ${run.error.message}\n`);
    process.exit(2);
  }

  const summaryPath = path.join(reportsDirectory, "coverage-summary.json");
  if (!existsSync(summaryPath)) {
    const testsFailed = run.code !== 0;
    const report = {
      ...baseReport,
      status: testsFailed ? "tests_failed" : "error",
      reason: testsFailed
        ? `vitest exited with code ${run.code}, so no coverage summary was ` +
          "written. The test run must pass before coverage can be judged; " +
          "fix the failing tests instead of treating this as a coverage result."
        : "vitest finished but produced no coverage-summary.json; coverage " +
          "reporter configuration is broken. No numbers are reported.",
      vitestExitCode: run.code,
      coverage: { scope: options.include, files: [], scopes: [] },
      violations: [],
    };
    await writeFile(
      path.join(coverageDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `Coverage gate: ${report.status.toUpperCase()}\n\n${report.reason}\n`,
    );
    process.exit(testsFailed ? 1 : 2);
  }

  const summary = await readJsonFile(summaryPath);
  const rows = buildRows(summary, root);
  const { checked, violations } = evaluateFloors(rows, floors);
  const status =
    run.code !== 0
      ? "tests_failed"
      : violations.length > 0
        ? "floors_failed"
        : "ok";

  const report = {
    ...baseReport,
    status,
    vitestExitCode: run.code,
    command: {
      executable: "node",
      args: [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--coverage",
        "--coverage.provider=v8",
        `--coverage.include=${options.include}`,
        "--coverage.reporter=json-summary",
        `--coverage.reportsDirectory=${REPORTS_DIR}`,
      ],
    },
    coverage: {
      scope: options.include,
      files: rows.map((row) => ({
        file: row.file,
        statements: row.statements.pct,
        branches: row.branches.pct,
        functions: row.functions.pct,
        lines: row.lines.pct,
      })),
      scopes: checked.map(({ floor, summary: scoped }) => ({
        floor,
        summary: {
          scope: scoped.scope,
          files: scoped.files,
          statements: scoped.statements,
          branches: scoped.branches,
          functions: scoped.functions,
          lines: scoped.lines,
        },
      })),
    },
    floors,
    violations,
  };

  await writeFile(
    path.join(coverageDir, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${printHuman(report)}\n`,
  );
  process.exit(status === "ok" ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`Coverage gate crashed: ${error.stack ?? error}\n`);
  process.exit(2);
});
