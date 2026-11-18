/**
 * Versioned, format-independent document model.
 *
 * Everything in the platform (editor UI, layout engine, renderer, conversion
 * engine, AI assistant, MCP server) operates on these structures. Geometry is
 * expressed in typographic points (1pt = 1/72 inch).
 */

export const DOCUMENT_SCHEMA_VERSION = "1.0.0" as const;
export type DocumentSchemaVersion = typeof DOCUMENT_SCHEMA_VERSION;

/* ------------------------------------------------------------------ units */

/** Points (1pt = 1/72in). */
export type Pt = number;
export const TWIPS_PER_PT = 20;
export const PT_PER_INCH = 72;
export const EMU_PER_PT = 12700;

export const twipsToPt = (v: number): Pt => v / TWIPS_PER_PT;
export const ptToTwips = (v: Pt): number => Math.round(v * TWIPS_PER_PT);
export const emuToPt = (v: number): Pt => v / EMU_PER_PT;
export const pxToPt = (v: number): Pt => (v * PT_PER_INCH) / 96;
export const ptToPx = (v: Pt): number => (v * 96) / PT_PER_INCH;
export const cmToPt = (v: number): Pt => (v * PT_PER_INCH) / 2.54;
export const mmToPt = (v: number): Pt => (v * PT_PER_INCH) / 25.4;

/* -------------------------------------------------------------- text model */

export type UnderlineStyle =
  "single" | "double" | "dotted" | "dash" | "wave" | "thick" | "none" | "words";

export type VerticalAlign = "baseline" | "superscript" | "subscript";

export interface ThemeFonts {
  major: { latin: string; eastAsia: string; complexScript: string };
  minor: { latin: string; eastAsia: string; complexScript: string };
}

/** Effective character formatting. Style values are resolved before layout. */
export interface RunProps {
  /** Resolved concrete font family name (theme references already substituted). */
  fontFamily?: string;
  /** Font family for East Asian characters, when the document distinguishes it. */
  fontFamilyEastAsia?: string;
  fontFamilyComplexScript?: string;
  /** Font size in points. */
  fontSize?: Pt;
  bold?: boolean;
  italic?: boolean;
  underline?: UnderlineStyle | false;
  underlineColor?: string;
  strike?: boolean;
  doubleStrike?: boolean;
  /** Text outline (w:outline) - rendered as a hairline outline. */
  outline?: boolean;
  shadow?: boolean;
  emboss?: boolean;
  imprint?: boolean;
  vertAlign?: VerticalAlign;
  /** Text colour, `#rrggbb`. */
  color?: string;
  /** Highlight colour, `#rrggbb` or a Word highlight name. */
  highlight?: string;
  /** Character background shading, `#rrggbb`. */
  background?: string;
  /** Character spacing adjustment in points (w:spacing, positive = expanded). */
  charSpacing?: Pt;
  /** w:w character scaling percentage (100 = normal). */
  charScale?: number;
  /** w:kern, minimum font size in points for kerning. */
  kerning?: Pt;
  caps?: boolean;
  smallCaps?: boolean;
  /** Complex-script / bidi run. */
  rtl?: boolean;
  language?: string;
  languageEastAsia?: string;
  languageBidi?: string;
  /** Hidden text (w:vanish). */
  hidden?: boolean;
  /** Non-printing web-hidden text (w:webHidden). */
  webHidden?: boolean;
  /** `w:specVanish` - Word's marker for list-numbering runs. */
  specVanish?: boolean;
  /** Character style id applied to this run (w:rStyle). */
  characterStyle?: string;
  /** Hyperlink destination attached as a run mark. */
  hyperlink?: HyperlinkTarget;
  /** Revision mark attached to this run. */
  revision?: RevisionMark;
  /** Preserved OOXML run properties this model does not interpret yet. */
  extensions?: Record<string, string>;
}

export interface HyperlinkTarget {
  href?: string;
  /** Internal bookmark target (w:anchor). */
  anchor?: string;
  tooltip?: string;
  targetFrame?: string;
  /** Whether the link is a mailto / external relationship. */
  external?: boolean;
}

export type RevisionKind = "insert" | "delete" | "format";

