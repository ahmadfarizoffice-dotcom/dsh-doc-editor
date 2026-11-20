/**
 * Anomaly and fault-injection suite.
 *
 * Every case is hostile: truncated/corrupt packages, entity expansion, deep
 * nesting, huge payloads, untyped ranges, path escapes, read-only routes,
 * concurrent/racing saves and table operations on wrong ids. The contract under
 * test is: a typed ServiceError/FormatError, no crash, no hang (10 s per case),
 * and a workspace that never keeps a truncated/partial file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import {
  DocumentService,
  createDocument,
  documentStats,
  documentText,
  exportAny,
  importAny,
} from "../../src/dsh-entry.js";
import type { DocDocument } from "../../src/model/types.js";
import {
  FuzzReporter,
  Rng,
  caseSeed,
  createTempWorkspace,
  describeError,
  errorCode,
  isTypedError,
  modelHash,
  readFuzzConfig,
  withTimeout,
  type TempWorkspace,
} from "./support.js";

const config = readFuzzConfig({ seed: 1337, cases: 150 });
const CASE_TIMEOUT_MS = 10_000;

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

function documentXml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`;
}

function paragraphXml(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

async function buildZip(
  parts: Array<{ name: string; data: string | Buffer }>,
): Promise<Buffer> {
  const zip = new JSZip();
  for (const part of parts) zip.file(part.name, part.data);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function buildDocx(
  inner: string,
  extra: Array<{ name: string; data: string | Buffer }> = [],
): Promise<Buffer> {
  return buildZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES_XML },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "word/document.xml", data: documentXml(inner) },
    ...extra,
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ForgedEntry {
  name: string;
  data: Buffer;
  declaredSize?: number;
}

/** A store-method ZIP written by hand so names/sizes are not sanitised. */
function forgedZipEntries(entries: ForgedEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const declared = entry.declaredSize ?? entry.data.length;
    const local = Buffer.alloc(30 + nameBuffer.length + entry.data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(declared >>> 0, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    nameBuffer.copy(local, 30);
    entry.data.copy(local, 30 + nameBuffer.length);

    const central = Buffer.alloc(46 + nameBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(declared >>> 0, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuffer.copy(central, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

interface AnomalyContext {
  workspace: TempWorkspace;
  service: DocumentService;
  readOnly: DocumentService;
  baseDocx: Buffer;
  outsideDir: string;
  seed: number;
}

interface AnomalyCase {
  name: string;
  run: (context: AnomalyContext) => Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectTypedFailure(
  label: string,
  work: () => Promise<unknown>,
  allowedCodes?: string[],
): Promise<void> {
  let succeeded = false;
  try {
    await work();
    succeeded = true;
  } catch (error) {
    if (!isTypedError(error)) {
      throw new Error(
        `${label}: untyped failure ${describeError(error)} (expected ServiceError/FormatError with a code)`,
      );
    }
    const code = errorCode(error);
    if (allowedCodes && !allowedCodes.includes(code)) {
      throw new Error(
        `${label}: unexpected code ${code} (${describeError(error)})`,
      );
    }
    return;
  }
  if (succeeded)
    throw new Error(
      `${label}: expected a typed failure but the call succeeded`,
    );
}

async function expectSuccess(
  label: string,
  work: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await work();
  } catch (error) {
    throw new Error(
      `${label}: expected success but threw ${describeError(error)}`,
    );
  }
}

/** Every persisted document must be complete; no truncated/partial files. */
async function assertWorkspaceIntegrity(root: string): Promise<void> {
  const documentsDir = path.join(root, "documents");
  let entries: string[] = [];
  try {
    entries = await readdir(documentsDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const directory = path.join(documentsDir, entry);
    let files: string[] = [];
    try {
      files = await readdir(directory);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith(".tmp") || file.endsWith(".partial")) {
        throw new Error(
          `workspace left a temp file: documents/${entry}/${file}`,
        );
      }
      const full = path.join(directory, file);
      const bytes = await readFile(full).catch(() => undefined);
      if (!bytes) continue;
      if (bytes.length === 0) {
        throw new Error(
          `workspace left a zero-byte file: documents/${entry}/${file}`,
        );
      }
      if (file === "document.json" || file === "record.json") {
        try {
          JSON.parse(bytes.toString("utf8"));
        } catch (error) {
          throw new Error(
            `workspace left a truncated JSON file documents/${entry}/${file}: ${describeError(error)}`,
          );
        }
      }
      if (
        file === "document.docx" &&
        !(bytes[0] === 0x50 && bytes[1] === 0x4b)
      ) {
        throw new Error(
          `workspace left a truncated DOCX: documents/${entry}/${file}`,
        );
      }
    }
  }
}

async function makeBaseDocx(service: DocumentService): Promise<Buffer> {
  const created = await service.createDocument({
    title: "anomaly-base",
    paragraphs: ["base document", "second paragraph"],
  });
  await service.saveDocument(created.documentId);
  const bytes = await service.workspace.loadDocx(created.documentId);
  assert(bytes, "base DOCX was not persisted");
  await service.closeDocument(created.documentId, { discardUnsaved: true });
  return bytes;
}

/** Cell ids of one table, used to prove split/merge never duplicates ids. */
function collectCellIds(doc: DocDocument, tableId: string): string[] {
  for (const block of doc.sections.flatMap((section) => section.blocks)) {
    if (block.type !== "table" || block.id !== tableId) continue;
    return block.rows.flatMap((row) => row.cells.map((cell) => cell.id));
  }
  return [];
}

/** Builds exactly `count` cases, cycling the template list with index variation. */
function buildCases(count: number, seed: number): AnomalyCase[] {
  const rng = new Rng(seed);
  const templateCounts: Array<[string, number]> = [
    ["truncated-docx", 12],
    ["zero-byte-docx", 4],
    ["garbage-pk", 4],
    ["missing-content-types", 4],
    ["wrong-content-types", 4],
    ["zip-traversal-entry", 4],
    ["zip-bomb-shape", 4],
    ["xml-entity-expansion", 4],
    ["xml-deep-nesting", 6],
    ["lone-surrogate", 6],
    ["nul-bytes", 5],
    ["huge-paragraph", 5],
    ["many-paragraphs", 2],
    ["path-traversal-open", 5],
    ["symlink-escape", 3],
    ["readonly-route", 12],
    ["concurrent-saves", 6],
    ["partial-save", 2],
    ["save-during-op", 8],
    ["double-close", 5],
    ["delete-while-open", 5],
    ["invalid-range", 16],
    ["overlapping-ranges", 4],
    ["table-non-table", 6],
    ["table-bad-region", 6],
    ["merge-non-adjacent", 8],
  ];
  const total = templateCounts.reduce((sum, [, amount]) => sum + amount, 0);
  void total;
  const cases: AnomalyCase[] = [];
  let serial = 0;
  for (const [kind, amount] of templateCounts) {
    for (let index = 0; index < amount && cases.length < count; index += 1) {
      const variant = serial;
      serial += 1;
      cases.push(makeCase(kind, variant, rng));
    }
    if (cases.length >= count) break;
  }
  // If more cases are requested than the default plan, extend by cycling.
  while (cases.length < count) {
    const kind = templateCounts[serial % templateCounts.length][0];
    cases.push(makeCase(kind, serial, rng));
    serial += 1;
  }
  return cases.slice(0, count);
}

interface PositionInputLike {
  blockId: string;
  inlineIndex?: number;
  offset?: number;
}

function makeCase(kind: string, variant: number, _rng: Rng): AnomalyCase {
  switch (kind) {
    case "truncated-docx":
      return {
        name: `truncated-docx#${variant}`,
        run: async (context) => {
          const fraction = 0.05 + ((variant * 0.073) % 0.9);
          const length = Math.max(
            0,
            Math.floor(context.baseDocx.length * fraction),
          );
          await expectTypedFailure(
            `truncated at ${length}/${context.baseDocx.length} bytes`,
            () =>
              importAny(context.baseDocx.subarray(0, length), "truncated.docx"),
          );
        },
      };
    case "zero-byte-docx":
      return {
        name: `zero-byte-docx#${variant}`,
        run: async () => {
          await expectTypedFailure("zero-byte DOCX", () =>
            importAny(Buffer.alloc(0), "empty.docx"),
          );
        },
      };
    case "garbage-pk":
      return {
        name: `garbage-pk#${variant}`,
        run: async () => {
          const bytes = Buffer.concat([
            Buffer.from([0x50, 0x4b, 0x03, 0x04]),
            Buffer.from(`garbage-${variant}-`.repeat(8 + variant)),
          ]);
          await expectTypedFailure("garbage ZIP with PK magic", () =>
            importAny(bytes, "garbage.docx"),
          );
        },
      };
    case "missing-content-types":
      return {
        name: `missing-content-types#${variant}`,
        run: async () => {
          const bytes = await buildZip([
            {
              name: "word/document.xml",
              data: documentXml(paragraphXml("no content types")),
            },
          ]);
          await expectTypedFailure("DOCX without [Content_Types].xml", () =>
            importAny(bytes, "no-content-types.docx"),
          );
        },
      };
    case "wrong-content-types":
      return {
        name: `wrong-content-types#${variant}`,
        run: async () => {
          const bytes = await buildZip([
            {
              name: "[Content_Types].xml",
              data: `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="text/plain"/></Types>`,
            },
            {
              name: "word/document.xml",
              data: documentXml(paragraphXml("wrong types")),
            },
          ]);
          await expectTypedFailure("DOCX with wrong content types", () =>
            importAny(bytes, "wrong-content-types.docx"),
          );
        },
      };
    case "zip-traversal-entry":
      return {
        name: `zip-traversal-entry#${variant}`,
        run: async (context) => {
          const bytes = forgedZipEntries([
            {
              name: "[Content_Types].xml",
              data: Buffer.from(CONTENT_TYPES_XML),
            },
            {
              name: "word/document.xml",
              data: Buffer.from(documentXml(paragraphXml("traversal"))),
            },
            { name: "../escape.txt", data: Buffer.from(`escape-${variant}`) },
          ]);
          const before = await readdir(context.outsideDir);
          // JSZip may sanitise hostile entry names before `readPackage` sees them,
          // so either a typed rejection or a safe import is acceptable - the
          // hard requirement is that nothing escapes the package root.
          let opened: Awaited<ReturnType<typeof importAny>> | undefined;
          try {
            opened = await importAny(bytes, "traversal.docx");
          } catch (error) {
            assert(
              isTypedError(error),
              `ZIP traversal failed untyped: ${describeError(error)}`,
            );
          }
          const after = await readdir(context.outsideDir);
          assert(
            before.length === after.length,
            `ZIP traversal wrote outside the package: ${before.length}->${after.length} entries`,
          );
          if (opened) {
            assert(
              documentText(opened.document).includes("traversal"),
              "a traversal entry replaced the document content",
            );
          }
        },
      };
    case "zip-bomb-shape":
      return {
        name: `zip-bomb-shape#${variant}`,
        run: async () => {
          if (variant % 2 === 0) {
            const payload = Buffer.from(
              documentXml(paragraphXml("declared huge")),
            );
            const bytes = forgedZipEntries([
              {
                name: "[Content_Types].xml",
                data: Buffer.from(CONTENT_TYPES_XML),
              },
              {
                name: "word/document.xml",
                data: payload,
                declaredSize: 512 * 1024 * 1024,
              },
            ]);
            const started = Date.now();
            try {
              await importAny(bytes, "bomb.docx");
            } catch (error) {
              assert(
                isTypedError(error),
                `declared 512 MiB part failed untyped: ${describeError(error)}`,
              );
            }
            assert(
              Date.now() - started < CASE_TIMEOUT_MS,
              `declared 512 MiB part took ${Date.now() - started}ms`,
            );
          } else {
            // A real deflate bomb shape: 24 MiB of zeros, tiny compressed size.
            const zeros = Buffer.alloc(24 * 1024 * 1024, 0);
            const bytes = await buildDocx(paragraphXml("bomb"), [
              { name: "word/media/bomb.bin", data: zeros },
            ]);
            const started = Date.now();
            try {
              await importAny(bytes, "real-bomb.docx");
            } catch (error) {
              assert(
                isTypedError(error),
                `deflate bomb failed untyped: ${describeError(error)}`,
              );
            }
            assert(
              Date.now() - started < CASE_TIMEOUT_MS,
              `deflate bomb took ${Date.now() - started}ms`,
            );
          }
        },
      };
    case "xml-entity-expansion":
      return {
        name: `xml-entity-expansion#${variant}`,
        run: async () => {
          const entities = `<!DOCTYPE lolz [
            <!ENTITY lol "lol">
            <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
            <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
            <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
            <!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
            <!ENTITY lol5 "&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;&lol4;">
          ]>`;
          const xml = `<?xml version="1.0"?>${entities}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lol5;</w:t></w:r></w:p></w:body></w:document>`;
          const bytes = await buildZip([
            { name: "[Content_Types].xml", data: CONTENT_TYPES_XML },
            { name: "word/document.xml", data: xml },
          ]);
          const started = Date.now();
          try {
            const imported = await importAny(bytes, "entities.docx");
            const text = documentText(imported.document);
            assert(
              text.length < 1_000_000,
              `entity expansion produced ${text.length} chars`,
            );
          } catch (error) {
            assert(
              isTypedError(error),
              `entity expansion failed untyped: ${describeError(error)}`,
            );
          }
          assert(
            Date.now() - started < CASE_TIMEOUT_MS,
            `entity expansion took ${Date.now() - started}ms`,
          );
        },
      };
    case "xml-deep-nesting":
      return {
        name: `xml-deep-nesting#${variant}`,
        run: async () => {
          const depth = 1000;
          let inner = "<w:p><w:r><w:t>deep</w:t></w:r></w:p>";
          for (let index = 0; index < depth; index += 1)
            inner = `<w:x>${inner}</w:x>`;
          const bytes = await buildDocx(inner);
          const started = Date.now();
          try {
            await importAny(bytes, "deep.docx");
          } catch (error) {
            assert(
              isTypedError(error),
              `deep nesting failed untyped: ${describeError(error)}`,
            );
          }
          assert(
            Date.now() - started < CASE_TIMEOUT_MS,
            `1000-level nesting took ${Date.now() - started}ms`,
          );
        },
      };
    case "lone-surrogate": {
      const texts = ["a\uD800b", "a\uDC00b", "\uD800", "\uDC00"];
      return {
        name: `lone-surrogate#${variant}`,
        run: async (context) => {
          const text = texts[variant % texts.length];
          const created = await context.service.createDocument({
            paragraphs: ["seed"],
          });
          const blockId = created.document.sections[0].blocks[0].id;
          context.service.insertText(created.documentId, {
            position: { blockId, offset: 0 },
            text,
          });
          await context.service.saveDocument(created.documentId);
          const bytes = await context.service.workspace.loadDocx(
            created.documentId,
          );
          assert(bytes, "lone-surrogate DOCX missing");
          let silentCorruption = "";
          try {
            const imported = await importAny(bytes, "surrogate.docx");
            const roundTripped = documentText(imported.document);
            const preserved = roundTripped.includes(text);
            if (!preserved) {
              const losses = imported.document.compatibility?.losses ?? [];
              const reported = imported.losses.some(
                (loss) => loss.level !== "full",
              );
              if (!reported && losses.length === 0) {
                silentCorruption =
                  `lone surrogate silently replaced with U+FFFD (no loss reported): ` +
                  `before=${JSON.stringify(text)} after=${JSON.stringify(roundTripped)}`;
              }
            }
          } catch (error) {
            assert(
              isTypedError(error),
              `lone surrogate DOCX import failed untyped: ${describeError(error)}`,
            );
          }
          if (silentCorruption) throw new Error(silentCorruption);
          await context.service.closeDocument(created.documentId, {
            discardUnsaved: true,
          });
        },
      };
    }
    case "nul-bytes":
      return {
        name: `nul-bytes#${variant}`,
        run: async (context) => {
          const text = `a\u0000b\u0001c\u0000${"z".repeat(variant * 7)}`;
          const created = await context.service.createDocument({
            paragraphs: ["seed"],
          });
          const blockId = created.document.sections[0].blocks[0].id;
          context.service.insertText(created.documentId, {
            position: { blockId, offset: 0 },
            text,
          });
          await context.service.saveDocument(created.documentId);
          const bytes = await context.service.workspace.loadDocx(
            created.documentId,
          );
          assert(bytes, "NUL DOCX missing");
          try {
            const imported = await importAny(bytes, "nul.docx");
            const roundTripped = documentText(imported.document);
            if (!roundTripped.includes(text)) {
              const reported = imported.losses.some(
                (loss) => loss.level !== "full",
              );
              assert(
                reported,
                `NUL/control text changed silently: before=${JSON.stringify(text.slice(0, 20))} ` +
                  `after=${JSON.stringify(roundTripped.slice(0, 20))}`,
              );
            }
          } catch (error) {
            assert(
              isTypedError(error),
              `NUL text failed untyped: ${describeError(error)}`,
            );
          }
          await context.service.closeDocument(created.documentId, {
            discardUnsaved: true,
          });
        },
      };
    case "huge-paragraph":
      return {
        name: `huge-paragraph#${variant}`,
        run: async (context) => {
          const length = 1024 * 1024 + variant;
          const text = "a".repeat(length);
          const created = await context.service.createDocument({
            paragraphs: ["seed"],
          });
          const blockId = created.document.sections[0].blocks[0].id;
          const started = Date.now();
          context.service.insertText(created.documentId, {
            position: { blockId, offset: 0 },
            text,
          });
          const expectedText = documentText(
            context.service.session(created.documentId).document,
          );
          const bytes = await exportAny(
            context.service.session(created.documentId).document,
            "docx",
          );
          const imported = await importAny(bytes.buffer, "huge.docx");
          assert(
            documentText(imported.document) === expectedText,
            `1 MiB paragraph lost text: ${documentText(imported.document).length} != ${expectedText.length}`,
          );
          assert(
            Date.now() - started < CASE_TIMEOUT_MS,
            `1 MiB paragraph took ${Date.now() - started}ms`,
          );
          await context.service.closeDocument(created.documentId, {
            discardUnsaved: true,
          });
        },
      };
    case "many-paragraphs":
      return {
        name: `many-paragraphs#${variant}`,
        run: async () => {
          const heapBefore = process.memoryUsage().heapUsed;
          const started = Date.now();
          const doc = createDocument({
            paragraphs: Array.from(
              { length: 100_000 },
              (_value, index) => `p${index}`,
            ),
          });
          const text = documentText(doc);
          const stats = documentStats(doc);
          const bytes = await exportAny(doc, "docx");
          const heapDelta = process.memoryUsage().heapUsed - heapBefore;
          assert(
            text.length > 100_000,
            `100k paragraphs produced ${text.length} chars`,
          );
          assert(
            stats.paragraphs === 100_000,
            `stats.paragraphs=${stats.paragraphs}`,
          );
          assert(
            bytes.buffer.length > 100_000,
            "100k paragraph DOCX is unexpectedly small",
          );
          assert(
            heapDelta < 700 * 1024 * 1024,
            `100k paragraphs grew the heap by ${(heapDelta / 1024 / 1024).toFixed(0)} MiB`,
          );
          assert(
            Date.now() - started < CASE_TIMEOUT_MS,
            `100k paragraphs took ${Date.now() - started}ms`,
          );
        },
      };
    case "path-traversal-open":
      return {
        name: `path-traversal-open#${variant}`,
        run: async (context) => {
          const paths = [
            path.join(context.workspace.root, "..", "..", "etc", "passwd.docx"),
            path.join(context.workspace.root, "..", `outside-${variant}.docx`),
            path.resolve(
              context.workspace.root,
              "documents",
              "..",
              "..",
              "escape.docx",
            ),
            path.join(context.outsideDir, "outside.docx"),
            variant % 2 === 0 ? "/etc/passwd" : "C:\\Windows\\win.ini",
          ];
          await expectTypedFailure(
            `open ${paths[variant % paths.length]}`,
            () => context.service.openDocument(paths[variant % paths.length]),
            [
              "PATH_OUTSIDE_WORKSPACE",
              "FILE_NOT_FOUND",
              "FORMAT_UNKNOWN",
              "INVALID_DOCUMENT_ID",
            ],
          );
        },
      };
    case "symlink-escape":
      return {
        name: `symlink-escape#${variant}`,
        run: async (context) => {
          const link = path.join(
            context.workspace.root,
            `escape-link-${variant}`,
          );
          const outsideFile = path.join(
            context.outsideDir,
            `secret-${variant}.docx`,
          );
          await writeFile(outsideFile, context.baseDocx);
          try {
            await symlink(context.outsideDir, link, "junction");
          } catch (error) {
            throw new Error(
              `could not create junction for symlink escape case: ${describeError(error)}`,
            );
          }
          await expectTypedFailure(
            "open through a directory junction outside the workspace",
            () =>
              context.service.openDocument(
                path.join(link, `secret-${variant}.docx`),
              ),
            ["PATH_OUTSIDE_WORKSPACE", "FILE_NOT_FOUND"],
          );
        },
      };
    case "readonly-route": {
      const routes = [
        "create",
        "save",
        "saveAs-docx",
        "saveAs-html",
        "export-docx-path",
        "export-html-path",
        "convert-html-path",
        "export-pdf-path",
        "delete",
        "export-base64",
        "convert-base64",
        "read-text",
      ];
      return {
        name: `readonly-route#${routes[variant % routes.length]}`,
        run: async (context) => {
          const route = routes[variant % routes.length];
          const created = await context.service.createDocument({
            paragraphs: ["readonly route"],
          });
          const documentId = created.documentId;
          await context.service.saveDocument(documentId);
          await context.service.closeDocument(documentId, {
            discardUnsaved: true,
          });
          await context.readOnly.reopenDocument(documentId);
          const target = path.join(
            context.workspace.root,
            `readonly-${variant}.out`,
          );
          const writeRoutes = new Set([
            "create",
            "save",
            "saveAs-docx",
            "saveAs-html",
            "export-docx-path",
            "export-html-path",
            "convert-html-path",
            "export-pdf-path",
            "delete",
          ]);
          try {
            switch (route) {
              case "create":
                await expectTypedFailure(
                  "read-only create",
                  () => context.readOnly.createDocument({ paragraphs: ["x"] }),
                  ["READ_ONLY_MODE"],
                );
                break;
              case "save":
                await expectTypedFailure(
                  "read-only save",
                  () => context.readOnly.saveDocument(documentId),
                  ["READ_ONLY_MODE"],
                );
                break;
              case "saveAs-docx":
                await expectTypedFailure(
                  "read-only saveAs docx",
                  () =>
                    context.readOnly.saveDocumentAs(
                      documentId,
                      `${target}.docx`,
                    ),
                  ["READ_ONLY_MODE"],
                );
                break;
              case "saveAs-html":
                await expectTypedFailure(
                  "read-only saveAs html",
                  () =>
                    context.readOnly.saveDocumentAs(
                      documentId,
                      `${target}.html`,
                    ),
                  ["READ_ONLY_MODE"],
                );
                break;
              case "export-docx-path":
                await expectTypedFailure(
                  "read-only export docx to path",
                  () =>
                    context.readOnly.exportDocument(
                      documentId,
                      "docx",
                      `${target}.docx`,
                    ),
                  ["READ_ONLY_MODE"],
                );
                break;
              case "export-html-path":
                await expectTypedFailure(
                  "read-only export html to path",
                  () =>
                    context.readOnly.exportDocument(
                      documentId,
                      "html",
                      `${target}.html`,
                    ),
                  ["READ_ONLY_MODE"],
                );
                break;
              case "convert-html-path":
                await expectTypedFailure(
                  "read-only convert to path",
                  () =>
                    context.readOnly.convert({
                      documentId,
                      to: "html",
                      outputPath: `${target}-convert.html`,
                    }),
                  ["READ_ONLY_MODE"],
                );
                break;
              case "export-pdf-path":
                await expectTypedFailure(
                  "read-only export PDF to path",
                  () => context.readOnly.exportPdf(documentId, `${target}.pdf`),
                  ["READ_ONLY_MODE"],
                );
                break;
              case "delete":
                await expectTypedFailure(
                  "read-only delete",
                  () => context.readOnly.deleteDocument(documentId),
                  ["READ_ONLY_MODE"],
                );
                break;
              case "export-base64":
                await expectSuccess("read-only base64 export", () =>
                  context.readOnly.exportDocument(documentId, "html"),
                );
                break;
              case "convert-base64":
                await expectSuccess("read-only base64 conversion", () =>
                  context.readOnly.convert({ documentId, to: "html" }),
                );
                break;
              default:
                await expectSuccess("read-only text read", async () =>
                  context.readOnly.getText(documentId),
                );
            }
          } finally {
            if (writeRoutes.has(route)) {
              const files = await readdir(context.workspace.root);
              const leaked = files.filter((file) =>
                file.startsWith(`readonly-${variant}`),
              );
              assert(
                leaked.length === 0,
                `read-only route ${route} leaked files: ${leaked.join(", ")}`,
              );
            }
            await context.readOnly.closeDocument(documentId, {
              discardUnsaved: true,
            });
          }
        },
      };
    }
    case "concurrent-saves":
      return {
        name: `concurrent-saves#${variant}`,
        run: async (context) => {
          const created = await context.service.createDocument({
            paragraphs: ["c1", "c2"],
          });
          const documentId = created.documentId;
          const blockId = created.document.sections[0].blocks[0].id;
          context.service.insertText(documentId, {
            position: { blockId, offset: 0 },
            text: `c${variant}`,
          });
          const results = await Promise.allSettled([
            context.service.saveDocument(documentId),
            context.service.saveDocument(documentId),
            context.service.saveDocument(documentId),
          ]);
          const rejected = results.filter(
            (result) => result.status === "rejected",
          );
          assert(
            rejected.length === 0,
            `concurrent saves rejected: ${rejected.length}`,
          );
          await assertWorkspaceIntegrity(context.workspace.root);
          await context.service.closeDocument(documentId, {
            discardUnsaved: true,
          });
        },
      };
    case "save-during-op":
      return {
        name: `save-during-op#${variant}`,
        run: async (context) => {
          const created = await context.service.createDocument({
            paragraphs: ["before"],
          });
          const documentId = created.documentId;
          const blockId = created.document.sections[0].blocks[0].id;
          const pending = context.service.saveDocument(documentId);
          context.service.insertText(documentId, {
            position: { blockId, offset: 0 },
            text: `MUTATION-${variant}-`,
          });
          await pending;
          const json = (await context.service.workspace.loadModel(
            documentId,
          )) as DocDocument;
          const bytes = await context.service.workspace.loadDocx(documentId);
          assert(bytes, "save-during-op DOCX missing");
          const docx = await importAny(bytes, "race.docx");
          assert(
            documentText(json) === documentText(docx.document),
            `save during mutation produced an inconsistent snapshot: ` +
              `JSON=${JSON.stringify(documentText(json).slice(0, 40))} DOCX=${JSON.stringify(
                documentText(docx.document).slice(0, 40),
              )}`,
          );
          await assertWorkspaceIntegrity(context.workspace.root);
          await context.service.closeDocument(documentId, {
            discardUnsaved: true,
          });
        },
      };
    case "partial-save":
      return {
        name: `partial-save#${variant}`,
        run: async (context) => {
          const created = await context.service.createDocument({
            paragraphs: ["atomic save"],
          });
          const documentId = created.documentId;
          const directory = path.join(
            context.workspace.root,
            "documents",
            documentId,
          );
          const blockId = created.document.sections[0].blocks[0].id;
          context.service.insertText(documentId, {
            position: { blockId, offset: 0 },
            text: `PARTIAL-${variant}-`,
          });
          const jsonBefore = await readFile(
            path.join(directory, "document.json"),
          );
          const docxBefore = await readFile(
            path.join(directory, "document.docx"),
          );
          // Force the final write of the three-file commit (record.json) to fail.
          await rm(path.join(directory, "record.json"), { force: true });
          await mkdir(path.join(directory, "record.json"), { recursive: true });
          let failure: unknown;
          try {
            await context.service.saveDocument(documentId);
          } catch (error) {
            failure = error;
          }
          assert(
            failure !== undefined,
            "save with an unwritable record.json unexpectedly succeeded",
          );
          const problems: string[] = [];
          if (!isTypedError(failure)) {
            problems.push(
              `failed save surfaced an untyped error: ${describeError(failure)}`,
            );
          }
          const jsonAfter = await readFile(
            path.join(directory, "document.json"),
          );
          const docxAfter = await readFile(
            path.join(directory, "document.docx"),
          );
          if (!jsonBefore.equals(jsonAfter) || !docxBefore.equals(docxAfter)) {
            problems.push(
              "failed save committed a partial set: document.json/document.docx changed before " +
                "record.json failed (no atomic replace/rollback)",
            );
          }
          if (problems.length > 0) throw new Error(problems.join("; "));
          await rm(path.join(directory, "record.json"), {
            recursive: true,
            force: true,
          });
          await context.service.closeDocument(documentId, {
            discardUnsaved: true,
          });
          await context.service
            .deleteDocument(documentId)
            .catch(() => undefined);
        },
      };
    case "double-close":
      return {
        name: `double-close#${variant}`,
        run: async (context) => {
          const created = await context.service.createDocument({
            paragraphs: ["double close"],
          });
          const documentId = created.documentId;
          await expectSuccess("first close", () =>
            context.service.closeDocument(documentId, { discardUnsaved: true }),
          );
          await expectTypedFailure(
            "second close",
            () =>
              context.service.closeDocument(documentId, {
                discardUnsaved: true,
              }),
            ["DOCUMENT_NOT_OPEN"],
          );
        },
      };
    case "delete-while-open":
      return {
        name: `delete-while-open#${variant}`,
        run: async (context) => {
          const created = await context.service.createDocument({
            paragraphs: ["delete while open"],
          });
          const documentId = created.documentId;
          await expectSuccess("delete while open", () =>
            context.service.deleteDocument(documentId),
          );
          await expectTypedFailure(
            "text after delete",
            async () => context.service.getText(documentId),
            ["DOCUMENT_NOT_OPEN"],
          );
          await expectTypedFailure(
            "save after delete",
            () => context.service.saveDocument(documentId),
            ["DOCUMENT_NOT_OPEN"],
          );
          assert(
            (await context.service.workspace.exists(documentId)) === false,
            "deleteDocument left the document directory behind",
          );
        },
      };
    case "invalid-range": {
      const operations = [
        "selection-end-before-start",
        "selection-beyond-text",
        "selection-negative-offset",
        "selection-inline-beyond",
        "delete-end-before-start",
        "replace-end-before-start",
        "format-beyond-text",
        "delete-beyond-text",
        "replace-unknown-block",
        "format-unknown-block",
        "delete-unknown-block",
        "selection-unknown-block",
        "replace-negative-offset",
        "format-negative-offset",
        "delete-negative-offset",
        "selection-unknown-end",
      ];
      return {
        name: `invalid-range#${operations[variant % operations.length]}`,
        run: async (context) => {
          const operation = operations[variant % operations.length];
          const created = await context.service.createDocument({
            paragraphs: ["abcdef", "second"],
          });
          const documentId = created.documentId;
          const blocks = created.document.sections[0].blocks;
          const first = blocks[0].id;
          const second = blocks[1].id;
          const before = modelHash(
            context.service.session(documentId).document,
          );
          const range = (
            start: PositionInputLike,
            end: PositionInputLike,
          ): { start: PositionInputLike; end: PositionInputLike } => ({
            start,
            end,
          });
          let work: () => Promise<unknown>;
          switch (operation) {
            case "selection-end-before-start":
              work = async () =>
                context.service.getSelection(
                  documentId,
                  range(
                    { blockId: second, offset: 2 },
                    { blockId: first, offset: 2 },
                  ),
                );
              break;
            case "selection-beyond-text":
              work = async () =>
                context.service.getSelection(
                  documentId,
                  range(
                    { blockId: first, offset: 999 },
                    { blockId: first, offset: 1000 },
                  ),
                );
              break;
            case "selection-negative-offset":
              work = async () =>
                context.service.getSelection(
                  documentId,
                  range(
                    { blockId: first, offset: -5 },
                    { blockId: first, offset: -1 },
                  ),
                );
              break;
            case "selection-inline-beyond":
              work = async () =>
                context.service.getSelection(
                  documentId,
                  range(
                    { blockId: first, inlineIndex: 99, offset: 0 },
                    { blockId: first, inlineIndex: 100, offset: 3 },
                  ),
                );
              break;
            case "delete-end-before-start":
              work = async () =>
                context.service.deleteRange(documentId, {
                  range: range(
                    { blockId: second, offset: 2 },
                    { blockId: first, offset: 2 },
                  ),
                });
              break;
            case "replace-end-before-start":
              work = async () =>
                context.service.replaceText(documentId, {
                  range: range(
                    { blockId: second, offset: 5 },
                    { blockId: first, offset: 3 },
                  ),
                  text: "X",
                });
              break;
            case "format-beyond-text":
              work = async () =>
                context.service.formatText(documentId, {
                  range: range(
                    { blockId: first, offset: 900 },
                    { blockId: first, offset: 1000 },
                  ),
                  props: { bold: true },
                });
              break;
            case "delete-beyond-text":
              work = async () =>
                context.service.deleteRange(documentId, {
                  range: range(
                    { blockId: second, offset: 900 },
                    { blockId: second, offset: 1000 },
                  ),
                });
              break;
            case "replace-unknown-block":
              work = async () =>
                context.service.replaceText(documentId, {
                  range: range(
                    { blockId: "missing", offset: 0 },
                    { blockId: "missing", offset: 1 },
                  ),
                  text: "X",
                });
              break;
            case "format-unknown-block":
              work = async () =>
                context.service.formatText(documentId, {
                  range: range(
                    { blockId: "missing", offset: 0 },
                    { blockId: "missing", offset: 1 },
                  ),
                  props: { bold: true },
                });
              break;
            case "delete-unknown-block":
              work = async () =>
                context.service.deleteRange(documentId, {
                  range: range(
                    { blockId: "missing", offset: 0 },
                    { blockId: "missing", offset: 1 },
                  ),
                });
              break;
            case "selection-unknown-block":
              work = async () =>
                context.service.getSelection(
                  documentId,
                  range(
                    { blockId: "missing", offset: 0 },
                    { blockId: "missing", offset: 1 },
                  ),
                );
              break;
            case "replace-negative-offset":
              work = async () =>
                context.service.replaceText(documentId, {
                  range: range(
                    { blockId: first, offset: -3 },
                    { blockId: first, offset: 2 },
                  ),
                  text: "X",
                });
              break;
            case "format-negative-offset":
              work = async () =>
                context.service.formatText(documentId, {
                  range: range(
                    { blockId: first, offset: -3 },
                    { blockId: first, offset: 2 },
                  ),
                  props: { bold: true },
                });
              break;
            case "delete-negative-offset":
              work = async () =>
                context.service.deleteRange(documentId, {
                  range: range(
                    { blockId: first, offset: -3 },
                    { blockId: first, offset: 2 },
                  ),
                });
              break;
            default:
              work = async () =>
                context.service.getSelection(
                  documentId,
                  range(
                    { blockId: first, offset: 0 },
                    { blockId: "missing", offset: 1 },
                  ),
                );
          }
          let typedFailure = false;
          try {
            await expectTypedFailure(operation, work);
            typedFailure = true;
          } finally {
            if (typedFailure) {
              const after = modelHash(
                context.service.session(documentId).document,
              );
              assert(
                before === after,
                `${operation} mutated the document while failing (no rollback)`,
              );
            }
            await context.service.closeDocument(documentId, {
              discardUnsaved: true,
            });
          }
        },
      };
    }
    case "overlapping-ranges":
      return {
        name: `overlapping-ranges#${variant}`,
        run: async (context) => {
          const created = await context.service.createDocument({
            paragraphs: ["0123456789", "abcdefghij"],
          });
          const documentId = created.documentId;
          const blocks = created.document.sections[0].blocks;
          const first = blocks[0].id;
          const second = blocks[1].id;
          context.service.replaceText(documentId, {
            range: {
              start: { blockId: first, offset: 2 },
              end: { blockId: first, offset: 8 },
            },
            text: "WIDE",
          });
          context.service.formatText(documentId, {
            range: {
              start: { blockId: first, offset: 1 },
              end: { blockId: second, offset: 4 },
            },
            props: { italic: true },
          });
          context.service.deleteRange(documentId, {
            range: {
              start: { blockId: first, offset: 0 },
              end: { blockId: second, offset: 2 },
            },
          });
          const text = documentText(
            context.service.session(documentId).document,
          );
          assert(
            typeof text === "string",
            "overlapping ranges produced a non-string model",
          );
          await context.service.closeDocument(documentId, {
            discardUnsaved: true,
          });
        },
      };
    case "table-non-table": {
      const tableOperations = [
        "insertRow",
        "deleteRow",
        "insertColumn",
        "deleteColumn",
        "mergeCells",
        "splitCell",
      ];
      return {
        name: `table-non-table#${variant}`,
        run: async (context) => {
          const operation = tableOperations[variant % tableOperations.length];
          const created = await context.service.createDocument({
            paragraphs: ["paragraph, not a table"],
          });
          const documentId = created.documentId;
          const blockId = created.document.sections[0].blocks[0].id;
          const args: Record<string, unknown> = { tableId: blockId, operation };
          if (operation === "mergeCells") {
            args.region = {
              startRow: 0,
              endRow: 0,
              startColumn: 0,
              endColumn: 1,
            };
          }
          if (operation === "splitCell") args.cellId = blockId;
          await expectTypedFailure(
            `table op ${operation} on a paragraph id`,
            async () => context.service.editTable(documentId, args as never),
            ["TABLE_NOT_FOUND", "INVALID_ARGUMENT"],
          );
          await context.service.closeDocument(documentId, {
            discardUnsaved: true,
          });
        },
      };
    }
    case "table-bad-region": {
      const regions = [
        "reversed-rows",
        "reversed-columns",
        "beyond-rows",
        "beyond-columns",
        "negative",
        "missing-region",
      ];
      return {
        name: `table-bad-region#${regions[variant % regions.length]}`,
        run: async (context) => {
          const kind = regions[variant % regions.length];
          const created = await context.service.createDocument({
            paragraphs: ["table"],
          });
          const documentId = created.documentId;
          const blockId = created.document.sections[0].blocks[0].id;
          const table = context.service.insertTable(documentId, {
            rows: 2,
            columns: 2,
            afterBlockId: blockId,
          }) as { tableId: string };
          const tableId = table.tableId;
          let work: () => Promise<unknown>;
          switch (kind) {
            case "reversed-rows":
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: 1,
                    endRow: 0,
                    startColumn: 0,
                    endColumn: 0,
                  },
                });
              break;
            case "reversed-columns":
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: 0,
                    endRow: 0,
                    startColumn: 1,
                    endColumn: 0,
                  },
                });
              break;
            case "beyond-rows":
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: 0,
                    endRow: 99,
                    startColumn: 0,
                    endColumn: 0,
                  },
                });
              break;
            case "beyond-columns":
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: 0,
                    endRow: 0,
                    startColumn: 0,
                    endColumn: 99,
                  },
                });
              break;
            case "negative":
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: -5,
                    endRow: -1,
                    startColumn: -5,
                    endColumn: -1,
                  },
                });
              break;
            default:
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                });
          }
          await expectTypedFailure(`mergeCells ${kind}`, work, [
            "INVALID_ARGUMENT",
            "INVALID_RANGE",
          ]);
          await context.service.closeDocument(documentId, {
            discardUnsaved: true,
          });
        },
      };
    }
    case "merge-non-adjacent": {
      const regions = [
        "reversed-rows",
        "reversed-columns",
        "out-of-bounds-rows",
        "out-of-bounds-columns",
        "overlaps-merged-cell",
        "repeated-merge",
        "zero-area",
        "split-unmerged",
      ];
      return {
        name: `merge-non-adjacent#${regions[variant % regions.length]}`,
        run: async (context) => {
          const kind = regions[variant % regions.length];
          const created = await context.service.createDocument({
            paragraphs: ["merge"],
          });
          const documentId = created.documentId;
          const blockId = created.document.sections[0].blocks[0].id;
          const table = context.service.insertTable(documentId, {
            rows: 3,
            columns: 3,
            afterBlockId: blockId,
          }) as { tableId: string };
          const tableId = table.tableId;
          const doc = context.service.session(documentId).document;
          const tableBlock = doc.sections[0].blocks.find(
            (block) => block.type === "table",
          );
          assert(
            tableBlock && tableBlock.type === "table",
            "table was not created",
          );
          const firstCell = tableBlock.rows[0].cells[0].id;
          context.service.editTable(documentId, {
            tableId,
            operation: "mergeCells",
            region: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 },
          });
          if (kind === "split-unmerged") {
            const secondRowCell = tableBlock.rows[1].cells[1].id;
            const result = await expectSuccess(
              "splitting an unmerged cell is a no-op",
              async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "splitCell",
                  cellId: secondRowCell,
                }),
            );
            const idsAfter = collectCellIds(
              context.service.session(documentId).document,
              tableId,
            );
            assert(
              new Set(idsAfter).size === idsAfter.length,
              `split of an unmerged cell duplicated cell ids: ${idsAfter.join(",")}`,
            );
            void result;
            await context.service.closeDocument(documentId, {
              discardUnsaved: true,
            });
            return;
          }
          let work: () => Promise<unknown>;
          switch (kind) {
            case "reversed-rows":
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: 2,
                    endRow: 0,
                    startColumn: 1,
                    endColumn: 1,
                  },
                });
              break;
            case "reversed-columns":
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: 1,
                    endRow: 1,
                    startColumn: 2,
                    endColumn: 0,
                  },
                });
              break;
            case "out-of-bounds-rows":
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: 9,
                    endRow: 12,
                    startColumn: 1,
                    endColumn: 1,
                  },
                });
              break;
            case "out-of-bounds-columns":
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: 1,
                    endRow: 1,
                    startColumn: 9,
                    endColumn: 12,
                  },
                });
              break;
            case "overlaps-merged-cell":
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: 0,
                    endRow: 1,
                    startColumn: 0,
                    endColumn: 0,
                  },
                });
              break;
            case "repeated-merge":
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: 0,
                    endRow: 0,
                    startColumn: 0,
                    endColumn: 1,
                  },
                });
              break;
            default:
              work = async () =>
                context.service.editTable(documentId, {
                  tableId,
                  operation: "mergeCells",
                  region: {
                    startRow: 1,
                    endRow: 1,
                    startColumn: 1,
                    endColumn: 0,
                  },
                });
          }
          await expectTypedFailure(`merge ${kind}`, work, [
            "INVALID_ARGUMENT",
            "INVALID_RANGE",
            "CELL_NOT_FOUND",
          ]);
          await context.service.closeDocument(documentId, {
            discardUnsaved: true,
          });
          void firstCell;
        },
      };
    }
    default:
      return {
        name: `unknown-case#${variant}`,
        run: async () => {
          throw new Error(`unknown anomaly case kind ${kind}`);
        },
      };
  }
}

