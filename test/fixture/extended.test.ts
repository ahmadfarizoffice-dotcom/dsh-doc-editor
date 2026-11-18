import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importDocx } from "../../packages/core/src/docx/import.js";
import { exportDocx } from "../../packages/core/src/docx/export.js";
import { layoutDocument } from "../../packages/core/src/layout/index.js";
import { documentText } from "../../packages/core/src/model/text.js";
import { documentOutline } from "../../packages/core/src/model/query.js";
import type {
  Block,
  DocDocument,
  Paragraph,
  Table,
} from "../../packages/core/src/model/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(
  here,
  "../../fixtures/docx_docs_renderer_feature_test_cases_extended.docx",
);

function paragraphs(doc: DocDocument): Paragraph[] {
  const out: Paragraph[] = [];
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      if (block.type === "paragraph") out.push(block);
      else if (block.type === "table")
        for (const row of block.rows)
          for (const cell of row.cells) walk(cell.blocks);
    }
  };
  for (const section of doc.sections) walk(section.blocks);
  return out;
}

function tables(doc: DocDocument): Table[] {
  return doc.sections
    .flatMap((section) => section.blocks)
    .filter((block): block is Table => block.type === "table");
}

function inlineCount(
  doc: DocDocument,
  predicate: (inline: Paragraph["inlines"][number]) => boolean,
): number {
  return paragraphs(doc).reduce(
    (sum, paragraph) => sum + paragraph.inlines.filter(predicate).length,
    0,
  );
}

