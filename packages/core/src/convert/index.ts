/**
 * Conversion engine.
 *
 * The engine is UI-independent: it takes bytes (or an in-memory document),
 * imports with the source adapter, exports with the target adapter and then
 * *measures* the result by re-importing it and comparing text and structure.
 * Every unrepresentable construct is returned as a `ConversionLoss`.
 *
 * PDF export is delegated lazily to `@dsh-doc/core/render`; when that module (or
 * its `renderPdf` export) is not present the engine fails with the typed
 * `PDF_RENDERER_UNAVAILABLE` error instead of producing a fake document.
 */
import { documentStats, documentText } from "../model/text.js";
import type { DocDocument, DocumentStats } from "../model/types.js";
import { detectFormat, getAdapter, listAdapters } from "../formats/index.js";
import { FormatError } from "../formats/types.js";
import type {
  CapabilityLevel,
  ConversionLoss,
  FormatAdapter,
  FormatCapabilities,
} from "../formats/types.js";

/* ---------------------------------------------------------------- errors */

/** Stable error codes produced by the conversion engine. */
export type ConversionErrorCode =
  | "CONVERSION_UNSUPPORTED"
  | "CONVERSION_FAILED"
  | "FORMAT_UNKNOWN"
  | "FORMAT_INVALID_INPUT"
  | "FORMAT_TOO_LARGE"
  | "FORMAT_EXPORT_UNSUPPORTED"
  | "PDF_RENDERER_UNAVAILABLE"
  | "PDF_RENDERER_FAILED";

/** Typed conversion error; also an instance of `FormatError`. */
export class ConversionError extends FormatError {
  constructor(code: ConversionErrorCode, message: string) {
    super(code, message);
    this.name = "ConversionError";
  }
}

/* --------------------------------------------------------- capability types */

/** Fidelity buckets used by the static conversion matrix. */
export type ConversionFidelity = "exact" | "high" | "medium" | "low";

/** One supported conversion pair. */
export interface ConversionCapability {
  from: string;
  to: string;
  fidelity: ConversionFidelity;
  /** Features that are not fully preserved for this pair. */
  lossyFeatures: string[];
  /** Whether the pair needs the optional PDF renderer. */
  requiresRenderer: boolean;
  /** False when an adapter in the chain cannot perform its half. */
  available: boolean;
  notes?: string;
}

/** Formats understood by the engine: adapter ids plus `pdf`. */
export type ConversionFormat = string;

const FEATURE_KEYS = [
  "styles",
  "tables",
  "images",
  "hyperlinks",
  "headersFooters",
  "pageLayout",
  "numbering",
  "metadata",
  "comments",
  "trackedChanges",
  "math",
] as const;

type FeatureKey = (typeof FEATURE_KEYS)[number];

const LEVEL_SCORE: Record<CapabilityLevel, number> = {
  full: 1,
  partial: 0.5,
  none: 0,
};

/** Fidelity overrides for the conversions the product commits to. */
const FIDELITY_OVERRIDES: Record<
  string,
  { fidelity: ConversionFidelity; notes?: string }
