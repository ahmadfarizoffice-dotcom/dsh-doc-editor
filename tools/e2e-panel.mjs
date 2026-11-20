/**
 * End-to-end panel runner.
 *
 * Builds the plugin, boots the harness (real Host plugin + real client bundle in
 * headless Chrome), and runs named suites. Every suite runs exactly 150 cases
 * generated from its own table; the process exits non-zero when any case fails.
 *
 *   node tools/e2e-panel.mjs                              # every suite, seed 1
 *   node tools/e2e-panel.mjs --suite all --count 150 --seeds 1337,424242,9
 *   node tools/e2e-panel.mjs --suite typing-integrity,chaos --seeds 7,9
 *   node tools/e2e-panel.mjs --suite shortcuts --count 20  # quick loop
 *   node tools/e2e-panel.mjs --no-build --seed 7
 *
 * A multi-seed run prints a suite × seed matrix and writes it to
 * `tools/e2e/last-matrix.json` (gitignored output).
 *
 * Boot robustness: one server per seed, health-checked before Chrome starts;
 * every suite gets a fresh browser, a fresh page target and one bounded boot
 * retry. A wedged renderer therefore costs one retry instead of turning the
 * rest of a multi-seed run into "timed out waiting for panel boot".
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, openPage, waitFor, waitForHttp } from "./e2e/cdp.mjs";
import { configureKit } from "./e2e/kit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const SUITES = {
  shortcuts: () => import("./e2e/suites/shortcuts.mjs"),
  "selection-multiblock": () => import("./e2e/suites/selection.mjs"),
  "typing-integrity": () => import("./e2e/suites/typing.mjs"),
  formatting: () => import("./e2e/suites/formatting.mjs"),
  structure: () => import("./e2e/suites/structure.mjs"),
  "undo-redo": () => import("./e2e/suites/history.mjs"),
  "open-save-export": () => import("./e2e/suites/files.mjs"),
  "hostile-input": () => import("./e2e/suites/hostile.mjs"),
  chaos: () => import("./e2e/suites/chaos.mjs"),
  differential: () => import("./e2e/suites/differential.mjs"),
};

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
};

const suiteArg = flag("--suite", "");
const selected =
  !suiteArg || suiteArg === "all"
    ? Object.keys(SUITES)
    : suiteArg
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
const count = Number(flag("--count", "150"));
const only = flag("--only", "");
const offset = Number(flag("--offset", "0"));
const trace = argv.includes("--trace");
// `--seeds 1337,424242,9` runs the whole matrix; `--seed N` stays the
// single-seed form (and defaults to 1).
const seeds = (
  flag("--seeds", "")
    ? flag("--seeds", "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [flag("--seed", "1")]
)
  .map(Number)
  .filter((value) => Number.isFinite(value) && value > 0);
if (seeds.length === 0) seeds.push(1);
const noBuild = argv.includes("--no-build");
const keepServer = argv.includes("--keep-server");
const chromePath = flag("--chrome", process.env.CHROME_PATH);
const reloadEvery = Number(flag("--reload-every", "30"));
const matrixPath = path.resolve(
  repo,
  flag("--matrix-out", "tools/e2e/last-matrix.json"),
);

const BOOT_EXPRESSION =
  "document.readyState === 'complete' && Boolean(window.__E2E__) && Boolean(document.querySelector('.dx-para'))";

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------- server */

async function startServer(seed) {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      path.join(here, "e2e/server.mjs"),
      "--port",
      String(port),
      "--seed",
      String(seed),
    ],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
  const state = { log: "", child, port };
  child.stdout.on("data", (chunk) => {
    state.log += chunk;
  });
  child.stderr.on("data", (chunk) => {
    state.log += chunk;
  });
  // The health route only answers once the Host plugin, the workspace and the
  // React bundle are ready, so it is the correct "server is up" signal.
  await waitForHttp(`http://127.0.0.1:${port}/e2e/health`, 30000);
  state.base = `http://127.0.0.1:${port}`;
  return state;
}

/* --------------------------------------------------------------- boot */

async function closeTarget(chrome, targetId) {
  if (!chrome || !targetId) return;
  await fetch(
    `http://127.0.0.1:${chrome.port}/json/close/${encodeURIComponent(targetId)}`,
  ).catch(() => {});
}

