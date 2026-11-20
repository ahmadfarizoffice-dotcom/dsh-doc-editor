/**
 * Suite: formatting.
 *
 * Selection shapes × ribbon formatting commands. The assertions read the Host
 * document: run properties for character formatting, paragraph properties for
 * alignment, and the numbering block for lists.
 */
import {
  assert,
  assertEqual,
  caretAt,
  clickTool,
  dragBlocks,
  errorText,
  hostState,
  opLog,
  pageErrors,
  paragraphProps,
  prepare,
  press,
  selectTab,
  sleep,
  totalOps,
  waitForOp,
} from "../kit.mjs";

const PARAGRAPHS = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];

const FORMATS = [
  {
    id: "bold",
    label: "Bold",
    kind: "run",
    check: (block) => block.inlines.some((i) => i.props && i.props.bold),
  },
  {
    id: "italic",
    label: "Italic",
    kind: "run",
    check: (block) => block.inlines.some((i) => i.props && i.props.italic),
  },
  {
    id: "underline",
    label: "Underline",
    kind: "run",
    check: (block) => block.inlines.some((i) => i.props && i.props.underline),
  },
  {
    id: "strike",
    label: "Strikethrough",
    kind: "run",
    check: (block) => block.inlines.some((i) => i.props && i.props.strike),
  },
  {
    id: "center",
    label: "Centre",
    kind: "paragraph",
    prop: "alignment",
    value: "center",
  },
  {
    id: "right",
    label: "Align right",
    kind: "paragraph",
    prop: "alignment",
    value: "right",
  },
  {
    id: "justify",
    label: "Justify",
    kind: "paragraph",
    prop: "alignment",
    value: "justify",
  },
  { id: "bullets", label: "Bullets", kind: "list" },
  { id: "numbering", label: "Numbering", kind: "list" },
  { id: "clear", label: "Clear", kind: "clear" },
];

const SHAPES = [
  {
    id: "caret",
    apply: async (ids) => caretAt(ids[0], PARAGRAPHS[0].length),
    blocks: [0],
  },
  {
    id: "caret-mid",
    apply: async (ids) => caretAt(ids[1], 4),
    blocks: [1],
  },
  {
    id: "drag",
    apply: async (ids) => dragBlocks(ids[0], 0.2, ids[1], 0.6),
    blocks: [0, 1],
  },
  {
    id: "ctrl-a",
    apply: async () => press("Ctrl+KeyA"),
    blocks: [0, 1, 2],
  },
  {
    id: "triple-p2",
    apply: async (ids) => caretAt(ids[1], 0),
    blocks: [1],
  },
];

const VARIANTS = [0, 1, 2];

function buildCases() {
  const cases = [];
  for (const shape of SHAPES) {
    for (const format of FORMATS) {
      for (const variant of VARIANTS) {
        cases.push({
          id: `${shape.id}/${format.id}/${variant}`,
          shape,
          format,
          variant,
        });
      }
    }
  }
  return cases.slice(0, 150);
}

async function blocksWith(ids) {
  return paragraphProps();
}

async function runCase(item) {
  const { ids } = await prepare(PARAGRAPHS, { hijackKeys: [] });
  await item.shape.apply(ids);
  await sleep(60);
  const before = await totalOps();
  const stateBefore = await hostState();
  await clickTool(item.format.label);

  const expectedBlocks = item.shape.blocks.map((index) => ids[index]);
  if (item.format.kind === "run") {
    let touched = 0;
    for (
      let attempt = 0;
      attempt < 30 && touched < expectedBlocks.length;
      attempt += 1
    ) {
      const blocks = await blocksWith();
      touched = expectedBlocks.filter((id) => {
        const block = blocks.find((entry) => entry.id === id);
        return block && item.format.check(block);
      }).length;
      if (touched < expectedBlocks.length) await sleep(60);
    }
    assertEqual(
      touched,
      expectedBlocks.length,
      `${item.id}: ${item.format.id} reached ${touched}/${expectedBlocks.length} blocks`,
    );
  } else if (item.format.kind === "paragraph") {
    let touched = 0;
    for (
      let attempt = 0;
      attempt < 30 && touched < expectedBlocks.length;
      attempt += 1
    ) {
      const blocks = await blocksWith();
      touched = expectedBlocks.filter((id) => {
        const block = blocks.find((entry) => entry.id === id);
        return (
          block &&
          block.props &&
          block.props[item.format.prop] === item.format.value
        );
      }).length;
      if (touched < expectedBlocks.length) await sleep(60);
    }
    assertEqual(
      touched,
      expectedBlocks.length,
      `${item.id}: ${item.format.id} reached ${touched}/${expectedBlocks.length} blocks`,
    );
  } else if (item.format.kind === "list") {
    const ops = await waitForOp("insertList", before, 5000);
    assert(
      ops.some((entry) => entry.op === "insertList"),
      `${item.id}: no insertList op`,
    );
    const blocks = await blocksWith();
    const numbered = blocks.filter(
      (block) => block.props && block.props.numbering,
    );
    assert(
      numbered.length >= 1,
      `${item.id}: no numbered paragraph in the Host document`,
    );
  } else {
    // Clear: first make the paragraph bold, then clear it.
    await press("Ctrl+KeyB");
    await sleep(500);
    await clickTool("Clear");
    let cleared = false;
    for (let attempt = 0; attempt < 30 && !cleared; attempt += 1) {
      const blocks = await blocksWith();
      const block = blocks.find((entry) => entry.id === expectedBlocks[0]);
      cleared = Boolean(
        block &&
        !block.inlines.some(
          (inline) =>
            inline.props &&
            (inline.props.bold || inline.props.italic || inline.props.fontSize),
        ),
      );
      if (!cleared) await sleep(60);
    }
    assert(cleared, `${item.id}: Clear left direct formatting behind`);
  }

  const stateAfter = await hostState();
  assertEqual(
    stateAfter.text,
    stateBefore.text,
    `${item.id}: formatting changed the document text`,
  );
  const errors = await pageErrors();
  assertEqual(
    errors.length,
    0,
    `${item.id}: console errors ${JSON.stringify(errors)}`,
  );
  assertEqual(await errorText(), null, `${item.id}: error bar appeared`);
  await selectTab("Home").catch(() => {});
}

export const suite = {
  name: "formatting",
  build: buildCases,
  async run(item) {
    await runCase(item);
  },
};
