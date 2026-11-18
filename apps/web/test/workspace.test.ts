import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportFileName,
  isValidDocumentId,
  makeDocumentId,
  validateDocumentShape,
  WorkspaceStore,
} from "../server/workspace";

/** Minimal valid document payload (kept independent of the core package). */
function sampleDocument(title: string) {
  return {
    schemaVersion: "1.0.0",
    id: "doc-1",
    metadata: { title, keywords: [], custom: {} },
    theme: { fonts: { major: {}, minor: {} }, colors: {} },
    styles: { defaults: {}, styles: {} },
    sections: [
      {
        id: "s1",
        blocks: [
          {
            type: "paragraph",
            id: "p1",
            style: "Normal",
            props: {},
            inlines: [{ type: "text", text: title, props: {} }],
          },
        ],
        page: {
          width: 595.3,
          height: 841.9,
          orientation: "portrait",
          margins: { top: 72, right: 72, bottom: 72, left: 72 },
        },
        columns: { count: 1, space: 36 },
        headers: {},
        footers: {},
        breakBefore: "nextPage",
        titlePage: false,
        evenAndOdd: false,
      },
    ],
    numbering: { abstract: {}, nums: {} },
    footnotes: [],
    endnotes: [],
    comments: [],
    revisions: [],
    bookmarks: [],
    shapes: [],
    media: [],
    customXml: [],
    settings: {
      defaultTabStop: 36,
      evenAndOddHeaders: false,
      trackRevisions: false,
      autoHyphenation: false,
    },
    unknown: [],
    idSeq: 1,
  };
}

describe("document ids", () => {
  it("accepts safe ids and rejects traversal attempts", () => {
    expect(isValidDocumentId("doc-abc_123")).toBe(true);
    expect(isValidDocumentId("..")).toBe(false);
    expect(isValidDocumentId("../etc/passwd")).toBe(false);
    expect(isValidDocumentId("a/b")).toBe(false);
    expect(isValidDocumentId("a\\b")).toBe(false);
    expect(isValidDocumentId("has space")).toBe(false);
    expect(isValidDocumentId(".hidden")).toBe(false);
    expect(isValidDocumentId("")).toBe(false);
    expect(isValidDocumentId(42)).toBe(false);
  });

  it("generates ids that satisfy the id contract", () => {
    const id = makeDocumentId(1_700_000_000_000, () => 0.5);
    expect(isValidDocumentId(id)).toBe(true);
    expect(id.startsWith("doc-")).toBe(true);
  });

  it("builds safe export filenames", () => {
    expect(exportFileName("Quarterly Report: Q3/2025", "docx")).toBe(
      "Quarterly-Report-Q32025.docx",
    );
    expect(exportFileName("", "pdf")).toBe("document.pdf");
    expect(exportFileName("Ünïcode tïtle", "txt")).toBe("Unicode-title.txt");
  });
});

describe("document shape validation", () => {
  it("accepts a structurally valid document", () => {
    expect(validateDocumentShape(sampleDocument("Hello"))).toEqual({
      ok: true,
    });
  });

  it("rejects non-documents with a concrete reason", () => {
    expect(validateDocumentShape(null).ok).toBe(false);
    expect(validateDocumentShape([]).ok).toBe(false);
    expect(validateDocumentShape({}).reason).toContain("schemaVersion");
    const missingSections = { ...sampleDocument("x"), sections: [] };
    expect(validateDocumentShape(missingSections).reason).toContain("sections");
    const badPage = sampleDocument("x");
    // @ts-expect-error deliberately malformed input
    badPage.sections[0].page = { width: "wide" };
    expect(validateDocumentShape(badPage).reason).toContain("page");
    const noIdSeq = { ...sampleDocument("x"), idSeq: "1" };
    expect(validateDocumentShape(noIdSeq).reason).toContain("idSeq");
  });
});

describe("WorkspaceStore", () => {
  let directory: string;
  let store: WorkspaceStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "dsh-doc-workspace-"));
    store = new WorkspaceStore(directory);
    await store.ensure();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes, lists, reads and deletes a document record", async () => {
    const id = makeDocumentId(1_700_000_000_000, () => 0.25);
    const record = await store.writeJson({
      id,
      title: "Report",
      document: sampleDocument("Report"),
    });
    expect(record.createdAt).toBeTruthy();
    expect(record.updatedAt).toBeTruthy();

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, title: "Report", kind: "json" });

    const loaded = await store.readJson(id);
    expect(loaded?.document).toMatchObject({ schemaVersion: "1.0.0" });
    expect((await store.exists(id)).json).toBe(true);

    expect(await store.remove(id)).toBe(true);
    expect(await store.readJson(id)).toBeNull();
    expect(await store.list()).toHaveLength(0);
    expect(await store.remove(id)).toBe(false);
  });

  it("refuses ids and paths that escape the workspace", () => {
    expect(() => store.resolvePath("../escape", "json")).toThrow(
      /Invalid document id/,
    );
    expect(() => store.resolvePath("nested/doc", "json")).toThrow(
      /Invalid document id/,
    );
    const inside = path.resolve(directory, "safe.json");
    expect(store.resolvePath("safe", "json")).toBe(inside);
  });

  it("rejects a record that is not a workspace document", async () => {
    const id = makeDocumentId(1, () => 0.1);
    const file = store.resolvePath(id, "json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify({ hello: "world" }), "utf8");
    await expect(store.readJson(id)).rejects.toThrow(
      /not a valid workspace record/,
    );
  });
});
