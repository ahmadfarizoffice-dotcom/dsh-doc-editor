/**
 * High level editing operations used by the toolbar, the keyboard layer and the
 * panels. Every function mutates the supplied `DocDocument` using the shared
 * model's deterministic edit operations, and returns the selection the surface
 * should restore afterwards.
 */
import {
  addComment,
  applyHyperlink,
  applyList,
  applyStyle,
  blocksInRange,
  clearFormatting,
  computeNumbering,
  deleteRange,
  documentStats,
  ensureBoundary,
  findBlock,
  findParagraph,
  formatParagraphs,
  formatRange,
  inheritedRunProps,
  insertFootnote,
  insertSectionBreak,
  insertTable,
  insertText,
  insertToc,
  listBlocks,
  mergeRunProps,
  newId,
  offsetInParagraph,
  paragraphText,
  removeList,
  resolveParagraphProps,
  resolveRunProps,
  searchDocument,
  setMetadata,
  setTrackChanges,
  textOffsetToPosition,
} from "@dsh-doc/core/model";
import type {
  Alignment,
  Block,
  DocDocument,
  DocRange,
  ImageInline,
  Inline,
  Paragraph,
  ParagraphProps,
  RunProps,
  Section,
  TextPosition,
} from "@dsh-doc/core/model";
import { normalizeRange, type EditorSelection } from "./selection";

export interface ParagraphInRange {
  paragraph: Paragraph;
  blockId: string;
  /** Plain text offset where the range starts inside this paragraph. */
  from: number;
  /** Plain text offset where the range ends inside this paragraph. */
  to: number;
}

/** Paragraphs touched by a range, with the covered text offsets in each. */
export function paragraphsInRange(
  doc: DocDocument,
  range: DocRange,
): ParagraphInRange[] {
  const startLoc = findParagraph(doc, range.start.blockId);
  const endLoc = findParagraph(doc, range.end.blockId);
  if (!startLoc || !endLoc) return [];

  const order = listBlocks(doc);
  const startIndex = order.findIndex(
    (entry) => entry.block.id === startLoc.paragraph.id,
  );
  const endIndex = order.findIndex(
    (entry) => entry.block.id === endLoc.paragraph.id,
  );
  if (startIndex < 0 || endIndex < 0) return [];

  const out: ParagraphInRange[] = [];
  for (
    let index = Math.min(startIndex, endIndex);
    index <= Math.max(startIndex, endIndex);
    index += 1
  ) {
    const located = findParagraph(doc, order[index].block.id);
    if (!located) continue;
    const paragraph = located.paragraph;
    const text = paragraphText(paragraph);
    const from =
      paragraph.id === startLoc.paragraph.id
        ? Math.min(offsetInParagraph(paragraph, range.start), text.length)
        : 0;
    const to =
      paragraph.id === endLoc.paragraph.id
        ? Math.min(offsetInParagraph(paragraph, range.end), text.length)
        : text.length;
    out.push({ paragraph, blockId: paragraph.id, from, to });
  }
  return out;
}

/** Block ids covered by a range, restricted to paragraphs (what paragraph ops need). */
export function paragraphBlockIds(doc: DocDocument, range: DocRange): string[] {
  const ids = paragraphsInRange(doc, range).map((entry) => entry.blockId);
  if (ids.length > 0) return ids;
  const fallback =
    findParagraph(doc, range.start.blockId) ??
    findParagraph(doc, range.end.blockId);
  return fallback ? [fallback.paragraph.id] : [];
}

export function selectionRange(
  doc: DocDocument,
  selection: EditorSelection,
): DocRange {
  const order = listBlocks(doc).map((entry) => entry.block.id);
  return normalizeRange(order, selection.anchor, selection.focus);
}

/** Collapsed caret selection helper. */
export function collapsed(position: TextPosition): EditorSelection {
  return { anchor: { ...position }, focus: { ...position } };
}

function sameRunProps(a: RunProps, b: RunProps): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) =>
      key in b &&
      (a as Record<string, unknown>)[key] ===
        (b as Record<string, unknown>)[key],
  );
}

/**
 * Merges adjacent text runs that carry identical formatting.
 *
 * Typing inserts one run per keystroke; without this the model (and every
 * export) would accumulate thousands of single-character runs. The merge is
 * formatting-preserving, so it never changes how the text renders.
 */
export function mergeAdjacentTextRuns(paragraph: Paragraph): void {
  const merged: Inline[] = [];
  for (const inline of paragraph.inlines) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.type === "text" &&
      inline.type === "text" &&
      sameRunProps(previous.props, inline.props)
    ) {
      merged[merged.length - 1] = {
        ...previous,
        text: previous.text + inline.text,
      };
      continue;
    }
    merged.push(inline);
  }
  if (merged.length !== paragraph.inlines.length) paragraph.inlines = merged;
}

