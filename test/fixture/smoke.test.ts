import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importDocx } from "../../packages/core/src/docx/import.js";
import {
  documentStats,
  documentText,
} from "../../packages/core/src/model/text.js";
import { documentOutline } from "../../packages/core/src/model/query.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(
  here,
  "../../fixtures/docx_docs_renderer_feature_test_cases.docx",
);

describe("DOCX import smoke test", () => {
  it("imports the golden fixture without structural loss", async () => {
    const bytes = await readFile(fixture);
    const result = await importDocx(bytes, { fileName: "fixture.docx" });
    const doc = result.document;

    console.log("sections:", doc.sections.length);
    console.log(
      "blocks/section:",
      doc.sections.map((s) => s.blocks.length),
    );
    console.log(
      "page sizes:",
      doc.sections.map((s) => [
        s.page.width.toFixed(1),
        s.page.height.toFixed(1),
        s.page.orientation,
      ]),
    );
    console.log("styles:", Object.keys(doc.styles.styles).length);
    console.log("numbering nums:", Object.keys(doc.numbering.nums).length);
    console.log(
      "headers:",
      doc.sections.map((s) => Boolean(s.headers.default)),
    );
    console.log(
      "footers:",
      doc.sections.map((s) => Boolean(s.footers.default)),
    );
    console.log("stats:", documentStats(doc));
    console.log(
      "outline:",
      documentOutline(doc)
        .map((e) => `${e.level}:${e.text}`)
        .slice(0, 12),
    );
    console.log("warnings:", result.warnings);
    console.log("losses:", result.report.losses);
    console.log(
      "features:",
      result.report.features.filter((f) => f.occurrences > 0),
    );
    const text = documentText(doc);
    console.log("text length:", text.length);
    console.log("first 200:", JSON.stringify(text.slice(0, 200)));

    expect(doc.sections.length).toBe(3);
    expect(documentStats(doc).paragraphs).toBeGreaterThan(50);
    expect(result.report.transparent).toBe(true);
  });
});
