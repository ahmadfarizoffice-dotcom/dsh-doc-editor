/**
 * Deterministic layout engine: turns the document model into paginated,
 * absolutely positioned page boxes. Renderers (HTML/SVG/PDF) consume the output
 * so print, preview and PDF stay consistent.
 */
import type {
  Block,
  DocDocument,
  FieldInline,
  ImageAnchor,
  ImageInline,
  Inline,
  MathRun,
  Paragraph,
  ParagraphProps,
  RunProps,
  Section,
  ShapeTextBox,
  Table,
  TableCell,
  TocBlock,
} from "../model/types.js";
import { computeNumbering, type ListLabel } from "../model/numbering.js";
import { documentOutline } from "../model/query.js";
import { resolveParagraphProps, resolveRunProps } from "../model/styles.js";
import {
  ascentFor,
  descentFor,
  isRtlText,
  measureText,
  naturalLineHeight,
  FontResolver,
} from "./fonts.js";
import type {
  FontSpec,
  ImageBox,
  LayoutBox,
  LayoutPage,
  LayoutRegion,
  LayoutResult,
  LayoutTextRun,
  LayoutWarning,
  RectBox,
  TextLineBox,
  TocEntryLayout,
} from "./types.js";

/* ------------------------------------------------------------ internals */

type BreakKind = "line" | "page" | "column";

interface TextToken {
  kind: "text";
  text: string;
  /** Trailing spaces collapsed into the token (break opportunity after). */
  spaces: number;
  font: FontSpec;
  props: RunProps;
  width: number;
  spaceWidth: number;
  commentIds: string[];
  revision?: { kind: "insert" | "delete" | "format"; author?: string };
}

interface TabToken {
  kind: "tab";
  font: FontSpec;
  props: RunProps;
}

interface AtomToken {
  kind: "atom";
  width: number;
  height: number;
  /** Rendering payload for images / maths / shapes. */
  inline: Inline;
  font: FontSpec;
  props: RunProps;
  commentIds: string[];
}

interface BreakToken {
  kind: "break";
  breakKind: BreakKind;
}

type Token = TextToken | TabToken | AtomToken | BreakToken;

interface LaidItem {
  kind: "text" | "atom" | "tab";
  x: number;
  width: number;
  /** Height of an atomic item (image/math), used for line height. */
  height?: number;
  text?: string;
  font?: FontSpec;
  props?: RunProps;
  inline?: Inline;
  commentIds?: string[];
  revision?: { kind: "insert" | "delete" | "format"; author?: string };
  /** Trailing spaces collapsed after this token (rendered as a gap). */
  spaces?: number;
  spaceWidth?: number;
  /** Rendered width of a tab stop gap. */
  tab?: boolean;
}

interface LaidLine {
  items: LaidItem[];
  height: number;
  ascent: number;
  width: number;
  alignment: ParagraphProps["alignment"];
  /** Space before/after belong to the paragraph, not the line. */
  spaceBefore: number;
  spaceAfter: number;
  isFirstLine: boolean;
  isLastLine: boolean;
  pageBreakBefore: boolean;
  /** List label is rendered with the first line. */
  listLabel?: string;
  level?: number;
  direction: "ltr" | "rtl";
  /** Footnote references encountered on this line. */
  footnotes: string[];
  /** Source paragraph id. */
  blockId: string;
  /** Borders/shading for the paragraph segment. */
  paragraphBorders?: ParagraphProps["borders"];
  paragraphShading?: ParagraphProps["shading"];
  paragraphIndent?: ParagraphProps["indent"];
  paragraphLeft: number;
  paragraphRight: number;
  listIndentLeft?: number;
}

interface NoteRef {
  noteId: string;
  type: "footnote" | "endnote";
  number: number;
}

interface NotePlacement {
  noteId: string;
  type: "footnote" | "endnote";
  number: number;
  height: number;
  blocks: Block[];
  pageIndex: number;
}

interface FlowState {
  pageIndex: number;
  columnIndex: number;
  y: number;
  /** Content bottom for the current column (excludes footnote area). */
  bottom: number;
}

interface PageState {
  page: LayoutPage;
  columns: Array<{ x: number; y: number; width: number; height: number }>;
  notes: NotePlacement[];
  footnoteHeight: number;
}

interface LayoutState {
  doc: DocDocument;
  resolver: FontResolver;
  warnings: LayoutWarning[];
  labels: Map<string, ListLabel>;
  pages: PageState[];
  pageNumberByBlock: Map<string, number>;
  bookmarkBlock: Map<string, string>;
  notesByNumber: Map<string, NoteRef>;
  seqCounters: Map<string, number>;
  totalPages: number;
  /** Options */
  headersFooters: boolean;
  revisionMode: "all" | "final" | "original";
  hyphenate: boolean;
  tocPageNumbers: Map<string, number>;
  fieldTotals: Map<string, number>;
  currentSection: Section;
  sectionPageNumber: number;
  flow: FlowState;
  images: number;
  lines: number;
  tables: number;
  footnotes: number;
  shapeQueue: Array<{ shape: ShapeTextBox; pageIndex: number }>;
}

const DEFAULT_PARAGRAPH_SPACE = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* --------------------------------------------------------------- tokens */

function shouldHide(run: RunProps, mode: LayoutState["revisionMode"]): boolean {
  if (run.hidden) return true;
  if (mode === "final" && run.revision?.kind === "delete") return true;
  if (mode === "original" && run.revision?.kind === "insert") return true;
  return false;
}

const WORD_SPLIT = /(\s+)/;

/** Splits text into breakable tokens: words, runs of whitespace, CJK chars. */
function tokenizeRun(
  state: LayoutState,
  inline: Extract<Inline, { type: "text" }>,
  paragraph: Paragraph,
): TextToken[] {
  const props = resolveRunProps(state.doc, {
    paragraphStyle: paragraph.style,
    characterStyle: inline.props.characterStyle,
    direct: inline.props,
  });
  if (shouldHide(props, state.revisionMode)) return [];
  const font: FontSpec = state.resolver.resolve(props);
  const metrics = state.resolver.metricsFor(font);
  const tokens: TextToken[] = [];
  const spacing = props.charSpacing ?? 0;

  const pushText = (text: string, spaces: number) => {
    if (!text) return;
    const width = measureText(text, font, metrics) + spacing * [...text].length;
    tokens.push({
      kind: "text",
      text,
      spaces,
      font,
      props,
      width,
      spaceWidth: (metrics.space * font.size) / 1000 + spacing,
      commentIds: [],
      revision: props.revision
        ? { kind: props.revision.kind, author: props.revision.author }
        : undefined,
    });
  };

  // Split by whitespace, then by CJK boundaries and hyphen opportunities.
  for (const part of inline.text.split(WORD_SPLIT)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      const last = tokens[tokens.length - 1];
      if (last) last.spaces += part.length;
      continue;
    }
    let buffer = "";
    const flush = () => {
      if (buffer) pushText(buffer, 0);
      buffer = "";
    };
    for (const char of part) {
      const cp = char.codePointAt(0) ?? 32;
      if (isWideCodePoint(cp) || cp === 0x200b) {
        flush();
        if (cp !== 0x200b) pushText(char, 0);
        continue;
      }
      buffer += char;
      if (
        char === "-" ||
        char === "\u2010" ||
        char === "\u2013" ||
        char === "/" ||
        char === "\u00ad"
      ) {
        flush();
      }
    }
    flush();
  }
  return tokens;
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function atomSize(
  state: LayoutState,
  inline: Inline,
): { width: number; height: number } {
  switch (inline.type) {
    case "image": {
      const asset = state.doc.media.find(
        (entry) => entry.id === inline.mediaId,
      );
      let width = inline.width;
      let height = inline.height;
      if ((!width || !height) && asset?.widthPx && asset.heightPx) {
        const dpi = asset.dpi ?? 96;
        width = width || (asset.widthPx * 72) / dpi;
        height = height || (asset.heightPx * 72) / dpi;
      }
      return { width: width || 200, height: height || 150 };
    }
    case "math": {
      const font = state.resolver.resolve(undefined, 11);
      const metrics = state.resolver.metricsFor(font);
      return {
        width: measureText(inline.linear, font, metrics) || 12,
        height: naturalLineHeight(font, metrics),
      };
    }
    case "field":
      return { width: 0, height: 0 };
    case "unknown":
      return { width: 0, height: 0 };
    default:
      return { width: 0, height: 0 };
  }
}

