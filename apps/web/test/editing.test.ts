import { describe, expect, it } from "vitest";
import {
  applyList,
  createDocument,
  findParagraph,
  paragraphText,
  resolveParagraphProps,
  resolveRunProps,
} from "@dsh-doc/core/model";
import type { DocDocument, Paragraph } from "@dsh-doc/core/model";
import {
  applyAlignment,
  applyParagraphSpacing,
  applyRunProps,
  applyToggleMark,
  changeListLevel,
  collapsed,
  deleteBackward,
  deleteForward,
  findMatches,
  insertPageBreakAt,
  insertTableAt,
  listLabels,
  readActiveFormatting,
  replaceMatches,
  selectionRange,
  transformRangeText,
} from "../src/model/ops";
import type { EditorSelection as Selection } from "../src/model/selection";

function makeDocument(text = "Hello world"): DocDocument {
  return createDocument({
    title: "Ops",
    paragraphs: [text, "Second paragraph"],
  });
}

function paragraph(document: DocDocument, id = "p1"): Paragraph {
  const located = findParagraph(document, id);
  if (!located) throw new Error(`missing paragraph ${id}`);
  return located.paragraph;
}

function selection(blockId: string, from: number, to: number): Selection {
  return {
    anchor: { blockId, inlineIndex: 0, offset: from },
    focus: { blockId, inlineIndex: 0, offset: to },
  };
}

describe("character formatting", () => {
  it("applies bold to the selected range and reports it as active", () => {
    const document = makeDocument();
    const range = selection("p1", 0, 5);
    const result = applyToggleMark(document, range, "bold");
    expect(result.value).toBe(true);
    expect(result.pending).toBeNull();

    const run = paragraph(document).inlines[0];
    expect(run.type).toBe("text");
    if (run.type === "text") {
      expect(run.text).toBe("Hello");
      expect(run.props.bold).toBe(true);
    }
    // The remainder of the paragraph keeps its old formatting.
    const tail = paragraph(document).inlines[1];
    expect(tail.type).toBe("text");
    if (tail.type === "text") {
      expect(tail.text).toBe(" world");
      expect(tail.props.bold).toBeUndefined();
    }

    const active = readActiveFormatting(document, range);
    expect(active.hasRange).toBe(true);
    expect(active.run.bold).toBe(true);
    expect(active.run.italic).toBe(false);
  });

  it("returns a pending format instead of mutating a collapsed selection", () => {
    const document = makeDocument();
    const before = paragraphText(paragraph(document));
    const result = applyToggleMark(
      document,
      collapsed({ blockId: "p1", inlineIndex: 0, offset: 2 }),
      "italic",
    );
    expect(result.value).toBe(true);
    expect(result.pending).toMatchObject({ italic: true });
    expect(paragraphText(paragraph(document))).toBe(before);
  });

  it("applies colour and size as run properties on the range", () => {
    const document = makeDocument();
    applyRunProps(document, selection("p1", 0, 11), {
      color: "#c00000",
      fontSize: 16,
    });
    for (const inline of paragraph(document).inlines) {
      if (inline.type !== "text") continue;
      expect(inline.props.color).toBe("#c00000");
      expect(inline.props.fontSize).toBe(16);
    }
    const resolved = resolveRunProps(document, {
      paragraphStyle: paragraph(document).style,
      direct: { fontSize: 16 },
    });
    expect(resolved.fontSize).toBe(16);
  });

  it("preserves formatting through a case transform", () => {
    const document = makeDocument();
    applyToggleMark(document, selection("p1", 0, 5), "bold");
    const changed = transformRangeText(
      document,
      selection("p1", 0, 5),
      "upper",
    );
    expect(changed).toBeGreaterThan(0);
    const first = paragraph(document).inlines[0];
    expect(first.type).toBe("text");
    if (first.type === "text") {
      expect(first.text).toBe("HELLO");
      expect(first.props.bold).toBe(true);
    }
    expect(paragraphText(paragraph(document))).toBe("HELLO world");
  });
});

