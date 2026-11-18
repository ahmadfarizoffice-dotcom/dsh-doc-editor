import { describe, expect, it } from "vitest";
import { createDocument } from "../../src/model/create.js";
import { appendParagraph, insertTable } from "../../src/model/edit.js";
import { documentText } from "../../src/model/text.js";
import type { Paragraph } from "../../src/model/types.js";
import { exportText, importText, textAdapter } from "../../src/formats/text.js";

describe("plain text import", () => {
  it("maps lines to paragraphs, keeps blank lines and splits on form feeds", async () => {
    const result = await importText(
      Buffer.from("first\n\nthird\fpage two", "utf8"),
      { fileName: "notes.txt" },
    );
    const blocks = result.document.sections[0].blocks;
    expect(blocks).toHaveLength(5);
    expect(documentText(result.document)).toContain("first");
    expect(documentText(result.document)).toContain("page two");
    const pageBreak = blocks.find(
      (block): block is Paragraph =>
        block.type === "paragraph" &&
        block.inlines.some(
          (inline) => inline.type === "break" && inline.kind === "page",
        ),
    );
    expect(pageBreak).toBeDefined();
    expect(result.document.metadata.title).toBe("notes");
    expect(result.losses).toHaveLength(0);
    expect(result.document.compatibility?.transparent).toBe(true);
  });

  it("strips a UTF-8 BOM and normalises CRLF line endings", async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("one\r\ntwo\r\n", "utf8"),
    ]);
    const result = await importText(bytes);
    expect(documentText(result.document).trim()).toBe("one\ntwo");
  });

  it("refuses inputs above maxBytes with a typed error", async () => {
    await expect(
      importText(Buffer.from("0123456789"), { maxBytes: 4 }),
    ).rejects.toMatchObject({
      code: "FORMAT_TOO_LARGE",
    });
  });
});

describe("plain text export", () => {
  it("round-trips imported text exactly", async () => {
    const source = "alpha\n\nbeta gamma\ndelta";
    const imported = await importText(Buffer.from(source, "utf8"), {
      fileName: "round.txt",
    });
    const exported = await exportText(imported.document);
    expect(exported.buffer.toString("utf8")).toBe(source);
  });

  it("writes form feeds for page breaks and tabs between table cells", async () => {
    const doc = createDocument({ title: "Text export" });
    const first = doc.sections[0].blocks[0];
    if (first.type === "paragraph")
      first.inlines = [{ type: "text", text: "page one", props: {} }];
    const second = appendParagraph(doc, "after break");
    second.inlines.unshift({ type: "break", kind: "page" });
    insertTable(doc, second.id, {
      rows: 2,
      columns: 2,
      data: [
        ["A", "B"],
        ["C", "D"],
      ],
    });
    const exported = await exportText(doc);
    const text = exported.buffer.toString("utf8");
    expect(text).toContain("page one");
    expect(text).toContain("\f");
    expect(text).toContain("A\tB");
    const features = exported.losses.map((loss) => loss.feature);
    expect(features).toContain("table.layout");
  });
});

describe("plain text detection", () => {
  it("claims printable text and rejects binary input", () => {
    expect(
      textAdapter.detect(Buffer.from("hello world\n", "utf8"), "x.txt"),
    ).toBe(true);
    expect(
      textAdapter.detect(Buffer.from([0x00, 0x01, 0x02, 0x03]), undefined),
    ).toBe(false);
  });
});
