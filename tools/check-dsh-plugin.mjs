#!/usr/bin/env node
/**
 * Validates the built DSH bundle in `dist/dsh-plugin` before it is published:
 * manifest shape, required files, locale metadata, client identity, Host tool
 * registration, and an end-to-end document round trip through the plugin's own
 * tool entry points with a mock Cordis context.
 */
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const dir = path.join(repo, "dist/dsh-plugin");

const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
check(
  pkg.dsh?.bundle?.patch === "./cordis.patch.yml",
  "package.json must declare dsh.bundle.patch",
);
check(Boolean(pkg.exports?.["./client"]), "package.json must export ./client");
check(
  Boolean(pkg.exports?.["./locale/*.json"]),
  "package.json must export locale JSON",
);
check(Boolean(pkg.exports?.["./icon"]), "package.json must export ./icon");
check(
  pkg.engines?.dsh === ">=0.2.2-rc.3",
  "engines.dsh must require 0.2.2-rc.3 or newer",
);

for (const file of [
  "engine.js",
  "index.js",
  "client.js",
  "cordis.patch.yml",
  "icon.svg",
  "README.md",
  "INSTALL.md",
  "LICENSE",
  "docs/DETAIL.md",
  "docs/preview.svg",
  "locale/en.json",
  "locale/id.json",
]) {
  const exists = await stat(path.join(dir, file))
    .then(() => true)
    .catch(() => false);
  check(exists, `missing required file: ${file}`);
}

for (const locale of ["en", "id"]) {
  const data = JSON.parse(
    await readFile(path.join(dir, `locale/${locale}.json`), "utf8"),
  );
  check(
    typeof data.meta?.title === "string" && data.meta.title.length > 0,
    `locale/${locale}.json needs meta.title`,
  );
  check(
    typeof data.meta?.description === "string" &&
      data.meta.description.length > 80,
    `locale/${locale}.json needs a descriptive meta.description`,
  );
  check(
    data.meta?.detail === "docs/DETAIL.md",
    `locale/${locale}.json meta.detail must be docs/DETAIL.md`,
  );
}

const detail = await readFile(path.join(dir, "docs/DETAIL.md"), "utf8");
check(
  /^!\[[^\]]+\]\(preview\.svg\)/m.test(detail.trim()),
  "docs/DETAIL.md must be one image line referencing preview.svg",
);
const preview = await readFile(path.join(dir, "docs/preview.svg"), "utf8");
check(preview.startsWith("<svg"), "docs/preview.svg is not an SVG");
check(
  !/<text|<foreignObject|<script/i.test(preview),
  "docs/preview.svg must not contain text, foreignObject or scripts",
);
const icon = await readFile(path.join(dir, "icon.svg"), "utf8");
check(icon.startsWith("<svg"), "icon.svg is not an SVG");

const client = await readFile(path.join(dir, "client.js"), "utf8");
const clientId = /id:\s*"([^"]+)"/.exec(client)?.[1];
check(
  clientId === pkg.name,
  `client module id ${clientId ?? "(none)"} must equal package name ${pkg.name}`,
);
check(
  client.includes("sidebar.panellist"),
  "client.js must register a sidebar panel icon",
);
check(
  client.includes('{ name: "main", key: PANEL_ID }'),
  "client.js must register the main panel",
);

const host = await readFile(path.join(dir, "index.js"), "utf8");
check(host.includes("export const inject"), "index.js must export inject");
check(host.includes("ctx.tools.register"), "index.js must register tools");

const plugin = await import(pathToFileURL(path.join(dir, "index.js")).href);
const workspace = path.join(repo, "dist/.plugin-check-workspace");
await rm(workspace, { recursive: true, force: true });
const registered = [];
const ctx = {
  logger: { warn() {} },
  tools: {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  },
  effect(fn) {
    const dispose = fn();
    return () => dispose?.();
  },
  get() {
    return undefined;
  },
};
plugin.apply(ctx, { workspaceDir: workspace });
check(
  registered.length >= 12,
  `expected at least 12 tools, got ${registered.length}`,
);
const names = registered.map((tool) => tool.name);
for (const name of [
  "document_create",
  "document_open",
  "document_get_text",
  "document_export_pdf",
  "document_ai_review",
]) {
  check(names.includes(name), `missing tool ${name}`);
}
for (const tool of registered) {
  check(
    tool.parameters?.type === "object",
    `${tool.name} parameters must be an object schema`,
  );
  check(
    typeof tool.description === "string" && tool.description.length > 20,
    `${tool.name} needs a description`,
  );
  check(
    typeof tool.output?.render === "function",
    `${tool.name} needs output.render`,
  );
}

const byName = new Map(registered.map((tool) => [tool.name, tool]));
const created = await byName
  .get("document_create")
  .execute({ title: "Plugin check", paragraphs: ["Hello engine."] });
const text = await byName
  .get("document_get_text")
  .execute({ documentId: created.documentId });
check(text.text.includes("Hello engine."), "document text was lost");
const pdf = await byName
  .get("document_export_pdf")
  .execute({ documentId: created.documentId });
check(
  Buffer.from(pdf.dataBase64, "base64").subarray(0, 5).toString() === "%PDF-",
  "PDF export failed",
);
await rm(workspace, { recursive: true, force: true });

const files = (await readdir(dir)).filter((name) => name !== "node_modules");
if (problems.length > 0) {
  console.error(`check-dsh-plugin: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("check-dsh-plugin: OK");
console.log(`  package      : ${pkg.name}@${pkg.version}`);
console.log(`  files        : ${files.length} entries`);
console.log(`  tools        : ${registered.length}`);
console.log(
  `  engine bytes : ${(await stat(path.join(dir, "engine.js"))).size}`,
);
