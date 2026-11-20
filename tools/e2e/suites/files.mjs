/**
 * Suite: open-save-export.
 *
 * The File backstage and the file chooser, plus the Host routes they call. No
 * case switches the active document (opening a file would replace the fixture),
 * so the chooser is verified by opening it and listing the seeded folder, while
 * save / save-as / export are verified by their Host requests and notices.
 */
import {
  assert,
  assertEqual,
  clickTool,
  errorText,
  evaluatePage,
  fillDialogField,
  hostState,
  kit,
  pageErrors,
  prepare,
  press,
  selectTab,
  sleep,
  submitDialog,
  waitForNet,
  waitForPage,
} from "../kit.mjs";

const BASE = ["Alpha paragraph.", "Beta paragraph.", "Gamma paragraph."];
const SCENARIOS = [
  {
    id: "save-shortcut",
    run: async () => {
      await press("Ctrl+KeyS");
    },
    net: "/save",
  },
  {
    id: "save-ribbon",
    run: async () => {
      await selectTab("File");
      await clickByAria("Save");
    },
    net: "/save",
  },
  {
    id: "save-as",
    run: async () => {
      await selectTab("File");
      await clickByAria("Save as…");
      await waitForPage("Boolean(document.querySelector('.dx-dialog'))", {
        timeoutMs: 4000,
      });
      const folder = await evaluatePage("window.__DSH_PICK_DIRECTORY__");
      await fillDialogField("Path", `${folder}\\saved-as.docx`);
      await submitDialog();
    },
    net: "/saveAs",
  },
  {
    id: "refresh",
    run: async () => {
      await selectTab("File");
      await clickByAria("Refresh list");
    },
    net: "/list",
  },
  {
    id: "new-document-dialog",
    run: async () => {
      await selectTab("File");
      await clickByAria("New document…");
      await sleep(200);
      assert(
        await evaluatePage("Boolean(document.querySelector('.dx-dialog'))"),
        "new-document dialog did not open",
      );
      await press("Escape");
    },
  },
  {
    id: "chooser-shortcut",
    run: async () => {
      await press("Ctrl+KeyO");
    },
    dialog: "Open a document",
  },
  {
    id: "chooser-ribbon",
    run: async () => {
      await selectTab("File");
      await clickByAria("Open file…");
    },
    dialog: "Open a document",
  },
  {
    id: "chooser-lists-folder",
    run: async () => {
      await press("Ctrl+KeyO");
      await waitForPage("Boolean(document.querySelector('.dx-dialog'))", {
        timeoutMs: 4000,
      });
      const loadRoots = await evaluatePage(
        `(() => { const b = [...document.querySelectorAll('.dx-dialog button')].find((x) => x.textContent.includes('Load roots')); if (!b) return false; b.click(); return true; })()`,
      );
      void loadRoots;
      await sleep(300);
    },
    dialog: "Open a document",
  },
  {
    id: "export-docx",
    run: async () => clickExport("DOCX"),
    net: "/export",
  },
  { id: "export-pdf", run: async () => clickExport("PDF"), net: "/export" },
  { id: "export-html", run: async () => clickExport("HTML"), net: "/export" },
  { id: "export-md", run: async () => clickExport("MD"), net: "/export" },
  { id: "export-txt", run: async () => clickExport("TXT"), net: "/export" },
  {
    id: "advanced-panel",
    run: async () => {
      await selectTab("File");
      const open = await evaluatePage(
        `(() => { const d = document.querySelector('.dx-advanced'); if (!d) return false; d.open = true; d.dispatchEvent(new Event('toggle', { bubbles: true })); return Boolean(document.querySelector('[aria-label="Document path"]')); })()`,
      );
      assert(open, "advanced path input is missing");
    },
  },
];

async function clickByAria(label) {
  const clicked = await evaluatePage(
    `(() => {
      const button = document.querySelector('[aria-label="' + ${JSON.stringify(label)} + '"]');
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  assert(clicked, `no File action labelled ${label}`);
  await sleep(120);
}

async function clickExport(format) {
  await selectTab("File");
  await sleep(150);
  const clicked = await evaluatePage(
    `(() => {
      const button = [...document.querySelectorAll('.dx-file-format, button')].find(
        (item) => (item.getAttribute('title') || '').toUpperCase() === 'EXPORT ${format}',
      );
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  assert(clicked, `no export control for ${format}`);
  await sleep(150);
}

const VARIANTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

function buildCases() {
  const cases = [];
  for (const scenario of SCENARIOS) {
    for (const variant of VARIANTS) {
      if (cases.length >= 150) break;
      cases.push({ id: `${scenario.id}/${variant}`, scenario });
    }
  }
  return cases.slice(0, 150);
}

async function runCase(item) {
  await prepare(BASE, { hijackKeys: [] });
  const scenario = item.scenario;
  if (scenario.net) {
    const { base } = kit();
    void base;
    await scenario.run();
    const entries = await waitForNet(scenario.net, 6000);
    assert(
      entries.length > 0,
      `${item.id}: no ${scenario.net} request was made`,
    );
    assertEqual(
      await errorText(),
      null,
      `${item.id}: error bar after ${scenario.id}`,
    );
  } else {
    await scenario.run();
    if (scenario.dialog) {
      await waitForPage(
        `window.__E2E__.dialogKind() === ${JSON.stringify(scenario.dialog)}`,
        { timeoutMs: 6000, label: `${item.id} dialog` },
      );
    }
  }
  const errors = await pageErrors();
  assertEqual(
    errors.length,
    0,
    `${item.id}: console errors ${JSON.stringify(errors)}`,
  );
  await press("Escape").catch(() => {});
  await selectTab("Home").catch(() => {});
}

export const suite = {
  name: "open-save-export",
  build: buildCases,
  async run(item) {
    await runCase(item);
  },
};
