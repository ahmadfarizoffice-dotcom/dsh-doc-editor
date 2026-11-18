/**
 * Controlled `contenteditable` editing surface.
 *
 * The document model is the source of truth: every user intent is intercepted,
 * translated into a model operation from `model/ops.ts`, applied to the
 * session, and the DOM is then re-rendered from the new model with the caret
 * restored from the model selection. Native DOM mutation is only tolerated
 * while an IME composition is active, and is reconciled on `compositionend`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { appendParagraph, resolveParagraphProps } from "@dsh-doc/core/model";
import type { DocDocument, RunProps, TextPosition } from "@dsh-doc/core/model";
import type { AppStore } from "../app/state";
import { createRenderContext, ptToPx, renderBlock } from "../model/dom";
import {
  buildRenderIndex,
  readDomSelection,
  selectionToPositions,
  writeDomSelection,
  type EditorSelection,
  type RenderIndex,
} from "../model/selection";
import {
  canDeleteBackward,
  canDeleteForward,
  changeListLevel,
  clearSelectionFormatting,
  collapsed,
  deleteBackward,
  deleteForward,
  deleteSelection,
  insertImageAt,
  insertLineBreakAt,
  insertPageBreakAt,
  insertTabAt,
  insertTextAtSelection,
  listLabels,
  paragraphsInRange,
  readActiveFormatting,
  selectionRange,
  splitParagraphAt,
  toggleRunMark,
  type TextMatch,
  type ToggleKey,
} from "../model/ops";

export interface EditableSurfaceProps {
  store: AppStore;
  document: DocDocument;
  /** Increments whenever the document changes (the model is mutated in place). */
  version: number;
  zoom: number;
  searchMatches: TextMatch[];
  activeMatch: TextMatch | null;
  activeCommentId: string | null;
  showFormattingMarks: boolean;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the selected file"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function measureImage(
  dataUrl: string,
): Promise<{ widthPx: number; heightPx: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () =>
      resolve({
        widthPx: image.naturalWidth || 320,
        heightPx: image.naturalHeight || 240,
      });
    image.onerror = () => resolve({ widthPx: 320, heightPx: 240 });
    image.src = dataUrl;
  });
}

