import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importDocx } from "../../src/docx/import.js";
import { importOdt } from "../../src/formats/odt.js";
import { documentText } from "../../src/model/text.js";
import type { DocDocument } from "../../src/model/types.js";
import {
  convert,
  getCapabilityMatrix,
  getConversionCapabilities,
  supportedTargets,
} from "../../src/convert/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, "../../../../fixtures/docx_docs_renderer_feature_test_cases.docx");

let cached: DocDocument | undefined;

async function fixtureDocument(): Promise<DocDocument> {
  if (!cached) {
    const bytes = await readFile(fixture);
    const imported = await importDocx(bytes, { fileName: "feature-test-cases.docx" });
    cached = imported.document;
  }
  return cached;
}

describe("conversion capability matrix", () => {
  it("lists the committed conversion pairs with fidelity levels", () => {
    const matrix = getCapabilityMatrix();
    expect(matrix.length).toBeGreaterThan(20);
    const required: Array<[string, string]> = [
      ["docx", "html"],
      ["docx", "pdf"],
      ["docx", "odt"],
      ["docx", "markdown"],
      ["docx", "text"],
      ["odt", "docx"],
      ["rtf", "docx"],
      ["html", "docx"],
      ["markdown", "docx"],
      ["legacy-doc", "docx"],
    ];
    for (const [from, to] of required) {
      const entry = matrix.find((candidate) => candidate.from === from && candidate.to === to);
      expect(entry, `${from} -> ${to} must be supported`).toBeDefined();
      expect(entry?.available).toBe(true);
      expect(entry?.fidelity).toMatch(/^(exact|high|medium|low)$/);
    }
    expect(getConversionCapabilities("docx", "html")?.fidelity).toBe("high");
    expect(getConversionCapabilities("docx", "pdf")?.requiresRenderer).toBe(true);
    expect(getConversionCapabilities("docx", "markdown")?.lossyFeatures.length).toBeGreaterThan(0);
    expect(getConversionCapabilities("docx", "xlsx-preview")).toBeUndefined();
    expect(supportedTargets("docx").map((entry) => entry.to)).toContain("odt");
  });
});

describe("convert() from an in-memory document", () => {
  it("exports the DOCX fixture to HTML, ODT, text and Markdown", async () => {
    const doc = await fixtureDocument();
    const beforeText = documentText(doc).trim();

    const html = await convert(doc, { from: "model", to: "html" });
    expect(html.buffer.byteLength).toBeGreaterThan(1000);
    expect(html.buffer.toString("utf8")).toContain("<!DOCTYPE html>");
    expect(html.losses.length).toBeGreaterThanOrEqual(0);
    expect(html.report.verified).toBe(true);
    expect(html.report.contentPreservation).toBeGreaterThan(0.9);
    expect(html.report.durationMs).toBeGreaterThanOrEqual(0);

    const odt = await convert(doc, { from: "model", to: "odt" });
    expect(odt.buffer.subarray(0, 2).toString("latin1")).toBe("PK");
    const odtRound = await importOdt(odt.buffer, { fileName: "converted.odt" });
    expect(documentText(odtRound.document).trim()).toBe(beforeText);
    expect(odt.report.verified).toBe(true);
    expect(odt.report.contentPreservation).toBeGreaterThan(0.9);

    const text = await convert(doc, { from: "model", to: "text" });
    const textOut = text.buffer.toString("utf8");
    expect(textOut.length).toBeGreaterThan(10);
    expect(text.report.roundTripAttempted).toBe(true);
    expect(text.report.verified).toBe(true);

    const markdown = await convert(doc, { from: "model", to: "markdown" });
    const markdownOut = markdown.buffer.toString("utf8");
    expect(markdownOut.length).toBeGreaterThan(10);
    expect(markdown.report.verified).toBe(true);
    expect(markdown.report.contentPreservation).toBeGreaterThan(0.5);
    expect(markdown.report.unsupportedElements.length).toBeGreaterThan(0);
  });

  it("delegates PDF to the render module or fails with PDF_RENDERER_UNAVAILABLE", async () => {
    const doc = await fixtureDocument();
    let pdf: Buffer | undefined;
    try {
      pdf = (await convert(doc, { from: "model", to: "pdf" })).buffer;
    } catch (error) {
      // The render module is owned by another area; when it is absent the
      // engine must fail with the typed error rather than fake a document.
      expect(error).toMatchObject({ code: "PDF_RENDERER_UNAVAILABLE" });
    }
    if (pdf) {
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  });
});

describe("convert() from bytes", () => {
  it("converts HTML bytes into DOCX with verified text preservation", async () => {
    const html = Buffer.from(
      "<html><body><h1>Converted heading</h1><p>Body text with <strong>bold</strong>.</p></body></html>",
      "utf8",
    );
    const result = await convert(html, { from: "auto", to: "docx", fileName: "input.html" });
    expect(result.buffer.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(result.from).toBe("html");
    expect(result.report.verified).toBe(true);
    expect(result.report.contentPreservation).toBeGreaterThan(0.9);
    expect(result.report.textBefore?.words).toBeGreaterThan(0);
    expect(result.report.textAfter?.words).toBeGreaterThan(0);
  });

  it("reports source-format losses through the conversion result", async () => {
    const rtf = Buffer.from(
      String.raw`{\rtf1\ansi{\header header text}{\pict\pngblip 89504e47}\pard Lossy sample\par}`,
      "latin1",
    );
    const result = await convert(rtf, { from: "auto", to: "docx", fileName: "lossy.rtf" });
    expect(result.from).toBe("rtf");
    const features = result.losses.map((loss) => loss.feature);
    expect(features).toContain("rtf.header");
    expect(features).toContain("rtf.pict");
    expect(result.report.unsupportedElements.length).toBeGreaterThan(0);
    expect(result.report.verified).toBe(true);
  });

  it("fails with typed errors for unknown input and read-only targets", async () => {
    await expect(convert(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]), { from: "auto", to: "docx" })).rejects.toMatchObject({
      code: "FORMAT_UNKNOWN",
    });
    await expect(convert(Buffer.from("# title\n", "utf8"), { from: "markdown", to: "xlsx-preview" })).rejects.toMatchObject({
      code: "FORMAT_EXPORT_UNSUPPORTED",
    });
    await expect(convert(Buffer.from("# title\n", "utf8"), { from: "nope", to: "docx" })).rejects.toMatchObject({
      code: "FORMAT_UNKNOWN",
    });
  });
});