/* ------------------------------------------------------------- formatting */

const TOGGLE_KEYS = [
  "bold",
  "italic",
  "underline",
  "strike",
  "caps",
  "smallCaps",
] as const;
export type ToggleKey = (typeof TOGGLE_KEYS)[number];

function truthy(value: unknown): boolean {
  return (
    value !== undefined && value !== null && value !== false && value !== "none"
  );
}

/** Effective character formatting at a model position. */
export function runPropsAt(doc: DocDocument, position: TextPosition): RunProps {
  const located = findParagraph(doc, position.blockId);
  if (!located) return {};
  const paragraph = located.paragraph;
  const inline = paragraph.inlines[position.inlineIndex];
  const direct =
    inline && inline.type === "text" && position.offset > 0
      ? inline.props
      : inheritedRunProps(paragraph, position);
  return resolveRunProps(doc, {
    paragraphStyle: paragraph.style,
    characterStyle: direct.characterStyle,
    direct,
  });
}

export interface ActiveFormatting {
  run: RunProps;
  paragraph: ParagraphProps;
  style?: string;
  blockIds: string[];
  hasRange: boolean;
}

/** Current formatting for toolbar state: intersection over the selection. */
export function readActiveFormatting(
  doc: DocDocument,
  selection: EditorSelection,
): ActiveFormatting {
  const range = selectionRange(doc, selection);
  const targets = paragraphsInRange(doc, range);
  const first = targets[0];
  const paragraph: ParagraphProps = first
    ? resolveParagraphProps(doc, first.paragraph)
    : {};
  const hasRange =
    range.start.blockId !== range.end.blockId ||
    range.start.inlineIndex !== range.end.inlineIndex ||
    range.start.offset !== range.end.offset;

  if (!hasRange) {
    return {
      run: runPropsAt(doc, range.start),
      paragraph,
      style: first?.paragraph.style,
      blockIds: targets.map((entry) => entry.blockId),
      hasRange: false,
    };
  }

  const run: RunProps = {
    bold: true,
    italic: true,
    underline: "single",
    strike: true,
    caps: true,
    smallCaps: true,
  };
  let sawText = false;
  let valuesSeen = false;
  let commonFontFamily: string | undefined;
  let commonFontSize: number | undefined;
  let commonColor: string | undefined;
  let commonHighlight: string | undefined;
  for (const target of targets) {
    const text = paragraphText(target.paragraph);
    const from = Math.min(target.from, text.length);
    const to = Math.min(target.to, text.length);
    if (from === to) continue;
    let offset = 0;
    for (const inline of target.paragraph.inlines) {
      const length =
        inline.type === "text"
          ? inline.text.length
          : inline.type === "image" ||
              inline.type === "tab" ||
              inline.type === "break"
            ? 1
            : 0;
      const inlineStart = offset;
      const inlineEnd = offset + length;
      offset = inlineEnd;
      if (inlineEnd <= from || inlineStart >= to) continue;
      if (inline.type !== "text") continue;
      sawText = true;
      const resolved = resolveRunProps(doc, {
        paragraphStyle: target.paragraph.style,
        characterStyle: inline.props.characterStyle,
        direct: inline.props,
      });
      for (const key of TOGGLE_KEYS) {
        if (!truthy(resolved[key]))
          (run as Record<string, unknown>)[key] = false;
      }
      // Non-toggle run properties are reported only when every selected run
      // agrees, so the toolbar shows a blank/mixed value instead of guessing.
      if (!valuesSeen) {
        valuesSeen = true;
        commonFontFamily = resolved.fontFamily;
        commonFontSize = resolved.fontSize;
        commonColor = resolved.color;
        commonHighlight = resolved.highlight;
      } else {
        if (commonFontFamily !== resolved.fontFamily)
          commonFontFamily = undefined;
        if (commonFontSize !== resolved.fontSize) commonFontSize = undefined;
        if (commonColor !== resolved.color) commonColor = undefined;
        if (commonHighlight !== resolved.highlight) commonHighlight = undefined;
      }
    }
  }
  if (!sawText) {
    for (const key of TOGGLE_KEYS)
      (run as Record<string, unknown>)[key] = false;
  }
  if (commonFontFamily !== undefined) run.fontFamily = commonFontFamily;
  if (commonFontSize !== undefined) run.fontSize = commonFontSize;
  if (commonColor !== undefined) run.color = commonColor;
  if (commonHighlight !== undefined) run.highlight = commonHighlight;
  return {
    run,
    paragraph,
    style: first?.paragraph.style,
    blockIds: targets.map((entry) => entry.blockId),
    hasRange: true,
  };
}

