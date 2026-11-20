import {
  detachBlock,
  findBlock,
  findParagraph,
  listBlocks,
  listParagraphs,
} from "./access.js";
import { newId } from "./ids.js";
import { computeNumbering } from "./numbering.js";
import { mergeRunProps, resolveParagraphProps } from "./styles.js";
import { paragraphText } from "./text.js";
import type {
  Block,
  DocDocument,
  ImageInline,
  Inline,
  MathNode,
  MathRun,
  Paragraph,
  ParagraphProps,
  Revision,
  RunProps,
  Section,
  Table,
  TextPosition,
  TocBlock,
} from "./types.js";

/** Plain-text length of a paragraph. */
function textCount(paragraph: Paragraph): number {
  return paragraphText(paragraph).length;
}

/* --------------------------------------------------------------- utilities */

export function cloneDocument(doc: DocDocument): DocDocument {
  return structuredClone(doc);
}

function revisionStamp(
  doc: DocDocument,
  kind: Revision["kind"],
  summary: string,
  blockIds: string[],
): Revision {
  const revision: Revision = {
    id: newId(doc, "rev"),
    kind,
    author: doc.metadata.lastModifiedBy ?? doc.metadata.creator ?? "Unknown",
    date: new Date().toISOString(),
    summary,
    blockIds,
  };
  doc.revisions.push(revision);
  return revision;
}

