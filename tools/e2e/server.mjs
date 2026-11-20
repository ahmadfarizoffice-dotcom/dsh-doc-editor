/**
 * E2E harness for the Documents panel.
 *
 * Boots the real Host half (`dist/dsh-plugin/index.js`) behind HTTP, serves the
 * real Client half (`dist/dsh-plugin/client.js`) to headless Chrome with a
 * stand-in Slot host, and adds only what a test driver needs:
 *
 *   - `/e2e/*` control routes (reset, state, op log, chaos)
 *   - an optional fake `shortcuts` client service (`?shortcuts=0|1|broken`)
 *   - a DSH-shaped bubble keydown listener that consumes what it recognises,
 *     replicating the live app's dispatcher so a panel listener has to win in
 *     the capture phase to be seen at all
 *
 * Chaos injects failures into `/op`, `/ops` and `/bootstrap`: half before the
 * Host applies anything, half after it applied but before the response is
 * delivered (the case that makes a naive retry duplicate text).
 *
 * Usage: node tools/e2e/server.mjs --port 4501 [--chaos] [--seed 7]
 */
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const pluginDir = path.join(repo, "dist", "dsh-plugin");

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const port = Number(valueOf("--port", "4501"));
const chaosSeed = Number(valueOf("--seed", "1"));

/* ------------------------------------------------------------ PRNG */

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const chaos = {
  enabled: args.includes("--chaos"),
  rate: Number(valueOf("--chaos-rate", "0.1")),
  rng: mulberry32(chaosSeed),
  postShare: Number(valueOf("--chaos-post-share", "0.5")),
  latencyMs: 0,
  log: [],
};

/* ------------------------------------------------ React bundle (dev) */

const requireFromWeb = createRequire(path.join(repo, "apps/web/package.json"));

async function loadEsbuild() {
  for (const candidate of [
    path.join(repo, "package.json"),
    path.join(repo, "apps/web/package.json"),
  ]) {
    try {
      return createRequire(candidate)("esbuild");
    } catch {
      /* try the next resolution root */
    }
  }
  const { readdir } = await import("node:fs/promises");
  const store = path.join(repo, "node_modules/.pnpm");
  const dir = (await readdir(store)).find((name) =>
    name.startsWith("esbuild@"),
  );
  if (!dir) throw new Error("esbuild not found");
  const mod = await import(
    pathToFileURL(path.join(store, dir, "node_modules/esbuild/lib/main.js"))
      .href
  );
  return mod.default ?? mod;
}

async function buildReactBundle() {
  const esbuild = await loadEsbuild();
  const webDir = path.join(repo, "apps/web");
  const entry = path.join(webDir, ".e2e-react-entry.js");
  await writeFile(
    entry,
    [
      'import * as React from "react";',
      'import * as ReactDOMClient from "react-dom/client";',
      'import { renderToStaticMarkup } from "react-dom/server";',
      "export { React, ReactDOMClient, renderToStaticMarkup };",
      "export default { React, ReactDOMClient, renderToStaticMarkup };",
    ].join("\n"),
    "utf8",
  );
  const output = path.join(webDir, ".e2e-react-bundle.js");
  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "ReactBundle",
      outfile: output,
      define: { "process.env.NODE_ENV": '"production"' },
      absWorkingDir: webDir,
      logLevel: "silent",
    });
    return await readFile(output, "utf8");
  } finally {
    await rm(entry, { force: true }).catch(() => {});
    await rm(output, { force: true }).catch(() => {});
  }
}

/* --------------------------------------------------------- Host wiring */

const routes = [];
const fakeWebServer = {
  getOrigin: () => `http://127.0.0.1:${port}`,
  register(route) {
    routes.push(route);
    return () => {
      const index = routes.indexOf(route);
      if (index >= 0) routes.splice(index, 1);
    };
  },
  registerFallback() {
    return () => {};
  },
  tapIndex() {
    return () => {};
  },
};

const workspace = await mkdtemp(path.join(tmpdir(), "dsh-doc-e2e-"));
const sampleFolder = path.join(workspace, "Reports");
await mkdir(path.join(sampleFolder, "Archive"), { recursive: true });
await writeFile(
  path.join(sampleFolder, "Q3 report.docx"),
  await readFile(
    path.join(repo, "fixtures/docx_docs_renderer_feature_test_cases.docx"),
  ),
);
await writeFile(path.join(sampleFolder, "notes.txt"), "Loose notes.\n", "utf8");

