import { describe, expect, it } from "vitest";
import { documentText } from "../../src/model/text.js";
import type { Paragraph, Table } from "../../src/model/types.js";
import {
  importPptxPreview,
  importXlsxPreview,
  pptxPreviewAdapter,
  xlsxPreviewAdapter,
} from "../../src/formats/ooxml-preview.js";
import { exportAny } from "../../src/formats/index.js";
import { buildPptxPackage, buildXlsxPackage } from "./fixtures.js";

describe("XLSX preview import", () => {
  it("projects each worksheet into a heading plus a cell table", async () => {
    const bytes = await buildXlsxPackage();
    const result = await importXlsxPreview(bytes, { fileName: "book.xlsx" });
    const doc = result.document;

    expect(doc.sections.length).toBe(2);
    expect(doc.metadata.custom.DSHPreview).toBe("true");
    expect(doc.compatibility).toBeDefined();
    expect(doc.compatibility?.sourceFormat).toBe("xlsx-preview");
    expect(result.losses.some((loss) => loss.feature === "xlsx.formula")).toBe(true);
    expect(result.losses.some((loss) => loss.feature === "xlsx.chart")).toBe(true);

    const firstSection = doc.sections[0];
    const heading = firstSection.blocks[0];
    expect(heading.type).toBe("paragraph");
    if (heading.type === "paragraph") {
      expect(heading.style).toBe("Heading1");
      expect(documentText(doc)).toContain("Sheet: Data");
    }
    const table = firstSection.blocks.find((block): block is Table => block.type === "table");
    expect(table).toBeDefined();
    expect(table?.rows.length).toBe(2);
    expect(table?.rows[0].props.isHeader).toBe(true);
    // Shared string, cached formula value.
    expect(documentText(doc)).toContain("Alpha");
    expect(documentText(doc)).toContain("42");
    // Column width from xl/worksheets/sheet1.xml (<col width="10"/> → 70pt).
    expect(Math.round(table?.grid[0] ?? 0)).toBe(70);

    const second = doc.sections[1];
    expect(documentText({ ...doc, sections: [second] })).toContain("Sheet: Second");
    expect(
      second.blocks.some(
        (block) => block.type === "table" && documentText({ ...doc, sections: [second] }).includes("Gamma"),
      ),
    ).toBe(true);
  });

  it("detects workbooks and refuses to be an export target", async () => {
    const bytes = await buildXlsxPackage();
    expect(xlsxPreviewAdapter.detect(bytes, "book.xlsx")).toBe(true);
    expect(xlsxPreviewAdapter.readOnly).toBe(true);
    const imported = await importXlsxPreview(bytes, { fileName: "book.xlsx" });
    await expect(exportAny(imported.document, "xlsx-preview")).rejects.toMatchObject({
      code: "FORMAT_EXPORT_UNSUPPORTED",
    });
  });
});

describe("PPTX preview import", () => {
  it("projects each slide into a heading, text paragraphs, tables and pictures", async () => {
    const bytes = await buildPptxPackage();
    const result = await importPptxPreview(bytes, { fileName: "deck.pptx" });
    const doc = result.document;

    expect(doc.sections.length).toBe(2);
    expect(doc.metadata.custom.DSHPreview).toBe("true");
    expect(doc.compatibility?.sourceFormat).toBe("pptx-preview");
    expect(result.losses.some((loss) => loss.feature === "pptx.chart")).toBe(true);
    expect(result.losses.some((loss) => loss.feature === "pptx.notes")).toBe(true);
    // Slide dimensions: 12192000 x 6858000 EMU → 960 x 540 pt.
    expect(Math.round(doc.sections[0].page.width)).toBe(960);
    expect(Math.round(doc.sections[0].page.height)).toBe(540);

    const text = documentText(doc);
    expect(text).toContain("Slide 1");
    expect(text).toContain("Slide title");
    expect(text).toContain("Point one");
    expect(text).toContain("Slide 2");
    expect(text).toContain("Second slide");
    expect(text).toContain("Only point");

    const firstSection = doc.sections[0];
    const heading = firstSection.blocks[0];
    expect(heading.type).toBe("paragraph");
    if (heading.type === "paragraph") {
      expect(heading.style).toBe("Heading1");
    }
    const slideTitle = firstSection.blocks.find(
      (block): block is Paragraph => block.type === "paragraph" && block.style === "Title",
    );
    expect(slideTitle).toBeDefined();
    const table = firstSection.blocks.find((block): block is Table => block.type === "table");
    expect(table).toBeDefined();
    expect(table?.rows.length).toBe(2);
    expect(documentText(doc)).toContain("H1");
    expect(documentText(doc)).toContain("C2");
    expect(doc.media.length).toBe(1);
    expect(doc.media[0].contentType).toBe("image/png");
  });

  it("detects presentations and marks itself read-only", async () => {
    const bytes = await buildPptxPackage();
    expect(pptxPreviewAdapter.detect(bytes, "deck.pptx")).toBe(true);
    expect(pptxPreviewAdapter.readOnly).toBe(true);
    expect(pptxPreviewAdapter.capabilities.canExport).toBe(false);
  });
});
