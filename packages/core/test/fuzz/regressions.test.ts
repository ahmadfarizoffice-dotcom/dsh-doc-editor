/**
 * Focused regressions for the defects catalogued in KNOWN-ISSUES.md.
 *
 * The property suites in this directory prove the general contracts; this file
 * pins each fixed defect to one deterministic assertion so a future regression
 * fails in a readable way.
 */
import { describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import {
  DocumentService,
  ServiceError,
  documentText,
  exportAny,
  importAny,
} from "../../src/dsh-entry.js";
import {
  collectStructuralIds,
  createTempWorkspace,
  duplicateIds,
  modelHash,
  orderedParagraphTexts,
} from "./support.js";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

async function zipOf(parts: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(parts)) zip.file(name, data);
  return zip.generateAsync({ type: "nodebuffer" });
}

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? "<untyped>";
}

describe("KNOWN-ISSUES regressions", () => {
  it("D6: every write route is refused in read-only mode and writes nothing", async () => {
    const workspace = await createTempWorkspace("dsh-reg-readonly-");
    const created = await workspace.service.createDocument({
      paragraphs: ["read-only"],
    });
    const documentId = created.documentId;
    await workspace.service.saveDocument(documentId);
    await workspace.service.closeDocument(documentId, {
      discardUnsaved: true,
    });

    const readOnly = new DocumentService({
      workspaceRoot: workspace.root,
      allowedReadRoots: [workspace.root],
      readOnly: true,
    });
    await readOnly.init();
    await readOnly.reopenDocument(documentId);

    const output = path.join(workspace.root, "readonly-routes");
    await mkdir(output, { recursive: true });
    const routes: Array<[string, () => Promise<unknown>]> = [
      [
        "saveAs-html",
        () => readOnly.saveDocumentAs(documentId, path.join(output, "a.html")),
      ],
      [
        "export-docx-path",
        () =>
          readOnly.exportDocument(
            documentId,
            "docx",
            path.join(output, "a.docx"),
          ),
      ],
      [
        "export-html-path",
        () =>
          readOnly.exportDocument(
            documentId,
            "html",
            path.join(output, "a2.html"),
          ),
      ],
      [
        "convert-html-path",
        () =>
          readOnly.convert({
            documentId,
            to: "html",
            outputPath: path.join(output, "a3.html"),
          }),
      ],
      [
        "export-pdf-path",
        () => readOnly.exportPdf(documentId, path.join(output, "a.pdf")),
      ],
    ];
    for (const [name, run] of routes) {
      const before = new Set(await readdir(output));
      let failure: unknown;
      try {
        await run();
      } catch (error) {
        failure = error;
      }
      expect(failure, `${name} must be refused`).toBeInstanceOf(ServiceError);
      expect(codeOf(failure), `${name} code`).toBe("READ_ONLY_MODE");
      const after = new Set(await readdir(output));
      expect(
        [...after].filter((file) => !before.has(file)),
        `${name} must not leak files`,
      ).toEqual([]);
    }
    // The in-memory routes still work read-only.
    await expect(
      readOnly.exportDocument(documentId, "html"),
    ).resolves.toBeTruthy();
    await expect(
      readOnly.convert({ documentId, to: "html" }),
    ).resolves.toBeTruthy();
    await readOnly.closeDocument(documentId, { discardUnsaved: true });
    await workspace.dispose();
  });

  it("D7: a directory junction pointing outside the workspace is rejected", async () => {
    const workspace = await createTempWorkspace("dsh-reg-junction-");
    const created = await workspace.service.createDocument({
      paragraphs: ["secret"],
    });
    await workspace.service.saveDocument(created.documentId);
    const docx = await workspace.service.workspace.loadDocx(created.documentId);
    expect(docx).toBeTruthy();
    const outside = await mkdtemp(path.join(os.tmpdir(), "dsh-reg-outside-"));
    try {
      await writeFile(path.join(outside, "secret.docx"), docx as Buffer);
      const link = path.join(workspace.root, "escape-link");
      await symlink(
        outside,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      let failure: unknown;
      try {
        await workspace.service.openDocument(path.join(link, "secret.docx"));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ServiceError);
      expect(codeOf(failure)).toBe("PATH_OUTSIDE_WORKSPACE");
    } finally {
      await rm(outside, { recursive: true, force: true });
      await workspace.dispose();
    }
  });

  it("A1/A2: corrupt or undeclared DOCX packages fail with a typed format code", async () => {
    const truncated = await zipOf({
      "[Content_Types].xml": CONTENT_TYPES,
      "word/document.xml":
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    });
    for (const [label, bytes] of [
      [
        "truncated ZIP",
        truncated.subarray(0, Math.floor(truncated.length / 2)),
      ],
      [
        "missing content types",
        await zipOf({ "word/document.xml": "<w:document/>" }),
      ],
      [
        "wrong content types",
        await zipOf({
          "[Content_Types].xml":
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="text/plain"/></Types>',
          "word/document.xml": "<w:document/>",
        }),
      ],
    ] as Array<[string, Buffer]>) {
      let failure: unknown;
      try {
        await importAny(bytes, `${label}.docx`);
      } catch (error) {
        failure = error;
      }
      expect(failure, label).toBeDefined();
      expect(
        (failure as { name?: string }).name,
        `${label} must be a typed FormatError`,
      ).toBe("FormatError");
      expect(["FORMAT_CORRUPT", "FORMAT_BOMB"], `${label} code`).toContain(
        codeOf(failure),
      );
    }
  });

  it("A4: binary bytes with a .txt extension are rejected instead of decoded", async () => {
    const workspace = await createTempWorkspace("dsh-reg-binary-");
    const file = path.join(workspace.root, "binary.txt");
    await writeFile(
      file,
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x80, 0x81]),
    );
    let failure: unknown;
    try {
      await workspace.service.openDocument(file);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect((failure as { name?: string }).name).toBe("FormatError");
    expect(codeOf(failure)).toBe("FORMAT_CORRUPT");
    await workspace.dispose();
  });

  it("B1: a reversed replaceText range throws INVALID_RANGE and leaves the model byte-identical", async () => {
    const workspace = await createTempWorkspace("dsh-reg-range-");
    const created = await workspace.service.createDocument({
      paragraphs: ["abcdef", "second"],
    });
    const documentId = created.documentId;
    const [first, second] = created.document.sections[0].blocks.map(
      (block) => block.id,
    );
    const before = modelHash(workspace.service.session(documentId).document);
    let failure: unknown;
    try {
      workspace.service.replaceText(documentId, {
        range: {
          start: { blockId: second, offset: 5 },
          end: { blockId: first, offset: 3 },
        },
        text: "X",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ServiceError);
    expect(codeOf(failure)).toBe("INVALID_RANGE");
    expect(modelHash(workspace.service.session(documentId).document)).toBe(
      before,
    );
    expect(documentText(workspace.service.session(documentId).document)).toBe(
      "abcdef\nsecond",
    );
    await workspace.dispose();
  });

  it("C1: invalid mergeCells regions are rejected and legitimate merges still work", async () => {
    const workspace = await createTempWorkspace("dsh-reg-merge-");
    const created = await workspace.service.createDocument({
      paragraphs: ["table"],
    });
    const documentId = created.documentId;
    const anchor = created.document.sections[0].blocks[0].id;
    const table = workspace.service.insertTable(documentId, {
      rows: 3,
      columns: 3,
      afterBlockId: anchor,
    }) as { tableId: string };
    const invalid = [
      { startRow: 1, endRow: 0, startColumn: 0, endColumn: 0 },
      { startRow: 0, endRow: 0, startColumn: 2, endColumn: 0 },
      { startRow: 0, endRow: 99, startColumn: 0, endColumn: 0 },
      { startRow: -1, endRow: 0, startColumn: 0, endColumn: 0 },
      { startRow: 0, endRow: 0, startColumn: 9, endColumn: 12 },
    ];
    for (const region of invalid) {
      let failure: unknown;
      try {
        workspace.service.editTable(documentId, {
          tableId: table.tableId,
          operation: "mergeCells",
          region,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure, JSON.stringify(region)).toBeInstanceOf(ServiceError);
      expect(codeOf(failure)).toBe("INVALID_RANGE");
    }
    const merged = workspace.service.editTable(documentId, {
      tableId: table.tableId,
      operation: "mergeCells",
      region: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 },
    }) as { cellId: string };
    expect(merged.cellId).toBeTruthy();
    // An overlapping or repeated merge conflicts with the existing one.
    for (const region of [
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 },
      { startRow: 0, endRow: 1, startColumn: 0, endColumn: 0 },
    ]) {
      let failure: unknown;
      try {
        workspace.service.editTable(documentId, {
          tableId: table.tableId,
          operation: "mergeCells",
          region,
        });
      } catch (error) {
        failure = error;
      }
      expect(codeOf(failure)).toBe("INVALID_RANGE");
    }
    await workspace.dispose();
  });

  it("D1: insertSectionBreak keeps every structural id globally unique", async () => {
    const workspace = await createTempWorkspace("dsh-reg-section-");
    const created = await workspace.service.createDocument({
      paragraphs: ["one", "two"],
    });
    const documentId = created.documentId;
    workspace.service.editHeaderFooter(documentId, {
      part: "header",
      text: "HEAD",
    });
    workspace.service.editHeaderFooter(documentId, {
      part: "footer",
      text: "FOOT",
    });
    workspace.service.insertSectionBreak(documentId, {
      sectionIndex: 0,
      blockIndex: 1,
    });
    const doc = workspace.service.session(documentId).document;
    expect(duplicateIds(collectStructuralIds(doc))).toEqual([]);
    const headerIds = doc.sections.map(
      (section) => section.headers.default?.blocks[0]?.id,
    );
    expect(new Set(headerIds).size).toBe(headerIds.length);
    await workspace.dispose();
  });

  it("D5: a failed three-file save leaves the previous snapshot intact with SAVE_FAILED", async () => {
    const workspace = await createTempWorkspace("dsh-reg-atomic-");
    const created = await workspace.service.createDocument({
      paragraphs: ["atomic"],
    });
    const documentId = created.documentId;
    const directory = path.join(workspace.root, "documents", documentId);
    const jsonBefore = await readFile(path.join(directory, "document.json"));
    const docxBefore = await readFile(path.join(directory, "document.docx"));
    await rm(path.join(directory, "record.json"), { force: true });
    await mkdir(path.join(directory, "record.json"), { recursive: true });
    let failure: unknown;
    try {
      await workspace.service.saveDocument(documentId);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ServiceError);
    expect(codeOf(failure)).toBe("SAVE_FAILED");
    expect(await readFile(path.join(directory, "document.json"))).toEqual(
      jsonBefore,
    );
    expect(await readFile(path.join(directory, "document.docx"))).toEqual(
      docxBefore,
    );
    const leftovers = (await readdir(directory)).filter((file) =>
      /\.(tmp|bak)$/.test(file),
    );
    expect(leftovers).toEqual([]);
    await rm(path.join(directory, "record.json"), {
      recursive: true,
      force: true,
    });
    await workspace.dispose();
  });

  it("E1: setPageLayout rejects unknown orientation, bad margins and unknown sections", async () => {
    const workspace = await createTempWorkspace("dsh-reg-layout-");
    const created = await workspace.service.createDocument({
      paragraphs: ["layout"],
    });
    const documentId = created.documentId;
    const cases: Array<[string, () => unknown]> = [
      [
        "orientation",
        () =>
          workspace.service.setPageLayout(documentId, {
            page: { orientation: "diagonal" as never },
          }),
      ],
      [
        "negative margin",
        () =>
          workspace.service.setPageLayout(documentId, {
            page: { margins: { top: -72 } as never },
          }),
      ],
      [
        "NaN margin",
        () =>
          workspace.service.setPageLayout(documentId, {
            page: { margins: { top: Number.NaN } as never },
          }),
      ],
      [
        "overflow margins",
        () =>
          workspace.service.setPageLayout(documentId, {
            page: {
              margins: { top: 900, bottom: 900 } as never,
            },
          }),
      ],
      [
        "unknown section",
        () => workspace.service.setPageLayout(documentId, { sectionIndex: 9 }),
      ],
    ];
    for (const [label, run] of cases) {
      let failure: unknown;
      try {
        run();
      } catch (error) {
        failure = error;
      }
      expect(failure, label).toBeInstanceOf(ServiceError);
      expect(["INVALID_ARGUMENT", "SECTION_NOT_FOUND"], label).toContain(
        codeOf(failure),
      );
    }
    // A valid layout still applies.
    workspace.service.setPageLayout(documentId, {
      page: {
        orientation: "landscape",
        margins: { top: 36, left: 36 } as never,
      },
    });
    expect(workspace.service.validate(documentId).valid).toBe(true);
    await workspace.dispose();
  });

  it("A5: lone surrogates are split-free through edits and a DOCX loss is reported", async () => {
    const workspace = await createTempWorkspace("dsh-reg-surrogate-");
    const created = await workspace.service.createDocument({
      paragraphs: ["emoji 🌈 pair"],
    });
    const documentId = created.documentId;
    const blockId = created.document.sections[0].blocks[0].id;
    // Formatting inside the surrogate pair must not split it into two halves.
    workspace.service.formatText(documentId, {
      range: {
        start: { blockId, offset: 6 },
        end: { blockId, offset: 7 },
      },
      props: { bold: true },
    });
    expect(
      documentText(workspace.service.session(documentId).document),
    ).toContain("🌈");
    await workspace.service.saveDocument(documentId);
    const docx = await workspace.service.workspace.loadDocx(documentId);
    const reimported = await importAny(docx as Buffer, "emoji.docx");
    expect(documentText(reimported.document)).toContain("🌈");

    // A raw lone surrogate cannot be represented in XML: it must be reported.
    workspace.service.insertText(documentId, {
      position: { blockId, offset: 0 },
      text: "\uD800",
    });
    await workspace.service.saveDocument(documentId);
    const lossyDocx = await workspace.service.workspace.loadDocx(documentId);
    const lossy = await importAny(lossyDocx as Buffer, "lone.docx");
    expect(
      lossy.losses.some(
        (loss) => loss.feature === "text.unicode" && loss.level !== "full",
      ),
    ).toBe(true);
    await workspace.dispose();
  });

  it("F1/F3: ODT and HTML report the structural losses they cannot represent", async () => {
    const workspace = await createTempWorkspace("dsh-reg-losses-");
    const created = await workspace.service.createDocument({
      paragraphs: ["one", "two"],
    });
    const documentId = created.documentId;
    const blocks = created.document.sections[0].blocks;
    workspace.service.insertToc(documentId, {
      afterBlockId: blocks[1].id,
      minLevel: 1,
      maxLevel: 3,
    });
    workspace.service.insertSectionBreak(documentId, {
      sectionIndex: 0,
      blockIndex: 2,
    });
    const doc = workspace.service.session(documentId).document;
    for (const format of ["odt", "html"] as const) {
      const exported = await exportAny(doc, format);
      const features = exported.losses.map((loss) => loss.feature);
      expect(features, `${format} section loss`).toContain(
        "sections.flattened",
      );
      expect(features, `${format} toc loss`).toContain("toc");
    }
    await workspace.dispose();
  });

  it("D2/D3: DOCX round-trip preserves table-ending, TOC-ending and empty sections", async () => {
    const workspace = await createTempWorkspace("dsh-reg-sections-");
    const created = await workspace.service.createDocument({
      paragraphs: ["first", "second"],
    });
    const documentId = created.documentId;
    const [first] = created.document.sections[0].blocks.map(
      (block) => block.id,
    );
    workspace.service.insertTable(documentId, {
      rows: 1,
      columns: 2,
      data: [["a", "b"]],
      afterBlockId: first,
    });
    workspace.service.insertSectionBreak(documentId, {
      sectionIndex: 0,
      blockIndex: 2,
    });
    const check = async (
      doc: import("../../src/model/types.js").DocDocument,
    ) => {
      const beforeBlocks = doc.sections.map((section) => section.blocks.length);
      const beforeParagraphs = orderedParagraphTexts(doc);
      const exported = await exportAny(doc, "docx");
      const back = await importAny(exported.buffer, "a.docx");
      expect(back.document.sections.length).toBe(doc.sections.length);
      expect(
        back.document.sections.map((section) => section.blocks.length),
      ).toEqual(beforeBlocks);
      expect(orderedParagraphTexts(back.document)).toEqual(beforeParagraphs);
    };
    // Table-ending section.
    await check(workspace.service.session(documentId).document);
    await workspace.service.closeDocument(documentId, {
      discardUnsaved: true,
    });

    // TOC-ending section.
    const tocDoc = await workspace.service.createDocument({
      paragraphs: ["first", "second"],
    });
    const tocBlocks = tocDoc.document.sections[0].blocks;
    workspace.service.insertToc(tocDoc.documentId, {
      afterBlockId: tocBlocks[1].id,
      minLevel: 1,
      maxLevel: 3,
    });
    workspace.service.insertSectionBreak(tocDoc.documentId, {
      sectionIndex: 0,
      blockIndex: 3,
    });
    await check(workspace.service.session(tocDoc.documentId).document);
    await workspace.service.closeDocument(tocDoc.documentId, {
      discardUnsaved: true,
    });

    // Empty section.
    const emptyDoc = await workspace.service.createDocument({
      paragraphs: ["only"],
    });
    workspace.service.insertSectionBreak(emptyDoc.documentId, {
      sectionIndex: 0,
      blockIndex: 0,
    });
    const emptySections = workspace.service
      .session(emptyDoc.documentId)
      .document.sections.map((section) => section.blocks.length);
    expect(emptySections[0]).toBe(0);
    await check(workspace.service.session(emptyDoc.documentId).document);
    await workspace.service.closeDocument(emptyDoc.documentId, {
      discardUnsaved: true,
    });
    await workspace.dispose();
  });
});
