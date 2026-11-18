import { describe, expect, it } from "vitest";
import { documentText } from "../../src/model/text.js";
import type {
  Block,
  DocDocument,
  Paragraph,
  Table,
} from "../../src/model/types.js";
import { exportMarkdown, importMarkdown } from "../../src/formats/markdown.js";

const SAMPLE_MARKDOWN = `# Release notes

Intro with **bold**, *italic*, ~~struck~~ and \`code\`, plus a [link](https://example.com/release).

- First bullet
- Second bullet
  - Nested bullet

1. Ordered one
2. Ordered two

> A quoted line.

| Name | Value |
| --- | --- |
| Alpha | 1 |
| Beta | 2 |

\`\`\`ts
const x = 1;
\`\`\`

---

Footnote reference[^1].

[^1]: The footnote body.
`;

function blocks(doc: DocDocument): Block[] {
  return doc.sections[0].blocks;
}

function tableOf(doc: DocDocument): Table | undefined {
  return blocks(doc).find((block): block is Table => block.type === "table");
}

describe("Markdown import", () => {
  it("maps headings, inline marks, lists, quotes, tables, code and footnotes", async () => {
    const result = await importMarkdown(Buffer.from(SAMPLE_MARKDOWN, "utf8"), {
      fileName: "notes.md",
    });
    const doc = result.document;
    const first = blocks(doc)[0];
    expect(first.type).toBe("paragraph");
    if (first.type === "paragraph") {
      expect(first.style).toBe("Heading1");
      expect(first.props.outlineLevel).toBe(0);
    }

    const intro = blocks(doc)[1];
    expect(intro.type).toBe("paragraph");
    if (intro.type === "paragraph") {
      const bold = intro.inlines.find(
        (inline) => inline.type === "text" && inline.text === "bold",
      );
      expect(bold && bold.type === "text" ? bold.props.bold : undefined).toBe(
        true,
      );
      const italic = intro.inlines.find(
        (inline) => inline.type === "text" && inline.text === "italic",
      );
      expect(
        italic && italic.type === "text" ? italic.props.italic : undefined,
      ).toBe(true);
      const struck = intro.inlines.find(
        (inline) => inline.type === "text" && inline.text === "struck",
      );
      expect(
        struck && struck.type === "text" ? struck.props.strike : undefined,
      ).toBe(true);
      const code = intro.inlines.find(
        (inline) => inline.type === "text" && inline.text === "code",
      );
      expect(
        code && code.type === "text" ? code.props.fontFamily : undefined,
      ).toBe("Consolas");
      const link = intro.inlines.find(
        (inline) =>
          inline.type === "text" &&
          inline.props.hyperlink?.href === "https://example.com/release",
      );
      expect(link).toBeDefined();
    }

    const listParagraphs = blocks(doc).filter(
      (block): block is Paragraph =>
        block.type === "paragraph" && Boolean(block.props.numbering),
    );
    expect(listParagraphs.length).toBe(5);
    expect(listParagraphs[2].props.numbering?.level).toBe(1);
    expect(documentText(doc)).toContain("Nested bullet");

    const quote = blocks(doc).find(
      (block): block is Paragraph =>
        block.type === "paragraph" && block.style === "Quote",
    );
    expect(quote).toBeDefined();

    const table = tableOf(doc);
    expect(table?.rows.length).toBe(3);
    expect(table?.rows[0].props.isHeader).toBe(true);
    expect(documentText(doc)).toContain("Alpha");

    const codeBlocks = blocks(doc).filter(
      (block): block is Paragraph =>
        block.type === "paragraph" && block.style === "Code",
    );
    expect(codeBlocks.length).toBe(1);
    expect(documentText(doc)).toContain("const x = 1;");

    const rule = blocks(doc).find(
      (block): block is Paragraph =>
        block.type === "paragraph" &&
        block.inlines.length === 0 &&
        block.props.borders?.bottom?.style === "single",
    );
    expect(rule).toBeDefined();

    expect(doc.footnotes).toHaveLength(1);
    expect(documentText(doc)).toContain("The footnote body.");
    const noteRef = blocks(doc)
      .flatMap((block) => (block.type === "paragraph" ? block.inlines : []))
      .find((inline) => inline.type === "noteRef");
    expect(noteRef).toBeDefined();
  });

  it("never fetches remote images and reports them as losses", async () => {
    const result = await importMarkdown(
      Buffer.from(
        "Text with ![a cat](https://example.com/cat.png) inline.",
        "utf8",
      ),
      { fileName: "images.md" },
    );
    expect(result.document.media).toHaveLength(0);
    expect(
      result.losses.some(
        (loss) => loss.feature === "image.remote" && loss.preserved === false,
      ),
    ).toBe(true);
    expect(documentText(result.document)).toContain("a cat");
  });
});

describe("Markdown round trip", () => {
  it("preserves text, headings, lists, tables, links and footnotes", async () => {
    const imported = await importMarkdown(
      Buffer.from(SAMPLE_MARKDOWN, "utf8"),
      { fileName: "notes.md" },
    );
    const exported = await exportMarkdown(imported.document);
    const markdown = exported.buffer.toString("utf8");

    expect(markdown.startsWith("# Release notes")).toBe(true);
    expect(markdown).toContain("- First bullet");
    expect(markdown).toContain("| Name | Value |");
    expect(markdown).toContain("[link](<https://example.com/release>)");
    expect(markdown).toContain("[^1]");
    expect(markdown).toContain("[^1]: The footnote body.");

    const round = await importMarkdown(exported.buffer, {
      fileName: "roundtrip.md",
    });
    expect(documentText(round.document).trim()).toBe(
      documentText(imported.document).trim(),
    );
    expect(tableOf(round.document)?.rows.length).toBe(
      tableOf(imported.document)?.rows.length,
    );
    const roundLink = blocks(round.document)
      .flatMap((block) => (block.type === "paragraph" ? block.inlines : []))
      .find(
        (inline) =>
          inline.type === "text" &&
          inline.props.hyperlink?.href === "https://example.com/release",
      );
    expect(roundLink).toBeDefined();
    expect(round.document.footnotes).toHaveLength(1);
  });

  it("reports formatting that Markdown cannot represent", async () => {
    const imported = await importMarkdown(Buffer.from("Styled text.", "utf8"));
    const paragraph = blocks(imported.document)[0];
    if (paragraph.type !== "paragraph") throw new Error("expected a paragraph");
    paragraph.inlines = [
      {
        type: "text",
        text: "Colour and underline",
        props: {
          color: "#ff0000",
          underline: "single",
          fontSize: 14,
          fontFamily: "Georgia",
        },
      },
    ];
    const exported = await exportMarkdown(imported.document);
    const features = exported.losses.map((loss) => loss.feature);
    expect(features).toContain("text.color");
    expect(features).toContain("text.underline");
    expect(features).toContain("text.font");
  });
});