const fakeRegistry = new Map();
const fakeWorkspaceRegistry = {
  resolveByPath(candidate) {
    return fakeRegistry.get(path.resolve(candidate));
  },
  async create(candidate, title) {
    const resolved = path.resolve(candidate);
    const existing = fakeRegistry.get(resolved);
    if (existing) return existing;
    const record = {
      id: `ws-${fakeRegistry.size + 1}`,
      path: resolved,
      title: title ?? path.basename(resolved),
    };
    fakeRegistry.set(resolved, record);
    return record;
  },
  list() {
    return [...fakeRegistry.values()];
  },
};

const plugin = await import(
  pathToFileURL(path.join(pluginDir, "index.js")).href
);
const ctx = {
  logger: {
    warn: () => {},
    info: () => {},
    error: () => {},
  },
  tools: { register: () => () => {} },
  effect(fn) {
    const dispose = fn();
    return () => dispose?.();
  },
  get(name) {
    if (name === "webServer") return fakeWebServer;
    if (name === "workspaceRegistry") return fakeWorkspaceRegistry;
    return undefined;
  },
};
plugin.apply(ctx, { workspaceDir: workspace });

/* ------------------------------------------------------- Host helpers */

async function hostCall(method, urlPath, body) {
  const url = new URL(urlPath, `http://127.0.0.1:${port}`);
  const route = routes.find((candidate) =>
    url.pathname.startsWith(candidate.path),
  );
  if (!route) throw new Error(`no route for ${urlPath}`);
  const raw =
    body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const req = {
    method,
    url: url.pathname + url.search,
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      "content-type": "application/json",
      "x-dsh-documents": "1",
    },
    async *[Symbol.asyncIterator]() {
      if (raw.length > 0) yield raw;
    },
  };
  const captured = await new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(status, headers) {
        this.statusCode = status;
        Object.assign(this.headers, headers ?? {});
        return this;
      },
      end(buffer) {
        resolve({
          status: this.statusCode,
          headers: this.headers,
          body: buffer,
        });
      },
      write() {},
    };
    Promise.resolve(route.handler(req, res)).catch((error) =>
      resolve({ status: 500, body: Buffer.from(String(error)) }),
    );
  });
  const text = Buffer.from(captured.body ?? "").toString("utf8");
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!json || json.ok === false) {
    const error = new Error(
      `host ${method} ${urlPath} failed: ${text.slice(0, 400)}`,
    );
    error.status = captured.status;
    error.payload = json;
    throw error;
  }
  return json;
}

const documentId = (
  await hostCall("POST", "/api/dsh-documents/create", {
    title: "E2E document",
    text: "",
  })
).documentId;

const opLog = [];
/** Every accepted op request, in order, for op-count assertions. */
function recordOps(kind, payload) {
  const list =
    kind === "ops" && Array.isArray(payload.ops) ? payload.ops : [payload];
  for (const entry of list) {
    opLog.push({
      at: Date.now(),
      kind,
      op: entry && entry.op,
      args: entry && entry.args,
    });
  }
}

async function projectState() {
  const bootstrap = await hostCall(
    "GET",
    `/api/dsh-documents/bootstrap?id=${encodeURIComponent(documentId)}`,
  );
  const document = bootstrap.document || { sections: [] };
  const blocks = [];
  for (const section of document.sections || []) {
    for (const block of section.blocks || []) {
      if (block && block.type === "paragraph") {
        const text = (block.inlines || [])
          .map((inline) => {
            if (!inline) return "";
            if (inline.type === "text") return inline.text || "";
            if (inline.type === "tab") return "\t";
            if (inline.type === "break")
              return inline.kind === "page" ? "\f" : "\n";
            if (inline.type === "image") return "\uFFFC";
            return inline.text || "";
          })
          .join("");
        blocks.push({ id: block.id, text });
      } else if (block && block.type === "table") {
        blocks.push({ id: block.id, type: "table" });
      }
    }
  }
  const text = blocks
    .filter((block) => block.type !== "table")
    .map((block) => block.text)
    .join("\n");
  return {
    documentId,
    blocks,
    text,
    stats: bootstrap.stats || {},
    pageCount: bootstrap.pageCount || 0,
    revision: bootstrap.revision || 0,
    readOnly: bootstrap.readOnly === true,
    title: bootstrap.title || "",
    dirty: bootstrap.dirty === true,
  };
}