/** Resolves a field's display text for the current page context. */
function resolveFieldText(
  state: LayoutState,
  field: FieldInline,
  pageDisplayNumber: number,
  totalPages: number,
): string {
  const instr = field.instr.trim();
  const upper = instr.toUpperCase();
  if (/^PAGE\b/.test(upper) || upper === "PAGE")
    return String(pageDisplayNumber);
  if (/^NUMPAGES\b/.test(upper)) return String(totalPages);
  if (/^SECTIONPAGES\b/.test(upper)) return String(totalPages);
  if (/^PAGEREF\b/.test(upper) || /^REF\b/.test(upper)) {
    const anchor = instr.split(/\s+/)[1];
    if (anchor) {
      const blockId = state.bookmarkBlock.get(anchor);
      if (blockId) {
        const page =
          state.pageNumberByBlock.get(blockId) ??
          state.pageNumberByBlock.get(anchor);
        if (page) return String(page);
      }
    }
    return "";
  }
  if (/^SEQ\b/.test(upper)) {
    const identifier = (instr.split(/\s+/)[1] ?? "SEQ").toUpperCase();
    const current = (state.seqCounters.get(identifier) ?? 0) + 1;
    state.seqCounters.set(identifier, current);
    return String(current);
  }
  // Unknown field: fall back to its cached result, never the raw instruction.
  return field.result ? inlineTextOf(field.result) : "";
}

function inlineTextOf(inlines: Inline[]): string {
  let out = "";
  for (const inline of inlines) {
    if (inline.type === "text") out += inline.text;
    else if (inline.type === "field")
      out += inline.result ? inlineTextOf(inline.result) : "";
    else if (inline.type === "math") out += inline.linear;
    else if (inline.type === "tab") out += "\t";
  }
  return out;
}

/* ------------------------------------------------------------ paragraph */

interface ParagraphLayout {
  lines: LaidLine[];
  props: ParagraphProps;
}

function layoutParagraph(
  state: LayoutState,
  paragraph: Paragraph,
  contentWidth: number,
  pageDisplayNumber: number,
): ParagraphLayout {
  const props = resolveParagraphProps(state.doc, paragraph);
  const pendingComments: string[] = [];
  const activeComments = new Set<string>();
  const indent = props.indent ?? {};
  const leftIndent = indent.left ?? 0;
  const rightIndent = indent.right ?? 0;
  const firstLineIndent = indent.firstLine ?? 0;
  const hanging = indent.hanging ?? 0;
  const label = state.labels.get(paragraph.id);
  const listIndent = label ? label.indent : undefined;

  // Numbered paragraphs: the label sits in the hanging indent area.
  const labelText = label ? formatLabel(label) : "";
  const labelWidth = labelText
    ? measureText(
        labelText,
        state.resolver.resolve(undefined, 11),
        state.resolver.metricsFor(state.resolver.resolve(undefined, 11)),
      )
    : 0;

  const tokens: Token[] = [];
  for (const inline of paragraph.inlines) {
    switch (inline.type) {
      case "text": {
        const runTokens = tokenizeRun(state, inline, paragraph);
        for (const token of runTokens) {
          // attach pending comment anchors to the next token
          if (pendingComments.length > 0) {
            token.commentIds.push(...pendingComments.splice(0));
          }
          tokens.push(token);
        }
        break;
      }
      case "tab": {
        const runProps = resolveRunProps(state.doc, {
          paragraphStyle: paragraph.style,
          characterStyle: inline.props?.characterStyle,
          direct: inline.props,
        });
        tokens.push({
          kind: "tab",
          font: state.resolver.resolve(runProps),
          props: runProps,
        });
        break;
      }
      case "break":
        tokens.push({ kind: "break", breakKind: inline.kind });
        break;
      case "image":
      case "math":
      case "shape":
      case "unknown": {
        if (inline.type === "image" && inline.anchor?.type === "floating") {
          // Floating images are placed by emitAnchoredObjects, not in the text flow.
          state.warnings.push({
            code: "image.wrapApproximated",
            message:
              "Floating image placed at its anchor; square text wrap is approximated",
            blockId: paragraph.id,
          });
          break;
        }
        const size = atomSize(state, inline);
        const runProps = (inline as { props?: RunProps }).props ?? {};
        tokens.push({
          kind: "atom",
          width: size.width,
          height: size.height,
          inline,
          font: state.resolver.resolve(runProps),
          props: runProps,
          commentIds: pendingComments.splice(0),
        });
        break;
      }
      case "field": {
        const text = resolveFieldText(
          state,
          inline,
          pageDisplayNumber,
          state.totalPages,
        );
        if (!text) break;
        const runProps = resolveRunProps(state.doc, {
          paragraphStyle: paragraph.style,
        });
        const font = state.resolver.resolve(runProps);
        const metrics = state.resolver.metricsFor(font);
        tokens.push({
          kind: "text",
          text,
          spaces: 0,
          font,
          props: runProps,
          width: measureText(text, font, metrics),
          spaceWidth: (metrics.space * font.size) / 1000,
          commentIds: [],
        });
        break;
      }
      case "noteRef": {
        const note = state.notesByNumber.get(inline.noteId) ?? {
          noteId: inline.noteId,
          type: inline.noteType,
          number: state.notesByNumber.size + 1,
        };
        state.notesByNumber.set(inline.noteId, note);
        const marker = {
          kind: "atom" as const,
          width: 6,
          height: 0,
          inline,
          font: superscriptFont(state),
          props: { vertAlign: "superscript" as const },
          commentIds: [],
        };
        tokens.push(marker);
        // remember reference on the line that contains it
        (marker as AtomToken & { noteId?: string }).noteId = inline.noteId;
        break;
      }
      case "commentRef": {
        if (inline.kind === "point") pendingComments.push(inline.commentId);
        else if (inline.kind === "rangeStart")
          activeComments.add(inline.commentId);
        else activeComments.delete(inline.commentId);
        if (inline.kind === "rangeStart")
          pendingComments.push(inline.commentId);
        break;
      }
      case "bookmark":
        break;
      default:
        break;
    }
  }
  if (pendingComments.length > 0) {
    // Comment anchors at paragraph end attach to the last token.
    const last = tokens[tokens.length - 1];
    if (last && last.kind === "text")
      last.commentIds.push(...pendingComments.splice(0));
    else pendingComments.length = 0;
  }
  activeComments.clear();

  // Line breaking.
  const lines: LaidLine[] = [];
  const pageBreakBefore = props.pageBreakBefore === true;
  const lineRule = props.lineSpacing;
  const tabStops = [...(props.tabStops ?? [])].sort(
    (a, b) => a.position - b.position,
  );
  const defaultTab = state.doc.settings.defaultTabStop || 36;

  let currentItems: LaidItem[] = [];
  let currentWidth = 0;
  let lineMaxHeight = 0;
  let lineAscent = 0;
  let lineFootnotes: string[] = [];
  let isFirstLine = true;
  const alignmentOverride: ParagraphProps["alignment"] = props.alignment;

  const effectiveIndent = isFirstLine ? firstLineIndent - hanging : -hanging;
  const lineContentWidth = (): number =>
    Math.max(
      12,
      contentWidth -
        leftIndent -
        rightIndent -
        (isFirstLine ? Math.max(0, effectiveIndent) : 0) -
        (label && isFirstLine ? label.indent.left : 0),
    );

  const finishLine = (isLast: boolean) => {
    const lineHeight = Math.max(
      lineMaxHeight,
      lineRule?.rule === "exact" ? lineRule.value : 0,
    );
    const computedHeight =
      lineRule?.rule === "exact" ? lineRule.value : Math.max(lineMaxHeight, 12);
    const height =
      lineHeight > 0 ? Math.max(computedHeight, lineHeight) : computedHeight;
    lines.push({
      items: currentItems,
      height,
      ascent: lineAscent || height * 0.8,
      width: currentWidth,
      alignment: alignmentOverride,
      spaceBefore: isFirstLine
        ? (props.spaceBefore ?? DEFAULT_PARAGRAPH_SPACE)
        : 0,
      spaceAfter: isLast ? (props.spaceAfter ?? DEFAULT_PARAGRAPH_SPACE) : 0,
      isFirstLine,
      isLastLine: isLast,
      pageBreakBefore: isFirstLine ? pageBreakBefore : false,
      listLabel: isFirstLine ? labelText || undefined : undefined,
      level: label?.level,
      direction:
        props.bidi ||
        currentItems.some((item) => item.text && isRtlText(item.text))
          ? "rtl"
          : "ltr",
      footnotes: lineFootnotes,
      blockId: paragraph.id,
      paragraphBorders: props.borders,
      paragraphShading: props.shading,
      paragraphIndent: indent,
      paragraphLeft:
        leftIndent + (label && isFirstLine ? label.indent.left : 0),
      paragraphRight: rightIndent,
      listIndentLeft: label?.indent.left,
    });
    currentItems = [];
    currentWidth = 0;
    lineMaxHeight = 0;
    lineAscent = 0;
    lineFootnotes = [];
    isFirstLine = false;
  };

  let pendingSpaceWidth = 0;
  const pushItem = (item: LaidItem, height: number, ascent: number) => {
    currentItems.push(item);
    currentWidth += item.width;
    lineMaxHeight = Math.max(lineMaxHeight, height);
    lineAscent = Math.max(lineAscent, ascent);
  };
  const pushTextItem = (text: string, token: TextToken, spaces: number) => {
    const metrics = state.resolver.metricsFor(token.font);
    const spacer = spaces > 0 ? " ".repeat(spaces) : "";
    pushItem(
      {
        kind: "text",
        x: 0,
        width: token.width + spaces * token.spaceWidth,
        text: text + spacer,
        font: token.font,
        props: token.props,
        commentIds: token.commentIds,
        revision: token.revision,
        spaces,
        spaceWidth: token.spaceWidth,
      },
      naturalLineHeight(token.font, metrics),
      ascentFor(token.font, metrics),
    );
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "break") {
      if (token.breakKind === "page" || token.breakKind === "column") {
        // Handled by the flow layer via a synthetic line marker.
        finishLine(currentItems.length === 0);
        const last = lines[lines.length - 1];
        if (last) {
          (last as LaidLine & { forceBreak?: BreakKind }).forceBreak =
            token.breakKind;
        }
        continue;
      }
      finishLine(false);
      continue;
    }
    if (token.kind === "tab") {
      const metrics = state.resolver.metricsFor(token.font);
      const stop = tabStops.find(
        (entry) => entry.position > currentWidth + leftIndent,
      );
      const target = stop
        ? stop.position - leftIndent
        : Math.ceil((currentWidth + 0.01) / defaultTab) * defaultTab;
      const gap = Math.max(4, target - currentWidth);
      pushItem(
        { kind: "tab", x: 0, width: gap },
        naturalLineHeight(token.font, metrics),
        ascentFor(token.font, metrics),
      );
      pendingSpaceWidth = 0;
      continue;
    }
    if (token.kind === "atom") {
      if (
        currentItems.length > 0 &&
        currentWidth + token.width > lineContentWidth()
      ) {
        finishLine(false);
      }
      pushItem(
        {
          kind: "atom",
          x: 0,
          width: token.width,
          height: token.height,
          inline: token.inline,
          font: token.font,
          props: token.props,
          commentIds: token.commentIds,
        },
        Math.max(token.height, 0),
        Math.max(token.height, 0),
      );
      const noteId = (token as AtomToken & { noteId?: string }).noteId;
      if (noteId) lineFootnotes.push(noteId);
      continue;
    }

    const available = lineContentWidth();
    if (currentWidth + token.width <= available || currentItems.length === 0) {
      if (currentWidth + token.width > available && currentItems.length === 0) {
        // A single token wider than the line: break inside it.
        let buffer = "";
        let bufferWidth = 0;
        for (const char of token.text) {
          const charWidth = measureText(
            char,
            token.font,
            state.resolver.metricsFor(token.font),
          );
          if (bufferWidth + charWidth > available && buffer) {
            pushItem(
              {
                kind: "text",
                x: 0,
                width: bufferWidth,
                text: buffer,
                font: token.font,
                props: token.props,
                commentIds: token.commentIds,
                revision: token.revision,
              },
              naturalLineHeight(
                token.font,
                state.resolver.metricsFor(token.font),
              ),
              ascentFor(token.font, state.resolver.metricsFor(token.font)),
            );
            finishLine(false);
            buffer = "";
            bufferWidth = 0;
          }
          buffer += char;
          bufferWidth += charWidth;
        }
        if (buffer) pushTextItem(buffer, token, token.spaces);
      } else {
        pushTextItem(token.text, token, token.spaces);
      }
      pendingSpaceWidth = 0;
      continue;
    }

    finishLine(false);
    // Re-process the token on the new line.
    index -= 1;
  }
  finishLine(true);

  if (lines.length === 0) {
    // Empty paragraph: still occupies one line.
    const font = state.resolver.resolve(
      resolveRunProps(state.doc, { paragraphStyle: paragraph.style }),
    );
    const metrics = state.resolver.metricsFor(font);
    lines.push({
      items: [],
      height: naturalLineHeight(font, metrics),
      ascent: ascentFor(font, metrics),
      width: 0,
      alignment: props.alignment,
      spaceBefore: props.spaceBefore ?? DEFAULT_PARAGRAPH_SPACE,
      spaceAfter: props.spaceAfter ?? DEFAULT_PARAGRAPH_SPACE,
      isFirstLine: true,
      isLastLine: true,
      pageBreakBefore,
      direction: props.bidi ? "rtl" : "ltr",
      footnotes: [],
      blockId: paragraph.id,
      paragraphBorders: props.borders,
      paragraphShading: props.shading,
      paragraphIndent: indent,
      paragraphLeft: leftIndent,
      paragraphRight: rightIndent,
    });
  }

  return { lines, props };
}