describe("paragraph formatting", () => {
  it("sets alignment and spacing through the shared paragraph operations", () => {
    const document = makeDocument();
    applyAlignment(document, selection("p1", 0, 0), "center");
    applyParagraphSpacing(document, selection("p1", 0, 0), {
      before: 12,
      after: 6,
    });

    const props = resolveParagraphProps(document, paragraph(document));
    expect(props.alignment).toBe("center");
    expect(props.spaceBefore).toBe(12);
    expect(props.spaceAfter).toBe(6);
  });

  it("creates a real numbering definition with computed labels", () => {
    const document = makeDocument();
    applyList(document, ["p1", "p2"], { kind: "number" });
    const labels = listLabels(document);
    expect(labels.get("p1")).toBe("1.");
    expect(labels.get("p2")).toBe("2.");

    changeListLevel(document, selection("p2", 0, 0), 1);
    const props = resolveParagraphProps(document, paragraph(document, "p2"));
    expect(props.numbering?.level).toBe(1);
  });
});

describe("structure", () => {
  it("inserts a table and returns a caret inside its first cell", () => {
    const document = makeDocument();
    const inserted = insertTableAt(document, selection("p1", 0, 0), {
      rows: 2,
      columns: 3,
      headerRow: true,
    });
    const table = document.sections[0].blocks.find(
      (block) => block.id === inserted.tableId,
    );
    expect(table?.type).toBe("table");
    if (table?.type === "table") {
      expect(table.rows).toHaveLength(2);
      expect(table.rows[0].cells).toHaveLength(3);
      expect(table.rows[0].props.isHeader).toBe(true);
    }
    const caretParagraph = findParagraph(
      document,
      inserted.selection.focus.blockId,
    );
    expect(caretParagraph).toBeTruthy();
  });

  it("inserts a page break inline at the caret", () => {
    const document = makeDocument();
    const caret = insertPageBreakAt(document, {
      blockId: "p1",
      inlineIndex: 0,
      offset: 6,
    });
    expect(caret.focus.blockId).toBe("p1");
    const hasBreak = paragraph(document).inlines.some(
      (inline) => inline.type === "break" && inline.kind === "page",
    );
    expect(hasBreak).toBe(true);
  });

  it("merges paragraphs with backspace at the start of a block", () => {
    const document = makeDocument();
    const result = deleteBackward(
      document,
      { blockId: "p2", inlineIndex: 0, offset: 0 },
      "character",
    );
    expect(result).not.toBeNull();
    expect(document.sections[0].blocks).toHaveLength(1);
    expect(paragraphText(paragraph(document))).toBe(
      "Hello worldSecond paragraph",
    );
    expect(result!.focus.blockId).toBe("p1");
  });

  it("refuses to delete forward at the end of the document", () => {
    const document = makeDocument();
    const text = paragraphText(paragraph(document, "p2"));
    expect(
      deleteForward(
        document,
        { blockId: "p2", inlineIndex: 0, offset: text.length },
        "character",
      ),
    ).toBeNull();
  });
});

describe("search and replace", () => {
  it("finds matches and replaces them all", () => {
    const document = makeDocument("alpha beta gamma alpha");
    const matches = findMatches(document, "alpha");
    expect(matches).toHaveLength(2);
    expect(matches[0].start).toBe(0);

    const replaced = replaceMatches(document, matches, "ALPHA");
    expect(replaced).toBe(2);
    expect(paragraphText(paragraph(document))).toBe("ALPHA beta gamma ALPHA");
  });

  it("honours case sensitivity", () => {
    const document = makeDocument("Alpha alpha");
    expect(
      findMatches(document, "alpha", { caseSensitive: true }),
    ).toHaveLength(1);
    expect(
      findMatches(document, "alpha", { caseSensitive: false }),
    ).toHaveLength(2);
  });
});

describe("selection helpers", () => {
  it("normalizes a backward selection into a document range", () => {
    const document = makeDocument();
    const backwards: Selection = {
      anchor: { blockId: "p1", inlineIndex: 0, offset: 5 },
      focus: { blockId: "p1", inlineIndex: 0, offset: 1 },
    };
    const range = selectionRange(document, backwards);
    expect(range.start.offset).toBe(1);
    expect(range.end.offset).toBe(5);
  });
});