describe("extended acceptance fixture", () => {
  it("imports every additional construct without silently dropping it", async () => {
    const bytes = await readFile(fixture);
    const { document: doc, report } = await importDocx(bytes, {
      fileName: "extended.docx",
    });

    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].page.width).toBeCloseTo(595.3, 0);
    expect(doc.sections[0].page.orientation).toBe("portrait");
    expect(doc.sections[0].page.borders?.top?.color).toBe("#4472c4");
    expect(doc.sections[0].headers.default).toBeDefined();
    expect(doc.sections[0].footers.default).toBeDefined();

    // Images with intrinsic pixel dimensions.
    expect(doc.media).toHaveLength(2);
    expect(doc.media.every((asset) => asset.widthPx && asset.heightPx)).toBe(
      true,
    );
    expect(doc.media[0].contentType).toBe("image/png");

    // Notes, comments, bookmarks.
    expect(doc.footnotes).toHaveLength(1);
    expect(doc.endnotes).toHaveLength(1);
    expect(doc.footnotes[0].blocks.length).toBeGreaterThan(0);
    expect(doc.comments).toHaveLength(1);
    expect(doc.comments[0].author).toBe("QA Fixture");
    expect(doc.bookmarks.map((bookmark) => bookmark.name)).toContain(
      "_Toc_extended",
    );

    // Tracked revisions.
    expect(
      inlineCount(
        doc,
        (inline) =>
          inline.type === "text" && inline.props.revision?.kind === "insert",
      ),
    ).toBeGreaterThan(0);
    expect(
      inlineCount(
        doc,
        (inline) =>
          inline.type === "text" && inline.props.revision?.kind === "delete",
      ),
    ).toBeGreaterThan(0);

    // Equation, text box, hyperlink.
    const math = paragraphs(doc).flatMap((paragraph) =>
      paragraph.inlines.filter((inline) => inline.type === "math"),
    );
    expect(math.length).toBeGreaterThan(0);
    expect(math[0].type === "math" ? math[0].linear : "").toContain("a");
    expect(doc.shapes.length).toBeGreaterThanOrEqual(1);
    expect(doc.shapes[0].kind).toBe("textbox");
    expect(doc.shapes[0].blocks.length).toBeGreaterThan(0);
    const links = paragraphs(doc).flatMap((paragraph) =>
      paragraph.inlines.filter(
        (inline) => inline.type === "text" && inline.props.hyperlink?.href,
      ),
    );
    expect(links.length).toBeGreaterThan(0);

    // Fields.
    const fields = paragraphs(doc).flatMap((paragraph) =>
      paragraph.inlines.filter((inline) => inline.type === "field"),
    );
    const instructions = fields.map((field) =>
      field.type === "field" ? field.instr : "",
    );
    expect(instructions.some((instr) => /PAGEREF/i.test(instr))).toBe(true);
    expect(instructions.some((instr) => /SEQ/i.test(instr))).toBe(true);
    const footerFields = (
      doc.sections[0].footers.default?.blocks ?? []
    ).flatMap((block) =>
      block.type === "paragraph"
        ? block.inlines.filter((inline) => inline.type === "field")
        : [],
    );
    expect(
      footerFields.some(
        (field) => field.type === "field" && /NUMPAGES/i.test(field.instr),
      ),
    ).toBe(true);

    // Generated TOC detected as a structured block.
    const tocBlocks = doc.sections[0].blocks.filter(
      (block) => block.type === "toc",
    );
    expect(tocBlocks).toHaveLength(1);

    // Table: repeating header row and horizontal merge.
    const table = tables(doc)[0];
    expect(table).toBeDefined();
    expect(table.rows[0].props.isHeader).toBe(true);
    expect(table.rows[1].cells[0].props.gridSpan).toBe(2);

    // Numbering definitions retained.
    expect(Object.keys(doc.numbering.nums).length).toBeGreaterThan(0);

    // Transparency: no silent drops.
    expect(report.transparent).toBe(true);
    expect(report.unknownElements.every((entry) => entry.count > 0)).toBe(true);
  });

  it("lays out pages with header/footer, notes, images, text boxes and TOC page numbers", async () => {
    const bytes = await readFile(fixture);
    const { document: doc } = await importDocx(bytes, {
      fileName: "extended.docx",
    });
    const layout = layoutDocument(doc);

    expect(layout.pageCount).toBeGreaterThanOrEqual(2);
    const boxes = layout.pages.flatMap((page) => page.boxes);
    expect(
      boxes.filter((box) => box.kind === "image").length,
    ).toBeGreaterThanOrEqual(2);
    expect(boxes.some((box) => box.kind === "shape")).toBe(true);
    expect(boxes.some((box) => box.kind === "math")).toBe(true);

    // Header/footer including PAGE and NUMPAGES.
    const headerText = layout.pages[0].header?.boxes
      .map((box) =>
        box.kind === "text" ? box.runs.map((run) => run.text).join("") : "",
      )
      .join("");
    expect(headerText).toContain("Extended fixture header");
    expect(headerText).toContain("1");
    const footerText = layout.pages[0].footer?.boxes
      .map((box) =>
        box.kind === "text" ? box.runs.map((run) => run.text).join("") : "",
      )
      .join("");
    expect(footerText).toContain("Extended fixture footer");
    expect(footerText).toContain(String(layout.pageCount));

    // Footnotes are placed in a bottom region on the page containing the reference.
    const footnotePages = layout.pages.filter(
      (page) => page.footnoteRegion && page.footnoteRegion.boxes.length > 0,
    );
    expect(footnotePages.length).toBeGreaterThan(0);
    const footnoteText = footnotePages[0].footnoteRegion?.boxes
      .map((box) =>
        box.kind === "text" ? box.runs.map((run) => run.text).join("") : "",
      )
      .join("");
    expect(footnoteText).toContain("Footnote text attached");

    // TOC entries resolved to real pages.
    expect(layout.tocEntries.length).toBeGreaterThan(0);
    expect(layout.tocEntries.every((entry) => entry.page >= 1)).toBe(true);
    const tocText = boxes
      .filter(
        (box) =>
          box.kind === "text" && box.blockId && box.blockId.includes("toc"),
      )
      .map((box) =>
        box.kind === "text" ? box.runs.map((run) => run.text).join("") : "",
      )
      .join("\n");
    expect(tocText).toContain("References and review");

    // Tracked changes are projected according to the revision mode.
    const allText = documentText(doc, { mode: "all" });
    const finalText = documentText(doc, { mode: "final" });
    expect(allText).toContain("deleted by track changes");
    expect(finalText).not.toContain("deleted by track changes");
    expect(finalText).toContain("inserted by track changes");

    // Outline includes the two headings (Title is level 0).
    const outline = documentOutline(doc);
    expect(
      outline.some((entry) => entry.text === "References and review"),
    ).toBe(true);
    expect(outline.some((entry) => entry.text === "Second heading")).toBe(true);
  });

  it("round-trips the extended constructs through DOCX export and re-import", async () => {
    const bytes = await readFile(fixture);
    const first = await importDocx(bytes, { fileName: "extended.docx" });
    const exported = await exportDocx(first.document, {
      preserveTimestamps: true,
    });
    const second = await importDocx(exported.buffer, {
      fileName: "extended-roundtrip.docx",
    });

    expect(documentText(second.document)).toBe(documentText(first.document));
    expect(second.document.media).toHaveLength(first.document.media.length);
    expect(second.document.footnotes).toHaveLength(
      first.document.footnotes.length,
    );
    expect(second.document.endnotes).toHaveLength(
      first.document.endnotes.length,
    );
    expect(second.document.comments).toHaveLength(
      first.document.comments.length,
    );
    expect(second.document.shapes).toHaveLength(first.document.shapes.length);
    expect(
      second.document.sections[0].blocks.filter(
        (block) => block.type === "toc",
      ),
    ).toHaveLength(1);
    expect(
      inlineCount(second.document, (inline) => inline.type === "math"),
    ).toBe(inlineCount(first.document, (inline) => inline.type === "math"));
    expect(
      inlineCount(
        second.document,
        (inline) => inline.type === "text" && Boolean(inline.props.revision),
      ),
    ).toBe(
      inlineCount(
        first.document,
        (inline) => inline.type === "text" && Boolean(inline.props.revision),
      ),
    );
    const tableA = tables(first.document)[0];
    const tableB = tables(second.document)[0];
    expect(tableB.rows.map((row) => row.cells.length)).toEqual(
      tableA.rows.map((row) => row.cells.length),
    );
    expect(tableB.rows[0].props.isHeader).toBe(true);

    const layout = layoutDocument(second.document);
    expect(layout.pageCount).toBeGreaterThanOrEqual(2);
  });
});
