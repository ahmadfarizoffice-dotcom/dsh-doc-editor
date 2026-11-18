/**
 * DOM selection ⇄ model position mapping.
 *
 * The editable surface is a *projection* of the document model. Every rendered
 * text chunk is a `<span data-block data-inline data-offset>`, so a DOM range can
 * be translated into `TextPosition`s without reading the model, and a model
 * position can be translated back into a DOM point after a re-render.
 *
 * The traversal is written against a minimal structural interface rather than
 * against `lib.dom` so the mapping is unit-testable in a plain Node process with
 * a fake DOM (see test/fake-dom.ts). Real `Node`s satisfy the interface.
 */
import type { DocRange, TextPosition } from "@dsh-doc/core/model";

/** Minimal structural view of a DOM node (elements and text nodes). */
export interface DomLikeNode {
  /** 1 = element, 3 = text. */
  nodeType: number;
  nodeValue?: string | null;
  childNodes: ArrayLike<DomLikeNode>;
  getAttribute?: (name: string) => string | null;
}

export interface TextChunk<N extends DomLikeNode = DomLikeNode> {
  blockId: string;
  /** Index of the inline node that owns this chunk. */
  inlineIndex: number;
  /** UTF-16 offset of the chunk inside its inline's text. */
  offsetInInline: number;
  /** Text as rendered in this DOM text node. */
  text: string;
  node: N;
}

export interface RenderIndex<N extends DomLikeNode = DomLikeNode> {
  chunks: Array<TextChunk<N>>;
  /** Text node → chunk index. */
  chunkOfText: Map<N, number>;
  /** Element → inclusive chunk index range of its descendants. */
  elementChunks: Map<N, { first: number; last: number }>;
  /** Paragraph element by block id (used to address the end of a block). */
  blockElements: Map<string, N>;
  /** Inline count per block id, mirrored from `data-inline-count`. */
  blockInlineCounts: Map<string, number>;
  /** Block ids in document order, when the caller supplied one. */
  blockOrder: string[];
}

export interface DomPoint<N extends DomLikeNode = DomLikeNode> {
  node: N;
  offset: number;
}

