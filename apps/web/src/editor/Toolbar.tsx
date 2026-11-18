/**
 * Formatting toolbar. Every control maps to a real model operation; there are
 * no decorative buttons. Displayed values reflect the current selection, or the
 * pending format when the caret is collapsed.
 */
import { useCallback, useMemo, useRef } from "react";
import {
  getNumberingLevel,
  listParagraphStyles,
  mergeRunProps,
  setTrackChanges,
} from "@dsh-doc/core/model";
import type { RunProps } from "@dsh-doc/core/model";
import {
  useSelectionVersion,
  type AppSnapshot,
  type AppStore,
} from "../app/state";
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

const FONT_FAMILIES = [
  "Calibri",
  "Calibri Light",
  "Arial",
  "Cambria",
  "Candara",
  "Consolas",
  "Courier New",
  "Georgia",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];

const FONT_SIZES = [
  8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72,
];

const LINE_SPACING = [
  { value: 1, label: "1.0" },
  { value: 1.15, label: "1.15" },
  { value: 1.5, label: "1.5" },
  { value: 2, label: "2.0" },
  { value: 2.5, label: "2.5" },
  { value: 3, label: "3.0" },
];

interface ToolbarProps {
  store: AppStore;
  snapshot: AppSnapshot;
}

interface ToolButtonProps {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  shortcut?: string;
  children: React.ReactNode;
}

function ToolButton({
  label,
  onClick,
  pressed,
  disabled,
  children,
  shortcut,
}: ToolButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={pressed ? "tool-button pressed" : "tool-button"}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      title={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
    >
      {children}
    </button>
  );
}

