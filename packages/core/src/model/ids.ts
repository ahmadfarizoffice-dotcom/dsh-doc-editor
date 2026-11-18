import type { DocDocument } from "./types.js";

/**
 * Document-scoped id factory. Ids are derived from a persisted counter so that
 * importing the same file twice produces identical ids (deterministic tests)
 * and persisted documents keep stable anchors.
 */
export function newId(doc: DocDocument, prefix: string): string {
  doc.idSeq += 1;
  return `${prefix}${doc.idSeq.toString(36)}`;
}

/** Creates a detached id without touching the document counter (used by importers that assign ids in bulk). */
export function makeIdFactory(start: number): {
  next: (prefix: string) => string;
  value: () => number;
} {
  let seq = start;
  return {
    next(prefix: string) {
      seq += 1;
      return `${prefix}${seq.toString(36)}`;
    },
    value() {
      return seq;
    },
  };
}

/** Deterministic slug id used for media parts and bookmarks. */
export function slugify(value: string, fallback = "item"): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : fallback;
}