function superscriptFont(state: LayoutState): FontSpec {
  const base = state.resolver.resolve(undefined, 10);
  return { ...base, size: base.size * 0.7 };
}

/** First explicit language declared by any text run in the paragraph. */
function paragraphLanguage(paragraph: Paragraph): string | undefined {
  for (const inline of paragraph.inlines) {
    if (inline.type === "text" && inline.props.language)
      return inline.props.language;
  }
  return undefined;
}

function formatLabel(label: ListLabel): string {
  return label.label;
}

/* -------------------------------------------------------------- the flow */

function createPage(
  state: LayoutState,
  section: Section,
  sectionIndex: number,
  displayNumber: number,
): PageState {
  const page: LayoutPage = {
    index: state.pages.length,
    displayNumber,
    sectionIndex,
    width: section.page.width,
    height: section.page.height,
    orientation: section.page.orientation,
    background: section.page.pageColor,
    pageBorders: section.page.borders
      ? {
          top: section.page.borders.top,
          bottom: section.page.borders.bottom,
          left: section.page.borders.left,
          right: section.page.borders.right,
          offsetFrom: section.page.borders.offsetFrom,
        }
      : undefined,
    columns: [],
    boxes: [],
  };
  const margins = section.page.margins;
  const contentX = margins.left + margins.gutter;
  const contentWidth =
    section.page.width - margins.left - margins.right - margins.gutter;
  const contentTop = margins.top;
  const contentHeight = section.page.height - margins.top - margins.bottom;
  const columns = section.columns.count > 1 ? section.columns.count : 1;
  const space = section.columns.space;
  const columnWidth = (contentWidth - space * (columns - 1)) / columns;
  const frames: Array<{ x: number; y: number; width: number; height: number }> =
    [];
  for (let index = 0; index < columns; index += 1) {
    frames.push({
      x: contentX + index * (columnWidth + space),
      y: contentTop,
      width: section.columns.widths?.[index] ?? columnWidth,
      height: contentHeight,
    });
  }
  page.columns = frames.map((frame) => ({ ...frame }));
  const pageState: PageState = {
    page,
    columns: frames,
    notes: [],
    footnoteHeight: 0,
  };
  state.pages.push(pageState);
  return pageState;
}

function currentPage(state: LayoutState): PageState {
  const page = state.pages[state.flow.pageIndex];
  if (!page) throw new Error("layout flow has no page");
  return page;
}

function currentFrame(state: LayoutState) {
  const page = currentPage(state);
  return page.columns[state.flow.columnIndex];
}

function startNewPage(
  state: LayoutState,
  section: Section,
  sectionIndex: number,
): void {
  state.sectionPageNumber += 1;
  const page = createPage(
    state,
    section,
    sectionIndex,
    state.sectionPageNumber,
  );
  state.flow = {
    pageIndex: state.pages.length - 1,
    columnIndex: 0,
    y: page.columns[0].y,
    bottom: page.columns[0].y + page.columns[0].height,
  };
}

function ensureSpace(
  state: LayoutState,
  section: Section,
  sectionIndex: number,
  height: number,
): void {
  const frame = currentFrame(state);
  const page = currentPage(state);
  const bottom = frame.y + frame.height - page.footnoteHeight;
  if (state.flow.y + height <= bottom + 0.01) return;
  if (state.flow.columnIndex + 1 < page.columns.length) {
    state.flow.columnIndex += 1;
    const next = page.columns[state.flow.columnIndex];
    state.flow.y = next.y;
    return;
  }
  startNewPage(state, section, sectionIndex);
}

function markBlockPage(state: LayoutState, blockId: string): void {
  if (state.pageNumberByBlock.has(blockId)) return;
  const page = state.pages[state.pages.length - 1];
  state.pageNumberByBlock.set(blockId, page ? page.page.index + 1 : 1);
}

function emit(state: LayoutState, box: LayoutBox): void {
  const page = state.pages[state.pages.length - 1];
  if (!page) return;
  page.page.boxes.push(box);
}

/* ------------------------------------------------------------ paragraphs */

