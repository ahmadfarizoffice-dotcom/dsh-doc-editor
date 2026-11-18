import { describe, expect, it } from "vitest";
import { documentText } from "../../src/model/text.js";
import { createDocumentContext } from "../../src/formats/shared.js";
import {
  importLegacyDoc,
  inspectLegacyDoc,
  paragraphsFromLegacyText,
  readCompoundFile,
} from "../../src/formats/legacy-doc.js";
import {
  buildCompoundFile,
  buildLegacyDocFile,
  buildMiniCompoundFile,
  buildWordDocumentStream,
} from "./fixtures.js";

describe("compound file reader", () => {
  it("reads directory entries and streams from regular FAT sectors", () => {
    const stream = buildWordDocumentStream();
    const file = buildCompoundFile([{ name: "WordDocument", data: stream }]);
    const compound = readCompoundFile(file);
    expect(compound.streamNames()).toContain("WordDocument");
    expect(compound.sectorSize).toBe(512);
    const read = compound.readStream("WordDocument");
    expect(read).toBeDefined();
    expect(read?.length).toBe(stream.length);
    expect(read?.equals(stream)).toBe(true);
    expect(compound.readStream("Missing")).toBeUndefined();
  });

  it("reads small streams from the mini FAT and mini stream", () => {
    const payload = Buffer.from("hello mini stream", "utf8");
    const file = buildMiniCompoundFile("Small", payload);
    const compound = readCompoundFile(file);
    expect(compound.miniSectorSize).toBe(64);
    const read = compound.readStream("Small");
    expect(read).toBeDefined();
    expect(read?.toString("utf8")).toBe("hello mini stream");
    expect(read?.length).toBe(payload.length);
  });

  it("rejects a buffer that is not a compound file with a typed error", () => {
    expect(() =>
      readCompoundFile(Buffer.from("this is not a compound file at all")),
    ).toThrowError(/compound file/i);
    try {
      readCompoundFile(Buffer.from("not a cfb"));
    } catch (error) {
      expect(error).toMatchObject({ code: "FORMAT_INVALID_INPUT" });
    }
  });
});

describe("legacy text projection", () => {
  it("splits paragraphs on CR, lines on VT and inserts page-break paragraphs", () => {
    const ctx = createDocumentContext();
    const result = paragraphsFromLegacyText(
      ctx,
      "first\rsecond\vline\r\fthird",
    );
    // first, second(+\nline), then a page-break paragraph, then third.
    expect(result.count).toBe(3);
    expect(result.pageBreaks).toBe(1);
    const blocks = ctx.blocks;
    expect(
      blocks.some(
        (block) =>
          block.type === "paragraph" &&
          block.inlines.some(
            (inline) => inline.type === "break" && inline.kind === "page",
          ),
      ),
    ).toBe(true);
    expect(documentText(ctx.doc)).toContain("second\nline");
    expect(documentText(ctx.doc)).toContain("third");
  });
});

describe("legacy .doc import", () => {
  it("extracts both compressed and UTF-16LE pieces through the FIB and CLX", async () => {
    const file = buildLegacyDocFile();
    const inspection = inspectLegacyDoc(file);
    expect(inspection.fib.hasClx).toBe(true);
    expect(inspection.fib.complex).toBe(true);
    expect(inspection.streams).toContain("WordDocument");
    expect(inspection.textLength).toBe(19);

    const result = await importLegacyDoc(file, { fileName: "legacy.doc" });
    expect(documentText(result.document).trim()).toBe("Hello legacy world");
    expect(result.document.compatibility?.sourceFormat).toBe("legacy-doc");
    const features = result.losses.map((loss) => loss.feature);
    expect(features).toContain("character.formatting");
    expect(features).toContain("headerFooter");
    expect(features).toContain("metadata");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects a compound file without a WordDocument stream", async () => {
    const file = buildCompoundFile([
      { name: "SomethingElse", data: Buffer.from("payload") },
    ]);
    await expect(
      importLegacyDoc(file, { fileName: "other.doc" }),
    ).rejects.toMatchObject({
      code: "FORMAT_INVALID_INPUT",
    });
  });

  it("refuses an encrypted document instead of producing garbage", async () => {
    const stream = buildWordDocumentStream();
    stream.writeUInt16LE(0x0104, 10); // fEncrypted | fComplex
    const file = buildCompoundFile([{ name: "WordDocument", data: stream }]);
    await expect(
      importLegacyDoc(file, { fileName: "secret.doc" }),
    ).rejects.toMatchObject({
      code: "FORMAT_UNSUPPORTED_CONTAINER",
    });
  });

  it("rejects a non-compound buffer quickly with a clear error", async () => {
    const started = Date.now();
    await expect(
      importLegacyDoc(Buffer.from("plain text, not a .doc")),
    ).rejects.toMatchObject({
      code: "FORMAT_INVALID_INPUT",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