describe(`anomaly / fault injection (seed ${config.seed}, ${config.cases} cases)`, () => {
  let workspace: TempWorkspace;
  let readOnly: DocumentService;
  let outsideDir: string;
  let baseDocx: Buffer;

  beforeAll(async () => {
    workspace = await createTempWorkspace("dsh-fuzz-anomaly-");
    outsideDir = await createTempFolderOutside(workspace.root);
    readOnly = new DocumentService({
      workspaceRoot: workspace.root,
      allowedReadRoots: [workspace.root],
      readOnly: true,
    });
    await readOnly.init();
    baseDocx = await makeBaseDocx(workspace.service);
  });

  afterAll(async () => {
    await rm(outsideDir, { recursive: true, force: true });
    await workspace.dispose();
  });

  it("survives 150 hostile inputs with typed errors, no crash/hang and an intact workspace", async () => {
    const reporter = new FuzzReporter("anomaly");
    const cases = buildCases(config.cases, config.seed);
    const failures: string[] = [];

    for (let index = 0; index < cases.length; index += 1) {
      const entry = cases[index];
      const seed = caseSeed(config.seed, index);
      const context: AnomalyContext = {
        workspace,
        service: workspace.service,
        readOnly,
        baseDocx,
        outsideDir,
        seed,
      };
      try {
        await withTimeout(entry.name, CASE_TIMEOUT_MS, () =>
          entry.run(context),
        );
        await assertWorkspaceIntegrity(workspace.root);
        reporter.pass(entry.name);
      } catch (error) {
        const detail = `seed=${seed} case=${entry.name}\n${describeError(error)}\n${
          (error as Error).stack ?? ""
        }`;
        failures.push(detail);
        reporter.fail(entry.name, detail);
      }
    }

    const summary = await reporter.writeSummary();
    expect(summary.cases).toBe(config.cases);
    if (failures.length > 0) {
      throw new Error(
        `anomaly failures (seed ${config.seed}):\n\n${failures
          .slice(0, 10)
          .join(
            "\n\n---\n\n",
          )}\n\n... ${Math.max(0, failures.length - 10)} more failure(s)`,
      );
    }
    expect(summary.failed).toBe(0);
  }, 900_000);
});

async function createTempFolderOutside(root: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const outside = await mkdtemp(path.join(os.tmpdir(), "dsh-fuzz-outside-"));
  void root;
  return outside;
}
