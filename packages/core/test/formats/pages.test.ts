import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { createDocument } from "../../src/model/create.js";
import { documentText, paragraphTexts } from "../../src/model/text.js";
import type { DocDocument } from "../../src/model/types.js";
import {
  importPages,
  pagesAdapter,
  snappyDecompress,
} from "../../src/formats/pages.js";
import {
  FORMAT_EXTERNAL_REQUIRED,
  gdocAdapter,
  importGdoc,
  parseGdocPointer,
} from "../../src/formats/gdoc.js";
import {
  availableFormats,
  detectFormat,
  exportAny,
  exportableFormats,
  importableFormats,
  importAny,
  listAdapters,
} from "../../src/formats/index.js";

/* --------------------------------------------------------------- helpers */

/** Minimal unsigned LEB128 encoder used by the protobuf fixtures. */
function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

/** Length-delimited protobuf field (`wire type 2`). */
function protobufField(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([
    varint(fieldNumber * 8 + 2),
    varint(payload.length),
    payload,
  ]);
}

function protobufString(fieldNumber: number, text: string): Buffer {
  return protobufField(fieldNumber, Buffer.from(text, "utf8"));
}

/**
 * Literal-only Snappy block encoder: varint uncompressed length, then one
 * literal tag per at-most-60-byte chunk. This is a valid (if unoptimised)
 * Snappy block and exercises the importer's literal path.
 */
function snappyLiteralBlock(payload: Buffer): Buffer {
  const parts: Buffer[] = [varint(payload.length)];
  let offset = 0;
  while (offset < payload.length) {
    const length = Math.min(60, payload.length - offset);
    parts.push(Buffer.from([(length - 1) << 2]));
    parts.push(payload.subarray(offset, offset + length));
    offset += length;
  }
  return Buffer.concat(parts);
}

/** Wraps one payload in the 4-byte IWA frame header. */
function iwaFrame(payload: Buffer, compressed: boolean): Buffer {
  const body = compressed ? snappyLiteralBlock(payload) : payload;
  const header = Buffer.alloc(4);
  header[0] = compressed ? 0x00 : 0x01;
  header.writeUIntLE(body.length, 1, 3);
  return Buffer.concat([header, body]);
}

function paragraphList(doc: DocDocument): string[] {
  return paragraphTexts(doc).map((entry) => entry.text);
}

function blockAt(doc: DocDocument, index: number) {
  return doc.sections[0].blocks[index];
}

/* ----------------------------------------------------- modern Pages fixture */

/**
 * Modern Pages (2013+) package: `Index/Document.iwa` with one uncompressed
 * frame and one Snappy-compressed frame carrying protobuf fields, plus the
 * Metadata directory and preview image a real package has.
 */
