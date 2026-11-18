import { describe, expect, it } from "vitest";
import {
  applyList,
  applyStyle,
  createDocument,
  documentOutline,
  documentStats,
  findParagraph,
  insertToc,
  paragraphText,
  searchDocument,
} from "@dsh-doc/core/model";
import {
  findMatches,
  insertTocAfterCaret,
  listLabels,
  replaceMatches,
} from "../src/model/ops";

function makeOutlineDocument() {
  const document = createDocument({
    title: "Outline",
    paragraphs: ["Document title", "Introduction", "Details", "Body text"],
  });
  applyStyle(document, ["p1"], "Title");
  applyStyle(document, ["p2"], "Heading1");
  applyStyle(document, ["p3"], "Heading2");
  return document;
}

describe("outline extraction", () => {
  it("derives levels from paragraph styles in document order", () => {
    const document = makeOutlineDocument();
    const outline = documentOutline(document);
    expect(outline.map((entry) => [entry.level, entry.text])).toEqual([
      [0, "Document title"],
      [1, "Introduction"],
      [2, "Details"],
    ]);
    expect(outline[1].style).toBe("Heading1");
    expect(outline[1].sectionIndex).toBe(0);
  });

  it("reflects heading changes applied after creation", () => {
    const document = makeOutlineDocument();
    applyStyle(document, ["p4"], "Heading1");
    const outline = documentOutline(document);
    expect(outline.find((entry) => entry.blockId === "p4")?.level).toBe(1);
  });

  it("inserts a table of contents block with a caption and a trailing paragraph", () => {
    const document = makeOutlineDocument();
    const caret = insertTocAfterCaret(
      document,
      {
        anchor: { blockId: "p4", inlineIndex: 0, offset: 0 },
        focus: { blockId: "p4", inlineIndex: 0, offset: 0 },
      },
      { minLevel: 1, maxLevel: 2, caption: "Contents" },
    );
    const toc = document.sections[0].blocks.find(
      (block) => block.type === "toc",
    );
    expect(toc).toBeTruthy();
    if (toc && toc.type === "toc") {
      expect(toc.minLevel).toBe(1);
      expect(toc.maxLevel).toBe(2);
    }
    expect(
      document.sections[0].blocks.some(
        (block) => block.id === caret.focus.blockId,
      ),
    ).toBe(true);

    const direct = insertToc(document, "p4", { caption: "Direct" });
    expect(direct.tocId).toBeTruthy();
  });
});

describe("document query integration", () => {
  it("counts words, characters and paragraphs", () => {
    const document = createDocument({ paragraphs: ["one two three", "four"] });
    const stats = documentStats(document);
    expect(stats.words).toBe(4);
    expect(stats.paragraphs).toBe(2);
    expect(stats.charactersWithSpaces).toBeGreaterThanOrEqual(17);
  });

  it("finds text with context through the shared search", () => {
    const document = createDocument({
      paragraphs: ["The quick brown fox", "jumps over the lazy dog"],
    });
    const matches = searchDocument(document, "the", { caseSensitive: false });
    expect(matches.length).toBe(2);
    expect(matches[0].contextAfter).toContain("quick");
    const appMatches = findMatches(document, "the");
    expect(appMatches).toHaveLength(2);
    replaceMatches(document, appMatches, "THE");
    const first = findParagraph(document, "p1")?.paragraph;
    const second = findParagraph(document, "p2")?.paragraph;
    expect(first ? paragraphText(first) : "").toBe("THE quick brown fox");
    expect(second ? paragraphText(second) : "").toBe("jumps over THE lazy dog");
  });

  it("reports list labels for numbered items", () => {
    const document = createDocument({
      paragraphs: ["First", "Second", "Third"],
    });
    applyList(document, ["p1", "p2", "p3"], { kind: "number" });
    const labels = listLabels(document);
    expect([...labels.values()]).toEqual(["1.", "2.", "3."]);
    const numbered = findParagraph(document, "p2")?.paragraph;
    expect(numbered).toBeTruthy();
  });
});
