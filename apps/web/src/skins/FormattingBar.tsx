/**
 * Shared formatting controls used by every skin's toolbar, ribbon and inspector.
 *
 * A skin selects the item ids and grouping it needs; the rendering, active
 * states, disabled reasons and keyboard behaviour are defined once here. Every
 * enabled item calls `SkinActions`, never the document directly.
 */
import type { ReactNode } from "react";
import type { AppSnapshot } from "../app/state";
import type { SkinActions } from "./actions";
import { LINE_SPACING, type FormattingState } from "./formatting";
import {
  ColorControl,
  FontSelect,
  FontSizeSelect,
  NumberField,
  Popover,
  SelectControl,
  SizeStepper,
  StyleSelect,
  ToolButton,
  ZoomSelect,
} from "./controls";
import { Icon } from "./icons";
import { MenuBar } from "./MenuBar";
import type { MenuDefinition } from "./menus";
import { UNIMPLEMENTED } from "./unimplemented";

export type FormatItemId =
  | "|"
  | "undo"
  | "redo"
  | "print"
  | "paintFormat"
  | "formatPainter"
  | "zoom"
  | "styles"
  | "font"
  | "size"
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "superscript"
  | "subscript"
  | "smallCaps"
  | "caps"
  | "textColor"
  | "highlight"
  | "link"
  | "comment"
  | "image"
  | "chart"
  | "shape"
  | "table"
  | "pageBreak"
  | "sectionBreak"
  | "footnote"
  | "toc"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "alignJustify"
  | "lineSpacing"
  | "paragraph"
  | "pageSetup"
  | "bulletList"
  | "numberList"
  | "checklist"
  | "indent"
  | "outdent"
  | "clearFormatting"
  | "case"
  | "find"
  | "trackChanges"
  | "formatMarks"
  | "more"
  | "newDoc"
  | "open"
  | "save"
  | "exportPdf"
  | "cut"
  | "copy"
  | "paste";

export interface FormatGroup {
  id: string;
  label?: string;
  items: readonly FormatItemId[];
}

function isPressed(
  state: FormattingState,
  item: FormatItemId,
): boolean | undefined {
  switch (item) {
    case "bold":
      return Boolean(state.run.bold);
    case "italic":
      return Boolean(state.run.italic);
    case "underline":
      return Boolean(state.run.underline && state.run.underline !== "none");
    case "strike":
      return Boolean(state.run.strike);
    case "smallCaps":
      return Boolean(state.run.smallCaps);
    case "caps":
      return Boolean(state.run.caps);
    case "superscript":
      return state.run.vertAlign === "superscript";
    case "subscript":
      return state.run.vertAlign === "subscript";
    case "alignLeft":
      return state.paragraph.alignment === "left";
    case "alignCenter":
      return state.paragraph.alignment === "center";
    case "alignRight":
      return state.paragraph.alignment === "right";
    case "alignJustify":
      return state.paragraph.alignment === "justify";
    case "bulletList":
      return state.inBulletList;
    case "numberList":
      return state.inNumberList;
    case "trackChanges":
      return undefined;
    case "formatMarks":
      return undefined;
    default:
      return undefined;
  }
}

function ParagraphPanel({
  actions,
  state,
}: {
  actions: SkinActions;
  state: FormattingState;
}): React.JSX.Element {
  return (
    <div className="s-paragraph-panel">
      <div className="s-panel-row">
        <NumberField
          id="skin-space-before"
          label="Before"
          value={state.paragraph.spaceBefore ?? 0}
          min={0}
          suffix="pt"
          onChange={actions.setSpaceBefore}
        />
        <NumberField
          id="skin-space-after"
          label="After"
          value={state.paragraph.spaceAfter ?? 0}
          min={0}
          suffix="pt"
          onChange={actions.setSpaceAfter}
        />
      </div>
      <div className="s-panel-row">
        <NumberField
          id="skin-indent-left"
          label="Left"
          value={state.paragraph.indent?.left ?? 0}
          min={0}
          step={9}
          suffix="pt"
          onChange={actions.setIndentLeft}
        />
        <NumberField
          id="skin-indent-right"
          label="Right"
          value={state.paragraph.indent?.right ?? 0}
          min={0}
          step={9}
          suffix="pt"
          onChange={actions.setIndentRight}
        />
      </div>
      <div className="s-panel-row">
        <SelectControl
          id="skin-first-line"
          label="First line"
          value={
            state.paragraph.indent?.hanging
              ? "hanging"
              : state.paragraph.indent?.firstLine
                ? "firstLine"
                : "none"
          }
          options={[
            { value: "none", label: "No first-line indent" },
            { value: "firstLine", label: "First line (36pt)" },
            { value: "hanging", label: "Hanging (36pt)" },
          ]}
          onChange={(value) =>
            actions.setFirstLine(value as "none" | "firstLine" | "hanging")
          }
          title="First-line indent"
        />
      </div>
      <div className="s-panel-actions">
        <button
          type="button"
          className="s-small-button"
          onClick={actions.resetIndents}
        >
          Reset indents
        </button>
        <button
          type="button"
          className="s-small-button"
          onClick={actions.defaultSpacing}
        >
          Default spacing
        </button>
      </div>
    </div>
  );
}

