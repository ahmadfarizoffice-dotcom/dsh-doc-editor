import { listParagraphs, walkBlocks } from "./access.js";
import { resolveParagraphProps, resolveRunProps } from "./styles.js";
import type {
  Block,
  DocDocument,
  DocumentStats,
  Inline,
  Paragraph,
  Section,
  Table,
} from "./types.js";

/** How tracked revisions are projected into plain text. */
export type TextMode = "final" | "original" | "all";

export interface TextOptions {
  mode?: TextMode;
  /** Include table cell content (default true). */
  includeTables?: boolean;
  /** Include text box / shape content (default true). */
  includeShapes?: boolean;
  /** Paragraph separator (default "\n"). */
  paragraphSeparator?: string;
  /** Table cell separator (default "\t"). */
  cellSeparator?: string;
}

function visibleRun(
  props: import("./types.js").RunProps,
  mode: TextMode,
): boolean {
  if (mode === "final" && props.revision?.kind === "delete") return false;
  if (mode === "original" && props.revision?.kind === "insert") return false;
  return true;
}

/** Plain-text projection of one inline node. */
export function inlineText(inline: Inline, mode: TextMode = "final"): string {
  switch (inline.type) {
    case "text":
      return visibleRun(inline.props, mode) ? inline.text : "";
    case "tab":
      return "\t";
    case "break":
      return inline.kind === "page" ? "\f" : "\n";
    case "image":
      return "\uFFFC";
    case "field": {
      if (!inline.result) return "";
      return inline.result.map((child) => inlineText(child, mode)).join("");
    }
    case "noteRef":
      return "";
    case "commentRef":
    case "bookmark":
      return "";
    case "math":
      return inline.linear;
    case "shape":
      return "";
    case "unknown":
      return inline.text ?? "";
    default:
      return "";
  }
}

/** Plain-text projection of one paragraph (no trailing separator). */
export function paragraphText(
  paragraph: Paragraph,
  mode: TextMode = "final",
): string {
  const body = paragraph.inlines
    .map((inline) => inlineText(inline, mode))
    .join("");
  if (mode === "original" && paragraph.revision?.kind === "insert") return "";
  return body;
}

export function tableText(table: Table, options: TextOptions = {}): string {
  const mode = options.mode ?? "final";
  const cellSeparator = options.cellSeparator ?? "\t";
  return table.rows
    .map((row) =>
      row.cells
        .map((cell) =>
          cell.blocks.map((block) => blockText(block, options)).join("\n"),
        )
        .join(cellSeparator),
    )
    .join("\n");
}

export function blockText(block: Block, options: TextOptions = {}): string {
  const mode = options.mode ?? "final";
  if (block.type === "paragraph") return paragraphText(block, mode);
  if (block.type === "toc") return "";
  if (options.includeTables === false) return "";
  return tableText(block, options);
}

/** Plain text for an arbitrary block array. */
export function blocksText(blocks: Block[], options: TextOptions = {}): string {
  const separator = options.paragraphSeparator ?? "\n";
  return blocks.map((block) => blockText(block, options)).join(separator);
}

export interface SectionText {
  sectionIndex: number;
  text: string;
}

export function documentTextSections(
  doc: DocDocument,
  options: TextOptions = {},
): SectionText[] {
  const separator = options.paragraphSeparator ?? "\n";
  return doc.sections.map((section, sectionIndex) => ({
    sectionIndex,
    text: section.blocks
      .map((block) => blockText(block, options))
      .join(separator),
  }));
}

/** Whole-document plain text. */
export function documentText(
  doc: DocDocument,
  options: TextOptions = {},
): string {
  const parts = documentTextSections(doc, options).map((entry) => entry.text);
  if (options.includeShapes !== false) {
    for (const shape of doc.shapes) {
      if (shape.kind === "textbox")
        parts.push(blocksText(shape.blocks, options));
    }
  }
  for (const note of [...doc.footnotes, ...doc.endnotes]) {
    parts.push(blocksText(note.blocks, options));
  }
  return parts.join(options.paragraphSeparator ?? "\n");
}

const WORD_PATTERN = /[\p{L}\p{N}\p{M}]+(?:['\u2019-][\p{L}\p{N}\p{M}]+)*/gu;

/** Counts words using Unicode letter/number runs (apostrophes and hyphens kept inside words). */
export function countWords(text: string): number {
  if (!text) return 0;
  const matches = text.match(WORD_PATTERN);
  return matches ? matches.length : 0;
}

export interface ParagraphTextInfo {
  paragraphId: string;
  sectionIndex: number;
  text: string;
}

/** All paragraph texts in document order (for search, stats and layout). */
export function paragraphTexts(
  doc: DocDocument,
  mode: TextMode = "final",
): ParagraphTextInfo[] {
  return listParagraphs(doc).map(({ paragraph, sectionIndex }) => ({
    paragraphId: paragraph.id,
    sectionIndex,
    text: paragraphText(paragraph, mode),
  }));
}

/** Word / character / paragraph counts. Page count is supplied by the layout engine. */
export function documentStats(
  doc: DocDocument,
  mode: TextMode = "final",
  pages?: number,
): DocumentStats {
  const paragraphs = listParagraphs(doc).filter(({ paragraph }) => {
    if (mode === "original") return paragraph.revision?.kind !== "insert";
    return true;
  });
  let words = 0;
  let characters = 0;
  let charactersWithSpaces = 0;
  const paragraphSeparator = "\n";

  for (const { paragraph } of paragraphs) {
    const text = paragraphText(paragraph, mode);
    words += countWords(text);
    for (const char of text) {
      if (char === "\uFFFC") continue;
      charactersWithSpaces += 1;
      if (!/\s/.test(char)) characters += 1;
    }
    charactersWithSpaces += paragraphSeparator.length;
  }

  let tables = 0;
  let images = 0;
  walkBlocks(doc, ({ block }) => {
    if (block.type === "table") tables += 1;
    if (block.type === "paragraph") {
      for (const inline of block.inlines) {
        if (inline.type === "image") images += 1;
      }
    }
  });

  return {
    words,
    characters,
    charactersWithSpaces,
    paragraphs: paragraphs.length,
    tables,
    images,
    pages,
  };
}

/** Header / footer text for a section (all variants), used by page info and search. */
export function headerFooterText(
  section: Section,
  mode: TextMode = "final",
): string[] {
  const out: string[] = [];
  for (const set of [section.headers, section.footers]) {
    for (const variant of ["default", "first", "even"] as const) {
      const part = set[variant];
      if (part) out.push(blocksText(part.blocks, { mode }));
    }
  }
  return out;
}

/** Convenience: effective run formatting for a run inside a paragraph. */
export function runPropsFor(
  doc: DocDocument,
  paragraph: Paragraph,
  inline: Inline,
) {
  const direct =
    (inline as { props?: import("./types.js").RunProps }).props ?? {};
  return resolveRunProps(doc, {
    paragraphStyle: paragraph.style,
    characterStyle: direct.characterStyle,
    direct,
  });
}

/** Convenience: effective paragraph formatting. */
export function paragraphPropsFor(doc: DocDocument, paragraph: Paragraph) {
  return resolveParagraphProps(doc, paragraph);
}
