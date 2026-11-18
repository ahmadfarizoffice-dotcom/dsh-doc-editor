import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { createDocument } from "../../src/model/create.js";
import { applyHyperlink, appendParagraph, insertImage, insertTable } from "../../src/model/edit.js";
import { documentText } from "../../src/model/text.js";
import type { DocDocument, Paragraph, Table } from "../../src/model/types.js";
import { importOdt, exportOdt } from "../../src/formats/odt.js";
import { readPackage } from "../../src/docx/package.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const MIMETYPE = "application/vnd.oasis.opendocument.text";

function buildDocument(): DocDocument {
  const doc = createDocument({ title: "ODT sample", author: "Ada" });
  // `createDocument` always creates one empty paragraph; reuse it as the title.
  const first = doc.sections[0].blocks[0];
  if (first.type === "paragraph") {
    first.style = "Heading1";
    first.inlines = [{ type: "text", text: "ODT heading", props: {} }];
    first.props = { outlineLevel: 0 };
  }
  const body = appendParagraph(doc, "Body with a link.");
  applyHyperlink(
    doc,
    {
      start: { blockId: body.id, inlineIndex: 0, offset: 0 },
      end: { blockId: body.id, inlineIndex: 0, offset: 4 },
    },
    { href: "https://example.com/odt" },
  );
  insertTable(doc, body.id, {
    rows: 2,
    columns: 2,
    data: [
      ["A", "B"],
      ["C", "D"],
    ],
    headerRow: true,
  });
  const last = appendParagraph(doc, "");
  insertImage(doc, { blockId: last.id, inlineIndex: 0, offset: 0 }, {
    data: Buffer.from(PNG_1X1, "base64"),
    contentType: "image/png",
    width: 48,
    height: 48,
    alt: "dot",
    naturalWidthPx: 1,
    naturalHeightPx: 1,
  });
  doc.footnotes.push({
    id: "fn1",
    type: "footnote",
    blocks: [{ type: "paragraph", id: "pf1", style: "Normal", props: {}, inlines: [{ type: "text", text: "Footnote text.", props: {} }] }],
  });
  if (body.type === "paragraph") body.inlines.push({ type: "noteRef", noteId: "fn1", noteType: "footnote" });
  return doc;
}

describe("ODT export", () => {
  it("writes a valid package with a stored mimetype as the first entry", async () => {
    const doc = buildDocument();
    const exported = await exportOdt(doc);
    const buffer = exported.buffer;
    expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");

    // Local file header: compression method 0 (STORE), name "mimetype".
    expect(buffer.readUInt16LE(8)).toBe(0);
    const nameLength = buffer.readUInt16LE(26);
    const extraLength = buffer.readUInt16LE(28);
    const name = buffer.subarray(30, 30 + nameLength).toString("latin1");
    expect(name).toBe("mimetype");
    const content = buffer.subarray(30 + nameLength + extraLength, 30 + nameLength + extraLength + MIMETYPE.length).toString("utf8");
    expect(content).toBe(MIMETYPE);

    const pkg = await readPackage(buffer);
    expect(pkg.isEncrypted).toBe(false);
    expect([...pkg.parts.keys()][0]).toBe("mimetype");
    for (const part of ["content.xml", "styles.xml", "meta.xml", "META-INF/manifest.xml"]) {
      expect(pkg.parts.has(part)).toBe(true);
    }
    expect(pkg.parts.get("mimetype")?.toString("utf8")).toBe(MIMETYPE);
    expect(pkg.parts.get("content.xml")?.toString("utf8")).toContain("office:document-content");
    expect(pkg.parts.get("content.xml")?.toString("utf8")).toContain("<text:h");
    expect(pkg.parts.get("content.xml")?.toString("utf8")).toContain("<table:table");
    expect(pkg.parts.get("content.xml")?.toString("utf8")).toContain("<text:a");
    expect(pkg.parts.get("content.xml")?.toString("utf8")).toContain("draw:image");
    expect(pkg.parts.get("meta.xml")?.toString("utf8")).toContain("ODT sample");
    expect([...pkg.parts.keys()].some((path) => path.startsWith("Pictures/"))).toBe(true);

    // The archive must be readable by a generic ZIP reader too.
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file("content.xml")).not.toBeNull();
  });
});