function moreFormattingMenu(
  actions: SkinActions,
  state: FormattingState,
  snapshot: AppSnapshot,
): MenuDefinition {
  const items: MenuDefinition["items"] = [
    { kind: "heading", id: "more-character", label: "Character" },
    {
      kind: "action",
      id: "more-strike",
      label: "Strikethrough",
      checked: Boolean(state.run.strike),
      onSelect: () => actions.toggleMark("strike"),
    },
    {
      kind: "action",
      id: "more-super",
      label: "Superscript",
      checked: state.run.vertAlign === "superscript",
      onSelect: () => actions.setRunProps({ vertAlign: "superscript" }),
    },
    {
      kind: "action",
      id: "more-sub",
      label: "Subscript",
      checked: state.run.vertAlign === "subscript",
      onSelect: () => actions.setRunProps({ vertAlign: "subscript" }),
    },
    {
      kind: "action",
      id: "more-small-caps",
      label: "Small caps",
      checked: Boolean(state.run.smallCaps),
      onSelect: () => actions.toggleMark("smallCaps"),
    },
    {
      kind: "action",
      id: "more-caps",
      label: "All caps",
      checked: Boolean(state.run.caps),
      onSelect: () => actions.toggleMark("caps"),
    },
    { kind: "separator", id: "more-sep-1" },
    { kind: "heading", id: "more-paragraph", label: "Paragraph" },
    {
      kind: "action",
      id: "more-clear",
      label: "Clear formatting",
      disabled: !state.hasRange,
      disabledReason: "Select text first.",
      onSelect: actions.clearFormatting,
    },
    {
      kind: "action",
      id: "more-marks",
      label: "Toggle formatting marks",
      checked: snapshot.ui.showFormattingMarks,
      onSelect: actions.toggleFormattingMarks,
    },
    {
      kind: "action",
      id: "more-find",
      label: "Find and replace…",
      shortcut: "Ctrl+F",
      onSelect: actions.openFind,
    },
    {
      kind: "action",
      id: "more-track",
      label: "Track changes",
      checked: snapshot.document.settings.trackRevisions,
      onSelect: actions.toggleTrackChanges,
    },
  ];
  return {
    id: "more-format",
    label: "More formatting",
    ariaLabel: "More formatting options",
    icon: "more",
    items,
  };
}

