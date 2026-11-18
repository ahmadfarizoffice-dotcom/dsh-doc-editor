import type {
  Block,
  DocDocument,
  DocRange,
  Paragraph,
  Section,
  Table,
  TableCell,
  TextPosition,
} from "./types.js";

export interface BlockLocation {
  block: Block;
  section: Section;
  sectionIndex: number;
  /** Index inside the containing block array (paragraphs/tables of the section or cell). */
  blockIndex: number;
  /** Container that owns the block array. */
  container: Block[];
  /** Set when the block lives inside a table cell. */
  cell?: TableCell;
}

export interface ParagraphLocation extends BlockLocation {
  paragraph: Paragraph;
}

/** Visits every block, descending into table cells and shape text boxes. */
export function walkBlocks(
  doc: DocDocument,
  visit: (location: BlockLocation) => void,
): void {
  doc.sections.forEach((section, sectionIndex) => {
    visitBlockArray(section.blocks, section, sectionIndex, visit);
  });
  for (const shape of doc.shapes) {
    if (shape.kind === "textbox") {
      shape.blocks.forEach((block, blockIndex) => {
        visit({
          block,
          section: doc.sections[0],
          sectionIndex: 0,
          blockIndex,
          container: shape.blocks,
        });
      });
    }
  }
}

function visitBlockArray(
  blocks: Block[],
  section: Section,
  sectionIndex: number,
  visit: (location: BlockLocation) => void,
): void {
  blocks.forEach((block, blockIndex) => {
    visit({ block, section, sectionIndex, blockIndex, container: blocks });
    if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          visitBlockArray(cell.blocks, section, sectionIndex, (inner) => {
            visit({ ...inner, cell });
          });
        }
      }
    }
  });
}

/** Returns every block in document order (including nested cell content). */
export function listBlocks(doc: DocDocument): BlockLocation[] {
  const out: BlockLocation[] = [];
  walkBlocks(doc, (location) => out.push(location));
  return out;
}

export function listParagraphs(doc: DocDocument): ParagraphLocation[] {
  const out: ParagraphLocation[] = [];
  walkBlocks(doc, (location) => {
    if (location.block.type === "paragraph") {
      out.push({ ...location, paragraph: location.block });
    }
  });
  return out;
}

export function findBlock(
  doc: DocDocument,
  blockId: string,
): BlockLocation | undefined {
  let found: BlockLocation | undefined;
  walkBlocks(doc, (location) => {
    if (!found && location.block.id === blockId) found = location;
  });
  return found;
}

export function findParagraph(
  doc: DocDocument,
  blockId: string,
): ParagraphLocation | undefined {
  const location = findBlock(doc, blockId);
  if (!location || location.block.type !== "paragraph") return undefined;
  return { ...location, paragraph: location.block };
}

export function findTable(
  doc: DocDocument,
  tableId: string,
): { table: Table; location: BlockLocation } | undefined {
  const location = findBlock(doc, tableId);
  if (!location || location.block.type !== "table") return undefined;
  return { table: location.block, location };
}

export function findCell(
  doc: DocDocument,
  cellId: string,
):
  | { cell: TableCell; table: Table; rowIndex: number; cellIndex: number }
  | undefined {
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.type !== "table") continue;
      for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
        const row = block.rows[rowIndex];
        for (let cellIndex = 0; cellIndex < row.cells.length; cellIndex += 1) {
          const cell = row.cells[cellIndex];
          if (cell.id === cellId)
            return { cell, table: block, rowIndex, cellIndex };
        }
        // nested tables
        for (const cell of row.cells) {
          for (const inner of cell.blocks) {
            if (inner.type === "table") {
              for (const innerRow of inner.rows) {
                for (const innerCell of innerRow.cells) {
                  if (innerCell.id === cellId) {
                    return {
                      cell: innerCell,
                      table: inner,
                      rowIndex: 0,
                      cellIndex: 0,
                    };
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return undefined;
}

export function findSection(
  doc: DocDocument,
  sectionIndex: number,
): Section | undefined {
  return doc.sections[sectionIndex];
}

export function getBlockArray(
  doc: DocDocument,
  blockId: string,
): Block[] | undefined {
  return findBlock(doc, blockId)?.container;
}

/** Index of a position inside its paragraph's inline list, or -1 when the block is not found. */
export function findPositionContainer(
  doc: DocDocument,
  position: TextPosition,
): ParagraphLocation | undefined {
  return findParagraph(doc, position.blockId);
}

export function sectionIndexOf(doc: DocDocument, blockId: string): number {
  return findBlock(doc, blockId)?.sectionIndex ?? 0;
}

/** Total number of blocks in the document (including nested). */
export function countBlocks(doc: DocDocument): number {
  return listBlocks(doc).length;
}

/** Removes a block from its container; returns the removed block. */
export function detachBlock(
  doc: DocDocument,
  blockId: string,
): Block | undefined {
  const location = findBlock(doc, blockId);
  if (!location) return undefined;
  const index = location.container.indexOf(location.block);
  if (index < 0) return undefined;
  location.container.splice(index, 1);
  return location.block;
}

/** Document order index of a block. */
export function blockOrderIndex(doc: DocDocument, blockId: string): number {
  const blocks = listBlocks(doc);
  return blocks.findIndex((entry) => entry.block.id === blockId);
}

/** Compares two positions in document order. */
export function comparePositions(
  doc: DocDocument,
  a: TextPosition,
  b: TextPosition,
): number {
  if (a.blockId === b.blockId) {
    if (a.inlineIndex !== b.inlineIndex) return a.inlineIndex - b.inlineIndex;
    return a.offset - b.offset;
  }
  const ai = blockOrderIndex(doc, a.blockId);
  const bi = blockOrderIndex(doc, b.blockId);
  if (ai >= 0 && bi >= 0 && ai !== bi) return ai - bi;
  return a.blockId < b.blockId ? -1 : 1;
}

export function sortRange(doc: DocDocument, range: DocRange): DocRange {
  return comparePositions(doc, range.start, range.end) <= 0
    ? range
    : { start: range.end, end: range.start };
}

export function rangeIsCollapsed(doc: DocDocument, range: DocRange): boolean {
  return comparePositions(doc, range.start, range.end) === 0;
}

/** All block ids covered by a range (inclusive), in document order. */
export function blocksInRange(doc: DocDocument, range: DocRange): string[] {
  const ordered = sortRange(doc, range);
  const blocks = listBlocks(doc);
  const startIndex = blocks.findIndex(
    (b) => b.block.id === ordered.start.blockId,
  );
  const endIndex = blocks.findIndex((b) => b.block.id === ordered.end.blockId);
  if (startIndex < 0 || endIndex < 0) return [];
  return blocks
    .slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1)
    .map((b) => b.block.id);
}