function flowParagraph(
  state: LayoutState,
  paragraph: Paragraph,
  section: Section,
  sectionIndex: number,
): void {
  const frame = currentFrame(state);
  const page = currentPage(state);
  const availableWidth = frame.width;
  const layout = layoutParagraph(
    state,
    paragraph,
    availableWidth,
    page.page.displayNumber,
  );
  markBlockPage(state, paragraph.id);
  const paragraphTop = state.flow.y;

  let lineIndex = 0;
  const lines = layout.lines;

  // Page-break-before handling.
  if (
    lines[0]?.pageBreakBefore &&
    (state.flow.y > frame.y + 0.01 || state.pages.length > 1)
  ) {
    if (state.flow.y > frame.y + 0.01 || state.flow.columnIndex > 0) {
      startNewPage(state, section, sectionIndex);
    }
  }

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    const lineBreak = (line as LaidLine & { forceBreak?: BreakKind })
      .forceBreak;
    const spaceBefore = lineIndex === 0 ? line.spaceBefore : 0;
    const needed = line.height + spaceBefore;

    // A break-only line carries the page/column break marker without occupying
    // vertical space.
    if (
      lineBreak &&
      line.items.length === 0 &&
      !line.listLabel &&
      lineBreak !== "line"
    ) {
      if (lineBreak === "page") {
        startNewPage(state, section, sectionIndex);
      } else {
        const page = currentPage(state);
        if (state.flow.columnIndex + 1 < page.columns.length) {
          state.flow.columnIndex += 1;
          state.flow.y = page.columns[state.flow.columnIndex].y;
        } else {
          startNewPage(state, section, sectionIndex);
        }
      }
      lineIndex += 1;
      continue;
    }

    const frameNow = currentFrame(state);
    const pageNow = currentPage(state);
    const bottomNow = frameNow.y + frameNow.height - pageNow.footnoteHeight;
    const fits = state.flow.y + needed <= bottomNow + 0.01;
    if (!fits) {
      // Widow/orphan control: never leave a single line of a multi-line
      // paragraph alone at the top or bottom of a page when it can be avoided.
      const widowControl = layout.props.widowControl !== false;
      if (
        widowControl &&
        lines.length > 2 &&
        state.flow.y > frameNow.y + 0.01
      ) {
        const fitsLines = Math.floor(
          (bottomNow - state.flow.y - spaceBefore) / Math.max(1, line.height),
        );
        const wouldSplit =
          fitsLines > 0 && fitsLines < line.height * 2 && lineIndex > 0;
        if (wouldSplit) {
          // Push the remainder to the next page/column instead of splitting.
          ensureSpace(state, section, sectionIndex, line.height);
          continue;
        }
      }
      ensureSpace(state, section, sectionIndex, needed);
      continue;
    }

    state.flow.y += spaceBefore;

    const frame2 = currentFrame(state);
    const left = frame2.x + line.paragraphLeft;
    const width = frame2.width - line.paragraphLeft - line.paragraphRight;
    const lineTop = state.flow.y;

    // Paragraph shading/borders for this page segment.
    if (line.paragraphShading?.fill) {
      const segmentStart = lineTop - spaceBefore;
      emit(state, {
        id: `shade-${paragraph.id}-${lineIndex}`,
        kind: "rect",
        x: frame2.x + (line.paragraphIndent?.left ?? 0) - 2,
        y: segmentStart,
        width:
          frame2.width -
          (line.paragraphIndent?.left ?? 0) -
          (line.paragraphIndent?.right ?? 0) +
          4,
        height: line.height + spaceBefore,
        fill: line.paragraphShading.fill,
        blockId: paragraph.id,
        z: -1,
      });
    }

    // Position items.
    const positioned = positionItems(state, line, left, width);
    const alignment = line.alignment ?? "left";
    let xOffset = 0;
    if (alignment === "center") xOffset = (width - positioned.totalWidth) / 2;
    else if (alignment === "right") xOffset = width - positioned.totalWidth;
    const justify =
      alignment === "justify" && !line.isLastLine && positioned.spaces > 0;
    const justifyExtra = justify
      ? (width - positioned.totalWidth) / positioned.spaces
      : 0;

    const runs: LayoutTextRun[] = [];
    let cursor = left + Math.max(0, xOffset);
    const baseline = lineTop + line.ascent;
    for (const item of positioned.items) {
      if (item.kind === "atom") {
        emitInlineAtom(state, item, cursor, lineTop, paragraph);
        cursor += item.width;
        continue;
      }
      if (item.kind === "tab") {
        cursor += item.width;
        continue;
      }
      if (!item.font || !item.text) {
        cursor += itemAdvance(item, justifyExtra);
        continue;
      }
      const font = item.font;
      const textWidth = item.width + (item.spaces ?? 0) * justifyExtra;
      const props = item.props ?? {};
      const vertAlign = props.vertAlign;
      const runBaseline =
        vertAlign === "superscript"
          ? baseline - font.size * 0.33
          : vertAlign === "subscript"
            ? baseline + font.size * 0.15
            : baseline;
      runs.push({
        text: item.text,
        x: cursor,
        width: textWidth,
        font,
        color: props.color,
        highlight: props.highlight,
        background: props.background,
        decoration: {
          underline: props.underline !== undefined && props.underline !== false,
          strike: props.strike === true,
          doubleStrike: props.doubleStrike === true,
          outline: props.outline === true,
        },
        baseline: runBaseline,
        vertAlign: vertAlign ?? "baseline",
        hyperlink: props.hyperlink,
        commentIds:
          item.commentIds && item.commentIds.length > 0
            ? item.commentIds
            : undefined,
        revision: item.revision,
      });
      cursor += itemAdvance(item, justifyExtra);
    }

    const labelFont = state.resolver.resolve(undefined, 11);
    const labelWidth = line.listLabel
      ? measureText(
          line.listLabel,
          labelFont,
          state.resolver.metricsFor(labelFont),
        )
      : 0;
    const listLabelRun: LayoutTextRun | undefined = line.listLabel
      ? {
          text: line.listLabel,
          x: frame2.x + (line.listIndentLeft ?? 0),
          width: labelWidth,
          font: labelFont,
          baseline,
        }
      : undefined;

    if (runs.length > 0 || line.listLabel) {
      const box: TextLineBox = {
        id: `line-${paragraph.id}-${lineIndex}`,
        kind: "text",
        x: left,
        y: lineTop,
        width: Math.max(width, positioned.totalWidth),
        height: line.height,
        baseline,
        runs,
        alignment: alignment === "distribute" ? "justify" : alignment,
        blockId: paragraph.id,
        firstLine: lineIndex === 0,
        direction: line.direction,
        language: paragraphLanguage(paragraph),
      };
      emit(state, box);
    }
    if (listLabelRun) {
      emit(state, {
        id: `list-${paragraph.id}-${lineIndex}`,
        kind: "text",
        x: listLabelRun.x,
        y: lineTop,
        width: labelWidth,
        height: line.height,
        baseline,
        runs: [listLabelRun],
        alignment: "left",
        blockId: paragraph.id,
        firstLine: true,
      });
    }

    // Footnotes referenced on this line.
    if (line.footnotes.length > 0) {
      for (const noteId of line.footnotes) {
        const note = state.notesByNumber.get(noteId);
        const noteBlocks =
          note?.type === "endnote"
            ? state.doc.endnotes.find((n) => n.id === noteId)?.blocks
            : state.doc.footnotes.find((n) => n.id === noteId)?.blocks;
        if (!note || !noteBlocks) continue;
        const height = 14 + noteBlocks.length * 14;
        const pageNow2 = currentPage(state);
        pageNow2.notes.push({
          noteId,
          type: note.type,
          number: note.number,
          height,
          blocks: noteBlocks,
          pageIndex: pageNow2.page.index,
        });
        pageNow2.footnoteHeight += height;
        state.footnotes += 1;
      }
    }

    state.flow.y += line.height;
    lineIndex += 1;

    if (lineBreak === "page") {
      startNewPage(state, section, sectionIndex);
    } else if (lineBreak === "column") {
      const pageAfter = currentPage(state);
      if (state.flow.columnIndex + 1 < pageAfter.columns.length) {
        state.flow.columnIndex += 1;
        state.flow.y = pageAfter.columns[state.flow.columnIndex].y;
      } else {
        startNewPage(state, section, sectionIndex);
      }
    }
  }

  drawParagraphBorders(state, paragraph, lines, frame);
  emitAnchoredObjects(state, paragraph, frame, paragraphTop);
  state.lines += lines.length;
}

function drawParagraphBorders(
  state: LayoutState,
  paragraph: Paragraph,
  lines: LaidLine[],
  frame: { x: number; y: number; width: number },
): void {
  const props = resolveParagraphProps(state.doc, paragraph);
  if (!props.borders) return;
  const page = state.pages[state.pages.length - 1];
  const paragraphLines = page.page.boxes.filter(
    (box) => box.kind === "text" && box.blockId === paragraph.id,
  );
  if (paragraphLines.length === 0) return;
  const top = Math.min(...paragraphLines.map((box) => box.y));
  const bottom = Math.max(...paragraphLines.map((box) => box.y + box.height));
  const border = props.borders;
  const toSide = (side: typeof border.top) =>
    side
      ? { width: side.width, color: side.color, style: side.style }
      : undefined;
  const rect: RectBox = {
    id: `pborder-${paragraph.id}`,
    kind: "rect",
    x: frame.x + (props.indent?.left ?? 0) - 3,
    y: top - 2,
    width:
      frame.width - (props.indent?.left ?? 0) - (props.indent?.right ?? 0) + 6,
    height: bottom - top + 4,
    border: {
      top: toSide(border.top),
      bottom: toSide(border.bottom),
      left: toSide(border.left),
      right: toSide(border.right),
    },
    blockId: paragraph.id,
    z: 1,
  };
  emit(state, rect);
  void lines;
}

