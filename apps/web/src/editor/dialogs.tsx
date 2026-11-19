/**
 * Modal dialogs. All of them operate on the model through real operations;
 * none of them inject HTML into the surface.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  PAGE_PRESETS,
  findParagraph,
  setPageSetup,
  textOffsetToPosition,
} from "@dsh-doc/core/model";
import type { PageSetup } from "@dsh-doc/core/model";
import type { ReactNode } from "react";
import type { AppStore } from "../app/state";
import { sectionIndexForPosition } from "../model/sections";
import {
  applyLinkAt,
  findMatches,
  insertCommentAt,
  insertFootnoteAt,
  insertSectionBreakAt,
  insertTableAt,
  insertTocAfterCaret,
  replaceMatches,
  selectionHasRange,
  type TextMatch,
} from "../model/ops";

interface DialogProps {
  store: AppStore;
  onClose: () => void;
}

function DialogShell(props: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  wide?: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    const node = ref.current;
    const focusable = node?.querySelector<HTMLElement>(
      "input, select, textarea, button",
    );
    focusable?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        className={props.wide ? "dialog dialog-wide" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        ref={ref}
      >
        <header className="dialog-header">
          <h2>{props.title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            onClick={props.onClose}
          >
            ✕
          </button>
        </header>
        {props.description ? (
          <p className="dialog-description">{props.description}</p>
        ) : null}
        <div className="dialog-body">{props.children}</div>
        <footer className="dialog-footer">{props.footer}</footer>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ table */

export function TableDialog({
  store,
  onClose,
}: DialogProps): React.JSX.Element {
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(3);
  const [headerRow, setHeaderRow] = useState(true);

  const submit = (): void => {
    const selection = store.selection;
    const ok = store.apply("Insert table", (document) => {
      insertTableAt(document, selection, { rows, columns, headerRow });
    });
    if (ok) store.toast("Table inserted", "success");
    onClose();
  };

  return (
    <DialogShell
      title="Insert table"
      description="Creates a real table block with per-cell paragraphs and a fixed grid."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={submit}>
            Insert table
          </button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="table-rows">Rows</label>
        <input
          id="table-rows"
          type="number"
          min={1}
          max={50}
          value={rows}
          onChange={(event) =>
            setRows(Math.max(1, Math.min(50, Number(event.target.value) || 1)))
          }
        />
      </div>
      <div className="form-row">
        <label htmlFor="table-columns">Columns</label>
        <input
          id="table-columns"
          type="number"
          min={1}
          max={20}
          value={columns}
          onChange={(event) =>
            setColumns(
              Math.max(1, Math.min(20, Number(event.target.value) || 1)),
            )
          }
        />
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={headerRow}
          onChange={(event) => setHeaderRow(event.target.checked)}
        />
        Repeat the first row as a header row
      </label>
    </DialogShell>
  );
}

/* ------------------------------------------------------------------- link */

export function LinkDialog({ store, onClose }: DialogProps): React.JSX.Element {
  const hasRange = selectionHasRange(store.session.document, store.selection);
  const [href, setHref] = useState("https://");
  const [text, setText] = useState("");

  const submit = (): void => {
    const target = href.trim();
    if (!target) {
      store.toast("Enter a URL for the link", "error");
      return;
    }
    if (!hasRange && !text.trim()) {
      store.toast("Select text first, or provide the link text", "error");
      return;
    }
    const selection = store.selection;
    const ok = store.apply("Insert hyperlink", (document) => {
      applyLinkAt(document, selection, {
        href: target,
        text: hasRange ? undefined : text.trim(),
      });
    });
    if (ok) store.toast("Hyperlink applied", "success");
    onClose();
  };

  return (
    <DialogShell
      title="Insert hyperlink"
      description={
        hasRange
          ? "The selected text becomes a hyperlink (a run mark, so it survives conversion)."
          : "No text is selected, so the link text you enter will be inserted as a link."
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={submit}>
            Apply link
          </button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="link-href">Address</label>
        <input
          id="link-href"
          type="text"
          value={href}
          onChange={(event) => setHref(event.target.value)}
          placeholder="https://example.com"
        />
      </div>
      {!hasRange ? (
        <div className="form-row">
          <label htmlFor="link-text">Text</label>
          <input
            id="link-text"
            type="text"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      ) : null}
    </DialogShell>
  );
}

/* --------------------------------------------------------------- footnote */

export function FootnoteDialog({
  store,
  onClose,
}: DialogProps): React.JSX.Element {
  const [text, setText] = useState("");

  const submit = (): void => {
    if (!text.trim()) {
      store.toast("Enter footnote text", "error");
      return;
    }
    const position = store.selection.focus;
    const ok = store.apply("Insert footnote", (document) => {
      insertFootnoteAt(document, position, text.trim());
    });
    if (ok) store.toast("Footnote inserted", "success");
    onClose();
  };

  return (
    <DialogShell
      title="Insert footnote"
      description="Adds a note reference inline and appends the note body to the document notes."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={submit}>
            Insert footnote
          </button>
        </>
      }
    >
      <div className="form-row form-row-column">
        <label htmlFor="note-text">Footnote text</label>
        <textarea
          id="note-text"
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
    </DialogShell>
  );
}

