/**
 * Shared building blocks for format adapters.
 *
 * Adapters create a document through `createDocumentContext`, which owns the
 * deterministic id factory and the default styles/numbering so every importer
 * produces the same ids for the same input. Exporters use the formatting
 * resolution helpers from `model/styles.ts` directly.
 */
import { addMedia } from "../model/edit.js";
import {
  createDefaultNumbering,
  createDefaultStyles,
  DEFAULT_PAGE,
  DEFAULT_THEME,
} from "../model/create.js";
import { makeIdFactory } from "../model/ids.js";
import { DOCUMENT_SCHEMA_VERSION, pxToPt } from "../model/types.js";
import type {
  Block,
  Border,
  CellProps,
  CompatibilityReport,
  DocDocument,
  DocMetadata,
  DocSettings,
  FeatureSupport,
  ImageInline,
  Inline,
  MediaAsset,
  PageSetup,
  Paragraph,
  ParagraphProps,
  RowProps,
  RunProps,
  Section,
  SectionBreakType,
  StyleDef,
  Table,
  TableCell,
  TableProps,
  TableRow,
  UnknownPart,
} from "../model/types.js";
import type { ConversionLoss, FormatImportResult } from "./types.js";

/* ------------------------------------------------------- document context */

export interface DocumentContextOptions {
  /** Document id (default `doc-1`). */
  id?: string;
  metadata?: Partial<DocMetadata>;
  page?: PageSetup;
  settings?: Partial<DocSettings>;
  /** Deterministic document timestamp; omit to leave timestamps unset. */
  now?: string;
}

export interface DocumentContext {
  doc: DocDocument;
  /** Live block array of the first (default) section. */
  blocks: Block[];
  /** Deterministic id factory scoped to this import. */
  next(prefix: string): string;
  /** Commits the id sequence so later edits cannot collide. */
  syncIds(): void;
}

function clonePage(page: PageSetup): PageSetup {
  return {
    ...page,
    margins: { ...page.margins },
    borders: page.borders ? { ...page.borders } : undefined,
  };
}

/** Creates an empty section with Word-compatible defaults. */
export function createSection(
  page: PageSetup,
  blocks: Block[],
  breakBefore: SectionBreakType = "nextPage",
): Section {
  return {
    id: `s1`,
    blocks,
    page: clonePage(page),
    columns: { count: 1, space: 36, equalWidth: true },
    headers: {},
    footers: {},
    breakBefore,
    titlePage: false,
    evenAndOdd: false,
  };
}

/** Creates the mutable import context shared by every format adapter. */
export function createDocumentContext(
  options: DocumentContextOptions = {},
): DocumentContext {
  const factory = makeIdFactory(0);
  const page = clonePage(options.page ?? DEFAULT_PAGE);
  const metadata: DocMetadata = {
    title: options.metadata?.title,
    subject: options.metadata?.subject,
    creator: options.metadata?.creator,
    lastModifiedBy: options.metadata?.lastModifiedBy,
    keywords: options.metadata?.keywords ? [...options.metadata.keywords] : [],
    description: options.metadata?.description,
    category: options.metadata?.category,
    created: options.metadata?.created,
    modified: options.metadata?.modified,
    revision: options.metadata?.revision,
    custom: { ...(options.metadata?.custom ?? {}) },
    app: options.metadata?.app ? { ...options.metadata.app } : undefined,
  };
  const settings: DocSettings = {
    defaultTabStop: 36,
    evenAndOddHeaders: false,
    trackRevisions: false,
    autoHyphenation: false,
    defaultLanguage: "en-US",
    compatibilityMode: "15",
    ...options.settings,
  };

  const doc: DocDocument = {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: options.id ?? "doc-1",
    metadata,
    theme: structuredClone(DEFAULT_THEME),
    styles: createDefaultStyles(),
    numbering: createDefaultNumbering(),
    sections: [createSection(page, [])],
    footnotes: [],
    endnotes: [],
    comments: [],
    revisions: [],
    bookmarks: [],
    shapes: [],
    media: [],
    customXml: [],
    settings,
    unknown: [],
    idSeq: 0,
  };

  if (options.now) {
    doc.metadata.created = doc.metadata.created ?? options.now;
    doc.metadata.modified = doc.metadata.modified ?? options.now;
  }

  const section = doc.sections[0];
  return {
    doc,
    blocks: section.blocks,
    next: (prefix) => factory.next(prefix),
    syncIds: () => {
      doc.idSeq = Math.max(factory.value(), doc.idSeq);
    },
  };
}

