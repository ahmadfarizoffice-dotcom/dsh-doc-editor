/**
 * Shared runtime for the panel e2e suites.
 *
 * Everything here drives the real page through CDP (real key and mouse events)
 * and reads the authoritative Host state through the harness control routes.
 * No suite reaches into component internals except through the panel's own
 * `__test` diagnostics.
 */
import {
  click,
  composeText,
  drag,
  evaluate,
  insertText,
  paragraphPoint,
  pressKey,
  rectOf,
  sleep,
  waitFor,
} from "./cdp.mjs";

const runtime = { client: null, base: "" };

export function configureKit(options) {
  runtime.client = options.client;
  runtime.base = options.base;
}

export function kit() {
  return runtime;
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected)
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

/* -------------------------------------------------------------- host */

async function request(path, options) {
  const response = await fetch(`${runtime.base}${path}`, options);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!response.ok || !json || json.ok === false)
    throw new Error(`host ${path} failed: ${text.slice(0, 300)}`);
  return json;
}

export async function hostState() {
  return (await request("/e2e/state")).state;
}

export async function hostDocument() {
  return (await request("/e2e/document")).bootstrap;
}

export async function opLog(since = 0) {
  return request(`/e2e/op-log?since=${since}`);
}

export async function setLatency(ms) {
  return request("/e2e/latency", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ms }),
  });
}

export async function setChaos(options) {
  return request("/e2e/chaos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
}

export async function resetHost(paragraphs) {
  return (
    await request("/e2e/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paragraphs }),
    })
  ).state;
}

/* -------------------------------------------------------------- page */

export async function evaluatePage(expression) {
  return evaluate(runtime.client, expression);
}

export async function waitForPage(expression, options) {
  return waitFor(runtime.client, expression, options);
}

export async function remount() {
  await evaluate(runtime.client, "window.__E2E__.remount(), true");
  try {
    await waitFor(
      runtime.client,
      "Boolean(document.querySelector('.dx-root') && document.querySelector('.dx-para'))",
      { timeoutMs: 5000, label: "panel remount" },
    );
  } catch (_error) {
    // A remount that cannot load (a stuck Host request, a blocked renderer)
    // must not poison every later case: reload the page and try once more.
    await runtime.client
      .send("Page.navigate", { url: `${runtime.base}/` })
      .catch(() => {});
    await waitFor(
      runtime.client,
      "Boolean(window.__E2E__ && document.querySelector('.dx-para'))",
      { timeoutMs: 20000, label: "panel reload" },
    );
  }
}

/**
 * Reset the document and remount the panel on it.
 * Returns the fresh block ids read from the DOM.
 */
export async function prepare(paragraphs, options = {}) {
  const state = await resetHost(paragraphs);
  if (state.paragraphs !== undefined) {
    /* no-op: the shape is { text, blocks, stats } */
  }
  if (options.latency !== undefined) await setLatency(options.latency);
  await remount();
  const expectedCount = paragraphs.length;
  await waitFor(
    runtime.client,
    `document.querySelectorAll('.dx-para').length === ${expectedCount}`,
    { timeoutMs: 10000, label: "paragraph count" },
  );
  const ids = await evaluate(
    runtime.client,
    "window.__E2E__.paragraphs().map((item) => item.id)",
  );
  if (options.hijackKeys) await setHijack(options.hijackKeys);
  return { state, ids };
}

export async function setHijack(keys) {
  await evaluate(
    runtime.client,
    `(window.__HIJACK_KEYS__ = ${JSON.stringify(keys)}, window.__HIJACK__.count = 0, window.__HIJACK__.keys = [], true)`,
  );
}

export async function hijackCount() {
  return evaluate(runtime.client, "window.__HIJACK__.count");
}

export async function domText() {
  return evaluate(runtime.client, "window.__E2E__.domText()");
}

export async function domParagraphs() {
  return evaluate(runtime.client, "window.__E2E__.paragraphs()");
}