/* ---------------------------------------------------------------- comment */

export function CommentDialog({
  store,
  onClose,
}: DialogProps): React.JSX.Element {
  const [text, setText] = useState("");
  const hasRange = selectionHasRange(store.session.document, store.selection);

  const submit = (): void => {
    if (!text.trim()) {
      store.toast("Enter a comment", "error");
      return;
    }
    const selection = store.selection;
    let commentId = "";
    const ok = store.apply("Add comment", (document) => {
      commentId = insertCommentAt(document, selection, text.trim()).commentId;
    });
    if (ok) {
      store.setUi({ rightPane: "comments", activeCommentId: commentId });
      store.toast("Comment added", "success");
    }
    onClose();
  };

  return (
    <DialogShell
      title="Insert comment"
      description={
        hasRange
          ? "The selection becomes the comment anchor."
          : "The comment is anchored to the caret position."
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={submit}>
            Add comment
          </button>
        </>
      }
    >
      <div className="form-row form-row-column">
        <label htmlFor="comment-text">Comment</label>
        <textarea
          id="comment-text"
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
    </DialogShell>
  );
}

/* ---------------------------------------------------------- section break */

export function SectionBreakDialog({
  store,
  onClose,
}: DialogProps): React.JSX.Element {
  const [type, setType] = useState<"nextPage" | "continuous">("nextPage");
  const [landscape, setLandscape] = useState(false);

  const submit = (): void => {
    const selection = store.selection;
    const ok = store.apply("Insert section break", (document) => {
      insertSectionBreakAt(document, selection, { type, landscape });
    });
    if (ok) store.toast("Section break inserted", "success");
    onClose();
  };

  return (
    <DialogShell
      title="Section break"
      description="Everything after the caret moves into a new section with its own page setup."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={submit}>
            Insert break
          </button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="section-type">Break</label>
        <select
          id="section-type"
          value={type}
          onChange={(event) =>
            setType(event.target.value as "nextPage" | "continuous")
          }
        >
          <option value="nextPage">Next page</option>
          <option value="continuous">Continuous</option>
        </select>
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={landscape}
          onChange={(event) => setLandscape(event.target.checked)}
        />
        New section uses landscape orientation
      </label>
    </DialogShell>
  );
}

/* -------------------------------------------------------------- page setup */

const PAGE_SIZE_OPTIONS: Array<{ value: string; label: string }> = [
  ...Object.keys(PAGE_PRESETS).map((key) => ({
    value: key,
    label: PAGE_PRESETS[key]?.label ?? key,
  })),
  { value: "custom", label: "Custom size" },
];

function presetForPage(page: PageSetup): string {
  for (const [key, preset] of Object.entries(PAGE_PRESETS)) {
    const samePortrait =
      Math.abs(page.width - preset.width) < 0.75 &&
      Math.abs(page.height - preset.height) < 0.75;
    const sameLandscape =
      Math.abs(page.width - preset.height) < 0.75 &&
      Math.abs(page.height - preset.width) < 0.75;
    if (samePortrait || sameLandscape) return key;
  }
  return "custom";
}

const PT_PER_INCH = 72;
const toInches = (points: number): number =>
  Math.round((points / PT_PER_INCH) * 100) / 100;
