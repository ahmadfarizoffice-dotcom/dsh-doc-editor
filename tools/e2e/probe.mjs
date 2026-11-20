/**
 * Ad-hoc probe runner for the panel e2e harness.
 *
 * Boots the same server + headless Chrome the real runner uses, then executes
 * one scenario file so a single flaky case can be observed with a full
 * timeline instead of a pass/fail line. Not part of the suite matrix:
 *
 *   node tools/e2e/probe.mjs backspace
 *
 * Every probe receives `{ client, base, kit, cdp, log }` and returns a JSON
 * value that is printed at the end.
 */
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { launchChrome, openPage, waitFor, waitForHttp } from "./cdp.mjs";
import { configureKit } from "./kit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const name = process.argv[2] || "backspace";
const seed = Number(process.argv[3] || "1337");

const serverPort = await freePort();
const server = spawn(
  process.execPath,
  [
    path.join(here, "server.mjs"),
    "--port",
    String(serverPort),
    "--seed",
    String(seed),
  ],
  { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
);
server.stdout.on("data", () => {});
server.stderr.on("data", (chunk) => process.stderr.write(chunk));

let chrome = null;
const log = (...parts) => console.log(...parts);
try {
  await waitForHttp(`http://127.0.0.1:${serverPort}/e2e/health`);
  chrome = await launchChrome({ port: await freePort() });
  const page = await openPage(chrome.port, "about:blank");
  const client = page.client;
  const base = `http://127.0.0.1:${serverPort}`;
  await client.send("Page.navigate", { url: `${base}/` });
  await waitFor(
    client,
    "Boolean(window.__E2E__ && document.querySelector('.dx-para'))",
    {
      timeoutMs: 30000,
      label: "panel boot",
    },
  );
  configureKit({ client, base });
  const probe = await import(`./probes/${name}.mjs`);
  const result = await probe.run({
    client,
    base,
    log,
    cdp: await import("./cdp.mjs"),
    kit: await import("./kit.mjs"),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  process.stderr.write(`probe failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
} finally {
  if (chrome) await chrome.close().catch(() => {});
  server.kill();
}