export async function selectionAttr() {
  return evaluate(runtime.client, "window.__E2E__.selectionAttr()");
}

export async function selectionBlocks() {
  return evaluate(runtime.client, "window.__E2E__.selectionBlocks() || ''");
}

export async function pageErrors() {
  return evaluate(runtime.client, "window.__ERRORS__");
}

export async function dialogTitle() {
  return evaluate(runtime.client, "window.__E2E__.dialogKind()");
}

export async function errorText() {
  return evaluate(runtime.client, "window.__E2E__.errorText()");
}

export async function netEntries() {
  return evaluate(runtime.client, "window.__NET__");
}

export async function shortcutDiagnostics() {
  return evaluate(
    runtime.client,
    "window.__DSH_PANEL__ && window.__DSH_PANEL__.__test ? window.__DSH_PANEL__.__test.shortcutDiagnostics() : null",
  );
}

export async function selectionDiagnostics() {
  return evaluate(
    runtime.client,
    "window.__DSH_PANEL__ && window.__DSH_PANEL__.__test ? window.__DSH_PANEL__.__test.selectionDiagnostics() : null",
  );
}

/* ------------------------------------------------------------- input */

export async function caretAt(blockId, offset) {
  await evaluate(
    runtime.client,
    `(() => {
      const test = window.__DSH_PANEL__.__test;
      const surface = document.querySelector('.dx-editor');
      const element = document.querySelector('[data-block-id="' + ${JSON.stringify(blockId)} + '"]');
      if (!element) return false;
      element.focus();
      const range = test.domRangeForPoints(
        surface,
        { blockId: ${JSON.stringify(blockId)}, offset: ${Number(offset) || 0} },
        { blockId: ${JSON.stringify(blockId)}, offset: ${Number(offset) || 0} },
      );
      test.selectDomRange(surface, range);
      surface.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    })()`,
  );
}

/**
 * A viewport point inside the paragraph's *text*, not its box: a short
 * paragraph leaves most of its box empty, so a box-relative fraction can land
 * past the last character.
 */
export async function textPoint(blockId, fraction = 0.5) {
  const point = await evaluate(
    runtime.client,
    `(() => {
      const block = document.querySelector('[data-block-id="' + ${JSON.stringify(blockId)} + '"]');
      if (!block) return null;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      const box = block.getBoundingClientRect();
      if (!node) return { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, 8) };
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = range.getClientRects();
      const rect = rects[0] || box;
      return { x: rect.left + Math.max(1, rect.width * ${Number(fraction)}), y: rect.top + rect.height / 2 };
    })()`,
  );
  assert(point, `no rendered text point for block ${blockId}`);
  return point;
}

export async function clickBlock(blockId, fraction = 0.5, extra = {}) {
  const point = await textPoint(blockId, fraction);
  await click(runtime.client, point.x, point.y, extra);
  await sleep(30);
}

export async function clickSelector(selector) {
  const rect = await rectOf(runtime.client, selector);
  assert(rect, `no element for ${selector}`);
  await click(
    runtime.client,
    rect.x + rect.width / 2,
    rect.y + rect.height / 2,
  );
  await sleep(60);
}

export async function focusSelector(selector) {
  const ok = await evaluate(
    runtime.client,
    `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.focus();
      return true;
    })()`,
  );
  assert(ok, `no focusable element for ${selector}`);
  await sleep(20);
}

export async function press(combo, options) {
  await pressKey(runtime.client, combo, options);
  await sleep(
    options && options.settleMs !== undefined ? options.settleMs : 40,
  );
}

export async function typeText(text, delayMs = 0) {
  if (delayMs <= 0) {
    await insertText(runtime.client, text);
    return;
  }
  for (const character of text) {
    await insertText(runtime.client, character);
    await sleep(delayMs);
  }
}

export async function dragBlocks(fromBlock, fromFraction, toBlock, toFraction) {
  const from = await textPoint(fromBlock, fromFraction);
  const to = await textPoint(toBlock, toFraction);
  await drag(runtime.client, from, to);
  await sleep(60);
}