/** Appends a new section (used by multi-sheet / multi-slide preview imports). */
export function appendSection(
  ctx: DocumentContext,
  blocks: Block[],
  options: { breakBefore?: SectionBreakType; page?: PageSetup } = {},
): Section {
  const template = ctx.doc.sections[0];
  const section: Section = {
    id: ctx.next("sec"),
    blocks,
    page: clonePage(options.page ?? template?.page ?? DEFAULT_PAGE),
    columns: { count: 1, space: 36, equalWidth: true },
    headers: {},
    footers: {},
    breakBefore: options.breakBefore ?? "nextPage",
    titlePage: false,
    evenAndOdd: false,
  };
  ctx.doc.sections.push(section);
  return section;
}

/** Content width (page width minus horizontal margins) in points. */
export function contentWidthPt(doc: DocDocument): number {
  const page = doc.sections[0]?.page ?? DEFAULT_PAGE;
  return Math.max(36, page.width - page.margins.left - page.margins.right);
}

/* ----------------------------------------------------- block constructors */

export interface ParagraphOptions {
  style?: string;
  props?: ParagraphProps;
}

/** Creates a paragraph owned by the import context. */
export function makeParagraph(
  ctx: DocumentContext,
  inlines: Inline[] = [],
  options: ParagraphOptions = {},
): Paragraph {
  return {
    type: "paragraph",
    id: ctx.next("p"),
    style: options.style ?? "Normal",
    props: { ...(options.props ?? {}) },
    inlines,
  };
}

/** Appends a paragraph with text and optional run formatting. */
export function appendTextParagraph(
  ctx: DocumentContext,
  target: Block[],
  text: string,
  options: ParagraphOptions & { runProps?: RunProps } = {},
): Paragraph {
  const inlines: Inline[] = [];
  pushText(inlines, text, options.runProps ?? {});
  const paragraph = makeParagraph(ctx, inlines, options);
  target.push(paragraph);
  return paragraph;
}

/* ---------------------------------------------------------- table builder */

export interface TableCellSpec {
  blocks?: Block[];
  /** Cell text (creates one paragraph unless `blocks` is supplied). */
  text?: string;
  runProps?: RunProps;
  props?: CellProps;
  gridSpan?: number;
  vMerge?: "restart" | "continue" | null;
}

export interface TableBuildOptions {
  columns?: number;
  columnWidths?: number[];
  headerRows?: number;
  style?: string;
  borders?: boolean;
  alignment?: TableProps["alignment"];
}

function defaultTableBorders(): NonNullable<TableProps["borders"]> {
  const border: Border = { style: "single", width: 0.5, color: "#000000" };
  return {
    top: { ...border },
    bottom: { ...border },
    left: { ...border },
    right: { ...border },
    between: { ...border },
  };
}

