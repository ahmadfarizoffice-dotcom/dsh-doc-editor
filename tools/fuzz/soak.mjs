#!/usr/bin/env node
/**
 * Soak test: 150 random open -> edit -> save -> reopen cycles against a temp
 * workspace. Reports peak heap, per-iteration duration and any leaked session.
 *
 *   node tools/fuzz/soak.mjs --seed 1337 --iterations 150
 *
 * Requires a built engine (`node_modules/.bin/tsc -p packages/core/tsconfig.json`)
 * because it runs the compiled `packages/core/dist/dsh-entry.js` outside vitest.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const entry = path.join(repoRoot, "packages", "core", "dist", "dsh-entry.js");
if (!existsSync(entry)) {
  console.error(
    `Missing ${entry}. Build the engine first: node_modules/.bin/tsc -p packages/core/tsconfig.json`,
  );
  process.exit(2);
}

const { DocumentService } = await import(pathToFileURL(entry).href);

function parseArgs(argv) {
  const options = { seed: 1337, iterations: 150 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--seed" || argument === "-s") {
      options.seed = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (argument.startsWith("--seed=")) {
      options.seed = Number.parseInt(argument.slice("--seed=".length), 10);
    } else if (argument === "--iterations" || argument === "-n") {
      options.iterations = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (argument.startsWith("--iterations=")) {
      options.iterations = Number.parseInt(
        argument.slice("--iterations=".length),
        10,
      );
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node tools/fuzz/soak.mjs [--seed 1337] [--iterations 150]",
      );
      process.exit(0);
    }
  }
  if (!Number.isFinite(options.seed)) options.seed = 1337;
  if (!Number.isFinite(options.iterations) || options.iterations <= 0)
    options.iterations = 150;
  return options;
}

/** Deterministic mulberry32 (kept local so the script has no build dependency). */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const options = parseArgs(process.argv.slice(2));
const random = mulberry32(options.seed);
const nextInt = (min, max) => min + Math.floor(random() * (max - min + 1));
const words = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "עברית",
  "😀",
  "日本語",
  "epsilon",
];
const randomText = (length) => {
  let text = "";
  while (text.length < length)
    text += `${words[nextInt(0, words.length - 1)]} `;
  return text.slice(0, length);
};

const root = await mkdtemp(path.join(os.tmpdir(), "dsh-fuzz-soak-"));
const service = new DocumentService({
  workspaceRoot: root,
  allowedReadRoots: [root],
});
await service.init();

const failures = [];
let peakHeapBytes = 0;
let peakSessionLeak = 0;
let totalSavedBytes = 0;
const started = Date.now();

