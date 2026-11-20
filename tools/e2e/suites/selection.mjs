/**
 * Suite: selection-multiblock.
 *
 * Each paragraph is its own contenteditable, so the interesting cases are the
 * selections that cross a paragraph boundary: a mouse drag, Shift+Click,
 * Shift+Arrow, Ctrl+A, and the formatting/deleting/typing that follows.
 */
import {
  assert,
  assertEqual,
  caretAt,
  clickBlock,
  textPoint,
  domParagraphs,
  dragBlocks,
  errorText,
  evaluatePage,
  hostState,
  pageErrors,
  paragraphProps,
  prepare,
  press,
  selectionAttr,
  selectionBlocks,
  sleep,
  typeText,
  waitForPage,
  seededCases,
} from "../kit.mjs";
import { click, mouse } from "../cdp.mjs";

const PARAGRAPHS = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];

async function doubleClick(blockId, fraction) {
  const point = await textPoint(blockId, fraction);
  const client = (await import("../kit.mjs")).kit().client;
  for (const count of [1, 2]) {
    await mouse(client, "mousePressed", point.x, point.y, {
      clickCount: count,
    });
    await mouse(client, "mouseReleased", point.x, point.y, {
      clickCount: count,
      buttons: 0,
    });
  }
  await sleep(80);
}

async function tripleClick(blockId, fraction = 0.4) {
  const point = await textPoint(blockId, fraction);
  const client = (await import("../kit.mjs")).kit().client;
  for (const count of [1, 2, 3]) {
    await mouse(client, "mousePressed", point.x, point.y, {
      clickCount: count,
    });
    await mouse(client, "mouseReleased", point.x, point.y, {
      clickCount: count,
      buttons: 0,
    });
  }
  await sleep(80);
}

async function shiftClick(blockId, fraction) {
  const point = await textPoint(blockId, fraction);
  const client = (await import("../kit.mjs")).kit().client;
  await click(client, point.x, point.y, { modifiers: 8 });
  await sleep(80);
}

function pointsOf(attr) {
  if (!attr) return null;
  const match = /^([^:]+):(\d+)>([^:]+):(\d+)$/.exec(attr);
  if (!match) return null;
  return {
    from: { blockId: match[1], offset: Number(match[2]) },
    to: { blockId: match[3], offset: Number(match[4]) },
  };
}

/** Expected text after replacing [from,to) with `insert` over plain paragraphs. */
function expectedAfterReplace(allBlocks, from, to, insert) {
  const blocks = allBlocks.filter((block) => block.type !== "table");
  const texts = blocks.map((block) => block.text);
  const fromIndex = blocks.findIndex((block) => block.id === from.blockId);
  const toIndex = blocks.findIndex((block) => block.id === to.blockId);
  if (fromIndex < 0 || toIndex < 0) return null;
  const fromText = blocks[fromIndex].text;
  const toText = blocks[toIndex].text;
  const before = fromText.slice(0, from.offset);
  const after = toText.slice(to.offset);
  const merged = before + insert + after;
  const result = texts.slice(0, fromIndex);
  result.push(merged);
  result.push(...texts.slice(toIndex + 1));
  return result.join("\n");
}

async function clipboardCopy() {
  return evaluatePage(`(() => {
    const surface = document.querySelector('.dx-editor');
    const target = document.querySelector('.dx-para');
    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return { text: data.getData('text/plain'), prevented: event.defaultPrevented };
  })()`);
}

async function clipboardCut() {
  return evaluatePage(`(() => {
    const target = document.querySelector('.dx-para');
    const data = new DataTransfer();
    const event = new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return { text: data.getData('text/plain'), prevented: event.defaultPrevented };
  })()`);
}

const SHAPES = [
  {
    id: "drag-forward",
    apply: (ids) => dragBlocks(ids[0], 0.2, ids[1], 0.6),
    blocks: [0, 1],
  },
  {
    id: "drag-backward",
    apply: (ids) => dragBlocks(ids[2], 0.7, ids[0], 0.25),
    blocks: [0, 1, 2],
  },
  {
    id: "drag-three",
    apply: (ids) => dragBlocks(ids[0], 0.1, ids[2], 0.8),
    blocks: [0, 1, 2],
  },
  {
    id: "double-click-word",
    apply: (ids) => doubleClick(ids[1], 0.35),
    blocks: [1],
  },
  {
    id: "triple-click-paragraph",
    apply: (ids) => tripleClick(ids[1]),
    blocks: [1],
  },
  {
    id: "shift-click",
    apply: async (ids) => {
      await caretAt(ids[0], 3);
      await shiftClick(ids[2], 0.5);
    },
    blocks: [0, 1, 2],
  },
  {
    id: "shift-arrow-down",
    apply: async (ids) => {
      await caretAt(ids[0], 2);
      await press("Shift+ArrowDown");
      await press("Shift+ArrowDown");
    },
    blocks: [0, 1, 2],
  },
  {
    id: "shift-arrow-boundary",
    apply: async (ids) => {
      await caretAt(ids[0], 16);
      await press("Shift+ArrowRight");
    },
    blocks: [0, 1],
  },
  {
    id: "ctrl-a",
    apply: async () => press("Ctrl+KeyA"),
    blocks: [0, 1, 2],
  },
  {
    id: "click-then-drag",
    apply: async (ids) => {
      await clickBlock(ids[0], 0.5);
      await dragBlocks(ids[0], 0.5, ids[1], 0.4);
    },
    blocks: [0, 1],
  },
];

