import { findParagraph, listBlocks, listParagraphs } from "./access.js";
import {
  ensureBoundary,
  insertParagraphAfter,
  offsetInParagraph,
} from "./edit.js";
import { newId } from "./ids.js";
import { paragraphText } from "./text.js";
import type {
  DocComment,
  DocDocument,
  Inline,
  Paragraph,
  Revision,
  TextPosition,
} from "./types.js";

/* ------------------------------------------------------------- comments */

export interface AddCommentOptions {
  text: string;
  author?: string;
  initials?: string;
  /** Reply to an existing comment thread. */
  parentId?: string;
  resolved?: boolean;
}

function commentMark(
  commentId: string,
  kind: "point" | "rangeStart" | "rangeEnd",
): Inline {
  return { type: "commentRef", commentId, kind };
}

function makeCommentBlocks(doc: DocDocument, text: string): Paragraph[] {
  return text.split(/\r?\n/).map((line) => ({
    type: "paragraph" as const,
    id: newId(doc, "p"),
    style: "Normal",
    props: {},
    inlines: line ? [{ type: "text" as const, text: line, props: {} }] : [],
  }));
}

/** Adds a comment anchored to a range (or to a single position when collapsed). */
export function addComment(
  doc: DocDocument,
  range: { start: TextPosition; end: TextPosition },
  options: AddCommentOptions,
): { commentId: string } {
  const startLoc = findParagraph(doc, range.start.blockId);
  const endLoc = findParagraph(doc, range.end.blockId);
  if (!startLoc || !endLoc)
    throw new Error("Comment range must reference existing paragraphs");

  const commentId = newId(doc, "c");
  const author =
    options.author ??
    doc.metadata.lastModifiedBy ??
    doc.metadata.creator ??
    "Anonymous";
  const comment: DocComment = {
    id: commentId,
    author,
    initials: options.initials ?? author.slice(0, 2).toUpperCase(),
    date: new Date().toISOString(),
    blocks: makeCommentBlocks(doc, options.text),
    resolved: options.resolved ?? false,
    parentId: options.parentId,
  };

  // Insert the end mark first so the start index stays valid.
  const endBoundary = ensureBoundary(endLoc.paragraph, range.end);
  endLoc.paragraph.inlines.splice(
    endBoundary,
    0,
    commentMark(commentId, "rangeEnd"),
  );
  if (startLoc.paragraph.id === endLoc.paragraph.id) {
    const startBoundary = ensureBoundary(startLoc.paragraph, range.start);
    startLoc.paragraph.inlines.splice(
      startBoundary,
      0,
      commentMark(commentId, "rangeStart"),
    );
  } else {
    const startBoundary = ensureBoundary(startLoc.paragraph, range.start);
    startLoc.paragraph.inlines.splice(
      startBoundary,
      0,
      commentMark(commentId, "rangeStart"),
    );
  }

  comment.anchor = {
    paragraphId: startLoc.paragraph.id,
    start: offsetInParagraph(startLoc.paragraph, range.start),
    end: offsetInParagraph(endLoc.paragraph, range.end),
  };
  doc.comments.push(comment);
  doc.metadata.modified = new Date().toISOString();
  return { commentId };
}

/** Replies to an existing comment. */
export function replyToComment(
  doc: DocDocument,
  parentId: string,
  text: string,
  author?: string,
): { commentId: string } {
  const parent = doc.comments.find((entry) => entry.id === parentId);
  if (!parent) throw new Error(`Unknown comment: ${parentId}`);
  const commentId = newId(doc, "c");
  const resolvedAuthor = author ?? doc.metadata.lastModifiedBy ?? "Anonymous";
  doc.comments.push({
    id: commentId,
    author: resolvedAuthor,
    initials: resolvedAuthor.slice(0, 2).toUpperCase(),
    date: new Date().toISOString(),
    blocks: makeCommentBlocks(doc, text),
    resolved: false,
    parentId,
  });
  doc.metadata.modified = new Date().toISOString();
  return { commentId };
}