describe("ODT import", () => {
  it("round-trips text, headings, tables, hyperlinks, images and footnotes", async () => {
    const doc = buildDocument();
    const exported = await exportOdt(doc, { preserveTimestamps: true });
    const imported = await importOdt(exported.buffer, { fileName: "sample.odt" });
    const round = imported.document;

    expect(round.metadata.title).toBe("ODT sample");
    expect(round.metadata.creator).toBe("Ada");
    expect(documentText(round).trim()).toBe(documentText(doc).trim());

    const heading = round.sections[0].blocks[0];
    expect(heading.type).toBe("paragraph");
    if (heading.type === "paragraph") {
      expect(heading.style).toBe("Heading1");
      expect(documentText(round)).toContain("ODT heading");
    }

    const table = round.sections[0].blocks.find((block): block is Table => block.type === "table");
    expect(table).toBeDefined();
    expect(table?.rows.length).toBe(2);
    expect(table?.rows[0].cells.length).toBe(2);
    expect(table?.rows[0].props.isHeader).toBe(true);
    expect(table?.grid.length).toBe(2);
    expect(Math.round(table?.grid[0] ?? 0)).toBeGreaterThan(10);

    const link = round.sections[0].blocks
      .flatMap((block) => (block.type === "paragraph" ? block.inlines : []))
      .find((inline) => inline.type === "text" && inline.props.hyperlink?.href === "https://example.com/odt");
    expect(link).toBeDefined();

    expect(round.media.length).toBe(1);
    expect(round.media[0].contentType).toBe("image/png");
    expect(round.footnotes.length).toBe(1);
    expect(documentText(round)).toContain("Footnote text.");
    expect(imported.losses.some((loss) => loss.level === "unsupported")).toBe(false);
  });

  it("imports an externally produced minimal ODT", async () => {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2">
  <office:body><office:text>
    <text:h text:outline-level="2">Second level</text:h>
    <text:p>Hello <text:a xlink:href="https://example.org">world</text:a></text:p>
    <text:list><text:list-item><text:p>bullet one</text:p></text:list-item><text:list-item><text:p>bullet two</text:p></text:list-item></text:list>
    <table:table table:name="T"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell><text:p>1</text:p></table:table-cell><table:table-cell><text:p>2</text:p></table:table-cell></table:table-row></table:table>
  </office:text></office:body>
</office:document-content>`;
    const zip = new JSZip();
    zip.file("mimetype", MIMETYPE, { compression: "STORE" });
    zip.file("content.xml", content);
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const result = await importOdt(buffer, { fileName: "external.odt" });
    const text = documentText(result.document);
    expect(text).toContain("Second level");
    expect(text).toContain("Hello world");
    expect(text).toContain("bullet one");
    expect(text).toContain("bullet two");
    const h2 = result.document.sections[0].blocks[0];
    if (h2.type === "paragraph") {
      expect(h2.style).toBe("Heading2");
    }
    const listItems = result.document.sections[0].blocks.filter(
      (block): block is Paragraph => block.type === "paragraph" && Boolean(block.props.numbering),
    );
    expect(listItems.length).toBe(2);
    const table = result.document.sections[0].blocks.find((block): block is Table => block.type === "table");
    expect(table?.rows[0].cells.length).toBe(2);
    const link = result.document.sections[0].blocks
      .flatMap((block) => (block.type === "paragraph" ? block.inlines : []))
      .find((inline) => inline.type === "text" && inline.props.hyperlink?.href === "https://example.org");
    expect(link).toBeDefined();
    expect(result.document.compatibility?.sourceFormat).toBe("odt");
  });

  it("rejects a package without content.xml with a typed error", async () => {
    const zip = new JSZip();
    zip.file("mimetype", MIMETYPE, { compression: "STORE" });
    const buffer = await zip.generateAsync({ type: "nodebuffer" });
    await expect(importOdt(buffer, { fileName: "broken.odt" })).rejects.toMatchObject({
      code: "FORMAT_INVALID_INPUT",
    });
  });
});