async function resetDocument(paragraphs) {
  const before = await projectState();
  const paragraphsBefore = before.blocks.filter(
    (block) => block.type !== "table",
  );
  if (paragraphsBefore.length > 0) {
    const first = paragraphsBefore[0];
    const last = paragraphsBefore[paragraphsBefore.length - 1];
    await hostCall("POST", "/api/dsh-documents/op", {
      id: documentId,
      op: "deleteRange",
      args: {
        range: {
          start: { blockId: first.id, offset: 0 },
          end: { blockId: last.id, offset: last.text.length },
        },
      },
    });
  }
  const after = await projectState();
  const firstId = (after.blocks.find((block) => block.type !== "table") || {})
    .id;
  const text = (paragraphs || []).join("\n");
  if (firstId && text) {
    await hostCall("POST", "/api/dsh-documents/op", {
      id: documentId,
      op: "insertText",
      args: { position: { blockId: firstId, offset: 0 }, text },
    });
  }
  return projectState();
}

/* ------------------------------------------------------------- chaos */

function chaosDecision(kind) {
  if (!chaos.enabled) return null;
  const roll = chaos.rng();
  if (roll >= chaos.rate) return null;
  const post = chaos.rng() < chaos.postShare;
  chaos.log.push({ kind, roll, post });
  return { kind, post };
}

function failureBody(kind, post) {
  return Buffer.from(
    JSON.stringify({
      ok: false,
      error: {
        code: post ? "CHAOS_RESPONSE_LOST" : "CHAOS_INJECTED",
        message: `injected ${kind} failure (${post ? "response lost" : "before apply"})`,
      },
    }),
  );
}

function sendFailure(res, kind, post) {
  const body = failureBody(kind, post);
  res.writeHead(500, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

/* ---------------------------------------------------------- page HTML */

await resetDocument([
  "Alpha paragraph.",
  "Beta paragraph.",
  "Gamma paragraph.",
]);

const reactBundle = await buildReactBundle();
const clientSource = await readFile(path.join(pluginDir, "client.js"), "utf8");

function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Documents panel e2e</title>
<style>
  html, body { margin: 0; height: 100%; background: #f3f3f3; font-family: "Segoe UI", system-ui, sans-serif; }
  #root { height: 100%; }
</style>
</head>
<body>
<div id="root"></div>
<script src="/harness/react.js"></script>
<script>
  window.__ERRORS__ = [];
  window.addEventListener("error", (event) => window.__ERRORS__.push("error: " + (event.message || "")));
  window.addEventListener("unhandledrejection", (event) => window.__ERRORS__.push("unhandled: " + String((event.reason && event.reason.message) || event.reason)));
  const originalError = console.error;
  console.error = function (...parts) { window.__ERRORS__.push("console: " + parts.map(String).join(" ")); originalError.apply(console, parts); };

  // Every request the panel makes, so a suite can count text ops.
  window.__NET__ = [];
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : String(input && input.url || "");
    const entry = { at: Date.now(), url, op: null, body: null };
    try {
      if (typeof (init && init.body) === "string") {
        entry.body = init.body;
        const parsed = JSON.parse(init.body);
        entry.op = parsed.op || (Array.isArray(parsed.ops) ? parsed.ops.map((item) => item.op) : null);
      }
    } catch (_error) { /* keep the raw url */ }
    window.__NET__.push(entry);
    return originalFetch.apply(this, arguments);
  };

  // DSH-shaped shortcut dispatcher: bubble phase on window, consumes what it
  // knows. The panel has to intercept in the capture phase to be seen first.
  window.__HIJACK__ = { count: 0, keys: [] };
  window.__HIJACK_KEYS__ = ["KeyB"];
  window.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    if (!window.__HIJACK_KEYS__.includes(event.code)) return;
    window.__HIJACK__.count += 1;
    window.__HIJACK__.keys.push((event.ctrlKey ? "Ctrl+" : "Cmd+") + (event.shiftKey ? "Shift+" : "") + event.code);
    event.preventDefault();
    event.stopPropagation();
  });

  // Native browser accelerators (open/save/print/find) would open real
  // dialogs that block a headless run. The real app handles these at the
  // menu/native layer, so the harness suppresses only the combos that no
  // handler consumed (bubble phase, after the panel had its chance).
  // View source (Ctrl+U), history (Ctrl+Y), address bar (Ctrl+K), bookmarks
  // (Ctrl+B/D), print (Ctrl+P) … all open real browser UI. Electron never runs
  // these because the app owns the accelerators, so the harness stands in for
  // that layer: consume whatever no handler consumed. Copy/cut/paste stay
  // native because the panel relies on them.
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const match = /^Key([A-Z])$/.exec(event.code);
    if (!match) return;
    if (match[1] === "C" || match[1] === "X" || match[1] === "V") return;
    event.preventDefault();
  }, false);

  window.__DSH_HARNESS__ = { documentId: ${JSON.stringify(documentId)}, e2e: true };
  window.__DSH_PICK_DIRECTORY__ = ${JSON.stringify(sampleFolder)};
  window.__DSH_PICKED__ = [];
  window.__DSH_SESSIONS__ = [];
  window.__DSH_PANEL__ = null;
  window.__ModuleLoader__ = {
    load(definition) { window.__DSH_DEF__ = definition; },
  };
  window.React = ReactBundle.React;