> = {
  "docx->html": {
    fidelity: "high",
    notes: "Styles become CSS; comments, notes and revisions use DSH markers",
  },
  "docx->pdf": {
    fidelity: "high",
    notes: "Rendered by the layout/render module",
  },
  "docx->odt": {
    fidelity: "high",
    notes: "Both sides are first-class ZIP/XML formats",
  },
  "docx->markdown": {
    fidelity: "medium",
    notes: "Rich formatting collapses to Markdown; tables become GFM",
  },
  "docx->text": { fidelity: "low", notes: "Plain text keeps text order only" },
  "odt->docx": {
    fidelity: "high",
    notes: "Both sides are first-class ZIP/XML formats",
  },
  "rtf->docx": {
    fidelity: "medium",
    notes: "RTF formatting is partially mapped; images and footnotes are lost",
  },
  "html->docx": {
    fidelity: "medium",
    notes: "CSS subset maps to run/paragraph formatting",
  },
  "markdown->docx": {
    fidelity: "medium",
    notes: "Markdown structure maps to styles, lists and GFM tables",
  },
  "legacy-doc->docx": {
    fidelity: "low",
    notes: "Legacy importer extracts text only; formatting is reported as lost",
  },
  "xlsx-preview->docx": {
    fidelity: "low",
    notes: "Spreadsheet preview: cell values become a table per sheet",
  },
  "pptx-preview->docx": {
    fidelity: "low",
    notes: "Presentation preview: slide text and tables only",
  },
  "xlsx-preview->html": {
    fidelity: "low",
    notes: "Spreadsheet preview rendered as HTML tables",
  },
  "pptx-preview->html": {
    fidelity: "low",
    notes: "Presentation preview rendered as HTML sections",
  },
  "text->docx": { fidelity: "low", notes: "One paragraph per line" },
  "text->html": { fidelity: "low", notes: "One paragraph per line" },
  "text->markdown": { fidelity: "low", notes: "One paragraph per line" },
};

function effectiveCapability(
  source: FormatCapabilities,
  target: FormatCapabilities,
  key: FeatureKey,
): {
  level: CapabilityLevel;
  sourceLevel: CapabilityLevel;
  targetLevel: CapabilityLevel;
} {
  const sourceLevel = source[key];
  const targetLevel = target[key];
  const score = Math.min(LEVEL_SCORE[sourceLevel], LEVEL_SCORE[targetLevel]);
  const level: CapabilityLevel =
    score >= 1 ? "full" : score >= 0.5 ? "partial" : "none";
  return { level, sourceLevel, targetLevel };
}

function derivedFidelity(
  source: FormatAdapter,
  target: FormatAdapter,
): { fidelity: ConversionFidelity; lossyFeatures: string[] } {
  let score = 0;
  const lossyFeatures: string[] = [];
  for (const key of FEATURE_KEYS) {
    const effective = effectiveCapability(
      source.capabilities,
      target.capabilities,
      key,
    );
    score += LEVEL_SCORE[effective.level];
    if (effective.level !== "full") {
      lossyFeatures.push(
        `${key}=${effective.level} (${source.id}:${effective.sourceLevel}/${target.id}:${effective.targetLevel})`,
      );
    }
  }
  const ratio = score / FEATURE_KEYS.length;
  const fidelity: ConversionFidelity =
    ratio >= 0.9
      ? "exact"
      : ratio >= 0.7
        ? "high"
        : ratio >= 0.45
          ? "medium"
          : "low";
  return { fidelity, lossyFeatures };
}

function pairKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function buildMatrix(): ConversionCapability[] {
  const adapters = listAdapters();
  const rows: ConversionCapability[] = [];
  for (const source of adapters) {
    if (!source.capabilities.canImport) continue;
    for (const target of adapters) {
      if (!target.export || !target.capabilities.canExport) continue;
      const key = pairKey(source.id, target.id);
      const override = FIDELITY_OVERRIDES[key];
      const derived = derivedFidelity(source, target);
      rows.push({
        from: source.id,
        to: target.id,
        fidelity: override?.fidelity ?? derived.fidelity,
        lossyFeatures: derived.lossyFeatures,
        requiresRenderer: false,
        available: true,
        notes:
          override?.notes ??
          (source.id === target.id
            ? "Same-format round trip"
            : "Derived from the adapters' declared capabilities"),
      });
    }
    // PDF is a renderer target available for every importable source.
    const pdfOverride = FIDELITY_OVERRIDES[pairKey(source.id, "pdf")];
    rows.push({
      from: source.id,
      to: "pdf",
      fidelity:
        pdfOverride?.fidelity ?? (source.id === "legacy-doc" ? "low" : "high"),
      lossyFeatures:
        source.id === "legacy-doc"
          ? ["character.formatting=none (legacy-doc:source)"]
          : [],
      requiresRenderer: true,
      available: true,
      notes:
        pdfOverride?.notes ??
        "Delegates to @dsh-doc/core render.renderPdf; fails with PDF_RENDERER_UNAVAILABLE when the renderer is absent",
    });
  }
  return rows.sort((a, b) =>
    a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from),
  );
}