/**
 * Open a fresh page target and wait until the panel has really mounted.
 *
 * Two independent conditions are required: the server health route still
 * answers (the Host is alive) and `window.__E2E__` exposes a rendered paragraph
 * (the client bundle booted and the bootstrap resolved). A stale target — one
 * whose execution context is gone after a renderer restart — fails the second
 * condition immediately instead of hanging on a dead CDP session.
 */
async function bootPanel({ base, chrome, label }) {
  await waitForHttp(`${base}/e2e/health`, 15000);
  const page = await openPage(chrome.port, "about:blank");
  const client = page.client;
  try {
    await client
      .send("Page.setInterceptFileChooserDialog", { enabled: true })
      .catch(() => {});
    await client.send("Page.navigate", { url: `${base}/` });
    await waitFor(client, BOOT_EXPRESSION, {
      timeoutMs: 25000,
      label: `${label} boot`,
    });
    await client
      .send("Browser.grantPermissions", {
        origin: base,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      })
      .catch(() => {});
    configureKit({ client, base });
    return page;
  } catch (error) {
    const detail = await client
      .send("Runtime.evaluate", {
        expression: `({
          readyState: document.readyState,
          hasE2e: Boolean(window.__E2E__),
          hasRoot: Boolean(document.querySelector('.dx-root')),
          paras: document.querySelectorAll('.dx-para').length,
          rootText: ((document.getElementById('root') || {}).textContent || '').slice(0, 200),
          errors: (window.__ERRORS__ || []).slice(-5),
        })`,
        returnByValue: true,
      })
      .then((result) => (result && result.result ? result.result.value : null))
      .catch((evaluateError) => ({
        evaluateFailed: String(evaluateError.message).slice(0, 200),
      }));
    await closeTarget(chrome, page.targetId);
    throw new Error(
      `${label} boot failed: ${error.message} :: ${JSON.stringify(detail)}`,
    );
  }
}

/**
 * Boot a browser + panel, retrying once on a *new* browser.
 *
 * The retry is what removes the multi-seed flakiness: the previous run kept one
 * Chrome for every suite, so a single wedged renderer (or a target whose
 * execution context was destroyed by an in-flight navigation) failed every
 * following suite with "timed out waiting for panel boot". A retry with a clear
 * message makes that failure diagnostic instead of fatal.
 */
async function openSession({ base, chrome, chromePath, label }) {
  const attempts = [];
  let active = chrome;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const page = await bootPanel({
        base,
        chrome: active,
        label: `${label} (attempt ${attempt})`,
      });
      return { chrome: active, page, attempts };
    } catch (error) {
      attempts.push(error.message);
      await active.close().catch(() => {});
      active = await launchChrome({ port: await freePort(), chromePath });
    }
  }
  await active.close().catch(() => {});
  throw new Error(
    `panel boot failed twice for ${label}: ${attempts.join(" | ")}`,
  );
}

/* -------------------------------------------------------------- cases */