async function buildModernPagesPackage(): Promise<Buffer> {
  const uncompressedFrame = Buffer.concat([
    // Metadata token: must be filtered out of the recovered text.
    protobufString(3, "com.apple.iWork.Pages"),
    protobufString(1, "Quarterly report"),
    protobufString(2, "Revenue grew by 12% in Q3."),
  ]);
  const compressedFrame = Buffer.concat([
    // A nested message (depth 2) whose payload is one prose string.
    protobufField(4, protobufString(1, "Highlights")),
    protobufString(5, "Intro line\nSecond line"),
    // Two adjacent identical strings: the second is a repeated stored run.
    protobufString(6, "Repeated line"),
    protobufString(7, "Repeated line"),
    // Style token and a non-UTF-8-ish control payload: both rejected.
    protobufString(8, "TSStyleDefault"),
    protobufField(9, Buffer.from([0x00, 0x01, 0x41, 0x42])),
  ]);

  const zip = new JSZip();
  zip.file(
    "Index/Document.iwa",
    Buffer.concat([
      iwaFrame(uncompressedFrame, false),
      iwaFrame(compressedFrame, true),
    ]),
  );
  zip.file(
    "Metadata/Metadata.plist",
    `<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>title</key><string>Report</string></dict></plist>`,
  );
  zip.file("preview.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  return zip.generateAsync({ type: "nodebuffer" });
}

/* --------------------------------------------------- Pages '09 XML fixture */

const PAGES09_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sf:document xmlns:sf="http://developer.apple.com/namespaces/sf">
  <sf:stylesheet>
    <sf:style sf:id="style-3" sf:name="Heading 2"/>
    <sf:style sf:id="style-4"><sf:name>Body</sf:name></sf:style>
  </sf:stylesheet>
  <sf:body>
    <sf:section>
      <sf:text>
        <sf:p>Quarterly report</sf:p>
        <sf:p/>
        <sf:p><sf:span>Revenue grew </sf:span><sf:span>by 12%</sf:span><sf:span> in Q3.</sf:span></sf:p>
        <sf:p sf:style="style-3">Highlights</sf:p>
        <sf:p sf:outline-level="0">Overview</sf:p>
        <sf:p>Line one<sf:br/>Line two</sf:p>
        <sf:table sf:id="t1"><sf:grid/></sf:table>
        <sf:drawable sf:id="d1"/>
      </sf:text>
    </sf:section>
  </sf:body>
</sf:document>`;

/** Pages '09 package: a root index.xml with paragraphs and non-text objects. */
async function buildPages09Package(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("index.xml", PAGES09_XML);
  zip.file("Metadata/DocumentProperties.plist", "<plist><dict/></plist>");
  return zip.generateAsync({ type: "nodebuffer" });
}

/* --------------------------------------------------------------- fixtures */

describe("Apple Pages import: modern IWA text recovery", () => {
  it("decompresses uncompressed and Snappy frames and recovers prose in order", async () => {
    const bytes = await buildModernPagesPackage();
    const result = await importPages(bytes, { fileName: "report.pages" });
    const doc = result.document;

    expect(doc.metadata.custom.DSHPreview).toBe("true");
    expect(doc.compatibility?.sourceFormat).toBe("pages");
    expect(doc.compatibility?.transparent).toBe(false);
    expect(paragraphList(doc)).toEqual([
      "Quarterly report",
      "Revenue grew by 12% in Q3.",
      "Highlights",
      "Intro line",
      "Second line",
      "Repeated line",
    ]);

    // Metadata tokens and control-byte payloads never become paragraphs.
    const text = documentText(doc);
    expect(text).not.toContain("com.apple");
    expect(text).not.toContain("TSStyle");

    const features = result.losses.map((loss) => loss.feature);
    expect(features).toContain("pages.structure");
    expect(features).toContain("pages.styles");
    expect(features).toContain("pages.tables");
    expect(features).toContain("pages.images");
    expect(features).toContain("pages.layout");
    expect(
      result.losses.find((loss) => loss.feature === "pages.structure")?.reason,
    ).toMatch(/not reconstructed/);
    expect(
      result.document.compatibility?.features.some(
        (feature) =>
          feature.feature === "pages.iwaFrame" && feature.occurrences === 2,
      ),
    ).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("decodes literal and 1/2/4-byte-offset Snappy copies", () => {
    const literalOnly = Buffer.from("Quarterly");
    expect(
      snappyDecompress(snappyLiteralBlock(literalOnly)).toString("utf8"),
    ).toBe("Quarterly");

    // 1-byte offset, overlapping copy: "abc" + copy(9, offset 3).
    const copied1 = Buffer.concat([
      Buffer.from([0x0c, 0x08]),
      Buffer.from("abc", "latin1"),
      Buffer.from([0x15, 0x03]),
    ]);
    expect(snappyDecompress(copied1).toString("utf8")).toBe("abcabcabcabc");

    // 2-byte offset copy: "abcd" + copy(8, offset 4).
    const copied2 = Buffer.concat([
      Buffer.from([0x0c, 0x0c]),
      Buffer.from("abcd", "latin1"),
      Buffer.from([0x1e, 0x04, 0x00]),
    ]);
    expect(snappyDecompress(copied2).toString("utf8")).toBe("abcdabcdabcd");

    // 4-byte offset copy: "abcdef" + copy(6, offset 6).
    const copied4 = Buffer.concat([
      Buffer.from([0x0c, 0x14]),
      Buffer.from("abcdef", "latin1"),
      Buffer.from([0x17, 0x06, 0x00, 0x00, 0x00]),
    ]);
    expect(snappyDecompress(copied4).toString("utf8")).toBe("abcdefabcdef");
  });

  it("rejects truncated or invalid Snappy blocks instead of allocating garbage", () => {
    expect(() => snappyDecompress(Buffer.from([0x05, 0x00]))).toThrow();
    // Copy offset 5 with nothing written yet.
    expect(() => snappyDecompress(Buffer.from([0x04, 0x01, 0x05]))).toThrow();
    expect(() => snappyDecompress(Buffer.from([]))).toThrow();
    // Declared length 5 but only 3 literal bytes present.
    expect(() =>
      snappyDecompress(
        Buffer.concat([Buffer.from([0x05, 0x08]), Buffer.from("abc")]),
      ),
    ).toThrow();
  });

  it("detects the modern package by content without a file name", async () => {
    const bytes = await buildModernPagesPackage();
    expect(pagesAdapter.detect(bytes)).toBe(true);
    const detected = detectFormat(bytes);
    expect(detected?.id).toBe("pages");

    const imported = await importAny(bytes, "report.pages");
    expect(imported.format).toBe("pages");
    expect(imported.readOnly).toBe(true);
    expect(imported.document.metadata.custom.DSHPreview).toBe("true");
  });
});

describe("Apple Pages import: Pages '09 XML package", () => {
  it("maps paragraphs, empty paragraphs, spans, line breaks and headings", async () => {
    const bytes = await buildPages09Package();
    const result = await importPages(bytes, { fileName: "report.pages" });
    const doc = result.document;

    expect(paragraphList(doc)).toEqual([
      "Quarterly report",
      "",
      "Revenue grew by 12% in Q3.",
      "Highlights",
      "Overview",
      "Line one\nLine two",
    ]);
    expect(documentText(doc)).toContain("Line one\nLine two");

    const highlights = blockAt(doc, 3);
    expect(highlights.type).toBe("paragraph");
    if (highlights.type === "paragraph") {
      expect(highlights.style).toBe("Heading2");
    }
    const overview = blockAt(doc, 4);
    expect(overview.type).toBe("paragraph");
    if (overview.type === "paragraph") {
      expect(overview.style).toBe("Heading1");
    }

    // The preview marker belongs to modern packages only.
    expect(doc.metadata.custom.DSHPreview).toBeUndefined();
    expect(doc.compatibility?.transparent).toBe(false);
    const features = result.losses.map((loss) => loss.feature);
    expect(features).toContain("pages09.characterFormatting");
    expect(features).toContain("pages09.pageLayout");
    expect(features).toContain("pages09.heading");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("reports unknown structural elements instead of dropping them", async () => {
    const bytes = await buildPages09Package();
    const result = await importPages(bytes, { fileName: "report.pages" });
    const doc = result.document;

    const unknown = doc.compatibility?.unknownElements ?? [];
    const names = unknown.map((entry) => entry.element);
    expect(names).toContain("sf:table");
    expect(names).toContain("sf:grid");
    expect(names).toContain("sf:drawable");
    expect(doc.unknown.length).toBeGreaterThanOrEqual(3);
    expect(
      result.losses.some((loss) => loss.feature === "pages09.unknownElement"),
    ).toBe(true);
    expect(
      result.losses.some(
        (loss) =>
          loss.feature === "pages09.unknownElement" &&
          loss.location === "index.xml:sf:table",
      ),
    ).toBe(true);
  });

  it("detects the Pages '09 container by content and imports through the registry", async () => {
    const bytes = await buildPages09Package();
    expect(pagesAdapter.detect(bytes)).toBe(true);
    expect(detectFormat(bytes)?.id).toBe("pages");

    const imported = await importAny(bytes, "report.pages");
    expect(imported.format).toBe("pages");
    expect(paragraphList(imported.document)[0]).toBe("Quarterly report");
  });
});

describe("Apple Pages import: malformed and unsupported containers", () => {
  it("rejects a non-ZIP buffer with a typed error and without hanging", async () => {
    const started = Date.now();
    await expect(
      importPages(Buffer.from("this is not a pages package", "utf8")),
    ).rejects.toMatchObject({ code: "FORMAT_INVALID_INPUT" });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects a ZIP without index.xml or Index/*.iwa", async () => {
    const zip = new JSZip();
    zip.file("random.txt", "nothing to import");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    expect(pagesAdapter.detect(bytes)).toBe(false);
    await expect(importPages(bytes)).rejects.toMatchObject({
      code: "FORMAT_UNSUPPORTED_CONTAINER",
    });
  });

  it("rejects index.xml that is not a Pages '09 document", async () => {
    const zip = new JSZip();
    zip.file("index.xml", "<root><p>not pages</p></root>");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await expect(importPages(bytes)).rejects.toMatchObject({
      code: "FORMAT_UNSUPPORTED_CONTAINER",
    });
  });

  it("refuses index.xml that declares external entities", async () => {
    const zip = new JSZip();
    zip.file(
      "index.xml",
      `<?xml version="1.0"?><!DOCTYPE doc [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><sf:document xmlns:sf="http://developer.apple.com/namespaces/sf"><sf:p>&xxe;</sf:p></sf:document>`,
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    await expect(importPages(bytes)).rejects.toMatchObject({
      code: "FORMAT_UNSUPPORTED_CONTAINER",
    });
  });

  it("does not throw from detect for non-container input", () => {
    expect(() =>
      pagesAdapter.detect(Buffer.from("not a zip"), "notes.pages"),
    ).not.toThrow();
    // The extension claim matches the other container adapters.
    expect(pagesAdapter.detect(Buffer.from("not a zip"), "notes.pages")).toBe(
      true,
    );
    expect(pagesAdapter.detect(Buffer.from("not a zip"))).toBe(false);
    expect(pagesAdapter.readOnly).toBe(true);
    expect(pagesAdapter.capabilities.canExport).toBe(false);
  });
});

describe("Google Docs pointer (.gdoc)", () => {
  const pointer = Buffer.from(
    JSON.stringify({
      doc_id: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
      resource_id: "document:1AbCdEfGhIjKlMnOpQrStUvWxYz",
      email: "person@example.com",
    }),
    "utf8",
  );

  it("parses the pointer and fails with FORMAT_EXTERNAL_REQUIRED and an actionable message", async () => {
    expect(parseGdocPointer(pointer)).toEqual({
      docId: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
      resourceId: "document:1AbCdEfGhIjKlMnOpQrStUvWxYz",
      email: "person@example.com",
    });
    expect(FORMAT_EXTERNAL_REQUIRED).toBe("FORMAT_EXTERNAL_REQUIRED");

    await expect(
      importGdoc(pointer, { fileName: "plan.gdoc" }),
    ).rejects.toMatchObject({
      code: "FORMAT_EXTERNAL_REQUIRED",
    });
    try {
      await importGdoc(pointer, { fileName: "plan.gdoc" });
      throw new Error("expected importGdoc to reject");
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      expect(typed.code).toBe("FORMAT_EXTERNAL_REQUIRED");
      expect(typed.message).toMatch(/Google Docs link/);
      expect(typed.message).toMatch(/\.docx/);
      expect(typed.message).toMatch(/OAuth|Drive/);
    }
  });

  it("detects the pointer by shape and rejects other JSON", async () => {
    expect(gdocAdapter.detect(pointer)).toBe(true);
    expect(detectFormat(pointer)?.id).toBe("gdoc");
    await expect(importAny(pointer, "plan.gdoc")).rejects.toMatchObject({
      code: "FORMAT_EXTERNAL_REQUIRED",
    });

    const random = Buffer.from('{"hello":"world"}', "utf8");
    expect(gdocAdapter.detect(random)).toBe(false);
    expect(parseGdocPointer(random)).toBeUndefined();
    expect(gdocAdapter.detect(Buffer.from("not json at all"))).toBe(false);
    expect(gdocAdapter.detect(Buffer.from('{"doc_id":"x"}', "utf8"))).toBe(
      false,
    );

    await expect(importGdoc(random)).rejects.toMatchObject({
      code: "FORMAT_INVALID_INPUT",
    });
  });

  it("is read-only and refuses export", async () => {
    expect(gdocAdapter.readOnly).toBe(true);
    expect(gdocAdapter.capabilities.canImport).toBe(true);
    expect(gdocAdapter.capabilities.canExport).toBe(false);
    expect(gdocAdapter.export).toBeUndefined();
  });
});

describe("format registry: Pages and Google Docs pointer", () => {
  it("lists both adapters deterministically with import-only capabilities", () => {
    const ids = listAdapters().map((adapter) => adapter.id);
    expect(ids).toContain("pages");
    expect(ids).toContain("gdoc");
    expect(ids.indexOf("pages")).toBeLessThan(ids.indexOf("gdoc"));
    expect(ids.indexOf("gdoc")).toBeLessThan(ids.indexOf("text"));

    const rows = availableFormats();
    const pages = rows.find((row) => row.id === "pages");
    expect(pages).toBeDefined();
    expect(pages?.readOnly).toBe(true);
    expect(pages?.canImport).toBe(true);
    expect(pages?.canExport).toBe(false);
    expect(pages?.extensions).toEqual(["pages"]);
    expect(pages?.capabilities.notes?.join(" ")).toMatch(
      /text-recovery preview/,
    );

    const gdoc = rows.find((row) => row.id === "gdoc");
    expect(gdoc).toBeDefined();
    expect(gdoc?.readOnly).toBe(true);
    expect(gdoc?.canImport).toBe(true);
    expect(gdoc?.canExport).toBe(false);
    expect(gdoc?.extensions).toEqual(["gdoc"]);
    expect(gdoc?.capabilities.notes?.join(" ")).toMatch(
      /FORMAT_EXTERNAL_REQUIRED/,
    );

    expect(importableFormats()).toContain("pages");
    expect(importableFormats()).toContain("gdoc");
    expect(exportableFormats()).not.toContain("pages");
    expect(exportableFormats()).not.toContain("gdoc");
  });

  it("reports export as unsupported instead of producing DOCX", async () => {
    const doc = createDocument({ title: "Export target" });
    await expect(exportAny(doc, "pages")).rejects.toMatchObject({
      code: "FORMAT_EXPORT_UNSUPPORTED",
    });
    await expect(exportAny(doc, "gdoc")).rejects.toMatchObject({
      code: "FORMAT_EXPORT_UNSUPPORTED",
    });
  });
});