function trackMark(
  doc: DocDocument,
  kind: "insert" | "delete" | "format",
  previous?: RunProps,
) {
  if (!doc.settings.trackRevisions) return undefined;
  const revision = revisionStamp(doc, kind, `${kind} tracked change`, []);
  return {
    id: revision.id,
    kind,
    author: revision.author,
    date: revision.date,
    previous: previous ? JSON.stringify(previous) : undefined,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Length a position contributes inside its paragraph text. */
export function inlineLength(inline: Inline): number {
  switch (inline.type) {
    case "text":
      return inline.text.length;
    case "tab":
    case "break":
    case "image":
      return 1;
    case "field":
      return inline.result
        ? inline.result.reduce((sum, child) => sum + inlineLength(child), 0)
        : 0;
    case "math":
      return inline.linear.length;
    case "unknown":
      return (inline.text ?? "").length;
    default:
      return 0;
  }
}

/**
 * Splits the paragraph at `position` so that `position` falls on an inline
 * boundary. Returns the inline index of the boundary (content before it stays
 * in indices < result).
 */
export function ensureBoundary(
  paragraph: Paragraph,
  position: TextPosition,
): number {
  const index = clamp(position.inlineIndex, 0, paragraph.inlines.length);
  const inline = paragraph.inlines[index];
  if (!inline) return paragraph.inlines.length;
  if (inline.type !== "text") {
    return position.offset > 0 ? index + 1 : index;
  }
  let offset = clamp(position.offset, 0, inline.text.length);
  // Never split a surrogate pair across two runs: a lone half cannot be
  // represented in XML and would be replaced with U+FFFD by the DOCX exporter.
  if (
    offset > 0 &&
    offset < inline.text.length &&
    isHighSurrogate(inline.text.charCodeAt(offset - 1)) &&
    isLowSurrogate(inline.text.charCodeAt(offset))
  ) {
    offset -= 1;
  }
  if (offset <= 0) return index;
  if (offset >= inline.text.length) return index + 1;
  const left = {
    ...inline,
    text: inline.text.slice(0, offset),
    props: { ...inline.props },
  };
  const right = {
    ...inline,
    text: inline.text.slice(offset),
    props: { ...inline.props },
  };
  paragraph.inlines.splice(index, 1, left, right);
  return index + 1;
}

/** Direct run formatting inherited by text typed at a position. */
export function inheritedRunProps(
  paragraph: Paragraph,
  position: TextPosition,
): RunProps {
  const before = paragraph.inlines[position.inlineIndex - 1];
  const after = paragraph.inlines[position.inlineIndex];
  if (before && before.type === "text") return { ...before.props };
  if (after && after.type === "text") return { ...after.props };
  return {};
}

function makeTextRuns(
  text: string,
  props: RunProps,
  doc: DocDocument,
): Inline[] {
  if (text.length === 0) return [];
  const revision = trackMark(doc, "insert");
  return [
    {
      type: "text",
      text,
      props: revision ? { ...props, revision } : { ...props },
    },
  ];
}

/* ------------------------------------------------------- text insertion */

export interface InsertTextOptions {
  /** Explicit character formatting for the inserted text. */
  props?: RunProps;
  /** Insert as tracked change regardless of the document setting. */
  tracked?: boolean;
}

export interface InsertTextResult {
  blockIds: string[];
  start: TextPosition;
  end: TextPosition;
}

/**
 * Inserts text at a position. Newlines create additional paragraphs that
 * inherit the source paragraph's style and direct formatting.
 */
export function insertText(
  doc: DocDocument,
  position: TextPosition,
  text: string,
  options: InsertTextOptions = {},
): InsertTextResult {
  const located = findParagraph(doc, position.blockId);
  if (!located) throw new Error(`Unknown block: ${position.blockId}`);
  const paragraph = located.paragraph;

  const base = options.props
    ? mergeRunProps(inheritedRunProps(paragraph, position), options.props)
    : inheritedRunProps(paragraph, position);

  const segments = text.replace(/\r\n/g, "\n").split("\n");
  const boundary = ensureBoundary(paragraph, position);
  const first = segments[0] ?? "";

  const createdBlocks: string[] = [paragraph.id];
  const firstRuns = makeTextRuns(first, base, doc);
  paragraph.inlines.splice(boundary, 0, ...firstRuns);

  let tailEnd: TextPosition = {
    blockId: paragraph.id,
    inlineIndex: boundary + firstRuns.length,
    offset: first.length,
  };

  if (segments.length > 1) {
    // Build the tail fragment (content after the caret) and split it into new paragraphs.
    const tailIndex = boundary + firstRuns.length;
    const tail = paragraph.inlines.splice(tailIndex);
    let previous = paragraph;
    for (let index = 1; index < segments.length; index += 1) {
      const isLast = index === segments.length - 1;
      const segment = segments[index] ?? "";
      const runs = makeTextRuns(segment, base, doc);
      const created: Paragraph = {
        type: "paragraph",
        id: newId(doc, "p"),
        style: paragraph.style,
        props: structuredClone(paragraph.props),
        inlines: isLast ? [...runs, ...tail] : runs,
        revision: paragraph.revision,
      };
      insertParagraphAfter(doc, previous, created);
      createdBlocks.push(created.id);
      if (isLast) {
        tailEnd = {
          blockId: created.id,
          inlineIndex: runs.length,
          offset: segment.length,
        };
      }
      previous = created;
    }
  }

  doc.metadata.modified = new Date().toISOString();
  return { blockIds: createdBlocks, start: { ...position }, end: tailEnd };
}

/** Inserts a freshly created paragraph after an existing one. */
export function insertParagraphAfter(
  doc: DocDocument,
  reference: Paragraph,
  created: Paragraph,
): void {
  const located = findParagraph(doc, reference.id);
  if (!located) throw new Error(`Unknown block: ${reference.id}`);
  located.container.splice(located.blockIndex + 1, 0, created);
}

/** Creates and inserts a paragraph after a block id. */
export function insertParagraph(
  doc: DocDocument,
  afterBlockId: string,
  text = "",
  options: { style?: string; props?: ParagraphProps; runProps?: RunProps } = {},
): Paragraph {
  const located = findBlock(doc, afterBlockId);
  if (!located) throw new Error(`Unknown block: ${afterBlockId}`);
  const reference =
    located.block.type === "paragraph" ? located.block : undefined;
  const created: Paragraph = {
    type: "paragraph",
    id: newId(doc, "p"),
    style: options.style ?? reference?.style ?? "Normal",
    props: options.props ? structuredClone(options.props) : {},
    inlines: text
      ? [{ type: "text", text, props: { ...(options.runProps ?? {}) } }]
      : [],
  };
  located.container.splice(located.blockIndex + 1, 0, created);
  return created;
}

/** Appends a paragraph at the end of the document (last section). */
export function appendParagraph(
  doc: DocDocument,
  text = "",
  options: { style?: string; props?: ParagraphProps; runProps?: RunProps } = {},
): Paragraph {
  const section = doc.sections[doc.sections.length - 1];
  const created: Paragraph = {
    type: "paragraph",
    id: newId(doc, "p"),
    style: options.style ?? "Normal",
    props: options.props ? structuredClone(options.props) : {},
    inlines: text
      ? [{ type: "text", text, props: { ...(options.runProps ?? {}) } }]
      : [],
  };
  section.blocks.push(created);
  return created;
}

/* ------------------------------------------------------- text deletion */

export interface DeleteRangeResult {
  deletedText: string;
  removedBlockIds: string[];
}

/** Deletes a range across one or more paragraphs. */
export function deleteRange(
  doc: DocDocument,
  range: { start: TextPosition; end: TextPosition },
): DeleteRangeResult {
  const startLoc = findParagraph(doc, range.start.blockId);
  const endLoc = findParagraph(doc, range.end.blockId);
  if (!startLoc || !endLoc)
    throw new Error("Delete range must reference existing paragraphs");
  if (comparePositionInDoc(doc, range.start, range.end) > 0) {
    return deleteRange(doc, { start: range.end, end: range.start });
  }

  const startPara = startLoc.paragraph;
  const endPara = endLoc.paragraph;
  const startOffset = offsetInParagraph(startPara, range.start);
  const endOffset = offsetInParagraph(endPara, range.end);
  const tracked = doc.settings.trackRevisions;
  const removedBlockIds: string[] = [];
  let deletedText = "";

  if (startPara.id === endPara.id) {
    const from = Math.min(startOffset, endOffset);
    const to = Math.max(startOffset, endOffset);
    deletedText = paragraphText(startPara).slice(from, to);
    const startBoundary = ensureBoundary(
      startPara,
      positionAtOffset(startPara, from),
    );
    const endBoundary = ensureBoundary(
      startPara,
      positionAtOffset(startPara, to),
    );
    const removed = startPara.inlines.splice(
      startBoundary,
      Math.max(0, endBoundary - startBoundary),
    );
    if (tracked) {
      const marked = removed.map((inline) => markInlineDeleted(doc, inline));
      startPara.inlines.splice(startBoundary, 0, ...marked);
    } else {
      dropNoteRefs(doc, removed);
    }
    doc.metadata.modified = new Date().toISOString();
    return { deletedText, removedBlockIds };
  }

  deletedText = paragraphText(startPara).slice(startOffset);
  const startBoundary = ensureBoundary(startPara, range.start);
  const removedStart = startPara.inlines.splice(startBoundary);

  if (tracked) {
    const marked = removedStart.map((inline) => markInlineDeleted(doc, inline));
    startPara.inlines.splice(startBoundary, 0, ...marked);
    const revision = revisionStamp(doc, "delete", "paragraph mark deleted", [
      startPara.id,
    ]);
    startPara.revision = {
      id: revision.id,
      kind: "delete",
      author: revision.author,
      date: revision.date,
    };
    const endBoundary = ensureBoundary(endPara, range.end);
    deletedText += paragraphText({
      ...endPara,
      inlines: endPara.inlines.slice(0, endBoundary),
    });
    const removedEnd = endPara.inlines.splice(0, endBoundary);
    const markedEnd = removedEnd.map((inline) =>
      markInlineDeleted(doc, inline),
    );
    endPara.inlines.splice(0, 0, ...markedEnd);
    doc.metadata.modified = new Date().toISOString();
    return { deletedText, removedBlockIds };
  }

  dropNoteRefs(doc, removedStart);

  const order = listBlocks(doc).map((entry) => entry.block.id);
  const startOrder = order.indexOf(startPara.id);
  const endOrder = order.indexOf(endPara.id);
  if (startOrder < 0 || endOrder < 0)
    throw new Error("Delete range blocks disappeared during mutation");

  for (let index = endOrder - 1; index > startOrder; index -= 1) {
    const blockId = order[index];
    const located = findBlock(doc, blockId);
    if (!located) continue;
    if (located.block.type === "paragraph")
      deletedText += `\n${paragraphText(located.block)}`;
    else if (located.block.type === "toc") deletedText += "\n";
    detachBlock(doc, blockId);
    removedBlockIds.push(blockId);
  }

  const endBoundary = ensureBoundary(endPara, range.end);
  const removedEnd = endPara.inlines.splice(0, endBoundary);
  dropNoteRefs(doc, removedEnd);
  startPara.inlines.push(...endPara.inlines);
  detachBlock(doc, endPara.id);
  removedBlockIds.push(endPara.id);

  doc.metadata.modified = new Date().toISOString();
  return { deletedText, removedBlockIds };
}

export function offsetInParagraph(
  paragraph: Paragraph,
  position: TextPosition,
): number {
  let offset = 0;
  const limit = clamp(position.inlineIndex, 0, paragraph.inlines.length);
  for (let index = 0; index < limit; index += 1)
    offset += inlineLength(paragraph.inlines[index]);
  return offset + Math.max(0, position.offset);
}

function positionAtOffset(paragraph: Paragraph, offset: number): TextPosition {
  let remaining = Math.max(0, offset);
  for (let index = 0; index < paragraph.inlines.length; index += 1) {
    const inline = paragraph.inlines[index];
    const length = inlineLength(inline);
    if (remaining <= length) {
      if (inline.type === "text") {
        return {
          blockId: paragraph.id,
          inlineIndex: index,
          offset: Math.min(remaining, inline.text.length),
        };
      }
      return { blockId: paragraph.id, inlineIndex: index, offset: 0 };
    }
    remaining -= length;
  }
  return {
    blockId: paragraph.id,
    inlineIndex: paragraph.inlines.length,
    offset: 0,
  };
}

function comparePositionInDoc(
  doc: DocDocument,
  a: TextPosition,
  b: TextPosition,
): number {
  if (a.blockId === b.blockId) {
    return a.inlineIndex === b.inlineIndex
      ? a.offset - b.offset
      : a.inlineIndex - b.inlineIndex;
  }
  const order = listBlocks(doc).map((entry) => entry.block.id);
  const ai = order.indexOf(a.blockId);
  const bi = order.indexOf(b.blockId);
  if (ai >= 0 && bi >= 0) return ai - bi;
  return a.blockId < b.blockId ? -1 : 1;
}

function markInlineDeleted(doc: DocDocument, inline: Inline): Inline {
  if (inline.type === "text") {
    const revision = trackMark(doc, "delete");
    return { ...inline, props: { ...inline.props, revision } };
  }
  if (inline.type === "image" || inline.type === "shape") {
    return inline;
  }
  return inline;
}

function dropNoteRefs(doc: DocDocument, inlines: Inline[]): void {
  const removed = new Set<string>();
  for (const inline of inlines) {
    if (inline.type === "noteRef") removed.add(inline.noteId);
  }
  if (removed.size === 0) return;
  doc.footnotes = doc.footnotes.filter((note) => !removed.has(note.id));
  doc.endnotes = doc.endnotes.filter((note) => !removed.has(note.id));
}

/* ------------------------------------------------------- formatting */

export interface FormatRangeOptions {
  /** Character formatting patch. `null` clears a property. */
  props: RunProps;
}

/** Applies character formatting to a range, splitting runs at the boundaries. */
export function formatRange(
  doc: DocDocument,
  range: { start: TextPosition; end: TextPosition },
  patch: RunProps,
): { blockIds: string[] } {
  const startLoc = findParagraph(doc, range.start.blockId);
  const endLoc = findParagraph(doc, range.end.blockId);
  if (!startLoc || !endLoc)
    throw new Error("Format range must reference existing paragraphs");

  const order = listBlocks(doc).map((entry) => entry.block.id);
  const startIndex = order.indexOf(startLoc.paragraph.id);
  const endIndex = order.indexOf(endLoc.paragraph.id);
  const affected: string[] = [];

  const startOffset = offsetInParagraph(startLoc.paragraph, range.start);
  const endOffset = offsetInParagraph(endLoc.paragraph, range.end);

  for (
    let index = Math.min(startIndex, endIndex);
    index <= Math.max(startIndex, endIndex);
    index += 1
  ) {
    const blockId = order[index];
    const located = findParagraph(doc, blockId);
    if (!located) continue;
    const paragraph = located.paragraph;
    const from = paragraph.id === startLoc.paragraph.id ? startOffset : 0;
    const to =
      paragraph.id === endLoc.paragraph.id ? endOffset : textCount(paragraph);
    applyInlinePatch(doc, paragraph, from, to, patch);
    affected.push(paragraph.id);
  }

  doc.metadata.modified = new Date().toISOString();
  return { blockIds: affected };
}

function applyInlinePatch(
  doc: DocDocument,
  paragraph: Paragraph,
  from: number,
  to: number,
  patch: RunProps,
): void {
  const total = textCount(paragraph);
  const start = clamp(from, 0, total);
  const end = clamp(to, 0, total);
  if (start === end) {
    // Collapsed selection still updates the paragraph's typing state by
    // recording the patch on the paragraph mark (matches Word's behaviour of
    // formatting the caret position), which is visible via inheritedRunProps.
    return;
  }
  const startBoundary = ensureBoundary(
    paragraph,
    positionAtOffset(paragraph, start),
  );
  const endBoundary = ensureBoundary(
    paragraph,
    positionAtOffset(paragraph, end),
  );
  for (let index = startBoundary; index < endBoundary; index += 1) {
    const inline = paragraph.inlines[index];
    if (!inline) continue;
    if (
      inline.type === "text" ||
      inline.type === "image" ||
      inline.type === "shape"
    ) {
      const previous = inline.props ?? {};
      const next = mergeRunProps(previous, patch);
      const revision = doc.settings.trackRevisions
        ? trackMark(doc, "format", previous)
        : undefined;
      paragraph.inlines[index] = {
        ...inline,
        props: revision ? { ...next, revision } : next,
      } as Inline;
    }
  }
}

/** Clears direct character formatting (including hyperlink marks) over a range. */
export function clearFormatting(
  doc: DocDocument,
  range: { start: TextPosition; end: TextPosition },
): void {
  const reset: RunProps = {
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    doubleStrike: false,
    color: undefined,
    highlight: undefined,
    background: undefined,
    vertAlign: "baseline",
    charSpacing: undefined,
    caps: false,
    smallCaps: false,
    hyperlink: undefined,
  };
  formatRange(doc, range, reset);
}

/** Applies paragraph formatting to specific paragraphs. */
export function formatParagraphs(
  doc: DocDocument,
  blockIds: string[],
  patch: ParagraphProps,
): { blockIds: string[] } {
  for (const blockId of blockIds) {
    const located = findParagraph(doc, blockId);
    if (!located) continue;
    located.paragraph.props = mergeParagraphPropsLocal(
      located.paragraph.props,
      patch,
    );
  }
  doc.metadata.modified = new Date().toISOString();
  return { blockIds: blockIds.filter((id) => Boolean(findParagraph(doc, id))) };
}

function mergeParagraphPropsLocal(
  base: ParagraphProps,
  patch: ParagraphProps,
): ParagraphProps {
  const result: ParagraphProps = { ...base };
  for (const [key, value] of Object.entries(patch) as Array<
    [keyof ParagraphProps, unknown]
  >) {
    if (value === undefined) continue;
    if (
      (key === "indent" ||
        key === "borders" ||
        key === "shading" ||
        key === "numbering") &&
      value &&
      typeof value === "object"
    ) {
      (result as Record<string, unknown>)[key] = {
        ...((base as Record<string, unknown>)[key] as object | undefined),
        ...(value as object),
      };
      continue;
    }
    (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

/** Applies a paragraph style, optionally clearing direct paragraph formatting. */
export function applyStyle(
  doc: DocDocument,
  blockIds: string[],
  styleId: string,
  options: { clearDirectFormatting?: boolean } = {},
): { blockIds: string[]; styleId: string } {
  if (!doc.styles.styles[styleId]) throw new Error(`Unknown style: ${styleId}`);
  const applied: string[] = [];
  for (const blockId of blockIds) {
    const located = findParagraph(doc, blockId);
    if (!located) continue;
    located.paragraph.style = styleId;
    if (options.clearDirectFormatting) located.paragraph.props = {};
    applied.push(blockId);
  }
  doc.metadata.modified = new Date().toISOString();
  return { blockIds: applied, styleId };
}

/* -------------------------------------------------------------- lists */

export interface ApplyListOptions {
  kind: "bullet" | "number";
  level?: number;
  /** Restart numbering at this value (also used to continue from a value). */
  startAt?: number;
  /** Bullet glyph override for custom bullets. */
  bulletGlyph?: string;
  numId?: string;
}

/** Turns paragraphs into list items, creating a numbering definition when needed. */
export function applyList(
  doc: DocDocument,
  blockIds: string[],
  options: ApplyListOptions,
): { numId: string } {
  const numId = options.numId ?? createListDefinition(doc, options);
  for (const blockId of blockIds) {
    const located = findParagraph(doc, blockId);
    if (!located) continue;
    located.paragraph.props = mergeParagraphPropsLocal(
      located.paragraph.props,
      {
        numbering: {
          numId,
          level: options.level ?? 0,
          startOverride: options.startAt,
        },
      },
    );
  }
  doc.metadata.modified = new Date().toISOString();
  return { numId };
}

/** Creates a numbering definition for a bullet or numbered list. */
export function createListDefinition(
  doc: DocDocument,
  options: {
    kind: "bullet" | "number";
    level?: number;
    startAt?: number;
    bulletGlyph?: string;
  },
): string {
  const abstractId = newId(doc, "abs");
  const levels: import("./types.js").ListLevel[] = [];
  for (let level = 0; level < 9; level += 1) {
    const left = 36 + level * 36;
    if (options.kind === "bullet") {
      const glyph =
        options.bulletGlyph ?? ["\u{F0B7}", "o", "\u{F0A7}"][level % 3];
      levels.push({
        level,
        start: 1,
        numFmt: "bullet",
        lvlText: glyph,
        lvlJc: "left",
        suff: "tab",
        paragraph: { indent: { left, hanging: 18 } },
        run: { fontFamily: "Symbol" },
      });
    } else {
      const lvlText = `${Array.from({ length: level + 1 }, (_value, index) => `%${index + 1}`).join(".")}.`;
      levels.push({
        level,
        start: 1,
        numFmt: "decimal",
        lvlText,
        lvlJc: "left",
        suff: "tab",
        paragraph: { indent: { left, hanging: 18 } },
      });
    }
  }
  doc.numbering.abstract[abstractId] = {
    id: abstractId,
    multiLevelType: "hybridMultilevel",
    levels,
  };
  const numId = newId(doc, "num");
  doc.numbering.nums[numId] = { id: numId, abstractId };
  return numId;
}

/** Restarts or continues numbering for the given paragraphs. */
export function setListNumbering(
  doc: DocDocument,
  blockIds: string[],
  value: number | "continue",
): void {
  if (value === "continue") {
    for (const blockId of blockIds) {
      const located = findParagraph(doc, blockId);
      if (!located) continue;
      const numbering = resolveParagraphProps(doc, located.paragraph).numbering;
      if (!numbering) continue;
      located.paragraph.props.numbering = {
        ...numbering,
        startOverride: undefined,
      };
    }
  } else {
    for (let index = 0; index < blockIds.length; index += 1) {
      const located = findParagraph(doc, blockIds[index]);
      if (!located) continue;
      const numbering = resolveParagraphProps(doc, located.paragraph).numbering;
      if (!numbering) continue;
      located.paragraph.props.numbering = {
        ...numbering,
        startOverride: index === 0 ? value : undefined,
      };
    }
  }
  doc.metadata.modified = new Date().toISOString();
}

/** Converts list items back to plain paragraphs. */
export function removeList(doc: DocDocument, blockIds: string[]): void {
  for (const blockId of blockIds) {
    const located = findParagraph(doc, blockId);
    if (!located) continue;
    if (located.paragraph.props.numbering)
      delete located.paragraph.props.numbering;
    const style = located.paragraph.style;
    if (style === "ListBullet" || style === "ListNumber")
      located.paragraph.style = "Normal";
  }
  doc.metadata.modified = new Date().toISOString();
}

/* --------------------------------------------------------- hyperlinks */

/** Applies (or removes) a hyperlink over a range. */
export function applyHyperlink(
  doc: DocDocument,
  range: { start: TextPosition; end: TextPosition },
  target: { href?: string; anchor?: string; tooltip?: string },
): void {
  if (!target.href && !target.anchor) {
    formatRange(doc, range, { hyperlink: undefined });
    return;
  }
  formatRange(doc, range, {
    hyperlink: {
      href: target.href,
      anchor: target.anchor,
      tooltip: target.tooltip,
      external: Boolean(target.href),
    },
    color: "#0563c1",
    underline: "single",
  });
}

/* ------------------------------------------------------------- breaks */

/** Inserts a page break at a position (OOXML `w:br w:type="page"`). */
export function insertPageBreak(
  doc: DocDocument,
  position: TextPosition,
): void {
  const located = findParagraph(doc, position.blockId);
  if (!located) throw new Error(`Unknown block: ${position.blockId}`);
  const boundary = ensureBoundary(located.paragraph, position);
  located.paragraph.inlines.splice(boundary, 0, {
    type: "break",
    kind: "page",
  });
  doc.metadata.modified = new Date().toISOString();
}

/** Inserts a line break at a position. */
export function insertLineBreak(
  doc: DocDocument,
  position: TextPosition,
): void {
  const located = findParagraph(doc, position.blockId);
  if (!located) throw new Error(`Unknown block: ${position.blockId}`);
  const boundary = ensureBoundary(located.paragraph, position);
  located.paragraph.inlines.splice(boundary, 0, {
    type: "break",
    kind: "line",
  });
  doc.metadata.modified = new Date().toISOString();
}

/** Inserts a column break (only meaningful inside a multi-column section). */
export function insertColumnBreak(
  doc: DocDocument,
  position: TextPosition,
): void {
  const located = findParagraph(doc, position.blockId);
  if (!located) throw new Error(`Unknown block: ${position.blockId}`);
  const boundary = ensureBoundary(located.paragraph, position);
  located.paragraph.inlines.splice(boundary, 0, {
    type: "break",
    kind: "column",
  });
  doc.metadata.modified = new Date().toISOString();
}

/* --------------------------------------------------------------- images */

export interface AddImageOptions {
  data: Buffer | Uint8Array;
  contentType: string;
  fileName?: string;
  width: number;
  height: number;
  alt?: string;
  title?: string;
  naturalWidthPx?: number;
  naturalHeightPx?: number;
  anchor?: ImageInline["anchor"];
  border?: ImageInline["border"];
}

/** Registers an image in the document media table and returns its id. */
export function addMedia(
  doc: DocDocument,
  options: {
    data: Buffer | Uint8Array;
    contentType: string;
    fileName?: string;
    widthPx?: number;
    heightPx?: number;
    dpi?: number;
  },
): string {
  const mediaId = newId(doc, "img");
  const buffer = Buffer.isBuffer(options.data)
    ? options.data
    : Buffer.from(options.data);
  doc.media.push({
    id: mediaId,
    fileName:
      options.fileName ?? `${mediaId}.${extensionFor(options.contentType)}`,
    contentType: options.contentType,
    data: buffer.toString("base64"),
    byteLength: buffer.byteLength,
    widthPx: options.widthPx,
    heightPx: options.heightPx,
    dpi: options.dpi ?? 96,
  });
  return mediaId;
}

function extensionFor(contentType: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
    "image/svg+xml": "svg",
    "image/x-emf": "emf",
    "image/x-wmf": "wmf",
    "image/webp": "webp",
  };
  return map[contentType] ?? "bin";
}

/** Inserts an image at a position. */
export function insertImage(
  doc: DocDocument,
  position: TextPosition,
  options: AddImageOptions,
): { mediaId: string; inline: ImageInline } {
  const located = findParagraph(doc, position.blockId);
  if (!located) throw new Error(`Unknown block: ${position.blockId}`);
  const mediaId = addMedia(doc, {
    data: options.data,
    contentType: options.contentType,
    fileName: options.fileName,
    widthPx: options.naturalWidthPx,
    heightPx: options.naturalHeightPx,
  });
  const boundary = ensureBoundary(located.paragraph, position);
  const inline: ImageInline = {
    type: "image",
    mediaId,
    width: options.width,
    height: options.height,
    naturalWidthPx: options.naturalWidthPx,
    naturalHeightPx: options.naturalHeightPx,
    alt: options.alt,
    title: options.title,
    anchor: options.anchor ?? { type: "inline" },
    border: options.border ?? null,
  };
  located.paragraph.inlines.splice(boundary, 0, inline);
  doc.metadata.modified = new Date().toISOString();
  return { mediaId, inline };
}

/** Replaces the media payload behind an existing image, preserving geometry. */
export function replaceImage(
  doc: DocDocument,
  mediaId: string,
  payload: {
    data: Buffer | Uint8Array;
    contentType: string;
    fileName?: string;
  },
): MediaAssetIdResult {
  const asset = doc.media.find((entry) => entry.id === mediaId);
  if (!asset) throw new Error(`Unknown media: ${mediaId}`);
  const buffer = Buffer.isBuffer(payload.data)
    ? payload.data
    : Buffer.from(payload.data);
  asset.data = buffer.toString("base64");
  asset.byteLength = buffer.byteLength;
  asset.contentType = payload.contentType;
  if (payload.fileName) asset.fileName = payload.fileName;
  doc.metadata.modified = new Date().toISOString();
  return { mediaId };
}

export interface MediaAssetIdResult {
  mediaId: string;
}

/** Resizes an image, optionally preserving the aspect ratio. */
export function resizeImage(
  doc: DocDocument,
  mediaId: string,
  size: { width?: number; height?: number; preserveAspectRatio?: boolean },
): { width: number; height: number } {
  let target: ImageInline | undefined;
  forEachInline(doc, (inline) => {
    if (inline.type === "image" && inline.mediaId === mediaId) target = inline;
  });
  if (!target) throw new Error(`No image inline uses media ${mediaId}`);
  const image = target;
  let width = size.width ?? image.width;
  let height = size.height ?? image.height;
  if (size.preserveAspectRatio ?? true) {
    const ratio = image.width / image.height;
    if (size.width !== undefined && size.height === undefined)
      height = width / ratio;
    else if (size.height !== undefined && size.width === undefined)
      width = height * ratio;
    else if (size.width !== undefined && size.height !== undefined) {
      // keep requested box but fit inside preserving ratio
      if (width / height > ratio) width = height * ratio;
      else height = width / ratio;
    }
  }
  image.width = width;
  image.height = height;
  doc.metadata.modified = new Date().toISOString();
  return { width, height };
}

export function forEachInline(
  doc: DocDocument,
  visit: (inline: Inline, paragraph: Paragraph) => void,
): void {
  for (const { paragraph } of listParagraphs(doc)) {
    for (const inline of paragraph.inlines) visit(inline, paragraph);
  }
}

/* -------------------------------------------------------------- footnotes */

/** Inserts a footnote reference and returns the created note id. */
export function insertFootnote(
  doc: DocDocument,
  position: TextPosition,
  text: string,
  options: { type?: "footnote" | "endnote" } = {},
): { noteId: string } {
  const located = findParagraph(doc, position.blockId);
  if (!located) throw new Error(`Unknown block: ${position.blockId}`);
  const type = options.type ?? "footnote";
  const noteId = newId(doc, "fn");
  const note: import("./types.js").Note = {
    id: noteId,
    type,
    blocks: [
      {
        type: "paragraph",
        id: newId(doc, "p"),
        style: "Normal",
        props: {},
        inlines: [{ type: "text", text, props: {} }],
      },
    ],
  };
  if (type === "footnote") doc.footnotes.push(note);
  else doc.endnotes.push(note);
  const boundary = ensureBoundary(located.paragraph, position);
  located.paragraph.inlines.splice(boundary, 0, {
    type: "noteRef",
    noteId,
    noteType: type,
  });
  doc.metadata.modified = new Date().toISOString();
  return { noteId };
}

/* ---------------------------------------------------------------- tables */

export interface InsertTableOptions {
  rows: number;
  columns: number;
  /** Row-major cell text. */
  data?: string[][];
  style?: string;
  width?: { value: number; type: "auto" | "dxa" | "pct" };
  headerRow?: boolean;
}

/** Creates and inserts a table after a block. */
export function insertTable(
  doc: DocDocument,
  afterBlockId: string,
  options: InsertTableOptions,
): Table {
  const located = findBlock(doc, afterBlockId);
  if (!located) throw new Error(`Unknown block: ${afterBlockId}`);
  const rows = Math.max(1, options.rows);
  const columns = Math.max(1, options.columns);
  const containerWidth =
    located.section.page.width -
    located.section.page.margins.left -
    located.section.page.margins.right;
  const columnWidth = containerWidth / columns;

  const table: Table = {
    type: "table",
    id: newId(doc, "tbl"),
    props: {
      style: options.style ?? "TableGrid",
      alignment: "left",
      width: options.width ?? { value: containerWidth, type: "dxa" },
      layout: "fixed",
      borders: {
        top: { style: "single", width: 0.5, color: "#000000" },
        bottom: { style: "single", width: 0.5, color: "#000000" },
        left: { style: "single", width: 0.5, color: "#000000" },
        right: { style: "single", width: 0.5, color: "#000000" },
        between: { style: "single", width: 0.5, color: "#000000" },
      },
    },
    grid: new Array(columns).fill(columnWidth),
    rows: Array.from({ length: rows }, (_rowValue, rowIndex) => ({
      id: newId(doc, "row"),
      props: {
        isHeader: options.headerRow ? rowIndex === 0 : undefined,
        cantSplit: false,
      },
      cells: Array.from({ length: columns }, (_cellValue, columnIndex) => ({
        id: newId(doc, "cell"),
        props: { width: { value: columnWidth, type: "dxa" }, vAlign: "top" },
        blocks: [
          {
            type: "paragraph",
            id: newId(doc, "p"),
            style: "Normal",
            props: {},
            inlines: options.data?.[rowIndex]?.[columnIndex]
              ? [
                  {
                    type: "text",
                    text: options.data[rowIndex][columnIndex],
                    props: {},
                  },
                ]
              : [],
          },
        ],
      })),
    })),
  };

  located.container.splice(located.blockIndex + 1, 0, table);
  doc.metadata.modified = new Date().toISOString();
  return table;
}

/** Appends rows to a table. */
export function addTableRows(
  doc: DocDocument,
  tableId: string,
  count = 1,
  copyFrom?: number,
): string[] {
  const table = requireTable(doc, tableId);
  const ids: string[] = [];
  const template = table.rows[copyFrom ?? table.rows.length - 1];
  const columns = table.grid.length || template?.cells.length || 1;
  for (let index = 0; index < Math.max(1, count); index += 1) {
    const row: import("./types.js").TableRow = {
      id: newId(doc, "row"),
      props: { ...(template?.props ?? {}) },
      cells: Array.from({ length: columns }, (_, columnIndex) => ({
        id: newId(doc, "cell"),
        props: {
          width: { value: table.grid[columnIndex] ?? 100, type: "dxa" },
          vAlign: "top",
        },
        blocks: [
          {
            type: "paragraph",
            id: newId(doc, "p"),
            style: "Normal",
            props: {},
            inlines:
              template?.cells[columnIndex]?.blocks[0]?.type === "paragraph"
                ? []
                : [],
          },
        ],
      })),
    };
    table.rows.push(row);
    ids.push(row.id);
  }
  doc.metadata.modified = new Date().toISOString();
  return ids;
}

/** Inserts a row at a position. */
export function insertTableRow(
  doc: DocDocument,
  tableId: string,
  index: number,
  copyFormatting = true,
): string {
  const table = requireTable(doc, tableId);
  const template = table.rows[Math.min(index, table.rows.length - 1)];
  const row: import("./types.js").TableRow = {
    id: newId(doc, "row"),
    props: copyFormatting ? { ...(template?.props ?? {}) } : {},
    cells: (template?.cells ?? []).map((cell, columnIndex) => ({
      id: newId(doc, "cell"),
      props: copyFormatting
        ? { ...cell.props }
        : { width: { value: table.grid[columnIndex] ?? 100, type: "dxa" } },
      blocks: [
        {
          type: "paragraph",
          id: newId(doc, "p"),
          style:
            cell.blocks[0]?.type === "paragraph"
              ? cell.blocks[0].style
              : "Normal",
          props: {},
          inlines: [],
        },
      ],
    })),
  };
  table.rows.splice(clamp(index, 0, table.rows.length), 0, row);
  doc.metadata.modified = new Date().toISOString();
  return row.id;
}

/** Deletes a row. A table with no rows is reported instead of silently removed. */
export function deleteTableRow(
  doc: DocDocument,
  tableId: string,
  index: number,
): { rowsRemaining: number } {
  const table = requireTable(doc, tableId);
  if (table.rows.length <= 1)
    throw new Error("Cannot delete the last row of a table");
  table.rows.splice(index, 1);
  doc.metadata.modified = new Date().toISOString();
  return { rowsRemaining: table.rows.length };
}

/** Inserts a column, expanding every row. */
export function insertTableColumn(
  doc: DocDocument,
  tableId: string,
  index: number,
): void {
  const table = requireTable(doc, tableId);
  const at = clamp(index, 0, table.grid.length);
  const width = table.grid[at - 1] ?? table.grid[0] ?? 100;
  table.grid.splice(at, 0, width);
  for (const row of table.rows) {
    row.cells.splice(at, 0, {
      id: newId(doc, "cell"),
      props: { width: { value: width, type: "dxa" }, vAlign: "top" },
      blocks: [
        {
          type: "paragraph",
          id: newId(doc, "p"),
          style: "Normal",
          props: {},
          inlines: [],
        },
      ],
    });
  }
  doc.metadata.modified = new Date().toISOString();
}

/** Deletes a column. */
export function deleteTableColumn(
  doc: DocDocument,
  tableId: string,
  index: number,
): { columnsRemaining: number } {
  const table = requireTable(doc, tableId);
  if (table.grid.length <= 1)
    throw new Error("Cannot delete the last column of a table");
  table.grid.splice(index, 1);
  for (const row of table.rows) row.cells.splice(index, 1);
  doc.metadata.modified = new Date().toISOString();
  return { columnsRemaining: table.grid.length };
}

/** Merges a rectangular cell region into a single cell. */
export function mergeCells(
  doc: DocDocument,
  tableId: string,
  region: {
    startRow: number;
    endRow: number;
    startColumn: number;
    endColumn: number;
  },
): { cellId: string } {
  const table = requireTable(doc, tableId);
  const startRow = clamp(region.startRow, 0, table.rows.length - 1);
  const endRow = clamp(region.endRow, startRow, table.rows.length - 1);
  const startColumn = clamp(
    region.startColumn,
    0,
    table.rows[startRow].cells.length - 1,
  );
  const endColumn = clamp(
    region.endColumn,
    startColumn,
    table.rows[startRow].cells.length - 1,
  );

  const anchor = table.rows[startRow].cells[startColumn];
  const span = endColumn - startColumn + 1;
  const contentBlocks: Block[] = [];
  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
    for (
      let columnIndex = startColumn;
      columnIndex <= endColumn;
      columnIndex += 1
    ) {
      const cell = table.rows[rowIndex]?.cells[columnIndex];
      if (!cell) continue;
      if (!(rowIndex === startRow && columnIndex === startColumn)) {
        contentBlocks.push(...cell.blocks);
      }
    }
  }
  anchor.props.gridSpan = span;
  anchor.props.vMerge = endRow > startRow ? "restart" : null;
  anchor.blocks.push(...contentBlocks);

  for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
    const row = table.rows[rowIndex];
    const removeCount = rowIndex === startRow ? span - 1 : span;
    const from = rowIndex === startRow ? startColumn + 1 : startColumn;
    row.cells.splice(from, removeCount);
  }
  for (let rowIndex = startRow + 1; rowIndex <= endRow; rowIndex += 1) {
    const row = table.rows[rowIndex];
    row.cells.splice(startColumn, 0, {
      id: newId(doc, "cell"),
      props: {
        width: anchor.props.width,
        gridSpan: 1,
        vMerge: "continue",
        vAlign: "top",
      },
      blocks: [
        {
          type: "paragraph",
          id: newId(doc, "p"),
          style: "Normal",
          props: {},
          inlines: [],
        },
      ],
    });
  }
  doc.metadata.modified = new Date().toISOString();
  return { cellId: anchor.id };
}

/** Splits a previously merged cell back into individual cells. */
export function splitCell(
  doc: DocDocument,
  cellId: string,
  options: { rows?: number; columns?: number } = {},
): { cellIds: string[] } {
  const located = findCellById(doc, cellId);
  if (!located) throw new Error(`Unknown cell: ${cellId}`);
  const { cell, table, rowIndex, cellIndex } = located;
  const span = cell.props.gridSpan ?? 1;
  const createsRows =
    (options.rows ?? 1) > 1 || cell.props.vMerge === "restart";
  const width =
    (cell.props.width?.value ?? table.grid[cellIndex] ?? 100) / span;

  const created: string[] = [];
  if (createsRows) {
    const merges = countVerticalMerge(table, rowIndex, cellIndex);
    cell.props.vMerge = null;
    for (
      let offset = 1;
      offset < Math.max(options.rows ?? merges, merges);
      offset += 1
    ) {
      const row = table.rows[rowIndex + offset];
      if (!row) break;
      const replacement = row.cells[cellIndex];
      if (replacement) {
        replacement.props.vMerge = null;
        replacement.props.gridSpan = span;
        created.push(replacement.id);
      }
    }
  }
  if (span > 1) {
    cell.props.gridSpan = 1;
    cell.props.width = { value: width, type: "dxa" };
    for (let offset = 1; offset < span; offset += 1) {
      const newCell: import("./types.js").TableCell = {
        id: newId(doc, "cell"),
        props: {
          width: { value: width, type: "dxa" },
          vAlign: cell.props.vAlign,
        },
        blocks: [
          {
            type: "paragraph",
            id: newId(doc, "p"),
            style: "Normal",
            props: {},
            inlines: [],
          },
        ],
      };
      table.rows[rowIndex].cells.splice(cellIndex + offset, 0, newCell);
      created.push(newCell.id);
    }
  }
  doc.metadata.modified = new Date().toISOString();
  return { cellIds: [cell.id, ...created] };
}

function countVerticalMerge(
  table: Table,
  rowIndex: number,
  cellIndex: number,
): number {
  let count = 1;
  for (let index = rowIndex; index < table.rows.length; index += 1) {
    const cell = table.rows[index]?.cells[cellIndex];
    if (cell?.props.vMerge === "continue") count += 1;
    else break;
  }
  return count;
}

export function findCellById(
  doc: DocDocument,
  cellId: string,
):
  | {
      cell: import("./types.js").TableCell;
      table: Table;
      rowIndex: number;
      cellIndex: number;
    }
  | undefined {
  for (const { block } of listBlocks(doc)) {
    if (block.type !== "table") continue;
    for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
      const row = block.rows[rowIndex];
      for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
        if (row.cells[cellIndex].id === cellId) {
          return {
            cell: row.cells[cellIndex],
            table: block,
            rowIndex,
            cellIndex,
          };
        }
      }
    }
  }
  return undefined;
}

