/**
 * Replay the typing-integrity "backspace" case list in order (same variants,
 * same remount per case) and dump, per Backspace press: DOM text, model
 * selection, and the posted op bodies. Reproduces the accumulated-state
 * behaviour the suite sees, which a single isolated case does not.
 */
import { evaluate } from "../cdp.mjs";

const BASE = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];
const TEXTS = ["abc", "hello world", "0123456789", "a b c d e f g h", "X"];
const DELAYS = [0, 7, 18];
const VARIANTS = [
  { after: "next", deletes: 3 },
  { after: "tail", deletes: 7 },
  { after: "x", deletes: 1 },
  { after: "unicode ✓", deletes: 5 },
  { after: "longer tail text", deletes: 2 },
];

function cases() {
  const list = [];
  for (const text of TEXTS) {
    for (const delay of DELAYS) {
      list.push({
        id: `backspace/${JSON.stringify(text)}/${delay}`,
        text,
        delay,
        variant: VARIANTS[list.length % VARIANTS.length],
      });
    }
  }
  return list;
}

function expectedFor(text, deletes) {
  const combined = BASE[0] + text;
  return [
    combined.slice(0, Math.max(0, combined.length - deletes)),
    BASE[1],
    BASE[2],
  ].join("\n");
}

export async function run({ client, cdp, kit }) {
  const trace = [];
  for (const item of cases()) {
    const { ids } = await kit.prepare(BASE, { hijackKeys: [], latency: 0 });
    await kit.caretAt(ids[0], BASE[0].length);
    await evaluate(client, "window.__NET__.length = 0, true");
    const perPress = [];
    for (const character of item.text) {
      await cdp.insertText(client, character);
      await new Promise((resolve) => setTimeout(resolve, item.delay));
    }
    perPress.push({
      press: -1,
      dom: await evaluate(client, "window.__E2E__.domText()"),
      sel: await evaluate(client, "window.__E2E__.selectionAttr()"),
    });
    for (let index = 0; index < item.variant.deletes; index += 1) {
      await kit.press("Backspace", { settleMs: 40 });
      perPress.push({
        press: index,
        dom: await evaluate(client, "window.__E2E__.domText()"),
        sel: await evaluate(client, "window.__E2E__.selectionAttr()"),
      });
    }
    let settled = null;
    try {
      settled = (await kit.settleText(8000)).text;
    } catch (error) {
      settled = `SETTLE-FAILED ${error.message}`;
    }
    const ops = await evaluate(
      client,
      `window.__NET__.filter((e) => /\\/(op|ops)$/.test(e.url)).map((e) => e.body)`,
    );
    trace.push({
      id: item.id,
      deletes: item.variant.deletes,
      expected: expectedFor(item.text, item.variant.deletes),
      suiteExpected: [
        BASE[0] +
          item.text.slice(
            0,
            Math.max(0, item.text.length - item.variant.deletes),
          ),
        BASE[1],
        BASE[2],
      ].join("\n"),
      host: settled,
      dom: await evaluate(client, "window.__E2E__.domText()"),
      perPress,
      ops,
    });
  }
  return trace;
}
