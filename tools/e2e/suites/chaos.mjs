/**
 * Suite: chaos.
 *
 * The harness fails ~10–20% of `/op`, `/ops` and `/bootstrap` calls, half of
 * them after the Host already applied the op (response lost). The panel must not
 * corrupt or duplicate text, must surface an error with the injected code, and
 * must converge once a request succeeds.
 */
import {
  assert,
  assertEqual,
  caretAt,
  domText,
  errorText,
  hostState,
  pageErrors,
  prepare,
  press,
  setChaos,
  settleText,
  sleep,
  typeText,
} from "../kit.mjs";

const BASE = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];
const JOIN = (blocks) => blocks.join("\n");

const TEXTS = [
  "abc",
  "hello chaos",
  "0123456789",
  "a longer burst of words",
  "x",
  "mixed ✓ text",
  "twelve chars",
  "another burst",
  "payload",
  "final",
];

function buildCases() {
  const cases = [];
  for (let index = 0; index < 150; index += 1) {
    const text = TEXTS[index % TEXTS.length];
    cases.push({
      id: `chaos/${index}/${text}`,
      text,
      seed: 1 + (index % 17),
      rate: index % 3 === 0 ? 0.2 : 0.1,
    });
  }
  return cases;
}

function expected(text, extras) {
  return JOIN([BASE[0] + text + extras, BASE[1], BASE[2]]);
}

async function runCase(item) {
  const { ids } = await prepare(BASE, { hijackKeys: [] });
  await setChaos({
    enabled: true,
    rate: item.rate,
    seed: item.seed,
    postShare: 0.5,
  });
  await caretAt(ids[0], BASE[0].length);
  await typeText(item.text, 0);

  let extras = "";
  let settled = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      settled = await settleText(2200);
    } catch (_error) {
      settled = await hostState();
    }
    if (settled.text === expected(item.text, extras)) break;
    // Another keystroke gives the panel a fresh flush pass; the character is
    // part of the expectation, never a silent repair.
    extras += "x";
    await press("x");
    await sleep(250);
  }
  const want = expected(item.text, extras);
  // The final settle may need one more round after the last keystroke.
  try {
    settled = await settleText(6000);
  } catch (_error) {
    settled = await hostState();
  }
  assertEqual(settled.text, want, `${item.id}: Host text after chaos`);
  const dom = await domText();
  assertEqual(dom, settled.text, `${item.id}: DOM and Host diverged`);
  assertEqual(
    settled.text.split(item.text).length - 1,
    1,
    `${item.id}: typed text duplicated`,
  );
  const bar = await errorText();
  if (bar) assert(/CHAOS/.test(bar), `${item.id}: unexpected error bar ${bar}`);

  await setChaos({ enabled: false });
  await press("x");
  extras += "x";
  const finalState = await settleText(8000);
  assertEqual(
    finalState.text,
    expected(item.text, extras),
    `${item.id}: text after recovery`,
  );
  const errors = await pageErrors();
  assertEqual(
    errors.length,
    0,
    `${item.id}: console errors ${JSON.stringify(errors)}`,
  );
}

export const suite = {
  name: "chaos",
  build: buildCases,
  async run(item) {
    try {
      await runCase(item);
    } finally {
      await setChaos({ enabled: false }).catch(() => {});
    }
  },
};