function requireTable(doc: DocDocument, tableId: string): Table {
  const located = findBlock(doc, tableId);
  if (!located || located.block.type !== "table")
    throw new Error(`Unknown table: ${tableId}`);
  return located.block;
}

/** Deletes a table entirely. */
export function deleteTable(doc: DocDocument, tableId: string): void {
  const located = findBlock(doc, tableId);
  if (!located || located.block.type !== "table")
    throw new Error(`Unknown table: ${tableId}`);
  located.container.splice(located.blockIndex, 1);
  doc.metadata.modified = new Date().toISOString();
}

/* ------------------------------------------------------------ math */

const GREEK: Record<string, string> = {
  alpha: "\u03B1",
  beta: "\u03B2",
  gamma: "\u03B3",
  delta: "\u03B4",
  epsilon: "\u03B5",
  zeta: "\u03B6",
  eta: "\u03B7",
  theta: "\u03B8",
  iota: "\u03B9",
  kappa: "\u03BA",
  lambda: "\u03BB",
  mu: "\u03BC",
  nu: "\u03BD",
  xi: "\u03BE",
  pi: "\u03C0",
  rho: "\u03C1",
  sigma: "\u03C3",
  tau: "\u03C4",
  upsilon: "\u03C5",
  phi: "\u03C6",
  chi: "\u03C7",
  psi: "\u03C8",
  omega: "\u03C9",
  Gamma: "\u0393",
  Delta: "\u0394",
  Theta: "\u0398",
  Lambda: "\u039B",
  Xi: "\u039E",
  Pi: "\u03A0",
  Sigma: "\u03A3",
  Phi: "\u03A6",
  Psi: "\u03A8",
  Omega: "\u03A9",
};