const toPoints = (inches: number): number =>
  Math.round(inches * PT_PER_INCH * 100) / 100;

/**
 * Real page setup: edits the selected section's `PageSetup` through the core
 * model operation. This is not a skin-only stub; it changes document geometry,
 * which the editor surface and preview both read.
 */
export function PageSetupDialog({
  store,
  onClose,
}: DialogProps): React.JSX.Element {
  const snapshot = store.getSnapshot();
  const sectionIndex = sectionIndexForPosition(
    snapshot.document,
    store.selection.focus,
  );
  const section =
    snapshot.document.sections[sectionIndex] ?? snapshot.document.sections[0];
  const page = section?.page;
  const [preset, setPreset] = useState(() =>
    page ? presetForPage(page) : "A4",
  );
  const [width, setWidth] = useState(page?.width ?? 595.3);
  const [height, setHeight] = useState(page?.height ?? 841.9);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(
    page?.orientation ?? "portrait",
  );
  const [margins, setMargins] = useState(() => ({
    top: toInches(page?.margins.top ?? 72),
    right: toInches(page?.margins.right ?? 72),
    bottom: toInches(page?.margins.bottom ?? 72),
    left: toInches(page?.margins.left ?? 72),
  }));

  if (!page) {
    return (
      <DialogShell
        title="Page setup"
        onClose={onClose}
        footer={
          <button type="button" className="button primary" onClick={onClose}>
            Close
          </button>
        }
      >
        <p className="notice notice-warning">
          This document has no sections, so no page geometry can be edited.
        </p>
      </DialogShell>
    );
  }

  const choosePreset = (value: string): void => {
    setPreset(value);
    const chosen = PAGE_PRESETS[value];
    if (!chosen) return;
    if (orientation === "landscape") {
      setWidth(Math.max(chosen.width, chosen.height));
      setHeight(Math.min(chosen.width, chosen.height));
    } else {
      setWidth(Math.min(chosen.width, chosen.height));
      setHeight(Math.max(chosen.width, chosen.height));
    }
  };

  const chooseOrientation = (value: "portrait" | "landscape"): void => {
    setOrientation(value);
    const shouldSwap =
      (value === "landscape" && width < height) ||
      (value === "portrait" && width > height);
    if (shouldSwap) {
      setWidth(height);
      setHeight(width);
    }
  };

  const submit = (): void => {
    let nextWidth = width;
    let nextHeight = height;
    if (orientation === "landscape" && nextWidth < nextHeight) {
      nextWidth = height;
      nextHeight = width;
    }
    if (orientation === "portrait" && nextWidth > nextHeight) {
      nextWidth = height;
      nextHeight = width;
    }
    const safeMargins = {
      top: Math.max(0, toPoints(margins.top)),
      right: Math.max(0, toPoints(margins.right)),
      bottom: Math.max(0, toPoints(margins.bottom)),
      left: Math.max(0, toPoints(margins.left)),
    };
    const ok = store.apply("Page setup", (document) => {
      setPageSetup(document, sectionIndex, {
        width: Math.max(72, nextWidth),
        height: Math.max(72, nextHeight),
        orientation,
        preset: preset === "custom" ? "custom" : preset,
        margins: { ...page.margins, ...safeMargins },
      });
    });
    if (ok) store.toast("Page setup applied to this section", "success");
    onClose();
  };

  return (
    <DialogShell
      title="Page setup"
      description={`Applies to section ${sectionIndex + 1} of ${snapshot.document.sections.length} (the section containing the caret).`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={submit}>
            Apply
          </button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="page-size">Paper size</label>
        <select
          id="page-size"
          value={preset}
          onChange={(event) => choosePreset(event.target.value)}
        >
          {PAGE_SIZE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {preset === "custom" ? (
        <div className="form-grid">
          <div className="form-row">
            <label htmlFor="page-width">Width (pt)</label>
            <input
              id="page-width"
              type="number"
              min={72}
              step={1}
              value={Math.round(width)}
              onChange={(event) =>
                setWidth(Math.max(72, Number(event.target.value) || width))
              }
            />
          </div>
          <div className="form-row">
            <label htmlFor="page-height">Height (pt)</label>
            <input
              id="page-height"
              type="number"
              min={72}
              step={1}
              value={Math.round(height)}
              onChange={(event) =>
                setHeight(Math.max(72, Number(event.target.value) || height))
              }
            />
          </div>
        </div>
      ) : null}
      <div className="form-row">
        <label htmlFor="page-orientation">Orientation</label>
        <select
          id="page-orientation"
          value={orientation}
          onChange={(event) =>
            chooseOrientation(event.target.value as "portrait" | "landscape")
          }
        >
          <option value="portrait">Portrait</option>
          <option value="landscape">Landscape</option>
        </select>
      </div>
      <div className="form-grid">
        {(["top", "bottom", "left", "right"] as const).map((side) => (
          <div className="form-row" key={side}>
            <label htmlFor={`margin-${side}`}>Margin {side} (in)</label>
            <input
              id={`margin-${side}`}
              type="number"
              min={0}
              max={4}
              step={0.1}
              value={margins[side]}
              onChange={(event) =>
                setMargins((current) => ({
                  ...current,
                  [side]: Math.max(0, Number(event.target.value) || 0),
                }))
              }
            />
          </div>
        ))}
      </div>
      <p className="hint">
        Page geometry is stored in points in the document model. The paper size
        changes the section's actual width and height; margins are converted
        from inches.
      </p>
    </DialogShell>
  );
}

/* -------------------------------------------------------------------- TOC */

export function TocDialog({ store, onClose }: DialogProps): React.JSX.Element {
  const [minLevel, setMinLevel] = useState(1);
  const [maxLevel, setMaxLevel] = useState(3);
  const [caption, setCaption] = useState("Table of Contents");

  const submit = (): void => {
    const selection = store.selection;
    const ok = store.apply("Insert table of contents", (document) => {
      insertTocAfterCaret(document, selection, {
        minLevel,
        maxLevel,
        caption: caption.trim() || undefined,
      });
    });
    if (ok) store.toast("Table of contents inserted", "success");
    onClose();
  };

  return (
    <DialogShell
      title="Insert table of contents"
      description="Generated from Heading 1–9 styles. Entries are live links back to their headings."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={submit}>
            Insert contents
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="toc-min">From level</label>
          <input
            id="toc-min"
            type="number"
            min={1}
            max={9}
            value={minLevel}
            onChange={(event) =>
              setMinLevel(
                Math.max(1, Math.min(9, Number(event.target.value) || 1)),
              )
            }
          />
        </div>
        <div className="form-row">
          <label htmlFor="toc-max">To level</label>
          <input
            id="toc-max"
            type="number"
            min={1}
            max={9}
            value={maxLevel}
            onChange={(event) =>
              setMaxLevel(
                Math.max(1, Math.min(9, Number(event.target.value) || 1)),
              )
            }
          />
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="toc-caption">Caption</label>
        <input
          id="toc-caption"
          type="text"
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
        />
      </div>
    </DialogShell>
  );
}

/* ------------------------------------------------------------ find/replace */

export function FindReplaceDialog({
  store,
  onClose,
}: DialogProps): React.JSX.Element {
  const snapshot = store.getSnapshot();
  const model = snapshot.document;
  const documentVersion = snapshot.documentVersion;
  const [query, setQuery] = useState(snapshot.ui.findQuery);
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(
    snapshot.ui.findCaseSensitive,
  );
  const [wholeWord, setWholeWord] = useState(snapshot.ui.findWholeWord);
  const matches = snapshot.ui.findMatches;
  const activeIndex = snapshot.ui.findActiveIndex;

  // Recompute when the query or the document changes.
  useEffect(() => {
    const found = query
      ? findMatches(model, query, { caseSensitive, wholeWord })
      : [];
    store.setUi({
      findQuery: query,
      findCaseSensitive: caseSensitive,
      findWholeWord: wholeWord,
      findMatches: found,
      findActiveIndex: found.length > 0 ? 0 : -1,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, documentVersion]);

  const focusMatch = useCallback(
    (match: TextMatch | undefined): void => {
      if (!match) return;
      const paragraph = findParagraph(model, match.blockId)?.paragraph;
      if (!paragraph) return;
      const start = textOffsetToPosition(paragraph, match.start);
      const end = textOffsetToPosition(paragraph, match.end);
      store.setSelection(start, end);
      globalThis.document
        .getElementById(`block-${match.blockId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    [model, store],
  );

  const step = (delta: number): void => {
    if (matches.length === 0) return;
    const next = (activeIndex + delta + matches.length) % matches.length;
    store.setUi({ findActiveIndex: next });
    focusMatch(matches[next]);
  };

  const replaceCurrent = (): void => {
    const match = matches[activeIndex];
    if (!match) return;
    const ok = store.apply("Replace", (target) => {
      replaceMatches(target, [match], replacement);
    });
    if (!ok) return;
    const found = query
      ? findMatches(store.session.document, query, { caseSensitive, wholeWord })
      : [];
    const nextIndex =
      found.length === 0 ? -1 : Math.min(activeIndex, found.length - 1);
    store.setUi({ findMatches: found, findActiveIndex: nextIndex });
    focusMatch(found[nextIndex]);
  };

  const replaceAll = (): void => {
    if (matches.length === 0) return;
    let count = 0;
    const ok = store.apply("Replace all", (target) => {
      count = replaceMatches(target, matches, replacement);
    });
    if (!ok) return;
    const found = query
      ? findMatches(store.session.document, query, { caseSensitive, wholeWord })
      : [];
    store.setUi({
      findMatches: found,
      findActiveIndex: found.length > 0 ? 0 : -1,
    });
    store.toast(
      `${count} replacement${count === 1 ? "" : "s"} made`,
      count > 0 ? "success" : "info",
    );
  };

  return (
    <DialogShell
      title="Find and replace"
      description={
        matches.length > 0
          ? `${matches.length} match${matches.length === 1 ? "" : "es"}${activeIndex >= 0 ? ` · match ${activeIndex + 1}` : ""}`
          : query
            ? "No matches in this document"
            : "Searches paragraph text across the whole document."
      }
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="button"
            onClick={() => step(-1)}
            disabled={matches.length === 0}
          >
            Previous
          </button>
          <button
            type="button"
            className="button"
            onClick={() => step(1)}
            disabled={matches.length === 0}
          >
            Next
          </button>
          <button
            type="button"
            className="button"
            onClick={replaceCurrent}
            disabled={matches.length === 0}
          >
            Replace
          </button>
          <button
            type="button"
            className="button primary"
            onClick={replaceAll}
            disabled={matches.length === 0}
          >
            Replace all
          </button>
        </>
      }
    >
      <div className="form-row">
        <label htmlFor="find-replace-input">Find</label>
        <input
          id="find-replace-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            }
          }}
        />
      </div>
      <div className="form-row">
        <label htmlFor="find-replace-value">Replace with</label>
        <input
          id="find-replace-value"
          type="text"
          value={replacement}
          onChange={(event) => setReplacement(event.target.value)}
        />
      </div>
      <div className="checkbox-row">
        <label>
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(event) => setCaseSensitive(event.target.checked)}
          />{" "}
          Match case
        </label>
        <label>
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(event) => setWholeWord(event.target.checked)}
          />{" "}
          Whole word
        </label>
      </div>
      {matches.length > 0 ? (
        <ul className="match-list" aria-label="Search results">
          {matches.slice(0, 40).map((match, index) => (
            <li key={`${match.blockId}-${match.start}-${index}`}>
              <button
                type="button"
                className={
                  index === activeIndex ? "match-item active" : "match-item"
                }
                onClick={() => {
                  store.setUi({ findActiveIndex: index });
                  focusMatch(match);
                }}
              >
                <span className="match-text">“{match.text}”</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </DialogShell>
  );
}

/* ------------------------------------------------------------------ files */

export function FilesDialog({
  store,
  onClose,
}: DialogProps): React.JSX.Element {
  const snapshot = store.getSnapshot();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const capabilities = snapshot.health?.capabilities;

  const upload = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    await store.openUpload(file);
    setBusy(false);
  };

  return (
    <DialogShell
      title="Documents"
      description={`Workspace documents are stored server-side (.workspace). ${snapshot.offline ? "The server is unreachable right now." : ""}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              void store.refreshDocuments();
            }}
          >
            Refresh
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              void store.createDocument();
            }}
          >
            New document
          </button>
        </>
      }
    >
      {snapshot.healthError ? (
        <p className="notice notice-warning">
          Server unavailable: {snapshot.healthError}. Documents cannot be
          listed, saved or imported until the API server is running.
        </p>
      ) : null}
      <div className="form-row">
        <label htmlFor="upload-docx">Import DOCX</label>
        <input
          id="upload-docx"
          ref={inputRef}
          type="file"
          accept=".docx,.dotx,.docm,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          disabled={busy || snapshot.offline}
          onChange={(event) => {
            void upload(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      <p className="hint">
        {capabilities?.docx
          ? "DOCX import is provided by the server's OOXML adapter."
          : "The server reports no DOCX adapter (501). Import will fail with an explicit error instead of guessing."}
      </p>
      <ul className="document-list">
        {snapshot.documents.length === 0 ? (
          <li className="document-empty">No documents in the workspace yet.</li>
        ) : (
          snapshot.documents.map((entry) => (
            <li
              key={entry.id}
              className={
                entry.id === snapshot.documentId
                  ? "document-item current"
                  : "document-item"
              }
            >
              <div className="document-meta">
                <span className="document-title">
                  {entry.title || entry.id}
                </span>
                <span className="document-sub">
                  {entry.kind.toUpperCase()} ·{" "}
                  {Math.max(1, Math.round(entry.bytes / 1024))} KB ·{" "}
                  {entry.updatedAt
                    ? new Date(entry.updatedAt).toLocaleString()
                    : "unknown time"}
                </span>
              </div>
              <div className="document-actions">
                <button
                  type="button"
                  className="button small"
                  onClick={() => {
                    void store.openDocumentById(entry.id).then((ok) => {
                      if (ok) onClose();
                    });
                  }}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="button small danger"
                  onClick={() => {
                    void store.deleteDocument(entry.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))
        )}
      </ul>
    </DialogShell>
  );
}

/* --------------------------------------------------------------- recovery */

export function RecoveryDialog({
  store,
  onClose,
}: DialogProps): React.JSX.Element {
  const dialog = store.getSnapshot().ui.dialog;
  const snapshot = dialog?.kind === "recovery" ? dialog.snapshot : null;
  if (!snapshot) {
    return <></>;
  }
  return (
    <DialogShell
      title="Unsaved changes found"
      description="A local recovery copy exists for this session. Recover it or discard it."
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="button secondary"
            onClick={() => store.discardRecovery()}
          >
            Discard
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => store.acceptRecovery()}
          >
            Recover changes
          </button>
        </>
      }
    >
      <p>
        “{snapshot.title}” · autosaved{" "}
        {new Date(snapshot.savedAt).toLocaleString()}
      </p>
      <p className="hint">
        {snapshot.document.sections.reduce(
          (sum, section) => sum + section.blocks.length,
          0,
        )}{" "}
        top-level blocks in the recovery copy.
      </p>
    </DialogShell>
  );
}

/* -------------------------------------------------------------- shortcuts */

const SHORTCUTS: Array<[string, string]> = [
  ["Ctrl/Cmd + S", "Save document"],
  ["Ctrl/Cmd + Z", "Undo"],
  ["Ctrl/Cmd + Shift + Z / Ctrl + Y", "Redo"],
  ["Ctrl/Cmd + B / I / U", "Bold / italic / underline"],
  ["Ctrl/Cmd + K", "Insert hyperlink"],
  ["Ctrl/Cmd + F", "Find and replace"],
  ["Ctrl/Cmd + P", "Print preview"],
  ["Ctrl/Cmd + Enter", "Page break"],
  ["Tab / Shift + Tab", "Increase / decrease list level"],
  ["Enter / Shift + Enter", "New paragraph / line break"],
  ["Ctrl/Cmd + Alt + 1…3", "Heading 1…3"],
  ["Ctrl/Cmd + Alt + 0", "Title style"],
];

export function ShortcutsDialog({ onClose }: DialogProps): React.JSX.Element {
  const rows = useMemo(() => SHORTCUTS, []);
  return (
    <DialogShell
      title="Keyboard shortcuts"
      onClose={onClose}
      footer={
        <button type="button" className="button primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <table className="shortcut-table">
        <tbody>
          {rows.map(([keys, action]) => (
            <tr key={keys}>
              <th scope="row">{keys}</th>
              <td>{action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </DialogShell>
  );
}
