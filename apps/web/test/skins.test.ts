import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  createDocument,
  findParagraph,
  paragraphText,
  resolveParagraphProps,
} from "@dsh-doc/core/model";
import { App } from "../src/App";
import { AppStore } from "../src/app/state";
import { MemoryStorage } from "../src/model/session";
import {
  DEFAULT_SKIN,
  SKIN_IDS,
  SKIN_OPTIONS,
  SKIN_STORAGE_KEY,
  SkinStore,
  resolveInitialSkin,
  skinFromQuery,
  type SkinId,
} from "../src/skins/skin";
import { createSkinActions } from "../src/skins/actions";
import { readFormattingState } from "../src/skins/formatting";
import { skinMenuItems, type MenuContext } from "../src/skins/menus";
import { SkinApp } from "../src/skins/SkinApp";
import { insertTextAtSelection, readActiveFormatting } from "../src/model/ops";
import { estimatePages } from "../src/skins/pages";

const AppComponent = App as unknown as ComponentType<{ store?: AppStore }>;

function makeStore(): AppStore {
  return new AppStore({
    storage: new MemoryStorage(),
    initialDocument: createDocument({
      title: "Skin test",
      paragraphs: ["Hello world", "Second paragraph"],
    }),
    autosaveDelayMs: 1_000_000,
  });
}

function firstBlockId(store: AppStore): string {
  return store.session.document.sections[0]?.blocks[0]?.id ?? "";
}

function typeText(
  store: AppStore,
  blockId: string,
  offset: number,
  text: string,
) {
  store.setSelection(
    { blockId, inlineIndex: 0, offset },
    { blockId, inlineIndex: 0, offset },
  );
  store.apply("Type", (document) => {
    insertTextAtSelection(document, store.selection, text);
  });
}

function menuContext(store: AppStore): MenuContext {
  const snapshot = store.getSnapshot();
  return {
    actions: createSkinActions(store),
    snapshot,
    state: readFormattingState(snapshot.document, store.selection),
    skin: "gdocs",
    theme: "system",
    onSkinChange: () => undefined,
    onThemeChange: () => undefined,
  };
}

describe("skin preference", () => {
  it("defaults to Google Docs and restores a stored skin", () => {
    const storage = new MemoryStorage();
    expect(resolveInitialSkin({ storage })).toBe(DEFAULT_SKIN);
    expect(DEFAULT_SKIN).toBe("gdocs");

    storage.setItem(SKIN_STORAGE_KEY, "word");
    expect(resolveInitialSkin({ storage })).toBe("word");

    storage.setItem(SKIN_STORAGE_KEY, "not-a-skin");
    expect(resolveInitialSkin({ storage })).toBe(DEFAULT_SKIN);
  });

  it("accepts ?skin= as a testing override without persisting it", () => {
    const storage = new MemoryStorage();
    storage.setItem(SKIN_STORAGE_KEY, "pages");

    expect(skinFromQuery("?skin=writer")).toBe("writer");
    expect(resolveInitialSkin({ storage, search: "?skin=writer" })).toBe(
      "writer",
    );
    expect(storage.getItem(SKIN_STORAGE_KEY)).toBe("pages");

    expect(resolveInitialSkin({ storage, search: "?skin=bogus" })).toBe(
      "pages",
    );
    expect(skinFromQuery("?skin=bogus")).toBeNull();
    expect(skinFromQuery("?other=1")).toBeNull();
  });

  it("persists an explicit switch and notifies subscribers", () => {
    const storage = new MemoryStorage();
    const store = new SkinStore({ storage, search: "" });
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    store.setSkin("word");
    expect(store.getSnapshot()).toBe("word");
    expect(storage.getItem(SKIN_STORAGE_KEY)).toBe("word");
    expect(notified).toBe(1);
    store.setSkin("word");
    expect(notified).toBe(1);
    unsubscribe();
  });

  it("carries the four product names in the switcher", () => {
    expect(SKIN_IDS).toEqual(["gdocs", "word", "pages", "writer"]);
    const labels = SKIN_OPTIONS.map((option) => option.name);
    expect(labels).toEqual([
      "Google Docs",
      "Microsoft Word",
      "Apple Pages",
      "LibreOffice Writer",
    ]);

    const store = makeStore();
    const items = skinMenuItems(menuContext(store), "test");
    const actionLabels = items
      .filter((item) => item.kind === "action")
      .map((item) => item.label);
    for (const label of labels) expect(actionLabels).toContain(label);
  });
});

