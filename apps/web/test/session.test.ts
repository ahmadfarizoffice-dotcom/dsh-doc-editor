import { describe, expect, it } from "vitest";
import {
  createDocument,
  findParagraph,
  paragraphText,
} from "@dsh-doc/core/model";
import {
  DocumentSession,
  MemoryStorage,
  recoveryKey,
} from "../src/model/session";
import { collapsed, insertTextAtSelection } from "../src/model/ops";

function makeSession(
  options: { now?: () => number; storage?: MemoryStorage } = {},
) {
  const document = createDocument({
    title: "Session test",
    paragraphs: ["Hello world"],
  });
  const storage = options.storage ?? new MemoryStorage();
  const session = new DocumentSession(document, {
    storage,
    documentId: "doc-test",
    now: options.now,
  });
  return { session, storage };
}

function firstParagraphText(session: DocumentSession): string {
  const paragraph = session.document.sections[0].blocks[0];
  if (!paragraph || paragraph.type !== "paragraph") return "";
  return paragraphText(paragraph);
}

describe("DocumentSession", () => {
  it("applies an edit, marks the session dirty and records undo history", () => {
    const { session } = makeSession();
    expect(session.dirty).toBe(false);
    expect(session.canUndo).toBe(false);

    const selection = {
      anchor: { blockId: "p1", inlineIndex: 0, offset: 5 },
      focus: { blockId: "p1", inlineIndex: 0, offset: 5 },
    };
    session.apply("Type", (document) => {
      insertTextAtSelection(document, selection, " there");
    });

    expect(firstParagraphText(session)).toBe("Hello there world");
    expect(session.dirty).toBe(true);
    expect(session.canUndo).toBe(true);

    expect(session.undo()).toBe(true);
    expect(firstParagraphText(session)).toBe("Hello world");
    expect(session.canRedo).toBe(true);

    expect(session.redo()).toBe(true);
    expect(firstParagraphText(session)).toBe("Hello there world");
  });

  it("coalesces consecutive keystrokes sharing a coalesce key into one undo step", () => {
    let now = 1_000;
    const { session } = makeSession({ now: () => now });
    const at = (offset: number) => ({
      anchor: { blockId: "p1", inlineIndex: 0, offset },
      focus: { blockId: "p1", inlineIndex: 0, offset },
    });

    session.apply(
      "Type",
      (document) => insertTextAtSelection(document, at(5), " a"),
      { coalesce: "type:p1" },
    );
    now += 200;
    session.apply(
      "Type",
      (document) => insertTextAtSelection(document, at(7), " b"),
      { coalesce: "type:p1" },
    );
    now += 200;
    session.apply(
      "Type",
      (document) => insertTextAtSelection(document, at(9), " c"),
      { coalesce: "type:p1" },
    );
    expect(firstParagraphText(session)).toBe("Hello a b c world");

    // One undo restores the state before the whole burst.
    session.undo();
    expect(firstParagraphText(session)).toBe("Hello world");

    // A different key starts a new history entry.
    now += 5_000;
    session.apply(
      "Type",
      (document) => insertTextAtSelection(document, at(5), " X"),
      { coalesce: "type:p1" },
    );
    expect(session.canUndo).toBe(true);
    session.undo();
    expect(firstParagraphText(session)).toBe("Hello world");
  });

  it("rolls the document back when a mutation throws", () => {
    const { session } = makeSession();
    expect(() =>
      session.apply("Broken", (document) => {
        const paragraph = findParagraph(document, "p1");
        if (paragraph) paragraph.paragraph.inlines = [];
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(firstParagraphText(session)).toBe("Hello world");
    expect(session.dirty).toBe(false);
  });

  it("writes an autosave snapshot and clears it on markSaved", () => {
    const storage = new MemoryStorage();
    const { session } = makeSession({ storage });
    session.apply("Edit", (document) =>
      insertTextAtSelection(
        document,
        collapsed({ blockId: "p1", inlineIndex: 0, offset: 0 }),
        ">>",
      ),
    );
    expect(session.autosave("Session test", 1234)).toBe(true);

    const raw = storage.getItem(recoveryKey("doc-test"));
    expect(raw).toBeTruthy();
    const snapshot = session.readRecovery();
    expect(snapshot?.savedAt).toBe(1234);
    expect(snapshot?.title).toBe("Session test");
    expect(session.hasNewerRecovery()).toBe(true);

    session.markSaved();
    expect(session.dirty).toBe(false);
    expect(session.readRecovery()).toBeNull();
    expect(session.hasNewerRecovery()).toBe(false);
  });

  it("recovers a snapshot into the session and resets history", () => {
    const { session } = makeSession();
    const snapshot = {
      version: 1 as const,
      documentId: "doc-test",
      title: "Recovered",
      savedAt: 99,
      document: createDocument({
        title: "Recovered",
        paragraphs: ["Recovered body"],
      }),
    };
    session.recover(snapshot);
    expect(session.document.metadata.title).toBe("Recovered");
    expect(session.canUndo).toBe(false);
    expect(session.dirty).toBe(true);
  });

  it("replaces the document and exposes block order for range normalization", () => {
    const { session } = makeSession();
    session.setDocument(
      createDocument({ title: "Other", paragraphs: ["A", "B"] }),
      { resetHistory: true, markClean: true },
    );
    expect(session.blockOrder).toEqual(["p1", "p2"]);
    expect(session.dirty).toBe(false);
    expect(session.stats().paragraphs).toBe(2);
    expect(session.range.start.blockId).toBe("p1");
  });
});
