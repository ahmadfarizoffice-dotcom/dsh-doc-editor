#!/usr/bin/env node
/**
 * LibreOffice adapter smoke test.
 *
 * Runs the real detection and conversion code against the machine it is on.
 * LibreOffice is optional: when it is absent the script reports
 * `available:false` with the detection evidence and the install command, and
 * exits successfully because "not installed" is a supported state.
 *
 * Usage:
 *   node tools/libreoffice-smoke.mjs
 *
 * Requires `packages/core/dist/engine/libreoffice.js`; build it with
 *   node_modules/.bin/tsc.CMD -b packages/core
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const enginePath = path.join(repo, "packages/core/dist/engine/libreoffice.js");

if (!existsSync(enginePath)) {
  console.error(
    `libreoffice-smoke: ${path.relative(repo, enginePath)} is missing.`,
  );
  console.error(
    "  Build the core package first: node_modules/.bin/tsc.CMD -b packages/core",
  );
  process.exit(1);
}

const engine = await import(
  `${pathToFileURL(enginePath).href}?v=${Date.now()}`
);
engine.clearLibreOfficeCache();
const detection = await engine.detectLibreOffice({ refresh: true });

const summary = {
  available: detection.available,
  path: detection.path,
  version: detection.version ?? null,
  source: detection.source,
  reason: detection.reason ?? null,
  candidates: detection.candidates.length,
  existingCandidates: detection.candidates.filter((entry) => entry.exists)
    .length,
  attempts: detection.attempts.map((attempt) => ({
    path: attempt.path,
    reason: attempt.reason,
  })),
  cached: detection.cached === true,
};

console.log("LibreOffice adapter smoke test");
console.log(JSON.stringify(summary, null, 2));

if (!detection.available) {
  console.log("");
  console.log("available:false");
  console.log(
    `Reason: ${detection.reason ?? "not-found"} — no usable LibreOffice executable answered '--version'.`,
  );
  if (detection.attempts.length > 0) {
    for (const attempt of detection.attempts) {
      console.log(`  attempted: ${attempt.path} (${attempt.reason})`);
    }
  }
  console.log(
    "The internal PDF renderer and every format adapter still work; only the optional external engine is unavailable.",
  );
  console.log("To install LibreOffice (optional):");
  console.log(`  ${engine.LIBREOFFICE_INSTALL_HINT}`);
  console.log(
    "  or download it from https://www.libreoffice.org/download/download-libreoffice/",
  );
  console.log(
    "After installing, re-run this script; no project configuration changes are needed.",
  );
  process.exit(0);
}

console.log("");
console.log("available:true");
const fixture = path.join(
  repo,
  "fixtures",
  "docx_docs_renderer_feature_test_cases.docx",
);
if (!existsSync(fixture)) {
  console.log(`Fixture not found (${fixture}); detection only.`);
  process.exit(0);
}

const workspace = await mkdtemp(path.join(tmpdir(), "dsh-lo-smoke-"));
try {
  const core = await import(
    `${pathToFileURL(path.join(repo, "packages/core/dist/service/service.js")).href}?v=${Date.now()}`
  );
  const service = new core.DocumentService({
    workspaceRoot: workspace,
    allowedReadRoots: [workspace, path.dirname(fixture)],
    auditPath: path.join(workspace, "audit.log"),
  });
  await service.init();
  const opened = await service.openDocument(fixture);
  const internal = await service.exportPdf(opened.documentId);
  const internalPdf = Buffer.from(internal.dataBase64, "base64");
  const libre = await engine.renderPdfWithLibreOffice(fixture);
  const comparison = await engine.comparePdfEngines({
    docxPath: fixture,
    internalPdf,
    libreOfficeResult: libre,
  });
  console.log(
    JSON.stringify(
      {
        libreOffice: {
          bytes: libre.bytes,
          sha256: libre.sha256,
          pageCount: engine.countPdfPages(libre.buffer) ?? null,
        },
        internal: {
          bytes: internalPdf.byteLength,
          pageCount: internal.pageCount,
        },
        bothPresent: comparison.bothPresent,
        byteIdentical: comparison.byteIdentical,
        pixelComparison: comparison.pixelComparison,
        notes: comparison.notes,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