export function EditableSurface(
  props: EditableSurfaceProps,
): React.JSX.Element {
  const { store, document, zoom, version } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const indexRef = useRef<RenderIndex<Node> | null>(null);
  const pendingCaretRef = useRef<EditorSelection | null>(null);
  const composingRef = useRef(false);
  const hadFocusRef = useRef(false);
  /**
   * Set when `beforeinput` could not be cancelled (`defaultPrevented` stayed
   * false, which is what `document.execCommand`-driven edits and some assistive
   * technologies produce). The browser mutates the DOM anyway; the payload is
   * picked up from the following `input` event and applied to the model, then
   * the DOM is re-rendered from the model.
   */
  const fallbackInputRef = useRef<{ mode: "insert" | "other" } | null>(null);
  const [domEpoch, setDomEpoch] = useState(0);
  const blockOrder = useMemo(() => store.session.blockOrder, [store, version]);

  const context = useMemo(
    () =>
      createRenderContext(document, {
        zoom,
        searchMatches: props.searchMatches,
        activeMatch: props.activeMatch,
        activeCommentId: props.activeCommentId,
        showFormattingMarks: props.showFormattingMarks,
        listLabels: listLabels(document),
        focusedBlockId: store.session.selection.focus.blockId,
      }),
    // The document object is mutated in place: `version` is the real signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      document,
      version,
      zoom,
      props.searchMatches,
      props.activeMatch,
      props.activeCommentId,
      props.showFormattingMarks,
    ],
  );

  const rebuildIndex = useCallback((): RenderIndex<Node> | null => {
    const root = rootRef.current;
    if (!root) return null;
    const index = buildRenderIndex<Node>(root, blockOrder);
    indexRef.current = index;
    return index;
  }, [blockOrder]);

  const ensureIndex = useCallback(
    (): RenderIndex<Node> | null => indexRef.current ?? rebuildIndex(),
    [rebuildIndex],
  );

  useLayoutEffect(() => {
    rebuildIndex();
    const caret =
      pendingCaretRef.current ??
      (hadFocusRef.current ? store.session.selection : null);
    pendingCaretRef.current = null;
    if (!caret) return;
    const index = indexRef.current;
    if (index) writeDomSelection(index, caret);
  }, [version, domEpoch, rebuildIndex, store]);

  // Keep the model selection in sync with DOM caret movement (arrows, mouse,
  // browser find) so the toolbar and range operations stay accurate.
  useEffect(() => {
    const onSelectionChange = (): void => {
      if (composingRef.current) return;
      const root = rootRef.current;
      if (!root) return;
      const domSelection = readDomSelection(root);
      if (!domSelection) return;
      const index = ensureIndex();
      if (!index) return;
      const positions = selectionToPositions(
        index,
        domSelection.anchor,
        domSelection.focus,
      );
      if (!positions) return;
      store.setSelection(positions.anchor, positions.focus);
    };
    globalThis.document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      globalThis.document.removeEventListener(
        "selectionchange",
        onSelectionChange,
      );
  }, [ensureIndex, store]);

  // An editable document needs at least one paragraph.
  useEffect(() => {
    const hasBlock = document.sections.some(
      (section) => section.blocks.length > 0,
    );
    if (hasBlock) return;
    store.apply("Initialize document", (next) => {
      appendParagraph(next, "");
    });
     
  }, [document, store]);

  const applySelection = useCallback(
    (selection: EditorSelection | null): void => {
      if (!selection) return;
      store.setSelection(selection.anchor, selection.focus);
      pendingCaretRef.current = store.session.selection;
    },
    [store],
  );

  const runEdit = useCallback(
    (
      label: string,
      mutate: (next: DocDocument) => EditorSelection | null | void,
      options: { coalesce?: string } = {},
    ): boolean => {
      let result: EditorSelection | null | void = null;
      const ok = store.apply(
        label,
        (next) => {
          result = mutate(next);
        },
        options,
      );
      if (!ok) return false;
      applySelection(result ?? store.session.selection);
      store.selectionBus.notify();
      return true;
    },
    [applySelection, store],
  );

  const insertText = useCallback(
    (text: string): void => {
      const session = store.session;
      const selection = session.selection;
      const formatting = session.pendingFormat;
      runEdit(
        "Type",
        (next) => insertTextAtSelection(next, selection, text, formatting),
        {
          coalesce: `type:${selection.focus.blockId}`,
        },
      );
      store.setPendingFormat(undefined);
    },
    [runEdit, store],
  );

  const insertImageFiles = useCallback(
    async (files: File[]): Promise<void> => {
      for (const file of files) {
        const dataUrl = await readFileAsDataUrl(file);
        const size = await measureImage(dataUrl);
        const width = Math.min(420, (size.widthPx * 72) / 96);
        const height = Math.max(1, width * (size.heightPx / size.widthPx));
        const position = store.session.selection.focus;
        runEdit("Insert image", (next) => {
          try {
            return insertImageAt(next, position, {
              dataUrl,
              width,
              height,
              naturalWidthPx: size.widthPx,
              naturalHeightPx: size.heightPx,
              alt: file.name,
              fileName: file.name,
            }).selection;
          } catch (error) {
            store.toast(
              error instanceof Error ? error.message : String(error),
              "error",
            );
            return null;
          }
        });
      }
    },
    [runEdit, store],
  );

  const handleImageFiles = useCallback(
    (files: FileList | File[] | null): boolean => {
      const list = files
        ? Array.from(files as ArrayLike<File>).filter((file) =>
            file.type.startsWith("image/"),
          )
        : [];
      if (list.length === 0) return false;
      void insertImageFiles(list);
      return true;
    },
    [insertImageFiles],
  );

  const toggleMark = useCallback(
    (key: ToggleKey): void => {
      const session = store.session;
      const selection = session.selection;
      const active = readActiveFormatting(session.document, selection);
      const current = active.run[key];
      const isOn =
        current !== undefined && current !== false && current !== "none";
      const next = !isOn;
      const patch: RunProps =
        key === "underline"
          ? { underline: next ? "single" : false }
          : { [key]: next };

      if (!active.hasRange) {
        store.setPendingFormat({ ...active.run, ...patch });
        return;
      }
      runEdit(`Toggle ${key}`, (mutable) => {
        toggleRunMark(mutable, selection, key);
      });
    },
    [runEdit, store],
  );

  /* -------------------------------------------------------------- events */

  const onBeforeInput = useCallback(
    (event: React.FormEvent<HTMLDivElement>): void => {
      const native = event.nativeEvent as InputEvent;
      const inputType = native.inputType;
      if (!inputType) return;
      if (composingRef.current) {
        // Only composition events belong to an active IME session; any other
        // input type means the composition flag is stale (for example the IME
        // committed through automation) and must not disable the editor.
        if (inputType === "insertCompositionText" || inputType === "deleteCompositionText") return;
        composingRef.current = false;
      }
      if (inputType === "insertCompositionText" || inputType === "deleteCompositionText") return;

      // Nothing may mutate the DOM: the model is the source of truth.
      event.preventDefault();
      if (native.defaultPrevented === false) {
        // Non-cancelable edit (programmatic insertion). The browser will mutate
        // the DOM; capture the payload from the `input` event and reconcile.
        fallbackInputRef.current = { mode: inputType.startsWith("insert") ? "insert" : "other" };
        return;
      }
      const session = store.session;
      const selection = session.selection;

      switch (inputType) {
        case "insertText":
        case "insertReplacementText": {
          const text = native.data ?? "";
          if (text) insertText(text);
          break;
        }
        case "insertFromPaste":
        case "insertFromYank":
        case "insertFromDrop": {
          const transfer = native.dataTransfer;
          if (!transfer) break;
          if (handleImageFiles(transfer.files)) break;
          const text = transfer.getData("text/plain");
          if (text) insertText(text);
          break;
        }
        case "insertParagraph": {
          runEdit("New paragraph", (next) => {
            const range = selectionRange(next, selection);
            const isCollapsed =
              range.start.blockId === range.end.blockId &&
              range.start.inlineIndex === range.end.inlineIndex &&
              range.start.offset === range.end.offset;
            const start = isCollapsed
              ? range.start
              : deleteSelection(next, selection).focus;
            return splitParagraphAt(next, start);
          });
          break;
        }
        case "insertLineBreak": {
          runEdit("Line break", (next) =>
            insertLineBreakAt(next, selectionRange(next, selection).start),
          );
          break;
        }
        case "deleteContentBackward":
        case "deleteSoftLineBackward":
        case "deleteHardLineBackward": {
          runEdit("Delete", (next) => {
            const range = selectionRange(next, selection);
            const isCollapsed =
              range.start.blockId === range.end.blockId &&
              range.start.inlineIndex === range.end.inlineIndex &&
              range.start.offset === range.end.offset;
            if (!isCollapsed) return deleteSelection(next, selection);
            if (!canDeleteBackward(next, range.start)) return null;
            return (
              deleteBackward(next, range.start, "character") ??
              collapsed(range.start)
            );
          });
          break;
        }
        case "deleteWordBackward": {
          runEdit("Delete word", (next) => {
            const range = selectionRange(next, selection);
            if (!canDeleteBackward(next, range.start)) return null;
            return (
              deleteBackward(next, range.start, "word") ??
              collapsed(range.start)
            );
          });
          break;
        }
        case "deleteContentForward":
        case "deleteSoftLineForward":
        case "deleteHardLineForward": {
          runEdit("Delete", (next) => {
            const range = selectionRange(next, selection);
            const isCollapsed =
              range.start.blockId === range.end.blockId &&
              range.start.inlineIndex === range.end.inlineIndex &&
              range.start.offset === range.end.offset;
            if (!isCollapsed) return deleteSelection(next, selection);
            if (!canDeleteForward(next, range.start)) return null;
            return (
              deleteForward(next, range.start, "character") ??
              collapsed(range.start)
            );
          });
          break;
        }
        case "deleteWordForward": {
          runEdit("Delete word", (next) => {
            const range = selectionRange(next, selection);
            if (!canDeleteForward(next, range.start)) return null;
            return (
              deleteForward(next, range.start, "word") ?? collapsed(range.start)
            );
          });
          break;
        }
        case "deleteByCut":
        case "deleteContent":
        case "deleteByDrag": {
          runEdit("Delete selection", (next) =>
            deleteSelection(next, selection),
          );
          break;
        }
        case "formatBold":
          toggleMark("bold");
          break;
        case "formatItalic":
          toggleMark("italic");
          break;
        case "formatUnderline":
          toggleMark("underline");
          break;
        case "formatStrikeThrough":
          toggleMark("strike");
          break;
        case "formatRemove": {
          runEdit("Clear formatting", (next) => {
            clearSelectionFormatting(next, selection);
          });
          break;
        }
        default:
          // Unknown input types are suppressed so the DOM cannot diverge from
          // the model.
          break;
      }
    },
    [handleImageFiles, insertText, runEdit, store, toggleMark],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (composingRef.current) {
        if ((event.nativeEvent as KeyboardEvent).isComposing) return;
        // Stale composition flag: the IME session ended without a compositionend.
        composingRef.current = false;
      }
      const modifier = event.ctrlKey || event.metaKey;
      const session = store.session;
      const selection = session.selection;

      if (modifier) {
        switch (event.key.toLowerCase()) {
          case "s":
            event.preventDefault();
            void store.save();
            return;
          case "z":
            event.preventDefault();
            if (event.shiftKey) store.redo();
            else store.undo();
            pendingCaretRef.current = store.session.selection;
            return;
          case "y":
            event.preventDefault();
            store.redo();
            pendingCaretRef.current = store.session.selection;
            return;
          case "b":
            event.preventDefault();
            toggleMark("bold");
            return;
          case "i":
            event.preventDefault();
            toggleMark("italic");
            return;
          case "u":
            event.preventDefault();
            toggleMark("underline");
            return;
          case "k":
            event.preventDefault();
            store.openDialog({ kind: "link" });
            return;
          case "f":
            event.preventDefault();
            store.openDialog({ kind: "find" });
            return;
          case "p":
            event.preventDefault();
            store.setView("preview");
            return;
          case "enter":
            event.preventDefault();
            runEdit("Page break", (next) =>
              insertPageBreakAt(next, selectionRange(next, selection).start),
            );
            return;
          default:
            return;
        }
      }

      if (event.key === "Tab") {
        event.preventDefault();
        const paragraph = paragraphsInRange(
          session.document,
          selectionRange(session.document, selection),
        )[0];
        const isList = paragraph
          ? Boolean(
              resolveParagraphProps(session.document, paragraph.paragraph)
                .numbering,
            )
          : false;
        if (isList) {
          const delta = event.shiftKey ? -1 : 1;
          runEdit("List level", (next) => {
            changeListLevel(next, selection, delta);
          });
        } else {
          runEdit("Tab", (next) =>
            insertTabAt(next, selectionRange(next, selection).start),
          );
        }
        return;
      }

      if (event.key === "Escape") {
        if (store.getSnapshot().ui.dialog) {
          event.preventDefault();
          store.closeDialog();
        }
        return;
      }

      if (event.key === "Enter" && event.altKey) {
        event.preventDefault();
        runEdit("Page break", (next) =>
          insertPageBreakAt(next, selectionRange(next, selection).start),
        );
      }
    },
    [runEdit, store, toggleMark],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>): void => {
      if (composingRef.current) return;
      event.preventDefault();
      const transfer = event.clipboardData;
      if (!transfer) return;
      if (handleImageFiles(transfer.files)) return;
      const text = transfer.getData("text/plain");
      if (text) insertText(text);
    },
    [handleImageFiles, insertText],
  );

  const onCut = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>): void => {
      const session = store.session;
      const range = selectionRange(session.document, session.selection);
      const text = paragraphsInRange(session.document, range)
        .map((entry) => {
          const source = entry.paragraph.inlines
            .map((inline) =>
              inline.type === "text"
                ? inline.text
                : inline.type === "tab"
                  ? "\t"
                  : inline.type === "break"
                    ? "\n"
                    : "",
            )
            .join("");
          return source.slice(entry.from, entry.to);
        })
        .join("\n");
      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
      runEdit("Cut", (next) => deleteSelection(next, session.selection));
    },
    [runEdit, store],
  );

  const onCompositionStart = useCallback((): void => {
    composingRef.current = true;
  }, []);

  const onCompositionEnd = useCallback(
    (event: React.CompositionEvent<HTMLDivElement>): void => {
      composingRef.current = false;
      const text = event.data;
      // The browser mutated the DOM during composition; force a clean render
      // from the model so the DOM and the model agree again.
      setDomEpoch((epoch) => epoch + 1);
      if (text) insertText(text);
    },
    [insertText],
  );

  /**
   * Reconciliation for edits the browser applied despite `beforeinput` (see
   * `fallbackInputRef`). The DOM is about to be thrown away and rebuilt from the
   * model, so the inserted payload must reach the model first.
   */
  const onInput = useCallback(
    (event: React.FormEvent<HTMLDivElement>): void => {
      if (composingRef.current) return;
      const pending = fallbackInputRef.current;
      if (!pending) return;
      fallbackInputRef.current = null;
      const native = event.nativeEvent as InputEvent;
      const text = native.data ?? "";
      setDomEpoch((epoch) => epoch + 1);
      if (pending.mode === "insert" && text) insertText(text);
    },
    [insertText],
  );

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const target = event.target as HTMLElement;
      const toc = target.closest<HTMLElement>("[data-toc-target]");
      if (toc) {
        event.preventDefault();
        const blockId = toc.dataset.tocTarget;
        if (blockId) {
          const element = globalThis.document.getElementById(
            `block-${blockId}`,
          );
          element?.scrollIntoView({ behavior: "smooth", block: "center" });
          store.setSelection(
            { blockId, inlineIndex: 0, offset: 0 },
            { blockId, inlineIndex: 0, offset: 0 },
          );
          pendingCaretRef.current = store.session.selection;
        }
        return;
      }
      const anchor = target.closest<HTMLElement>("[data-comment-id]");
      if (anchor?.dataset.commentId) {
        store.setUi({
          rightPane: "comments",
          activeCommentId: anchor.dataset.commentId,
        });
      }
    },
    [store],
  );

  const sections = document.sections;
  const firstSection = sections[0];
  const margins = firstSection?.page.margins;
  const contentWidthPt = firstSection
    ? firstSection.page.width -
      firstSection.page.margins.left -
      firstSection.page.margins.right
    : 451;
  const paperWidth =
    contentWidthPt + (margins ? margins.left + margins.right : 0);
  const paperPadding = margins
    ? `${ptToPx(margins.top, zoom)}px ${ptToPx(margins.right, zoom)}px ${ptToPx(margins.bottom, zoom)}px ${ptToPx(margins.left, zoom)}px`
    : undefined;

  return (
    <div className="doc-scroll">
      <div
        className="doc-paper"
        style={{ width: `${ptToPx(paperWidth, zoom)}px` }}
      >
        <div
          ref={rootRef}
          className="doc-editable"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Document body"
          spellCheck
          style={{ padding: paperPadding }}
          onBeforeInput={onBeforeInput}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCut={onCut}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onFocus={() => {
            hadFocusRef.current = true;
          }}
          onBlur={() => {
            hadFocusRef.current = false;
            // A composition cannot survive focus loss; a stale flag would make
            // the surface ignore every subsequent edit.
            composingRef.current = false;
            fallbackInputRef.current = null;
          }}
          onClick={onClick}
          onDragOver={(event) => {
            if (event.dataTransfer?.types.includes("Files"))
              event.preventDefault();
          }}
          onDrop={(event) => {
            if (!event.dataTransfer) return;
            event.preventDefault();
            if (event.dataTransfer.files.length > 0) {
              handleImageFiles(event.dataTransfer.files);
              return;
            }
            const text = event.dataTransfer.getData("text/plain");
            if (text) insertText(text);
          }}
        >
          <div key={`blocks-${domEpoch}`} className="doc-sections">
            {sections.map((section, sectionIndex) => (
              <div
                className="doc-section"
                key={section.id}
                data-section={sectionIndex}
              >
                {sectionIndex > 0 ? (
                  <div
                    className="doc-section-break"
                    contentEditable={false}
                    role="separator"
                  >
                    <span className="doc-section-break-label">
                      {section.breakBefore === "continuous"
                        ? "Continuous section break"
                        : "Section break (next page)"}
                      {" · "}
                      {section.page.orientation}
                      {" · "}
                      {Math.round(section.page.width)}×
                      {Math.round(section.page.height)}pt
                    </span>
                  </div>
                ) : null}
                {section.blocks.map((block) => renderBlock(block, context))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