export interface RevisionMark {
  id: string;
  kind: RevisionKind;
  author?: string;
  /** ISO-8601 timestamp as recorded by the source. */
  date?: string;
  /** For format revisions: the previous formatting, JSON encoded. */
  previous?: string;
}

export type BreakKind = "line" | "page" | "column";

export interface TextRun {
  type: "text";
  /** UTF-16 text exactly as stored. */
  text: string;
  props: RunProps;
}

export interface TabInline {
  type: "tab";
  props?: RunProps;
}

export interface BreakInline {
  type: "break";
  kind: BreakKind;
  props?: RunProps;
}

export interface ImageInline {
  type: "image";
  mediaId: string;
  /** Displayed width in points. */
  width: Pt;
  /** Displayed height in points. */
  height: Pt;
  /** Natural pixel dimensions, used for aspect-ratio preserving resize. */
  naturalWidthPx?: number;
  naturalHeightPx?: number;
  /** Crop fractions (0..1) for each edge. */
  crop?: { left: number; top: number; right: number; bottom: number };
  /** Alt text from OOXML description/title. */
  alt?: string;
  title?: string;
  /** Anchor behaviour. `inline` participates in the text flow. */
  anchor?: ImageAnchor;
  border?: Border | null;
  /** Layout effect hint; `none` means inline. */
  props?: RunProps;
}

export interface ImageAnchor {
  /** `inline` runs in the text flow; `floating` is positioned relative to a frame. */
  type: "inline" | "floating";
  /** Horizontal/vertical relative-from + relative-to information. */
  position?: {
    horizontal?: AnchorPosition;
    vertical?: AnchorPosition;
  };
  wrap?: TextWrap;
  /** Behind text / in front of text. */
  behindText?: boolean;
  /** Whether the anchor is locked to its paragraph. */
  lockAnchor?: boolean;
  /** Distance from the anchor in points, when supplied by the source. */
  distances?: { top: Pt; bottom: Pt; left: Pt; right: Pt };
  /** w:simplePos offsets. */
  simplePosition?: { x: Pt; y: Pt };
  /** `relativeHeight` for z-ordering. */
  zOrder?: number;
}

export interface AnchorPosition {
  /** Edge of the object to align (left/right/top/bottom/center). */
  align?: "left" | "right" | "top" | "bottom" | "center" | "inside" | "outside";
  /** Offset in points from `relativeTo` edge. */
  offset?: Pt;
  /** Reference frame. */
  relativeTo?:
    | "margin"
    | "page"
    | "column"
    | "character"
    | "paragraph"
    | "line"
    | "leftMargin"
    | "rightMargin"
    | "topMargin"
    | "bottomMargin"
    | "insideMargin"
    | "outsideMargin";
}

export type TextWrap =
  | { type: "none" }
  | {
      type: "square";
      wrapSide?: "both" | "left" | "right" | "largest";
      distances?: number[];
    }
  | { type: "tight"; wrapSide?: string; distances?: number[] }
  | { type: "through"; wrapSide?: string; distances?: number[] }
  | { type: "topAndBottom"; distances?: number[] };

export interface FieldInline {
  type: "field";
  /** Field instruction, e.g. `PAGE`, `NUMPAGES`, `TOC \o "1-3"`. */
  instr: string;
  /** Whether the source used `fldSimple` (true) or a complex field (false). */
  simple: boolean;
  /** Cached field result as inlines; recomputed by the layout engine for known fields. */
  result?: Inline[];
  /** Complex-field bookkeeping. */
  dirty?: boolean;
  lock?: boolean;
}

export interface NoteRefInline {
  type: "noteRef";
  noteId: string;
  noteType: "footnote" | "endnote";
}

export interface CommentRefInline {
  type: "commentRef";
  commentId: string;
  /** Anchor marks the range start; `end` markers carry `kind: "end"`. */
  kind: "point" | "rangeStart" | "rangeEnd";
}

export interface BookmarkMarkInline {
  type: "bookmark";
  name: string;
  bookmarkId: string;
  kind: "start" | "end";
}

export interface MathRun {
  type: "math";
  /** Structured math content (Office Math Markup subset). */
  math: MathNode[];
  /** Fallback linear text so the content is never lost. */
  linear: string;
  display?: boolean;
}