function positionItems(
  state: LayoutState,
  line: LaidLine,
  left: number,
  width: number,
): { items: LaidItem[]; totalWidth: number; spaces: number } {
  void state;
  void left;
  void width;
  let totalWidth = 0;
  for (const item of line.items) totalWidth += item.width;
  // Trailing spaces of the last token are not justification points.
  let spaces = 0;
  for (let index = 0; index < line.items.length - 1; index += 1) {
    spaces += line.items[index].spaces ?? 0;
  }
  return { items: line.items, totalWidth, spaces };
}

/** Horizontal advance contributed by an item, including justified spaces. */
function itemAdvance(item: LaidItem, justifyExtra = 0): number {
  return item.width + (item.spaces ?? 0) * justifyExtra;
}

function emitInlineAtom(
  state: LayoutState,
  item: LaidItem,
  x: number,
  y: number,
  paragraph: Paragraph,
): void {
  const inline = item.inline;
  if (!inline) return;
  if (inline.type === "image") {
    const asset = state.doc.media.find((entry) => entry.id === inline.mediaId);
    const box: ImageBox = {
      id: `img-${paragraph.id}-${Math.round(x)}-${Math.round(y)}`,
      kind: "image",
      x,
      y: y + Math.max(0, item.width === 0 ? 0 : 0),
      width: item.width,
      height:
        item.width === 0
          ? 0
          : item.width * ((inline.height || 1) / (inline.width || 1)),
      mediaId: inline.mediaId,
      contentType: asset?.contentType ?? "image/png",
      alt: inline.alt,
      border: inline.border,
      crop: inline.crop,
      blockId: paragraph.id,
    };
    if (inline.anchor?.type === "floating") {
      // Floating images are placed by the float pass; keep them out of flow.
      box.x = clamp(x, 0, 10000);
      box.z = inline.anchor.zOrder ?? 1;
      box.y = y;
    }
    emit(state, box);
    state.images += 1;
    return;
  }
  if (inline.type === "math") {
    emit(state, {
      id: `math-${paragraph.id}-${Math.round(x)}`,
      kind: "math",
      x,
      y,
      width: item.width,
      height: Math.max(item.height ?? 0, 12),
      text: inline.linear,
      font: item.font ?? state.resolver.resolve(undefined, 11),
      blockId: paragraph.id,
    });
    return;
  }
  if (inline.type === "noteRef") {
    const note = state.notesByNumber.get(inline.noteId);
    const marker = String(note?.number ?? 1);
    emit(state, {
      id: `noteref-${inline.noteId}`,
      kind: "text",
      x,
      y,
      width: item.width,
      height: 10,
      baseline: y + 8,
      runs: [
        {
          text: marker,
          x,
          width: item.width,
          font: {
            ...(item.font ?? state.resolver.resolve(undefined, 10)),
            size: 8,
          },
          baseline: y + 8,
          vertAlign: "superscript",
        },
      ],
      alignment: "left",
      blockId: paragraph.id,
    });
    return;
  }
  if (inline.type === "unknown") {
    emit(state, {
      id: `unknown-${paragraph.id}-${Math.round(x)}`,
      kind: "text",
      x,
      y,
      width: 0,
      height: 0,
      baseline: y + 8,
      runs: [
        {
          text: inline.text ?? "",
          x,
          width: 0,
          font: state.resolver.resolve(undefined, 9),
          baseline: y + 8,
          color: "#b45309",
        },
      ],
      alignment: "left",
      blockId: paragraph.id,
    });
  }
}

/* -------------------------------------------------------- anchored objects */

/** Positions floating images and text boxes anchored to a paragraph. */
function emitAnchoredObjects(
  state: LayoutState,
  paragraph: Paragraph,
  frame: { x: number; y: number; width: number },
  paragraphTop: number,
): void {
  for (const inline of paragraph.inlines) {
    if (inline.type === "image" && inline.anchor?.type === "floating") {
      const asset = state.doc.media.find(
        (entry) => entry.id === inline.mediaId,
      );
      const horizontal = inline.anchor.position?.horizontal;
      const vertical = inline.anchor.position?.vertical;
      const width = inline.width || 200;
      const height = inline.height || 150;
      let x = frame.x;
      if (horizontal?.align === "right") x = frame.x + frame.width - width;
      else if (horizontal?.align === "center")
        x = frame.x + (frame.width - width) / 2;
      else if (horizontal?.offset !== undefined)
        x = frame.x + horizontal.offset;
      const y = paragraphTop + (vertical?.offset ?? 0);
      emit(state, {
        id: `floatimg-${paragraph.id}-${Math.round(x)}`,
        kind: "image",
        x,
        y,
        width,
        height,
        mediaId: inline.mediaId,
        contentType: asset?.contentType ?? "image/png",
        alt: inline.alt,
        border: inline.border,
        blockId: paragraph.id,
        z: inline.anchor.zOrder ?? 2,
      });
      state.images += 1;
      continue;
    }
    if (inline.type === "shape") {
      const shape = state.doc.shapes.find(
        (entry) => entry.id === inline.shapeId,
      );
      if (!shape) continue;
      const anchor = shape.anchor ?? { type: "floating" };
      const horizontal = anchor.position?.horizontal;
      let x = frame.x;
      if (horizontal?.align === "right")
        x = frame.x + frame.width - shape.width;
      else if (horizontal?.align === "center")
        x = frame.x + (frame.width - shape.width) / 2;
      else if (horizontal?.offset !== undefined)
        x = frame.x + horizontal.offset;
      const y = paragraphTop + (anchor.position?.vertical?.offset ?? 0);
      emit(state, {
        id: `shape-${shape.id}`,
        kind: "shape",
        x,
        y,
        width: shape.width,
        height: shape.height,
        shapeId: shape.id,
        fill: shape.fill,
        border: { width: 1, color: "#bfa76f" },
        preset: shape.preset,
        blockId: paragraph.id,
        z: (anchor.zOrder ?? 3) + 1,
      });
      const content = layoutCellContent(state, shape.blocks, shape.width, {
        top: 6,
        right: 6,
        bottom: 6,
        left: 6,
      });
      for (const entry of content.boxes) {
        const box = entry.relative as LayoutBox;
        emit(state, {
          ...box,
          x: box.x + x,
          y: box.y + y,
          blockId: paragraph.id,
        } as LayoutBox);
      }
    }
  }
}

/* ---------------------------------------------------------------- tables */

interface CellLayout {
  width: number;
  height: number;
  boxes: Array<{
    kind: "text" | "rect" | "image" | "math";
    relative: LayoutBox;
  }>;
}