const SYMBOLS: Record<string, string> = {
  times: "\u00D7",
  div: "\u00F7",
  pm: "\u00B1",
  leq: "\u2264",
  geq: "\u2265",
  neq: "\u2260",
  approx: "\u2248",
  infty: "\u221E",
  sum: "\u2211",
  prod: "\u220F",
  int: "\u222B",
  partial: "\u2202",
  nabla: "\u2207",
  sqrt: "\u221A",
  cdot: "\u00B7",
  cdots: "\u22EF",
  ldots: "\u2026",
  rightarrow: "\u2192",
  leftarrow: "\u2190",
  Rightarrow: "\u21D2",
  leftrightarrow: "\u2194",
  forall: "\u2200",
  exists: "\u2203",
  in: "\u2208",
  notin: "\u2209",
  subset: "\u2282",
  supset: "\u2283",
  cup: "\u222A",
  cap: "\u2229",
  angle: "\u2220",
  degree: "\u00B0",
  prime: "\u2032",
};

interface TexToken {
  type: "text" | "group";
  value: string;
  children?: TexToken[];
}

/** Minimal TeX-subset parser used by `insertEquation` and OMML fallbacks. */
export function parseMathLinear(input: string): MathNode[] {
  const tokens = tokenizeMath(input);
  return buildMathNodes(tokens);
}