function FormatControl({
  item,
  actions,
  snapshot,
  state,
  sizeStyle,
}: {
  item: FormatItemId;
  actions: SkinActions;
  snapshot: AppSnapshot;
  state: FormattingState;
  sizeStyle: "stepper" | "select";
}): ReactNode {
  switch (item) {
    case "|":
      return null;
    case "undo":
      return (
        <ToolButton
          label="Undo"
          shortcut="Ctrl+Z"
          disabled={!snapshot.canUndo}
          title={!snapshot.canUndo ? "Nothing to undo" : "Undo (Ctrl+Z)"}
          onClick={actions.undo}
        >
          <Icon name="undo" />
        </ToolButton>
      );
    case "redo":
      return (
        <ToolButton
          label="Redo"
          shortcut="Ctrl+Y"
          disabled={!snapshot.canRedo}
          title={!snapshot.canRedo ? "Nothing to redo" : "Redo (Ctrl+Y)"}
          onClick={actions.redo}
        >
          <Icon name="redo" />
        </ToolButton>
      );
    case "print":
      return (
        <ToolButton
          label="Print preview"
          shortcut="Ctrl+P"
          title="Print preview (Ctrl+P)"
          onClick={actions.print}
        >
          <Icon name="print" />
        </ToolButton>
      );
    case "paintFormat":
    case "formatPainter":
      return (
        <ToolButton
          label="Paint format"
          disabled
          title={UNIMPLEMENTED.paintFormat}
        >
          <Icon name="paint" />
        </ToolButton>
      );
    case "zoom":
      return <ZoomSelect value={snapshot.ui.zoom} onChange={actions.setZoom} />;
    case "styles":
      return (
        <StyleSelect
          value={state.styleId}
          options={state.styles}
          onChange={actions.applyStyle}
        />
      );
    case "font":
      return (
        <FontSelect
          value={state.run.fontFamily ?? ""}
          onChange={(family) => actions.setRunProps({ fontFamily: family })}
        />
      );
    case "size":
      if (sizeStyle === "select")
        return (
          <FontSizeSelect
            value={state.run.fontSize ?? 11}
            onChange={actions.setFontSize}
          />
        );
      return (
        <SizeStepper
          value={state.run.fontSize ?? 11}
          onChange={actions.setFontSize}
        />
      );
    case "bold":
      return (
        <ToolButton
          label="Bold"
          shortcut="Ctrl+B"
          pressed={isPressed(state, item)}
          onClick={() => actions.toggleMark("bold")}
        >
          <span className="s-glyph-bold">B</span>
        </ToolButton>
      );
    case "italic":
      return (
        <ToolButton
          label="Italic"
          shortcut="Ctrl+I"
          pressed={isPressed(state, item)}
          onClick={() => actions.toggleMark("italic")}
        >
          <span className="s-glyph-italic">I</span>
        </ToolButton>
      );
    case "underline":
      return (
        <ToolButton
          label="Underline"
          shortcut="Ctrl+U"
          pressed={isPressed(state, item)}
          onClick={() => actions.toggleMark("underline")}
        >
          <span className="s-glyph-underline">U</span>
        </ToolButton>
      );
    case "strike":
      return (
        <ToolButton
          label="Strikethrough"
          pressed={isPressed(state, item)}
          onClick={() => actions.toggleMark("strike")}
        >
          <span className="s-glyph-strike">S</span>
        </ToolButton>
      );
    case "superscript":
      return (
        <ToolButton
          label="Superscript"
          pressed={isPressed(state, item)}
          onClick={() =>
            actions.setRunProps({
              vertAlign:
                state.run.vertAlign === "superscript"
                  ? "baseline"
                  : "superscript",
            })
          }
        >
          <span>
            x<sup>2</sup>
          </span>
        </ToolButton>
      );
    case "subscript":
      return (
        <ToolButton
          label="Subscript"
          pressed={isPressed(state, item)}
          onClick={() =>
            actions.setRunProps({
              vertAlign:
                state.run.vertAlign === "subscript" ? "baseline" : "subscript",
            })
          }
        >
          <span>
            x<sub>2</sub>
          </span>
        </ToolButton>
      );
    case "smallCaps":
      return (
        <ToolButton
          label="Small caps"
          pressed={isPressed(state, item)}
          onClick={() => actions.toggleMark("smallCaps")}
        >
          <span className="s-glyph-smallcaps">Aᴀ</span>
        </ToolButton>
      );
    case "caps":
      return (
        <ToolButton
          label="All caps"
          pressed={isPressed(state, item)}
          onClick={() => actions.toggleMark("caps")}
        >
          <span>AA</span>
        </ToolButton>
      );
    case "textColor":
      return (
        <ColorControl
          label="Text colour"
          value={state.run.color ?? "#000000"}
          onChange={actions.setColor}
          glyph={
            <span className="s-color-letter">
              A<span className="s-color-bar" />
            </span>
          }
        />
      );
    case "highlight":
      return (
        <ColorControl
          label="Highlight colour"
          value={state.run.highlight ?? "#ffff00"}
          onChange={actions.setHighlight}
          glyph={<span className="s-highlight-glyph">▮</span>}
        />
      );
    case "link":
      return (
        <ToolButton
          label="Insert link"
          shortcut="Ctrl+K"
          onClick={actions.openLink}
        >
          <Icon name="link" />
        </ToolButton>
      );
    case "comment":
      return (
        <ToolButton label="Insert comment" onClick={actions.openComment}>
          <Icon name="commentAdd" />
        </ToolButton>
      );
    case "image":
      return (
        <ToolButton label="Insert image" onClick={actions.pickImage}>
          <Icon name="image" />
        </ToolButton>
      );
    case "chart":
      return (
        <ToolButton label="Insert chart" disabled title={UNIMPLEMENTED.chart}>
          <Icon name="chart" />
        </ToolButton>
      );
    case "shape":
      return (
        <ToolButton label="Insert shape" disabled title={UNIMPLEMENTED.shape}>
          <Icon name="shape" />
        </ToolButton>
      );
    case "table":
      return (
        <ToolButton label="Insert table" onClick={actions.openTable}>
          <Icon name="table" />
        </ToolButton>
      );
    case "pageBreak":
      return (
        <ToolButton label="Insert page break" onClick={actions.insertPageBreak}>
          <Icon name="pageBreak" />
        </ToolButton>
      );
    case "sectionBreak":
      return (
        <ToolButton
          label="Insert section break"
          onClick={actions.openSectionBreak}
        >
          <Icon name="sectionBreak" />
        </ToolButton>
      );
    case "footnote":
      return (
        <ToolButton label="Insert footnote" onClick={actions.openFootnote}>
          <Icon name="footnote" />
        </ToolButton>
      );
    case "toc":
      return (
        <ToolButton label="Insert table of contents" onClick={actions.openToc}>
          <Icon name="toc" />
        </ToolButton>
      );
    case "alignLeft":
      return (
        <ToolButton
          label="Align left"
          pressed={isPressed(state, item)}
          onClick={() => actions.setAlignment("left")}
        >
          <Icon name="alignLeft" />
        </ToolButton>
      );
    case "alignCenter":
      return (
        <ToolButton
          label="Align centre"
          pressed={isPressed(state, item)}
          onClick={() => actions.setAlignment("center")}
        >
          <Icon name="alignCenter" />
        </ToolButton>
      );
    case "alignRight":
      return (
        <ToolButton
          label="Align right"
          pressed={isPressed(state, item)}
          onClick={() => actions.setAlignment("right")}
        >
          <Icon name="alignRight" />
        </ToolButton>
      );
    case "alignJustify":
      return (
        <ToolButton
          label="Justify"
          pressed={isPressed(state, item)}
          onClick={() => actions.setAlignment("justify")}
        >
          <Icon name="alignJustify" />
        </ToolButton>
      );
    case "lineSpacing":
      return (
        <SelectControl
          id="skin-line-spacing"
          label="Line spacing"
          value={String((state.paragraph.lineSpacing?.value ?? 240) / 240)}
          options={LINE_SPACING.map((option) => ({
            value: String(option.value),
            label: option.label,
          }))}
          onChange={(value) => actions.setLineSpacing(Number(value))}
          className="s-spacing-select"
          title="Line spacing"
        />
      );
    case "paragraph":
      return (
        <Popover
          label="Paragraph spacing and indents"
          title="Paragraph spacing and indents"
          icon="formatMarks"
          align="end"
        >
          <ParagraphPanel actions={actions} state={state} />
        </Popover>
      );
    case "pageSetup":
      return (
        <ToolButton label="Page setup" onClick={actions.openPageSetup}>
          <Icon name="page" />
        </ToolButton>
      );
    case "bulletList":
      return (
        <ToolButton
          label="Bulleted list"
          pressed={isPressed(state, item)}
          onClick={() => actions.toggleList("bullet")}
        >
          <Icon name="bulletList" />
        </ToolButton>
      );
    case "numberList":
      return (
        <ToolButton
          label="Numbered list"
          pressed={isPressed(state, item)}
          onClick={() => actions.toggleList("number")}
        >
          <Icon name="numberList" />
        </ToolButton>
      );
    case "checklist":
      return (
        <ToolButton label="Checklist" disabled title={UNIMPLEMENTED.checklist}>
          <Icon name="checklist" />
        </ToolButton>
      );
    case "indent":
      return (
        <ToolButton label="Increase indent" onClick={() => actions.indent(1)}>
          <Icon name="indentIncrease" />
        </ToolButton>
      );
    case "outdent":
      return (
        <ToolButton label="Decrease indent" onClick={() => actions.indent(-1)}>
          <Icon name="indentDecrease" />
        </ToolButton>
      );
    case "clearFormatting":
      return (
        <ToolButton
          label="Clear formatting"
          disabled={!state.hasRange}
          title={
            !state.hasRange
              ? "Select text to clear its formatting"
              : "Clear formatting"
          }
          onClick={actions.clearFormatting}
        >
          <Icon name="clearFormat" />
        </ToolButton>
      );
    case "case":
      return (
        <SelectControl
          id="skin-case"
          label="Change case"
          value=""
          options={[
            { value: "", label: "Aa" },
            { value: "upper", label: "UPPERCASE" },
            { value: "lower", label: "lowercase" },
            { value: "title", label: "Title Case" },
            { value: "sentence", label: "Sentence case" },
          ]}
          onChange={(value) => {
            if (value)
              actions.changeCase(
                value as "upper" | "lower" | "title" | "sentence",
              );
          }}
          className="s-case-select"
          title="Change case"
          disabled={!state.hasRange}
        />
      );
    case "find":
      return (
        <ToolButton
          label="Find and replace"
          shortcut="Ctrl+F"
          onClick={actions.openFind}
        >
          <Icon name="find" />
        </ToolButton>
      );
    case "trackChanges":
      return (
        <ToolButton
          label="Track changes"
          pressed={snapshot.document.settings.trackRevisions}
          onClick={actions.toggleTrackChanges}
        >
          <Icon name="trackChanges" />
        </ToolButton>
      );
    case "formatMarks":
      return (
        <ToolButton
          label="Formatting marks"
          pressed={snapshot.ui.showFormattingMarks}
          onClick={actions.toggleFormattingMarks}
        >
          <Icon name="formatMarks" />
        </ToolButton>
      );
    case "more":
      return (
        <MenuBar
          menus={[moreFormattingMenu(actions, state, snapshot)]}
          align="end"
        />
      );
    case "newDoc":
      return (
        <ToolButton label="New document" onClick={actions.newDocument}>
          <Icon name="newDoc" />
        </ToolButton>
      );
    case "open":
      return (
        <ToolButton label="Open document" onClick={actions.openFiles}>
          <Icon name="open" />
        </ToolButton>
      );
    case "save":
      return (
        <ToolButton
          label="Save"
          shortcut="Ctrl+S"
          disabled={snapshot.saving}
          title={snapshot.saving ? "Saving…" : "Save (Ctrl+S)"}
          onClick={actions.save}
        >
          <Icon name="save" />
        </ToolButton>
      );
    case "exportPdf": {
      const formats = snapshot.health?.capabilities.formats ?? [];
      const available = formats.includes("pdf");
      return (
        <ToolButton
          label="Export PDF"
          disabled={!available}
          title={
            available
              ? "Export as PDF"
              : "PDF export is unavailable: the server reports no PDF backend."
          }
          onClick={() => actions.exportDocument("pdf")}
        >
          <Icon name="export" />
        </ToolButton>
      );
    }
    case "cut":
      return (
        <ToolButton label="Cut" disabled title={UNIMPLEMENTED.cut}>
          <Icon name="cut" />
        </ToolButton>
      );
    case "copy":
      return (
        <ToolButton label="Copy" disabled title={UNIMPLEMENTED.copy}>
          <Icon name="copy" />
        </ToolButton>
      );
    case "paste":
      return (
        <ToolButton label="Paste" disabled title={UNIMPLEMENTED.paste}>
          <Icon name="paste" />
        </ToolButton>
      );
    default:
      return null;
  }
}

