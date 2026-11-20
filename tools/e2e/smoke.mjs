/**
 * Focused smoke probe for the panel harness.
 *
 * Boots the harness, then exercises the behaviours the fix is about:
 * capture-phase shortcuts, cross-paragraph selection, typing integrity, IME and
 * the Host authoritative text. Prints one JSON object; exits non-zero when an
 * expectation is broken.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  click,
  composeText,
  drag,
  evaluate,
  insertText,
  launchChrome,
  openPage,
  paragraphPoint,
  pressKey,
  rectOf,
  sleep,
  waitFor,
  waitForHttp,
} from "./cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const serverPort = await freePort();
const server = spawn(
  process.execPath,
  [path.join(here, "server.mjs"), "--port", String(serverPort)],
  { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (chunk) => {
  serverLog += chunk;
});
server.stderr.on("data", (chunk) => {
  serverLog += chunk;
});

const base = `http://127.0.0.1:${serverPort}`;
const hostState = () =>
  fetch(`${base}/e2e/state`)
    .then((r) => r.json())
    .then((p) => p.state);
const reset = (paragraphs) =>
  fetch(`${base}/e2e/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paragraphs }),
  }).then((r) => r.json());

const results = {};
let chrome = null;
const failures = [];
try {
  await waitForHttp(`${base}/e2e/health`);
  chrome = await launchChrome({ port: await freePort() });
  const { client } = await openPage(chrome.port, "about:blank");
  let ids = [];
  const load = async () => {
    await client.send("Page.navigate", { url: `${base}/` });
    await waitFor(
      client,
      "Boolean(window.__E2E__ && document.querySelector('.dx-para'))",
      { timeoutMs: 15000, label: "panel boot" },
    );
    ids = await evaluate(
      client,
      "window.__E2E__.paragraphs().map((item) => item.id)",
    );
  };
  await load();

  results.boot = await evaluate(
    client,
    `({
      paragraphs: window.__E2E__.paragraphs(),
      shortcutsAttr: window.__E2E__.shortcutsAttr(),
      diagnostics: window.__E2E__.diagnostics(),
      errors: window.__ERRORS__,
    })`,
  );
  if (results.boot.shortcutsAttr !== "window-capture")
    failures.push("shortcuts capture attribute missing");
  if (!results.boot.diagnostics.bound) failures.push("diagnostics not bound");

  // 1. Ctrl+B on a caret formats the paragraph and posts formatText.
  await reset(["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."]);
  await load();
  let point = await paragraphPoint(client, ids[0], 0.5);
  await click(client, point.x, point.y);
  await waitFor(client, "Boolean(window.__E2E__.selectionAttr())");
  const opsBefore = await fetch(`${base}/e2e/op-log`).then((r) => r.json());
  await pressKey(client, "Ctrl+KeyB");
  await waitFor(
    client,
    `getComputedStyle(document.querySelector('[data-block-id="${ids[0]}"] .dx-run')).fontWeight === '700'`,
    { timeoutMs: 5000, label: "bold applied" },
  );
  const opsAfter = await fetch(`${base}/e2e/op-log`).then((r) => r.json());
  results.ctrlB = {
    newOps: opsAfter.ops.slice(opsBefore.total).map((entry) => entry.op),
    hijack: await evaluate(client, "window.__HIJACK__.count"),
  };
  if (!results.ctrlB.newOps.includes("formatText"))
    failures.push("Ctrl+B did not post formatText");

  // 2. Fast typing: DOM text must equal the Host text afterwards.
  await reset(["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."]);
  await load();
  point = await paragraphPoint(client, ids[0], 0.5);
  await click(client, point.x, point.y);
  await evaluate(
    client,
    `(() => { const el = document.querySelector('[data-block-id="${ids[0]}"]'); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`,
  );
  await insertText(client, "Hello world");
  await sleep(900);
  {
    const host = await hostState();
    results.typing = {
      dom: await evaluate(client, "window.__E2E__.domText()"),
      host: host.text,
      ops: (await fetch(`${base}/e2e/op-log`).then((r) => r.json())).ops.map(
        (entry) => entry.op,
      ),
    };
    if (results.typing.dom !== host.text)
      failures.push(
        `typing DOM/model divergence: ${JSON.stringify(results.typing.dom)} vs ${JSON.stringify(host.text)}`,
      );
  }

  // 3. Cross-paragraph drag: two blocks in the model selection.
  await reset(["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."]);
  await load();
  const from = await paragraphPoint(client, ids[0], 0.2);
  const to = await paragraphPoint(client, ids[1], 0.6);
  await drag(client, from, to);
  await sleep(150);
  results.dragSelection = {
    attr: await evaluate(client, "window.__E2E__.selectionAttr()"),
    blocks: await evaluate(client, "window.__E2E__.selectionBlocks()"),
    text: await evaluate(client, "String(getSelection())"),
  };
  if (!String(results.dragSelection.blocks || "").includes(","))
    failures.push("drag did not produce a multi-block selection");

  // 4. IME composition must not duplicate.
  await reset(["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."]);
  await load();
  await evaluate(
    client,
    `(() => { const el = document.querySelector('[data-block-id="${ids[2]}"]'); el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`,
  );
  await composeText(client, ["に", "にほ"], "日本");
  await sleep(900);
  const hostIme = await hostState();
  results.ime = {
    dom: await evaluate(client, "window.__E2E__.domText()"),
    host: hostIme.text,
  };
  if (results.ime.dom !== hostIme.text)
    failures.push("IME DOM/model divergence");
  if ((hostIme.text.match(/日本/g) || []).length !== 1)
    failures.push("IME text duplicated");

  // 5. A host that registers every combo must still lose to the capture phase.
  await reset(["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."]);
  await load();
  await evaluate(
    client,
    `window.__HIJACK_KEYS__ = ${JSON.stringify(["KeyB", "KeyI", "KeyU", "KeyZ", "KeyY", "KeyS", "KeyF", "KeyA", "KeyO", "KeyK", "Digit7", "Digit8"])}`,
  );
  const hijackBefore = await evaluate(client, "window.__HIJACK__.count");
  point = await paragraphPoint(client, ids[0], 0.5);
  await click(client, point.x, point.y);
  await pressKey(client, "Ctrl+KeyI");
  await sleep(600);
  results.captureWins = {
    hijacked:
      (await evaluate(client, "window.__HIJACK__.count")) - hijackBefore,
    italic: await evaluate(
      client,
      `getComputedStyle(document.querySelector('[data-block-id="${ids[0]}"] .dx-run')).fontStyle`,
    ),
  };
  if (results.captureWins.hijacked !== 0)
    failures.push("DSH-shaped bubble listener consumed the shortcut");

  // 6. Ignored when focus is outside the panel.
  await evaluate(
    client,
    `(() => { const button = document.createElement('button'); button.id = 'outside'; button.textContent = 'x'; document.body.appendChild(button); button.focus(); return true; })()`,
  );
  const hijackBeforeOutside = await evaluate(client, "window.__HIJACK__.count");
  await pressKey(client, "Ctrl+KeyB");
  await sleep(200);
  results.outsidePanel = {
    hijacked:
      (await evaluate(client, "window.__HIJACK__.count")) - hijackBeforeOutside,
  };
  if (results.outsidePanel.hijacked !== 1)
    failures.push("panel stole a shortcut while focus was outside it");

  results.errors = await evaluate(client, "window.__ERRORS__");
  results.rect = await rectOf(client, ".dx-root");
  if (results.errors.length)
    failures.push(`console errors: ${results.errors.join("; ")}`);
  results.failures = failures;
  console.log(JSON.stringify(results, null, 2));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  console.error("SMOKE FAILED:", error.message);
  console.error(serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  if (chrome) await chrome.close();
  server.kill();
}
