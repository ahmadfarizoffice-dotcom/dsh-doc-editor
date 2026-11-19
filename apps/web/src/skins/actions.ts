/**
 * One action layer shared by all four skins.
 *
 * Every chrome control across the skins calls into this object. The functions
 * are the same document operations the original toolbar used (`model/ops` and
 * `@dsh-doc/core/model`); skins never mutate the document themselves. Actions
 * read the live selection and document at call time because the model is mutated
 * in place and React props can be one render behind a click.
 */
import {
  acceptAllChanges,
  getNumberingLevel,
  mergeRunProps,
  rejectAllChanges,
  setTrackChanges,
} from "@dsh-doc/core/model";
import type { RunProps } from "@dsh-doc/core/model";
import type { AppStore } from "../app/state";
import {
  applyAlignment,
  applyIndent,
  applyLineSpacing,
  applyParagraphProps,
  applyParagraphSpacing,
  applyParagraphStyle,
  applyRunProps,
  applyToggleMark,
  changeListLevel,
  clearSelectionFormatting,
  insertImageAt,
  insertPageBreakAt,
  readActiveFormatting,
  selectionHasRange,
  toggleList,
  transformRangeText,
  type CaseMode,
  type ToggleKey,
} from "../model/ops";

export type Alignment = Parameters<typeof applyAlignment>[2];

export interface SkinActions {
  /* lifecycle */
  undo(): void;
  redo(): void;
  save(): void;
  newDocument(): void;
  openFiles(): void;
  preview(): void;
  print(): void;
  exportDocument(format: string): void;
  openPageSetup(): void;
  openShortcuts(): void;
  cycleView(): void;

  /* insert */
  openTable(): void;
  pickImage(): void;
  openLink(): void;
  openComment(): void;
  openFootnote(): void;
  openToc(): void;
  openFind(): void;
  insertPageBreak(): void;
  openSectionBreak(): void;

  /* character formatting */
  toggleMark(key: ToggleKey): void;
  setRunProps(patch: RunProps): void;
  setColor(color: string): void;
  setHighlight(color: string): void;
  setFontSize(size: number): void;
  changeCase(mode: CaseMode): void;
  clearFormatting(): void;

  /* paragraph formatting */
  applyStyle(styleId: string): void;
  setAlignment(alignment: Alignment): void;
  setLineSpacing(multiple: number): void;
  setSpaceBefore(points: number): void;
  setSpaceAfter(points: number): void;
  setIndentLeft(points: number): void;
  setIndentRight(points: number): void;
  setFirstLine(mode: "none" | "firstLine" | "hanging"): void;
  resetIndents(): void;
  defaultSpacing(): void;
  toggleList(kind: "bullet" | "number"): void;
  changeListLevel(delta: number): void;
  indent(delta: 1 | -1): void;

  /* review / view */
  toggleTrackChanges(): void;
  acceptAllChanges(): void;
  rejectAllChanges(): void;
  toggleFormattingMarks(): void;
  toggleComments(): void;
  toggleAi(): void;
  toggleOutline(): void;
  setZoom(zoom: number): void;
}

/** Opens a file picker and inserts the chosen image through the model op. */
function pickImageFile(store: AppStore): void {
  const input = globalThis.document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      if (!dataUrl) return;
      const image = new Image();
      image.onload = () => {
        const width = Math.min(420, (image.naturalWidth * 72) / 96);
        const height = Math.max(
          1,
          width * (image.naturalHeight / image.naturalWidth),
        );
        const position = store.selection.focus;
        store.apply("Insert image", (target) => {
          insertImageAt(target, position, {
            dataUrl,
            width,
            height,
            naturalWidthPx: image.naturalWidth,
            naturalHeightPx: image.naturalHeight,
            alt: file.name,
            fileName: file.name,
          });
        });
      };
      image.onerror = () =>
        store.toast("The selected file is not a readable image", "error");
      image.src = dataUrl;
    };
    reader.onerror = () =>
      store.toast("Could not read the selected image", "error");
    reader.readAsDataURL(file);
  });
  input.click();
}

