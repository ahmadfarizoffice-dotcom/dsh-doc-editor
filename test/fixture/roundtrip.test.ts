import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importDocx } from "../../packages/core/src/docx/import.js";
import { exportDocx } from "../../packages/core/src/docx/export.js";
import {
  documentStats,
  documentText,
} from "../../packages/core/src/model/text.js";
import { documentOutline } from "../../packages/core/src/model/query.js";
import type { DocDocument } from "../../packages/core/src/model/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(
  here,
  "../../fixtures/docx_docs_renderer_feature_test_cases.docx",
);

function structure(doc: DocDocument) {
  return doc.sections.map((section) => ({
    page: [
      Math.round(section.page.width * 10) / 10,
      Math.round(section.page.height * 10) / 10,
      section.page.orientation,
    ],
    columns: section.columns.count,
    header: section.headers.default ? section.headers.default.blocks.length : 0,
    footer: section.footers.default ? section.footers.default.blocks.length : 0,
    blocks: section.blocks.map((block) =>
      block.type === "paragraph"
        ? `p:${block.style ?? ""}:${JSON.stringify(
            block.inlines
              .map((inline) =>
                inline.type === "text" ? inline.text : inline.type,
              )
              .join(""),
          )}`
        : block.type === "table"
          ? `tbl:${block.rows.length}x${block.grid.length}`
          : "toc",
    ),
  }));
}

describe("DOCX round-trip", () => {
  it("re-imports an exported document with identical structure and text", async () => {
    const bytes = await readFile(fixture);
    const first = await importDocx(bytes, { fileName: "fixture.docx" });
    const exported = await exportDocx(first.document, {
      preserveTimestamps: true,
    });

    console.log(
      "export warnings:",
      exported.warnings,
      "bytes:",
      exported.buffer.byteLength,
    );

    const second = await importDocx(exported.buffer, {
      fileName: "roundtrip.docx",
    });

    const textA = documentText(first.document);
    const textB = documentText(second.document);
    expect(textB).toBe(textA);

    expect(documentStats(second.document).paragraphs).toBe(
      documentStats(first.document).paragraphs,
    );
    expect(second.document.sections.length).toBe(
      first.document.sections.length,
    );

    const outlineA = documentOutline(first.document).map(
      (e) => `${e.level}|${e.text}|${e.style}`,
    );
    const outlineB = documentOutline(second.document).map(
      (e) => `${e.level}|${e.text}|${e.style}`,
    );
    expect(outlineB).toEqual(outlineA);

    expect(structure(second.document)).toEqual(structure(first.document));

    const tablesA = first.document.sections
      .flatMap((section) => section.blocks)
      .filter((block) => block.type === "table")
      .map((block) =>
        block.type === "table" ? block.rows.map((row) => row.cells.length) : [],
      );
    const tablesB = second.document.sections
      .flatMap((section) => section.blocks)
      .filter((block) => block.type === "table")
      .map((block) =>
        block.type === "table" ? block.rows.map((row) => row.cells.length) : [],
      );
    expect(tablesB).toEqual(tablesA);
  });
});
