import { describe, expect, it } from "vitest";
import { documentText } from "../../src/model/text.js";
import type {
  Block,
  DocDocument,
  Paragraph,
  Table,
} from "../../src/model/types.js";
import { exportRtf, importRtf } from "../../src/formats/rtf.js";

const SAMPLE_RTF = String.raw`{\rtf1\ansi\ansicpg1252\deff0\uc1
{\fonttbl{\f0\froman\fcharset0 Times New Roman;}{\f1\fswiss\fcharset0 Arial;}}
{\colortbl;\red255\green0\blue0;\red0\green0\blue255;}
{\info{\title RTF sample}{\author Grace Hopper}{\subject Unit test}}
\pard\qc\b Bold title\b0\par
\pard\ql Normal \i italic\i0 and \ul underlined\ulnone and \strike struck\strike0.\par
\pard\qr Right aligned\par
\pard\li720\fi-360 Indented item\par
\pard\f1\fs28\cf1 Red Arial text\cf0\fs24\f0\par
Unicode: \u8364?euro and \u1046?char.\par
{\field{\*\fldinst HYPERLINK "https://example.com/rtf"}{\fldrslt click here}}\par
\trowd\cellx2000\cellx4000
Cell A\cell Cell B\cell\row
}`;

function blocks(doc: DocDocument): Block[] {
  return doc.sections[0].blocks;
}

function paragraphs(doc: DocDocument): Paragraph[] {
  return blocks(doc).filter(
    (block): block is Paragraph => block.type === "paragraph",
  );
}

describe("RTF import", () => {
  it("parses groups, formatting, alignment, indents, colours, unicode and links", async () => {
    const result = await importRtf(Buffer.from(SAMPLE_RTF, "latin1"), {
      fileName: "sample.rtf",
    });
    const doc = result.document;
    expect(doc.metadata.title).toBe("RTF sample");
    expect(doc.metadata.creator).toBe("Grace Hopper");
    expect(doc.metadata.subject).toBe("Unit test");

    const title = paragraphs(doc)[0];
    expect(title.props.alignment).toBe("center");
    expect(documentText(doc)).toContain("Bold title");
    const boldRun = title.inlines.find(
      (inline) => inline.type === "text" && inline.text.includes("Bold title"),
    );
    expect(
      boldRun && boldRun.type === "text" ? boldRun.props.bold : undefined,
    ).toBe(true);

    const normal = paragraphs(doc)[1];
    const italic = normal.inlines.find(
      (inline) => inline.type === "text" && inline.text === "italic",
    );
    expect(
      italic && italic.type === "text" ? italic.props.italic : undefined,
    ).toBe(true);
    const underlined = normal.inlines.find(
      (inline) => inline.type === "text" && inline.text === "underlined",
    );
    expect(
      underlined && underlined.type === "text"
        ? underlined.props.underline
        : undefined,
    ).toBe("single");
    const struck = normal.inlines.find(
      (inline) => inline.type === "text" && inline.text === "struck",
    );
    expect(
      struck && struck.type === "text" ? struck.props.strike : undefined,
    ).toBe(true);

    const right = paragraphs(doc)[2];
    expect(right.props.alignment).toBe("right");

    const indented = paragraphs(doc)[3];
    expect(Math.round(indented.props.indent?.left ?? 0)).toBe(36);
    expect(Math.round(indented.props.indent?.hanging ?? 0)).toBe(18);

    const coloured = paragraphs(doc)[4];
    const colouredRun = coloured.inlines.find(
      (inline) => inline.type === "text" && inline.text.includes("Red Arial"),
    );
    if (colouredRun && colouredRun.type === "text") {
      expect(colouredRun.props.color).toBe("#ff0000");
      expect(colouredRun.props.fontFamily).toBe("Arial");
      expect(colouredRun.props.fontSize).toBe(14);
    } else {
      throw new Error("coloured run not found");
    }

    const text = documentText(doc);
    expect(text).toContain("\u20AC");
    expect(text).toContain("\u0416");

    const linkRun = paragraphs(doc)
      .flatMap((paragraph) => paragraph.inlines)
      .find(
        (inline) =>
          inline.type === "text" &&
          inline.props.hyperlink?.href === "https://example.com/rtf",
      );
    expect(linkRun).toBeDefined();
    expect(documentText(doc)).toContain("click here");

    const table = blocks(doc).find(
      (block): block is Table => block.type === "table",
    );
    expect(table).toBeDefined();
    expect(table?.rows[0].cells).toHaveLength(2);
    expect(table?.grid[0]).toBeGreaterThan(0);
    expect(documentText(doc)).toContain("Cell A");
    expect(documentText(doc)).toContain("Cell B");

    expect(result.losses.some((loss) => loss.feature.startsWith("rtf."))).toBe(
      false,
    );
  });

  it("skips unknown destinations and reports them as losses without throwing", async () => {
    const rtf = String.raw`{\rtf1\ansi{\*\generator Test;}{\pict\pngblip 89504e47}{\header header text}\pard Hello\par}`;
    const result = await importRtf(Buffer.from(rtf, "latin1"));
    expect(documentText(result.document)).toContain("Hello");
    const features = result.losses.map((loss) => loss.feature);
    expect(features).toContain("rtf.pict");
    expect(features).toContain("rtf.header");
    expect(features).toContain("rtf.generator");
  });
});

describe("RTF export", () => {
  it("round-trips text, formatting and tables through the importer", async () => {
    const imported = await importRtf(Buffer.from(SAMPLE_RTF, "latin1"), {
      fileName: "sample.rtf",
    });
    const exported = await exportRtf(imported.document);
    const rtf = exported.buffer.toString("latin1");
    expect(rtf.startsWith("{\\rtf1")).toBe(true);
    expect(rtf).toContain("{\\fonttbl");
    expect(rtf).toContain("{\\colortbl");
    expect(rtf).toContain("\\trowd");
    expect(rtf).toContain("\\cellx");

    const round = await importRtf(exported.buffer, {
      fileName: "roundtrip.rtf",
    });
    expect(documentText(round.document).trim()).toBe(
      documentText(imported.document).trim(),
    );
    const roundTable = blocks(round.document).find(
      (block): block is Table => block.type === "table",
    );
    expect(roundTable?.rows.length).toBe(1);
    expect(roundTable?.rows[0].cells).toHaveLength(2);
  });

  it("reports images and revisions as unsupported", async () => {
    const imported = await importRtf(
      Buffer.from(String.raw`{\rtf1\ansi Hello\par}`, "latin1"),
    );
    const paragraph = paragraphs(imported.document)[0];
    paragraph.inlines = [
      {
        type: "text",
        text: "tracked",
        props: { revision: { id: "r1", kind: "insert", author: "A" } },
      },
    ];
    imported.document.media.push({
      id: "img1",
      fileName: "img1.png",
      contentType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      byteLength: 70,
    });
    paragraph.inlines.push({
      type: "image",
      mediaId: "img1",
      width: 10,
      height: 10,
      alt: "dot",
    });
    const exported = await exportRtf(imported.document);
    const features = exported.losses.map((loss) => loss.feature);
    expect(features).toContain("image");
    expect(features).toContain("revisions");
  });
});
