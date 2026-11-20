#!/usr/bin/env node
/**
 * One command for the four engine-hardening suites.
 *
 *   node tools/fuzz/run.mjs --seed 1337 --cases 150
 *
 * Runs `roundtrip`, `anomaly`, `differential` and `mcdc` with vitest, then prints
 * one JSON summary per suite (cases/passed/failed/documented/duration) plus an
 * aggregate line. Exits non-zero when any suite fails.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const vitestEntry = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const SUITES = [
  ["roundtrip", "packages/core/test/fuzz/roundtrip.property.test.ts"],
  ["anomaly", "packages/core/test/fuzz/anomaly.test.ts"],
  ["differential", "packages/core/test/fuzz/differential.test.ts"],
  ["mcdc", "packages/core/test/fuzz/mcdc.test.ts"],
];

function parseArgs(argv) {
  const options = { seed: "1337", cases: "150", only: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--seed" || argument === "-s") {
      options.seed = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--seed=")) {
      options.seed = argument.slice("--seed=".length);
    } else if (argument === "--cases" || argument === "-c") {
      options.cases = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--cases=")) {
      options.cases = argument.slice("--cases=".length);
    } else if (argument === "--suite" || argument === "--only") {
      options.only = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--suite=")) {
      options.only = argument.slice("--suite=".length);
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node tools/fuzz/run.mjs [--seed 1337] [--cases 150] [--suite roundtrip|anomaly|differential|mcdc]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${argument}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(Number.parseInt(options.seed, 10))) {
    console.error(`--seed must be an integer, got ${options.seed}`);
    process.exit(2);
  }
  if (!(Number.parseInt(options.cases, 10) > 0)) {
    console.error(`--cases must be a positive integer, got ${options.cases}`);
    process.exit(2);
  }
  return options;
}

function readSummary(reportDirectory, suite) {
  const file = path.join(reportDirectory, `${suite}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

const options = parseArgs(process.argv.slice(2));
const primary = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
if (!existsSync(vitestEntry) && !existsSync(primary)) {
  console.error("vitest is not installed under node_modules/vitest/vitest.mjs");
  process.exit(2);
}

const reportDirectory = mkdtempSync(
  path.join(os.tmpdir(), "dsh-fuzz-reports-"),
);
const summaries = [];
let exitCode = 0;

const selected = options.only
  ? SUITES.filter(([name]) => name === options.only)
  : SUITES;
if (selected.length === 0) {
  console.error(
    `Unknown suite ${options.only}; expected one of ${SUITES.map(([name]) => name).join(", ")}`,
  );
  rmSync(reportDirectory, { recursive: true, force: true });
  process.exit(2);
}

for (const [suite, file] of selected) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [vitestEntry, "run", file, "--reporter=default"],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        FUZZ_SEED: String(options.seed),
        FUZZ_CASES: String(options.cases),
        FUZZ_REPORT_DIR: reportDirectory,
      },
    },
  );
  const durationMs = Date.now() - started;
  const summary = readSummary(reportDirectory, suite);
  const row = summary
    ? {
        suite,
        cases: summary.cases,
        passed: summary.passed,
        failed: summary.failed,
        documented: summary.documented,
        durationMs,
      }
    : {
        suite,
        cases: 0,
        passed: 0,
        failed: 1,
        documented: 0,
        durationMs,
        error: "suite did not produce a report (see vitest output above)",
      };
  if (result.error) row.error = String(result.error);
  if ((result.status ?? 1) !== 0 || row.failed > 0) exitCode = 1;
  summaries.push(row);
  console.log(`FUZZ_SUITE ${JSON.stringify(row)}`);
}

const aggregate = {
  seed: Number.parseInt(options.seed, 10),
  cases: Number.parseInt(options.cases, 10),
  suites: summaries,
  totals: {
    cases: summaries.reduce((total, row) => total + row.cases, 0),
    passed: summaries.reduce((total, row) => total + row.passed, 0),
    failed: summaries.reduce((total, row) => total + row.failed, 0),
    documented: summaries.reduce((total, row) => total + row.documented, 0),
    durationMs: summaries.reduce((total, row) => total + row.durationMs, 0),
  },
};
console.log(`FUZZ_SUMMARY_TOTAL ${JSON.stringify(aggregate)}`);
rmSync(reportDirectory, { recursive: true, force: true });
process.exit(exitCode);