interface CellMarginBox {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function resolvedMargins(
  cell: TableCell,
  fallback: CellMarginBox,
): CellMarginBox {
  const margins = cell.props.margins;
  return {
    top: margins?.top ?? fallback.top,
    right: margins?.right ?? fallback.right,
    bottom: margins?.bottom ?? fallback.bottom,
    left: margins?.left ?? fallback.left,
  };
}

function tableMarginsFor(table: Table): CellMarginBox {
  const margins = table.props.cellMargins;
  return {
    top: margins?.top ?? 0,
    right: margins?.right ?? 5.4,
    bottom: margins?.bottom ?? 0,
    left: margins?.left ?? 5.4,
  };
}

function computeColumnWidths(
  table: Table,
  availableWidth: number,
  state: LayoutState,
): number[] {
  const grid = table.grid.length > 0 ? table.grid : [];
  if (grid.length === 0) {
    const columns = Math.max(1, ...table.rows.map((row) => row.cells.length));
    return new Array(columns).fill(availableWidth / columns);
  }
  const total = grid.reduce((sum, value) => sum + value, 0);
  if (table.props.layout === "fixed" || total <= availableWidth) {
    if (total <= availableWidth && total > 0) {
      // Scale up to fill the available width when the table is narrower.
      return grid.map((value) => (value / total) * availableWidth);
    }
    return grid.map((value) => (value / Math.max(1, total)) * availableWidth);
  }
  void state;
  return grid.map((value) => (value / total) * availableWidth);
}

function layoutCellContent(
  state: LayoutState,
  blocks: Block[],
  width: number,
  cellMargins: CellMarginBox,
): { height: number; boxes: Array<{ relative: LayoutBox }> } {
  const innerWidth = Math.max(12, width - cellMargins.left - cellMargins.right);
  let cursor = cellMargins.top;
  const boxes: Array<{ relative: LayoutBox }> = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      const layout = layoutParagraph(state, block, innerWidth, 1);
      for (const line of layout.lines) {
        cursor += line.spaceBefore;
        const positioned = positionItems(
          state,
          line,
          cellMargins.left,
          innerWidth,
        );
        const alignment = line.alignment ?? "left";
        let offset = 0;
        if (alignment === "center")
          offset = (innerWidth - positioned.totalWidth) / 2;
        else if (alignment === "right")
          offset = innerWidth - positioned.totalWidth;
        let x = cellMargins.left + Math.max(0, offset);
        const runs: LayoutTextRun[] = [];
        for (const item of positioned.items) {
          if (item.kind === "atom") {
            const atom = item.inline;
            if (atom?.type === "image") {
              boxes.push({
                relative: {
                  id: `cellimg-${block.id}-${Math.round(x)}`,
                  kind: "image",
                  x,
                  y: cursor,
                  width: item.width,
                  height: item.width * ((atom.height || 1) / (atom.width || 1)),
                  mediaId: atom.mediaId,
                  contentType:
                    state.doc.media.find((entry) => entry.id === atom.mediaId)
                      ?.contentType ?? "image/png",
                  blockId: block.id,
                } as ImageBox,
              });
            }
            x += item.width;
            continue;
          }
          if (item.kind === "tab") {
            x += item.width;
            continue;
          }
          if (!item.font || !item.text) continue;
          const props = item.props ?? {};
          runs.push({
            text: item.text,
            x,
            width: item.width,
            font: item.font,
            color: props.color,
            highlight: props.highlight,
            background: props.background,
            decoration: {
              underline:
                props.underline !== undefined && props.underline !== false,
              strike: props.strike === true,
            },
            baseline: cursor + line.ascent,
            vertAlign: props.vertAlign ?? "baseline",
            hyperlink: props.hyperlink,
          });
          x += item.width;
        }
        if (runs.length > 0 || line.listLabel) {
          boxes.push({
            relative: {
              id: `cellline-${block.id}-${Math.round(cursor)}`,
              kind: "text",
              x: cellMargins.left,
              y: cursor,
              width: innerWidth,
              height: line.height,
              baseline: cursor + line.ascent,
              runs,
              alignment: alignment === "distribute" ? "justify" : alignment,
              blockId: block.id,
            } as TextLineBox,
          });
        }
        cursor += line.height + line.spaceAfter;
      }
    } else if (block.type === "table") {
      // Nested tables: flatten with a bounded height.
      const widths = computeColumnWidths(block, innerWidth, state);
      let nestedY = cursor;
      for (const row of block.rows) {
        let rowHeight = 0;
        for (let index = 0; index < row.cells.length; index += 1) {
          const cell = row.cells[index];
          const cellWidth =
            widths[index] ?? innerWidth / Math.max(1, row.cells.length);
          const content = layoutCellContent(state, cell.blocks, cellWidth, {
            top: 2,
            right: 4,
            bottom: 2,
            left: 4,
          });
          rowHeight = Math.max(rowHeight, content.height);
          for (const entry of content.boxes) {
            boxes.push({
              relative: {
                ...entry.relative,
                x: (entry.relative as { x: number }).x + cellMargins.left,
                y: (entry.relative as { y: number }).y + nestedY,
              } as LayoutBox,
            });
          }
        }
        nestedY += Math.max(rowHeight, 14);
      }
      cursor = nestedY;
    } else if (block.type === "toc") {
      cursor += 14;
    }
  }
  return { height: Math.max(cursor + cellMargins.bottom, 14), boxes };
}

function flowTable(
  state: LayoutState,
  table: Table,
  section: Section,
  sectionIndex: number,
): void {
  const frame = currentFrame(state);
  const widths = computeColumnWidths(table, frame.width, state);
  const tableWidth = widths.reduce((sum, value) => sum + value, 0);
  const tableMargins = tableMarginsFor(table);
  markBlockPage(state, table.id);
  state.tables += 1;

  const headerRows: Table["rows"] = [];
  for (const row of table.rows) {
    if (row.props.isHeader) headerRows.push(row);
    else break;
  }

  let rowIndex = 0;
  let guard = 0;
  while (rowIndex < table.rows.length) {
    guard += 1;
    if (guard > 5000) {
      state.warnings.push({
        code: "table.iteration",
        message: "Table pagination guard tripped",
        blockId: table.id,
      });
      break;
    }
    const row = table.rows[rowIndex];
    // Row height from content.
    let contentHeight = 14;
    const cellBoxes: Array<{
      cellIndex: number;
      boxes: ReturnType<typeof layoutCellContent>["boxes"];
      height: number;
    }> = [];
    let columnIndex = 0;
    for (const cell of row.cells) {
      const span = cell.props.gridSpan ?? 1;
      const cellWidth = widths
        .slice(columnIndex, columnIndex + span)
        .reduce((sum, value) => sum + value, 0);
      if (cell.props.vMerge === "continue") {
        cellBoxes.push({ cellIndex: columnIndex, boxes: [], height: 0 });
        columnIndex += span;
        continue;
      }
      const content = layoutCellContent(
        state,
        cell.blocks,
        cellWidth,
        resolvedMargins(cell, tableMargins),
      );
      contentHeight = Math.max(contentHeight, content.height);
      cellBoxes.push({
        cellIndex: columnIndex,
        boxes: content.boxes,
        height: content.height,
      });
      columnIndex += span;
    }
    const explicitHeight = row.props.height ?? 0;
    const rowHeight = Math.max(contentHeight, explicitHeight, 14);

    const frameNow = currentFrame(state);
    const pageNow = currentPage(state);
    const bottomNow = frameNow.y + frameNow.height - pageNow.footnoteHeight;
    if (state.flow.y + rowHeight > bottomNow + 0.01) {
      // Move the row to the next page/column, repeating header rows.
      if (!row.props.cantSplit) {
        if (state.flow.columnIndex + 1 < pageNow.columns.length) {
          state.flow.columnIndex += 1;
          state.flow.y = pageNow.columns[state.flow.columnIndex].y;
        } else {
          startNewPage(state, section, sectionIndex);
        }
      } else {
        startNewPage(state, section, sectionIndex);
      }
      // Repeat header rows at the top of the new page.
      if (headerRows.length > 0 && rowIndex >= headerRows.length) {
        for (const header of headerRows) {
          let col = 0;
          for (const cell of header.cells) {
            const span = cell.props.gridSpan ?? 1;
            const width = widths
              .slice(col, col + span)
              .reduce((sum, value) => sum + value, 0);
            const content = layoutCellContent(
              state,
              cell.blocks,
              width,
              resolvedMargins(cell, tableMargins),
            );
            drawCell(
              state,
              table,
              header,
              cell,
              col,
              widths,
              state.flow.y,
              width,
              content,
              true,
            );
            col += span;
          }
          state.flow.y += Math.max(14, header.props.height ?? 0);
        }
      }
      continue;
    }

    // Draw the row.
    const rowTop = state.flow.y;
    let col = 0;
    for (const cell of row.cells) {
      const span = cell.props.gridSpan ?? 1;
      const cellWidth = widths
        .slice(col, col + span)
        .reduce((sum, value) => sum + value, 0);
      if (cell.props.vMerge === "continue") {
        col += span;
        continue;
      }
      const entry = cellBoxes.find((item) => item.cellIndex === col);
      drawCell(
        state,
        table,
        row,
        cell,
        col,
        widths,
        rowTop,
        cellWidth,
        { height: rowHeight, boxes: entry?.boxes ?? [] },
        false,
      );
      col += span;
    }

    state.flow.y += rowHeight;
    rowIndex += 1;
  }
}

