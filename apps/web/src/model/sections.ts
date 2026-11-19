/**
 * Section helpers shared by the page-setup dialog and the status bars.
 *
 * Blocks can live inside table cells and text boxes, so looking up a block id
 * must recurse. The helpers never mutate the document.
 */
import type { Block, DocDocument, TextPosition } from "@dsh-doc/core/model";

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

export function sectionIndexForBlock(
  document: DocDocument,
  blockId: string,
): number | null {
  for (let index = 0; index < document.sections.length; index += 1) {
    const section = document.sections[index];
    if (section?.blocks.some((block) => blockContains(block, blockId)))
      return index;
  }
  return null;
}

/** Section that owns the caret; falls back to the first section. */
export function sectionIndexForPosition(
  document: DocDocument,
  position: TextPosition | null | undefined,
): number {
  if (position) {
    const found = sectionIndexForBlock(document, position.blockId);
    if (found !== null) return found;
  }
  return 0;
}
