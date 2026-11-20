#!/usr/bin/env node
/**
 * Engine matrix: internal adapter vs LibreOffice for every export target.
 *
 * For each target format (docx, odt, rtf, html, txt, pdf) this script reports
 *   - the byte size produced by the internal adapter and by the routed engine
 *     (LibreOffice when available, with the typed fallback reason when not),
 *   - the PDF page count where applicable (parsed from `/Type /Page`),
 *   - the text-equality verdict of each output against the model text,
 *   - the engine actually chosen and its fallback reason.
 *
 * The routed engine is exactly what `DocumentService.exportDocument()` /
 * `exportPdf()` use by default, so this is the same code path the editor, MCP
 * server and plugin use.
 *
 * Usage:
 *   node tools/engine-matrix.mjs [file.docx] [--json]
 *
 * Requires the built core package:
 *   node_modules/.bin/tsc.CMD -b packages/core
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

const servicePath = path.join(repo, "packages/core/dist/service/service.js");
const enginePath = path.join(repo, "packages/core/dist/engine/libreoffice.js");
const formatsPath = path.join(repo, "packages/core/dist/formats/index.js");
const textPath = path.join(repo, "packages/core/dist/model/text.js");
const docxPath = path.join(repo, "packages/core/dist/docx/export.js");

for (const required of [servicePath, enginePath, formatsPath, textPath]) {
  if (!existsSync(required)) {
    console.error(
      `engine-matrix: ${path.relative(repo, required)} is missing.`,
    );
    console.error(
      "  Build the core package first: node_modules/.bin/tsc.CMD -b packages/core",
    );
    process.exit(1);
  }
}

const cache = `?v=${Date.now()}`;
const { DocumentService } = await import(
  `${pathToFileURL(servicePath).href}${cache}`
);
const engineModule = await import(`${pathToFileURL(enginePath).href}${cache}`);
const formats = await import(`${pathToFileURL(formatsPath).href}${cache}`);
const textModule = await import(`${pathToFileURL(textPath).href}${cache}`);
const { exportDocx } = await import(`${pathToFileURL(docxPath).href}${cache}`);

const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const explicit = args.find((entry) => !entry.startsWith("--"));
const fixture = path.resolve(
  explicit ??
    path.join(repo, "fixtures/docx_docs_renderer_feature_test_cases.docx"),
);
if (!existsSync(fixture)) {
  console.error(`engine-matrix: fixture not found: ${fixture}`);
  process.exit(1);
}

const TARGETS = ["docx", "odt", "rtf", "html", "txt", "pdf"];
const normalize = (value) =>
  value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const workspace = await mkdtemp(path.join(tmpdir(), "dsh-engine-matrix-"));
const internalWorkspace = await mkdtemp(
  path.join(tmpdir(), "dsh-engine-matrix-internal-"),
);
const service = new DocumentService({
  workspaceRoot: workspace,
  allowedReadRoots: [workspace, path.dirname(fixture)],
  auditPath: path.join(workspace, "audit.log"),
});
const internalService = new DocumentService({
  workspaceRoot: internalWorkspace,
  allowedReadRoots: [internalWorkspace, path.dirname(fixture)],
  auditPath: path.join(internalWorkspace, "audit.log"),
  engine: "internal",
});
await service.init();
await internalService.init();

const detection = await engineModule.detectLibreOffice({ refresh: true });
const preference = service.enginePreference();
const inUse = await service.engineInUse();

const importedText = async (buffer, format) => {
  try {
    const imported = await formats.importAny(buffer, `matrix.${format}`);
    return normalize(textModule.documentText(imported.document));
  } catch (error) {
    return `<<unreadable: ${error.message}>>`;
  }
};

const rows = [];
const conversionDirectory = await mkdtemp(
  path.join(tmpdir(), "dsh-engine-matrix-convert-"),
);
try {
  const opened = await service.openDocument(fixture);
  const internalOpened = await internalService.openDocument(fixture);
  const modelText = normalize(service.getText(opened.documentId).text);

  // The direct LibreOffice attempt: export the model to DOCX once, then ask
  // LibreOffice for every target. This measures LibreOffice itself, including
  // the cases where the router rejects its output.
  const docx = await exportDocx(service.session(opened.documentId).document, {
    preserveTimestamps: true,
  });
  const docxPath = path.join(conversionDirectory, "matrix-input.docx");
  await writeFile(docxPath, docx.buffer);

  for (const format of TARGETS) {
    const internalStarted = Date.now();
    const internal =
      format === "pdf"
        ? await internalService.exportPdf(internalOpened.documentId)
        : await internalService.exportDocument(
            internalOpened.documentId,
            format,
          );
    const internalDurationMs = Date.now() - internalStarted;
    const internalBytes =
      internal.dataBase64 !== undefined
        ? Buffer.from(internal.dataBase64, "base64")
        : await readFile(internal.path);

    // Direct LibreOffice conversion (independent of routing).
    let libreOffice;
    if (detection.available) {
      const loStarted = Date.now();
      try {
        const attempt = await engineModule.convertWithLibreOffice({
          inputPath: docxPath,
          format,
          detection,
          tempDirectory: conversionDirectory,
        });
        const bytes = Buffer.from(attempt.dataBase64 ?? "", "base64");
        const pageCount =
          format === "pdf" ? engineModule.countPdfPages(bytes) : null;
        const outputText =
          format === "pdf" ? null : await importedText(bytes, format);
        libreOffice = {
          bytes: bytes.byteLength,
          pageCount,
          textEqual: outputText === null ? null : outputText === modelText,
          outputText,
          durationMs: Date.now() - loStarted,
          error: null,
        };
      } catch (error) {
        libreOffice = {
          bytes: null,
          pageCount: null,
          textEqual: null,
          outputText: null,
          durationMs: Date.now() - loStarted,
          error: error.code ?? error.message,
        };
      }
    } else {
      libreOffice = {
        bytes: null,
        pageCount: null,
        textEqual: null,
        outputText: null,
        durationMs: null,
        error: "engine-unavailable",
      };
    }

    const routedStarted = Date.now();
    const routed =
      format === "pdf"
        ? await service.exportPdf(opened.documentId)
        : await service.exportDocument(opened.documentId, format);
    const routedDurationMs = Date.now() - routedStarted;
    const routedBytes =
      routed.dataBase64 !== undefined
        ? Buffer.from(routed.dataBase64, "base64")
        : await readFile(routed.path);

    const internalText =
      format === "pdf" ? null : await importedText(internalBytes, format);
    const internalPageCount =
      format === "pdf"
        ? (engineModule.countPdfPages(internalBytes) ?? internal.pageCount)
        : null;

    rows.push({
      format,
      internal: {
        engine: "internal",
        bytes: internalBytes.byteLength,
        pageCount: internalPageCount,
        textEqual: internalText === null ? null : internalText === modelText,
        durationMs: internalDurationMs,
      },
      libreoffice: libreOffice,
      routed: {
        engine: routed.engine,
        fallbackReason: routed.fallbackReason ?? null,
        reason: routed.reason,
        bytes: routedBytes.byteLength,
        pageCount:
          format === "pdf" ? engineModule.countPdfPages(routedBytes) : null,
        textEqual:
          format === "pdf"
            ? null
            : (await importedText(routedBytes, format)) === modelText,
        durationMs: routedDurationMs,
      },
      byteDelta:
        libreOffice.bytes === null
          ? null
          : libreOffice.bytes - internalBytes.byteLength,
    });
  }
} finally {
  await rm(conversionDirectory, { recursive: true, force: true }).catch(
    () => undefined,
  );
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  await rm(internalWorkspace, { recursive: true, force: true }).catch(
    () => undefined,
  );
}

const summary = {
  fixture: path.relative(repo, fixture).split(path.sep).join("/"),
  engine: {
    preference,
    inUse: inUse.engine,
    reason: inUse.reason,
    fallbackReason: inUse.fallbackReason,
    available: detection.available,
    path: detection.path,
    version: detection.version ?? null,
    detectionReason: detection.reason ?? null,
  },
  generatedAt: new Date().toISOString(),
  rows,
};

if (jsonOnly) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("Engine matrix — internal adapter vs LibreOffice");
  console.log(`fixture: ${summary.fixture}`);
  console.log(
    `preference: ${preference}  engine in use: ${inUse.engine}  ` +
      `libreoffice: ${detection.available ? `available (${detection.version})` : `unavailable (${detection.reason})`}`,
  );
  console.log("");
  const pad = (value, width) => String(value).padEnd(width);
  const padStart = (value, width) => String(value).padStart(width);
  console.log(
    [
      pad("target", 7),
      padStart("internal B", 11),
      padStart("LO B", 10),
      pad("engine", 12),
      pad("fallback", 18),
      padStart("pages i/LO", 11),
      pad("text i/LO", 12),
      padStart("ms i/LO", 12),
    ].join(" "),
  );
  console.log("-".repeat(108));
  for (const row of rows) {
    const loBytes =
      row.libreoffice.bytes === null
        ? `err:${row.libreoffice.error ?? "?"}`
        : String(row.libreoffice.bytes);
    const pages =
      row.format === "pdf"
        ? `${row.internal.pageCount ?? "?"}/${row.libreoffice.pageCount ?? "?"}`
        : "-";
    const textVerdict =
      row.format === "pdf"
        ? "n/a"
        : `${row.internal.textEqual ? "equal" : "differs"}/${row.libreoffice.textEqual === null ? "n/a" : row.libreoffice.textEqual ? "equal" : "differs"}`;
    console.log(
      [
        pad(row.format, 7),
        padStart(row.internal.bytes, 11),
        padStart(loBytes, 10),
        pad(row.routed.engine, 12),
        pad(row.routed.fallbackReason ?? "-", 18),
        padStart(pages, 11),
        pad(textVerdict, 12),
        padStart(
          `${row.internal.durationMs}/${row.libreoffice.durationMs ?? "-"}`,
          12,
        ),
      ].join(" "),
    );
  }
  console.log("");
  console.log(
    "legend: internal B / LO B = bytes from the internal adapter / a direct LibreOffice conversion",
  );
  console.log(
    "        engine + fallback = what the service actually chose; text i/LO = model text preserved",
  );
  console.log("");
  console.log(JSON.stringify(summary, null, 2));
}
