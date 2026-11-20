/**
 * Format adapter contract.
 *
 * Every document format supported by the platform is described by one
 * `FormatAdapter`. Adapters are stateless: they receive bytes (or a document)
 * and return a result. Fidelity is always reported explicitly through
 * `ConversionLoss` entries so callers never have to guess what was preserved.
 */
import type { DocDocument, SupportLevel } from "../model/types.js";

/** How completely a capability is represented in the intermediate model. */
export type CapabilityLevel = "full" | "partial" | "none";

/**
 * Declared, static capabilities of one format. These describe what the adapter
 * *attempts*; per-document reality is reported in `ConversionLoss` entries and
 * in the `CompatibilityReport` attached to imported documents.
 */
export interface FormatCapabilities {
  canImport: boolean;
  canExport: boolean;
  styles: CapabilityLevel;
  tables: CapabilityLevel;
  images: CapabilityLevel;
  hyperlinks: CapabilityLevel;
  headersFooters: CapabilityLevel;
  pageLayout: CapabilityLevel;
  numbering: CapabilityLevel;
  metadata: CapabilityLevel;
  comments: CapabilityLevel;
  trackedChanges: CapabilityLevel;
  math: CapabilityLevel;
  /** Human readable caveats shown in the MCP `document_list_formats` output. */
  notes?: string[];
}

/** Options accepted by every `FormatAdapter.import`. */
export interface FormatImportOptions {
  /** Original file name, used for extension hints and metadata. */
  fileName?: string;
  /** Refuse inputs larger than this many bytes. */
  maxBytes?: number;
}

/** Options accepted by every `FormatAdapter.export`. */
export interface FormatExportOptions {
  fileName?: string;
  /** Keep stored timestamps instead of regenerating them. */
  preserveTimestamps?: boolean;
  /** Page assignments from the layout engine (used by TOC-bearing formats). */
  pageNumbers?: Map<string, number>;
}

/**
 * One feature that a conversion could not represent exactly. `level` uses the
 * model's support vocabulary: `full` is only used for informational entries.
 */
export interface ConversionLoss {
  feature: string;
  level: SupportLevel;
  reason: string;
  /** Where it was observed, e.g. `section[0].blocks[12]` or `table:Sheet1!B4`. */
  location?: string;
  /** True when the original construct is retained verbatim in the document. */
  preserved?: boolean;
}

/** Result of importing bytes into the document model. */
export interface FormatImportResult {
  document: DocDocument;
  warnings: string[];
  losses: ConversionLoss[];
}

/** Result of exporting a document to bytes. */
export interface FormatExportResult {
  buffer: Buffer;
  warnings: string[];
  losses: ConversionLoss[];
}

/** A single format implementation. */
export interface FormatAdapter {
  /** Stable id, e.g. `docx`, `odt`, `rtf`, `html`, `markdown`, `text`. */
  id: string;
  label: string;
  /** Lower-case extensions without the dot, e.g. `["docx", "dotx"]`. */
  extensions: string[];
  mimeTypes: string[];
  /** True for preview-only adapters (XLSX/PPTX/legacy DOC import). */
  readOnly?: boolean;
  capabilities: FormatCapabilities;
  /** Fast, synchronous content sniffing. Must never throw. */
  detect(bytes: Buffer, fileName?: string): boolean;
  import(
    bytes: Buffer,
    options: FormatImportOptions,
  ): Promise<FormatImportResult>;
  export?(
    doc: DocDocument,
    options: FormatExportOptions,
  ): Promise<FormatExportResult>;
}

/** Stable error codes surfaced by adapters and the conversion engine. */
export type FormatErrorCode =
  | "FORMAT_UNKNOWN"
  | "FORMAT_IMPORT_UNSUPPORTED"
  | "FORMAT_EXPORT_UNSUPPORTED"
  | "FORMAT_INVALID_INPUT"
  | "FORMAT_CORRUPT"
  | "FORMAT_BOMB"
  | "FORMAT_UNSUPPORTED"
  | "FORMAT_TOO_LARGE"
  | "FORMAT_UNSUPPORTED_CONTAINER"
  | "CONVERSION_UNSUPPORTED"
  | "CONVERSION_FAILED"
  | "PDF_RENDERER_UNAVAILABLE"
  | "PDF_RENDERER_FAILED";

/** Typed error thrown by format adapters and the conversion engine. */
export class FormatError extends Error {
  readonly code: FormatErrorCode;

  constructor(code: FormatErrorCode, message: string) {
    super(message);
    this.name = "FormatError";
    this.code = code;
  }
}

/** True when `error` is a `FormatError` with the given code. */
export function isFormatError(error: unknown): error is FormatError {
  return error instanceof FormatError;
}