function drawCell(
  state: LayoutState,
  table: Table,
  row: Table["rows"][number],
  cell: Table["rows"][number]["cells"][number],
  columnIndex: number,
  widths: number[],
  rowTop: number,
  cellWidth: number,
  content: { height: number; boxes: Array<{ relative: LayoutBox }> },
  isHeaderRepeat: boolean,
): void {
  const frame = currentFrame(state);
  const x =
    frame.x +
    widths.slice(0, columnIndex).reduce((sum, value) => sum + value, 0);
  const borders = cell.props.borders;
  const tableBorders = table.props.borders;
  const border = {
    top: cellBorder(borders?.top ?? tableBorders?.top),
    bottom: cellBorder(borders?.bottom ?? tableBorders?.bottom),
    left: cellBorder(borders?.left ?? tableBorders?.left),
    right: cellBorder(borders?.right ?? tableBorders?.right),
  };
  const margins = resolvedMargins(cell, tableMarginsFor(table));
  const rowHeight = content.height;
  // Background.
  if (
    cell.props.background?.fill ||
    row.props.shading?.fill ||
    table.props.shading?.fill
  ) {
    emit(state, {
      id: `cellbg-${cell.id}-${Math.round(rowTop)}`,
      kind: "rect",
      x,
      y: rowTop,
      width: cellWidth,
      height: rowHeight,
      fill:
        cell.props.background?.fill ??
        row.props.shading?.fill ??
        table.props.shading?.fill,
      tableId: table.id,
      cellId: cell.id,
      z: -1,
    });
  }
  // Borders.
  const hasBorder = border.top || border.bottom || border.left || border.right;
  if (hasBorder) {
    emit(state, {
      id: `cellborder-${cell.id}-${Math.round(rowTop)}`,
      kind: "rect",
      x,
      y: rowTop,
      width: cellWidth,
      height: rowHeight,
      border: {
        top: border.top,
        bottom: border.bottom,
        left: border.left,
        right: border.right,
      },
      tableId: table.id,
      cellId: cell.id,
      z: 1,
    });
  }
  // Content.
  if (!isHeaderRepeat || content.boxes.length > 0) {
    for (const entry of content.boxes) {
      const box = entry.relative as LayoutBox;
      const adjusted = {
        ...box,
        x: box.x + x,
        y: box.y + rowTop,
        tableId: table.id,
        cellId: cell.id,
      } as LayoutBox;
      emit(state, adjusted);
    }
  }
  if (cell.props.vAlign === "center" || cell.props.vAlign === "bottom") {
    const innerHeight = rowHeight - margins.top - margins.bottom;
    const contentHeight = content.boxes.reduce((max, entry) => {
      const box = entry.relative as LayoutBox;
      return Math.max(max, box.y + box.height);
    }, 0);
    const delta =
      cell.props.vAlign === "center"
        ? (innerHeight - contentHeight) / 2
        : innerHeight - contentHeight;
    if (delta > 1) {
      for (const entry of content.boxes) {
        const box = entry.relative as LayoutBox;
        box.y += delta;
      }
    }
  }
}

function cellBorder(
  side:
    | { style: string; width: number; color?: string; none?: boolean }
    | undefined,
) {
  if (!side || side.none || side.style === "none") return undefined;
  return {
    width: side.width || 0.5,
    color: side.color ?? "#000000",
    style: side.style,
  };
}

/* -------------------------------------------------------------- TOC block */

function flowToc(
  state: LayoutState,
  toc: TocBlock,
  section: Section,
  sectionIndex: number,
): void {
  const entries = documentOutline(state.doc, {
    maxLevel: toc.maxLevel,
    includeTitle: toc.includeTitle ?? false,
  }).filter((entry) => entry.level >= toc.minLevel);
  const frame = currentFrame(state);
  const font = state.resolver.resolve(undefined, 11);
  const metrics = state.resolver.metricsFor(font);
  const lineHeight = naturalLineHeight(font, metrics) * 1.15;

  for (const entry of entries) {
    const page =
      state.pageNumberByBlock.get(entry.blockId) ??
      state.tocPageNumbers.get(entry.blockId) ??
      0;
    ensureSpace(state, section, sectionIndex, lineHeight);
    const frameNow = currentFrame(state);
    const indentLeft = (Math.max(1, entry.level) - 1) * 18;
    const left = frameNow.x + indentLeft;
    const width = frameNow.width - indentLeft;
    const y = state.flow.y;
    const numberWidth = page > 0 ? measureText(String(page), font, metrics) : 0;
    const textWidth = Math.max(0, width - numberWidth - 12);
    const labelWidth = measureText(entry.text, font, metrics);
    const dots =
      toc.tabLeader === "dot" && labelWidth < textWidth
        ? Math.max(
            0,
            Math.floor(
              (textWidth - labelWidth) / measureText(".", font, metrics),
            ) - 1,
          )
        : 0;
    const runs: LayoutTextRun[] = [
      {
        text: entry.text,
        x: left,
        width: labelWidth,
        font,
        baseline: y + ascentFor(font, metrics),
      },
    ];
    if (dots > 0) {
      runs.push({
        text: ".".repeat(dots),
        x: left + labelWidth + 2,
        width: measureText(".".repeat(dots), font, metrics),
        font,
        color: "#888888",
        baseline: y + ascentFor(font, metrics),
      });
    }
    if (page > 0) {
      runs.push({
        text: String(page),
        x: left + width - numberWidth,
        width: numberWidth,
        font,
        baseline: y + ascentFor(font, metrics),
      });
    }
    emit(state, {
      id: `toc-${toc.id}-${entry.blockId}`,
      kind: "text",
      x: left,
      y,
      width,
      height: lineHeight,
      baseline: y + ascentFor(font, metrics),
      runs,
      alignment: "left",
      blockId: toc.id,
    });
    state.flow.y += lineHeight;
  }
  markBlockPage(state, toc.id);
}

/* ------------------------------------------------------- headers/footers */

function fieldTextForRegion(
  state: LayoutState,
  block: Block,
  displayNumber: number,
): void {
  // Header/footer layout resolves PAGE/NUMPAGES at render time via fields; the
  // simplest correct approach is a dedicated single-block layout pass below.
  void block;
  void displayNumber;
}

function layoutRegionBlocks(
  state: LayoutState,
  blocks: Block[],
  region: { x: number; y: number; width: number; height: number },
  displayNumber: number,
): LayoutRegion {
  const boxes: LayoutBox[] = [];
  let y = region.y;
  for (const block of blocks) {
    if (block.type === "paragraph") {
      const layout = layoutParagraph(
        state,
        substituteFields(state, block, displayNumber),
        region.width,
        displayNumber,
      );
      for (const line of layout.lines) {
        y += line.spaceBefore;
        if (y + line.height > region.y + region.height) break;
        const positioned = positionItems(state, line, region.x, region.width);
        let offset = 0;
        const alignment = line.alignment ?? "left";
        if (alignment === "center")
          offset = (region.width - positioned.totalWidth) / 2;
        else if (alignment === "right")
          offset = region.width - positioned.totalWidth;
        let x = region.x + Math.max(0, offset);
        const runs: LayoutTextRun[] = [];
        for (const item of positioned.items) {
          if (item.kind !== "text" || !item.font || !item.text) {
            x += item.width;
            continue;
          }
          runs.push({
            text: item.text,
            x,
            width: item.width,
            font: item.font,
            color: item.props?.color,
            baseline: y + line.ascent,
            decoration: {
              underline:
                item.props?.underline !== undefined &&
                item.props?.underline !== false,
            },
            hyperlink: item.props?.hyperlink,
          });
          x += item.width;
        }
        if (runs.length > 0) {
          boxes.push({
            id: `hf-${block.id}-${Math.round(y)}`,
            kind: "text",
            x: region.x,
            y,
            width: region.width,
            height: line.height,
            baseline: y + line.ascent,
            runs,
            alignment: alignment === "distribute" ? "justify" : alignment,
            blockId: block.id,
          });
        }
        y += line.height + line.spaceAfter;
      }
    }
  }
  return { ...region, boxes };
}

/** Replaces PAGE/NUMPAGES field nodes with literal text for header/footer layout. */
function substituteFields(
  state: LayoutState,
  paragraph: Paragraph,
  displayNumber: number,
): Paragraph {
  const inlines: Inline[] = [];
  for (const inline of paragraph.inlines) {
    if (inline.type === "field") {
      const text = resolveFieldText(
        state,
        inline,
        displayNumber,
        state.totalPages,
      );
      if (text) {
        inlines.push({ type: "text", text, props: {} });
        continue;
      }
      inlines.push(inline);
      continue;
    }
    inlines.push(inline);
  }
  return { ...paragraph, inlines };
}

/* ------------------------------------------------------------- footnotes */

function layoutFootnoteRegion(
  state: LayoutState,
  page: PageState,
): LayoutRegion | undefined {
  if (page.notes.length === 0) return undefined;
  const section =
    state.doc.sections[page.page.sectionIndex] ?? state.doc.sections[0];
  const margins = section.page.margins;
  const width = section.page.width - margins.left - margins.right;
  const totalHeight = page.footnoteHeight;
  const y = section.page.height - margins.bottom - totalHeight;
  const region: LayoutRegion = {
    x: margins.left,
    y,
    width,
    height: totalHeight,
    boxes: [],
  };
  const font = state.resolver.resolve(undefined, 9);
  const metrics = state.resolver.metricsFor(font);
  const lineHeight = naturalLineHeight(font, metrics);
  let cursor = y;
  // Separator rule above notes.
  region.boxes.push({
    id: `fn-sep-${page.page.index}`,
    kind: "line",
    x: margins.left,
    y: cursor,
    width: width * 0.33,
    height: 0.5,
    color: "#000000",
    thickness: 0.5,
  });
  cursor += 4;
  for (const note of page.notes) {
    const text = note.blocks
      .map((block) =>
        block.type === "paragraph" ? inlineTextOf(block.inlines) : "",
      )
      .join(" ");
    const runs: LayoutTextRun[] = [
      {
        text: `${note.number}. `,
        x: margins.left,
        width: measureText(`${note.number}. `, font, metrics),
        font,
        baseline: cursor + ascentFor(font, metrics),
        vertAlign: "superscript",
      },
      {
        text,
        x: margins.left + measureText(`${note.number}. `, font, metrics),
        width: measureText(text, font, metrics),
        font,
        baseline: cursor + ascentFor(font, metrics),
      },
    ];
    region.boxes.push({
      id: `fn-${note.noteId}`,
      kind: "text",
      x: margins.left,
      y: cursor,
      width,
      height: lineHeight,
      baseline: cursor + ascentFor(font, metrics),
      runs,
      alignment: "left",
    });
    cursor += note.height - 6;
  }
  return region;
}