/** Marks a comment (and its replies) resolved or reopened. */
export function setCommentResolved(
  doc: DocDocument,
  commentId: string,
  resolved: boolean,
): void {
  const comment = doc.comments.find((entry) => entry.id === commentId);
  if (!comment) throw new Error(`Unknown comment: ${commentId}`);
  comment.resolved = resolved;
  for (const reply of doc.comments) {
    if (reply.parentId === commentId) reply.resolved = resolved;
  }
  doc.metadata.modified = new Date().toISOString();
}

/** Deletes a comment and every reply plus their inline anchors. */
export function deleteComment(
  doc: DocDocument,
  commentId: string,
): { removedIds: string[] } {
  const removedIds = [commentId];
  let changed = true;
  while (changed) {
    changed = false;
    for (const comment of doc.comments) {
      if (
        comment.parentId &&
        removedIds.includes(comment.parentId) &&
        !removedIds.includes(comment.id)
      ) {
        removedIds.push(comment.id);
        changed = true;
      }
    }
  }
  doc.comments = doc.comments.filter(
    (comment) => !removedIds.includes(comment.id),
  );
  for (const { paragraph } of listParagraphs(doc)) {
    paragraph.inlines = paragraph.inlines.filter(
      (inline) =>
        !(
          inline.type === "commentRef" && removedIds.includes(inline.commentId)
        ),
    );
  }
  doc.metadata.modified = new Date().toISOString();
  return { removedIds };
}

/** Comment threads for the review pane, parents first with `replies` populated. */
export function commentThreads(
  doc: DocDocument,
): Array<DocComment & { replies: DocComment[] }> {
  const roots = doc.comments.filter((comment) => !comment.parentId);
  return roots.map((root) => ({
    ...root,
    replies: doc.comments.filter((comment) => comment.parentId === root.id),
  }));
}

/* -------------------------------------------------------- tracked changes */

/** Enables or disables tracked changes. */
export function setTrackChanges(doc: DocDocument, enabled: boolean): void {
  doc.settings.trackRevisions = enabled;
}

/** Every tracked revision currently present in the document body. */
export function pendingRevisions(doc: DocDocument): Revision[] {
  const ids = new Set<string>();
  for (const { paragraph } of listParagraphs(doc)) {
    if (paragraph.revision) ids.add(paragraph.revision.id);
    for (const inline of paragraph.inlines) {
      const revision =
        inline.type === "text" ? inline.props.revision : undefined;
      if (revision) ids.add(revision.id);
    }
  }
  return doc.revisions.filter((revision) => ids.has(revision.id));
}

interface InlineRevisionSummary {
  inserted: number;
  deleted: number;
  formatted: number;
}

export function revisionSummary(doc: DocDocument): InlineRevisionSummary {
  let inserted = 0;
  let deleted = 0;
  let formatted = 0;
  for (const { paragraph } of listParagraphs(doc)) {
    if (paragraph.revision?.kind === "delete") deleted += 1;
    for (const inline of paragraph.inlines) {
      if (inline.type !== "text") continue;
      if (inline.props.revision?.kind === "insert") inserted += 1;
      else if (inline.props.revision?.kind === "delete") deleted += 1;
      else if (inline.props.revision?.kind === "format") formatted += 1;
    }
  }
  return { inserted, deleted, formatted };
}

/** Accepts all tracked changes in a paragraph list. */
export function acceptAllChanges(doc: DocDocument): { accepted: number } {
  let accepted = 0;
  for (const { paragraph } of listParagraphs(doc)) {
    accepted += acceptParagraph(doc, paragraph);
  }
  mergeMarkedParagraphs(doc);
  doc.revisions = [];
  doc.metadata.modified = new Date().toISOString();
  return { accepted };
}

/** Rejects all tracked changes. */
export function rejectAllChanges(doc: DocDocument): { rejected: number } {
  let rejected = 0;
  for (const { paragraph } of listParagraphs(doc)) {
    rejected += rejectParagraphParagraphOnly(paragraph);
  }
  doc.revisions = [];
  doc.metadata.modified = new Date().toISOString();
  return { rejected };
}