</script>
<script src="/harness/client.js"></script>
<script>
  (async function boot() {
    const params = new URLSearchParams(location.search);
    const shortcutsMode = params.get("shortcuts") || "0";
    const conflictCodes = (params.get("conflicts") || "").split(",").filter(Boolean);
    window.__E2E_SHORTCUT_CONFLICTS__ = conflictCodes;
    const definition = window.__DSH_DEF__;
    if (!definition) throw new Error("client module did not register");
    const React = ReactBundle.React;
    const modules = definition.factory((name) => {
      if (name === "react") return ReactBundle.React;
      throw new Error("unexpected require: " + name);
    });
    const registry = new Map();
    window.__E2E_SHORTCUT_REGISTERED__ = [];
    const shortcutsMock = {
      runtime: "web",
      platform: "windows",
      catalog: { getSnapshot: () => [], subscribe: () => () => {} },
      register(command) {
        if (shortcutsMode === "broken") throw new Error("shortcuts registry unavailable");
        const record = {
          id: command.id,
          regions: command.regions,
          modals: command.modals,
          defaults: command.defaults,
        };
        window.__E2E_SHORTCUT_REGISTERED__.push(record);
        return () => {
          const at = window.__E2E_SHORTCUT_REGISTERED__.indexOf(record);
          if (at >= 0) window.__E2E_SHORTCUT_REGISTERED__.splice(at, 1);
        };
      },
      describeBinding(binding) {
        // Model the real reservation precisely: only primary+KeyB (no shift,
        // no alt) is owned by the host's sidebar toggle.
        const modifiers = binding.modifiers || [];
        const conflicts =
          (window.__E2E_SHORTCUT_CONFLICTS__ || []).includes(binding.code) &&
          modifiers.includes("primary") &&
          !modifiers.includes("shift") &&
          !modifiers.includes("alt")
            ? ["sidebar.left.toggle"]
            : [];
        return { binding, keys: [], issue: null, conflicts };
      },
      registerFixed() { return () => {}; },
      observeFixedInput() { return () => {}; },
    };
    const hostCtx = {
      locale: { getLocale: () => ({ id: "en" }) },
      uiWorkspace: {
        async pickDirectory() {
          window.__DSH_PICKED__.push("pickDirectory");
          return window.__DSH_PICK_DIRECTORY__;
        },
        startSession(workspaceId) { window.__DSH_SESSIONS__.push(workspaceId); },
        openWorkspace() {},
        connectWorkspace() {},
      },
      layout: { selectPanel() {} },
      workspaces: { async create({ path }) { return { id: "ws-local", path }; } },
      slots: {
        inject(_key, callback) { return callback(); },
        register(spec, Component) {
          registry.set(spec.key ?? spec.id, Component);
          return () => registry.delete(spec.key ?? spec.id);
        },
      },
    };
    if (shortcutsMode !== "0") hostCtx.shortcuts = shortcutsMock;
    hostCtx.get = (name) => hostCtx[name];
    modules.apply(hostCtx);
    window.__DSH_PANEL__ = modules;
    const Panel = registry.get("dsh-documents");
    if (!Panel) throw new Error("panel component was not registered");
    let root = null;
    let host = document.getElementById("root");
    window.__E2E__ = {
      modules,
      mount() {
        // Replace the container instead of reusing it: React 18 does not
        // support createRoot() twice on one container, and a reused container
        // leaks the previous root's listeners (handlers multiply per remount).
        if (root) { root.unmount(); root = null; }
        const fresh = document.createElement("div");
        fresh.id = "root";
        host.replaceWith(fresh);
        host = fresh;
        root = ReactBundle.ReactDOMClient.createRoot(host);
        root.render(React.createElement(Panel));
      },
      remount() { this.mount(); },
      ready() { return Boolean(document.querySelector(".dx-para")); },
      unmount() { if (root) { root.unmount(); root = null; } host.innerHTML = ""; },
      rootEl() { return document.querySelector(".dx-root"); },
      surface() { return document.querySelector(".dx-editor"); },
      paragraphs() {
        const test = window.__DSH_PANEL__.__test;
        return [...document.querySelectorAll(".dx-para")].map((element) => ({
          id: element.getAttribute("data-block-id"),
          text: test.domTextOfBlock(element),
        }));
      },
      selectionAttr() {
        const surface = document.querySelector(".dx-editor");
        return surface ? surface.getAttribute("data-dx-selection") : null;
      },
      selectionBlocks() {
        const surface = document.querySelector(".dx-editor");
        return surface ? surface.getAttribute("data-dx-selection-blocks") : null;
      },
      shortcutsAttr() {
        const rootElement = document.querySelector(".dx-root");
        return rootElement ? rootElement.getAttribute("data-dx-shortcuts") : null;
      },
      diagnostics() {
        const test = window.__DSH_PANEL__ && window.__DSH_PANEL__.__test;
        return test && test.shortcutDiagnostics ? test.shortcutDiagnostics() : null;
      },
      domText() {
        // innerText of an empty paragraph counts the <br> placeholder as a
        // line, which would misreport the model text; use the panel's own
        // DOM-to-model projection instead.
        const test = window.__DSH_PANEL__.__test;
        return [...document.querySelectorAll(".dx-para")]
          .map((element) => test.domTextOfBlock(element))
          .join("\\n");
      },
      errorText() {
        const bar = document.querySelector(".dx-error");
        return bar ? bar.textContent : null;
      },
      dialogKind() {
        const dialog = document.querySelector(".dx-dialog");
        if (!dialog) return null;
        const title = dialog.querySelector("h3");
        return title ? title.textContent : dialog.getAttribute("aria-label");
      },
    };
    window.__SEL_HISTORY__ = [];
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName !== "data-dx-selection") continue;
        window.__SEL_HISTORY__.push({ at: Date.now(), value: record.target.getAttribute("data-dx-selection") });
        if (window.__SEL_HISTORY__.length > 40) window.__SEL_HISTORY__.shift();
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-dx-selection"] });
    window.__E2E__.mount();
  })().catch((error) => {
    document.getElementById("root").textContent = "Panel failed to start: " + error.message;
    window.__ERRORS__.push("boot: " + error.message);
  });
