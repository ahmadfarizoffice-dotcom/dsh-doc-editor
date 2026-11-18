/**
 * Document navigation pane: heading outline generated from the live model.
 */
import { useMemo } from "react";
import { documentOutline } from "@dsh-doc/core/model";
import type { AppSnapshot, AppStore } from "../app/state";

interface OutlinePaneProps {
  store: AppStore;
  snapshot: AppSnapshot;
}

export function OutlinePane({
  store,
  snapshot,
}: OutlinePaneProps): React.JSX.Element {
  // `document` is mutated in place; `documentVersion` invalidates the memo.
   
  const entries = useMemo(
    () => documentOutline(snapshot.document),
    [snapshot.document, snapshot.documentVersion],
  );

  return (
    <aside className="pane pane-left" aria-label="Document outline">
      <header className="pane-header">
        <h2>Outline</h2>
        <span className="pane-count">{entries.length}</span>
      </header>
      {entries.length === 0 ? (
        <p className="pane-empty">
          No headings yet. Apply the <strong>Title</strong>,{" "}
          <strong>Heading 1</strong> or <strong>Heading 2</strong> style from
          the style gallery to build the outline and the table of contents.
        </p>
      ) : (
        <nav className="outline-list" aria-label="Headings">
          {entries.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={
                entry.blockId === store.selection.focus.blockId
                  ? "outline-item active"
                  : "outline-item"
              }
              style={{
                paddingLeft: `${8 + Math.max(0, entry.level - 1) * 14}px`,
              }}
              title={`${entry.text} (level ${entry.level})`}
              onClick={() => {
                const element = document.getElementById(
                  `block-${entry.blockId}`,
                );
                element?.scrollIntoView({
                  behavior: "smooth",
                  block: "center",
                });
                store.setSelection(
                  { blockId: entry.blockId, inlineIndex: 0, offset: 0 },
                  { blockId: entry.blockId, inlineIndex: 0, offset: 0 },
                );
                element?.focus();
              }}
            >
              <span className="outline-level" aria-hidden="true">
                {entry.level === 0 ? "T" : entry.level}
              </span>
              <span className="outline-text">{entry.text}</span>
            </button>
          ))}
        </nav>
      )}
    </aside>
  );
}