const FOLLOW_UPS = [
  "shape",
  "bold",
  "delete",
  "type",
  "copy",
  "delete2",
  "backspace",
];

const VARIANTS = [0.15, 0.45, 0.8];

/** Blocks in the selection whose selected range contains at least one character. */
function nonEmptyBlocks(allBlocks, points, selectedIds) {
  const paragraphs = allBlocks.filter((block) => block.type !== "table");
  return selectedIds.filter((id) => {
    const block = paragraphs.find((entry) => entry.id === id);
    if (!block) return false;
    const fromOffset = id === points.from.blockId ? points.from.offset : 0;
    const toOffset =
      id === points.to.blockId ? points.to.offset : block.text.length;
    return toOffset > fromOffset;
  });
}

/** Prefix/suffix and untouched paragraphs around a model selection. */
function selectionExpectation(allBlocks, points) {
  const paragraphs = allBlocks.filter((block) => block.type !== "table");
  const fromIndex = paragraphs.findIndex(
    (block) => block.id === points.from.blockId,
  );
  const toIndex = paragraphs.findIndex(
    (block) => block.id === points.to.blockId,
  );
  const from = paragraphs[fromIndex];
  const to = paragraphs[toIndex];
  const prefix = from.text.slice(0, points.from.offset);
  const suffix = to.text.slice(points.to.offset);
  const middle = paragraphs
    .slice(fromIndex + 1, toIndex)
    .map((block) => block.text);
  const parts = [
    from.text.slice(points.from.offset),
    ...middle,
    to.text.slice(0, points.to.offset),
  ];
  // Only paragraph breaks, no characters: an empty cross-boundary range.
  const selected = parts.some((part) => part.length > 0)
    ? parts.join("\n")
    : "";
  return {
    prefix,
    suffix,
    selected,
    sameBlock: fromIndex === toIndex,
    untouched: [
      ...paragraphs.slice(0, fromIndex).map((block) => block.text),
      ...paragraphs.slice(toIndex + 1).map((block) => block.text),
    ],
  };
}

function buildCases() {
  const cases = [];
  for (const shape of SHAPES) {
    for (const followUp of FOLLOW_UPS) {
      for (const fraction of VARIANTS) {
        cases.push({
          id: `${shape.id}/${followUp}/${fraction}`,
          shape,
          followUp,
          fraction,
        });
      }
    }
  }
  // 10 shapes * 7 follow-ups * 3 variants = 210 candidates; keep 150 with
  // full shape/follow-up coverage by dropping the last 60 variants.
  const kept = [];
  for (const shape of SHAPES) {
    for (const followUp of FOLLOW_UPS) {
      const variants = VARIANTS.slice(0, 2);
      for (const fraction of variants) {
        kept.push({
          id: `${shape.id}/${followUp}/${fraction}`,
          shape,
          followUp,
          fraction,
        });
      }
    }
  }
  // 140; add ten more with the third variant for the first ten pairs.
  for (const shape of SHAPES.slice(0, 5)) {
    kept.push({
      id: `${shape.id}/shape/0.8`,
      shape,
      followUp: "shape",
      fraction: 0.8,
    });
  }
  for (const shape of SHAPES.slice(0, 5)) {
    kept.push({
      id: `${shape.id}/bold/0.8`,
      shape,
      followUp: "bold",
      fraction: 0.8,
    });
  }
  return seededCases(kept).slice(0, 150);
}

async function applyShape(item, ids) {
  if (item.id.startsWith("triple-click")) await item.shape.apply(ids);
  else await item.shape.apply(ids);
}