for (let iteration = 0; iteration < options.iterations; iteration += 1) {
  const paragraphCount = nextInt(1, 4);
  const created = await service.createDocument({
    title: `soak-${iteration}`,
    paragraphs: Array.from({ length: paragraphCount }, () =>
      randomText(nextInt(0, 120)),
    ),
  });
  const documentId = created.documentId;
  const operationCount = nextInt(3, 10);
  for (let step = 0; step < operationCount; step += 1) {
    const document = service.session(documentId).document;
    const paragraphs = [];
    const walk = (blocks) => {
      for (const block of blocks) {
        if (block.type === "paragraph") paragraphs.push(block);
        if (block.type === "table") {
          for (const row of block.rows)
            for (const cell of row.cells) walk(cell.blocks);
        }
      }
    };
    for (const section of document.sections) walk(section.blocks);
    if (paragraphs.length === 0) break;
    const target = paragraphs[nextInt(0, paragraphs.length - 1)];
    const text = target.inlines
      .map((inline) => (inline.type === "text" ? inline.text : ""))
      .join("");
    const roll = random();
    try {
      if (roll < 0.55) {
        service.insertText(documentId, {
          position: { blockId: target.id, offset: nextInt(0, text.length) },
          text: randomText(nextInt(1, 40)),
          props:
            random() < 0.4 ? { bold: true, italic: random() < 0.5 } : undefined,
        });
      } else if (roll < 0.7) {
        service.insertHeading(documentId, {
          text: randomText(nextInt(1, 20)),
          level: nextInt(1, 3),
          afterBlockId: target.id,
        });
      } else if (roll < 0.82) {
        service.insertList(documentId, {
          items: [randomText(8), randomText(8)],
          kind: random() < 0.5 ? "bullet" : "number",
          afterBlockId: target.id,
        });
      } else if (roll < 0.92) {
        service.insertTable(documentId, {
          rows: nextInt(1, 3),
          columns: nextInt(1, 3),
          afterBlockId: target.id,
        });
      } else {
        service.formatText(documentId, {
          range: {
            start: { blockId: target.id, offset: 0 },
            end: { blockId: target.id, offset: Math.min(text.length, 12) },
          },
          props: { italic: true, color: "#112233" },
        });
      }
    } catch (error) {
      failures.push(`iteration ${iteration} step ${step}: ${String(error)}`);
    }
  }

  const beforeSave = service.session(documentId).document;
  const saved = await service.saveDocument(documentId);
  totalSavedBytes += saved.bytes;
  await service.closeDocument(documentId, { discardUnsaved: true });
  const sessionsAfterClose = service.sessions_().length;
  peakSessionLeak = Math.max(peakSessionLeak, sessionsAfterClose);
  if (sessionsAfterClose !== 0) {
    failures.push(
      `iteration ${iteration}: ${sessionsAfterClose} session(s) left open after closeDocument`,
    );
  }

  const reopened = await service.reopenDocument(documentId);
  const reopenedText = reopened.document.sections
    .flatMap((section) => section.blocks)
    .filter((block) => block.type === "paragraph")
    .map((block) =>
      block.inlines
        .map((inline) => (inline.type === "text" ? inline.text : ""))
        .join(""),
    )
    .join("\n");
  const originalText = beforeSave.sections
    .flatMap((section) => section.blocks)
    .filter((block) => block.type === "paragraph")
    .map((block) =>
      block.inlines
        .map((inline) => (inline.type === "text" ? inline.text : ""))
        .join(""),
    )
    .join("\n");
  if (reopenedText !== originalText) {
    failures.push(
      `iteration ${iteration}: reopenDocument changed text ` +
        `(${originalText.length}->${reopenedText.length} chars)`,
    );
  }
  await service.closeDocument(documentId, { discardUnsaved: true });
  peakSessionLeak = Math.max(peakSessionLeak, service.sessions_().length);
  if (service.sessions_().length !== 0) {
    failures.push(
      `iteration ${iteration}: session leak after reopenDocument cycle`,
    );
  }

  // Bound disk usage: keep at most the last few documents.
  if (iteration % 5 === 0) {
    await service.deleteDocument(documentId).catch(() => undefined);
  }

  const heap = process.memoryUsage().heapUsed;
  peakHeapBytes = Math.max(peakHeapBytes, heap);
  if ((iteration + 1) % 25 === 0 || iteration === options.iterations - 1) {
    console.log(
      `soak iteration ${iteration + 1}/${options.iterations} ` +
        `heap=${(heap / 1024 / 1024).toFixed(1)}MiB peak=${(peakHeapBytes / 1024 / 1024).toFixed(1)}MiB ` +
        `sessions=${service.sessions_().length}`,
    );
  }
}

const documents = await service.listDocuments();
const report = {
  seed: options.seed,
  iterations: options.iterations,
  failures: failures.length,
  failureSamples: failures.slice(0, 5),
  peakHeapMB: Math.round((peakHeapBytes / 1024 / 1024) * 10) / 10,
  peakSessionLeak,
  documentsLeft: documents.length,
  averageSavedBytes: Math.round(totalSavedBytes / options.iterations),
  durationMs: Date.now() - started,
};
console.log(`SOAK_SUMMARY ${JSON.stringify(report)}`);
await rm(root, { recursive: true, force: true });
process.exit(failures.length > 0 || peakSessionLeak > 0 ? 1 : 0);
