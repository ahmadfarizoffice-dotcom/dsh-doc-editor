/**
 * Format adapter registry.
 *
 * `detectFormat` is the single entry point for "what is this file"; `importAny`
 * and `exportAny` are the adapter-agnostic conversions used by the conversion
 * engine, the MCP server and the CLI. `availableFormats()` is the capability
 * matrix surfaced by the `document_list_formats` tool.
 */
import { docxAdapter } from "./docx.js";
import { htmlAdapter } from "./html.js";
import { legacyDocAdapter } from "./legacy-doc.js";
import { markdownAdapter } from "./markdown.js";
import { odtAdapter } from "./odt.js";
import { pptxPreviewAdapter, xlsxPreviewAdapter } from "./ooxml-preview.js";
import { rtfAdapter } from "./rtf.js";
import { textAdapter } from "./text.js";
import { FormatError } from "./types.js";
import type {
  FormatAdapter,
  FormatCapabilities,
  FormatExportOptions,
  FormatExportResult,
  FormatImportOptions,
  FormatImportResult,
} from "./types.js";

export * from "./types.js";
export { importDocxFormat, exportDocxFormat, docxAdapter } from "./docx.js";
export { importHtml, exportHtml, htmlAdapter } from "./html.js";
export { importMarkdown, exportMarkdown, markdownAdapter } from "./markdown.js";
export { importText, exportText, textAdapter } from "./text.js";
export { importRtf, exportRtf, rtfAdapter } from "./rtf.js";
export { importOdt, exportOdt, odtAdapter } from "./odt.js";
export {
  importLegacyDoc,
  readCompoundFile,
  paragraphsFromLegacyText,
  legacyDocAdapter,
} from "./legacy-doc.js";
export {
  importXlsxPreview,
  importPptxPreview,
  xlsxPreviewAdapter,
  pptxPreviewAdapter,
} from "./ooxml-preview.js";

/**
 * Registry order matters for detection: container formats first, the
 * printable-text fallback last.
 */
const ADAPTERS: FormatAdapter[] = [
  docxAdapter,
  odtAdapter,
  xlsxPreviewAdapter,
  pptxPreviewAdapter,
  legacyDocAdapter,
  rtfAdapter,
  htmlAdapter,
  markdownAdapter,
  textAdapter,
];

/** Every registered adapter, in detection order. */
export function listAdapters(): FormatAdapter[] {
  return [...ADAPTERS];
}

/** Looks an adapter up by id. */
export function getAdapter(id: string): FormatAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.id === id);
}

/** All adapters whose id matches one of the given ids. */
export function getAdapters(ids: string[]): FormatAdapter[] {
  const wanted = new Set(ids);
  return ADAPTERS.filter((adapter) => wanted.has(adapter.id));
}

/**
 * Detects the most specific adapter for the given bytes/file name. When no
 * adapter claims the input, `undefined` is returned (the caller decides whether
 * to treat the bytes as opaque or to report `FORMAT_UNKNOWN`).
 */
export function detectFormat(
  bytes: Buffer | Uint8Array,
  fileName?: string,
): FormatAdapter | undefined {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  for (const adapter of ADAPTERS) {
    let claimed = false;
    try {
      claimed = adapter.detect(buffer, fileName);
    } catch {
      // A detection failure must never break the registry.
      claimed = false;
    }
    if (claimed) return adapter;
  }
  return undefined;
}

/** Every adapter that claims the input, most specific first. */
export function detectAll(
  bytes: Buffer | Uint8Array,
  fileName?: string,
): FormatAdapter[] {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return ADAPTERS.filter((adapter) => {
    try {
      return adapter.detect(buffer, fileName);
    } catch {
      return false;
    }
  });
}

/** Import result that also names the adapter that handled the input. */
export interface DetectedImportResult extends FormatImportResult {
  format: string;
  readOnly: boolean;
}

/**
 * Imports bytes using the detected (or explicitly selected) adapter.
 *
 * @throws FormatError `FORMAT_UNKNOWN` when nothing claims the input and
 * `FORMAT_IMPORT_UNSUPPORTED` when the selected adapter cannot import.
 */
export async function importAny(
  bytes: Buffer | Uint8Array,
  fileName?: string,
  options: FormatImportOptions & { format?: string } = {},
): Promise<DetectedImportResult> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const adapter = options.format
    ? getAdapter(options.format)
    : detectFormat(buffer, fileName);
  if (!adapter) {
    throw new FormatError(
      "FORMAT_UNKNOWN",
      `No format adapter recognises this input${fileName ? ` (${fileName})` : ""}`,
    );
  }
  if (!adapter.capabilities.canImport) {
    throw new FormatError(
      "FORMAT_IMPORT_UNSUPPORTED",
      `Format ${adapter.id} does not support import`,
    );
  }
  const result = await adapter.import(buffer, {
    ...options,
    fileName: options.fileName ?? fileName,
  });
  return { ...result, format: adapter.id, readOnly: adapter.readOnly === true };
}

/**
 * Exports a document to the named format.
 *
 * @throws FormatError `FORMAT_UNKNOWN` for an unknown format and
 * `FORMAT_EXPORT_UNSUPPORTED` for read-only adapters.
 */
export async function exportAny(
  doc: import("../model/types.js").DocDocument,
  format: string,
  options: FormatExportOptions = {},
): Promise<FormatExportResult> {
  const adapter = getAdapter(format);
  if (!adapter) {
    throw new FormatError("FORMAT_UNKNOWN", `Unknown export format: ${format}`);
  }
  if (!adapter.export || !adapter.capabilities.canExport) {
    throw new FormatError(
      "FORMAT_EXPORT_UNSUPPORTED",
      `Format ${adapter.id} is ${adapter.readOnly ? "read-only" : "import-only"} and cannot be used as an export target`,
    );
  }
  return adapter.export(doc, options);
}

/** One row of the capability matrix consumed by `document_list_formats`. */
export interface FormatCapabilityRow {
  id: string;
  label: string;
  extensions: string[];
  mimeTypes: string[];
  readOnly: boolean;
  canImport: boolean;
  canExport: boolean;
  capabilities: FormatCapabilities;
}

/**
 * Capability matrix for every registered format: what each adapter can read
 * and write, how completely it maps the model, and its caveats.
 */
export function availableFormats(): FormatCapabilityRow[] {
  return ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    extensions: [...adapter.extensions],
    mimeTypes: [...adapter.mimeTypes],
    readOnly: adapter.readOnly === true,
    canImport: adapter.capabilities.canImport,
    canExport: adapter.capabilities.canExport && adapter.export !== undefined,
    capabilities: {
      ...adapter.capabilities,
      notes: adapter.capabilities.notes
        ? [...adapter.capabilities.notes]
        : undefined,
    },
  }));
}

/** Format ids that can be used as export targets. */
export function exportableFormats(): string[] {
  return ADAPTERS.filter(
    (adapter) => adapter.export !== undefined && adapter.capabilities.canExport,
  ).map((adapter) => adapter.id);
}

/** Format ids that can be used as import sources. */
export function importableFormats(): string[] {
  return ADAPTERS.filter((adapter) => adapter.capabilities.canImport).map(
    (adapter) => adapter.id,
  );
}

/** True when `id` is a registered adapter. */
export function isKnownFormat(id: string): boolean {
  return getAdapter(id) !== undefined;
}
