#!/usr/bin/env node
/**
 * Measures the Documents ribbon height on every tab in a real Chromium and
 * prints JSON. Used to verify the constant 1/16-viewport rule.
 *
 * Usage: node tools/measure-ribbon.mjs [--url http://127.0.0.1:4399/] [--height 900]
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const urlArg = args.indexOf("--url");
const heightArg = args.indexOf("--height");
const url = urlArg >= 0 ? args[urlArg + 1] : "http://127.0.0.1:4399/";
const height = heightArg >= 0 ? Number(args[heightArg + 1]) : 900;
const port = 9333;
const chrome =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const profile = await mkdtemp(path.join(tmpdir(), "dx-measure-"));
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
      // Not listening yet.
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
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

try {
  if (!(await waitForDevtools()))
    throw new Error("Chrome DevTools did not start");
  const target = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  ).then((response) => response.json());
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send("Page.enable");
  await client.send("Page.navigate", { url });
  await sleep(2800);
  const expression = `
    (async () => {
      const wanted = ["File","Home","Insert","Design","Layout","References","View"];
      const tabs = [...document.querySelectorAll('[role="tab"]')]
        .filter((tab) => wanted.includes(tab.textContent.trim()));
      const rows = [];
      for (const tab of tabs) {
        tab.click();
        await new Promise((resolve) => setTimeout(resolve, 160));
        const ribbon = document.querySelector('.dx-ribbon');
        if (!ribbon) continue;
        const rect = ribbon.getBoundingClientRect();
        const content = ribbon.querySelector('.dx-group-items');
        rows.push({
          tab: tab.textContent.trim(),
          height: Math.round(rect.height * 100) / 100,
          top: Math.round(rect.top * 100) / 100,
          itemsScrollWidth: content ? content.scrollWidth : 0,
          itemsClientWidth: content ? content.clientWidth : 0,
        });
      }
      return {
        viewportHeight: window.innerHeight,
        expected: Math.round((window.innerHeight / 16) * 100) / 100,
        rows,
      };
    })()
  `;
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "evaluation failed");
  }
  const data = result.result.value;
  data.constant = new Set(data.rows.map((row) => row.height)).size === 1;
  console.log(JSON.stringify(data, null, 2));
  client.close();
} finally {
  child.kill();
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
