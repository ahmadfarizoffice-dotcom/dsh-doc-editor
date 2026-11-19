/**
 * End-to-end harness for the Documents panel.
 *
 * It runs the Host half of the DSH bundle (`dist/dsh-plugin/index.js`) behind a
 * small HTTP server, serves the Client half to a real browser with a stand-in
 * Slot host, and wires them to the same engine the Harness uses. That makes the
 * panel testable without restarting DeepSeek Harness, and keeps the exact code
 * paths the installed bundle runs.
 *
 * Usage: node tools/dev-documents-server.mjs [--port 4399] [--open]
 */
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const pluginDir = path.join(repo, "dist/dsh-plugin");

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? Number(args[portArg + 1]) : 4399;

const requireFromWeb = createRequire(path.join(repo, "apps/web/package.json"));

async function loadEsbuild() {
  for (const candidate of [
    path.join(repo, "package.json"),
    path.join(repo, "apps/web/package.json"),
  ]) {
    try {
      return createRequire(candidate)("esbuild");
    } catch {
      // try next
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
  // The entry lives inside apps/web so Node resolution finds react there.
  const webDir = path.join(repo, "apps/web");
  const entry = path.join(webDir, ".harness-react-entry.js");
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
  const output = path.join(webDir, ".harness-react-bundle.js");
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

function jsonResponse(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

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

const workspace = await mkdtemp(path.join(tmpdir(), "dsh-doc-panel-"));
const sampleFolder = path.join(workspace, "Reports");
await mkdir(path.join(sampleFolder, "Archive"), { recursive: true });
await writeFile(
  path.join(sampleFolder, "Q3 report.docx"),
  await readFile(
    path.join(repo, "fixtures/docx_docs_renderer_feature_test_cases.docx"),
  ),
);
await writeFile(path.join(sampleFolder, "notes.txt"), "Loose notes.\n", "utf8");

// A small importable document keeps the folder-flow browser capture light.
const engineForSeed = await import(
  pathToFileURL(path.join(pluginDir, "engine.js")).href
);
const seedService = new engineForSeed.DocumentService({
  workspaceRoot: path.join(workspace, ".seed"),
  allowedReadRoots: [workspace],
  auditPath: path.join(workspace, ".seed-audit.log"),
});
await seedService.init();
const seedCreated = await seedService.createDocument({
  title: "Small memo",
  paragraphs: [
    "Small memo opened from the folder browser.",
    "The workspace and chat session were prepared at this folder.",
  ],
});
const seedDocx = await seedService.exportDocument(
  seedCreated.documentId,
  "docx",
);
await writeFile(
  path.join(sampleFolder, "Small memo.docx"),
  Buffer.from(seedDocx.dataBase64, "base64"),
);

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
    warn: (message) => console.warn("[host]", message),
    info: () => {},
    error: console.error,
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

async function seed() {
  // Seed one document so the panel opens with content.
  const create = routes.find((route) => route.path.endsWith("dsh-documents"));
  void create;
  const call = async (method, urlPath, body) => {
    const url = new URL(urlPath, `http://127.0.0.1:${port}`);
    const route = routes.find((candidate) =>
      url.pathname.startsWith(candidate.path),
    );
    if (!route) throw new Error(`no route for ${urlPath}`);
    const chunks = [];
    const req = {
      method,
      url: url.pathname + url.search,
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        "x-dsh-documents": "1",
      },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body));
      },
    };
    const result = await new Promise((resolve) => {
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
        resolve({ status: 500, body: String(error) }),
      );
    });
    return {
      ...result,
      json: () => JSON.parse(Buffer.from(result.body).toString("utf8")),
    };
  };

  const created = await call("POST", "/api/dsh-documents/create", {
    title: "Panel editor demo",
    text: "Type here to edit the document.",
  });
  const id = created.json().documentId;
  await call("POST", "/api/dsh-documents/op", {
    id,
    op: "insertHeading",
    args: { text: "Quarterly report", level: 1 },
  });
  await call("POST", "/api/dsh-documents/op", {
    id,
    op: "insertList",
    args: {
      items: ["Revenue grew 12%", "Costs stayed flat", "Hiring on plan"],
      kind: "bullet",
    },
  });
  await call("POST", "/api/dsh-documents/op", {
    id,
    op: "insertTable",
    args: {
      rows: 3,
      columns: 3,
      headerRow: true,
      data: [
        ["Metric", "Q2", "Q3"],
        ["Revenue", "1.2M", "1.34M"],
        ["Costs", "0.8M", "0.81M"],
      ],
    },
  });
  return id;
}

const documentId = await seed();

const reactBundle = await buildReactBundle();
const clientSource = await readFile(path.join(pluginDir, "client.js"), "utf8");

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Documents panel harness</title>
<style>
  html, body { margin: 0; height: 100%; background: #f3f3f3; font-family: "Segoe UI", system-ui, sans-serif; }
  #root { height: 100%; }
  .harness-note { position: fixed; right: 12px; bottom: 12px; font-size: 11px; color: #666; }
</style>
</head>
<body>
<div id="root"></div>
<script src="/harness/react.js"></script>
<script>
  window.__DSH_HARNESS__ = { documentId: ${JSON.stringify(documentId)} };
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
    const definition = window.__DSH_DEF__;
    if (!definition) throw new Error("client module did not register");
    const React = ReactBundle.React;
    const modules = definition.factory((name) => {
      if (name === "react") return ReactBundle.React;
      throw new Error("unexpected require: " + name);
    });
    const registry = new Map();
    const hostCtx = {
      locale: { getLocale: () => ({ id: "en" }) },
      uiWorkspace: {
        async pickDirectory() {
          window.__DSH_PICKED__.push("pickDirectory");
          return window.__DSH_PICK_DIRECTORY__;
        },
        startSession(workspaceId) {
          window.__DSH_SESSIONS__.push(workspaceId);
        },
        openWorkspace() {},
        connectWorkspace() {},
      },      layout: { selectPanel() {} },
      workspaces: {
        async create({ path }) { return { id: "ws-local", path }; },
      },
      slots: {
        inject(_key, callback) { return callback(); },
        register(spec, Component) {
          registry.set(spec.key ?? spec.id, Component);
          return () => registry.delete(spec.key ?? spec.id);
        },
      },
    };
    hostCtx.get = (name) => hostCtx[name];
    modules.apply(hostCtx);
    window.__DSH_PANEL__ = modules;
    const Panel = registry.get("dsh-documents");
    if (!Panel) throw new Error("panel component was not registered");
    ReactBundle.ReactDOMClient.createRoot(document.getElementById("root")).render(
      React.createElement(Panel),
    );
    window.__DSH_READY__ = true;
  })().catch((error) => {
    document.getElementById("root").textContent = "Panel failed to start: " + error.message;
    console.error(error);
  });
</script>
<div class="harness-note">Documents panel harness</div>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const body = Buffer.from(page, "utf8");
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

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
      if (
        chunks.reduce((sum, part) => sum + part.length, 0) >
        20 * 1024 * 1024
      ) {
        jsonResponse(res, 413, {
          ok: false,
          error: { code: "PAYLOAD_TOO_LARGE", message: "body too large" },
        });
        return;
      }
    }
    const rawBody = Buffer.concat(chunks);
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

server.listen(port, "127.0.0.1", () => {
  console.log(
    `documents panel harness: http://127.0.0.1:${port}/ (document ${documentId})`,
  );
  console.log(`workspace: ${workspace}`);
});

const shutdown = async () => {
  server.close();
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