async function runSuite({ loader, name, base, chrome, seed, chromePath }) {
  const module = await loader();
  const suite = module.suite ?? module.default;
  if (!suite || typeof suite.build !== "function")
    throw new Error(`suite ${name} does not export build/run`);
  const cases = suite
    .build()
    .filter((item) => (only ? String(item.id).includes(only) : true))
    .slice(offset, offset + count);

  let session = await openSession({
    base,
    chrome,
    chromePath,
    label: `${name}@seed ${seed}`,
  });
  const bootAttempts = session.attempts.length;
  let client = session.page.client;

  const started = Date.now();
  const failures = [];
  let passed = 0;
  let sinceReload = 0;

  const reloadPage = async (why) => {
    // Long suites accumulate renderer state; a cheap reload keeps the Host
    // deterministic. A reload that cannot reach the panel reboots the browser
    // instead of aborting the suite.
    try {
      await client.send("Page.navigate", { url: `${base}/` });
      await waitFor(client, BOOT_EXPRESSION, { timeoutMs: 25000, label: why });
      return;
    } catch (_error) {
      const previous = session.chrome;
      await closeTarget(previous, session.page.targetId);
      await previous.close().catch(() => {});
      session = await openSession({
        base,
        chrome: await launchChrome({ port: await freePort(), chromePath }),
        chromePath,
        label: `${why} recovery`,
      });
      client = session.page.client;
    }
  };

  for (const item of cases) {
    if (reloadEvery > 0 && sinceReload >= reloadEvery) {
      sinceReload = 0;
      try {
        await reloadPage("periodic reload");
      } catch (error) {
        await session.chrome.close().catch(() => {});
        throw error;
      }
    }
    sinceReload += 1;
    const caseStarted = Date.now();
    let timer = null;
    try {
      await Promise.race([
        suite.run(item),
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "case timed out after 45s (page or Host did not respond)",
                ),
              ),
            45000,
          );
        }),
      ]);
      passed += 1;
      if (trace)
        console.log(
          "  ok " +
            (item.id ?? cases.indexOf(item)) +
            " " +
            (Date.now() - caseStarted) +
            "ms",
        );
    } catch (error) {
      if (trace)
        console.log(
          "  FAIL " +
            (item.id ?? cases.indexOf(item)) +
            " " +
            (Date.now() - caseStarted) +
            "ms " +
            error.message,
        );
      let snapshot = null;
      try {
        snapshot = await client.send("Runtime.evaluate", {
          expression: `({
            paras: document.querySelectorAll('.dx-para').length,
            dialog: (document.querySelector('.dx-dialog h3') || {}).textContent || null,
            errors: (window.__ERRORS__ || []).slice(-3),
            dom: window.__E2E__ ? window.__E2E__.domText() : null,
            mounted: Boolean(window.__DSH_PANEL__),
            selection: window.__E2E__ ? window.__E2E__.selectionAttr() : null,
          })`,
          returnByValue: true,
        });
      } catch (snapshotError) {
        snapshot = {
          evaluateFailed: String(snapshotError.message).slice(0, 200),
        };
      }
      let hostText = null;
      try {
        const state = await fetch(`${base}/e2e/state`).then((r) => r.json());
        hostText = state && state.state ? state.state.text : null;
      } catch (_error) {
        hostText = null;
      }
      failures.push({
        case: item.id ?? String(cases.indexOf(item)),
        ms: Date.now() - caseStarted,
        error: String((error && error.message) || error).slice(0, 900),
        page: snapshot && snapshot.result && snapshot.result.value,
        hostText,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const summary = {
    suite: name,
    seed,
    cases: cases.length,
    passed,
    failed: failures.length,
    ms: Date.now() - started,
    bootAttempts,
    failures,
  };
  console.log(
    JSON.stringify({
      suite: name,
      seed,
      cases: summary.cases,
      passed: summary.passed,
      failed: summary.failed,
      ms: summary.ms,
    }),
  );
  return { summary, chrome: session.chrome };
}

/* ------------------------------------------------------------- matrix */

function printMatrix(matrix, totals, seeds) {
  const suitesSeen = [...new Set(matrix.map((row) => row.suite))];
  const width = Math.max(...suitesSeen.map((name) => name.length), 5);
  const head = [
    "suite".padEnd(width),
    ...seeds.map((seed) => `seed ${seed}`.padStart(14)),
  ].join("  ");
  console.log("");
  console.log("suite x seed matrix (passed/cases)");
  console.log(head);
  console.log("-".repeat(head.length));
  for (const suite of suitesSeen) {
    const cells = seeds.map((seed) => {
      const row = matrix.find(
        (entry) => entry.suite === suite && entry.seed === seed,
      );
      return row ? `${row.passed}/${row.cases}` : "-";
    });
    console.log(
      [suite.padEnd(width), ...cells.map((cell) => cell.padStart(14))].join(
        "  ",
      ),
    );
  }
  console.log("-".repeat(head.length));
  console.log(
    `total ${totals.passed}/${totals.cases} passed, ${totals.failed} failed across ${seeds.length} seed(s)`,
  );
}

function worstCase(matrix) {
  let worst = null;
  for (const row of matrix) {
    for (const failure of row.failures || []) {
      if (!worst || failure.ms > worst.ms)
        worst = { ...failure, suite: row.suite, seed: row.seed };
    }
  }
  return worst;
}

/**
 * Persist the matrix after every suite.
 *
 * A 3-seed × 10-suite run takes the better part of two hours; writing only at
 * the end loses every number (and the failing case ids) if the run is
 * interrupted. `complete` says whether every seed/suite cell has been measured.
 */
async function writeMatrix({
  matrix,
  totals,
  seeds,
  selected,
  runnerFailures,
}) {
  const payload = {
    generatedAt: new Date().toISOString(),
    seeds,
    count,
    suites: selected,
    totals,
    runnerFailures,
    complete: matrix.length >= seeds.length * selected.length,
    cells: seeds.length * selected.length,
    matrix: matrix.map((row) => ({
      seed: row.seed,
      suite: row.suite,
      cases: row.cases,
      passed: row.passed,
      failed: row.failed,
      ms: row.ms,
      bootAttempts: row.bootAttempts,
      failures: (row.failures || []).map((failure) => ({
        case: failure.case,
        ms: failure.ms,
        error: failure.error,
        page: failure.page,
        hostText: failure.hostText,
      })),
    })),
    worstCase: worstCase(matrix),
  };
  await mkdir(path.dirname(matrixPath), { recursive: true }).catch(() => {});
  await writeFile(matrixPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/* --------------------------------------------------------------- main */

async function main() {
  if (!noBuild) {
    const build = spawnSync(process.execPath, ["tools/build-dsh-plugin.mjs"], {
      cwd: repo,
      encoding: "utf8",
    });
    if (build.status !== 0) {
      process.stderr.write(build.stdout || "");
      process.stderr.write(build.stderr || "");
      throw new Error("plugin build failed");
    }
  }

  const matrix = [];
  let failedTotal = 0;
  let casesTotal = 0;
  let runnerFailures = 0;

  for (const seed of seeds) {
    process.env.E2E_SEED = String(seed);
    const server = await startServer(seed);
    try {
      for (const name of selected) {
        const loader = SUITES[name];
        if (!loader) throw new Error(`unknown suite ${name}`);
        let chrome = await launchChrome({
          port: await freePort(),
          chromePath,
        });
        try {
          const result = await runSuite({
            loader,
            name,
            base: server.base,
            chrome,
            seed,
            chromePath,
          });
          chrome = result.chrome;
          matrix.push(result.summary);
          casesTotal += result.summary.cases;
          failedTotal += result.summary.failed;
          await writeMatrix({
            matrix,
            totals: {
              cases: casesTotal,
              passed: casesTotal - failedTotal,
              failed: failedTotal,
            },
            seeds,
            selected,
            runnerFailures,
          });
        } catch (error) {
          // A suite that cannot even boot is a failure of that suite, not of
          // the run: record it and keep going so the matrix stays complete.
          process.stderr.write(
            `suite ${name} (seed ${seed}) could not run: ${error.message}\n`,
          );
          runnerFailures += 1;
          matrix.push({
            suite: name,
            seed,
            cases: count,
            passed: 0,
            failed: count,
            ms: 0,
            bootAttempts: 2,
            failures: [
              {
                case: "<suite boot>",
                ms: 0,
                error: String(error.message).slice(0, 900),
                page: null,
                hostText: null,
              },
            ],
          });
          casesTotal += count;
          failedTotal += count;
          await writeMatrix({
            matrix,
            totals: {
              cases: casesTotal,
              passed: casesTotal - failedTotal,
              failed: failedTotal,
            },
            seeds,
            selected,
            runnerFailures,
          });
        } finally {
          await chrome.close().catch(() => {});
        }
      }
    } finally {
      if (!keepServer) server.child.kill();
    }
  }

  const totals = {
    cases: casesTotal,
    passed: casesTotal - failedTotal,
    failed: failedTotal,
  };
  if (matrix.length > 0) {
    printMatrix(matrix, totals, seeds);
    await writeMatrix({ matrix, totals, seeds, selected, runnerFailures });
    console.log("matrix written to " + path.relative(repo, matrixPath));
  }
  if (failedTotal > 0) process.exitCode = 1;
}

await main();