export type MathNode =
  | {
      kind: "run";
      text: string;
      italic?: boolean;
      bold?: boolean;
      script?: "normal" | "script" | "fraktur" | "double";
    }
  | { kind: "fraction"; numerator: MathNode[]; denominator: MathNode[] }
  | { kind: "superscript"; base: MathNode[]; superscript: MathNode[] }
  | { kind: "subscript"; base: MathNode[]; subscript: MathNode[] }
  | { kind: "subsup"; base: MathNode[]; sub: MathNode[]; sup: MathNode[] }
  | { kind: "radical"; degree: MathNode[]; radicand: MathNode[] }
  | {
      kind: "delimited";
      begin?: string;
      end?: string;
      separator?: string;
      children: MathNode[];
    }
  | { kind: "function"; name: string; argument: MathNode[] }
  | {
      kind: "nary";
      operator: string;
      sub?: MathNode[];
      sup?: MathNode[];
      body: MathNode[];
    }
  | { kind: "bar"; position: "top" | "bottom"; body: MathNode[] }
  | { kind: "accent"; char: string; body: MathNode[] }
  | { kind: "matrix"; rows: MathNode[][][] }
  | { kind: "group"; children: MathNode[] }
  | { kind: "space"; width?: number }
  | { kind: "unknown"; raw: string; linear: string };

/** An inline reference to an anchored drawing (text box, shape, chart, ...). */
export interface ShapeRefInline {
  type: "shape";
  shapeId: string;
  props?: RunProps;
}

export interface UnknownInline {
  type: "unknown";
  /** Local OOXML element name, e.g. `w:sdt` or `w:object`. */
  element: string;
  /** Original XML, preserved verbatim for round-trip fidelity. */
  raw: string;
  /** Plain-text projection so search/text extraction still sees the content. */
  text?: string;
  note?: string;
}

export type Inline =
  | TextRun
  | TabInline
  | BreakInline
  | ImageInline
  | FieldInline
  | NoteRefInline
  | CommentRefInline
  | BookmarkMarkInline
  | MathRun
  | ShapeRefInline
  | UnknownInline;

/* -------------------------------------------------------------- paragraphs */

export type Alignment = "left" | "center" | "right" | "justify" | "distribute";

export interface TabStop {
  position: Pt;
  alignment: "left" | "center" | "right" | "decimal" | "bar" | "clear" | "num";
  leader?: "none" | "dot" | "hyphen" | "underscore" | "heavy" | "middleDot";
}

export interface Indentation {
  left?: Pt;
  right?: Pt;
  /** First-line indent (positive) in points. */
  firstLine?: Pt;
  /** Hanging indent (positive value stored; applied as negative first line). */
  hanging?: Pt;
  /** Mirror indents for facing pages. */
  mirror?: boolean;
}

export interface LineSpacing {
  /** `auto` multiplies single line height, `exact`/`atLeast` are absolute points. */
  rule: "auto" | "exact" | "atLeast";
  /** Multiplier when rule is `auto` (240 = single). */
  value: number;
}

export interface Shading {
  /** `#rrggbb` */
  fill?: string;
  /** OOXML pattern, recorded for round-trip; rendered as `fill` approximation. */
  pattern?: string;
  color?: string;
}

export type BorderStyle =
  | "none"
  | "single"
  | "thick"
  | "double"
  | "dotted"
  | "dashed"
  | "dotDash"
  | "dotDotDash"
  | "triple"
  | "wave"
  | "doubleWave"
  | "dashSmallGap"
  | "dashDotStroked"
  | "threeDEmboss"
  | "threeDEngrave"
  | "outset"
  | "inset";

export interface Border {
  style: BorderStyle;
  width: Pt;
  color?: string;
  /** Empty border explicitly removes inheritance. */
  none?: boolean;
  /** Space in points between border and text (w:space, 0..31). */
  space?: Pt;
  shadow?: boolean;
}

export interface BorderSet {
  top?: Border;
  bottom?: Border;
  left?: Border;
  right?: Border;
  between?: Border;
  bar?: Border;
}

