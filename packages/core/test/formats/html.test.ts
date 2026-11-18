import { describe, expect, it } from "vitest";
import { exportDocx } from "../../src/docx/export.js";
import { importDocx } from "../../src/docx/import.js";
import { documentText } from "../../src/model/text.js";
import type {
  Block,
  DocDocument,
  Paragraph,
  Table,
} from "../../src/model/types.js";
import { exportHtml, importHtml } from "../../src/formats/html.js";

/** 1x1 transparent PNG. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en-GB">
<head>
  <title>Quarterly report</title>
  <meta name="author" content="Ada Lovelace" />
  <meta name="description" content="A small sample" />
  <meta name="keywords" content="report, sample" />
  <style>@page { size: 612pt 792pt; margin: 90pt; }</style>
</head>
<body>
  <h1>Quarterly report</h1>
  <p>Intro with <strong>bold</strong>, <em>italic</em> and a <a href="https://example.com/q1">link</a>.</p>
  <ul>
    <li>First item</li>
    <li>Second item<ul><li>Nested item</li></ul></li>
  </ul>
  <table>
    <thead><tr><th colspan="2">Merged header</th></tr></thead>
    <tbody>
      <tr><td rowspan="2">A</td><td>B</td></tr>
      <tr><td>C</td></tr>
    </tbody>
  </table>
  <p><img src="data:image/png;base64,${PNG_1X1}" alt="dot" width="16" height="16" /></p>
</body>
</html>`;

function firstSection(doc: DocDocument): Block[] {
  return doc.sections[0].blocks;
}

function paragraphAt(blocks: Block[], index: number): Paragraph {
  const block = blocks[index];
  if (!block || block.type !== "paragraph")
    throw new Error(`block ${index} is not a paragraph`);
  return block;
}

function tableAt(blocks: Block[], index: number): Table {
  const block = blocks[index];
  if (!block || block.type !== "table")
    throw new Error(`block ${index} is not a table`);
  return block;
}

describe("HTML import", () => {
  it("maps headings, inline formatting, links, lists, tables and data-URI images", async () => {
    const result = await importHtml(Buffer.from(SAMPLE_HTML, "utf8"), {
      fileName: "report.html",
    });
    const doc = result.document;
    const blocks = firstSection(doc);

    expect(doc.metadata.title).toBe("Quarterly report");
    expect(doc.metadata.creator).toBe("Ada Lovelace");
    expect(doc.metadata.description).toBe("A small sample");
    expect(doc.metadata.keywords).toEqual(["report", "sample"]);
    expect(doc.settings.defaultLanguage).toBe("en-GB");
    // @page size + shorthand margin.
    expect(Math.round(doc.sections[0].page.width)).toBe(612);
    expect(Math.round(doc.sections[0].page.height)).toBe(792);
    expect(Math.round(doc.sections[0].page.margins.top)).toBe(90);

    expect(paragraphAt(blocks, 0).style).toBe("Heading1");
    expect(documentText(doc)).toContain("Intro with bold, italic and a link.");

    const intro = paragraphAt(blocks, 1);
    const boldRun = intro.inlines.find(
      (inline) => inline.type === "text" && inline.text === "bold",
    );
    expect(
      boldRun && boldRun.type === "text" ? boldRun.props.bold : undefined,
    ).toBe(true);
    const italicRun = intro.inlines.find(
      (inline) => inline.type === "text" && inline.text === "italic",
    );
    expect(
      italicRun && italicRun.type === "text"
        ? italicRun.props.italic
        : undefined,
    ).toBe(true);
    const linkRun = intro.inlines.find(
      (inline) =>
        inline.type === "text" &&
        inline.props.hyperlink?.href === "https://example.com/q1",
    );
    expect(linkRun).toBeDefined();

    const listItems = blocks.filter(
      (block): block is Paragraph =>
        block.type === "paragraph" && Boolean(block.props.numbering),
    );
    expect(listItems).toHaveLength(3);
    expect(listItems[0].props.numbering?.level).toBe(0);
    expect(listItems[2].props.numbering?.level).toBe(1);
    expect(documentText(doc)).toContain("Nested item");

    const table = tableAt(
      blocks,
      blocks.findIndex((block) => block.type === "table"),
    );
    expect(table.rows).toHaveLength(3);
    expect(table.rows[0].props.isHeader).toBe(true);
    expect(table.rows[0].cells[0].props.gridSpan).toBe(2);
    expect(table.rows[1].cells[0].props.vMerge).toBe("restart");
    expect(table.rows[1].cells[0].props.gridSpan ?? 1).toBe(1);
    expect(table.rows[2].cells[0].props.vMerge).toBe("continue");

    expect(doc.media).toHaveLength(1);
    expect(doc.media[0].contentType).toBe("image/png");
    const imageParagraph = blocks.find(
      (block): block is Paragraph =>
        block.type === "paragraph" &&
        block.inlines.some((inline) => inline.type === "image"),
    );
    expect(imageParagraph).toBeDefined();
    expect(doc.compatibility?.sourceFormat).toBe("html");
    expect(doc.compatibility?.transparent).toBe(true);
  });

  it("repairs sloppy HTML with unclosed list items, cells and paragraphs", async () => {
    const sloppy =
      "<ul><li>one<li>two</ul><table><tr><td>a<td>b</table><p>para";
    const result = await importHtml(Buffer.from(sloppy, "utf8"), {
      fileName: "sloppy.html",
    });
    const blocks = firstSection(result.document);
    const text = documentText(result.document);
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("para");
    expect(blocks.some((block) => block.type === "table")).toBe(true);
    const table = blocks.find(
      (block): block is Table => block.type === "table",
    );
    expect(table?.rows[0].cells).toHaveLength(2);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("reports remote images as losses without fetching them", async () => {
    const html =
      '<p>before <img src="https://example.com/cat.png" alt="cat" /> after</p>';
    const result = await importHtml(Buffer.from(html, "utf8"));
    expect(result.document.media).toHaveLength(0);
    expect(result.losses.some((loss) => loss.feature === "image.remote")).toBe(
      true,
    );
    expect(documentText(result.document)).toContain("cat");
  });
});

describe("HTML export", () => {
  it("writes semantic HTML with styles, tables, links, comments and footnotes", async () => {
    const imported = await importHtml(Buffer.from(SAMPLE_HTML, "utf8"), {
      fileName: "report.html",
    });
    const doc = imported.document;
    // Add an anchored comment and a footnote on the intro paragraph.
    const intro = paragraphAt(firstSection(doc), 1);
    doc.comments.push({
      id: "c1",
      author: "Reviewer",
      blocks: [
        {
          type: "paragraph",
          id: "pc1",
          style: "Normal",
          props: {},
          inlines: [
            { type: "text", text: "Please check the numbers.", props: {} },
          ],
        },
      ],
      resolved: false,
    });
    intro.inlines.push({ type: "commentRef", commentId: "c1", kind: "point" });
    doc.footnotes.push({
      id: "fn1",
      type: "footnote",
      blocks: [
        {
          type: "paragraph",
          id: "pf1",
          style: "Normal",
          props: {},
          inlines: [{ type: "text", text: "A footnote body.", props: {} }],
        },
      ],
    });
    intro.inlines.push({
      type: "noteRef",
      noteId: "fn1",
      noteType: "footnote",
    });

    const exported = await exportHtml(doc);
    const html = exported.buffer.toString("utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Quarterly report</title>");
    expect(html).toContain("@page { size:");
    expect(html).toContain("<h1");
    expect(html).toContain('<table class="dsh-table"');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('rowspan="2"');
    expect(html).toContain('href="https://example.com/q1"');
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain('class="dsh-comment"');
    expect(html).toContain('class="dsh-footnotes"');

    const round = await importHtml(exported.buffer, {
      fileName: "report.html",
    });
    expect(documentText(round.document).trim()).toBe(documentText(doc).trim());
    expect(round.document.comments).toHaveLength(1);
    expect(round.document.footnotes).toHaveLength(1);
    expect(
      round.document.sections[0].blocks.some((block) => block.type === "table"),
    ).toBe(true);
  });
});

describe("HTML to DOCX round trip", () => {
  it("preserves text, table structure and hyperlinks through the DOCX exporter", async () => {
    const imported = await importHtml(Buffer.from(SAMPLE_HTML, "utf8"), {
      fileName: "report.html",
    });
    const exported = await exportDocx(imported.document, {
      preserveTimestamps: true,
    });
    const reimported = await importDocx(exported.buffer, {
      fileName: "report.docx",
    });

    const beforeText = documentText(imported.document).trim();
    const afterText = documentText(reimported.document).trim();
    expect(afterText).toBe(beforeText);

    const beforeTable = firstSection(imported.document).find(
      (block): block is Table => block.type === "table",
    );
    const afterTable = firstSection(reimported.document).find(
      (block): block is Table => block.type === "table",
    );
    expect(beforeTable).toBeDefined();
    expect(afterTable).toBeDefined();
    expect(afterTable?.rows.length).toBe(beforeTable?.rows.length);
    expect(afterTable?.rows[0].cells[0].props.gridSpan).toBe(2);
    expect(afterTable?.rows[2].cells[0].props.vMerge).toBe("continue");

    const link = firstSection(reimported.document)
      .flatMap((block) => (block.type === "paragraph" ? block.inlines : []))
      .find(
        (inline) =>
          inline.type === "text" &&
          inline.props.hyperlink?.href === "https://example.com/q1",
      );
    expect(link).toBeDefined();
    expect(reimported.document.media.length).toBe(
      imported.document.media.length,
    );
  });
});
