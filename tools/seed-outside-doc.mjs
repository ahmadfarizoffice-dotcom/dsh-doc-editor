/**
 * Seeds a DOCX outside every DSH workspace with one paragraph that contains a
 * hard line break followed by text, plus a table, for live verification of
 * "open from any local directory" and multiline paragraph rendering.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { writeFile, mkdir, rm } from "node:fs/promises";

const repo = process.cwd();
const { DocumentService } = await import(
  pathToFileURL(path.join(repo, "packages/core/dist/dsh-entry.js")).href
);

const outDir = "C:\\dsh-anywhere-test";
await mkdir(outDir, { recursive: true });
await rm(path.join(outDir, ".seed-workspace"), {
  recursive: true,
  force: true,
});

const service = new DocumentService({
  workspaceRoot: path.join(outDir, ".seed-workspace"),
  allowedReadRoots: [outDir],
  auditPath: path.join(outDir, ".seed-audit.log"),
});
await service.init();

const created = await service.createDocument({
  title: "Outside report",
  paragraphs: [
    "This file lives outside every DSH workspace folder.",
    "First line of a broken paragraph Last line after the hard break.",
  ],
});
const id = created.documentId;

const block = service.session(id).document.sections[0].blocks[1];
const text = block.inlines.map((run) => run.text ?? "").join("");
const cut = "First line of a broken paragraph ".length;
service.insertPageBreak(id, {
  position: { blockId: block.id, offset: cut },
  kind: "line",
});

service.insertTable(id, {
  rows: 2,
  columns: 2,
  headerRow: true,
  data: [
    ["Region", "Revenue"],
    ["North", "1.2M"],
  ],
});

const docx = await service.exportDocument(id, "docx");
await writeFile(
  path.join(outDir, "Outside report.docx"),
  Buffer.from(docx.dataBase64, "base64"),
);
await writeFile(
  path.join(outDir, "README.txt"),
  "This folder is outside the DSH workspace on purpose.\n",
  "utf8",
);
console.log(
  "wrote",
  path.join(outDir, "Outside report.docx"),
  docx.bytes,
  "bytes; paragraph cut at",
  cut,
  "of",
  text.length,
);