async function runCase(item) {
  const { ids } = await prepare(PARAGRAPHS, { hijackKeys: [] });
  await applyShape(item, ids);
  await sleep(80);
  const attr = await selectionAttr();
  assert(attr, `${item.id}: no selection was published`);
  const points = pointsOf(attr);
  assert(points, `${item.id}: malformed selection attr ${attr}`);
  const blocks = (await selectionBlocks()).split(",").filter(Boolean);
  const expectedBlocks = item.shape.blocks.map((index) => ids[index]);
  assertEqual(
    blocks.join(","),
    expectedBlocks.join(","),
    `${item.id}: selected blocks`,
  );
  assert(
    points.from.offset >= 0 && points.to.offset >= 0,
    `${item.id}: negative offsets`,
  );

  if (item.followUp === "shape") {
    // The DOM selection must address the same points the model reports.
    const dom = await evaluatePage(`(() => {
      const test = window.__DSH_PANEL__.__test;
      const surface = document.querySelector('.dx-editor');
      return test.domSelectionToModel(surface);
    })()`);
    assert(dom, `${item.id}: DOM selection vanished`);
    const expectedFrom = points.from;
    assertEqual(
      dom.start.blockId,
      expectedFrom.blockId,
      `${item.id}: DOM start block`,
    );
    assertEqual(
      dom.start.offset,
      expectedFrom.offset,
      `${item.id}: DOM start offset`,
    );
    return;
  }

  if (item.followUp === "bold") {
    // Only blocks with a non-empty selected range can carry the property; a
    // selection that ends exactly at a paragraph boundary selects no character
    // from the block it starts in.
    const state = await hostState();
    const expectedBold = nonEmptyBlocks(state.blocks, points, expectedBlocks);
    await press("Ctrl+KeyB");
    let boldBlocks = 0;
    for (
      let attempt = 0;
      attempt < 30 && boldBlocks < expectedBold.length;
      attempt += 1
    ) {
      const blocksNow = await paragraphProps();
      boldBlocks = expectedBold.filter((id) => {
        const block = blocksNow.find((entry) => entry.id === id);
        return (
          block &&
          (block.inlines || []).some(
            (inline) => inline.props && inline.props.bold,
          )
        );
      }).length;
      if (boldBlocks < expectedBold.length) await sleep(60);
    }
    assertEqual(
      boldBlocks,
      expectedBold.length,
      `${item.id}: bold applied to ${boldBlocks}/${expectedBold.length} non-empty blocks`,
    );
    return;
  }

  if (
    item.followUp === "delete" ||
    item.followUp === "type" ||
    item.followUp === "backspace" ||
    item.followUp === "delete2"
  ) {
    const state = await hostState();
    const expectation = selectionExpectation(state.blocks, points);
    const insert = item.followUp === "type" ? "z" : "";
    // The exact expected text: the selection is replaced by `insert`; a
    // cross-paragraph range also removes the paragraph marks it covers, and a
    // cross-boundary range (end of one paragraph to the start of the next)
    // therefore joins them.
    const expected = expectedAfterReplace(
      state.blocks,
      points.from,
      points.to,
      insert,
    );
    if (item.followUp === "type") await press("z");
    else if (item.followUp === "delete" || item.followUp === "delete2")
      await press("Delete");
    else if (item.followUp === "backspace") await press("Backspace");

    let host = await hostState();
    for (
      let attempt = 0;
      attempt < 40 && host.text !== expected;
      attempt += 1
    ) {
      await sleep(80);
      host = await hostState();
    }
    const dom = await evaluatePage("window.__E2E__.domText()");
    assertEqual(dom, host.text, `${item.id}: DOM and Host text diverged`);
    if (expected === "") {
      assert(
        /^\n*$/.test(host.text),
        `${item.id}: deleting everything left text ${JSON.stringify(host.text)}`,
      );
    } else {
      assertEqual(
        host.text,
        expected,
        `${item.id}: text after ${item.followUp}`,
      );
    }
    return;
  }

  if (item.followUp === "copy") {
    const result = await clipboardCopy();
    assert(result && result.text, `${item.id}: copy produced no text`);
    assert(result.prevented, `${item.id}: copy was not handled by the panel`);
    assert(
      result.text.includes("\n") || expectedBlocks.length === 1,
      `${item.id}: multi-block copy has no newline: ${JSON.stringify(result.text)}`,
    );
    return;
  }

  const errors = await pageErrors();
  assertEqual(
    errors.length,
    0,
    `${item.id}: console errors ${JSON.stringify(errors)}`,
  );
  const bar = await errorText();
  assertEqual(bar, null, `${item.id}: error bar ${bar}`);
}

export const suite = {
  name: "selection-multiblock",
  build: buildCases,
  async run(item) {
    try {
      await runCase(item);
    } finally {
      await press("Escape").catch(() => {});
      await evaluatePage("window.__E2E__.remount(), true").catch(() => {});
    }
  },
};

export { pointsOf, expectedAfterReplace };