export function Toolbar({ store, snapshot }: ToolbarProps): React.JSX.Element {
  useSelectionVersion(store);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const selection = store.selection;
  const document = snapshot.document;
  // `document` is mutated in place, so `documentVersion` is the real dependency.

  const active = useMemo(
    () => readActiveFormatting(document, selection),
    [document, snapshot.documentVersion, selection],
  );
  const pending = store.session.pendingFormat;
  const hasRange = active.hasRange;
  const run: RunProps =
    !hasRange && pending ? mergeRunProps(active.run, pending) : active.run;
  const paragraph = active.paragraph;

  const styles = useMemo(
    () => listParagraphStyles(document),
    [document, snapshot.documentVersion],
  );
  const numbering = paragraph.numbering;
  const listLevel = numbering
    ? getNumberingLevel(document, numbering.numId, numbering.level)
    : undefined;
  const inBulletList = Boolean(numbering) && listLevel?.numFmt === "bullet";
  const inNumberList = Boolean(numbering) && listLevel?.numFmt !== "bullet";

  const toggle = useCallback(
    (key: ToggleKey): void => {
      const current = store.selection;
      if (!selectionHasRange(store.session.document, current)) {
        const result = applyToggleMark(store.session.document, current, key);
        store.setPendingFormat(result.pending ?? undefined);
        return;
      }
      store.apply(`Toggle ${key}`, (target) => {
        applyToggleMark(target, current, key);
      });
    },
    [store],
  );

  const patchRun = useCallback(
    (patch: RunProps): void => {
      const current = store.selection;
      if (!selectionHasRange(store.session.document, current)) {
        const base = readActiveFormatting(store.session.document, current).run;
        store.setPendingFormat(mergeRunProps(base, patch));
        return;
      }
      store.apply("Character formatting", (target) => {
        applyRunProps(target, current, patch);
      });
    },
    [store],
  );

  const patchParagraph = useCallback(
    (label: string, patch: Parameters<typeof applyParagraphProps>[2]): void => {
      store.apply(label, (target) => {
        applyParagraphProps(target, store.selection, patch);
      });
    },
    [store],
  );

  const applyStyleId = useCallback(
    (styleId: string): void => {
      store.apply(`Apply style ${styleId}`, (target) => {
        applyParagraphStyle(target, store.selection, styleId);
      });
    },
    [store],
  );

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting toolbar">
      <div className="toolbar-group">
        <ToolButton
          label="Undo"
          shortcut="Ctrl+Z"
          onClick={() => store.undo()}
          disabled={!snapshot.canUndo}
        >
          ↶
        </ToolButton>
        <ToolButton
          label="Redo"
          shortcut="Ctrl+Y"
          onClick={() => store.redo()}
          disabled={!snapshot.canRedo}
        >
          ↷
        </ToolButton>
      </div>

      <div className="toolbar-group">
        <label className="visually-hidden" htmlFor="toolbar-style">
          Paragraph style
        </label>
        <select
          id="toolbar-style"
          className="tool-select style-select"
          value={active.style ?? "Normal"}
          onChange={(event) => applyStyleId(event.target.value)}
          title="Paragraph style (Title, Heading 1–9, …)"
        >
          {styles.map((style) => (
            <option key={style.id} value={style.id}>
              {style.name}
            </option>
          ))}
        </select>

        <label className="visually-hidden" htmlFor="toolbar-font">
          Font family
        </label>
        <select
          id="toolbar-font"
          className="tool-select"
          value={run.fontFamily ?? ""}
          onChange={(event) => patchRun({ fontFamily: event.target.value })}
          title="Font family"
        >
          {run.fontFamily && !FONT_FAMILIES.includes(run.fontFamily) ? (
            <option value={run.fontFamily}>{run.fontFamily}</option>
          ) : null}
          {FONT_FAMILIES.map((family) => (
            <option key={family} value={family} style={{ fontFamily: family }}>
              {family}
            </option>
          ))}
        </select>

        <label className="visually-hidden" htmlFor="toolbar-size">
          Font size
        </label>
        <select
          id="toolbar-size"
          className="tool-select size-select"
          value={String(run.fontSize ?? 11)}
          onChange={(event) =>
            patchRun({ fontSize: Number(event.target.value) })
          }
          title="Font size (points)"
        >
          {run.fontSize && !FONT_SIZES.includes(run.fontSize) ? (
            <option value={String(run.fontSize)}>{run.fontSize}</option>
          ) : null}
          {FONT_SIZES.map((size) => (
            <option key={size} value={String(size)}>
              {size}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar-group">
        <ToolButton
          label="Bold"
          shortcut="Ctrl+B"
          pressed={Boolean(run.bold)}
          onClick={() => toggle("bold")}
        >
          <strong>B</strong>
        </ToolButton>
        <ToolButton
          label="Italic"
          shortcut="Ctrl+I"
          pressed={Boolean(run.italic)}
          onClick={() => toggle("italic")}
        >
          <em>I</em>
        </ToolButton>
        <ToolButton
          label="Underline"
          shortcut="Ctrl+U"
          pressed={Boolean(run.underline && run.underline !== "none")}
          onClick={() => toggle("underline")}
        >
          <span className="underline-glyph">U</span>
        </ToolButton>
        <ToolButton
          label="Strikethrough"
          pressed={Boolean(run.strike)}
          onClick={() => toggle("strike")}
        >
          <span className="strike-glyph">S</span>
        </ToolButton>
        <ToolButton
          label="Superscript"
          pressed={run.vertAlign === "superscript"}
          onClick={() =>
            patchRun({
              vertAlign:
                run.vertAlign === "superscript" ? "baseline" : "superscript",
            })
          }
        >
          x<sup>2</sup>
        </ToolButton>
        <ToolButton
          label="Subscript"
          pressed={run.vertAlign === "subscript"}
          onClick={() =>
            patchRun({
              vertAlign:
                run.vertAlign === "subscript" ? "baseline" : "subscript",
            })
          }
        >
          x<sub>2</sub>
        </ToolButton>
        <ToolButton
          label="Small caps"
          pressed={Boolean(run.smallCaps)}
          onClick={() => toggle("smallCaps")}
        >
          <span className="smallcaps-glyph">Aᴀ</span>
        </ToolButton>
        <ToolButton
          label="All caps"
          pressed={Boolean(run.caps)}
          onClick={() => toggle("caps")}
        >
          AA
        </ToolButton>
      </div>

      <div className="toolbar-group">
        <label className="color-control" title="Text colour">
          <span className="color-label" aria-hidden="true">
            A
          </span>
          <input
            type="color"
            aria-label="Text colour"
            value={run.color ?? "#000000"}
            onChange={(event) => patchRun({ color: event.target.value })}
          />
        </label>
        <label className="color-control highlight" title="Highlight colour">
          <span className="color-label" aria-hidden="true">
            ▮
          </span>
          <input
            type="color"
            aria-label="Highlight colour"
            value={run.highlight ?? "#ffff00"}
            onChange={(event) => patchRun({ highlight: event.target.value })}
          />
        </label>
        <ToolButton
          label="Clear character formatting"
          onClick={() =>
            store.apply("Clear formatting", (target) => {
              clearSelectionFormatting(target, store.selection);
            })
          }
          disabled={!hasRange}
        >
          ⌫
        </ToolButton>
        <label className="visually-hidden" htmlFor="toolbar-case">
          Change case
        </label>
        <select
          id="toolbar-case"
          className="tool-select"
          value=""
          onChange={(event) => {
            const mode = event.target.value as CaseMode;
            event.target.value = "";
            if (!mode) return;
            store.apply("Change case", (target) => {
              transformRangeText(target, store.selection, mode);
            });
          }}
          title="Change case"
          disabled={!hasRange}
        >
          <option value="">Aa</option>
          <option value="upper">UPPERCASE</option>
          <option value="lower">lowercase</option>
          <option value="title">Title Case</option>
          <option value="sentence">Sentence case</option>
        </select>
      </div>

      <div className="toolbar-group">
        <ToolButton
          label="Align left"
          pressed={paragraph.alignment === "left"}
          onClick={() =>
            applyAlignment(store.session.document, store.selection, "left")
          }
        >
          ≡
        </ToolButton>
        <ToolButton
          label="Align centre"
          pressed={paragraph.alignment === "center"}
          onClick={() =>
            applyAlignment(store.session.document, store.selection, "center")
          }
        >
          ⋮≡
        </ToolButton>
        <ToolButton
          label="Align right"
          pressed={paragraph.alignment === "right"}
          onClick={() =>
            applyAlignment(store.session.document, store.selection, "right")
          }
        >
          ≡⋮
        </ToolButton>
        <ToolButton
          label="Justify"
          pressed={paragraph.alignment === "justify"}
          onClick={() =>
            applyAlignment(store.session.document, store.selection, "justify")
          }
        >
          ⇹
        </ToolButton>
      </div>

      <div className="toolbar-group">
        <ToolButton
          label="Bulleted list"
          pressed={inBulletList}
          onClick={() =>
            store.apply("Bulleted list", (target) => {
              toggleList(target, store.selection, "bullet");
            })
          }
        >
          •≡
        </ToolButton>
        <ToolButton
          label="Numbered list"
          pressed={inNumberList}
          onClick={() =>
            store.apply("Numbered list", (target) => {
              toggleList(target, store.selection, "number");
            })
          }
        >
          1.≡
        </ToolButton>
        <ToolButton
          label="Decrease list level"
          onClick={() =>
            store.apply("Decrease list level", (target) => {
              changeListLevel(target, store.selection, -1);
            })
          }
          disabled={!numbering}
        >
          ⇤
        </ToolButton>
        <ToolButton
          label="Increase list level"
          onClick={() =>
            store.apply("Increase list level", (target) => {
              changeListLevel(target, store.selection, 1);
            })
          }
          disabled={!numbering}
        >
          ⇥
        </ToolButton>
      </div>

      <div className="toolbar-group">
        <label className="visually-hidden" htmlFor="toolbar-line-spacing">
          Line spacing
        </label>
        <select
          id="toolbar-line-spacing"
          className="tool-select"
          value={String((paragraph.lineSpacing?.value ?? 240) / 240)}
          onChange={(event) => {
            applyLineSpacing(
              store.session.document,
              store.selection,
              Number(event.target.value),
            );
          }}
          title="Line spacing"
        >
          {LINE_SPACING.map((option) => (
            <option key={option.value} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>

        <details className="popover">
          <summary
            className="tool-button"
            title="Paragraph spacing and indents"
          >
            ¶
          </summary>
          <div className="popover-panel">
            <div className="form-row">
              <label htmlFor="paragraph-before">Space before (pt)</label>
              <input
                id="paragraph-before"
                type="number"
                min={0}
                step={1}
                value={Math.round(paragraph.spaceBefore ?? 0)}
                onChange={(event) =>
                  applyParagraphSpacing(
                    store.session.document,
                    store.selection,
                    { before: Number(event.target.value) },
                  )
                }
              />
            </div>
            <div className="form-row">
              <label htmlFor="paragraph-after">Space after (pt)</label>
              <input
                id="paragraph-after"
                type="number"
                min={0}
                step={1}
                value={Math.round(paragraph.spaceAfter ?? 0)}
                onChange={(event) =>
                  applyParagraphSpacing(
                    store.session.document,
                    store.selection,
                    { after: Number(event.target.value) },
                  )
                }
              />
            </div>
            <div className="form-row">
              <label htmlFor="indent-left">Left indent (pt)</label>
              <input
                id="indent-left"
                type="number"
                min={0}
                step={9}
                value={Math.round(paragraph.indent?.left ?? 0)}
                onChange={(event) =>
                  applyIndent(store.session.document, store.selection, {
                    left: Number(event.target.value),
                  })
                }
              />
            </div>
            <div className="form-row">
              <label htmlFor="indent-right">Right indent (pt)</label>
              <input
                id="indent-right"
                type="number"
                min={0}
                step={9}
                value={Math.round(paragraph.indent?.right ?? 0)}
                onChange={(event) =>
                  applyIndent(store.session.document, store.selection, {
                    right: Number(event.target.value),
                  })
                }
              />
            </div>
            <div className="form-row">
              <label htmlFor="indent-first">First line</label>
              <select
                id="indent-first"
                value={
                  paragraph.indent?.hanging
                    ? "hanging"
                    : paragraph.indent?.firstLine
                      ? "firstLine"
                      : "none"
                }
                onChange={(event) => {
                  const mode = event.target.value;
                  if (mode === "none") {
                    applyIndent(store.session.document, store.selection, {
                      clearFirstLine: true,
                      clearHanging: true,
                    });
                  } else if (mode === "hanging") {
                    applyIndent(store.session.document, store.selection, {
                      hanging: 36,
                      clearFirstLine: true,
                    });
                  } else {
                    applyIndent(store.session.document, store.selection, {
                      firstLine: 36,
                      clearHanging: true,
                    });
                  }
                }}
              >
                <option value="none">None</option>
                <option value="firstLine">First line (36pt)</option>
                <option value="hanging">Hanging (36pt)</option>
              </select>
            </div>
            <div className="popover-actions">
              <button
                type="button"
                className="button small"
                onClick={() =>
                  applyIndent(store.session.document, store.selection, {
                    left: 0,
                    right: 0,
                    clearFirstLine: true,
                    clearHanging: true,
                  })
                }
              >
                Reset indents
              </button>
              <button
                type="button"
                className="button small"
                onClick={() =>
                  patchParagraph("Default spacing", {
                    spaceBefore: 0,
                    spaceAfter: 8,
                  })
                }
              >
                Default spacing
              </button>
            </div>
          </div>
        </details>
      </div>

      <div className="toolbar-group">
        <ToolButton
          label="Insert table"
          onClick={() => store.openDialog({ kind: "table" })}
        >
          ▦
        </ToolButton>
        <ToolButton
          label="Insert image"
          onClick={() => imageInputRef.current?.click()}
        >
          🖼
        </ToolButton>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="visually-hidden"
          aria-label="Insert image file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
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
                store.toast(
                  "The selected file is not a readable image",
                  "error",
                );
              image.src = dataUrl;
            };
            reader.onerror = () =>
              store.toast("Could not read the selected image", "error");
            reader.readAsDataURL(file);
          }}
        />
        <ToolButton
          label="Insert hyperlink"
          shortcut="Ctrl+K"
          onClick={() => store.openDialog({ kind: "link" })}
        >
          🔗
        </ToolButton>
        <ToolButton
          label="Insert page break"
          onClick={() =>
            store.apply("Insert page break", (target) => {
              insertPageBreakAt(target, store.selection.focus);
            })
          }
        >
          ⤓
        </ToolButton>
        <ToolButton
          label="Insert section break"
          onClick={() => store.openDialog({ kind: "section-break" })}
        >
          ▤
        </ToolButton>
        <ToolButton
          label="Insert table of contents"
          onClick={() => store.openDialog({ kind: "toc" })}
        >
          ☰
        </ToolButton>
        <ToolButton
          label="Insert footnote"
          onClick={() => store.openDialog({ kind: "footnote" })}
        >
          ⁿ
        </ToolButton>
        <ToolButton
          label="Insert comment"
          onClick={() => store.openDialog({ kind: "comment" })}
        >
          💬
        </ToolButton>
      </div>

      <div className="toolbar-group">
        <ToolButton
          label="Track changes"
          pressed={document.settings.trackRevisions}
          onClick={() => {
            const next = !document.settings.trackRevisions;
            store.apply(
              next ? "Enable track changes" : "Disable track changes",
              (target) => {
                setTrackChanges(target, next);
              },
            );
          }}
        >
          ✎
        </ToolButton>
        <ToolButton
          label="Find and replace"
          shortcut="Ctrl+F"
          onClick={() => store.openDialog({ kind: "find" })}
        >
          🔍
        </ToolButton>
        <ToolButton
          label="Toggle formatting marks"
          pressed={snapshot.ui.showFormattingMarks}
          onClick={() =>
            store.setUi({
              showFormattingMarks: !snapshot.ui.showFormattingMarks,
            })
          }
        >
          ¶
        </ToolButton>
      </div>
    </div>
  );
}