function tokenizeMath(input: string): TexToken[] {
  const out: TexToken[] = [];
  let index = 0;
  const readGroup = (): TexToken[] => {
    // index points at '{'
    index += 1;
    const children: TexToken[] = [];
    let buffer = "";
    while (index < input.length && input[index] !== "}") {
      const char = input[index];
      if (char === "\\") {
        const match = /^\\([A-Za-z]+)/.exec(input.slice(index));
        if (match) {
          if (buffer) {
            children.push({ type: "text", value: buffer });
            buffer = "";
          }
          const name = match[1];
          index += match[0].length;
          if (GREEK[name]) children.push({ type: "text", value: GREEK[name] });
          else if (SYMBOLS[name])
            children.push({ type: "text", value: SYMBOLS[name] });
          else if (name === "frac" || name === "sqrt" || name === "text") {
            children.push({ type: "text", value: "" });
            children.push({ type: "group", value: name, children: [] });
          } else children.push({ type: "text", value: name });
          continue;
        }
      }
      if (char === "{") {
        if (buffer) {
          children.push({ type: "text", value: buffer });
          buffer = "";
        }
        children.push({ type: "group", value: "group", children: readGroup() });
        continue;
      }
      buffer += char;
      index += 1;
    }
    if (buffer) children.push({ type: "text", value: buffer });
    index += 1; // consume '}'
    return children;
  };

  let buffer = "";
  while (index < input.length) {
    const char = input[index];
    if (char === "\\") {
      const match = /^\\([A-Za-z]+)/.exec(input.slice(index));
      if (match) {
        if (buffer) {
          out.push({ type: "text", value: buffer });
          buffer = "";
        }
        const name = match[1];
        index += match[0].length;
        if (GREEK[name]) out.push({ type: "text", value: GREEK[name] });
        else if (SYMBOLS[name])
          out.push({ type: "text", value: SYMBOLS[name] });
        else out.push({ type: "text", value: name });
        continue;
      }
    }
    if (char === "{") {
      if (buffer) {
        out.push({ type: "text", value: buffer });
        buffer = "";
      }
      out.push({ type: "group", value: "group", children: readGroup() });
      continue;
    }
    buffer += char;
    index += 1;
  }
  if (buffer) out.push({ type: "text", value: buffer });
  return out;
}

