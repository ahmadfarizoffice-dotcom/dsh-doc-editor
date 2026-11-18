import { describe, expect, it } from "vitest";
import {
  buildRenderIndex,
  comparePositions,
  firstPositionInNode,
  lastPositionInNode,
  normalizeRange,
  pointToPosition,
  positionToPoint,
  selectionIsCollapsed,
  selectionToPositions,
} from "../src/model/selection";
import { element, marker, paragraph, run, text } from "./fake-dom";

/**
 * Paragraph layout used by most tests:
 *   inline 0: text "Hello " (6 chars)
 *   inline 1: image/tab marker (1 character in the model text)
 *   inline 2: text "world" (5 chars)
 * The paragraph is 12 characters long in plain text.
 */
const INLINE_LENGTHS = [6, 1, 5];

function plainOffset(position: {
  blockId: string;
  inlineIndex: number;
  offset: number;
}): number {
  let offset = 0;
  for (let index = 0; index < position.inlineIndex; index += 1)
    offset += INLINE_LENGTHS[index] ?? 0;
  return offset + position.offset;
}

function buildDocument() {
  const p1 = paragraph("p1", 3, [
    run("p1", 0, 0, "Hello "),
    marker("p1", 1),
    run("p1", 2, 0, "world"),
  ]);
  const p2 = paragraph("p2", 1, [run("p2", 0, 0, "Second paragraph")]);
  const p3 = paragraph("p3", 0, []);
  const section = element("div", { "data-section": "0" }, [p1, p2, p3]);
  const root = element("div", {}, [section]);
  const index = buildRenderIndex(root, ["p1", "p2", "p3"]);
  return { root, index, p1, p2, p3 };
}

describe("DOM render index", () => {
  it("collects one chunk per rendered text node with block/inline/offset anchors", () => {
    const { index } = buildDocument();
    expect(
      index.chunks.map((chunk) => [
        chunk.blockId,
        chunk.inlineIndex,
        chunk.offsetInInline,
        chunk.text,
      ]),
    ).toEqual([
      ["p1", 0, 0, "Hello "],
      ["p1", 2, 0, "world"],
      ["p2", 0, 0, "Second paragraph"],
    ]);
    expect(index.blockInlineCounts.get("p3")).toBe(0);
    expect(index.blockElements.has("p2")).toBe(true);
  });

  it("maps a text-node point to a model position", () => {
    const { index } = buildDocument();
    const worldNode = index.chunks[1].node;
    expect(pointToPosition(index, worldNode, 0)).toEqual({
      blockId: "p1",
      inlineIndex: 2,
      offset: 0,
    });
    expect(pointToPosition(index, worldNode, 5)).toEqual({
      blockId: "p1",
      inlineIndex: 2,
      offset: 5,
    });
    // Out-of-range offsets are clamped rather than throwing.
    expect(pointToPosition(index, worldNode, 99)).toEqual({
      blockId: "p1",
      inlineIndex: 2,
      offset: 5,
    });
  });

  it("resolves element boundary points (empty paragraphs, caret next to markers)", () => {
    const { index, p1, p3 } = buildDocument();
    // Between the first run and the image marker.
    expect(pointToPosition(index, p1, 1)).toEqual({
      blockId: "p1",
      inlineIndex: 1,
      offset: 0,
    });
    // After the last child of a paragraph: end of its last text run.
    expect(pointToPosition(index, p1, 3)).toEqual({
      blockId: "p1",
      inlineIndex: 2,
      offset: 5,
    });
    // Empty paragraph: block end.
    expect(pointToPosition(index, p3, 0)).toEqual({
      blockId: "p3",
      inlineIndex: 0,
      offset: 0,
    });
    expect(firstPositionInNode(index, p3)).toBeNull();
    expect(lastPositionInNode(index, p3)).toEqual({
      blockId: "p3",
      inlineIndex: 0,
      offset: 0,
    });
  });

  it("round-trips every caret offset in both text runs", () => {
    const { index } = buildDocument();
    const cases: Array<{ inlineIndex: number; length: number }> = [
      { inlineIndex: 0, length: 6 },
      { inlineIndex: 2, length: 5 },
    ];
    for (const entry of cases) {
      for (let offset = 0; offset <= entry.length; offset += 1) {
        const position = {
          blockId: "p1",
          inlineIndex: entry.inlineIndex,
          offset,
        };
        const point = positionToPoint(index, position);
        expect(
          point,
          `caret ${JSON.stringify(position)} must map to a DOM point`,
        ).not.toBeNull();
        const back = pointToPosition(index, point!.node, point!.offset);
        expect(
          back,
          `DOM point for ${JSON.stringify(position)} must map back`,
        ).not.toBeNull();
        // Boundary carets may normalize to an equivalent position, so compare the
        // plain-text offset inside the paragraph.
        expect(plainOffset(back!)).toBe(plainOffset(position));
      }
    }
  });

  it("maps the end-of-paragraph position onto the paragraph element", () => {
    const { index } = buildDocument();
    const point = positionToPoint(index, {
      blockId: "p1",
      inlineIndex: 3,
      offset: 0,
    });
    expect(point?.node.nodeType).toBe(1);
    expect(pointToPosition(index, point!.node, point!.offset)).toEqual({
      blockId: "p1",
      inlineIndex: 2,
      offset: 5,
    });
  });

  it("normalizes forward and backward multi-block selections", () => {
    const { index } = buildDocument();
    const forward = selectionToPositions(
      index,
      { node: index.chunks[1].node, offset: 2 },
      { node: index.chunks[2].node, offset: 6 },
    );
    expect(forward).not.toBeNull();
    expect(selectionIsCollapsed(forward!)).toBe(false);

    const range = normalizeRange(
      ["p1", "p2", "p3"],
      forward!.anchor,
      forward!.focus,
    );
    expect(range.start).toEqual({ blockId: "p1", inlineIndex: 2, offset: 2 });
    expect(range.end).toEqual({ blockId: "p2", inlineIndex: 0, offset: 6 });

    const backward = selectionToPositions(
      index,
      { node: index.chunks[2].node, offset: 6 },
      { node: index.chunks[2].node, offset: 2 },
    );
    const normalizedBackward = normalizeRange(
      ["p1", "p2", "p3"],
      backward!.anchor,
      backward!.focus,
    );
    expect(normalizedBackward.start).toEqual({
      blockId: "p2",
      inlineIndex: 0,
      offset: 2,
    });
    expect(normalizedBackward.end).toEqual({
      blockId: "p2",
      inlineIndex: 0,
      offset: 6,
    });
    expect(
      comparePositions(
        ["p1", "p2", "p3"],
        normalizedBackward.start,
        normalizedBackward.end,
      ),
    ).toBeLessThan(0);
  });

  it("treats a caret placed inside the same text node as collapsed", () => {
    const { index } = buildDocument();
    const selection = selectionToPositions(
      index,
      { node: index.chunks[0].node, offset: 3 },
      { node: index.chunks[0].node, offset: 3 },
    );
    expect(selectionIsCollapsed(selection!)).toBe(true);
    expect(selection!.focus).toEqual({
      blockId: "p1",
      inlineIndex: 0,
      offset: 3,
    });
  });

  it("returns null for points outside any rendered run", () => {
    const { index } = buildDocument();
    const detached = text("not rendered");
    expect(pointToPosition(index, detached, 0)).toBeNull();
    expect(
      positionToPoint(index, { blockId: "missing", inlineIndex: 0, offset: 0 }),
    ).toBeNull();
  });
});
