import { listParagraphs } from "./access.js";
import { computeNumbering } from "./numbering.js";
import { headingLevelOfStyle, resolveParagraphProps } from "./styles.js";
import { paragraphText } from "./text.js";
import type {
  DocDocument,
  OutlineEntry,
  Paragraph,
  SearchMatch,
  TextPosition,
} from "./types.js";

export interface OutlineOptions {
  /** Include headings inside tables (default false, matching Word). */
  includeTables?: boolean;
  /** Include the Title style at level 0 (default true). */
  includeTitle?: boolean;
  /** Maximum heading level to include (default 9). */
  maxLevel?: number;
}

/** Heading level for a paragraph: explicit outline level, else its style. */
export function paragraphHeadingLevel(
  doc: DocDocument,
  paragraph: Paragraph,
): number | undefined {
  const props = resolveParagraphProps(doc, paragraph);
  if (
    props.outlineLevel !== undefined &&
    props.outlineLevel >= 0 &&
    props.outlineLevel < 9
  ) {
    return props.outlineLevel + 1;
  }
  return headingLevelOfStyle(doc, paragraph.style);
}

/** Builds the document outline (navigation pane / TOC source). */
export function documentOutline(
  doc: DocDocument,
  options: OutlineOptions = {},
): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  const maxLevel = options.maxLevel ?? 9;
  // Text-box content is not part of the body flow, so Word-style outlines and
  // TOCs exclude it even though the blocks exist in the model.
  const shapeParagraphs = new Set<string>();
  for (const shape of doc.shapes) {
    if (shape.kind !== "textbox") continue;
    for (const block of shape.blocks) {
      if (block.type === "paragraph") shapeParagraphs.add(block.id);
    }
  }
  for (const { paragraph, sectionIndex, cell } of listParagraphs(doc)) {
    if (cell && options.includeTables !== true) continue;
    if (shapeParagraphs.has(paragraph.id)) continue;
    const level = paragraphHeadingLevel(doc, paragraph);
    if (level === undefined) continue;
    if (level === 0 && options.includeTitle === false) continue;
    if (level > maxLevel) continue;
    const text = paragraphText(paragraph).trim();
    if (!text) continue;
    entries.push({
      id: `outline-${paragraph.id}`,
      blockId: paragraph.id,
      level,
      text,
      style: paragraph.style,
      sectionIndex,
    });
  }
  return entries;
}

/** Flat paragraph index of a text position, used for search result addressing. */
export function positionToTextIndex(
  doc: DocDocument,
  position: TextPosition,
): number {
  let offset = 0;
  for (const { paragraph } of listParagraphs(doc)) {
    const text = paragraphText(paragraph);
    if (paragraph.id === position.blockId) {
      let local = 0;
      for (
        let index = 0;
        index < Math.min(position.inlineIndex, paragraph.inlines.length);
        index += 1
      ) {
        local += inlineTextLength(paragraph, index);
      }
      return offset + local + position.offset;
    }
    offset += text.length + 1;
  }
  return -1;
}

function inlineTextLength(paragraph: Paragraph, index: number): number {
  const inline = paragraph.inlines[index];
  if (!inline) return 0;
  switch (inline.type) {
    case "text":
      return inline.text.length;
    case "tab":
      return 1;
    case "break":
      return 1;
    case "image":
      return 1;
    case "field":
      return inline.result
        ? inline.result
            .map((child) => (child.type === "text" ? child.text.length : 1))
            .join("").length
        : 0;
    case "math":
      return inline.linear.length;
    case "unknown":
      return (inline.text ?? "").length;
    default:
      return 0;
  }
}

export interface SearchOptions {
  caseSensitive?: boolean;
  /** Treat the query as a regular expression. */
  regex?: boolean;
  wholeWord?: boolean;
  /** Restrict to a block id list. */
  blockIds?: string[];
  /** Maximum matches (default 1000). */
  limit?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Literal or regular-expression search across paragraph text. */
export function searchDocument(
  doc: DocDocument,
  query: string,
  options: SearchOptions = {},
): SearchMatch[] {
  const limit = options.limit ?? 1000;
  const matches: SearchMatch[] = [];
  if (!query) return matches;

  const source = options.regex ? query : escapeRegExp(query);
  const body = options.wholeWord
    ? `(?<![\\p{L}\\p{N}])${source}(?![\\p{L}\\p{N}])`
    : source;
  let pattern: RegExp;
  try {
    pattern = new RegExp(body, options.caseSensitive ? "gu" : "giu");
  } catch {
    return matches;
  }

  const blockFilter = options.blockIds ? new Set(options.blockIds) : undefined;
  const paragraphs = listParagraphs(doc);

  for (const { paragraph, sectionIndex, blockIndex } of paragraphs) {
    if (blockFilter && !blockFilter.has(paragraph.id)) continue;
    const text = paragraphText(paragraph);
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      const position = textOffsetToPosition(paragraph, start);
      matches.push({
        blockId: paragraph.id,
        sectionIndex,
        blockIndex,
        start,
        end,
        text: match[0],
        contextBefore: text.slice(Math.max(0, start - 40), start),
        contextAfter: text.slice(end, Math.min(text.length, end + 40)),
      });
      void position;
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

/** Converts a plain-text offset inside a paragraph into an inline position. */
export function textOffsetToPosition(
  paragraph: Paragraph,
  offset: number,
): TextPosition {
  let remaining = Math.max(0, offset);
  for (let index = 0; index < paragraph.inlines.length; index += 1) {
    const inline = paragraph.inlines[index];
    const length = inlineTextLength(paragraph, index);
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
  const lastIndex = Math.max(0, paragraph.inlines.length - 1);
  const last = paragraph.inlines[lastIndex];
  return {
    blockId: paragraph.id,
    inlineIndex: lastIndex,
    offset: last && last.type === "text" ? last.text.length : 0,
  };
}

/** Plain text offset of a position inside its paragraph. */
export function positionToOffset(
  paragraph: Paragraph,
  position: TextPosition,
): number {
  let offset = 0;
  for (
    let index = 0;
    index < position.inlineIndex && index < paragraph.inlines.length;
    index += 1
  ) {
    offset += inlineTextLength(paragraph, index);
  }
  return offset + Math.max(0, position.offset);
}

/** List labels for the navigation pane / list inspector. */
export function listOutline(doc: DocDocument) {
  const numbering = computeNumbering(doc);
  return [...numbering.labels.values()];
}
