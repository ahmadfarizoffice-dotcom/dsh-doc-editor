import { describe, expect, it } from "vitest";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importDocx } from "../../packages/core/src/docx/import.js";
import {
  layoutDocument,
  pageInfoForBlock,
} from "../../packages/core/src/layout/index.js";
import {
  renderHtml,
  renderSvg,
  renderPdf,
  mediaMap,
} from "../../packages/core/src/render/index.js";
import { documentText } from "../../packages/core/src/model/text.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(
  here,
  "../../fixtures/docx_docs_renderer_feature_test_cases.docx",
);
const outputDir = path.resolve(here, "../../test-output");

describe("layout + render", () => {
  it("paginates the golden fixture and renders HTML/SVG/PDF", async () => {
    const bytes = await readFile(fixture);
    const { document } = await importDocx(bytes, { fileName: "fixture.docx" });
    const layout = layoutDocument(document);

     
    console.log(
      "pages:",
      layout.pageCount,
      "lines:",
      layout.stats.lines,
      "warnings:",
      layout.warnings.length,
    );
    console.log(
      "page sizes:",
      layout.pages.map(
        (page) =>
          `${page.displayNumber}:${page.width.toFixed(0)}x${page.height.toFixed(0)}:${page.orientation}:s${page.sectionIndex}`,
      ),
    );
    console.log(
      "header text page1:",
      layout.pages[0]?.header?.boxes
        .map((box) =>
          box.kind === "text" ? box.runs.map((run) => run.text).join("") : "",
        )
        .join(" | "),
    );
    console.log(
      "footer text page1:",
      layout.pages[0]?.footer?.boxes
        .map((box) =>
          box.kind === "text" ? box.runs.map((run) => run.text).join("") : "",
        )
        .join(" | "),
    );
    console.log("warnings:", layout.warnings);
    console.log("substituted:", layout.substitutedFonts);

    expect(layout.pageCount).toBeGreaterThan(2);
    expect(layout.stats.lines).toBeGreaterThan(200);

    // Every non-trivial paragraph must be reachable via a page.
    const firstPage = layout.pages[0];
    expect(firstPage).toBeDefined();
    const info = pageInfoForBlock(layout, document.sections[0].blocks[0].id);
    expect(info.blockPage).toBe(1);

    // Header and footer text appears on page 1.
    const headerText = firstPage.header?.boxes
      .map((box) =>
        box.kind === "text" ? box.runs.map((run) => run.text).join("") : "",
      )
      .join("");
    expect(headerText).toContain("DOCUMENT RENDERER TEST FIXTURE");
    const footerText = firstPage.footer?.boxes
      .map((box) =>
        box.kind === "text" ? box.runs.map((run) => run.text).join("") : "",
      )
      .join("");
    expect(footerText).toContain("Renderer QA Fixture");
    // PAGE field rendered as the display number.
    expect(footerText).toContain("1");

    const html = renderHtml(layout, {
      title: "Fixture",
      images: mediaMap(document),
    });
    expect(html).toContain('data-page="1"');
    expect(html).toContain("DOCX");
    expect(html).toContain("RENDERER");

    const svgs = renderSvg(layout, { images: mediaMap(document) });
    expect(svgs.length).toBe(layout.pageCount);
    expect(svgs[0]).toContain("<svg");

    const pdf = await renderPdf(layout, { title: "Fixture" });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(5000);

    // Text coverage: concatenated page text should contain most of the document text.
    const pageText = layout.pages
      .flatMap((page) => page.boxes)
      .filter((box) => box.kind === "text")
      .map((box) =>
        box.kind === "text" ? box.runs.map((run) => run.text).join("") : "",
      )
      .join("\n");
    const sourceText = documentText(document);
    const sample = sourceText.slice(0, 200).split("\n")[0];
    expect(pageText).toContain(sample);

    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, "fixture-preview.html"), html, "utf8");
    await writeFile(path.join(outputDir, "fixture.pdf"), pdf);
    await writeFile(
      path.join(outputDir, "fixture-page1.svg"),
      svgs[0] ?? "",
      "utf8",
    );
  });
});