export interface EditorSelection {
  /** Where the selection started (may be after `focus`). */
  anchor: TextPosition;
  /** The caret end of the selection. */
  focus: TextPosition;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function readAttribute(node: DomLikeNode, name: string): string | null {
  if (node.nodeType !== ELEMENT_NODE || typeof node.getAttribute !== "function")
    return null;
  return node.getAttribute(name);
}

function readNumberAttribute(
  node: DomLikeNode,
  name: string,
): number | undefined {
  const raw = readAttribute(node, name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function textContent(node: DomLikeNode): string {
  if (node.nodeType === TEXT_NODE) return node.nodeValue ?? "";
  let out = "";
  const kids = node.childNodes;
  for (let index = 0; index < kids.length; index += 1)
    out += textContent(kids[index]);
  return out;
}

/**
 * Builds the mapping index for a rendered block tree.
 *
 * `blockOrder` is the model's document order; it is used to normalize ranges.
 */
export function buildRenderIndex<N extends DomLikeNode>(
  root: N,
  blockOrder: string[] = [],
): RenderIndex<N> {
  const index: RenderIndex<N> = {
    chunks: [],
    chunkOfText: new Map(),
    elementChunks: new Map(),
    blockElements: new Map(),
    blockInlineCounts: new Map(),
    blockOrder,
  };

  interface Frame {
    /** Block id inherited from the closest `data-block` ancestor. */
    blockId?: string;
    /** Inline index inherited from the closest `data-inline` span. */
    inlineIndex?: number;
    /** Offset of the inherited inline span inside its run. */
    inlineOffset: number;
  }

  const visit = (node: N, inherited: Frame): void => {
    if (node.nodeType === TEXT_NODE) {
      const text = node.nodeValue ?? "";
      if (
        inherited.blockId === undefined ||
        inherited.inlineIndex === undefined
      )
        return;
      const chunkIndex = index.chunks.length;
      index.chunks.push({
        blockId: inherited.blockId,
        inlineIndex: inherited.inlineIndex,
        offsetInInline: inherited.inlineOffset,
        text,
        node,
      });
      index.chunkOfText.set(node, chunkIndex);
      return;
    }

    if (node.nodeType !== ELEMENT_NODE) return;

    const blockAttribute = readAttribute(node, "data-block");
    const inlineAttribute = readAttribute(node, "data-inline");
    const offsetAttribute = readNumberAttribute(node, "data-offset");

    let frame: Frame = inherited;
    if (blockAttribute !== null) {
      index.blockElements.set(blockAttribute, node);
      const inlineCount = readNumberAttribute(node, "data-inline-count");
      if (inlineCount !== undefined)
        index.blockInlineCounts.set(blockAttribute, inlineCount);
      frame = { ...frame, blockId: blockAttribute };
    }
    if (inlineAttribute !== null) {
      const inlineIndex = Number(inlineAttribute);
      if (Number.isFinite(inlineIndex)) {
        frame = {
          ...frame,
          inlineIndex,
          inlineOffset: offsetAttribute ?? 0,
        };
      }
    }

    const firstChunk = index.chunks.length;
    const kids = node.childNodes;
    for (let childIndex = 0; childIndex < kids.length; childIndex += 1) {
      visit(kids[childIndex] as N, frame);
    }
    const lastChunk = index.chunks.length - 1;
    if (lastChunk >= firstChunk) {
      index.elementChunks.set(node, { first: firstChunk, last: lastChunk });
      // Propagate upward through non-registered ancestors by recording lazily
      // in the reverse direction: children set their own ranges, and parents
      // compute theirs from their first/last chunk counts above.
    }
  };

  visit(root, { blockId: undefined, inlineIndex: undefined, inlineOffset: 0 });
  return index;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function chunkStart(chunk: TextChunk): TextPosition {
  return {
    blockId: chunk.blockId,
    inlineIndex: chunk.inlineIndex,
    offset: chunk.offsetInInline,
  };
}

function chunkEnd(chunk: TextChunk): TextPosition {
  return {
    blockId: chunk.blockId,
    inlineIndex: chunk.inlineIndex,
    offset: chunk.offsetInInline + chunk.text.length,
  };
}

/** First selectable model position inside a node, or null when it holds no text. */
export function firstPositionInNode<N extends DomLikeNode>(
  index: RenderIndex<N>,
  node: N,
): TextPosition | null {
  if (node.nodeType === TEXT_NODE) {
    const chunkIndex = index.chunkOfText.get(node);
    if (chunkIndex === undefined) return null;
    return chunkStart(index.chunks[chunkIndex]);
  }
  if (node.nodeType !== ELEMENT_NODE) return null;

  const blockId = readAttribute(node, "data-block");
  const inlineIndex = readNumberAttribute(node, "data-inline");
  if (blockId !== null && inlineIndex !== undefined) {
    const offset = readNumberAttribute(node, "data-offset") ?? 0;
    return { blockId, inlineIndex, offset };
  }

  const range = index.elementChunks.get(node);
  if (range) return chunkStart(index.chunks[range.first]);

  // Element with an inline marker but no text (image / tab / break).
  const kids = node.childNodes;
  for (let childIndex = 0; childIndex < kids.length; childIndex += 1) {
    const found = firstPositionInNode(index, kids[childIndex] as N);
    if (found) return found;
  }
  return null;
}

/** Last selectable model position inside a node, or null when it holds no text. */
export function lastPositionInNode<N extends DomLikeNode>(
  index: RenderIndex<N>,
  node: N,
): TextPosition | null {
  if (node.nodeType === TEXT_NODE) {
    const chunkIndex = index.chunkOfText.get(node);
    if (chunkIndex === undefined) return null;
    return chunkEnd(index.chunks[chunkIndex]);
  }
  if (node.nodeType !== ELEMENT_NODE) return null;

  const blockId = readAttribute(node, "data-block");
  const inlineIndex = readNumberAttribute(node, "data-inline");
  if (blockId !== null && inlineIndex !== undefined) {
    const range = index.elementChunks.get(node);
    if (range) return chunkEnd(index.chunks[range.last]);
    // Marker only (image, tab, break): "after this inline".
    return { blockId, inlineIndex: inlineIndex + 1, offset: 0 };
  }

  const kids = node.childNodes;
  for (let childIndex = kids.length - 1; childIndex >= 0; childIndex -= 1) {
    const found = lastPositionInNode(index, kids[childIndex] as N);
    if (found) return found;
  }

  const block = blockId === null ? undefined : blockId;
  if (block !== undefined) return blockEnd(index, block);
  const range = index.elementChunks.get(node);
  if (range) return chunkEnd(index.chunks[range.last]);
  return null;
}

function blockEnd<N extends DomLikeNode>(
  index: RenderIndex<N>,
  blockId: string,
): TextPosition {
  return {
    blockId,
    inlineIndex: index.blockInlineCounts.get(blockId) ?? 0,
    offset: 0,
  };
}

/**
 * Resolves a DOM boundary point to a model position.
 *
 * Element containers are the common case for collapsed carets at the start or
 * end of a paragraph, and for carets next to images and other markers.
 */
export function pointToPosition<N extends DomLikeNode>(
  index: RenderIndex<N>,
  node: N,
  offset: number,
): TextPosition | null {
  if (node.nodeType === TEXT_NODE) {
    const chunkIndex = index.chunkOfText.get(node);
    if (chunkIndex === undefined) return null;
    const chunk = index.chunks[chunkIndex];
    const local = clamp(offset, 0, chunk.text.length);
    return {
      blockId: chunk.blockId,
      inlineIndex: chunk.inlineIndex,
      offset: chunk.offsetInInline + local,
    };
  }
  if (node.nodeType !== ELEMENT_NODE) return null;

  const kids = node.childNodes;
  if (kids.length === 0) {
    const blockId = readAttribute(node, "data-block");
    if (blockId !== null) return blockEnd(index, blockId);
    return null;
  }

  const at = clamp(offset, 0, kids.length);
  if (at < kids.length) {
    const next = kids[at] as N;
    const forward = firstPositionInNode(index, next);
    if (forward) return forward;
    for (let sibling = at + 1; sibling < kids.length; sibling += 1) {
      const found = firstPositionInNode(index, kids[sibling] as N);
      if (found) return found;
    }
  }

  for (
    let sibling = Math.min(at, kids.length) - 1;
    sibling >= 0;
    sibling -= 1
  ) {
    const found = lastPositionInNode(index, kids[sibling] as N);
    if (found) return found;
  }

  const blockId = readAttribute(node, "data-block");
  if (blockId !== null) {
    const inlineCount = index.blockInlineCounts.get(blockId);
    if (inlineCount !== undefined) return blockEnd(index, blockId);
    // Nearest ancestor paragraph, if this element is nested (e.g. <strong>).
    const range = index.elementChunks.get(node);
    if (range) return chunkEnd(index.chunks[range.last]);
  }
  const range = index.elementChunks.get(node);
  if (range) return chunkEnd(index.chunks[range.last]);
  return null;
}

/** Converts a DOM selection into model positions (anchor and focus order kept). */
export function selectionToPositions<N extends DomLikeNode>(
  index: RenderIndex<N>,
  anchor: DomPoint<N>,
  focus: DomPoint<N>,
): EditorSelection | null {
  const anchorPosition = pointToPosition(index, anchor.node, anchor.offset);
  const focusPosition = pointToPosition(index, focus.node, focus.offset);
  if (!anchorPosition || !focusPosition) return null;
  return { anchor: anchorPosition, focus: focusPosition };
}

export function comparePositions(
  blockOrder: string[],
  a: TextPosition,
  b: TextPosition,
): number {
  if (a.blockId === b.blockId) {
    if (a.inlineIndex !== b.inlineIndex) return a.inlineIndex - b.inlineIndex;
    return a.offset - b.offset;
  }
  const ai = blockOrder.indexOf(a.blockId);
  const bi = blockOrder.indexOf(b.blockId);
  if (ai >= 0 && bi >= 0 && ai !== bi) return ai - bi;
  return a.blockId < b.blockId ? -1 : 1;
}

/** Orders a selection so `start` comes first in the document. */
export function normalizeRange(
  blockOrder: string[],
  anchor: TextPosition,
  focus: TextPosition,
): DocRange {
  return comparePositions(blockOrder, anchor, focus) <= 0
    ? { start: anchor, end: focus }
    : { start: focus, end: anchor };
}

export function selectionIsCollapsed(selection: EditorSelection): boolean {
  return (
    selection.anchor.blockId === selection.focus.blockId &&
    selection.anchor.inlineIndex === selection.focus.inlineIndex &&
    selection.anchor.offset === selection.focus.offset
  );
}

/** DOM point for a model position, or null when the position is not rendered. */
export function positionToPoint<N extends DomLikeNode>(
  index: RenderIndex<N>,
  position: TextPosition,
): DomPoint<N> | null {
  for (let chunkIndex = 0; chunkIndex < index.chunks.length; chunkIndex += 1) {
    const chunk = index.chunks[chunkIndex];
    if (chunk.blockId !== position.blockId) continue;
    if (chunk.inlineIndex !== position.inlineIndex) continue;
    const start = chunk.offsetInInline;
    const end = start + chunk.text.length;
    if (position.offset >= start && position.offset <= end) {
      return { node: chunk.node, offset: position.offset - start };
    }
  }

  // Position at a marker boundary or at the end of an empty paragraph: use the
  // next rendered chunk in the same block, else the paragraph element itself.
  let nextChunk: TextChunk<N> | undefined;
  for (const chunk of index.chunks) {
    if (chunk.blockId !== position.blockId) continue;
    if (chunk.inlineIndex > position.inlineIndex) {
      nextChunk = chunk;
      break;
    }
  }
  if (nextChunk) {
    const chunkFirst = index.chunks.findIndex(
      (entry) => entry.node === nextChunk?.node,
    );
    const start = index.chunks[chunkFirst];
    if (start) return { node: start.node, offset: 0 };
  }

  const element = index.blockElements.get(position.blockId);
  if (element) return { node: element, offset: element.childNodes.length };
  return null;
}

/* ------------------------------------------------------------------ browser */

function isTextNode(node: Node): node is Text {
  return node.nodeType === 3;
}

/** Builds the index from a live DOM subtree. */
export function buildDomIndex(
  root: HTMLElement,
  blockOrder: string[] = [],
): RenderIndex<Node> {
  return buildRenderIndex<Node>(root as unknown as Node, blockOrder);
}

/** Reads the current DOM selection, when it lives inside `root`. */
export function readDomSelection(
  root: HTMLElement,
  selection: Selection | null = window.getSelection(),
): { anchor: DomPoint<Node>; focus: DomPoint<Node> } | null {
  if (!selection || selection.rangeCount === 0) return null;
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (!anchorNode || !focusNode) return null;
  if (!root.contains(anchorNode) || !root.contains(focusNode)) return null;
  return {
    anchor: { node: anchorNode, offset: anchorOffset },
    focus: { node: focusNode, offset: focusOffset },
  };
}

/** Places the DOM selection for a model selection. Returns false when unmappable. */
export function writeDomSelection(
  index: RenderIndex<Node>,
  selection: EditorSelection,
  target: Selection | null = window.getSelection(),
): boolean {
  if (!target) return false;
  const anchor = positionToPoint(index, selection.anchor);
  const focus = positionToPoint(index, selection.focus);
  if (!anchor || !focus) return false;

  const doc = anchor.node.ownerDocument ?? focus.node.ownerDocument;
  if (!doc) return false;
  const range = doc.createRange();
  try {
    range.setStart(
      anchor.node,
      clampOffset(anchor.node, anchor.offset, isTextNode),
    );
    range.setEnd(focus.node, clampOffset(focus.node, focus.offset, isTextNode));
  } catch {
    return false;
  }
  target.removeAllRanges();
  target.addRange(range);
  return true;
}

function clampOffset(
  node: Node,
  offset: number,
  text: (node: Node) => node is Text,
): number {
  const max = text(node)
    ? (node.nodeValue ?? "").length
    : node.childNodes.length;
  return Math.max(0, Math.min(offset, max));
}