export interface NumberingRef {
  numId: string;
  level: number;
  /** Override the start value for this list (w:lvlOverride/w:startOverride). */
  startOverride?: number;
  /** Explicit label text override (used by "restart/continue numbering"). */
  labelOverride?: string;
}

/** Effective paragraph formatting. */
export interface ParagraphProps {
  alignment?: Alignment;
  /** Vertical alignment of text within the line box (table cells). */
  lineSpacing?: LineSpacing;
  spaceBefore?: Pt;
  spaceAfter?: Pt;
  beforeAutospacing?: boolean;
  afterAutospacing?: boolean;
  indent?: Indentation;
  tabStops?: TabStop[];
  borders?: BorderSet;
  shading?: Shading;
  numbering?: NumberingRef;
  keepNext?: boolean;
  keepLines?: boolean;
  widowControl?: boolean;
  pageBreakBefore?: boolean;
  /** Outline level 0..8 (0 = Heading 1). */
  outlineLevel?: number;
  /** Paragraph direction for bidi text. */
  bidi?: boolean;
  /** `contextualSpacing` - suppress spacing between same-style paragraphs. */
  contextualSpacing?: boolean;
  /** Snap to document grid. */
  snapToGrid?: boolean;
  /** Suppress line numbers in the margin. */
  suppressLineNumbers?: boolean;
  /** Right-to-left paragraph gutter. */
  textDirection?: "lrTb" | "tbRl" | "btLr" | "lrTbV" | "tbLrV" | "tbRlV";
  /** Frame properties for positioned paragraphs (text boxes / frames). */
  frame?: FrameProps;
  /** Preserved OOXML paragraph properties this model does not interpret yet. */
  extensions?: Record<string, string>;
}

export interface FrameProps {
  width: Pt;
  height: Pt;
  x: Pt;
  y: Pt;
  wrap?: TextWrap;
  anchorLock?: boolean;
  dropCap?: "none" | "drop" | "margin";
  lines?: number;
  hAnchor?: "margin" | "page" | "text";
  vAnchor?: "margin" | "page" | "text";
}

export interface Paragraph {
  type: "paragraph";
  id: string;
  /** Paragraph style id (Normal, Title, Heading1, ...). */
  style?: string;
  /** Direct formatting applied on top of the style. */
  props: ParagraphProps;
  inlines: Inline[];
  /** Tracked-change mark on the paragraph mark itself. */
  revision?: RevisionMark;
  /** Section properties that end at this paragraph (paragraph-level sectPr). */
  sectionEnd?: SectionPropertiesRef;
  /** Raw OOXML of unknown properties, preserved for round-trip. */
  raw?: { element?: string; xml?: string };
}

/* ------------------------------------------------------------------ tables */

export interface TableProps {
  style?: string;
  alignment?: "left" | "center" | "right";
  width?: { value: Pt; type: "auto" | "dxa" | "pct" };
  layout?: "fixed" | "autofit";
  indent?: Pt;
  borders?: BorderSet;
  /** Cell spacing in points (legacy `tblCellSpacing`). */
  cellSpacing?: Pt;
  cellMargins?: CellMargins;
  shading?: Shading;
  /** Table-level alignment/positioning for floating tables. */
  floating?: {
    x?: AnchorPosition;
    y?: AnchorPosition;
    wrap?: TextWrap;
    overlap?: boolean;
  };
  /** Table style conditional formatting flags (tblLook). */
  look?: {
    firstRow?: boolean;
    lastRow?: boolean;
    firstColumn?: boolean;
    lastColumn?: boolean;
    noHBand?: boolean;
    noVBand?: boolean;
  };
  extensions?: Record<string, string>;
}

export interface CellMargins {
  top?: Pt;
  right?: Pt;
  bottom?: Pt;
  left?: Pt;
}

export interface RowProps {
  height?: Pt;
  heightRule?: "auto" | "atLeast" | "exact";
  isHeader?: boolean;
  cantSplit?: boolean;
  /** Row level gridBefore/gridAfter for irregular tables. */
  gridBefore?: number;
  gridAfter?: number;
  alignment?: Alignment;
  shading?: Shading;
}