function buildMathNodes(tokens: TexToken[]): MathNode[] {
  const nodes: MathNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) {
      nodes.push({ kind: "run", text: buffer });
      buffer = "";
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "group" && token.value === "group") {
      flush();
      nodes.push(...buildMathNodes(token.children ?? []));
      continue;
    }
    const text = token.value;
    if (text === "\\frac" || text === "frac") {
      const numerator = tokens[index + 1];
      const denominator = tokens[index + 2];
      if (numerator?.type === "group" && denominator?.type === "group") {
        flush();
        nodes.push({
          kind: "fraction",
          numerator: buildMathNodes(numerator.children ?? []),
          denominator: buildMathNodes(denominator.children ?? []),
        });
        index += 2;
        continue;
      }
    }
    if (text === "\\sqrt" || text === "sqrt") {
      const radicand = tokens[index + 1];
      if (radicand?.type === "group") {
        flush();
        nodes.push({
          kind: "radical",
          degree: [],
          radicand: buildMathNodes(radicand.children ?? []),
        });
        index += 1;
        continue;
      }
    }
    // superscript / subscript markers are handled by the tokenizer as literal text
    buffer += text;
  }
  flush();
  return nodes;
}

/** Inserts an equation (structured nodes or a TeX-like linear string). */
export function insertEquation(
  doc: DocDocument,
  position: TextPosition,
  input: { linear?: string; nodes?: MathNode[]; display?: boolean },
): { linear: string } {
  const located = findParagraph(doc, position.blockId);
  if (!located) throw new Error(`Unknown block: ${position.blockId}`);
  const linear = input.linear ?? mathToLinear(input.nodes ?? []);
  const nodes = input.nodes ?? parseMathLinear(linear);
  const boundary = ensureBoundary(located.paragraph, position);
  const inline: MathRun = {
    type: "math",
    math: nodes,
    linear,
    display: input.display,
  };
  located.paragraph.inlines.splice(boundary, 0, inline);
  doc.metadata.modified = new Date().toISOString();
  return { linear };
}