/** Builds a table block from plain cell specifications. */
export function buildTable(
  ctx: DocumentContext,
  rowSpecs: TableCellSpec[][],
  options: TableBuildOptions = {},
): Table {
  const columnCount = Math.max(
    options.columns ?? 0,
    ...rowSpecs.map((row) =>
      row.reduce((sum, cell) => sum + Math.max(1, cell.gridSpan ?? 1), 0),
    ),
    1,
  );
  const totalWidth =
    options.columnWidths?.reduce((sum, width) => sum + width, 0) ??
    contentWidthPt(ctx.doc);
  const widths =
    options.columnWidths && options.columnWidths.length === columnCount
      ? [...options.columnWidths]
      : new Array(columnCount).fill(totalWidth / columnCount);

  const rows: TableRow[] = rowSpecs.map((specs, rowIndex) => {
    const cells: TableCell[] = specs.map((spec, cellIndex) => {
      const span = Math.max(1, spec.gridSpan ?? 1);
      const width =
        widths
          .slice(cellIndex, cellIndex + span)
          .reduce((sum, value) => sum + value, 0) || totalWidth / columnCount;
      const blocks: Block[] = spec.blocks
        ? spec.blocks
        : [
            makeParagraph(
              ctx,
              spec.text
                ? (() => {
                    const inlines: Inline[] = [];
                    pushText(inlines, spec.text, spec.runProps ?? {});
                    return inlines;
                  })()
                : [],
              { style: "Normal" },
            ),
          ];
      return {
        id: ctx.next("cell"),
        props: {
          width: { value: width, type: "dxa" },
          gridSpan: span > 1 ? span : undefined,
          vMerge: spec.vMerge ?? undefined,
          vAlign: "top",
          ...(spec.props ?? {}),
        },
        blocks,
      };
    });
    const rowProps: RowProps = {
      isHeader:
        options.headerRows !== undefined && rowIndex < options.headerRows
          ? true
          : undefined,
      cantSplit: false,
    };
    return { id: ctx.next("row"), props: rowProps, cells };
  });

  const table: Table = {
    type: "table",
    id: ctx.next("tbl"),
    props: {
      style: options.style ?? "TableGrid",
      alignment: options.alignment ?? "left",
      width: { value: totalWidth, type: "dxa" },
      layout: "fixed",
      borders: options.borders === false ? undefined : defaultTableBorders(),
    },
    grid: widths,
    rows,
  };
  return table;
}

/* -------------------------------------------------------------- inline */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** Structural equality for run formatting. */
export function sameRunProps(
  a: RunProps | undefined,
  b: RunProps | undefined,
): boolean {
  return stableStringify(a ?? {}) === stableStringify(b ?? {});
}

/**
 * Appends text, merging with the previous run when formatting is identical.
 * Empty text is ignored so callers can pass optional fragments.
 */
export function pushText(
  inlines: Inline[],
  text: string,
  props: RunProps = {},
): void {
  if (text.length === 0) return;
  const previous = inlines[inlines.length - 1];
  if (
    previous &&
    previous.type === "text" &&
    sameRunProps(previous.props, props)
  ) {
    previous.text += text;
    return;
  }
  inlines.push({ type: "text", text, props: { ...props } });
}