export function createSkinActions(store: AppStore): SkinActions {
  const applyParagraph = (
    label: string,
    mutate: Parameters<AppStore["apply"]>[1],
  ): void => {
    store.apply(label, mutate);
  };

  const toggleMark = (key: ToggleKey): void => {
    const document = store.session.document;
    const selection = store.selection;
    if (!selectionHasRange(document, selection)) {
      const result = applyToggleMark(document, selection, key);
      store.setPendingFormat(result.pending ?? undefined);
      return;
    }
    store.apply(`Toggle ${key}`, (target) => {
      applyToggleMark(target, selection, key);
    });
  };

  const setRunProps = (patch: RunProps): void => {
    const document = store.session.document;
    const selection = store.selection;
    if (!selectionHasRange(document, selection)) {
      const base = readActiveFormatting(document, selection).run;
      store.setPendingFormat(mergeRunProps(base, patch));
      return;
    }
    store.apply("Character formatting", (target) => {
      applyRunProps(target, selection, patch);
    });
  };

  const cycleView = (): void => {
    const snapshot = store.getSnapshot();
    store.setView(snapshot.ui.view === "editor" ? "preview" : "editor");
  };

  return {
    undo: () => store.undo(),
    redo: () => store.redo(),
    save: () => void store.save(),
    newDocument: () => void store.createDocument(),
    openFiles: () => store.openDialog({ kind: "files" }),
    preview: () => store.setView("preview"),
    print: () => store.setView("preview"),
    exportDocument: (format) => void store.exportDocument(format),
    openPageSetup: () => store.openDialog({ kind: "page-setup" }),
    openShortcuts: () => store.openDialog({ kind: "shortcuts" }),
    cycleView,

    openTable: () => store.openDialog({ kind: "table" }),
    pickImage: () => pickImageFile(store),
    openLink: () => store.openDialog({ kind: "link" }),
    openComment: () => store.openDialog({ kind: "comment" }),
    openFootnote: () => store.openDialog({ kind: "footnote" }),
    openToc: () => store.openDialog({ kind: "toc" }),
    openFind: () => store.openDialog({ kind: "find" }),
    insertPageBreak: () => {
      const position = store.selection.focus;
      store.apply("Insert page break", (target) => {
        insertPageBreakAt(target, position);
      });
    },
    openSectionBreak: () => store.openDialog({ kind: "section-break" }),

    toggleMark,
    setRunProps,
    setColor: (color) => setRunProps({ color }),
    setHighlight: (highlight) => setRunProps({ highlight }),
    setFontSize: (fontSize) => setRunProps({ fontSize }),
    changeCase: (mode) => {
      const selection = store.selection;
      store.apply("Change case", (target) => {
        transformRangeText(target, selection, mode);
      });
    },
    clearFormatting: () => {
      const selection = store.selection;
      store.apply("Clear formatting", (target) => {
        clearSelectionFormatting(target, selection);
      });
    },

    applyStyle: (styleId) => {
      const selection = store.selection;
      store.apply(`Apply style ${styleId}`, (target) => {
        applyParagraphStyle(target, selection, styleId);
      });
    },
    setAlignment: (alignment) => {
      const selection = store.selection;
      applyParagraph(`Align ${alignment}`, (target) => {
        applyAlignment(target, selection, alignment);
      });
    },
    setLineSpacing: (multiple) => {
      const selection = store.selection;
      store.apply("Line spacing", (target) => {
        applyLineSpacing(target, selection, multiple);
      });
    },
    setSpaceBefore: (points) => {
      const selection = store.selection;
      applyParagraph("Space before", (target) => {
        applyParagraphSpacing(target, selection, { before: points });
      });
    },
    setSpaceAfter: (points) => {
      const selection = store.selection;
      applyParagraph("Space after", (target) => {
        applyParagraphSpacing(target, selection, { after: points });
      });
    },
    setIndentLeft: (points) => {
      const selection = store.selection;
      applyParagraph("Left indent", (target) => {
        applyIndent(target, selection, { left: points });
      });
    },
    setIndentRight: (points) => {
      const selection = store.selection;
      applyParagraph("Right indent", (target) => {
        applyIndent(target, selection, { right: points });
      });
    },
    setFirstLine: (mode) => {
      const selection = store.selection;
      applyParagraph("First line indent", (target) => {
        if (mode === "none") {
          applyIndent(target, selection, {
            clearFirstLine: true,
            clearHanging: true,
          });
        } else if (mode === "hanging") {
          applyIndent(target, selection, {
            hanging: 36,
            clearFirstLine: true,
          });
        } else {
          applyIndent(target, selection, {
            firstLine: 36,
            clearHanging: true,
          });
        }
      });
    },
    resetIndents: () => {
      const selection = store.selection;
      applyParagraph("Reset indents", (target) => {
        applyIndent(target, selection, {
          left: 0,
          right: 0,
          clearFirstLine: true,
          clearHanging: true,
        });
      });
    },
    defaultSpacing: () => {
      const selection = store.selection;
      applyParagraph("Default spacing", (target) => {
        applyParagraphProps(target, selection, {
          spaceBefore: 0,
          spaceAfter: 8,
        });
      });
    },
    toggleList: (kind) => {
      const selection = store.selection;
      store.apply(
        kind === "bullet" ? "Bulleted list" : "Numbered list",
        (target) => {
          toggleList(target, selection, kind);
        },
      );
    },
    changeListLevel: (delta) => {
      const selection = store.selection;
      store.apply("List level", (target) => {
        changeListLevel(target, selection, delta);
      });
    },
    indent: (delta) => {
      const document = store.session.document;
      const selection = store.selection;
      const paragraph = readActiveFormatting(document, selection).paragraph;
      if (paragraph.numbering) {
        store.apply("List level", (target) => {
          changeListLevel(target, selection, delta);
        });
        return;
      }
      const current = paragraph.indent?.left ?? 0;
      const next = Math.max(0, current + delta * 36);
      store.apply(
        delta > 0 ? "Increase indent" : "Decrease indent",
        (target) => {
          applyIndent(target, selection, { left: next });
        },
      );
    },

    toggleTrackChanges: () => {
      const document = store.getSnapshot().document;
      const next = !document.settings.trackRevisions;
      store.apply(
        next ? "Enable track changes" : "Disable track changes",
        (target) => {
          setTrackChanges(target, next);
        },
      );
    },
    acceptAllChanges: () =>
      store.apply("Accept all changes", (target) => {
        acceptAllChanges(target);
      }),
    rejectAllChanges: () =>
      store.apply("Reject all changes", (target) => {
        rejectAllChanges(target);
      }),
    toggleFormattingMarks: () => {
      const snapshot = store.getSnapshot();
      store.setUi({ showFormattingMarks: !snapshot.ui.showFormattingMarks });
    },
    toggleComments: () => {
      const snapshot = store.getSnapshot();
      store.setUi({
        rightPane: snapshot.ui.rightPane === "comments" ? "none" : "comments",
      });
    },
    toggleAi: () => {
      const snapshot = store.getSnapshot();
      store.setUi({
        rightPane: snapshot.ui.rightPane === "ai" ? "none" : "ai",
      });
    },
    toggleOutline: () => {
      const snapshot = store.getSnapshot();
      store.setUi({ showOutline: !snapshot.ui.showOutline });
    },
    setZoom: (zoom) => store.setZoom(zoom),
  };
}

/** Reads the live list level for skins that disable list-level controls. */
export function currentListLevel(
  store: AppStore,
): ReturnType<typeof getNumberingLevel> {
  const document = store.session.document;
  const paragraph = readActiveFormatting(document, store.selection).paragraph;
  const numbering = paragraph.numbering;
  return numbering
    ? getNumberingLevel(document, numbering.numId, numbering.level)
    : undefined;
}