/* ---------------------------------------------------------- page finishing */

function finishPageHeaders(state: LayoutState): void {
  for (const pageState of state.pages) {
    const page = pageState.page;
    const section =
      state.doc.sections[page.sectionIndex] ?? state.doc.sections[0];
    if (!state.headersFooters) continue;
    const margins = section.page.margins;
    const isFirstOfSection = (() => {
      const previous = state.pages[page.index - 1];
      return !previous || previous.page.sectionIndex !== page.sectionIndex;
    })();
    const variantKey: "default" | "first" | "even" =
      section.titlePage && isFirstOfSection
        ? "first"
        : section.evenAndOdd && page.displayNumber % 2 === 0
          ? "even"
          : "default";
    const header = section.headers[variantKey] ?? section.headers.default;
    const footer = section.footers[variantKey] ?? section.footers.default;
    if (header) {
      page.header = layoutRegionBlocks(
        state,
        header.blocks,
        {
          x: margins.left,
          y: Math.max(0, margins.top - margins.header),
          width: page.width - margins.left - margins.right,
          height: margins.header,
        },
        page.displayNumber,
      );
    }
    if (footer) {
      page.footer = layoutRegionBlocks(
        state,
        footer.blocks,
        {
          x: margins.left,
          y: page.height - margins.bottom,
          width: page.width - margins.left - margins.right,
          height: margins.footer + margins.bottom,
        },
        page.displayNumber,
      );
    }
    const footnoteRegion = layoutFootnoteRegion(state, pageState);
    if (footnoteRegion) page.footnoteRegion = footnoteRegion;
  }
}

/* ------------------------------------------------------------- main entry */

export function layoutDocument(
  doc: DocDocument,
  options: import("./types.js").LayoutOptions = {},
): LayoutResult {
  const started = Date.now();
  const resolver = new FontResolver({
    substitutions: options.fontSubstitutions,
  });
  const labels = computeNumbering(doc).labels;
  const warnings: LayoutWarning[] = [];
  const revisionMode = options.revisionMode ?? "all";
  const maxPasses = clamp(options.maxPasses ?? 3, 1, 5);

  const bookmarkBlock = new Map<string, string>();
  for (const bookmark of doc.bookmarks) {
    if (bookmark.paragraphId)
      bookmarkBlock.set(bookmark.name, bookmark.paragraphId);
  }

  let pages: PageState[] = [];
  let pageNumberByBlock = new Map<string, number>();
  let tocEntries: TocEntryLayout[] = [];
  let totalPages = 1;
  let tocNumbers = new Map<string, number>();
  let finalState: LayoutState | undefined;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const state: LayoutState = {
      doc,
      resolver,
      warnings: [],
      labels,
      pages: [],
      pageNumberByBlock: new Map(),
      bookmarkBlock,
      notesByNumber: new Map(),
      seqCounters: new Map(),
      totalPages: pass === 0 ? 1 : totalPages,
      headersFooters: options.headersFooters !== false,
      revisionMode,
      hyphenate: options.hyphenate === true,
      tocPageNumbers: tocNumbers,
      fieldTotals: new Map(),
      currentSection: doc.sections[0],
      sectionPageNumber: 0,
      flow: { pageIndex: 0, columnIndex: 0, y: 0, bottom: 0 },
      images: 0,
      lines: 0,
      tables: 0,
      footnotes: 0,
      shapeQueue: [],
    };

    doc.sections.forEach((section, sectionIndex) => {
      state.currentSection = section;
      if (sectionIndex === 0) {
        const start = section.pageNumbering?.start ?? 1;
        state.sectionPageNumber = start - 1;
        startNewPage(state, section, sectionIndex);
      } else {
        const start = section.pageNumbering?.start;
        if (start !== undefined) state.sectionPageNumber = start - 1;
        if (section.breakBefore === "continuous") {
          warnings.push({
            code: "section.continuous",
            message: "Continuous section break laid out as a page break",
          });
          startNewPage(state, section, sectionIndex);
        } else {
          startNewPage(state, section, sectionIndex);
          if (
            section.breakBefore === "oddPage" &&
            state.sectionPageNumber % 2 === 0
          ) {
            startNewPage(state, section, sectionIndex);
          } else if (
            section.breakBefore === "evenPage" &&
            state.sectionPageNumber % 2 === 1
          ) {
            startNewPage(state, section, sectionIndex);
          }
        }
      }

      for (const block of section.blocks) {
        if (block.type === "paragraph") {
          flowParagraph(state, block, section, sectionIndex);
        } else if (block.type === "table") {
          ensureSpace(state, section, sectionIndex, 24);
          flowTable(state, block, section, sectionIndex);
        } else {
          ensureSpace(state, section, sectionIndex, 24);
          flowToc(state, block, section, sectionIndex);
        }
      }
    });

    if (state.pages.length === 0) startNewPage(state, doc.sections[0], 0);
    totalPages = state.pages.length;
    state.totalPages = totalPages;
    pages = state.pages;
    pageNumberByBlock = state.pageNumberByBlock;
    warnings.push(...state.warnings);
    finalState = state;

    const newTocNumbers = new Map<string, number>();
    for (const entry of documentOutline(doc, {
      maxLevel: 9,
      includeTitle: true,
    })) {
      const page = pageNumberByBlock.get(entry.blockId);
      if (page) newTocNumbers.set(entry.blockId, page);
    }
    const stable =
      newTocNumbers.size === tocNumbers.size &&
      [...newTocNumbers.entries()].every(
        ([key, value]) => tocNumbers.get(key) === value,
      );
    tocNumbers = newTocNumbers;
    if (stable && pass > 0) break;
  }

  finishPageHeadersFor(finalState, totalPages, warnings);

  tocEntries = documentOutline(doc, { maxLevel: 9, includeTitle: true }).map(
    (entry) => ({
      blockId: entry.blockId,
      level: entry.level,
      text: entry.text,
      page: tocNumbers.get(entry.blockId) ?? 0,
    }),
  );

  const imageCount = pages.reduce(
    (sum, page) =>
      sum + page.page.boxes.filter((box) => box.kind === "image").length,
    0,
  );
  const lineCount = pages.reduce(
    (sum, page) =>
      sum + page.page.boxes.filter((box) => box.kind === "text").length,
    0,
  );

  return {
    pages: pages.map((page) => page.page),
    pageCount: pages.length,
    pageNumberByBlock,
    tocEntries,
    warnings: dedupeWarnings(warnings),
    stats: {
      lines: lineCount,
      tables: doc.sections.reduce(
        (sum, section) => sum + countTables(section.blocks),
        0,
      ),
      images: imageCount,
      footnotes: pages.reduce((sum, page) => sum + page.notes.length, 0),
    },
    substitutedFonts: [...resolver.substituted].sort(),
    durationMs: Date.now() - started,
  };
}

function finishPageHeadersFor(
  state: LayoutState | undefined,
  totalPages: number,
  warnings: LayoutWarning[],
): void {
  if (!state) return;
  state.totalPages = totalPages;
  const before = state.warnings.length;
  finishPageHeaders(state);
  for (const warning of state.warnings.slice(before)) warnings.push(warning);
}

function countTables(blocks: Block[]): number {
  let count = 0;
  for (const block of blocks) {
    if (block.type === "table") {
      count += 1;
      for (const row of block.rows)
        for (const cell of row.cells) count += countTables(cell.blocks);
    }
  }
  return count;
}

function dedupeWarnings(warnings: LayoutWarning[]): LayoutWarning[] {
  const seen = new Set<string>();
  const out: LayoutWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}|${warning.message}|${warning.blockId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(warning);
  }
  return out;
}

/** Page info for a block (used by MCP `document_get_page_info`). */
export function pageInfoForBlock(
  result: LayoutResult,
  blockId: string,
): import("./types.js").PageInfo {
  const pageNumber = result.pageNumberByBlock.get(blockId) ?? null;
  const page = pageNumber !== null ? result.pages[pageNumber - 1] : undefined;
  return {
    pageCount: result.pageCount,
    blockPage: pageNumber,
    blockId,
    page: page
      ? {
          index: page.index,
          displayNumber: page.displayNumber,
          width: page.width,
          height: page.height,
          orientation: page.orientation,
          sectionIndex: page.sectionIndex,
        }
      : null,
  };
}

export { round };
