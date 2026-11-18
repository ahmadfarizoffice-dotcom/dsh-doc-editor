/**
 * Page packing for the client-side print preview approximation.
 *
 * Pure function: given the measured height of each block, distribute blocks
 * over pages. A block is never split across pages, which is exactly the
 * approximation the preview banner describes.
 */
import type { Block } from "@dsh-doc/core/model";

export interface PreviewPage {
  blocks: Block[];
  sectionIndex: number;
  /** Height of the blocks on this page, in points. */
  usedPt: number;
}

export interface PaginateEntry {
  block: Block;
  sectionIndex: number;
  heightPt: number;
  /** Section break that starts a new page. */
  forceBreakBefore: boolean;
}

export function paginateBlocks(
  entries: PaginateEntry[],
  contentHeightForSection: (sectionIndex: number) => number,
): PreviewPage[] {
  const pages: PreviewPage[] = [];
  let currentPage: PreviewPage | null = null;

  for (const entry of entries) {
    const limit = Math.max(1, contentHeightForSection(entry.sectionIndex));
    const needsNewPage =
      currentPage === null ||
      currentPage.sectionIndex !== entry.sectionIndex ||
      entry.forceBreakBefore ||
      (currentPage.usedPt > 0 && currentPage.usedPt + entry.heightPt > limit);

    if (needsNewPage) {
      currentPage = { blocks: [], sectionIndex: entry.sectionIndex, usedPt: 0 };
      pages.push(currentPage);
    }
    if (!currentPage) continue;
    currentPage.blocks.push(entry.block);
    currentPage.usedPt += Math.max(0, entry.heightPt);
  }

  if (pages.length === 0)
    pages.push({ blocks: [], sectionIndex: 0, usedPt: 0 });
  return pages;
}
