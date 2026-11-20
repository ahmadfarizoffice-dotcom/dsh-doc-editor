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
  seededCases,
} from "../kit.mjs";

const BASE = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];
const JOIN = (blocks) => blocks.join("\n");

/**
 * The keystroke used to force another flush pass. It must not appear in any
 * case text, otherwise the "typed text was not duplicated" count below would
 * count the retry itself as a duplicate (the old "x" collided with the "x"
 * case).
 */
const RETRY_KEY = "z";

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
  return seededCases(cases).slice(0, 150);
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
    extras += RETRY_KEY;
    await press(RETRY_KEY);
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
  // The invariant the panel guarantees after a failed op: once the error has
  // settled the rendered text and the authoritative Host text are the same.
  assertEqual(dom, settled.text, `${item.id}: DOM and Host diverged`);
  assertEqual(
    settled.text.split(item.text).length - 1,
    1,
    `${item.id}: typed text duplicated`,
  );
  const bar = await errorText();
  if (bar) assert(/CHAOS/.test(bar), `${item.id}: unexpected error bar ${bar}`);

  await setChaos({ enabled: false });
  await press(RETRY_KEY);
  extras += RETRY_KEY;
  const finalState = await settleText(8000);
  assertEqual(
    finalState.text,
    expected(item.text, extras),
    `${item.id}: text after recovery`,
  );
  const finalDom = await domText();
  assertEqual(
    finalDom,
    finalState.text,
    `${item.id}: DOM and Host diverged after the successful retry`,
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
