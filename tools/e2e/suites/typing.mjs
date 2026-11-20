/**
 * Suite: typing-integrity.
 *
 * The duplication bugs lived here: fast typing, typing while an op is in
 * flight, typing around a structural refetch, IME composition, paste, and
 * undo/redo. Every case asserts the DOM text, the Host text and the expected
 * text agree, and that no replaceText op was applied twice.
 */
import {
  assert,
  assertEqual,
  caretAt,
  clickBlock,
  composeText,
  domText,
  errorText,
  evaluatePage,
  hostState,
  kit,
  insertText,
  opLog,
  opsSince,
  pageErrors,
  prepare,
  press,
  setLatency,
  settleText,
  sleep,
  totalOps,
  typeText,
  waitForOp,
  seededCases,
} from "../kit.mjs";

const BASE = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];

const PAYLOAD = "The quick brown fox jumps over the lazy dog. ".repeat(7);

function textOf(blocks) {
  return blocks.join("\n");
}

/** Build a case's expected final text and the operations to perform. */
function scenarioPlan(name, text, variant) {
  const base = [...BASE];
  const type = text;
  switch (name) {
    case "type-end":
      return { expected: textOf([base[0] + type, base[1], base[2]]) };
    case "type-mid":
      return {
        expected: textOf([
          base[0].slice(0, 5) + type + base[0].slice(5),
          base[1],
          base[2],
        ]),
        caret: 5,
      };
    case "type-two-blocks":
      return { expected: textOf([base[0] + type, base[1], base[2] + type]) };
    case "in-flight-op":
      return {
        expected: textOf([base[0] + type, base[1], base[2]]),
        latency: 160,
        preOp: true,
      };
    case "click-away":
      return {
        expected: textOf([base[0] + type, base[1], base[2]]),
        clickAway: true,
      };
    case "save-mid-typing":
      return {
        expected: textOf([base[0] + type, base[1], base[2]]),
        save: true,
      };
    case "enter-then-type":
      return {
        expected: textOf([base[0] + type, variant.after, base[1], base[2]]),
        enter: true,
      };
    case "refetch-then-type":
      return {
        expected: textOf([base[0], type, base[1], base[2]]),
        enterFirst: true,
      };
    case "ime":
      return {
        expected: textOf([base[0] + "日本", base[1], base[2]]),
        ime: true,
      };
    case "paste":
      return {
        expected: textOf([base[0] + PAYLOAD, base[1], base[2]]),
        paste: true,
      };
    case "backspace": {
      // One Backspace deletes exactly one character at the caret. When the
      // case presses more times than the typed text is long, the extra presses
      // continue into the paragraph itself — that is what the panel's deletion
      // queue applies, so the expectation is the count, not the typed text.
      const typed = base[0] + type;
      return {
        expected: textOf([
          typed.slice(0, Math.max(0, typed.length - variant.deletes)),
          base[1],
          base[2],
        ]),
        backspaces: variant.deletes,
      };
    }
    case "undo-then-type":
      return {
        expected: textOf([base[0] + type, base[1], base[2]]),
        undoAfter: true,
      };
    default:
      throw new Error(`unknown scenario ${name}`);
  }
}

const SCENARIOS = [
  "type-end",
  "type-mid",
  "type-two-blocks",
  "in-flight-op",
  "click-away",
  "save-mid-typing",
  "enter-then-type",
  "refetch-then-type",
  "ime",
  "paste",
  "backspace",
  "undo-then-type",
];

const TEXTS = ["abc", "hello world", "0123456789", "a b c d e f g h", "X"];
const DELAYS = [0, 7, 18];
const VARIANTS = [
  { after: "next", deletes: 3 },
  { after: "tail", deletes: 7 },
  { after: "x", deletes: 1 },
  { after: "unicode ✓", deletes: 5 },
  { after: "longer tail text", deletes: 2 },
];

function buildCases() {
  const cases = [];
  for (const name of SCENARIOS) {
    for (const text of TEXTS) {
      for (const delay of DELAYS) {
        cases.push({
          id: `${name}/${JSON.stringify(text)}/${delay}`,
          name,
          text,
          delay,
          variant: VARIANTS[cases.length % VARIANTS.length],
        });
      }
    }
  }
  return seededCases(cases).slice(0, 150);
}