export interface CellProps {
  width?: { value: Pt; type: "auto" | "dxa" | "pct" };
  gridSpan?: number;
  vMerge?: "restart" | "continue" | null;
  vAlign?: "top" | "center" | "bottom";
  background?: Shading;
  borders?: BorderSet;
  margins?: CellMargins;
  textDirection?: ParagraphProps["textDirection"];
  /** w:tcFitText */
  fitText?: boolean;
  wrapText?: boolean;
  extensions?: Record<string, string>;
}

export interface TableCell {
  id: string;
  props: CellProps;
  blocks: Block[];
}

export interface TableRow {
  id: string;
  props: RowProps;
  cells: TableCell[];
}

export interface Table {
  type: "table";
  id: string;
  props: TableProps;
  /** Column widths in points, from tblGrid; empty means computed. */
  grid: Pt[];
  rows: TableRow[];
}

/* ------------------------------------------------------------- text boxes */

export interface ShapeTextBox {
  id: string;
  kind: "textbox";
  anchor: ImageAnchor;
  width: Pt;
  height: Pt;
  fill?: string;
  line?: Border | null;
  blocks: Block[];
  /** VML/DrawingML shape preset, e.g. `rect`, `roundRect`, `ellipse`. */
  preset?: string;
  rotation?: number;
}

export type Shape = ShapeTextBox;

/* ---------------------------------------------------------------- sections */

export interface PageMargins {
  top: Pt;
  right: Pt;
  bottom: Pt;
  left: Pt;
  header: Pt;
  footer: Pt;
  gutter: Pt;
}

export interface PageBorders {
  top?: Border;
  bottom?: Border;
  left?: Border;
  right?: Border;
  /** Offset from page edge in points. */
  offsetFrom?: "page" | "text";
  /** Border display: all pages, first page only, or all but first. */
  display?: "allPages" | "firstPage" | "notFirstPage";
  zOrder?: "front" | "back";
}

export interface PageSetup {
  width: Pt;
  height: Pt;
  orientation: "portrait" | "landscape";
  margins: PageMargins;
  borders?: PageBorders;
  /** `#rrggbb` page background colour. */
  pageColor?: string;
  /** Document grid line pitch in points, used for East-Asian layout. */
  linePitch?: Pt;
  /** Character pitch for grid layout. */
  charPitch?: Pt;
  /** Preset paper name when known (A4, Letter, Legal, ...). */
  preset?: string;
}

export interface ColumnSetup {
  count: number;
  space: Pt;
  /** Explicit per-column widths in points (w:col). */
  widths?: Pt[];
  separator?: boolean;
  equalWidth?: boolean;
}

export interface HeaderFooter {
  id: string;
  blocks: Block[];
}

export interface HeaderFooterSet {
  default?: HeaderFooter;
  first?: HeaderFooter;
  even?: HeaderFooter;
}

export interface PageNumbering {
  start?: number;
  /** `decimal`, `lowerRoman`, `upperRoman`, `lowerLetter`, `upperLetter`, ... */
  format?: string;
}

export type SectionBreakType =
  "nextPage" | "continuous" | "oddPage" | "evenPage";

export interface Section {
  id: string;
  blocks: Block[];
  page: PageSetup;
  columns: ColumnSetup;
  headers: HeaderFooterSet;
  footers: HeaderFooterSet;
  pageNumbering?: PageNumbering;
  breakBefore: SectionBreakType;
  titlePage: boolean;
  evenAndOdd: boolean;
  /** w:footnotePr / w:endnotePr restarts */
  footnoteRestart?: "continuous" | "eachSect" | "eachPage";
  endnoteRestart?: "continuous" | "eachSect" | "eachPage";
}

/** Reference kept on the paragraph that terminates a section. */
export interface SectionPropertiesRef {
  /** Section index in the document. */
  sectionIndex: number;
}

/* ------------------------------------------------------------ annotations */

export interface Note {
  id: string;
  type: "footnote" | "endnote";
  blocks: Block[];
  /** Footnote reference mark (automatic numbering when undefined). */
  customMark?: string;
}

export interface DocComment {
  id: string;
  author: string;
  initials?: string;
  date?: string;
  blocks: Block[];
  resolved: boolean;
  /** Parent comment id for threaded replies. */
  parentId?: string;
  /** Paragraph + offset anchor when the comment is range-based. */
  anchor?: { paragraphId: string; start: number; end: number };
}