describe("data-skin attribute and chrome", () => {
  it("renders the app root with data-skin and the active switcher", () => {
    const store = makeStore();
    const html = renderToStaticMarkup(createElement(AppComponent, { store }));
    expect(html).toContain('class="app"');
    expect(html).toContain('data-skin="gdocs"');
    expect(html).toContain("Skin: Docs");
    for (const option of SKIN_OPTIONS) {
      expect(html).toContain(option.name);
    }
  });

  it("renders the signature chrome of every skin", () => {
    const store = makeStore();
    const snapshot = store.getSnapshot();
    const renderSkin = (skin: SkinId): string =>
      renderToStaticMarkup(
        createElement(SkinApp, {
          store,
          snapshot,
          skin,
          theme: "system",
          onSkinChange: () => undefined,
          onThemeChange: () => undefined,
        }),
      );

    const docs = renderSkin("gdocs");
    expect(docs).toContain("Share");
    expect(docs).toContain("Editing");
    expect(docs).toContain("Google Docs toolbar");

    const word = renderSkin("word");
    for (const tab of [
      "Home",
      "Insert",
      "Draw",
      "Design",
      "Layout",
      "References",
      "Mailings",
      "Review",
      "View",
      "Help",
    ])
      expect(word).toContain(`>${tab}<`);

    const pages = renderSkin("pages");
    expect(pages).toContain("Pages");
    expect(pages).toContain("Collaborate");
    expect(pages).toContain("Format");
    expect(pages).toContain("Document");

    const writer = renderSkin("writer");
    for (const menu of [
      "File",
      "Edit",
      "View",
      "Insert",
      "Format",
      "Styles",
      "Table",
      "Form",
      "Tools",
      "Window",
      "Help",
    ])
      expect(writer).toContain(`>${menu}<`);
  });
});

describe("skin switching keeps the document intact", () => {
  it("does not touch typed text, statistics or the undo history", () => {
    const storage = new MemoryStorage();
    const skins = new SkinStore({ storage, search: "" });
    const store = makeStore();
    const blockId = firstBlockId(store);
    typeText(store, blockId, 11, "!");

    const paragraph = (): string => {
      const found = findParagraph(store.session.document, blockId);
      return found ? paragraphText(found.paragraph) : "";
    };
    const textBefore = paragraph();
    const historyBefore = store.session.historyEntries().length;
    const wordsBefore = store.getSnapshot().stats.words;
    expect(textBefore).toBe("Hello world!");
    expect(store.session.dirty).toBe(true);

    for (const skin of SKIN_IDS) {
      skins.setSkin(skin);
      expect(skins.getSnapshot()).toBe(skin);
      expect(paragraph()).toBe(textBefore);
      expect(store.session.historyEntries().length).toBe(historyBefore);
      expect(store.getSnapshot().stats.words).toBe(wordsBefore);
      expect(store.session.dirty).toBe(true);
    }
    expect(storage.getItem(SKIN_STORAGE_KEY)).toBe("writer");
  });
});

describe("shared action layer", () => {
  it("routes character and paragraph controls to the real model operations", () => {
    const store = makeStore();
    const actions = createSkinActions(store);
    const blockId = firstBlockId(store);
    store.setSelection(
      { blockId, inlineIndex: 0, offset: 0 },
      { blockId, inlineIndex: 0, offset: 5 },
    );

    actions.toggleMark("bold");
    actions.setFontSize(16);
    actions.setColor("#c00000");
    actions.setAlignment("center");
    actions.applyStyle("Heading1");

    const found = findParagraph(store.session.document, blockId);
    expect(found).toBeTruthy();
    if (!found) return;
    const active = readActiveFormatting(
      store.session.document,
      store.selection,
    );
    expect(active.run.bold).toBe(true);
    expect(active.run.fontSize).toBe(16);
    expect(active.run.color).toBe("#c00000");
    expect(
      resolveParagraphProps(store.session.document, found.paragraph).alignment,
    ).toBe("center");
    expect(found.paragraph.style).toBe("Heading1");
  });

  it("keeps undo working for toolbar actions", () => {
    const store = makeStore();
    const actions = createSkinActions(store);
    const blockId = firstBlockId(store);
    typeText(store, blockId, 11, "!");
    store.setSelection(
      { blockId, inlineIndex: 0, offset: 0 },
      { blockId, inlineIndex: 0, offset: 5 },
    );
    actions.toggleMark("italic");
    expect(store.getSnapshot().canUndo).toBe(true);
    actions.undo();
    const found = findParagraph(store.session.document, blockId);
    expect(found).toBeTruthy();
    if (!found) return;
    expect(paragraphText(found.paragraph)).toBe("Hello world!");
    const active = readActiveFormatting(
      store.session.document,
      store.selection,
    );
    expect(active.run.italic).toBe(false);
  });

  it("estimates page count and caret page from the model", () => {
    const document = createDocument({
      title: "Pages",
      paragraphs: Array.from({ length: 80 }, (_, index) => `Line ${index + 1}`),
    });
    const estimate = estimatePages(document);
    expect(estimate.pageCount).toBeGreaterThan(1);
    expect(estimate.currentPage).toBe(1);

    const blockId = document.sections[0]?.blocks[0]?.id ?? "";
    expect(
      estimatePages(document, {
        position: { blockId, inlineIndex: 0, offset: 0 },
      }).currentPage,
    ).toBe(1);
  });
});