export async function selectRange(fromBlock, fromOffset, toBlock, toOffset) {
  const ok = await evaluate(
    runtime.client,
    `(() => {
      const test = window.__DSH_PANEL__.__test;
      const surface = document.querySelector('.dx-editor');
      const range = test.domRangeForPoints(
        surface,
        { blockId: ${JSON.stringify(fromBlock)}, offset: ${Number(fromOffset) || 0} },
        { blockId: ${JSON.stringify(toBlock)}, offset: ${Number(toOffset) || 0} },
      );
      if (!range) return false;
      const startElement = document.querySelector('[data-block-id="' + ${JSON.stringify(fromBlock)} + '"]');
      if (startElement) startElement.focus();
      test.selectDomRange(surface, range);
      surface.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return true;
    })()`,
  );
  assert(ok, "could not build the requested selection");
  await sleep(40);
}

export async function dispatchSyntheticKey(combo, options = {}) {
  const parts = String(combo).split("+");
  const final = parts.pop();
  const code =
    final.startsWith("Key") || final.startsWith("Digit") ? final : final;
  const key = final.startsWith("Key") ? final.slice(3).toLowerCase() : final;
  const ctrl = parts.includes("Ctrl") || parts.includes("Control");
  const shift = parts.includes("Shift");
  const alt = parts.includes("Alt");
  const blockId = options.blockId;
  await evaluate(
    runtime.client,
    `(() => {
      const target = ${
        options.useActive
          ? "document.activeElement || document.body"
          : blockId
            ? `document.querySelector('[data-block-id="' + ${JSON.stringify(blockId)} + '"]')`
            : "document.querySelector('.dx-editor')"
      };
      if (!target) return false;
      const event = new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        code: ${JSON.stringify(code)},
        ctrlKey: ${ctrl},
        shiftKey: ${shift},
        altKey: ${alt},
        bubbles: true,
        cancelable: true,
        repeat: ${options.repeat === true},
        isComposing: ${options.isComposing === true},
      });
      target.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented };
    })()`,
  );
  await sleep(40);
}

/* ----------------------------------------------------------- settle */

/**
 * Wait until the rendered text and the Host text agree and stay stable.
 * Returns the settled Host state.
 */
export async function settleText(timeoutMs = 5000) {
  const started = Date.now();
  let stable = 0;
  let last = null;
  let state = null;
  while (Date.now() - started < timeoutMs) {
    state = await hostState();
    const dom = await domText();
    if (state.text === dom) {
      if (last === state.text) {
        stable += 1;
        if (stable >= 2) return state;
      } else {
        stable = 0;
      }
      last = state.text;
    } else {
      stable = 0;
      last = null;
    }
    await sleep(70);
  }
  const dom = await domText();
  throw new Error(
    `text never settled: host=${JSON.stringify(state && state.text)} dom=${JSON.stringify(dom)}`,
  );
}

