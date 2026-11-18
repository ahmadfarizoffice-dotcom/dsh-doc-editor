/**
 * Review pane: comment threads (reply, resolve, reopen, delete, jump to anchor)
 * and tracked-change accept/reject.
 */
import { useMemo, useState } from "react";
import {
  acceptAllChanges,
  commentThreads,
  deleteComment,
  pendingRevisions,
  replyToComment,
  rejectAllChanges,
  revisionSummary,
  setCommentResolved,
} from "@dsh-doc/core/model";
import type { DocComment } from "@dsh-doc/core/model";
import { commentText } from "../model/dom";
import type { AppSnapshot, AppStore } from "../app/state";

interface CommentsPaneProps {
  store: AppStore;
  snapshot: AppSnapshot;
}

function commentPreview(comment: DocComment): string {
  return commentText(comment).trim() || "(empty comment)";
}

export function CommentsPane({
  store,
  snapshot,
}: CommentsPaneProps): React.JSX.Element {
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const model = snapshot.document;

  const threads = useMemo(
    () => commentThreads(model),
    [document, snapshot.documentVersion],
  );

  const revisions = useMemo(
    () => pendingRevisions(model),
    [document, snapshot.documentVersion],
  );

  const summary = useMemo(
    () => revisionSummary(model),
    [document, snapshot.documentVersion],
  );
  const activeId = snapshot.ui.activeCommentId;

  const jumpTo = (comment: DocComment, thread: DocComment): void => {
    const paragraphId =
      comment.anchor?.paragraphId ?? thread.anchor?.paragraphId;
    if (!paragraphId) {
      store.toast("This comment has no anchor in the document", "info");
      return;
    }
    const element = globalThis.document.getElementById(`block-${paragraphId}`);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    const start = (comment.anchor ?? thread.anchor)?.start ?? 0;
    const end = (comment.anchor ?? thread.anchor)?.end ?? start;
    store.setSelection(
      { blockId: paragraphId, inlineIndex: 0, offset: start },
      { blockId: paragraphId, inlineIndex: 0, offset: end },
    );
  };

  return (
    <aside
      className="pane pane-right"
      aria-label="Comments and tracked changes"
    >
      <header className="pane-header">
        <h2>Review</h2>
        <span className="pane-count">{threads.length}</span>
      </header>

      <section
        className="revision-summary"
        aria-label="Tracked changes summary"
      >
        <p>
          Tracked changes:{" "}
          <strong>{model.settings.trackRevisions ? "recording" : "off"}</strong>
        </p>
        <p className="hint">
          {summary.inserted} inserted · {summary.deleted} deleted ·{" "}
          {summary.formatted} formatted · {revisions.length} revision records
        </p>
        <div className="pane-actions">
          <button
            type="button"
            className="button small"
            onClick={() =>
              store.apply("Accept all changes", (target) => {
                acceptAllChanges(target);
              })
            }
            disabled={revisions.length === 0}
          >
            Accept all
          </button>
          <button
            type="button"
            className="button small"
            onClick={() =>
              store.apply("Reject all changes", (target) => {
                rejectAllChanges(target);
              })
            }
            disabled={revisions.length === 0}
          >
            Reject all
          </button>
          <button
            type="button"
            className="button small"
            onClick={() =>
              store.apply("Toggle track changes", (target) => {
                target.settings.trackRevisions =
                  !target.settings.trackRevisions;
              })
            }
          >
            {model.settings.trackRevisions ? "Stop tracking" : "Track changes"}
          </button>
        </div>
      </section>

      {threads.length === 0 ? (
        <p className="pane-empty">
          Select text and use “Insert comment” to start a review thread.
        </p>
      ) : (
        <ul className="comment-list">
          {threads.map((thread) => {
            const threadComment = thread as DocComment;
            return (
              <li
                key={thread.id}
                className={[
                  "comment-thread",
                  thread.resolved ? "resolved" : "",
                  activeId === thread.id ? "active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <div className="comment-head">
                  <span className="avatar" aria-hidden="true">
                    {thread.initials ?? thread.author.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <span className="comment-author">{thread.author}</span>
                    <span className="comment-date">
                      {thread.date
                        ? new Date(thread.date).toLocaleString()
                        : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => jumpTo(threadComment, threadComment)}
                    title="Jump to the comment anchor"
                  >
                    Jump
                  </button>
                </div>
                <p className="comment-body">{commentPreview(threadComment)}</p>

                {thread.replies.length > 0 ? (
                  <ul className="comment-replies">
                    {thread.replies.map((reply) => (
                      <li key={reply.id}>
                        <span className="reply-author">{reply.author}</span>
                        <p>{commentPreview(reply)}</p>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => jumpTo(reply, threadComment)}
                        >
                          Jump to anchor
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="reply-row">
                  <label
                    className="visually-hidden"
                    htmlFor={`reply-${thread.id}`}
                  >
                    Reply to {thread.author}
                  </label>
                  <input
                    id={`reply-${thread.id}`}
                    type="text"
                    placeholder="Reply…"
                    value={replyDrafts[thread.id] ?? ""}
                    onChange={(event) =>
                      setReplyDrafts((drafts) => ({
                        ...drafts,
                        [thread.id]: event.target.value,
                      }))
                    }
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      const text = (replyDrafts[thread.id] ?? "").trim();
                      if (!text) return;
                      store.apply("Reply to comment", (target) => {
                        replyToComment(target, thread.id, text);
                      });
                      setReplyDrafts((drafts) => ({
                        ...drafts,
                        [thread.id]: "",
                      }));
                    }}
                  />
                  <button
                    type="button"
                    className="button small"
                    onClick={() => {
                      const text = (replyDrafts[thread.id] ?? "").trim();
                      if (!text) return;
                      store.apply("Reply to comment", (target) => {
                        replyToComment(target, thread.id, text);
                      });
                      setReplyDrafts((drafts) => ({
                        ...drafts,
                        [thread.id]: "",
                      }));
                    }}
                  >
                    Reply
                  </button>
                </div>

                <div className="comment-actions">
                  <button
                    type="button"
                    className="button small"
                    onClick={() =>
                      store.apply(
                        thread.resolved ? "Reopen comment" : "Resolve comment",
                        (target) => {
                          setCommentResolved(
                            target,
                            thread.id,
                            !thread.resolved,
                          );
                        },
                      )
                    }
                  >
                    {thread.resolved ? "Reopen" : "Resolve"}
                  </button>
                  <button
                    type="button"
                    className="button small danger"
                    onClick={() => {
                      store.apply("Delete comment", (target) => {
                        deleteComment(target, thread.id);
                      });
                      if (activeId === thread.id)
                        store.setUi({ activeCommentId: null });
                    }}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      store.setUi({
                        activeCommentId:
                          activeId === thread.id ? null : thread.id,
                      })
                    }
                  >
                    {activeId === thread.id
                      ? "Clear highlight"
                      : "Highlight in text"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