export interface Revision {
  id: string;
  kind: RevisionKind;
  author?: string;
  date?: string;
  /** Human readable summary for the revision history pane. */
  summary: string;
  /** Block ids affected by this revision. */
  blockIds: string[];
}

export interface Bookmark {
  name: string;
  id: string;
  paragraphId: string;
}

/* ------------------------------------------------------------------- media */

export interface MediaAsset {
  id: string;
  fileName: string;
  contentType: string;
  /** Base64 payload. Kept in the model so a document is self-contained. */
  data: string;
  /** Bytes length of the decoded payload. */
  byteLength: number;
  widthPx?: number;
  heightPx?: number;
  /** DPI for converting pixel dimensions to points when the source omits size. */
  dpi?: number;
}

/* -------------------------------------------------------------- style sheet */

export interface DocDefaults {
  run?: RunProps;
  paragraph?: ParagraphProps;
  /** Default tab stop interval in points (w:defaultTabStop). */
  defaultTabStop?: Pt;
}

export interface TableStyleProps {
  borders?: BorderSet;
  cellMargins?: CellMargins;
  shading?: Shading;
  /** Conditional formats keyed by firstRow/lastRow/firstColumn/... */
  conditional?: Record<
    string,
    {
      run?: RunProps;
      paragraph?: ParagraphProps;
      shading?: Shading;
      borders?: BorderSet;
    }
  >;
}

export interface StyleDef {
  id: string;
  name: string;
  type: "paragraph" | "character" | "table" | "numbering";
  basedOn?: string;
  next?: string;
  link?: string;
  isDefault?: boolean;
  /** Whether the style is offered in the editor's style gallery. */
  qFormat?: boolean;
  uiPriority?: number;
  semiHidden?: boolean;
  paragraph?: ParagraphProps;
  run?: RunProps;
  table?: TableStyleProps;
}

export interface StyleSheet {
  defaults: DocDefaults;
  styles: Record<string, StyleDef>;
}

export interface ListLevel {
  level: number;
  start: number;
  /** OOXML numFmt: decimal, lowerRoman, upperLetter, bullet, none, ... */
  numFmt: string;
  /** `%1.`, `%1.%2.`, bullet glyph, etc. */
  lvlText: string;
  lvlJc: "left" | "center" | "right";
  suff?: "tab" | "space" | "nothing";
  pStyle?: string;
  paragraph?: ParagraphProps;
  run?: RunProps;
  restartAfter?: number;
  /** Legacy list item - numbering continues through a lower level. */
  isLegal?: boolean;
  /** Picture bullet id (w:lvlPicBulletId) - preserved but not rendered as bitmap. */
  pictureBulletId?: string;
}

export interface AbstractNum {
  id: string;
  multiLevelType?: "singleLevel" | "multilevel" | "hybridMultilevel";
  levels: ListLevel[];
}

export interface NumInstance {
  id: string;
  abstractId: string;
  levelOverrides?: Record<
    number,
    Partial<
      Pick<ListLevel, "start" | "lvlText" | "numFmt" | "paragraph" | "run">
    >
  >;
}

export interface NumberingDefs {
  abstract: Record<string, AbstractNum>;
  nums: Record<string, NumInstance>;
}

export interface Theme {
  fonts: ThemeFonts;
  /** Theme colour scheme, key -> `#rrggbb`. */
  colors: Record<string, string>;
  name?: string;
}

export interface DocSettings {
  defaultTabStop: Pt;
  evenAndOddHeaders: boolean;
  trackRevisions: boolean;
  autoHyphenation: boolean;
  /** Language default for character formatting. */
  defaultLanguage?: string;
  /** w:compat compatibility mode, preserved. */
  compatibilityMode?: string;
  /** Whether math is rendered as OMML (true) or fallback text. */
  mathFormat?: "omml";
}

export interface DocMetadata {
  title?: string;
  subject?: string;
  creator?: string;
  lastModifiedBy?: string;
  keywords: string[];
  description?: string;
  category?: string;
  /** ISO-8601 */
  created?: string;
  modified?: string;
  revision?: string;
  /** Custom document properties. */
  custom: Record<string, string>;
  /** Source application metadata (docProps/app.xml) preserved verbatim. */
  app?: Record<string, string>;
}