export function mathToLinear(nodes: MathNode[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "run":
          return node.text;
        case "fraction":
          return `(${mathToLinear(node.numerator)})/(${mathToLinear(node.denominator)})`;
        case "superscript":
          return `${mathToLinear(node.base)}^(${mathToLinear(node.superscript)})`;
        case "subscript":
          return `${mathToLinear(node.base)}_(${mathToLinear(node.subscript)})`;
        case "subsup":
          return `${mathToLinear(node.base)}_(${mathToLinear(node.sub)})^(${mathToLinear(node.sup)})`;
        case "radical":
          return node.degree.length > 0
            ? `root(${mathToLinear(node.degree)})(${mathToLinear(node.radicand)})`
            : `\u221A(${mathToLinear(node.radicand)})`;
        case "delimited":
          return `${node.begin ?? "("}${node.children.map((child) => mathToLinear([child])).join(node.separator ?? ",")}${node.end ?? ")"}`;
        case "function":
          return `${node.name}(${mathToLinear(node.argument)})`;
        case "nary":
          return `${node.operator}${node.sub ? `_(${mathToLinear(node.sub)})` : ""}${node.sup ? `^(${mathToLinear(node.sup)})` : ""}(${mathToLinear(node.body)})`;
        case "bar":
          return `${mathToLinear(node.body)}\u0305`;
        case "accent":
          return `${mathToLinear(node.body)}${node.char}`;
        case "matrix":
          return node.rows
            .map((row) => row.map((cell) => `[${mathToLinear(cell)}]`).join(""))
            .join("; ");
        case "group":
          return node.children.map((child) => mathToLinear([child])).join("");
        case "space":
          return " ";
        case "unknown":
          return node.linear;
        default:
          return "";
      }
    })
    .join("");
}

/* ------------------------------------------------------------------ TOC */

export interface InsertTocOptions {
  minLevel?: number;
  maxLevel?: number;
  hyperlinks?: boolean;
  pageNumbers?: boolean;
  tabLeader?: TocBlock["tabLeader"];
  includeTitle?: boolean;
  caption?: string;
}

/** Inserts a generated table of contents after a block. */
export function insertToc(
  doc: DocDocument,
  afterBlockId: string,
  options: InsertTocOptions = {},
): { tocId: string; blockIds: string[] } {
  const located = findBlock(doc, afterBlockId);
  if (!located) throw new Error(`Unknown block: ${afterBlockId}`);
  const minLevel = options.minLevel ?? 1;
  const maxLevel = options.maxLevel ?? 3;
  const blockIds: string[] = [];
  let insertIndex = located.blockIndex + 1;
  if (options.caption) {
    const caption: Paragraph = {
      type: "paragraph",
      id: newId(doc, "p"),
      style: "Normal",
      props: { alignment: "left" },
      inlines: [{ type: "text", text: options.caption, props: { bold: true } }],
    };
    located.container.splice(insertIndex, 0, caption);
    blockIds.push(caption.id);
    insertIndex += 1;
  }
  const toc: TocBlock = {
    type: "toc",
    id: newId(doc, "toc"),
    minLevel,
    maxLevel,
    hyperlinks: options.hyperlinks ?? true,
    pageNumbers: options.pageNumbers ?? true,
    tabLeader: options.tabLeader ?? "dot",
    includeTitle: options.includeTitle,
    instruction: `TOC \\o "${minLevel}-${maxLevel}" \\h \\z \\u`,
  };
  located.container.splice(insertIndex, 0, toc);
  blockIds.push(toc.id);
  // A trailing paragraph keeps the caret editable after the generated block.
  if (insertIndex + 1 >= located.container.length) {
    const after: Paragraph = {
      type: "paragraph",
      id: newId(doc, "p"),
      style: "Normal",
      props: {},
      inlines: [],
    };
    located.container.splice(insertIndex + 1, 0, after);
    blockIds.push(after.id);
  }
  doc.metadata.modified = new Date().toISOString();
  return { tocId: toc.id, blockIds };
}

