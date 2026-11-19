#!/usr/bin/env node
/**
 * Drives the Documents panel in headless Chromium and prints the observed state:
 * constant ribbon height, the File backstage, and opening a document from a
 * folder (which must switch the workspace and prepare a chat session).
 *
 * Usage: node tools/probe-panel.mjs [--url http://127.0.0.1:4399/] [--height 900]
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const url = arg("--url", "http://127.0.0.1:4399/");
const height = Number(arg("--height", "900"));
const port = 9334;
const chrome =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const profile = await mkdtemp(path.join(tmpdir(), "dx-probe-"));
const child = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=1440,${height}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return true;
    } catch {
      // Still starting.
    }
    await sleep(200);
  }
  return false;
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  });
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

const evaluate = async (client, expression) => {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
};

try {
  if (!(await waitForDevtools())) throw new Error("Chrome did not start");
  const target = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  ).then((response) => response.json());
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__probeErrors = [];
      window.addEventListener("error", (event) => window.__probeErrors.push(String(event.message)));
      window.addEventListener("unhandledrejection", (event) => window.__probeErrors.push(String(event.reason)));
    `,
  });
  await client.send("Page.navigate", { url });
  await sleep(2600);

  const clickByLabel = async (labelPart) =>
    evaluate(
      client,
      `(() => {
        const nodes = [...document.querySelectorAll('button,[role="tab"],[role="button"]')];
        const hit = nodes.find((node) => (node.getAttribute('aria-label') || node.textContent || '').trim().includes(${JSON.stringify(labelPart)}));
        if (!hit) return { clicked: false, label: ${JSON.stringify(labelPart)} };
        hit.click();
        return { clicked: true, label: (hit.getAttribute('aria-label') || hit.textContent || '').trim().slice(0, 60) };
      })()`,
    );

  const state = () =>
    evaluate(
      client,
      `(() => {
        const ribbon = document.querySelector('.dx-ribbon');
        const backstage = document.querySelector('.dx-backstage');
        const tab = document.querySelector('[role="tab"][aria-selected="true"]');
        const title = document.querySelector('.dx-title');
        const chip = document.querySelector('.dx-chip');
        const sessionChip = document.querySelector('.dx-session-text');
        const heading = document.querySelector('.dx-backstage h3');
        const rows = [...document.querySelectorAll('.dx-browse-item')].map((node) => node.getAttribute('aria-label'));
        return {
          ribbonHeight: ribbon ? Math.round(ribbon.getBoundingClientRect().height * 100) / 100 : null,
          expected: Math.round((window.innerHeight / 16) * 100) / 100,
          tab: tab ? tab.textContent.trim() : null,
          backstageOpen: Boolean(backstage),
          backstageHeading: heading ? heading.textContent : null,
          title: title ? title.value : null,
          chip: chip ? chip.textContent.trim() : null,
          sessionChip: sessionChip ? sessionChip.textContent.trim() : null,
          sessions: Array.isArray(window.__DSH_SESSIONS__) ? window.__DSH_SESSIONS__.slice(0, 4) : [],
          browseRows: rows.slice(0, 8),
          errors: window.__probeErrors || [],
        };
      })()`,
    );

  const report = { steps: [] };
  report.steps.push({ step: "loaded", ...(await state()) });
  report.steps.push({
    step: "click File",
    ...(await clickByLabel("File")),
    after: (await sleep(250), await state()),
  });
  report.steps.push({
    step: "click Choose folder",
    ...(await clickByLabel("Choose folder")),
    after: (await sleep(1800), await state()),
  });
  report.steps.push({
    step: "open Small memo",
    ...(await clickByLabel("Open Small memo")),
    after: (await sleep(2600), await state()),
  });
  report.steps.push({
    step: "click Home",
    ...(await clickByLabel("Home")),
    after: (await sleep(300), await state()),
  });
  console.log(JSON.stringify(report, null, 2));
  client.close();
} finally {
  child.kill();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