export interface CustomXmlPart {
  itemPath: string;
  xml: string;
}

/* ---------------------------------------------------------- compatibility */

export type SupportLevel = "full" | "partial" | "fallback" | "unsupported";

export interface FeatureSupport {
  /** Stable feature id, e.g. `paragraph.alignment`. */
  feature: string;
  /** Human readable label. */
  label: string;
  level: SupportLevel;
  /** How many occurrences were found in the imported document. */
  occurrences: number;
  notes?: string;
}

export interface LossEntry {
  /** Element or feature that was not fully preserved. */
  feature: string;
  level: SupportLevel;
  reason: string;
  /** Where it was observed, e.g. `section[1].blocks[12]`. */
  location?: string;
  /** Raw content preserved for round-trip, when available. */
  preserved?: boolean;
}

export interface CompatibilityReport {
  sourceFormat: string;
  sourceName?: string;
  generatedAt: string;
  engine: string;
  features: FeatureSupport[];
  losses: LossEntry[];
  /** Elements encountered but not interpreted; always reported. */
  unknownElements: Array<{ element: string; count: number; location?: string }>;
  /** True when nothing was silently dropped. */
  transparent: boolean;
}

/* -------------------------------------------------------------- the document */

export interface UnknownPart {
  id: string;
  /** Location descriptor, e.g. `section[0].blocks[3]` or `part:word/glossary/document.xml`. */
  location: string;
  /** Element name or part name. */
  element: string;
  /** Original XML (for elements) or a note (for whole parts). */
  xml: string;
  reason: string;
}

export type Block = Paragraph | Table | TocBlock;

/**
 * A generated table of contents. The layout engine expands it into entries and
 * resolves page numbers; export writes a real OOXML TOC field with cached
 * results so other word processors can refresh it.
 */
export interface TocBlock {
  type: "toc";
  id: string;
  minLevel: number;
  maxLevel: number;
  hyperlinks: boolean;
  pageNumbers: boolean;
  tabLeader: "dot" | "none" | "underscore" | "hyphen";
  /** Include the Title style as an entry. */
  includeTitle?: boolean;
  /** Optional caption paragraph inserted above the TOC by the creator. */
  caption?: string;
  /** Preserved field instruction (`TOC \o "1-3" \h \z \u`). */
  instruction?: string;
}

export interface DocDocument {
  schemaVersion: DocumentSchemaVersion;
  id: string;
  metadata: DocMetadata;
  theme: Theme;
  styles: StyleSheet;
  numbering: NumberingDefs;
  sections: Section[];
  footnotes: Note[];
  endnotes: Note[];
  comments: DocComment[];
  revisions: Revision[];
  bookmarks: Bookmark[];
  shapes: Shape[];
  media: MediaAsset[];
  customXml: CustomXmlPart[];
  settings: DocSettings;
  /** Unknown constructs are preserved, never dropped. */
  unknown: UnknownPart[];
  /** Monotonic id sequence so persisted documents keep deterministic ids. */
  idSeq: number;
  compatibility?: CompatibilityReport;
}

/* ------------------------------------------------------------- selections */

export interface TextPosition {
  blockId: string;
  /** Index within `Paragraph.inlines`. */
  inlineIndex: number;
  /** UTF-16 offset inside a text run. */
  offset: number;
}

export interface DocRange {
  start: TextPosition;
  end: TextPosition;
}

export interface BlockSelection {
  blockIds: string[];
}

export interface OutlineEntry {
  id: string;
  blockId: string;
  level: number;
  text: string;
  style?: string;
  sectionIndex: number;
}

export interface DocumentStats {
  words: number;
  characters: number;
  charactersWithSpaces: number;
  paragraphs: number;
  tables: number;
  images: number;
  pages?: number;
}

export interface SearchMatch {
  blockId: string;
  /** Index of the block within its section, and section index. */
  sectionIndex: number;
  blockIndex: number;
  start: number;
  end: number;
  text: string;
  contextBefore: string;
  contextAfter: string;
}
