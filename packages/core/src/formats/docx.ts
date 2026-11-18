/**
 * DOCX adapter: thin, faithful wrapper around the OOXML importer/exporter.
 *
 * The DOCX code paths are the reference implementation for the model, so this
 * adapter only adapts the shapes (compatibility report → loss list) and adds
 * content sniffing. It exists so the registry and conversion engine treat DOCX
 * exactly like every other format.
 */
import { exportDocx } from "../docx/export.js";
import { importDocx } from "../docx/import.js";
import type { DocDocument, FeatureSupport } from "../model/types.js";
import { FormatError } from "./types.js";
import type {
  ConversionLoss,
  FormatAdapter,
  FormatCapabilities,
  FormatExportOptions,
  FormatExportResult,
  FormatImportOptions,
  FormatImportResult,
} from "./types.js";

const CAPABILITIES: FormatCapabilities = {
  canImport: true,
  canExport: true,
  styles: "full",
  tables: "full",
  images: "full",
  hyperlinks: "full",
  headersFooters: "full",
  pageLayout: "full",
  numbering: "full",
  metadata: "full",
  comments: "full",
  trackedChanges: "full",
  math: "partial",
  notes: [
    "Round-trips the shared document model without loss for modelled constructs.",
    "Unmodelled OOXML parts are preserved and reported, never dropped silently.",
    "Equations are modelled for common constructs; others fall back to linear text.",
  ],
};

const DOCX_EXTENSIONS = ["docx", "dotx", "docm"];

function extensionOf(fileName?: string): string {
  const match = fileName ? /\.([A-Za-z0-9]+)$/.exec(fileName) : null;
  return match ? match[1].toLowerCase() : "";
}

function isZip(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05)
  );
}

/** True when the ZIP prefix mentions WordprocessingML parts. */
function looksLikeWordPackage(bytes: Buffer): boolean {
  const head = bytes
    .subarray(0, Math.min(bytes.length, 8192))
    .toString("latin1");
  return head.includes("word/") || head.includes("wordprocessingml");
}

/** Converts the DOCX compatibility report into conversion losses. */
function lossesFromReport(
  report: import("../model/types.js").CompatibilityReport,
): ConversionLoss[] {
  const losses: ConversionLoss[] = report.losses.map((loss) => ({
    feature: loss.feature,
    level: loss.level,
    reason: loss.reason,
    location: loss.location,
    preserved: loss.preserved,
  }));
  for (const unknown of report.unknownElements) {
    losses.push({
      feature: unknown.element,
      level: "fallback",
      reason:
        "Element is preserved verbatim and reported; rendering uses a text fallback",
      location: unknown.location,
      preserved: true,
    });
  }
  return losses;
}

/** Imports a WordprocessingML package into the shared document model. */
export async function importDocxFormat(
  bytes: Buffer,
  options: FormatImportOptions = {},
): Promise<FormatImportResult> {
  if (options.maxBytes !== undefined && bytes.byteLength > options.maxBytes) {
    throw new FormatError(
      "FORMAT_TOO_LARGE",
      `DOCX input is ${bytes.byteLength} bytes, above the ${options.maxBytes} byte limit`,
    );
  }
  if (!isZip(bytes)) {
    throw new FormatError(
      "FORMAT_INVALID_INPUT",
      "Not an OOXML package (ZIP magic is missing). Encrypted or legacy .doc files need the legacy-doc importer.",
    );
  }
  const result = await importDocx(bytes, { fileName: options.fileName });
  return {
    document: result.document,
    warnings: result.warnings,
    losses: lossesFromReport(result.report),
  };
}

/** Serializes a document to a WordprocessingML package. */
export async function exportDocxFormat(
  doc: DocDocument,
  options: FormatExportOptions = {},
): Promise<FormatExportResult> {
  const extension = extensionOf(options.fileName);
  const flavor =
    extension === "dotx" ? "dotx" : extension === "docm" ? "docm" : "docx";
  const result = await exportDocx(doc, {
    flavor,
    pageNumbers: options.pageNumbers,
    preserveTimestamps: options.preserveTimestamps ?? false,
  });
  const losses: ConversionLoss[] = result.droppedParts.map((path) => ({
    feature: `part:${path}`,
    level: "unsupported",
    reason:
      "Part is preserved in the source package but has no model representation, so it was not re-emitted",
    location: `part:${path}`,
    preserved: false,
  }));
  return { buffer: result.buffer, warnings: result.warnings, losses };
}

/** DOCX format descriptor. */
export const docxAdapter: FormatAdapter = {
  id: "docx",
  label: "Microsoft Word (DOCX)",
  extensions: [...DOCX_EXTENSIONS],
  mimeTypes: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    "application/vnd.ms-word.document.macroEnabled.12",
  ],
  capabilities: CAPABILITIES,
  detect(bytes, fileName) {
    if (DOCX_EXTENSIONS.includes(extensionOf(fileName))) return true;
    if (!isZip(bytes)) return false;
    return looksLikeWordPackage(bytes);
  },
  import: importDocxFormat,
  export: exportDocxFormat,
};

/** Feature list used by compatibility reports produced from a DOCX import. */
export function docxBaselineFeatures(doc: DocDocument): FeatureSupport[] {
  return [
    {
      feature: "document.package",
      label: "OOXML package",
      level: "full",
      occurrences: 1,
    },
    {
      feature: "document.sections",
      label: "Sections",
      level: "full",
      occurrences: doc.sections.length,
    },
    {
      feature: "document.metadata",
      label: "Document metadata",
      level: "full",
      occurrences: 1,
    },
  ];
}
