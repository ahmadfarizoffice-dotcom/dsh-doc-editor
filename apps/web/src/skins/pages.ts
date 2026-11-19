/**
 * Client-side page estimate used by the status bars ("Page 1 of 3").
 *
 * The editor renders one continuous sheet, so there is no measured page
 * boundary to read. This module estimates block heights from the document model
 * and the section page geometry. It is deliberately labelled as an estimate in
 * the UI: the server layout renderer (GET /api/render) remains authoritative.
 * The document model is never modified.
 */
import { documentOutline, resolveParagraphProps } from "@dsh-doc/core/model";
import type {
  Block,
  DocDocument,
  Paragraph,
  Section,
  TextPosition,
} from "@dsh-doc/core/model";

export interface PageEstimate {
  pageCount: number;
  /** 1-based page that currently contains the caret. */
  currentPage: number;
  sectionIndex: number;
}

interface EstimateOptions {
  /** Caret position used for `currentPage`; omit for a plain page count. */
  position?: TextPosition | null;
}

function inlineTextLength(paragraph: Paragraph): number {
  let length = 0;
  for (const inline of paragraph.inlines) {
    if (inline.type === "text") length += inline.text.length;
    else if (
      inline.type === "image" ||
      inline.type === "tab" ||
      inline.type === "break"
    )
      length += 1;
  }
  return length;
}

function largestImageHeight(paragraph: Paragraph): number {
  let height = 0;
  for (const inline of paragraph.inlines) {
    if (inline.type === "image" && inline.anchor?.type !== "floating")
      height = Math.max(height, inline.height);
  }
  return height;
}

/** Crude style scale so headings do not pack like body text. */
function baseFontSize(paragraph: Paragraph, document: DocDocument): number {
  const style = paragraph.style ?? "";
  if (/title/i.test(style)) return 26;
  if (/heading1/i.test(style)) return 20;
  if (/heading2/i.test(style)) return 16;
  if (/heading3/i.test(style)) return 14;
  const defaults = document.styles.defaults.run?.fontSize;
  return typeof defaults === "number" && defaults > 0 ? defaults : 11;
}

export function pageContentHeightPt(section: Section | undefined): number {
  const page = section?.page;
  if (!page) return 697.9;
  return Math.max(72, page.height - page.margins.top - page.margins.bottom);
}

export function pageContentWidthPt(section: Section | undefined): number {
  const page = section?.page;
  if (!page) return 451.3;
  return Math.max(72, page.width - page.margins.left - page.margins.right);
}

function paragraphHeight(
  paragraph: Paragraph,
  document: DocDocument,
  section: Section,
): number {
  const props = resolveParagraphProps(document, paragraph);
  const fontSize = baseFontSize(paragraph, document);
  const text = inlineTextLength(paragraph);
  const width = pageContentWidthPt(section);
  const charsPerLine = Math.max(12, Math.floor(width / (fontSize * 0.52)));
  const lines = Math.max(1, Math.ceil(text / charsPerLine));
  const spacing = props.lineSpacing;
  const lineHeight =
    spacing?.rule === "exact" || spacing?.rule === "atLeast"
      ? Math.max(fontSize, spacing.value)
      : fontSize * 1.2 * Math.max(0.8, (spacing?.value ?? 276) / 240);
  const spaceBefore = props.spaceBefore ?? 0;
  const spaceAfter = props.spaceAfter ?? 0;
  return (
    lines * lineHeight +
    spaceBefore +
    spaceAfter +
    Math.max(0, largestImageHeight(paragraph) - lineHeight)
  );
}

function blockContains(block: Block, blockId: string): boolean {
  if (block.id === blockId) return true;
  if (block.type === "table") {
    return block.rows.some((row) =>
      row.cells.some((cell) =>
        cell.blocks.some((child) => blockContains(child, blockId)),
      ),
    );
  }
  return false;
}

interface BlockEstimate {
  heightPt: number;
  /** The caret block is a paragraph inside this block (table cell included). */
  containsFocus: boolean;
  /** An explicit page break ends the page after this block. */
  forcedBreakAfter: boolean;
}

function estimateTable(
  table: Extract<Block, { type: "table" }>,
  document: DocDocument,
  section: Section,
  focusBlockId: string | null,
): BlockEstimate {
  let heightPt = 0;
  let containsFocus = false;
  for (const row of table.rows) {
    let rowHeight = 18;
    for (const cell of row.cells) {
      let cellHeight = 4;
      for (const child of cell.blocks) {
        if (blockContains(child, focusBlockId ?? "")) containsFocus = true;
        cellHeight += estimateBlock(
          child,
          document,
          section,
          focusBlockId,
        ).heightPt;
      }
      rowHeight = Math.max(rowHeight, cellHeight);
    }
    heightPt += rowHeight;
  }
  return { heightPt: heightPt + 2, containsFocus, forcedBreakAfter: false };
}

function estimateBlock(
  block: Block,
  document: DocDocument,
  section: Section,
  focusBlockId: string | null,
): BlockEstimate {
  if (block.type === "paragraph") {
    return {
      heightPt: paragraphHeight(block, document, section),
      containsFocus: block.id === focusBlockId,
      forcedBreakAfter: block.inlines.some(
        (inline) => inline.type === "break" && inline.kind === "page",
      ),
    };
  }
  if (block.type === "table")
    return estimateTable(block, document, section, focusBlockId);
  // Generated table of contents: caption plus one line per entry.
  const entries = documentOutline(document).filter(
    (entry) => entry.level >= block.minLevel && entry.level <= block.maxLevel,
  ).length;
  return {
    heightPt: 42 + entries * 18,
    containsFocus: block.id === focusBlockId,
    forcedBreakAfter: false,
  };
}

export function estimatePages(
  document: DocDocument,
  options: EstimateOptions = {},
): PageEstimate {
  const focusBlockId = options.position?.blockId ?? null;
  let page = 1;
  let used = 0;
  let currentPage = -1;
  let currentSection = 0;
  let found = false;

  document.sections.forEach((section, sectionIndex) => {
    if (sectionIndex > 0 && section.breakBefore !== "continuous") {
      page += 1;
      used = 0;
    }
    const contentHeight = pageContentHeightPt(section);
    for (const block of section.blocks) {
      const estimate = estimateBlock(block, document, section, focusBlockId);
      if (used > 0 && used + estimate.heightPt > contentHeight) {
        page += 1;
        used = 0;
      }
      if (!found && estimate.containsFocus) {
        currentPage = page;
        currentSection = sectionIndex;
        found = true;
      }
      used += estimate.heightPt;
      while (used > contentHeight * 2) {
        page += 1;
        used -= contentHeight;
        if (!found) {
          currentPage = page;
          currentSection = sectionIndex;
          found = true;
        }
      }
      if (estimate.forcedBreakAfter) {
        page += 1;
        used = 0;
      }
    }
  });

  return {
    pageCount: Math.max(1, page),
    currentPage: currentPage > 0 ? currentPage : 1,
    sectionIndex: currentSection,
  };
}
