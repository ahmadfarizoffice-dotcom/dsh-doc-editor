/**
 * End-to-end panel runner.
 *
 * Builds the plugin, boots the harness (real Host plugin + real client bundle in
 * headless Chrome), and runs named suites. Every suite runs exactly 150 cases
 * generated from its own table and prints a JSON summary; the process exits
 * non-zero when any case fails.
 *
 *   node tools/e2e-panel.mjs                 # every suite
 *   node tools/e2e-panel.mjs --suite shortcuts,selection-multiblock
 *   node tools/e2e-panel.mjs --count 20 --suite shortcuts   # quick loop
 *   node tools/e2e-panel.mjs --no-build --seed 7
 */
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, openPage, waitForHttp } from "./e2e/cdp.mjs";
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
const trace = argv.includes("--trace");
const seed = Number(flag("--seed", "1"));
process.env.E2E_SEED = String(seed);
const noBuild = argv.includes("--no-build");
const keepServer = argv.includes("--keep-server");
const chromePath = flag("--chrome", process.env.CHROME_PATH);

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

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

  const serverPort = await freePort();
  const server = spawn(
    process.execPath,
    [
      path.join(here, "e2e/server.mjs"),
      "--port",
      String(serverPort),
      "--seed",
      String(seed),
    ],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
  let serverLog = "";
  server.stdout.on("data", (chunk) => {
    serverLog += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverLog += chunk;
  });

  let chrome = null;
  const summaries = [];
  let failedTotal = 0;
  try {
    await waitForHttp(`http://127.0.0.1:${serverPort}/e2e/health`);
    chrome = await launchChrome({ port: await freePort(), chromePath });
    const page = await openPage(chrome.port, "about:blank");
    const client = page.client;
    const base = `http://127.0.0.1:${serverPort}`;
    await client.send("Page.navigate", { url: `${base}/` });
    await waitForHttp(`${base}/e2e/health`);
    const { waitFor } = await import("./e2e/cdp.mjs");
    await waitFor(
      client,
      "Boolean(window.__E2E__ && document.querySelector('.dx-para'))",
      {
        timeoutMs: 20000,
        label: "panel boot",
      },
    );
    await client
      .send("Page.setInterceptFileChooserDialog", { enabled: true })
      .catch(() => {});
    await client
      .send("Browser.grantPermissions", {
        origin: `http://127.0.0.1:${serverPort}`,
        permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      })
      .catch(() => {});
    configureKit({ client, base });

    for (const name of selected) {
      const loader = SUITES[name];
      if (!loader) throw new Error(`unknown suite ${name}`);
      const module = await loader();
      const suite = module.suite ?? module.default;
      if (!suite || typeof suite.build !== "function")
        throw new Error(`suite ${name} does not export build/run`);
      const cases = suite
        .build()
        .filter((item) => (only ? String(item.id).includes(only) : true))
        .slice(0, count);
      const started = Date.now();
      const failures = [];
      let passed = 0;
      const reloadEvery = Number(flag("--reload-every", "30"));
      let sinceReload = 0;
      for (const item of cases) {
        // Long suites accumulate renderer state; a cheap page reload keeps the
        // Host deterministic and prevents one slow remount from cascading.
        if (reloadEvery > 0 && sinceReload >= reloadEvery) {
          sinceReload = 0;
          await client
            .send("Page.navigate", { url: `${base}/` })
            .catch(() => undefined);
          await waitFor(
            client,
            "Boolean(window.__E2E__ && document.querySelector('.dx-para'))",
            { timeoutMs: 20000, label: "periodic reload" },
          );
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
                net: (window.__NET__ || []).slice(-3).map((entry) => entry.url),
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
          failures.push({
            case: item.id ?? String(cases.indexOf(item)),
            ms: Date.now() - caseStarted,
            error: String((error && error.message) || error).slice(0, 600),
            page: snapshot && snapshot.result && snapshot.result.value,
          });
          failedTotal += 1;
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      const summary = {
        suite: name,
        cases: cases.length,
        passed,
        failed: failures.length,
        ms: Date.now() - started,
        failures,
      };
      summaries.push(summary);
      console.log(JSON.stringify(summary));
    }
  } catch (error) {
    process.stderr.write(`e2e runner failed: ${error.message}\n`);
    process.stderr.write(serverLog.slice(-4000));
    process.exitCode = 1;
  } finally {
    if (chrome) await chrome.close().catch(() => {});
    if (!keepServer) server.kill();
    if (summaries.length) {
      const total = summaries.reduce((sum, entry) => sum + entry.cases, 0);
      console.log(
        JSON.stringify({
          totalCases: total,
          passed: total - failedTotal,
          failed: failedTotal,
          suites: summaries.map((entry) => ({
            suite: entry.suite,
            cases: entry.cases,
            passed: entry.passed,
            failed: entry.failed,
            ms: entry.ms,
          })),
        }),
      );
    }
    if (failedTotal > 0) process.exitCode = 1;
  }
}

await main();