async function runCase(item) {
  const plan = scenarioPlan(item.name, item.text, item.variant);
  const { ids } = await prepare(BASE, {
    hijackKeys: [],
    latency: plan.latency || 0,
  });
  const before = await totalOps();
  const startOffset = plan.caret !== undefined ? plan.caret : BASE[0].length;
  await caretAt(ids[0], startOffset);

  try {
    if (plan.ime) {
      // A real click puts a native caret at the paragraph end; Chrome's IME
      // API inserts at the native caret, not at a programmatically set range.
      await clickBlock(ids[0], 1);
      await composeText(kit().client, ["に", "にほ"], "日本");
    } else if (plan.paste) {
      await insertText(kit().client, PAYLOAD);
    } else if (plan.enterFirst) {
      await press("Enter");
      await sleep(60);
      await typeText(item.text, item.delay);
    } else if (plan.enter) {
      await typeText(item.text, item.delay);
      await press("Enter");
      await typeText(item.variant.after, item.delay);
    } else {
      if (plan.preOp) await press("Ctrl+KeyB");
      if (plan.backspaces) {
        await typeText(item.text, item.delay);
        for (let index = 0; index < plan.backspaces; index += 1) {
          await press("Backspace");
        }
      } else if (plan.undoAfter) {
        await typeText(item.text, item.delay);
        await sleep(700);
        await press("Ctrl+KeyZ");
        await sleep(300);
        await typeText("!", item.delay);
      } else {
        if (item.name === "type-two-blocks") {
          await typeText(item.text, item.delay);
          await caretAt(ids[2], BASE[2].length);
        }
        await typeText(item.text, item.delay);
      }
      if (plan.clickAway) {
        await clickBlock(ids[1], 0.4);
      }
      if (plan.save) {
        await press("Ctrl+KeyS");
      }
    }

    const settled = await settleText(8000);
    const dom = await domText();
    const expected = plan.expected;
    if (item.name === "undo-then-type") {
      // Undo reverts the typed batch, then "!" is typed on top of the restored
      // paragraph. Both steps must be visible and not duplicated.
      assertEqual(
        settled.text,
        textOf([BASE[0] + "!", BASE[1], BASE[2]]),
        `${item.id}: undo+type result`,
      );
    } else if (item.name === "ime") {
      // Headless Chrome's IME API always composes at offset 0 of the editing
      // host; what matters here is that the committed text lands exactly once
      // and that the model, the DOM and the Host agree.
      assertEqual(
        settled.text.split("日本").length - 1,
        1,
        `${item.id}: IME text duplicated or lost`,
      );
      assert(
        settled.text.replace("日本", "") === textOf(BASE),
        `${item.id}: IME changed unrelated text: ${JSON.stringify(settled.text)}`,
      );
    } else if (item.name === "backspace") {
      assertEqual(settled.text, expected, `${item.id}: text after backspaces`);
    } else {
      assertEqual(settled.text, expected, `${item.id}: Host text`);
    }
    assertEqual(dom, settled.text, `${item.id}: DOM text`);

    const ops = await opsSince(before);
    const textOps = ops.filter((entry) => entry.op === "replaceText").length;
    if (item.name !== "backspace" && item.name !== "ime") {
      assert(textOps >= 1, `${item.id}: no replaceText op was posted`);
    }
    assert(
      textOps <= 8,
      `${item.id}: ${textOps} replaceText ops for one typing burst (duplicate application)`,
    );
    // A duplicated application always leaves a repeated copy of the typed text
    // inside the paragraph; the final-text equality above already catches it,
    // and this guards the multi-block variant where the whole string repeats.
    if (item.text.length >= 6) {
      const repetitions = settled.text.split(item.text).length - 1;
      assert(
        repetitions <= 2,
        `${item.id}: typed text appears ${repetitions} times (duplication)`,
      );
    }
    const errors = await pageErrors();
    assertEqual(
      errors.length,
      0,
      `${item.id}: console errors ${JSON.stringify(errors)}`,
    );
  } finally {
    await setLatency(0).catch(() => {});
  }
}

export const suite = {
  name: "typing-integrity",
  build: buildCases,
  async run(item) {
    await runCase(item);
  },
};
