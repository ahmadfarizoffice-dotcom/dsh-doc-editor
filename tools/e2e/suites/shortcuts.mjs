/**
 * Suite: shortcuts.
 *
 * Every case drives a real key event through CDP (or a synthetic KeyboardEvent
 * for conditions real input cannot express: IME composition, a modal outside
 * the panel owning focus) and asserts either that the command ran or that the
 * panel deliberately ignored it.
 *
 * The harness installs a DSH-shaped bubble dispatcher that consumes the combos
 * it knows, so a "handled" result also proves the window capture listener ran
 * first.
 */
import {
  assert,
  assertEqual,
  caretAt,
  clickBlock,
  dispatchSyntheticKey,
  dragBlocks,
  evaluatePage,
  focusSelector,
  hijackCount,
  opLog,
  opsSince,
  pageErrors,
  paragraphProps,
  prepare,
  press,
  selectionBlocks,
  setHijack,
  shortcutDiagnostics,
  sleep,
  totalOps,
  waitForNet,
  waitForOp,
  waitForPage,
} from "../kit.mjs";

const PARAGRAPHS = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];

/** The panel's shortcut table as the live panel exposes it. */
export const COMMANDS = [
  { id: "bold", combo: "Ctrl+KeyB", kind: "op", op: "formatText" },
  // Fallback chord: always reaches the panel, even when the host reserves
  // Ctrl+B for the sidebar (Desktop Windows/macOS).
  { id: "boldShift", combo: "Ctrl+Shift+KeyB", kind: "op", op: "formatText" },
  { id: "italic", combo: "Ctrl+KeyI", kind: "op", op: "formatText" },
  { id: "underline", combo: "Ctrl+KeyU", kind: "op", op: "formatText" },
  { id: "undo", combo: "Ctrl+KeyZ", kind: "op", op: "undo" },
  { id: "redo", combo: "Ctrl+KeyY", kind: "op", op: "redo" },
  // Ctrl+Shift+Z and Ctrl+Shift+7/8 are dispatched synthetically: headless
  // Chrome treats them as browser/OS-level history and list accelerators, and
  // a CDP-generated Ctrl+Shift+Z hangs its renderer. Synthetic KeyboardEvents
  // still travel through window capture, which is the path under test.
  {
    id: "redoShift",
    combo: "Ctrl+Shift+KeyZ",
    kind: "op",
    op: "redo",
    synthetic: true,
  },
  { id: "save", combo: "Ctrl+KeyS", kind: "net", net: "/save" },
  {
    id: "find",
    combo: "Ctrl+KeyF",
    kind: "dialog",
    dialog: "Find and replace",
  },
  { id: "selectAll", combo: "Ctrl+KeyA", kind: "select-all" },
  { id: "open", combo: "Ctrl+KeyO", kind: "dialog", dialog: "Open a document" },
  {
    id: "link",
    combo: "Ctrl+KeyK",
    kind: "dialog",
    dialog: "Insert hyperlink",
  },
  {
    id: "numberedList",
    combo: "Ctrl+Shift+Digit7",
    kind: "op",
    op: "insertList",
    synthetic: true,
  },
  {
    id: "bulletList",
    combo: "Ctrl+Shift+Digit8",
    kind: "op",
    op: "insertList",
    synthetic: true,
  },
];

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

/** Combos the panel does not own: they must never be consumed. */
const FOREIGN = [
  "Ctrl+KeyC",
  "Ctrl+KeyV",
  "Ctrl+KeyX",
  "Ctrl+KeyQ",
  "Alt+KeyB",
  "Ctrl+KeyR",
];

const PANEL_SCOPE = new Set(["save", "find", "open"]);
const EDITABLE_COMMANDS = COMMANDS.filter(
  (command) => !PANEL_SCOPE.has(command.id),
);

const STATES = [
  "editable",
  "editable-selection",
  "panel",
  "dialog-input",
  "outside",
  "modal-outside",
  "composing",
];

function buildCases() {
  const cases = [];
  for (const command of COMMANDS) {
    for (const state of STATES) {
      cases.push({ id: `${command.id}/${state}`, command, state });
    }
  }
  for (const combo of FOREIGN) {
    for (const state of ["editable", "panel", "outside"]) {
      cases.push({
        id: `foreign/${combo}/${state}`,
        command: { combo, foreign: true },
        state,
        foreign: true,
      });
    }
  }
  for (const id of ["bold", "italic", "undo", "redo"]) {
    for (const state of ["editable", "editable-selection"]) {
      cases.push({
        id: `repeat/${id}/${state}`,
        command: BY_ID.get(id),
        state,
        repeat: true,
      });
    }
  }
  for (const command of COMMANDS) {
    cases.push({
      id: `hijack-all/${command.id}`,
      command,
      state: "editable",
      hijackAll: true,
    });
  }
  for (const command of COMMANDS.slice(0, 8)) {
    cases.push({
      id: `selection/${command.id}`,
      command,
      state: "editable-selection",
      hijackAll: true,
    });
  }
  for (const command of EDITABLE_COMMANDS) {
    cases.push({
      id: `readonly/${command.id}`,
      command,
      state: "readonly",
    });
  }
  // Two more cases so the suite is exactly 150: foreign combos while a
  // multi-block selection exists (they must stay native).
  for (const combo of ["Ctrl+KeyC", "Ctrl+KeyX"]) {
    cases.push({
      id: `foreign-selection/${combo}`,
      command: { combo, foreign: true },
      state: "editable-selection",
      foreign: true,
    });
  }
  return cases.slice(0, 150);
}

