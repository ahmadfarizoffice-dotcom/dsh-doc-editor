/**
 * Suite: structure.
 *
 * Enter / Shift+Enter / Backspace / Delete / Tab / tables. Each case asserts
 * the Host text (or block count/table shape), DOM==Host, and no console errors.
 */
import {
  assert,
  assertEqual,
  caretAt,
  caseSeed,
  clickTool,
  domText,
  hostDocument,
  hostState,
  pageErrors,
  prepare,
  press,
  selectTab,
  sleep,
  submitDialog,
  waitForHostText,
} from "../kit.mjs";

const BASE = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];

const SCENARIOS = [
  {
    id: "enter-end",
    run: async (ids) => {
      await caretAt(ids[0], 16);
      await press("Enter");
    },
  },
  {
    id: "enter-mid",
    run: async (ids) => {
      await caretAt(ids[0], 5);
      await press("Enter");
    },
  },
  {
    id: "enter-start",
    run: async (ids) => {
      await caretAt(ids[0], 0);
      await press("Enter");
    },
  },
  {
    id: "shift-enter",
    run: async (ids) => {
      await caretAt(ids[0], 5);
      await press("Shift+Enter");
    },
  },
  {
    id: "backspace-start",
    run: async (ids) => {
      await caretAt(ids[1], 0);
      await press("Backspace");
    },
  },
  {
    id: "delete-end",
    run: async (ids) => {
      await caretAt(ids[0], 16);
      await press("Delete");
    },
  },
  {
    id: "enter-then-type",
    run: async (ids) => {
      await caretAt(ids[0], 16);
      await press("Enter");
      await press("x");
    },
  },
  {
    id: "type-then-enter",
    run: async (ids) => {
      await caretAt(ids[0], 16);
      await press("q");
      await press("Enter");
    },
  },
  {
    id: "backspace-word",
    run: async (ids) => {
      await caretAt(ids[1], 5);
      for (let i = 0; i < 4; i += 1) await press("Backspace");
    },
  },
  {
    id: "delete-word",
    run: async (ids) => {
      await caretAt(ids[1], 5);
      for (let i = 0; i < 4; i += 1) await press("Delete");
    },
  },
  {
    id: "tab",
    run: async (ids) => {
      await caretAt(ids[0], 5);
      await press("Tab");
    },
  },
  {
    id: "enter-tab-p2",
    run: async (ids) => {
      await caretAt(ids[2], 3);
      await press("Enter");
      await press("Tab");
    },
  },
  {
    id: "table-insert",
    run: async () => {
      await selectTab("Insert");
      await clickTool("Table");
      await submitDialog();
    },
    table: true,
  },
  {
    id: "table-insert-then-type",
    run: async (ids) => {
      await selectTab("Insert");
      await clickTool("Table");
      await submitDialog();
      await sleep(400);
      const cell = await evaluateCellParagraph();
      if (cell) {
        await caretAt(cell, 0);
        await press("x");
      }
    },
    table: true,
  },
];

async function evaluateCellParagraph() {
  const { evaluatePage } = await import("../kit.mjs");
  return evaluatePage(`(() => {
    const cell = document.querySelector('.dx-table td .dx-para');
    return cell ? cell.getAttribute('data-block-id') : null;
  })()`);
}

const VARIANTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function buildCases() {
  const cases = [];
  for (const scenario of SCENARIOS) {
    for (const variant of VARIANTS) {
      if (cases.length >= 150) break;
      cases.push({
        id: `${scenario.id}/${variant}`,
        scenario,
        variant,
      });
    }
  }
  // 15 scenarios × 11 = 165; keep 150, rotated by --seed.
  const offset = caseSeed() % cases.length;
  const rotated = cases.slice(offset).concat(cases.slice(0, offset));
  return rotated.slice(0, 150);
}

async function runCase(item) {
  const { ids } = await prepare(BASE, { hijackKeys: [] });
  const before = await hostState();
  await item.scenario.run(ids);
  await sleep(120);
  if (item.scenario.table) {
    const document = await hostDocument();
    const tables = (document.document.sections || [])
      .flatMap((section) => section.blocks || [])
      .filter((block) => block.type === "table");
    assert(
      tables.length === 1,
      `${item.id}: expected one table, got ${tables.length}`,
    );
    assert(
      (tables[0].rows || []).length >= 1,
      `${item.id}: inserted table has no rows`,
    );
    const dom = await domText();
    const state = await hostState();
    assertEqual(
      dom,
      state.text,
      `${item.id}: DOM and Host diverged after the table`,
    );
  } else {
    let state = await hostState();
    for (
      let attempt = 0;
      attempt < 30 && state.text === before.text;
      attempt += 1
    ) {
      await sleep(60);
      state = await hostState();
    }
    assert(
      state.text !== before.text,
      `${item.id}: the structural edit did not change the document`,
    );
    const dom = await domText();
    assertEqual(dom, state.text, `${item.id}: DOM and Host text diverged`);
    const paragraphs = state.blocks.filter((block) => block.type !== "table");
    assert(
      paragraphs.length >= 1,
      `${item.id}: the document lost every paragraph`,
    );
  }
  const errors = await pageErrors();
  assertEqual(
    errors.length,
    0,
    `${item.id}: console errors ${JSON.stringify(errors)}`,
  );
  await selectTab("Home").catch(() => {});
}

export const suite = {
  name: "structure",
  build: buildCases,
  async run(item) {
    await runCase(item);
  },
};
