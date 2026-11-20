/**
 * Suite: hostile-input.
 *
 * Unicode fringe cases, control characters, NUL, RTL, combining marks, emoji and
 * very large pastes. The Host must keep the text it can represent, the panel
 * must stay responsive, and DOM and Host must agree.
 */
import {
  assert,
  assertEqual,
  caretAt,
  domText,
  errorText,
  evaluatePage,
  hostState,
  pageErrors,
  prepare,
  press,
  settleText,
  sleep,
  typeText,
  seededCases,
} from "../kit.mjs";

const BASE = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];

const PAYLOADS = [
  "plain text",
  "emoji 😀😃😄🎉",
  "rtl שלום עולם مرحبا",
  "combining éééé (e\u0301e\u0301e\u0301)",
  "control \u0001\u0002\u0003\u0007",
  "nul \u0000 inside",
  "cjk 日本語のテキスト",
  "greek αβγδε",
  "math ∑∫√∞",
  "tab\tand\tspaces  ",
  "quote \"'`<>",
  "long " + "x".repeat(9000),
  "mixed 😀שלום日本" + "\u0001".repeat(30),
  "zwj 👨‍👩‍👧‍👦 and flags 🇯🇵",
  "mixed scripts 한글 العربية 123",
];

const METHODS = [
  { id: "insert", run: async (text) => typeText(text, 0) },
  { id: "paste", run: async (text) => typeText(text, 0) },
];

const VARIANTS = [0, 1, 2, 3, 4];

function buildCases() {
  const cases = [];
  for (const payload of PAYLOADS) {
    for (const method of METHODS) {
      for (const variant of VARIANTS) {
        if (cases.length >= 150) break;
        cases.push({
          id: `${method.id}/${cases.length}`,
          payload,
          method,
          variant,
        });
      }
    }
  }
  return seededCases(cases).slice(0, 150);
}

function expectedText(payload, variant) {
  // The Host preserves U+0000 in its text runs, so NUL round-trips.
  const clean = payload;
  if (variant === 2)
    return [
      BASE[0].slice(0, 5) + clean + BASE[0].slice(5),
      BASE[1],
      BASE[2],
    ].join("\n");
  return [BASE[0] + clean, BASE[1], BASE[2]].join("\n");
}

async function runCase(item) {
  const { ids } = await prepare(BASE, { hijackKeys: [] });
  await caretAt(ids[0], BASE[0].length);
  if (item.variant === 2) {
    // Insert in the middle instead of the end.
    await caretAt(ids[0], 5);
  }
  await item.method.run(item.payload);
  const settled = await settleText(12000);
  const expected = expectedText(item.payload, item.variant);
  assertEqual(settled.text, expected, `${item.id}: Host text`);
  const dom = await domText();
  assertEqual(dom, settled.text, `${item.id}: DOM text`);
  // The page must still be responsive and able to evaluate state.
  const alive = await evaluatePage(
    "Boolean(window.__DSH_PANEL__ && document.querySelector('.dx-editor'))",
  );
  assert(alive, `${item.id}: the panel stopped rendering`);
  const errors = await pageErrors();
  assertEqual(
    errors.length,
    0,
    `${item.id}: console errors ${JSON.stringify(errors)}`,
  );
  const bar = await errorText();
  assertEqual(bar, null, `${item.id}: error bar ${bar}`);
  await sleep(20);
}

export const suite = {
  name: "hostile-input",
  build: buildCases,
  async run(item) {
    await runCase(item);
  },
};
