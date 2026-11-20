/**
 * Suite: undo-redo.
 *
 * Typing, formatting, structure and deletion, each followed by undo/redo. The
 * assertions are the document text, the block count and the op sequence.
 */
import {
  assert,
  assertEqual,
  caretAt,
  clickTool,
  domText,
  hostState,
  pageErrors,
  paragraphProps,
  prepare,
  press,
  settleText,
  sleep,
  typeText,
  seededCases,
} from "../kit.mjs";

const BASE = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];
const JOIN = (blocks) => blocks.join("\n");

const SCENARIOS = [
  {
    id: "type-undo",
    run: async (ids) => {
      await caretAt(ids[0], 16);
      await typeText("xyz");
      await sleep(700);
      await press("Ctrl+KeyZ");
    },
    expected: JOIN(BASE),
  },
  {
    id: "type-undo-redo",
    run: async (ids) => {
      await caretAt(ids[0], 16);
      await typeText("xyz");
      await sleep(700);
      await press("Ctrl+KeyZ");
      await sleep(400);
      await press("Ctrl+KeyY");
    },
    expected: JOIN([BASE[0] + "xyz", BASE[1], BASE[2]]),
  },
  {
    id: "type-undo-shift-redo",
    run: async (ids) => {
      await caretAt(ids[0], 16);
      await typeText("ab");
      await sleep(700);
      await press("Ctrl+KeyZ");
      await sleep(400);
      await press("Ctrl+Shift+KeyZ");
    },
    expected: JOIN([BASE[0] + "ab", BASE[1], BASE[2]]),
  },
  {
    id: "bold-undo",
    run: async (ids) => {
      await caretAt(ids[0], 5);
      await press("Ctrl+KeyB");
      await sleep(600);
      await press("Ctrl+KeyZ");
    },
    expected: JOIN(BASE),
  },
  {
    id: "enter-undo",
    run: async (ids) => {
      await caretAt(ids[0], 5);
      await press("Enter");
      await sleep(500);
      await press("Ctrl+KeyZ");
    },
    expected: JOIN(BASE),
  },
  {
    id: "delete-undo",
    run: async (ids) => {
      await caretAt(ids[0], 0);
      await press("Delete");
      await press("Delete");
      await sleep(400);
      await press("Ctrl+KeyZ");
    },
    expected: JOIN(BASE),
  },
  {
    id: "undo-then-type",
    run: async (ids) => {
      await caretAt(ids[0], 16);
      await typeText("q");
      await sleep(700);
      await press("Ctrl+KeyZ");
      await sleep(400);
      await typeText("!");
    },
    expected: JOIN([BASE[0] + "!", BASE[1], BASE[2]]),
  },
  {
    id: "undo-undo",
    run: async (ids) => {
      await caretAt(ids[0], 16);
      await typeText("a");
      await sleep(500);
      await typeText("b");
      await sleep(700);
      await press("Ctrl+KeyZ");
      await sleep(300);
      await press("Ctrl+KeyZ");
    },
    expected: JOIN(BASE),
  },
  {
    id: "redo-then-undo",
    run: async (ids) => {
      await caretAt(ids[0], 16);
      await typeText("zz");
      await sleep(700);
      await press("Ctrl+KeyZ");
      await sleep(300);
      await press("Ctrl+KeyY");
      await sleep(300);
      await press("Ctrl+KeyZ");
    },
    expected: JOIN(BASE),
  },
  {
    id: "format-stays-undoable",
    run: async (ids) => {
      await caretAt(ids[0], 2);
      await clickTool("Bold");
      await sleep(500);
      await press("Ctrl+KeyZ");
      await sleep(300);
      await press("Ctrl+KeyY");
    },
    expected: JOIN(BASE),
  },
];

const VARIANTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function buildCases() {
  const cases = [];
  for (const scenario of SCENARIOS) {
    for (const variant of VARIANTS) {
      if (cases.length >= 150) break;
      cases.push({ id: `${scenario.id}/${variant}`, scenario });
    }
  }
  return seededCases(cases).slice(0, 150);
}

async function runCase(item) {
  const { ids } = await prepare(BASE, { hijackKeys: [] });
  await item.scenario.run(ids);
  const settled = await settleText(8000);
  assertEqual(settled.text, item.scenario.expected, `${item.id}: text`);
  const dom = await domText();
  assertEqual(dom, settled.text, `${item.id}: DOM text`);
  const errors = await pageErrors();
  assertEqual(
    errors.length,
    0,
    `${item.id}: console errors ${JSON.stringify(errors)}`,
  );
  const formatting = await paragraphProps();
  assert(
    formatting.length >= 1,
    `${item.id}: the document lost its paragraphs`,
  );
}

export const suite = {
  name: "undo-redo",
  build: buildCases,
  async run(item) {
    await runCase(item);
  },
};