const MATRIX: ConversionCapability[] = buildMatrix();

/** The static capability matrix of every supported conversion pair. */
export function getCapabilityMatrix(): ConversionCapability[] {
  return MATRIX.map((row) => ({
    ...row,
    lossyFeatures: [...row.lossyFeatures],
  }));
}

/** Capability entry for one conversion pair, or undefined when unsupported. */
export function getConversionCapabilities(
  from: string,
  to: string,
): ConversionCapability | undefined {
  const row = MATRIX.find((entry) => entry.from === from && entry.to === to);
  return row ? { ...row, lossyFeatures: [...row.lossyFeatures] } : undefined;
}

/** Export targets reachable from a source format (for MCP/CLI listings). */
export function supportedTargets(
  from: string,
): Array<{ to: string; fidelity: ConversionFidelity }> {
  return MATRIX.filter((entry) => entry.from === from && entry.available).map(
    (entry) => ({
      to: entry.to,
      fidelity: entry.fidelity,
    }),
  );
}

/* ------------------------------------------------------------- conversion */

export interface ConvertOptions {
  /** Source format id, or `auto` to detect it from the bytes. */
  from: ConversionFormat | "auto";
  /** Target format id (`docx`, `html`, `markdown`, `text`, `rtf`, `odt`, `pdf`, ...). */
  to: ConversionFormat;
  fileName?: string;
  /** Page assignments for TOC-bearing targets. */
  pageNumbers?: Map<string, number>;
  /** Keep stored timestamps on export. */
  preserveTimestamps?: boolean;
  /** Refuse inputs larger than this many bytes. */
  maxBytes?: number;
}

/** How the preservation numbers were obtained. */
export type PreservationMethod =
  "roundtrip-text" | "loss-penalty" | "unverified";

export interface ConversionReport {
  /** 0..1 text preservation, measured by round trip when the target can import. */
  contentPreservation: number;
  /** 0..1 structural preservation (paragraphs/tables/images). */
  structuralPreservation: number;
  /** Losses that removed or degraded content (unsupported/fallback/not preserved). */
  unsupportedElements: ConversionLoss[];
  durationMs: number;
  /** True when preservation was measured by re-importing the output. */
  verified: boolean;
  method: PreservationMethod;
  textBefore?: DocumentStats;
  textAfter?: DocumentStats;
  roundTripAttempted: boolean;
  roundTripError?: string;
}

export interface ConversionResult {
  buffer: Buffer;
  from: string;
  to: string;
  losses: ConversionLoss[];
  warnings: string[];
  report: ConversionReport;
}