/**
 * Toggles a character mark over the selection.
 *
 * Collapsed carets cannot be formatted by `formatRange` (Word would apply the
 * mark to the next typed text), so the caller receives `pending` and passes the
 * returned props to text insertion.
 */
export function selectionHasRange(
  doc: DocDocument,
  selection: EditorSelection,
): boolean {
  const range = selectionRange(doc, selection);
  return !(
    range.start.blockId === range.end.blockId &&
    range.start.inlineIndex === range.end.inlineIndex &&
    range.start.offset === range.end.offset
  );
}

/**
 * Toggles a character mark over the selection.
 *
 * Collapsed carets cannot be formatted by `formatRange` (Word applies the mark
 * to the next typed text), so the caller receives `pending` in that case.
 */
export function applyToggleMark(
  doc: DocDocument,
  selection: EditorSelection,
  key: ToggleKey,
): { value: boolean; pending: RunProps | null } {
  const active = readActiveFormatting(doc, selection);
  const current = active.run[key];
  const isOn = current !== undefined && current !== false && current !== "none";
  const next = !isOn;
  const patch: RunProps =
    key === "underline"
      ? { underline: next ? "single" : false }
      : ({ [key]: next } as RunProps);
  if (!active.hasRange) {
    return { value: next, pending: mergeRunProps(active.run, patch) };
  }
  formatRange(doc, selectionRange(doc, selection), patch);
  return { value: next, pending: null };
}

export function toggleRunMark(
  doc: DocDocument,
  selection: EditorSelection,
  key: ToggleKey,
): { value: boolean; pending: RunProps | null } & ActiveFormatting {
  const active = readActiveFormatting(doc, selection);
  const current = truthy(active.run[key]);
  const next = !current;
  const patch: RunProps =
    key === "underline"
      ? { underline: next ? "single" : false }
      : ({ [key]: next } as RunProps);

  if (!active.hasRange) {
    const pending = mergeRunProps(active.run, patch);
    return { ...active, value: next, pending };
  }
  formatRange(doc, selectionRange(doc, selection), patch);
  return {
    ...readActiveFormatting(doc, selection),
    value: next,
    pending: null,
  };
}

export function applyRunProps(
  doc: DocDocument,
  selection: EditorSelection,
  patch: RunProps,
): void {
  const range = selectionRange(doc, selection);
  formatRange(doc, range, patch);
}

export function clearSelectionFormatting(
  doc: DocDocument,
  selection: EditorSelection,
): void {
  clearFormatting(doc, selectionRange(doc, selection));
}

/* ------------------------------------------------------------ case changes */

export type CaseMode = "upper" | "lower" | "title" | "sentence";

