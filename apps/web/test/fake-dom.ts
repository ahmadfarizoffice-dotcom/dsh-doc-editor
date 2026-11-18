/**
 * A tiny fake DOM used by the selection-mapping tests.
 *
 * It implements exactly the structural contract `model/selection.ts` consumes
 * (`nodeType`, `childNodes`, `nodeValue`, `getAttribute`), so the same traversal
 * code that runs against a real browser DOM is exercised in a plain Node test.
 */
import type { DomLikeNode } from "../src/model/selection";

export interface FakeNode extends DomLikeNode {
  tagName?: string;
  attributes?: Record<string, string>;
  childNodes: FakeNode[];
  nodeValue?: string | null;
  getAttribute: (name: string) => string | null;
}

export function text(value: string): FakeNode {
  return {
    nodeType: 3,
    nodeValue: value,
    childNodes: [],
    getAttribute: () => null,
  };
}

export function element(
  tagName: string,
  attributes: Record<string, string>,
  children: FakeNode[] = [],
): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    tagName,
    attributes,
    childNodes: children,
    getAttribute(name: string) {
      return node.attributes?.[name] ?? null;
    },
  };
  return node;
}

/** A rendered text chunk: `<span data-block data-inline data-offset>text</span>`. */
export function run(
  blockId: string,
  inlineIndex: number,
  offset: number,
  value: string,
): FakeNode {
  return element(
    "span",
    {
      "data-block": blockId,
      "data-inline": String(inlineIndex),
      "data-offset": String(offset),
    },
    [text(value)],
  );
}

/** A rendered non-text inline (image, tab, break). */
export function marker(
  blockId: string,
  inlineIndex: number,
  label = "marker",
): FakeNode {
  return element("span", {
    "data-block": blockId,
    "data-inline": String(inlineIndex),
    "data-offset": "0",
    "data-marker": label,
  });
}

/** Rendered paragraph container. */
export function paragraph(
  blockId: string,
  inlineCount: number,
  children: FakeNode[],
): FakeNode {
  return element(
    "p",
    {
      "data-block": blockId,
      "data-inline-count": String(inlineCount),
    },
    children,
  );
}