export async function settleSelector(selector, timeoutMs = 5000) {
  return waitFor(
    runtime.client,
    `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
    { timeoutMs, label: selector },
  );
}

export async function waitForHostText(expected, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await hostState();
    if (state.text === expected) return state;
    await sleep(70);
  }
  const state = await hostState();
  throw new Error(
    `host text did not become ${JSON.stringify(expected)}; it is ${JSON.stringify(state.text)}`,
  );
}

export async function opsSince(since) {
  return (await opLog(since)).ops;
}

export async function waitForOp(name, since, timeoutMs = 4000) {
  const started = Date.now();
  let ops = [];
  while (Date.now() - started < timeoutMs) {
    ops = await opsSince(since);
    if (ops.some((entry) => entry.op === name)) return ops;
    await sleep(25);
  }
  return ops;
}

export async function waitForNet(urlPart, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const entries = await netEntries();
    const match = entries.filter((entry) => entry.url.includes(urlPart));
    if (match.length) return match;
    await sleep(25);
  }
  return [];
}

export async function totalOps() {
  return (await opLog(0)).total;
}

/* ------------------------------------------------------ document read */

export async function paragraphProps() {
  const bootstrap = await hostDocument();
  const blocks = [];
  for (const section of bootstrap.document.sections || []) {
    for (const block of section.blocks || []) {
      if (block && block.type === "paragraph") {
        blocks.push({
          id: block.id,
          text: (block.inlines || [])
            .map((inline) =>
              inline && inline.type === "text"
                ? inline.text || ""
                : inline && inline.type === "tab"
                  ? "\t"
                  : "",
            )
            .join(""),
          props: block.props || {},
          inlines: (block.inlines || []).map((inline) => ({
            type: inline.type,
            text: inline.text,
            props: inline.props || {},
          })),
        });
      } else if (block && block.type === "table") {
        blocks.push({
          id: block.id,
          type: "table",
          rows: (block.rows || []).length,
        });
      }
    }
  }
  return blocks;
}

export function boldRuns(block) {
  return (block.inlines || []).filter(
    (inline) => inline.type === "text" && inline.props && inline.props.bold,
  );
}

export function para(blocks, id) {
  return blocks.find((block) => block.id === id);
}

export { sleep, insertText, composeText };

/** Click a ribbon control by its aria-label, waiting until it is enabled. */
export async function clickTool(label) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await evaluate(
      runtime.client,
      `(() => {
        const element = document.querySelector('[aria-label="' + ${JSON.stringify(label)} + '"]');
        if (!element) return "missing";
        if (element.disabled) return "disabled";
        element.click();
        return "clicked";
      })()`,
    );
    if (state === "clicked") {
      await sleep(80);
      return;
    }
    if (state === "missing" && attempt > 20)
      throw new Error(`no ribbon control labelled ${label}`);
    await sleep(60);
  }
  throw new Error(`ribbon control ${label} stayed disabled`);
}

/** Switch the ribbon tab by its visible label. */
export async function selectTab(label) {
  const clicked = await evaluate(
    runtime.client,
    `(() => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find(
        (item) => item.textContent.trim() === ${JSON.stringify(label)},
      );
      if (!tab) return false;
      tab.click();
      return true;
    })()`,
  );
  assert(clicked, `no ribbon tab ${label}`);
  await sleep(100);
}

/** Fill a dialog field (label prefix match) and submit the dialog. */
export async function fillDialogField(label, value) {
  const ok = await evaluate(
    runtime.client,
    `(() => {
      const field = [...document.querySelectorAll('.dx-dialog label')].find(
        (item) => item.textContent.trim().startsWith(${JSON.stringify(label)}),
      );
      const input = field && field.querySelector('input, textarea, select');
      if (!input) return false;
      const proto = input.tagName === 'SELECT' ? HTMLSelectElement.prototype : (input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(input, ${JSON.stringify(String(value))});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
  assert(ok, `no dialog field ${label}`);
  await sleep(60);
}

export async function submitDialog() {
  const ok = await evaluate(
    runtime.client,
    `(() => {
      const button = document.querySelector('.dx-dialog .dx-primary');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
  );
  assert(ok, "dialog submit button is missing or disabled");
  await sleep(120);
}

/** Seed selected with --seed/--seeds, so case order varies per run without changing coverage. */
export function caseSeed() {
  const value = Number(process.env.E2E_SEED || "1");
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Deterministic case order for the current seed.
 *
 * A rotation (not a shuffle) keeps every case in the suite: the seed decides
 * which case runs first, never which cases run. Two runs with the same seed
 * therefore execute the identical sequence, and different seeds still cover the
 * whole suite.
 */
export function seededCases(cases) {
  const list = Array.isArray(cases) ? cases.slice() : [];
  if (list.length === 0) return list;
  const offset = caseSeed() % list.length;
  return list.slice(offset).concat(list.slice(0, offset));
}
