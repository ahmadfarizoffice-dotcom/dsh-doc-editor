#!/usr/bin/env node
/**
 * Builds the self-contained DeepSeek Harness bundle.
 *
 * Output (default `dist/dsh-plugin/`):
 *   engine.js          the whole document engine, dependencies inlined
 *   index.js           Host half (tools + local HTTP API for the page)
 *   client.js          Client half (Documents panel in the main column)
 *   cordis.patch.yml   bundle patch inserting the Host row
 *   package.json       bundle manifest with display metadata exports
 *   locale/*.json      display titles/descriptions
 *   icon.svg           panel/plugin icon
 *   docs/DETAIL.md     single-image detail document
 *   docs/preview.svg   the feature image
 *
 * The output directory is what gets published as the plugin repository; it has
 * no build step and no dependencies, so installing from a GitHub link works.
 */
import { createRequire } from "node:module";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const core = path.join(repo, "packages/core");
const template = path.join(repo, "dsh-plugin");
const outDir = path.join(repo, "dist/dsh-plugin");

function resolveEsbuild() {
  const candidates = [
    createRequire(path.join(repo, "package.json")),
    createRequire(path.join(repo, "apps/web/package.json")),
  ];
  for (const require of candidates) {
    try {
      return require("esbuild");
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}

async function findEsbuildInStore() {
  const store = path.join(repo, "node_modules/.pnpm");
  const entries = await readdir(store).catch(() => []);
  const dir = entries.find((name) => name.startsWith("esbuild@"));
  if (!dir) return undefined;
  const mod = await import(
    pathToFileURL(path.join(store, dir, "node_modules/esbuild/lib/main.js"))
      .href
  );
  return mod.default ?? mod;
}

async function loadEsbuild() {
  return resolveEsbuild() ?? (await findEsbuildInStore());
}

async function copyTemplate(target) {
  await cp(template, target, { recursive: true });
}

async function findPdfkit() {
  const store = path.join(repo, "node_modules/.pnpm");
  const entries = await readdir(store).catch(() => []);
  const dir = entries.find((name) => name.startsWith("pdfkit@"));
  if (!dir) return undefined;
  return path.join(store, dir, "node_modules/pdfkit");
}

const STANDARD_FONTS = [
  "Courier",
  "CourierBold",
  "CourierBoldOblique",
  "CourierOblique",
  "Helvetica",
  "HelveticaBold",
  "HelveticaBoldOblique",
  "HelveticaOblique",
  "Symbol",
  "TimesBold",
  "TimesBoldItalic",
  "TimesItalic",
  "TimesRoman",
  "ZapfDingbats",
];

/**
 * PDFKit resolves its standard-14 font data through package-import specifiers
 * (`#standard-fonts/Helvetica`). A bundle has no package context, so those
 * runtime requires fail. The plugin rewrites the generated loader table to use
 * statically imported font data instead; the fonts are then inlined.
 */
async function pdfkitFontPlugin(pdfkitDir, fontsModule) {
  const escaped = fontsModule.replace(/\\/g, "\\\\");
  return {
    name: "pdfkit-standard-fonts",
    setup(build) {
      build.onLoad(
        { filter: /pdfkit[\\/]js[\\/]pdfkit\.node\.mjs$/ },
        async (args) => {
          let source = await readFile(args.path, "utf8");
          let replaced = 0;
          source = source.replace(
            /require\$1\(\s*(['"])#standard-fonts\/([A-Za-z]+)\1\s*\)/g,
            (_match, _quote, name) => {
              replaced += 1;
              return `__dshStandardFonts.${name}`;
            },
          );
          if (replaced === 0) {
            throw new Error(
              `pdfkit standard font loaders were not found in ${args.path}`,
            );
          }
          source = `import __dshStandardFonts from ${JSON.stringify(escaped)};\n${source}`;
          return {
            contents: source,
            loader: "js",
            resolveDir: path.dirname(args.path),
          };
        },
      );
    },
  };
}

async function writeFontsModule(pdfkitDir, target) {
  const lines = [];
  const entries = [];
  for (const name of STANDARD_FONTS) {
    const file = path.join(pdfkitDir, "js/standard-fonts", `${name}.cjs`);
    lines.push(`import ${name} from ${JSON.stringify(file)};`);
    entries.push(`  ${name}: ${name},`);
  }
  lines.push("export default {");
  lines.push(...entries);
  lines.push("};");
  await writeFile(target, lines.join("\n"), "utf8");
}

async function main() {
  const esbuild = await loadEsbuild();
  if (!esbuild) {
    throw new Error("esbuild was not found; run pnpm install first");
  }
  const pdfkitDir = await findPdfkit();
  if (!pdfkitDir) {
    throw new Error("pdfkit was not found in node_modules/.pnpm");
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await copyTemplate(outDir);

  const fontsModule = path.join(outDir, ".fonts.js");
  await writeFontsModule(pdfkitDir, fontsModule);
  const entry = path.join(core, "dist/dsh-entry.js");
  const entryExists = await stat(entry)
    .then(() => true)
    .catch(() => false);
  if (!entryExists) {
    throw new Error(
      "packages/core/dist/dsh-entry.js is missing; run `pnpm run build:core` first",
    );
  }

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: path.join(outDir, "engine.js"),
    legalComments: "none",
    logLevel: "info",
    metafile: true,
    plugins: [await pdfkitFontPlugin(pdfkitDir, fontsModule)],
    define: { "process.env.NODE_ENV": '"production"' },
    banner: {
      js: [
        'import { createRequire as __dshCreateRequire } from "node:module";',
        'import { fileURLToPath as __dshFileURLToPath } from "node:url";',
        'import { dirname as __dshDirname } from "node:path";',
        "const require = __dshCreateRequire(import.meta.url);",
        "const __filename = __dshFileURLToPath(import.meta.url);",
        "const __dirname = __dshDirname(__filename);",
      ].join("\n"),
    },
  });

  const size = (await stat(path.join(outDir, "engine.js"))).size;
  const inputs = Object.keys(result.metafile.inputs).length;
  await rm(fontsModule, { force: true });

  // Smoke-test the bundle exactly as the plugin will import it.
  const engine = await import(
    `${pathToFileURL(path.join(outDir, "engine.js")).href}?v=${Date.now()}`
  );
  if (typeof engine.DocumentService !== "function") {
    throw new Error("engine bundle does not export DocumentService");
  }
  const workspace = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(path.join(process.env.TEMP ?? "/tmp", "dsh-doc-bundle-")),
  );
  const service = new engine.DocumentService({
    workspaceRoot: workspace,
    allowedReadRoots: [workspace],
    auditPath: path.join(workspace, "audit.log"),
  });
  await service.init();
  const created = await service.createDocument({
    title: "Bundle smoke test",
    paragraphs: ["Hello from the bundled engine."],
  });
  const formats = await service.listFormats();
  const text = service.getText(created.documentId);
  const pdf = await service.exportPdf(created.documentId);
  const tools = engine.listTools();
  await fs0rm(workspace);
  if (!text.text.includes("Hello from the bundled engine.")) {
    throw new Error("bundled engine lost document text");
  }
  const docx = (formats.formats ?? []).find((format) => format.id === "docx");
  if (!docx || docx.canExport !== true) {
    throw new Error("bundled engine lost the DOCX adapter");
  }
  if (
    !pdf.dataBase64 ||
    Buffer.from(pdf.dataBase64, "base64").subarray(0, 5).toString() !== "%PDF-"
  ) {
    throw new Error("bundled engine PDF export failed");
  }
  const manifest = engine.buildToolManifest();
  console.log(
    `engine.js: ${(size / 1024 / 1024).toFixed(2)} MiB, ${inputs} bundled inputs, ${tools.length} tools, ${manifest.tools.length} manifest entries`,
  );
  console.log(
    `smoke: create/getText/listFormats/exportPdf OK (${pdf.pageCount} pages)`,
  );
}

async function fs0rm(target) {
  const fs = await import("node:fs/promises");
  await fs.rm(target, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
