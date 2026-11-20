/**
 * Suite: differential.
 *
 * For each generated op script, run it (a) through the panel UI and (b) through
 * the Host API on the same document. The final text, block count and paragraph
 * statistics must agree; a divergence is reported with the script.
 */
import {
  assertEqual,
  caretAt,
  clickTool,
  domText,
  hostState,
  paragraphProps,
  prepare,
  press,
  selectTab,
  settleText,
  sleep,
  typeText,
  kit,
} from "../kit.mjs";

const BASE = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];

/** Primitive scripts, each a list of UI steps plus the equivalent Host ops. */
const PRIMITIVES = {
  typeEnd: {
    ui: async (ids, text) => {
      await caretAt(ids[0], BASE[0].length);
      await typeText(text, 0);
    },
    host: (ids, text) => ({
      op: "insertText",
      args: { position: { blockId: ids[0], offset: BASE[0].length }, text },
    }),
  },
  typeMid: {
    ui: async (ids, text) => {
      await caretAt(ids[1], 4);
      await typeText(text, 0);
    },
    host: (ids, text) => ({
      op: "insertText",
      args: { position: { blockId: ids[1], offset: 4 }, text },
    }),
  },
  enterEnd: {
    ui: async (ids) => {
      await caretAt(ids[0], BASE[0].length);
      await press("Enter");
    },
    host: (ids) => ({
      op: "insertText",
      args: {
        position: { blockId: ids[0], offset: BASE[0].length },
        text: "\n",
      },
    }),
  },
  bold: {
    ui: async (ids) => {
      await caretAt(ids[0], 3);
      await press("Ctrl+KeyB");
    },
    host: (ids) => ({
      op: "formatText",
      args: {
        range: {
          start: { blockId: ids[0], offset: 0 },
          end: { blockId: ids[0], offset: BASE[0].length },
        },
        props: { bold: true },
        clear: false,
      },
    }),
  },
  center: {
    ui: async (ids) => {
      await caretAt(ids[1], 2);
      await clickTool("Centre");
    },
    host: (ids) => ({
      op: "formatParagraph",
      args: { blockIds: [ids[0], ids[1]], props: { alignment: "center" } },
    }),
  },
};

function scriptFor(index) {
  const primitives = Object.keys(PRIMITIVES);
  const length = 2 + (index % 3);
  const script = [];
  for (let step = 0; step < length; step += 1) {
    const name = primitives[(index + step * 3) % primitives.length];
    script.push({
      primitive: name,
      text:
        name === "typeEnd" || name === "typeMid" ? `t${index}${step}` : null,
    });
  }
  return script;
}

function buildCases() {
  const cases = [];
  for (let index = 0; index < 150; index += 1) {
    cases.push({ id: `script/${index}`, script: scriptFor(index) });
  }
  return cases;
}

async function runUi(script) {
  const { ids } = await prepare(BASE, { hijackKeys: [] });
  for (const step of script) {
    await PRIMITIVES[step.primitive].ui(ids, step.text);
    await sleep(220);
  }
  await settleText(9000);
  const state = await hostState();
  return {
    text: state.text,
    blockCount: state.blocks.length,
    stats: state.stats,
    dom: await domText(),
  };
}

async function runHost(script) {
  const { ids } = await prepare(BASE, { hijackKeys: [] });
  const { base } = kit();
  const ops = script.map((step) =>
    PRIMITIVES[step.primitive].host(ids, step.text),
  );
  // Apply through the Host API one op at a time, like the panel does.
  for (const op of ops) {
    const response = await fetch(`${base}/api/dsh-documents/op`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dsh-documents": "1" },
      body: JSON.stringify({
        id: (await hostState()).documentId,
        op: op.op,
        args: op.args,
      }),
    });
    const json = await response.json();
    if (!json || json.ok === false)
      throw new Error(
        `Host op ${op.op} failed: ${JSON.stringify(json).slice(0, 300)}`,
      );
  }
  const state = await hostState();
  return {
    text: state.text,
    blockCount: state.blocks.length,
    stats: state.stats,
  };
}

async function runCase(item) {
  const ui = await runUi(item.script);
  const host = await runHost(item.script);
  const details = `script=${JSON.stringify(item.script)} ui=${JSON.stringify({ text: ui.text, blocks: ui.blockCount, stats: ui.stats })} host=${JSON.stringify({ text: host.text, blocks: host.blockCount, stats: host.stats })}`;
  assertEqual(
    ui.text,
    host.text,
    `${item.id}: final text diverged (${details})`,
  );
  assertEqual(
    ui.blockCount,
    host.blockCount,
    `${item.id}: block count diverged (${details})`,
  );
  for (const key of ["words", "paragraphs", "characters"]) {
    if (ui.stats && host.stats && ui.stats[key] !== undefined) {
      assertEqual(
        ui.stats[key],
        host.stats[key],
        `${item.id}: stats.${key} diverged (${details})`,
      );
    }
  }
  assertEqual(ui.dom, ui.text, `${item.id}: UI DOM and Host text diverged`);
}

export const suite = {
  name: "differential",
  build: buildCases,
  async run(item) {
    await runCase(item);
  },
};