/** Merges a partial run-formatting patch over existing properties. */
export function mergeRun(
  base: RunProps | undefined,
  patch: RunProps,
): RunProps {
  const result: RunProps = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(patch) as Array<
    [keyof RunProps, unknown]
  >) {
    if (value === undefined) continue;
    (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

/* -------------------------------------------------------- style helpers */

/** Adds a paragraph/character style definition when it is not present yet. */
export function ensureStyle(doc: DocDocument, style: StyleDef): StyleDef {
  const existing = doc.styles.styles[style.id];
  if (existing) return existing;
  doc.styles.styles[style.id] = style;
  return style;
}

/** Registers the monospace style used for `<pre>`, fenced code and RTF `\fmodern` runs. */
export function ensureCodeStyle(doc: DocDocument): string {
  ensureStyle(doc, {
    id: "Code",
    name: "Code",
    type: "paragraph",
    basedOn: "Normal",
    next: "Code",
    semiHidden: true,
    run: { fontFamily: "Consolas", fontSize: 10 },
    paragraph: { spaceBefore: 0, spaceAfter: 0, shading: { fill: "#f5f5f5" } },
  });
  ensureStyle(doc, {
    id: "CodeChar",
    name: "Code Char",
    type: "character",
    semiHidden: true,
    run: { fontFamily: "Consolas", fontSize: 10 },
  });
  return "Code";
}

/** Registers the blockquote style used by HTML/Markdown importers. */
export function ensureQuoteStyle(doc: DocDocument): string {
  ensureStyle(doc, {
    id: "Quote",
    name: "Quote",
    type: "paragraph",
    basedOn: "Normal",
    next: "Quote",
    run: { italic: true, color: "#404040" },
    paragraph: { indent: { left: 36, right: 36 }, spaceAfter: 8 },
  });
  return "Quote";
}

/* ------------------------------------------------------- loss reporting */

/** Accumulates conversion losses with automatic de-duplication. */
export class LossCollector {
  private readonly entries: ConversionLoss[] = [];
  private readonly seen = new Set<string>();

  /** Records a loss once per distinct feature/location pair. */
  add(loss: ConversionLoss): void {
    const key = `${loss.feature}|${loss.location ?? ""}|${loss.level}|${loss.reason}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.entries.push({ ...loss });
  }

  partial(
    feature: string,
    reason: string,
    location?: string,
    preserved = false,
  ): void {
    this.add({ feature, level: "partial", reason, location, preserved });
  }

  fallback(
    feature: string,
    reason: string,
    location?: string,
    preserved = false,
  ): void {
    this.add({ feature, level: "fallback", reason, location, preserved });
  }

  unsupported(
    feature: string,
    reason: string,
    location?: string,
    preserved = false,
  ): void {
    this.add({ feature, level: "unsupported", reason, location, preserved });
  }

  merge(losses: ConversionLoss[] | undefined): void {
    for (const loss of losses ?? []) this.add(loss);
  }

  get size(): number {
    return this.entries.length;
  }

  all(): ConversionLoss[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

/** Records an uninterpreted construct on the document so nothing is dropped. */
export function recordUnknown(
  doc: DocDocument,
  id: string,
  part: { location: string; element: string; xml?: string; reason: string },
): UnknownPart {
  const entry: UnknownPart = {
    id,
    location: part.location,
    element: part.element,
    xml: part.xml ?? "",
    reason: part.reason,
  };
  doc.unknown.push(entry);
  return entry;
}

/* ------------------------------------------------- compatibility report */

export interface CompatibilityReportInput {
  format: string;
  fileName?: string;
  features: FeatureSupport[];
  losses: ConversionLoss[];
  unknownElements: Array<{ element: string; count: number; location?: string }>;
}

/**
 * Builds a `CompatibilityReport` from adapter observations. `transparent` is
 * true only when every loss is either fully supported or preserved verbatim;
 * unrepresented constructs therefore always show up as `transparent: false`.
 */
export function buildCompatibilityReport(
  input: CompatibilityReportInput,
): CompatibilityReport {
  return {
    sourceFormat: input.format,
    sourceName: input.fileName,
    generatedAt: new Date().toISOString(),
    engine: "@dsh-doc/core",
    features: [...input.features].sort((a, b) =>
      a.feature.localeCompare(b.feature),
    ),
    losses: input.losses.map((loss) => ({ ...loss })),
    unknownElements: input.unknownElements.map((entry) => ({ ...entry })),
    transparent: input.losses.every(
      (loss) => loss.level === "full" || loss.preserved === true,
    ),
  };
}

/** Standard result wrapper used by every adapter's `import`. */
export function importResult(
  doc: DocDocument,
  losses: ConversionLoss[],
  warnings: string[] = [],
): FormatImportResult {
  return {
    document: doc,
    warnings: [...warnings],
    losses: losses.map((loss) => ({ ...loss })),
  };
}

/* ------------------------------------------------------------- CSS utils */

export type CssDeclarations = Map<string, string>;

/** Parses an inline `style` attribute into lower-cased property/value pairs. */
export function parseCssDeclarations(
  style: string | undefined | null,
): CssDeclarations {
  const out: CssDeclarations = new Map();
  if (!style) return out;
  for (const part of style.split(";")) {
    const index = part.indexOf(":");
    if (index <= 0) continue;
    const property = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (!property || !value) continue;
    const existing = out.get(property);
    // Later declarations win, except that a `!important` value keeps priority.
    if (
      existing &&
      existing.includes("!important") &&
      !value.includes("!important")
    )
      continue;
    out.set(property, value.replace(/\s*!important\s*$/i, ""));
  }
  return out;
}

const CSS_ABSOLUTE_UNITS: Record<string, number> = {
  pt: 1,
  px: 72 / 96,
  in: 72,
  cm: 72 / 2.54,
  mm: 72 / 25.4,
  pc: 12,
  q: 72 / 101.6,
};

/**
 * Converts a CSS length to points. Relative units are resolved against
 * `basePt` (font-relative) or `percentBase` (`%`). Returns undefined when the
 * value is not a length.
 */
export function cssLengthToPt(
  value: string | undefined | null,
  options: { basePt?: number; percentBase?: number } = {},
): number | undefined {
  if (!value) return undefined;
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*([a-z%]*)\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = (match[2] ?? "").toLowerCase();
  if (unit === "") return undefined;
  if (unit === "%") {
    const base = options.percentBase;
    return base === undefined ? undefined : (amount / 100) * base;
  }
  if (unit === "em" || unit === "rem") {
    const base = options.basePt ?? 12;
    return amount * base;
  }
  if (unit === "ex") {
    const base = options.basePt ?? 12;
    return amount * base * 0.5;
  }
  const factor = CSS_ABSOLUTE_UNITS[unit];
  return factor === undefined ? undefined : amount * factor;
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  white: "#ffffff",
  maroon: "#800000",
  red: "#ff0000",
  purple: "#800080",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  green: "#008000",
  lime: "#00ff00",
  olive: "#808000",
  yellow: "#ffff00",
  navy: "#000080",
  blue: "#0000ff",
  teal: "#008080",
  aqua: "#00ffff",
  cyan: "#00ffff",
  orange: "#ffa500",
  brown: "#a52a2a",
  pink: "#ffc0cb",
  gold: "#ffd700",
  indigo: "#4b0082",
  violet: "#ee82ee",
  transparent: "",
};

/** Normalises `#rgb`, `#rrggbb`, `rgb(...)` and CSS colour names to `#rrggbb`. */
export function normalizeCssColor(
  value: string | undefined | null,
): string | undefined {
  if (!value) return undefined;
  const input = value.trim().toLowerCase();
  if (input === "") return undefined;
  const named = NAMED_COLORS[input];
  if (named !== undefined) return named === "" ? undefined : named;
  if (/^#[0-9a-f]{3}$/.test(input)) {
    return `#${input[1]}${input[1]}${input[2]}${input[2]}${input[3]}${input[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(input)) return input;
  if (/^#[0-9a-f]{8}$/.test(input)) return input.slice(0, 7);
  const rgb =
    /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})/.exec(input);
  if (rgb) {
    const channels = [rgb[1], rgb[2], rgb[3]].map((channel) => {
      const number = Math.max(0, Math.min(255, Number(channel)));
      return number.toString(16).padStart(2, "0");
    });
    return `#${channels.join("")}`;
  }
  return undefined;
}

/* ------------------------------------------------------------ image utils */

export interface DecodedDataUri {
  contentType: string;
  data: Buffer;
}

/** Decodes a `data:` URI; accepts the base64 form (the only safe form). */
export function decodeDataUri(
  uri: string | undefined | null,
): DecodedDataUri | undefined {
  if (!uri) return undefined;
  const match = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/is.exec(uri.trim());
  if (!match) return undefined;
  const contentType = match[1]?.trim() || "application/octet-stream";
  const parameters = match[2] ?? "";
  const payload = match[3] ?? "";
  if (!/;base64/i.test(parameters)) {
    try {
      return {
        contentType,
        data: Buffer.from(decodeURIComponent(payload), "utf8"),
      };
    } catch {
      return undefined;
    }
  }
  try {
    return {
      contentType,
      data: Buffer.from(payload.replace(/\s+/g, ""), "base64"),
    };
  } catch {
    return undefined;
  }
}

export interface ImageInfo {
  contentType: string;
  extension: string;
  widthPx?: number;
  heightPx?: number;
}

/** Sniffs common raster image headers and reads their pixel dimensions. */
export function sniffImage(data: Buffer): ImageInfo | undefined {
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47) {
    const widthPx = data.length >= 24 ? data.readUInt32BE(16) : undefined;
    const heightPx = data.length >= 24 ? data.readUInt32BE(20) : undefined;
    return { contentType: "image/png", extension: "png", widthPx, heightPx };
  }
  if (data.length >= 10 && data.toString("ascii", 0, 4) === "GIF8") {
    return {
      contentType: "image/gif",
      extension: "gif",
      widthPx: data.readUInt16LE(6),
      heightPx: data.readUInt16LE(8),
    };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    const size = jpegSize(data);
    return { contentType: "image/jpeg", extension: "jpeg", ...size };
  }
  if (data.length >= 26 && data.toString("ascii", 0, 2) === "BM") {
    return {
      contentType: "image/bmp",
      extension: "bmp",
      widthPx: data.readInt32LE(18),
      heightPx: Math.abs(data.readInt32LE(22)),
    };
  }
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  return undefined;
}

function jpegSize(data: Buffer): { widthPx?: number; heightPx?: number } {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);
    // SOF0..SOF15 excluding DHT/JPG/DAC.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        heightPx: data.readUInt16BE(offset + 5),
        widthPx: data.readUInt16BE(offset + 7),
      };
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return {};
}

export interface AddImageOptions {
  data: Buffer;
  contentType?: string;
  fileName?: string;
  alt?: string;
  title?: string;
  /** Requested display width in points (height follows the aspect ratio). */
  width?: number;
  height?: number;
}

/**
 * Registers an image in the media table and returns an inline image sized from
 * its natural pixel dimensions, clamped to the content width.
 */
export function addImageInline(
  ctx: DocumentContext,
  options: AddImageOptions,
): ImageInline {
  const info = sniffImage(options.data);
  const contentType =
    options.contentType ?? info?.contentType ?? "application/octet-stream";
  const naturalWidthPx = info?.widthPx;
  const naturalHeightPx = info?.heightPx;
  const mediaId = addMedia(ctx.doc, {
    data: options.data,
    contentType,
    fileName: options.fileName,
    widthPx: naturalWidthPx,
    heightPx: naturalHeightPx,
  });
  let width = options.width;
  let height = options.height;
  if (width === undefined) {
    width = naturalWidthPx ? pxToPt(naturalWidthPx) : 240;
  }
  if (height === undefined) {
    if (naturalWidthPx && naturalHeightPx && width !== undefined) {
      height = (width * naturalHeightPx) / naturalWidthPx;
    } else {
      height = 180;
    }
  }
  const maxWidth = contentWidthPt(ctx.doc);
  if (width > maxWidth) {
    height = (height * maxWidth) / width;
    width = maxWidth;
  }
  return {
    type: "image",
    mediaId,
    width,
    height,
    naturalWidthPx,
    naturalHeightPx,
    alt: options.alt,
    title: options.title,
    anchor: { type: "inline" },
    border: null,
  };
}

/** Looks up a media asset by id (exporters need the base64 payload). */
export function findMedia(
  doc: DocDocument,
  mediaId: string,
): MediaAsset | undefined {
  return doc.media.find((asset) => asset.id === mediaId);
}