function isDocument(value: unknown): value is DocDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { schemaVersion?: unknown; sections?: unknown };
  return (
    typeof candidate.schemaVersion === "string" &&
    Array.isArray(candidate.sections)
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (text.length === 0) return counts;
  for (const token of text.split(" ")) {
    if (token.length === 0) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/** Sørensen-Dice coefficient over token multisets (order-independent). */
function diceSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const left = tokenCounts(a);
  const right = tokenCounts(b);
  let overlap = 0;
  for (const [token, count] of left) {
    const other = right.get(token);
    if (other) overlap += Math.min(count, other);
  }
  const total =
    [...left.values()].reduce((sum, count) => sum + count, 0) +
    [...right.values()].reduce((sum, count) => sum + count, 0);
  return total === 0 ? 1 : (2 * overlap) / total;
}

function ratio(before: number, after: number): number {
  if (before === 0 && after === 0) return 1;
  if (before === 0 || after === 0) return 0;
  return Math.min(before, after) / Math.max(before, after);
}

function structuralScore(before: DocumentStats, after: DocumentStats): number {
  return clamp01(
    ratio(before.paragraphs, after.paragraphs) * 0.5 +
      ratio(before.tables, after.tables) * 0.25 +
      ratio(before.images, after.images) * 0.25,
  );
}

function lossPenalty(losses: ConversionLoss[]): number {
  let penalty = 0;
  for (const loss of losses) {
    if (loss.level === "partial") penalty += 0.02;
    else if (loss.level === "fallback") penalty += 0.05;
    else if (loss.level === "unsupported") penalty += 0.1;
    if (loss.preserved === false && loss.level === "full") penalty += 0.02;
  }
  return Math.min(0.95, penalty);
}

function unsupportedElementsOf(losses: ConversionLoss[]): ConversionLoss[] {
  return losses
    .filter(
      (loss) =>
        loss.level === "unsupported" ||
        loss.level === "fallback" ||
        loss.preserved === false,
    )
    .map((loss) => ({ ...loss }));
}

/* ------------------------------------------------------------ PDF renderer */

interface PdfRendererOptions {
  pageNumbers?: Map<string, number>;
}

type PdfRenderer = (doc: DocDocument, options: PdfRendererOptions) => unknown;

interface RenderModule {
  renderPdf?: PdfRenderer;
  default?: unknown;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function renderPdfThroughModule(
  doc: DocDocument,
  options: PdfRendererOptions,
): Promise<Buffer> {
  // Deliberately a variable specifier: the render module is owned by another
  // package area and may not exist yet, so a literal specifier would fail the
  // TypeScript build instead of producing the runtime PDF_RENDERER_UNAVAILABLE
  // error the API contract promises.
  const renderModuleSpecifier: string = "../render/index.js";
  let module: RenderModule;
  try {
    module = (await import(renderModuleSpecifier)) as RenderModule;
  } catch (error) {
    throw new ConversionError(
      "PDF_RENDERER_UNAVAILABLE",
      `PDF export requires the render module (${renderModuleSpecifier}), which is not available: ${describeError(error)}`,
    );
  }
  const renderer = module.renderPdf;
  if (typeof renderer !== "function") {
    throw new ConversionError(
      "PDF_RENDERER_UNAVAILABLE",
      `The render module (${renderModuleSpecifier}) does not export renderPdf()`,
    );
  }
  let output: unknown;
  try {
    output = await renderer(doc, options);
  } catch (error) {
    throw new ConversionError(
      "PDF_RENDERER_FAILED",
      `renderPdf() failed: ${describeError(error)}`,
    );
  }
  if (Buffer.isBuffer(output)) return output;
  if (output instanceof Uint8Array) return Buffer.from(output);
  if (output && typeof output === "object") {
    const candidate = (output as { buffer?: unknown }).buffer;
    if (Buffer.isBuffer(candidate)) return candidate;
    if (candidate instanceof Uint8Array) return Buffer.from(candidate);
    const pdf = (output as { pdf?: unknown }).pdf;
    if (Buffer.isBuffer(pdf)) return pdf;
    if (pdf instanceof Uint8Array) return Buffer.from(pdf);
  }
  throw new ConversionError(
    "PDF_RENDERER_FAILED",
    "renderPdf() returned no PDF bytes",
  );
}

/* ---------------------------------------------------------------- convert */

/**
 * Converts bytes (or an in-memory document) between supported formats.
 *
 * The result always includes the adapter losses, and a report that records how
 * content/structure preservation was measured. Text-based targets are verified
 * by re-importing the produced bytes and comparing normalized document text.
 *
 * @throws ConversionError for unsupported pairs, invalid input, or a missing PDF renderer.
 */
export async function convert(
  input: Buffer | Uint8Array | DocDocument,
  options: ConvertOptions,
): Promise<ConversionResult> {
  const started =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const warnings: string[] = [];
  const losses: ConversionLoss[] = [];

  const document = isDocument(input) ? input : undefined;
  const bytes = isDocument(input)
    ? undefined
    : Buffer.isBuffer(input)
      ? input
      : Buffer.from(input);

  /* ------------------------------------------------------ resolve source */

  let fromId: string;
  if (document) {
    fromId = options.from === "auto" ? "model" : options.from;
  } else {
    const buffer = bytes as Buffer;
    if (
      options.maxBytes !== undefined &&
      buffer.byteLength > options.maxBytes
    ) {
      throw new ConversionError(
        "FORMAT_TOO_LARGE",
        `Input is ${buffer.byteLength} bytes, above the ${options.maxBytes} byte limit`,
      );
    }
    const sourceAdapter =
      options.from === "auto"
        ? detectFormat(buffer, options.fileName)
        : getAdapter(options.from);
    if (!sourceAdapter) {
      throw new ConversionError(
        "FORMAT_UNKNOWN",
        options.from === "auto"
          ? "No format adapter recognises the input"
          : `Unknown source format: ${options.from}`,
      );
    }
    fromId = sourceAdapter.id;
    const imported = await sourceAdapter.import(buffer, {
      fileName: options.fileName,
      maxBytes: options.maxBytes,
    });
    return finish(imported, options, started, [], []);
  }

  /* -------------------------------------------------------- convert flow */

  const sourceAdapter = fromId === "model" ? undefined : getAdapter(fromId);
  const doc = document as DocDocument;

  if (options.to === "pdf") {
    if (sourceAdapter) assertPairSupported(sourceAdapter.id, "pdf");
    const buffer = await renderPdfThroughModule(doc, {
      pageNumbers: options.pageNumbers,
    });
    const before = documentStats(doc);
    const penalty = lossPenalty(losses);
    warnings.push(
      "PDF export was delegated to the render module; preservation was not round-trip verified.",
    );
    const report: ConversionReport = {
      contentPreservation: round3(1 - penalty),
      structuralPreservation: round3(1 - penalty),
      unsupportedElements: unsupportedElementsOf(losses),
      durationMs: elapsed(started),
      verified: false,
      method: "unverified",
      textBefore: before,
      roundTripAttempted: false,
    };
    return {
      buffer,
      from: fromId,
      to: "pdf",
      losses: losses.map((loss) => ({ ...loss })),
      warnings,
      report,
    };
  }

  const targetAdapter = getAdapter(options.to);
  if (!targetAdapter) {
    throw new ConversionError(
      "FORMAT_UNKNOWN",
      `Unknown target format: ${options.to}`,
    );
  }
  if (!targetAdapter.export || !targetAdapter.capabilities.canExport) {
    throw new ConversionError(
      "FORMAT_EXPORT_UNSUPPORTED",
      `Format ${targetAdapter.id} is ${targetAdapter.readOnly ? "read-only" : "import-only"} and cannot be an export target`,
    );
  }
  if (sourceAdapter) assertPairSupported(sourceAdapter.id, targetAdapter.id);

  return finish(
    { document: doc, warnings: [], losses: [] },
    options,
    started,
    losses,
    warnings,
    targetAdapter,
  );
}

function elapsed(started: number): number {
  const now =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  return Math.max(0, Math.round(now - started));
}

function assertPairSupported(from: string, to: string): void {
  if (from === "model") return;
  if (getConversionCapabilities(from, to)) return;
  const targets = supportedTargets(from).map((entry) => entry.to);
  throw new ConversionError(
    "CONVERSION_UNSUPPORTED",
    `Conversion ${from} -> ${to} is not supported. Supported targets from ${from}: ${targets.join(", ") || "none"}`,
  );
}

/**
 * Shared tail of every conversion: export, measure, report.
 *
 * `importResult` is the source adapter's result (empty when the input was
 * already a document).
 */
async function finish(
  importResult: {
    document: DocDocument;
    warnings: string[];
    losses: ConversionLoss[];
  },
  options: ConvertOptions,
  started: number,
  extraLosses: ConversionLoss[],
  extraWarnings: string[],
  explicitTarget?: FormatAdapter,
): Promise<ConversionResult> {
  const losses: ConversionLoss[] = [...importResult.losses, ...extraLosses].map(
    (loss) => ({ ...loss }),
  );
  const warnings: string[] = [...importResult.warnings, ...extraWarnings];
  const doc = importResult.document;
  const fromId = options.from === "auto" ? inferSourceId(doc) : options.from;

  if (options.to === "pdf") {
    if (fromId !== "model") assertPairSupported(fromId, "pdf");
    const buffer = await renderPdfThroughModule(doc, {
      pageNumbers: options.pageNumbers,
    });
    const before = documentStats(doc);
    const penalty = lossPenalty(losses);
    warnings.push(
      "PDF export was delegated to the render module; preservation was not round-trip verified.",
    );
    return {
      buffer,
      from: fromId,
      to: "pdf",
      losses,
      warnings,
      report: {
        contentPreservation: round3(1 - penalty),
        structuralPreservation: round3(1 - penalty),
        unsupportedElements: unsupportedElementsOf(losses),
        durationMs: elapsed(started),
        verified: false,
        method: "unverified",
        textBefore: before,
        roundTripAttempted: false,
      },
    };
  }

  const target = explicitTarget ?? getAdapter(options.to);
  if (!target || !target.export) {
    throw new ConversionError(
      "FORMAT_EXPORT_UNSUPPORTED",
      `Format ${options.to} cannot be used as an export target`,
    );
  }
  if (fromId !== "model") assertPairSupported(fromId, target.id);

  const exported = await target.export(doc, {
    fileName: options.fileName,
    preserveTimestamps: options.preserveTimestamps,
    pageNumbers: options.pageNumbers,
  });
  losses.push(...exported.losses.map((loss) => ({ ...loss })));
  warnings.push(...exported.warnings);

  const before = documentStats(doc);
  const beforeText = normalizeText(documentText(doc));

  let method: PreservationMethod = "loss-penalty";
  let verified = false;
  let roundTripAttempted = false;
  let roundTripError: string | undefined;
  let contentPreservation = round3(1 - lossPenalty(losses));
  let structuralPreservation = round3(1 - lossPenalty(losses));
  let after: DocumentStats | undefined;

  const canRoundTrip =
    target.import !== undefined &&
    target.capabilities.canImport &&
    target.readOnly !== true;
  if (canRoundTrip) {
    roundTripAttempted = true;
    try {
      const reimported = await target.import(exported.buffer, {
        fileName: options.fileName
          ? `roundtrip.${target.extensions[0] ?? "bin"}`
          : undefined,
      });
      after = documentStats(reimported.document);
      const afterText = normalizeText(documentText(reimported.document));
      contentPreservation = round3(diceSimilarity(beforeText, afterText));
      structuralPreservation = round3(structuralScore(before, after));
      method = "roundtrip-text";
      verified = true;
    } catch (error) {
      roundTripError = describeError(error);
      warnings.push(`Round-trip verification failed: ${roundTripError}`);
    }
  }

  const result: ConversionResult = {
    buffer: exported.buffer,
    from: fromId,
    to: target.id,
    losses,
    warnings,
    report: {
      contentPreservation,
      structuralPreservation,
      unsupportedElements: unsupportedElementsOf(losses),
      durationMs: elapsed(started),
      verified,
      method,
      textBefore: before,
      textAfter: after,
      roundTripAttempted,
      roundTripError,
    },
  };
  return result;
}

function inferSourceId(doc: DocDocument): string {
  const declared = doc.metadata.custom?.sourceFormat;
  if (declared) return declared;
  const report = doc.compatibility?.sourceFormat;
  if (report) return report;
  return "model";
}

/** Convenience: convert and return only the bytes (throws on failure). */
export async function convertToBuffer(
  input: Buffer | Uint8Array | DocDocument,
  options: ConvertOptions,
): Promise<Buffer> {
  return (await convert(input, options)).buffer;
}