/* ------------------------------------------------------------ bookmarks */

/** Adds a bookmark around a paragraph (start/end marks). */
export function addBookmark(
  doc: DocDocument,
  paragraphId: string,
  name: string,
): { bookmarkId: string } {
  const located = findParagraph(doc, paragraphId);
  if (!located) throw new Error(`Unknown block: ${paragraphId}`);
  const bookmarkId = newId(doc, "bm");
  located.paragraph.inlines.unshift({
    type: "bookmark",
    name,
    bookmarkId,
    kind: "start",
  });
  located.paragraph.inlines.push({
    type: "bookmark",
    name,
    bookmarkId,
    kind: "end",
  });
  doc.bookmarks.push({ name, id: bookmarkId, paragraphId });
  doc.metadata.modified = new Date().toISOString();
  return { bookmarkId };
}

/* -------------------------------------------------------- section helpers */

/** Creates a section break at a position, moving the tail into a new section. */
export function insertSectionBreak(
  doc: DocDocument,
  at: { sectionIndex: number; blockIndex: number },
  options: {
    type?: Section["breakBefore"];
    page?: Partial<Section["page"]>;
    columns?: Section["columns"];
  } = {},
): { sectionIndex: number } {
  const section = doc.sections[at.sectionIndex];
  if (!section) throw new Error(`Unknown section: ${at.sectionIndex}`);
  const tail = section.blocks.splice(at.blockIndex);
  if (tail.length === 0) {
    // Ensure the previous section keeps at least one paragraph.
    tail.push({
      type: "paragraph",
      id: newId(doc, "p"),
      style: "Normal",
      props: {},
      inlines: [],
    });
  }
  const created: Section = {
    id: newId(doc, "s"),
    blocks: tail,
    breakBefore: options.type ?? "nextPage",
    titlePage: section.titlePage,
    evenAndOdd: section.evenAndOdd,
    columns: options.columns
      ? structuredClone(options.columns)
      : structuredClone(section.columns),
    page: {
      ...structuredClone(section.page),
      ...(options.page ?? {}),
      margins: { ...section.page.margins, ...(options.page?.margins ?? {}) },
    },
    headers: structuredClone(section.headers),
    footers: structuredClone(section.footers),
    pageNumbering: structuredClone(section.pageNumbering),
  };
  doc.sections.splice(at.sectionIndex + 1, 0, created);
  // Re-key cloned header/footer ids so they remain unique.
  rekeyHeaderFooters(doc, created);
  doc.metadata.modified = new Date().toISOString();
  return { sectionIndex: at.sectionIndex + 1 };
}

/** Assigns fresh ids to every block/table/row/cell inside a cloned block list. */
function rekeyBlocks(doc: DocDocument, blocks: Block[]): void {
  for (const block of blocks) {
    block.id = newId(
      doc,
      block.type === "table" ? "tbl" : block.type === "toc" ? "toc" : "p",
    );
    if (block.type === "table") {
      for (const row of block.rows) {
        row.id = newId(doc, "row");
        for (const cell of row.cells) {
          cell.id = newId(doc, "cell");
          rekeyBlocks(doc, cell.blocks);
        }
      }
    }
  }
}

function rekeyHeaderFooters(doc: DocDocument, section: Section): void {
  for (const set of [section.headers, section.footers]) {
    for (const variant of ["default", "first", "even"] as const) {
      const part = set[variant];
      if (!part) continue;
      part.id = newId(doc, "hf");
      // Cloned header/footer parts must not share block ids with the section
      // they were copied from; otherwise ids are duplicated across sections.
      rekeyBlocks(doc, part.blocks);
    }
  }
}

/** True when every structural id in the document is unique. */
export function hasUniqueStructuralIds(doc: DocDocument): boolean {
  const seen = new Set<string>();
  let unique = true;
  const walk = (blocks: Block[]): void => {
    for (const block of blocks) {
      if (seen.has(block.id)) unique = false;
      seen.add(block.id);
      if (block.type === "table") {
        for (const row of block.rows) {
          if (seen.has(row.id)) unique = false;
          seen.add(row.id);
          for (const cell of row.cells) {
            if (seen.has(cell.id)) unique = false;
            seen.add(cell.id);
            walk(cell.blocks);
          }
        }
      }
    }
  };
  for (const section of doc.sections) {
    if (seen.has(section.id)) unique = false;
    seen.add(section.id);
    walk(section.blocks);
    for (const set of [section.headers, section.footers]) {
      for (const variant of ["default", "first", "even"] as const) {
        const part = set[variant];
        if (!part) continue;
        if (seen.has(part.id)) unique = false;
        seen.add(part.id);
        walk(part.blocks);
      }
    }
  }
  return unique;
}

/** Sets a header/footer variant to plain text or structured blocks. */
export function setHeaderFooter(
  doc: DocDocument,
  sectionIndex: number,
  target: {
    part: "header" | "footer";
    variant: "default" | "first" | "even";
    text?: string;
    blocks?: Block[];
  },
): { partId: string } {
  const section = doc.sections[sectionIndex];
  if (!section) throw new Error(`Unknown section: ${sectionIndex}`);
  const set = target.part === "header" ? section.headers : section.footers;
  const blocks: Block[] =
    target.blocks ??
    (target.text !== undefined
      ? [
          {
            type: "paragraph",
            id: newId(doc, "p"),
            style: target.part === "header" ? "Header" : "Footer",
            props: {},
            inlines: target.text
              ? [{ type: "text", text: target.text, props: {} }]
              : [],
          },
        ]
      : []);
  const existing = set[target.variant];
  const id = existing?.id ?? newId(doc, "hf");
  set[target.variant] = { id, blocks };
  if (target.variant === "even") section.evenAndOdd = true;
  if (target.variant === "first") section.titlePage = true;
  doc.metadata.modified = new Date().toISOString();
  return { partId: id };
}

/** Updates page geometry for a section. */
export function setPageSetup(
  doc: DocDocument,
  sectionIndex: number,
  patch: Partial<Section["page"]>,
): void {
  const section = doc.sections[sectionIndex];
  if (!section) throw new Error(`Unknown section: ${sectionIndex}`);
  section.page = {
    ...section.page,
    ...patch,
    margins: { ...section.page.margins, ...(patch.margins ?? {}) },
  };
  if (patch.orientation) {
    const isLandscape = patch.orientation === "landscape";
    const width = isLandscape
      ? Math.max(section.page.width, section.page.height)
      : Math.min(section.page.width, section.page.height);
    const height = isLandscape
      ? Math.min(section.page.width, section.page.height)
      : Math.max(section.page.width, section.page.height);
    section.page.width = width;
    section.page.height = height;
  }
  doc.metadata.modified = new Date().toISOString();
}

export function setColumns(
  doc: DocDocument,
  sectionIndex: number,
  columns: Section["columns"],
): void {
  const section = doc.sections[sectionIndex];
  if (!section) throw new Error(`Unknown section: ${sectionIndex}`);
  section.columns = { ...columns };
  doc.metadata.modified = new Date().toISOString();
}

/* ------------------------------------------------------------- metadata */

/** Updates document metadata (only provided fields are changed). */
export function setMetadata(
  doc: DocDocument,
  patch: Partial<DocDocument["metadata"]>,
): void {
  doc.metadata = {
    ...doc.metadata,
    ...patch,
    custom: { ...doc.metadata.custom, ...(patch.custom ?? {}) },
  };
  doc.metadata.modified = new Date().toISOString();
}

/** Records an unsupported construct without discarding it. */
export function recordUnknown(
  doc: DocDocument,
  part: { location: string; element: string; xml: string; reason: string },
): void {
  doc.unknown.push({ id: newId(doc, "unk"), ...part });
}

/** Convenience accessor used by the service layer. */
export function paragraphById(
  doc: DocDocument,
  id: string,
): Paragraph | undefined {
  return findParagraph(doc, id)?.paragraph;
}

export { computeNumbering };
