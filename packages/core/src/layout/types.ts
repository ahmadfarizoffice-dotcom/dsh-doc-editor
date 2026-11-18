/** Layout engine output types. Geometry is in points, origin at page top-left. */

export interface FontSpec {
  /** Requested family name from the document. */
  family: string;
  /** Concrete metric family used for measurement. */
  metricFamily: string;
  size: number;
  bold: boolean;
  italic: boolean;
}

export interface TextDecoration {
  underline?: boolean;
  strike?: boolean;
  doubleStrike?: boolean;
  outline?: boolean;
}

export interface LayoutTextRun {
  text: string;
  /** Offset from the parent box's left edge. */
  x: number;
  width: number;
  font: FontSpec;
  color?: string;
  highlight?: string;
  background?: string;
  decoration?: TextDecoration;
  /** Baseline offset in points relative to the box top (used by renderers). */
  baseline: number;
  vertAlign?: "superscript" | "subscript" | "baseline";
  hyperlink?: { href?: string; anchor?: string };
  commentIds?: string[];
  revision?: { kind: "insert" | "delete" | "format"; author?: string };
}

export type BoxKind =
  "text" | "image" | "rect" | "line" | "shape" | "math" | "field";

interface BoxBase {
  /** Deterministic id (page-local). */
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Source block/paragraph id for selection and page-info queries. */
  blockId?: string;
  /** Source table/cell id when nested. */
  tableId?: string;
  cellId?: string;
  /** Z-order within the page; higher paints later. */
  z?: number;
}

export interface TextLineBox extends BoxBase {
  kind: "text";
  runs: LayoutTextRun[];
  alignment: "left" | "center" | "right" | "justify";
  /** Baseline y within the page (absolute). */
  baseline: number;
  language?: string;
  direction?: "ltr" | "rtl";
  /** True when this is the first line of its paragraph. */
  firstLine?: boolean;
  /** List label rendered for this line. */
  listLabel?: string;
}

export interface ImageBox extends BoxBase {
  kind: "image";
  mediaId: string;
  contentType: string;
  alt?: string;
  border?: { style: string; width: number; color?: string } | null;
  crop?: { left: number; top: number; right: number; bottom: number };
}

export interface RectBox extends BoxBase {
  kind: "rect";
  fill?: string;
  border?: {
    top?: { width: number; color?: string; style: string };
    bottom?: { width: number; color?: string; style: string };
    left?: { width: number; color?: string; style: string };
    right?: { width: number; color?: string; style: string };
  };
  radius?: number;
}

export interface RuleBox extends BoxBase {
  kind: "line";
  color: string;
  thickness: number;
}

export interface ShapeBox extends BoxBase {
  kind: "shape";
  shapeId: string;
  fill?: string;
  border?: { width: number; color?: string };
  preset?: string;
}

export interface MathBox extends BoxBase {
  kind: "math";
  text: string;
  font: FontSpec;
}

export type LayoutBox =
  TextLineBox | ImageBox | RectBox | RuleBox | ShapeBox | MathBox;

export interface LayoutRegion {
  /** Region frame in page coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  boxes: LayoutBox[];
}

export interface LayoutColumnFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutPage {
  /** Zero-based page index in the document. */
  index: number;
  /** Displayed page number (honours section page numbering). */
  displayNumber: number;
  sectionIndex: number;
  width: number;
  height: number;
  orientation: "portrait" | "landscape";
  background?: string;
  pageBorders?: {
    top?: { width: number; color?: string; style: string };
    bottom?: { width: number; color?: string; style: string };
    left?: { width: number; color?: string; style: string };
    right?: { width: number; color?: string; style: string };
    offsetFrom?: "page" | "text";
  };
  columns: LayoutColumnFrame[];
  header?: LayoutRegion;
  footer?: LayoutRegion;
  boxes: LayoutBox[];
  /** Reserved footnote area at the bottom of the content, when present. */
  footnoteRegion?: LayoutRegion;
}

export interface TocEntryLayout {
  blockId: string;
  level: number;
  text: string;
  page: number;
}

export interface LayoutWarning {
  code: string;
  message: string;
  blockId?: string;
}

export interface LayoutOptions {
  /** Layout scale (content unaffected; renderers use it for CSS). */
  zoom?: number;
  /** Show headers/footers (default true). */
  headersFooters?: boolean;
  /** How tracked changes are projected. */
  revisionMode?: "all" | "final" | "original";
  /** Enable hyphenation heuristics (default false). */
  hyphenate?: boolean;
  /** Custom font substitution map (family → metric family). */
  fontSubstitutions?: Record<string, string>;
  /** Maximum pagination passes for TOC/page-number convergence (default 3). */
  maxPasses?: number;
}

export interface LayoutResult {
  pages: LayoutPage[];
  pageCount: number;
  /** Block id → 1-based page number where it starts. */
  pageNumberByBlock: Map<string, number>;
  tocEntries: TocEntryLayout[];
  warnings: LayoutWarning[];
  stats: {
    lines: number;
    tables: number;
    images: number;
    footnotes: number;
  };
  /** Font families substituted during layout. */
  substitutedFonts: string[];
  durationMs: number;
}

export interface PageInfo {
  pageCount: number;
  blockPage: number | null;
  blockId: string;
  page: {
    index: number;
    displayNumber: number;
    width: number;
    height: number;
    orientation: "portrait" | "landscape";
    sectionIndex: number;
  } | null;
}