/* --------------------------------------------------------------- setup */

async function focusExternalButton() {
  await evaluatePage(`(() => {
    document.querySelectorAll('[data-e2e-external]').forEach((node) => node.remove());
    const button = document.createElement('button');
    button.id = 'e2e-outside';
    button.dataset.e2eExternal = '1';
    button.textContent = 'outside';
    document.body.appendChild(button);
    button.focus();
    return true;
  })()`);
  await sleep(20);
}

async function focusOutsideModal() {
  await evaluatePage(`(() => {
    document.querySelectorAll('[data-e2e-external]').forEach((node) => node.remove());
    const modal = document.createElement('div');
    modal.dataset.e2eExternal = '1';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const button = document.createElement('button');
    button.textContent = 'modal';
    modal.appendChild(button);
    document.body.appendChild(modal);
    button.focus();
    return true;
  })()`);
  await sleep(20);
}

async function openFindDialog() {
  await press("Ctrl+KeyF");
  await waitForPage("Boolean(document.querySelector('.dx-dialog input'))", {
    timeoutMs: 5000,
    label: "find dialog",
  });
  await focusSelector(".dx-dialog input");
}

async function enterReadOnly() {
  await evaluatePage(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(
      (item) => item.textContent.trim() === 'View',
    );
    if (tab) tab.click();
    return Boolean(tab);
  })()`);
  await sleep(120);
  const clicked = await evaluatePage(`(() => {
    const button = document.querySelector('[aria-label="Read only"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, "View tab has no Read only control");
  await waitForPage(
    "Boolean(document.querySelector('.dx-para[contenteditable=\"false\"]'))",
    { timeoutMs: 5000, label: "read-only surface" },
  );
}

async function setupState(state, ids) {
  switch (state) {
    case "editable":
      await caretAt(ids[0], 4);
      return;
    case "editable-selection":
      await dragBlocks(ids[0], 0.2, ids[1], 0.6);
      return;
    case "panel":
      await focusSelector("#dx-tab-home");
      return;
    case "dialog-input":
      await openFindDialog();
      return;
    case "outside":
      await focusExternalButton();
      return;
    case "modal-outside":
      await focusOutsideModal();
      return;
    case "composing":
      await caretAt(ids[0], 4);
      return;
    case "readonly":
      await enterReadOnly();
      await clickBlock(ids[0], 0.5);
      return;
    default:
      throw new Error(`unknown state ${state}`);
  }
}

/** Everything that changes the panel, undone before the next case. */
async function cleanup() {
  await setHijack(["KeyB"]);
  await evaluatePage(`(() => {
    document.querySelectorAll('[data-e2e-external]').forEach((node) => node.remove());
    const cancel = document.querySelector('.dx-dialog-actions .dx-btn');
    if (cancel) cancel.click();
    return true;
  })()`);
  await evaluatePage("window.__E2E__.remount(), true");
}

function expectedHandled(command, state) {
  if (command.foreign) return false;
  if (state === "outside" || state === "modal-outside" || state === "composing")
    return false;
  if (state === "dialog-input" || state === "readonly") return false;
  if (state === "panel") return PANEL_SCOPE.has(command.id);
  return true;
}

async function dialogTitle() {
  return evaluatePage("window.__E2E__.dialogKind()");
}

async function runCase(item) {
  const command = item.command;
  const { ids } = await prepare(PARAGRAPHS, {
    hijackKeys: item.hijackAll
      ? COMMANDS.map((entry) => entry.combo.split("+").pop())
      : ["KeyB"],
  });
  await setupState(item.state, ids);
  const before = await totalOps();
  const hijackBefore = await hijackCount();
  const errorsBefore = (await pageErrors()).length;
  if (
    command.synthetic ||
    item.state === "modal-outside" ||
    item.state === "composing"
  ) {
    await dispatchSyntheticKey(command.combo, {
      blockId: ids[0],
      useActive: item.state !== "modal-outside" && item.state !== "composing",
      isComposing: item.state === "composing",
    });
  } else {
    await press(command.combo);
  }

  if (!expectedHandled(command, item.state)) {
    await sleep(260);
    const extra = await opsSince(before);
    assertEqual(
      extra.length,
      0,
      `${item.id}: ignored command posted ${JSON.stringify(extra.map((entry) => entry.op))}`,
    );
    const expectedDialog =
      item.state === "dialog-input" ? "Find and replace" : null;
    assertEqual(
      await dialogTitle(),
      expectedDialog,
      `${item.id}: ignored command changed the dialog`,
    );
    const diagnostics = await shortcutDiagnostics();
    assert(diagnostics && diagnostics.bound, "capture listener is not bound");
    return;
  }

  if (command.kind === "op") {
    const ops = await waitForOp(command.op, before, 4000);
    assert(
      ops.some((entry) => entry.op === command.op),
      `${item.id}: no ${command.op} op (saw ${JSON.stringify(ops.map((entry) => entry.op))})`,
    );
    if (item.repeat) {
      // A real auto-repeat is a keydown with repeat=true; CDP's isAutoRepeat
      // does not set the DOM property, so dispatch the DOM event directly.
      // Target the document, not document.activeElement: after an undo the
      // focused element can be replaced, and the repeat belongs to the editor.
      await dispatchSyntheticKey(command.combo, {
        blockId: ids[0],
        repeat: true,
      });
      await sleep(650);
      const after = await opsSince(before);
      const count = after.filter((entry) => entry.op === command.op).length;
      const allowed = command.id === "undo" || command.id === "redo";
      const selectedCount =
        (await selectionBlocks()).split(",").filter(Boolean).length || 1;
      const perPress = command.op === "formatText" ? selectedCount : 1;
      assertEqual(
        count,
        allowed ? perPress * 2 : perPress,
        `${item.id}: repeat ${allowed ? "should run" : "must be ignored"} (${count} ops)`,
      );
    }
    if (item.state === "editable-selection" && command.op === "formatText") {
      // The drag ends inside the second paragraph, so that block always has a
      // non-empty range. Bold on it proves the cross-paragraph path ran.
      const selectedBlocks = (await selectionBlocks())
        .split(",")
        .filter(Boolean);
      const lastBlockId = selectedBlocks[selectedBlocks.length - 1];
      let lastBold = false;
      for (let attempt = 0; attempt < 25 && !lastBold; attempt += 1) {
        const blocks = await paragraphProps();
        const block = blocks.find((entry) => entry.id === lastBlockId);
        lastBold = Boolean(
          block &&
          (block.inlines || []).some(
            (inline) =>
              inline.props &&
              (inline.props.bold ||
                inline.props.italic ||
                inline.props.underline),
          ),
        );
        if (!lastBold) await sleep(60);
      }
      assert(
        lastBold,
        `${item.id}: the last selected block (${lastBlockId}) was not formatted`,
      );
    }
  } else if (command.kind === "dialog") {
    await waitForPage(
      `window.__E2E__.dialogKind() === ${JSON.stringify(command.dialog)}`,
      { timeoutMs: 5000, label: `${item.id} dialog` },
    );
  } else if (command.kind === "net") {
    const entries = await waitForNet(command.net, 5000);
    assert(entries.length > 0, `${item.id}: no ${command.net} request`);
  } else if (command.kind === "select-all") {
    let blocks = "";
    let attr = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      blocks = await selectionBlocks();
      attr = await evaluatePage("window.__E2E__.selectionAttr()");
      if (blocks === ids.join(",")) break;
      await sleep(80);
    }
    assertEqual(
      blocks,
      ids.join(","),
      `${item.id}: whole-document selection (attr=${attr}, blocks=${blocks}, expected=${ids.join(",")}, diag=${JSON.stringify((({ events, matched, ignored, executed, lastCommand, lastExec }) => ({ events, matched, ignored, executed, lastCommand, lastExec }))(await shortcutDiagnostics()))} history=${JSON.stringify(await evaluatePage("(window.__SEL_HISTORY__ || []).slice(-8)"))} active=${JSON.stringify(await evaluatePage("document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName)"))})`,
    );
  }

  const hijacked = (await hijackCount()) - hijackBefore;
  // An ignored auto-repeat is allowed to fall through to the host dispatcher;
  // a handled press must not.
  const repeatIsIgnored =
    item.repeat && !["undo", "redo", "redoShift"].includes(command.id);
  if (!repeatIsIgnored)
    assertEqual(
      hijacked,
      0,
      `${item.id}: DSH-shaped dispatcher consumed the shortcut`,
    );
  const errors = await pageErrors();
  assertEqual(
    errors.length,
    errorsBefore,
    `${item.id}: console errors ${JSON.stringify(errors.slice(errorsBefore))}`,
  );
}

export const suite = {
  name: "shortcuts",
  build: buildCases,
  async run(item) {
    try {
      await runCase(item);
    } finally {
      await cleanup().catch(() => {});
    }
  },
};