export interface FormatButtonsProps {
  actions: SkinActions;
  snapshot: AppSnapshot;
  state: FormattingState;
  groups: readonly FormatGroup[];
  sizeStyle?: "stepper" | "select";
  label?: string;
  className?: string;
  showLabels?: boolean;
}

export function FormatButtons({
  actions,
  snapshot,
  state,
  groups,
  sizeStyle = "select",
  label = "Formatting",
  className,
  showLabels = false,
}: FormatButtonsProps): React.JSX.Element {
  return (
    <div
      className={className ? `s-formatbar ${className}` : "s-formatbar"}
      role="toolbar"
      aria-label={label}
    >
      {groups.map((group) => (
        <div className="s-fmt-group" key={group.id}>
          {showLabels && group.label ? (
            <span className="s-fmt-label">{group.label}</span>
          ) : null}
          <div className="s-fmt-items">
            {group.items.map((item, index) =>
              item === "|" ? (
                <span
                  className="s-format-separator"
                  role="separator"
                  key={`${group.id}-sep-${index}`}
                />
              ) : (
                <FormatControl
                  key={`${group.id}-${item}-${index}`}
                  item={item}
                  actions={actions}
                  snapshot={snapshot}
                  state={state}
                  sizeStyle={sizeStyle}
                />
              ),
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
