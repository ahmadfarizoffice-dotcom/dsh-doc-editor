/**
 * Reproduce the in-flight typing scenario: 160 ms API latency and a character
 * every 18 ms. Samples the DOM text and the model selection after every
 * character so a caret jump (text inserted at the wrong offset) is visible.
 */
import { evaluate } from "../cdp.mjs";

const BASE = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];

export async function run({ client, cdp, kit }) {
  const text = process.env.PROBE_TEXT ?? "hello world";
  const delay = Number(process.env.PROBE_DELAY ?? "18");
  const rounds = Number(process.env.PROBE_ROUNDS ?? "3");
  const observations = [];
  for (let round = 0; round < rounds; round += 1) {
    const { ids } = await kit.prepare(BASE, { hijackKeys: [], latency: 160 });
    await evaluate(client, "window.__NET__.length = 0, true");
    await kit.caretAt(ids[0], BASE[0].length);
    await kit.press("Ctrl+KeyB");
    const trace = [];
    for (const character of text) {
      await cdp.insertText(client, character);
      await new Promise((resolve) => setTimeout(resolve, delay));
      trace.push({
        at: character,
        dom: (await evaluate(client, "window.__E2E__.domText()")).split(
          "\n",
        )[0],
        sel: await evaluate(client, "window.__E2E__.selectionAttr()"),
      });
    }
    let host = null;
    try {
      host = (await kit.settleText(8000)).text.split("\n")[0];
    } catch (error) {
      host = `SETTLE-FAILED ${error.message}`;
    }
    const dom = (await evaluate(client, "window.__E2E__.domText()")).split(
      "\n",
    )[0];
    const ops = await evaluate(
      client,
      `(window.__NET__ || []).filter((e) => /\\/(op|ops)$/.test(e.url)).map((e) => e.body)`,
    );
    observations.push({
      round,
      expected: BASE[0] + text,
      host,
      dom,
      ok: host === BASE[0] + text && dom === host,
      trace,
      ops,
    });
    await kit.setLatency(0).catch(() => {});
  }
  return {
    text,
    delay,
    failures: observations.filter((entry) => !entry.ok).length,
    first: observations.find((entry) => !entry.ok) ?? null,
  };
}
