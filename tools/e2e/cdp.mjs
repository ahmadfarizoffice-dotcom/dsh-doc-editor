/**
 * Minimal CDP client for the panel e2e harness.
 *
 * Only what the suites need: one browser, one page, real key/mouse events via
 * `Input.dispatchKeyEvent` / `Input.insertText` / `Input.dispatchMouseEvent`,
 * and a JSON-returning `evaluate`.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function waitForHttp(url, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      /* retry */
    }
    if (Date.now() - started > timeoutMs)
      throw new Error(`timed out waiting for ${url}`);
    await sleep(80);
  }
}

export async function launchChrome(options) {
  const port = options.port;
  const profile = await mkdtemp(path.join(tmpdir(), "dx-e2e-chrome-"));
  const chromePath =
    options.chromePath ??
    process.env.CHROME_PATH ??
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--window-size=1440,900",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  await waitForHttp(`http://127.0.0.1:${port}/json/version`);
  const close = async () => {
    child.kill();
    await sleep(150);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  return { port, profile, child, close };
}

export function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      const handlers = listeners.get(message.method) || [];
      for (const handler of handlers) handler(message.params);
    }
  });
  return {
    ready: new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    }),
    send(method, params = {}) {
      const next = id++;
      return new Promise((resolve, reject) => {
        pending.set(next, { resolve, reject });
        socket.send(JSON.stringify({ id: next, method, params }));
      });
    },
    on(method, handler) {
      const handlers = listeners.get(method) || [];
      handlers.push(handler);
      listeners.set(method, handlers);
    },
    close() {
      socket.close();
    },
  };
}

/** Open a page target and attach. */
export async function openPage(port, url) {
  const target = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  ).then((response) => response.json());
  const client = connect(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Log.enable").catch(() => {});
  return { targetId: target.id, client };
}

export async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `evaluate failed: ${result.exceptionDetails.text} ${
        (result.exceptionDetails.exception &&
          result.exceptionDetails.exception.description) ||
        ""
      }`,
    );
  }
  return result.result.value;
}

/** Poll a page expression until it returns truthy. */
export async function waitFor(
  client,
  expression,
  { timeoutMs = 5000, intervalMs = 20, label = expression } = {},
) {
  const started = Date.now();
  for (;;) {
    const value = await evaluate(client, expression);
    if (value) return value;
    if (Date.now() - started > timeoutMs)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/* ------------------------------------------------------------ input */

const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const KEYS = {};
for (let code = 65; code <= 90; code += 1) {
  const letter = String.fromCharCode(code).toLowerCase();
  KEYS[letter] = {
    code: "Key" + letter.toUpperCase(),
    key: letter,
    keyCode: code,
  };
}
Object.assign(KEYS, {
  7: { code: "Digit7", key: "7", keyCode: 55, shiftKey: "&" },
  8: { code: "Digit8", key: "8", keyCode: 56, shiftKey: "*" },
  Digit7: { code: "Digit7", key: "7", keyCode: 55, shiftKey: "&" },
  Digit8: { code: "Digit8", key: "8", keyCode: 56, shiftKey: "*" },
  Enter: { code: "Enter", key: "Enter", keyCode: 13 },
  Tab: { code: "Tab", key: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", key: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", key: "Delete", keyCode: 46 },
  Escape: { code: "Escape", key: "Escape", keyCode: 27 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", key: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", key: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", key: "Home", keyCode: 36 },
  End: { code: "End", key: "End", keyCode: 35 },
});

/**
 * Dispatch one real key press. `combo` looks like "Ctrl+Shift+KeyB" or a plain
 * named key ("Enter"). Modifiers are accepted as Control/Ctrl, Meta/Cmd, Shift,
 * Alt. The physical `code` is what the panel matches.
 */
export async function pressKey(client, combo, options = {}) {
  const parts = String(combo).split("+");
  const final = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const key = part === "Ctrl" ? "Control" : part === "Cmd" ? "Meta" : part;
    modifiers |= MODIFIERS[key] || 0;
  }
  const base =
    KEYS[final] ||
    (final.startsWith("Key")
      ? {
          code: final,
          key: final.slice(3).toLowerCase(),
          keyCode: final.charCodeAt(3),
        }
      : { code: final, key: final, keyCode: 0 });
  const key =
    modifiers & MODIFIERS.Shift && base.shiftKey ? base.shiftKey : base.key;
  const common = {
    code: base.code,
    key,
    windowsVirtualKeyCode: base.keyCode,
    nativeVirtualKeyCode: base.keyCode,
    modifiers,
    isAutoRepeat: options.repeat === true,
  };
  await client.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    ...common,
  });
  if (!modifiers && key.length === 1)
    await client.send("Input.dispatchKeyEvent", {
      type: "char",
      text: key,
      unmodifiedText: key,
      ...common,
    });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

/** Type literal text (no key events), the way an IME or paste commits text. */
export async function insertText(client, text) {
  await client.send("Input.insertText", { text });
}

/** IME composition: set, update, then commit through a text insert. */
export async function composeText(client, stages, finalText) {
  for (const stage of stages) {
    await client.send("Input.imeSetComposition", {
      text: stage,
      selectionStart: stage.length,
      selectionEnd: stage.length,
      replacementStart: 0,
      replacementEnd: 0,
    });
  }
  await insertText(client, finalText);
}

export async function mouse(client, type, x, y, extra = {}) {
  await client.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: extra.button ?? "left",
    buttons: extra.buttons ?? (type === "mouseMoved" ? 1 : 1),
    clickCount: extra.clickCount ?? 1,
    ...extra,
  });
}

/** Drag from one viewport point to another in small steps. */
export async function drag(client, from, to, steps = 8) {
  await mouse(client, "mousePressed", from.x, from.y, { clickCount: 1 });
  for (let index = 1; index <= steps; index += 1) {
    const x = from.x + ((to.x - from.x) * index) / steps;
    const y = from.y + ((to.y - from.y) * index) / steps;
    await mouse(client, "mouseMoved", x, y, { buttons: 1 });
  }
  await mouse(client, "mouseReleased", to.x, to.y, { buttons: 0 });
}

export async function click(client, x, y, extra = {}) {
  await mouse(client, "mousePressed", x, y, extra);
  await mouse(client, "mouseReleased", x, y, { buttons: 0, ...extra });
}

/** Viewport rectangle of a selector, or null. */
export async function rectOf(client, selector) {
  return evaluate(
    client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    })()`,
  );
}

/** Center of the first text line inside a paragraph, plus a column offset. */
export async function paragraphPoint(client, blockId, fraction = 0.5) {
  return evaluate(
    client,
    `(() => {
      const element = document.querySelector('[data-block-id="' + ${JSON.stringify(blockId)} + '"]');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + Math.max(2, rect.width * ${JSON.stringify(fraction)}), y: rect.top + Math.min(rect.height / 2, 10) };
    })()`,
  );
}