const TITLE_WORD = /[\p{L}\p{N}][\p{L}\p{N}'\u2019-]*/gu;
const SENTENCE_SPLIT = /([.!?\u2026]+["'\u201d\u2019)]*\s+)/u;

function toTitleCase(text: string): string {
  return text.replace(TITLE_WORD, (word) => {
    const lower = word.toLocaleLowerCase();
    return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
  });
}

function toSentenceCase(text: string): string {
  const lower = text.toLocaleLowerCase();
  const parts = lower.split(SENTENCE_SPLIT);
  let atStart = true;
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (SENTENCE_SPLIT.test(part)) {
      out.push(part);
      atStart = true;
      continue;
    }
    if (atStart) {
      out.push(part.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase()));
      atStart = false;
    } else {
      out.push(part);
    }
  }
  return out.join("");
}

export function transformText(text: string, mode: CaseMode): string {
  switch (mode) {
    case "upper":
      return text.toLocaleUpperCase();
    case "lower":
      return text.toLocaleLowerCase();
    case "title":
      return toTitleCase(text);
    case "sentence":
      return toSentenceCase(text);
    default:
      return text;
  }
}

/**
 * Applies a case transform to the selected text while preserving run
 * formatting: runs are split at the range edges and only their text changes.
 */
export function transformRangeText(
  doc: DocDocument,
  selection: EditorSelection,
  mode: CaseMode,
): number {
  const range = selectionRange(doc, selection);
  if (
    range.start.blockId === range.end.blockId &&
    range.start.inlineIndex === range.end.inlineIndex &&
    range.start.offset === range.end.offset
  ) {
    return 0;
  }
  let changed = 0;
  for (const target of paragraphsInRange(doc, range)) {
    const paragraph = target.paragraph;
    if (target.from === target.to) continue;
    const startBoundary = ensureBoundary(
      paragraph,
      textOffsetToPosition(paragraph, target.from),
    );
    const endBoundary = ensureBoundary(
      paragraph,
      textOffsetToPosition(paragraph, target.to),
    );
    for (let index = startBoundary; index < endBoundary; index += 1) {
      const inline = paragraph.inlines[index];
      if (!inline || inline.type !== "text") continue;
      const next = transformText(inline.text, mode);
      if (next !== inline.text) {
        changed += Math.max(inline.text.length, next.length);
        paragraph.inlines[index] = { ...inline, text: next };
      }
    }
  }
  return changed;
}

/* ------------------------------------------------------------- paragraphs */

export function applyParagraphProps(
  doc: DocDocument,
  selection: EditorSelection,
  patch: ParagraphProps,
): void {
  const blockIds = paragraphBlockIds(doc, selectionRange(doc, selection));
  if (blockIds.length === 0) return;
  formatParagraphs(doc, blockIds, patch);
}

export function applyAlignment(
  doc: DocDocument,
  selection: EditorSelection,
  alignment: Alignment,
): void {
  applyParagraphProps(doc, selection, { alignment });
}

export function applyLineSpacing(
  doc: DocDocument,
  selection: EditorSelection,
  multiple: number,
): void {
  applyParagraphProps(doc, selection, {
    lineSpacing: { rule: "auto", value: Math.round(multiple * 240) },
  });
}

export function applyParagraphSpacing(
  doc: DocDocument,
  selection: EditorSelection,
  spacing: { before?: number; after?: number },
): void {
  applyParagraphProps(doc, selection, {
    ...(spacing.before !== undefined ? { spaceBefore: spacing.before } : {}),
    ...(spacing.after !== undefined ? { spaceAfter: spacing.after } : {}),
  });
}

export function applyIndent(
  doc: DocDocument,
  selection: EditorSelection,
  indent: {
    left?: number;
    right?: number;
    firstLine?: number;
    hanging?: number;
    clearFirstLine?: boolean;
    clearHanging?: boolean;
  },
): void {
  const current = readActiveFormatting(doc, selection).paragraph.indent ?? {};
  const next: ParagraphProps["indent"] = { ...current };
  if (indent.left !== undefined) next.left = Math.max(0, indent.left);
  if (indent.right !== undefined) next.right = Math.max(0, indent.right);
  if (indent.firstLine !== undefined)
    next.firstLine = Math.max(0, indent.firstLine);
  if (indent.hanging !== undefined) next.hanging = Math.max(0, indent.hanging);
  if (indent.clearFirstLine) delete next.firstLine;
  if (indent.clearHanging) delete next.hanging;
  applyParagraphProps(doc, selection, { indent: next });
}

export function applyParagraphStyle(
  doc: DocDocument,
  selection: EditorSelection,
  styleId: string,
): void {
  const blockIds = paragraphBlockIds(doc, selectionRange(doc, selection));
  if (blockIds.length === 0) return;
  applyStyle(doc, blockIds, styleId);
}

/* ------------------------------------------------------------------ lists */

export function toggleList(
  doc: DocDocument,
  selection: EditorSelection,
  kind: "bullet" | "number",
): { applied: boolean } {
  const blockIds = paragraphBlockIds(doc, selectionRange(doc, selection));
  if (blockIds.length === 0) return { applied: false };
  const numbering = computeNumbering(doc);
  const allInList = blockIds.every((blockId) => numbering.refs.has(blockId));
  if (allInList) {
    removeList(doc, blockIds);
    return { applied: false };
  }
  applyList(doc, blockIds, { kind });
  return { applied: true };
}

export function changeListLevel(
  doc: DocDocument,
  selection: EditorSelection,
  delta: number,
): boolean {
  const range = selectionRange(doc, selection);
  const blockIds = paragraphBlockIds(doc, range);
  if (blockIds.length === 0) return false;
  let changed = false;
  for (const blockId of blockIds) {
    const located = findParagraph(doc, blockId);
    if (!located) continue;
    const props = resolveParagraphProps(doc, located.paragraph);
    if (!props.numbering) continue;
    const level = Math.max(
      0,
      Math.min(8, (props.numbering.level ?? 0) + delta),
    );
    if (level === props.numbering.level) continue;
    located.paragraph.props = {
      ...located.paragraph.props,
      numbering: { ...props.numbering, level },
    };
    changed = true;
  }
  return changed;
}

export function listLabels(doc: DocDocument): Map<string, string> {
  const state = computeNumbering(doc);
  const out = new Map<string, string>();
  for (const [blockId, label] of state.labels) out.set(blockId, label.label);
  return out;
}

/* -------------------------------------------------------------- insertion */

/** Inserts text (replacing a selection) and returns the caret after it. */
export function insertTextAtSelection(
  doc: DocDocument,
  selection: EditorSelection,
  text: string,
  props?: RunProps,
): EditorSelection {
  const range = selectionRange(doc, selection);
  const isCollapsed =
    range.start.blockId === range.end.blockId &&
    range.start.inlineIndex === range.end.inlineIndex &&
    range.start.offset === range.end.offset;

  const startLoc = findParagraph(doc, range.start.blockId);
  if (!startLoc) throw new Error(`Unknown paragraph: ${range.start.blockId}`);
  const startOffset = offsetInParagraph(startLoc.paragraph, range.start);

  if (!isCollapsed) deleteRange(doc, range);

  const paragraph = findParagraph(doc, range.start.blockId)?.paragraph;
  if (!paragraph) throw new Error(`Unknown paragraph: ${range.start.blockId}`);
  const position = textOffsetToPosition(paragraph, startOffset);
  const result = insertText(doc, position, text, props ? { props } : {});

  // Merge the runs the insertion produced so typing does not create one run per
  // keystroke; recompute the caret afterwards because merge changes run indices.
  const endLocator = findParagraph(doc, result.end.blockId)?.paragraph;
  const endOffset = endLocator ? offsetInParagraph(endLocator, result.end) : 0;
  for (const blockId of result.blockIds) {
    const created = findParagraph(doc, blockId)?.paragraph;
    if (created) mergeAdjacentTextRuns(created);
  }
  const mergedEnd = findParagraph(doc, result.end.blockId)?.paragraph;
  if (!mergedEnd) return collapsed(result.end);
  return collapsed(
    textOffsetToPosition(
      mergedEnd,
      Math.min(endOffset, paragraphText(mergedEnd).length),
    ),
  );
}

/** Deletes the selection; the caret ends where the range started. */
export function deleteSelection(
  doc: DocDocument,
  selection: EditorSelection,
): EditorSelection {
  const range = selectionRange(doc, selection);
  const isCollapsed =
    range.start.blockId === range.end.blockId &&
    range.start.inlineIndex === range.end.inlineIndex &&
    range.start.offset === range.end.offset;
  if (isCollapsed) return collapsed(range.start);
  const startLoc = findParagraph(doc, range.start.blockId);
  const offset = startLoc
    ? offsetInParagraph(startLoc.paragraph, range.start)
    : 0;
  deleteRange(doc, range);
  const paragraph = findParagraph(doc, range.start.blockId)?.paragraph;
  if (!paragraph) return collapsed(range.start);
  return collapsed(
    textOffsetToPosition(
      paragraph,
      Math.min(offset, paragraphText(paragraph).length),
    ),
  );
}

export function splitParagraphAt(
  doc: DocDocument,
  position: TextPosition,
): EditorSelection {
  const result = insertText(doc, position, "\n");
  return collapsed(result.end);
}

export function insertLineBreakAt(
  doc: DocDocument,
  position: TextPosition,
): EditorSelection {
  const located = findParagraph(doc, position.blockId);
  if (!located) return collapsed(position);
  const boundary = ensureBoundary(located.paragraph, position);
  located.paragraph.inlines.splice(boundary, 0, {
    type: "break",
    kind: "line",
  });
  return collapsed({
    blockId: position.blockId,
    inlineIndex: boundary + 1,
    offset: 0,
  });
}

export function insertPageBreakAt(
  doc: DocDocument,
  position: TextPosition,
): EditorSelection {
  const located = findParagraph(doc, position.blockId);
  if (!located) return collapsed(position);
  const boundary = ensureBoundary(located.paragraph, position);
  located.paragraph.inlines.splice(boundary, 0, {
    type: "break",
    kind: "page",
  });
  return collapsed({
    blockId: position.blockId,
    inlineIndex: boundary + 1,
    offset: 0,
  });
}

export function insertTabAt(
  doc: DocDocument,
  position: TextPosition,
): EditorSelection {
  const located = findParagraph(doc, position.blockId);
  if (!located) return collapsed(position);
  const boundary = ensureBoundary(located.paragraph, position);
  located.paragraph.inlines.splice(boundary, 0, { type: "tab" });
  return collapsed({
    blockId: position.blockId,
    inlineIndex: boundary + 1,
    offset: 0,
  });
}

export interface TableInsertOptions {
  rows: number;
  columns: number;
  headerRow?: boolean;
  style?: string;
}

/** Inserts a table after the paragraph that holds the caret. */
export function insertTableAt(
  doc: DocDocument,
  selection: EditorSelection,
  options: TableInsertOptions,
): { tableId: string; selection: EditorSelection } {
  const range = selectionRange(doc, selection);
  const anchorBlock =
    findBlock(doc, range.end.blockId) ?? findBlock(doc, range.start.blockId);
  if (!anchorBlock)
    throw new Error("Cannot insert a table: the caret is not inside a block");
  const table = insertTable(doc, anchorBlock.block.id, {
    rows: options.rows,
    columns: options.columns,
    headerRow: options.headerRow,
    style: options.style,
  });
  const firstCellParagraph = table.rows[0]?.cells[0]?.blocks.find(
    (block): block is Paragraph => block.type === "paragraph",
  );
  const selectionAfter = firstCellParagraph
    ? collapsed({ blockId: firstCellParagraph.id, inlineIndex: 0, offset: 0 })
    : collapsed(range.end);
  return { tableId: table.id, selection: selectionAfter };
}

export interface ImageInsertPayload {
  /** `data:image/png;base64,...` */
  dataUrl: string;
  /** Displayed size in points. */
  width: number;
  height: number;
  naturalWidthPx?: number;
  naturalHeightPx?: number;
  alt?: string;
  fileName?: string;
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

function decodeDataUrl(dataUrl: string): {
  contentType: string;
  base64: string;
} {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/s.exec(
    dataUrl,
  );
  if (!match)
    throw new Error("Unsupported image data URL (base64 payload expected)");
  return { contentType: match[1] ?? "image/png", base64: match[2] ?? "" };
}

function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** Inserts an inline image and registers its media payload in the document. */
export function insertImageAt(
  doc: DocDocument,
  position: TextPosition,
  payload: ImageInsertPayload,
): { mediaId: string; selection: EditorSelection } {
  const located = findParagraph(doc, position.blockId);
  if (!located) throw new Error(`Unknown paragraph: ${position.blockId}`);
  const { contentType, base64 } = decodeDataUrl(payload.dataUrl);
  const mediaId = newId(doc, "img");
  doc.media.push({
    id: mediaId,
    fileName:
      payload.fileName ??
      `${mediaId}.${EXTENSION_BY_TYPE[contentType] ?? "bin"}`,
    contentType,
    data: base64,
    byteLength: base64ByteLength(base64),
    widthPx: payload.naturalWidthPx,
    heightPx: payload.naturalHeightPx,
    dpi: 96,
  });
  const boundary = ensureBoundary(located.paragraph, position);
  const inline: ImageInline = {
    type: "image",
    mediaId,
    width: payload.width,
    height: payload.height,
    naturalWidthPx: payload.naturalWidthPx,
    naturalHeightPx: payload.naturalHeightPx,
    alt: payload.alt,
    anchor: { type: "inline" },
    border: null,
  };
  located.paragraph.inlines.splice(boundary, 0, inline);
  return {
    mediaId,
    selection: collapsed({
      blockId: position.blockId,
      inlineIndex: boundary + 1,
      offset: 0,
    }),
  };
}

/** Applies (or removes) a hyperlink over the selection. */
export function applyLinkAt(
  doc: DocDocument,
  selection: EditorSelection,
  target: { href?: string; anchor?: string; tooltip?: string; text?: string },
): EditorSelection {
  const range = selectionRange(doc, selection);
  const isCollapsed =
    range.start.blockId === range.end.blockId &&
    range.start.inlineIndex === range.end.inlineIndex &&
    range.start.offset === range.end.offset;
  if (isCollapsed && target.text) {
    const afterInsert = insertTextAtSelection(doc, selection, target.text);
    const paragraph = findParagraph(doc, afterInsert.focus.blockId)?.paragraph;
    if (!paragraph) return afterInsert;
    const textRange: DocRange = {
      start: textOffsetToPosition(
        paragraph,
        Math.max(
          0,
          offsetInParagraph(paragraph, afterInsert.focus) - target.text.length,
        ),
      ),
      end: afterInsert.focus,
    };
    applyHyperlink(doc, textRange, target);
    return afterInsert;
  }
  applyHyperlink(doc, range, target);
  return selection;
}

export function insertFootnoteAt(
  doc: DocDocument,
  position: TextPosition,
  text: string,
): EditorSelection {
  const located = findParagraph(doc, position.blockId);
  if (!located) throw new Error(`Unknown paragraph: ${position.blockId}`);
  const boundary = ensureBoundary(located.paragraph, position);
  insertFootnote(doc, position, text);
  return collapsed({
    blockId: position.blockId,
    inlineIndex: boundary + 1,
    offset: 0,
  });
}

export function insertCommentAt(
  doc: DocDocument,
  selection: EditorSelection,
  text: string,
  author?: string,
): { commentId: string } {
  const range = selectionRange(doc, selection);
  const result = addComment(doc, range, { text, author });
  return { commentId: result.commentId };
}

export function insertTocAfterCaret(
  doc: DocDocument,
  selection: EditorSelection,
  options: { minLevel?: number; maxLevel?: number; caption?: string } = {},
): EditorSelection {
  const range = selectionRange(doc, selection);
  const anchor =
    findBlock(doc, range.end.blockId) ?? findBlock(doc, range.start.blockId);
  if (!anchor) throw new Error("Cannot insert a table of contents here");
  const result = insertToc(doc, anchor.block.id, {
    ...options,
    caption: options.caption,
  });
  const paragraphId = [...result.blockIds]
    .reverse()
    .find((blockId) => Boolean(findParagraph(doc, blockId)));
  if (!paragraphId) return selection;
  return collapsed({ blockId: paragraphId, inlineIndex: 0, offset: 0 });
}

export interface SectionBreakOptions {
  type?: Section["breakBefore"];
  landscape?: boolean;
}

/** Moves everything after the caret into a new section. */
export function insertSectionBreakAt(
  doc: DocDocument,
  selection: EditorSelection,
  options: SectionBreakOptions = {},
): void {
  const range = selectionRange(doc, selection);
  const located =
    findBlock(doc, range.end.blockId) ?? findBlock(doc, range.start.blockId);
  if (!located) throw new Error("Cannot insert a section break here");
  const section = doc.sections[located.sectionIndex];
  if (!section) throw new Error("Cannot insert a section break here");

  const isLastBlock = located.blockIndex >= section.blocks.length - 1;
  const existingNext = doc.sections[located.sectionIndex + 1];

  if (isLastBlock && existingNext) {
    // Nothing left to move: apply the requested page setup to the next section
    // instead of creating an empty one.
    existingNext.page = {
      ...existingNext.page,
      ...(options.landscape ? { orientation: "landscape" as const } : {}),
    };
    return;
  }

  insertSectionBreak(
    doc,
    { sectionIndex: located.sectionIndex, blockIndex: located.blockIndex + 1 },
    {
      type: options.type ?? "nextPage",
      ...(options.landscape
        ? { page: { orientation: "landscape" as const } }
        : {}),
    },
  );
}

export function updateTitle(doc: DocDocument, title: string): void {
  setMetadata(doc, { title });
}

export function setTrackedChanges(doc: DocDocument, enabled: boolean): void {
  setTrackChanges(doc, enabled);
}

/* --------------------------------------------------------- find & replace */

export interface TextMatch {
  blockId: string;
  start: number;
  end: number;
  text: string;
}

export function findMatches(
  doc: DocDocument,
  query: string,
  options: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    regex?: boolean;
  } = {},
): TextMatch[] {
  return searchDocument(doc, query, options).map((match) => ({
    blockId: match.blockId,
    start: match.start,
    end: match.end,
    text: match.text,
  }));
}

/** Replaces the given matches (highest offset first so positions stay valid). */
export function replaceMatches(
  doc: DocDocument,
  matches: TextMatch[],
  replacement: string,
): number {
  const ordered = [...matches].sort((a, b) => {
    if (a.blockId !== b.blockId) return a.blockId < b.blockId ? 1 : -1;
    return b.start - a.start;
  });
  let replaced = 0;
  for (const match of ordered) {
    const located = findParagraph(doc, match.blockId);
    if (!located) continue;
    const text = paragraphText(located.paragraph);
    if (text.slice(match.start, match.end) !== match.text) continue;
    const start = textOffsetToPosition(located.paragraph, match.start);
    const end = textOffsetToPosition(located.paragraph, match.end);
    deleteRange(doc, { start, end });
    const paragraph = findParagraph(doc, match.blockId)?.paragraph;
    if (!paragraph) continue;
    const insertAt = textOffsetToPosition(paragraph, match.start);
    insertText(doc, insertAt, replacement);
    replaced += 1;
  }
  return replaced;
}

/* ------------------------------------------------------------ deletions */

function previousBlock(
  doc: DocDocument,
  blockId: string,
): { block: Block } | null {
  const blocks = listBlocks(doc);
  const index = blocks.findIndex((entry) => entry.block.id === blockId);
  if (index <= 0) return null;
  const entry = blocks[index - 1];
  return entry ? { block: entry.block } : null;
}

function nextBlock(doc: DocDocument, blockId: string): { block: Block } | null {
  const blocks = listBlocks(doc);
  const index = blocks.findIndex((entry) => entry.block.id === blockId);
  if (index < 0 || index >= blocks.length - 1) return null;
  const entry = blocks[index + 1];
  return entry ? { block: entry.block } : null;
}

/** Grapheme-aware caret step inside a paragraph's plain text. */
export function previousGraphemeOffset(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  if (!segmenter) return offset - 1;
  let previous = Math.max(0, offset - 1);
  for (const segment of segmenter.segment(text.slice(0, offset))) {
    const start = segment.index;
    const segmentText = String(segment.segment);
    if (start + segmentText.length >= offset) {
      previous = start;
      break;
    }
  }
  return previous;
}

export function nextGraphemeOffset(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  if (!segmenter) return offset + 1;
  for (const segment of segmenter.segment(text.slice(offset))) {
    const start = offset + segment.index;
    if (start >= offset) {
      return Math.min(text.length, start + String(segment.segment).length);
    }
  }
  return text.length;
}

export function wordStartOffset(text: string, offset: number): number {
  let index = Math.max(0, Math.min(offset, text.length));
  while (index > 0 && /\s/u.test(text[index - 1] ?? "")) index -= 1;
  while (index > 0 && !/\s/u.test(text[index - 1] ?? "")) index -= 1;
  return index;
}

export function wordEndOffset(text: string, offset: number): number {
  let index = Math.max(0, Math.min(offset, text.length));
  while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
  while (index < text.length && !/\s/u.test(text[index] ?? "")) index += 1;
  return index;
}

function caretInParagraph(
  doc: DocDocument,
  position: TextPosition,
): EditorSelection | null {
  const paragraph = findParagraph(doc, position.blockId)?.paragraph;
  if (!paragraph) return null;
  return collapsed(
    textOffsetToPosition(
      paragraph,
      Math.min(
        offsetInParagraph(paragraph, position),
        paragraphText(paragraph).length,
      ),
    ),
  );
}

export function canDeleteBackward(
  doc: DocDocument,
  position: TextPosition,
): boolean {
  const located = findParagraph(doc, position.blockId);
  if (!located) return false;
  const offset = offsetInParagraph(located.paragraph, position);
  if (offset > 0) return true;
  const previous = previousBlock(doc, located.paragraph.id);
  return Boolean(previous && previous.block.type === "paragraph");
}

export function canDeleteForward(
  doc: DocDocument,
  position: TextPosition,
): boolean {
  const located = findParagraph(doc, position.blockId);
  if (!located) return false;
  const text = paragraphText(located.paragraph);
  const offset = offsetInParagraph(located.paragraph, position);
  if (offset < text.length) return true;
  const next = nextBlock(doc, located.paragraph.id);
  return Boolean(next && next.block.type === "paragraph");
}

export function deleteBackward(
  doc: DocDocument,
  position: TextPosition,
  unit: "character" | "word",
): EditorSelection | null {
  const located = findParagraph(doc, position.blockId);
  if (!located) return null;
  const paragraph = located.paragraph;
  const text = paragraphText(paragraph);
  const offset = offsetInParagraph(paragraph, position);

  if (offset === 0) {
    const previous = previousBlock(doc, paragraph.id);
    if (!previous || previous.block.type !== "paragraph") return null;
    const previousParagraph = previous.block;
    const previousEnd = textOffsetToPosition(
      previousParagraph,
      paragraphText(previousParagraph).length,
    );
    const mergedAt = {
      blockId: previousParagraph.id,
      inlineIndex: previousParagraph.inlines.length,
      offset: 0,
    };
    deleteRange(doc, { start: previousEnd, end: position });
    return collapsed(mergedAt);
  }

  const from =
    unit === "word"
      ? wordStartOffset(text, offset)
      : previousGraphemeOffset(text, offset);
  const start = textOffsetToPosition(paragraph, from);
  deleteRange(doc, { start, end: position });
  return caretInParagraph(doc, start);
}

export function deleteForward(
  doc: DocDocument,
  position: TextPosition,
  unit: "character" | "word",
): EditorSelection | null {
  const located = findParagraph(doc, position.blockId);
  if (!located) return null;
  const paragraph = located.paragraph;
  const text = paragraphText(paragraph);
  const offset = offsetInParagraph(paragraph, position);

  if (offset >= text.length) {
    const next = nextBlock(doc, paragraph.id);
    if (!next || next.block.type !== "paragraph") return null;
    const nextParagraph = next.block;
    const nextStart = textOffsetToPosition(nextParagraph, 0);
    deleteRange(doc, { start: position, end: nextStart });
    return caretInParagraph(doc, position);
  }

  const to =
    unit === "word"
      ? wordEndOffset(text, offset)
      : nextGraphemeOffset(text, offset);
  const end = textOffsetToPosition(paragraph, to);
  deleteRange(doc, { start: position, end });
  return caretInParagraph(doc, position);
}

/* ------------------------------------------------------------------ misc */

export function documentCounts(doc: DocDocument) {
  return documentStats(doc);
}

export function blocksOfRange(doc: DocDocument, range: DocRange): string[] {
  return blocksInRange(doc, range);
}

export function findParagraphById(
  doc: DocDocument,
  blockId: string,
): Paragraph | undefined {
  return findParagraph(doc, blockId)?.paragraph;
}

export function inlineLengthOf(inline: Inline): number {
  switch (inline.type) {
    case "text":
      return inline.text.length;
    case "tab":
    case "break":
    case "image":
      return 1;
    case "field":
      return inline.result
        ? inline.result.reduce((sum, child) => sum + inlineLengthOf(child), 0)
        : 0;
    case "math":
      return inline.linear.length;
    case "unknown":
      return (inline.text ?? "").length;
    default:
      return 0;
  }
}