function acceptParagraph(doc: DocDocument, paragraph: Paragraph): number {
  let count = 0;
  const kept: Inline[] = [];
  for (const inline of paragraph.inlines) {
    if (inline.type === "text" && inline.props.revision?.kind === "delete") {
      count += 1;
      continue;
    }
    if (inline.type === "text" && inline.props.revision?.kind === "insert") {
      const props = { ...inline.props };
      delete props.revision;
      kept.push({ ...inline, props });
      count += 1;
      continue;
    }
    if (inline.type === "text" && inline.props.revision?.kind === "format") {
      count += 1;
      const props = { ...inline.props };
      delete props.revision;
      kept.push({ ...inline, props });
      continue;
    }
    kept.push(inline);
  }
  paragraph.inlines = kept;
  if (paragraph.revision?.kind === "delete") count += 1;
  void doc;
  return count;
}

function rejectParagraphParagraphOnly(paragraph: Paragraph): number {
  let count = 0;
  const kept: Inline[] = [];
  for (const inline of paragraph.inlines) {
    if (inline.type === "text" && inline.props.revision?.kind === "insert") {
      count += 1;
      continue;
    }
    if (inline.type === "text" && inline.props.revision) {
      count += 1;
      const props = { ...inline.props };
      delete props.revision;
      kept.push({ ...inline, props });
      continue;
    }
    kept.push(inline);
  }
  paragraph.inlines = kept;
  if (paragraph.revision) {
    delete paragraph.revision;
    count += 1;
  }
  return count;
}

/** Merges paragraphs whose paragraph mark was accepted as deleted. */
function mergeMarkedParagraphs(doc: DocDocument): void {
  for (const section of doc.sections) {
    const blocks = section.blocks;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index];
      if (block.type !== "paragraph" || block.revision?.kind !== "delete")
        continue;
      const next = blocks[index + 1];
      delete block.revision;
      if (next && next.type === "paragraph") {
        block.inlines.push(...next.inlines);
        blocks.splice(index + 1, 1);
      }
    }
  }
}

/** Accepts or rejects one revision id. */
export function resolveRevision(
  doc: DocDocument,
  revisionId: string,
  action: "accept" | "reject",
): { found: boolean } {
  let found = false;
  for (const { paragraph } of listParagraphs(doc)) {
    if (paragraph.revision?.id === revisionId) {
      found = true;
      paragraph.revision = undefined;
    }
    const kept: Inline[] = [];
    for (const inline of paragraph.inlines) {
      if (inline.type === "text" && inline.props.revision?.id === revisionId) {
        found = true;
        const kind = inline.props.revision.kind;
        if (action === "accept") {
          if (kind === "delete") continue;
          const props = { ...inline.props };
          delete props.revision;
          kept.push({ ...inline, props });
          continue;
        }
        if (kind === "insert") continue;
        const props = { ...inline.props };
        delete props.revision;
        kept.push({ ...inline, props });
        continue;
      }
      kept.push(inline);
    }
    paragraph.inlines = kept;
  }
  doc.revisions = doc.revisions.filter(
    (revision) => revision.id !== revisionId,
  );
  doc.metadata.modified = new Date().toISOString();
  return { found };
}

/** Text of a paragraph without deleted content (used by the review pane). */
export function acceptedText(paragraph: Paragraph): string {
  return paragraphText(paragraph, "final");
}

/** Ensures the caret follows a paragraph that may have been removed. */
export function locateParagraphForCaret(
  doc: DocDocument,
  preferredId: string,
): string {
  if (findParagraph(doc, preferredId)) return preferredId;
  const blocks = listBlocks(doc);
  return blocks[0]?.block.id ?? "";
}

/** Creates a paragraph after `reference` and returns it (used by review replies). */
export function appendBlockParagraph(
  doc: DocDocument,
  reference: Paragraph,
  text: string,
): Paragraph {
  const created: Paragraph = {
    type: "paragraph",
    id: newId(doc, "p"),
    style: reference.style,
    props: {},
    inlines: text ? [{ type: "text", text, props: {} }] : [],
  };
  insertParagraphAfter(doc, reference, created);
  return created;
}