</script>
</body>
</html>`;
}

/* -------------------------------------------------------------- server */

function jsonResponse(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const body = Buffer.from(pageHtml(), "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(body.length),
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/harness/react.js") {
      const body = Buffer.from(reactBundle, "utf8");
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-length": String(body.length),
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/harness/client.js") {
      const body = Buffer.from(clientSource, "utf8");
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-length": String(body.length),
      });
      res.end(body);
      return;
    }

    if (url.pathname === "/e2e/health") {
      jsonResponse(res, 200, { ok: true, documentId });
      return;
    }
    if (url.pathname === "/e2e/state") {
      jsonResponse(res, 200, { ok: true, state: await projectState() });
      return;
    }
    if (url.pathname === "/e2e/document") {
      const bootstrap = await hostCall(
        "GET",
        `/api/dsh-documents/bootstrap?id=${encodeURIComponent(documentId)}`,
      );
      jsonResponse(res, 200, { ok: true, bootstrap });
      return;
    }
    if (url.pathname === "/e2e/latency") {
      const body = await readJsonBody(req);
      if (typeof body.ms === "number") chaos.latencyMs = Math.max(0, body.ms);
      jsonResponse(res, 200, { ok: true, latencyMs: chaos.latencyMs });
      return;
    }
    if (url.pathname === "/e2e/reset") {
      const body = await readJsonBody(req);
      const state = await resetDocument(body.paragraphs || []);
      jsonResponse(res, 200, { ok: true, state });
      return;
    }
    if (url.pathname === "/e2e/op-log") {
      const since = Number(url.searchParams.get("since") || "0");
      jsonResponse(res, 200, {
        ok: true,
        total: opLog.length,
        ops: opLog.slice(since),
      });
      return;
    }
    if (url.pathname === "/e2e/chaos") {
      const body = await readJsonBody(req);
      if (typeof body.enabled === "boolean") chaos.enabled = body.enabled;
      if (typeof body.rate === "number") chaos.rate = body.rate;
      if (typeof body.seed === "number") chaos.rng = mulberry32(body.seed);
      if (typeof body.postShare === "number") chaos.postShare = body.postShare;
      jsonResponse(res, 200, {
        ok: true,
        chaos: {
          enabled: chaos.enabled,
          rate: chaos.rate,
          postShare: chaos.postShare,
          injected: chaos.log.length,
        },
      });
      return;
    }
    if (url.pathname === "/e2e/ops") {
      // Apply an op script through the Host API (differential reference arm).
      const body = await readJsonBody(req);
      const results = [];
      for (const entry of body.ops || []) {
        results.push(
          await hostCall("POST", "/api/dsh-documents/op", {
            id: documentId,
            op: entry.op,
            args: entry.args || {},
          }),
        );
      }
      jsonResponse(res, 200, {
        ok: true,
        results,
        state: await projectState(),
      });
      return;
    }

    const route = routes.find((candidate) =>
      url.pathname.startsWith(candidate.path),
    );
    if (!route) {
      jsonResponse(res, 404, {
        ok: false,
        error: { code: "NOT_FOUND", message: "no route" },
      });
      return;
    }

    const rawBody = await readBody(req);
    if (chaos.latencyMs > 0) await sleep(chaos.latencyMs);
    const kind = url.pathname.endsWith("/op")
      ? "op"
      : url.pathname.endsWith("/ops")
        ? "ops"
        : url.pathname.endsWith("/bootstrap")
          ? "bootstrap"
          : null;
    const decision = kind ? chaosDecision(kind) : null;
    if (decision && !decision.post) {
      sendFailure(res, decision.kind, false);
      return;
    }

    const replay = {
      method: req.method,
      url: req.url,
      headers: {
        ...req.headers,
        "x-dsh-documents": "1",
        origin: `http://127.0.0.1:${port}`,
      },
      async *[Symbol.asyncIterator]() {
        if (rawBody.length > 0) yield rawBody;
      },
    };

    if (decision && decision.post) {
      // Run the Host handler against a throwaway response, then report a
      // failure: the Host applied the op, the client never learns it.
      const captured = await new Promise((resolve) => {
        const sink = {
          statusCode: 200,
          headers: {},
          writeHead(status, headers) {
            this.statusCode = status;
            Object.assign(this.headers, headers ?? {});
            return this;
          },
          end() {
            resolve({ status: this.statusCode });
          },
          write() {},
        };
        Promise.resolve(route.handler(replay, sink)).catch(() =>
          resolve({ status: 500 }),
        );
      });
      if (captured.status < 400) {
        sendFailure(res, decision.kind, true);
        return;
      }
      sendFailure(res, decision.kind, false);
      return;
    }

    if (kind === "op" || kind === "ops") {
      try {
        const parsed = JSON.parse(rawBody.toString("utf8") || "{}");
        recordOps(kind, parsed);
      } catch {
        /* the Host reports malformed bodies itself */
      }
    }
    await route.handler(replay, res);
  } catch (error) {
    jsonResponse(res, 200, {
      ok: false,
      error: {
        code: "HARNESS_ERROR",
        message: String(error?.message ?? error),
      },
    });
  }
});

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString("utf8"));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

server.listen(port, "127.0.0.1", () => {
  console.log(
    JSON.stringify({
      ready: true,
      url: `http://127.0.0.1:${port}/`,
      documentId,
      chaos: chaos.enabled,
      seed: chaosSeed,
    }),
  );
});

const shutdown = async () => {
  server.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
