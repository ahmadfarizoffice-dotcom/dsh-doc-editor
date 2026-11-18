import { describe, expect, it } from "vitest";
import { createDocument } from "@dsh-doc/core/model";
import { paginateBlocks } from "../src/pages/pagination";

function entry(
  heightPt: number,
  sectionIndex = 0,
  forceBreakBefore = false,
  index = 0,
) {
  const document = createDocument({ paragraphs: [`block ${index}`] });
  const block = document.sections[0].blocks[0];
  return { block, sectionIndex, heightPt, forceBreakBefore };
}

describe("preview page packing", () => {
  it("packs blocks until the content height is reached", () => {
    const entries = [
      entry(200, 0, false, 1),
      entry(200, 0, false, 2),
      entry(200, 0, false, 3),
    ];
    const pages = paginateBlocks(entries, () => 500);
    expect(pages).toHaveLength(2);
    expect(pages[0].blocks).toHaveLength(2);
    expect(pages[0].usedPt).toBe(400);
    expect(pages[1].blocks).toHaveLength(1);
  });

  it("never splits a block: an oversized block gets its own page", () => {
    const entries = [
      entry(100, 0, false, 1),
      entry(900, 0, false, 2),
      entry(100, 0, false, 3),
    ];
    const pages = paginateBlocks(entries, () => 500);
    expect(pages.map((page) => page.blocks.length)).toEqual([1, 1, 1]);
    expect(pages[1].usedPt).toBe(900);
  });

  it("starts a new page for forced breaks and section changes", () => {
    const entries = [
      entry(100, 0, false, 1),
      entry(100, 0, true, 2),
      entry(100, 1, false, 3),
      entry(100, 1, false, 4),
    ];
    const pages = paginateBlocks(entries, (sectionIndex) =>
      sectionIndex === 0 ? 500 : 500,
    );
    expect(pages).toHaveLength(3);
    expect(pages[1].blocks).toHaveLength(1);
    expect(pages[2].sectionIndex).toBe(1);
    expect(pages[2].blocks).toHaveLength(2);
  });

  it("produces one empty page for an empty document", () => {
    const pages = paginateBlocks([], () => 500);
    expect(pages).toHaveLength(1);
    expect(pages[0].blocks).toHaveLength(0);
  });
});
