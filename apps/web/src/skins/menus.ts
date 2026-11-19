/**
 * Menu definitions shared by the skin chrome.
 *
 * Menus are data, not components: the accessible `MenuBar` renders them, and
 * every enabled item calls the same `SkinActions` method as the corresponding
 * toolbar control. Items without a backend are rendered disabled with an
 * explicit reason from `unimplemented.ts`.
 */
import type { AppSnapshot } from "../app/state";
import type { FormattingState } from "./formatting";
import {
  FONT_SIZES,
  LINE_SPACING,
  ZOOM_LEVELS,
  formatZoom,
} from "./formatting";
import type { IconName } from "./icons";
import { UNIMPLEMENTED } from "./unimplemented";
import type { SkinActions } from "./actions";
import {
  SKIN_OPTIONS,
  skinOption,
  themeLabel,
  type SkinId,
  type Theme,
} from "./skin";

export interface MenuActionItem {
  kind: "action";
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  disabledReason?: string;
  checked?: boolean;
  onSelect: () => void;
}

export interface MenuSeparatorItem {
  kind: "separator";
  id: string;
}

export interface MenuHeadingItem {
  kind: "heading";
  id: string;
  label: string;
}

export type MenuItem = MenuActionItem | MenuSeparatorItem | MenuHeadingItem;

export interface MenuDefinition {
  id: string;
  label: string;
  ariaLabel?: string;
  icon?: IconName;
  items: MenuItem[];
  className?: string;
}

export interface MenuContext {
  actions: SkinActions;
  snapshot: AppSnapshot;
  state: FormattingState;
  skin: SkinId;
  theme: Theme;
  onSkinChange(skin: SkinId): void;
  onThemeChange(theme: Theme): void;
}

function action(
  id: string,
  label: string,
  onSelect: () => void,
  extra: {
    shortcut?: string;
    disabled?: boolean;
    disabledReason?: string;
    checked?: boolean;
  } = {},
): MenuActionItem {
  return { kind: "action", id, label, onSelect, ...extra };
}

function separator(id: string): MenuSeparatorItem {
  return { kind: "separator", id };
}

function heading(id: string, label: string): MenuHeadingItem {
  return { kind: "heading", id, label };
}

function unavailable(
  id: string,
  label: string,
  reason: string,
): MenuActionItem {
  return {
    kind: "action",
    id,
    label,
    disabled: true,
    disabledReason: reason,
    onSelect: () => undefined,
  };
}

const ALIGNMENTS = [
  { id: "left", label: "Align left" },
  { id: "center", label: "Align centre" },
  { id: "right", label: "Align right" },
  { id: "justify", label: "Justify" },
] as const;

type MarkKey =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "smallCaps"
  | "caps"
  | "superscript"
  | "subscript";

const CHARACTER_MARKS: ReadonlyArray<{
  id: MarkKey;
  label: string;
  shortcut?: string;
}> = [
  { id: "bold", label: "Bold", shortcut: "Ctrl+B" },
  { id: "italic", label: "Italic", shortcut: "Ctrl+I" },
  { id: "underline", label: "Underline", shortcut: "Ctrl+U" },
  { id: "strike", label: "Strikethrough" },
  { id: "superscript", label: "Superscript" },
  { id: "subscript", label: "Subscript" },
  { id: "smallCaps", label: "Small caps" },
  { id: "caps", label: "All caps" },
];

function markRun(state: FormattingState, key: MarkKey): boolean {
  if (key === "underline")
    return Boolean(state.run.underline && state.run.underline !== "none");
  if (key === "superscript") return state.run.vertAlign === "superscript";
  if (key === "subscript") return state.run.vertAlign === "subscript";
  if (key === "smallCaps") return Boolean(state.run.smallCaps);
  if (key === "caps") return Boolean(state.run.caps);
  return Boolean(state.run[key]);
}

function toggleMarkItem(ctx: MenuContext, key: MarkKey): void {
  if (key === "superscript" || key === "subscript") {
    const current = ctx.state.run.vertAlign;
    const next = current === key ? "baseline" : key;
    ctx.actions.setRunProps({ vertAlign: next });
    return;
  }
  ctx.actions.toggleMark(key);
}

export function skinMenuItems(ctx: MenuContext, prefix: string): MenuItem[] {
  return [
    heading(`${prefix}-skin-heading`, "Skin"),
    ...SKIN_OPTIONS.map((option) =>
      action(
        `${prefix}-skin-${option.id}`,
        option.name,
        () => ctx.onSkinChange(option.id),
        {
          checked: ctx.skin === option.id,
        },
      ),
    ),
    separator(`${prefix}-theme-sep`),
    heading(`${prefix}-theme-heading`, "Theme (dialogs and notifications)"),
    ...(["system", "light", "dark"] as const).map((theme) =>
      action(
        `${prefix}-theme-${theme}`,
        themeLabel(theme),
        () => ctx.onThemeChange(theme),
        { checked: ctx.theme === theme },
      ),
    ),
  ];
}

/** Compact app-bar switcher: current skin name + all four skins + theme. */
export function skinSwitcherMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "skin-switcher",
    label: `Skin: ${skinOption(ctx.skin).shortName}`,
    ariaLabel: `Switch skin and theme. Available skins: ${SKIN_OPTIONS.map(
      (option) => option.name,
    ).join(", ")}.`,
    icon: "theme",
    items: skinMenuItems(ctx, "switcher"),
    className: "s-skin-switcher",
  };
}

export function exportMenuItems(ctx: MenuContext, prefix: string): MenuItem[] {
  const formats = ctx.snapshot.health?.capabilities.formats ?? [];
  if (formats.length === 0)
    return [
      unavailable(
        `${prefix}-export-none`,
        "Export unavailable",
        "The server reports no export backend. Start the API server or build the conversion engine.",
      ),
    ];
  return formats.map((format) =>
    action(`${prefix}-export-${format}`, format.toUpperCase(), () =>
      ctx.actions.exportDocument(format),
    ),
  );
}

function styleItems(ctx: MenuContext, prefix: string, limit = 12): MenuItem[] {
  return ctx.state.styles.slice(0, limit).map((style) =>
    action(
      `${prefix}-style-${style.id}`,
      style.name,
      () => ctx.actions.applyStyle(style.id),
      {
        checked: ctx.state.styleId === style.id,
      },
    ),
  );
}

function zoomItems(ctx: MenuContext, prefix: string): MenuItem[] {
  return ZOOM_LEVELS.map((zoom) =>
    action(
      `${prefix}-zoom-${zoom}`,
      formatZoom(zoom),
      () => ctx.actions.setZoom(zoom),
      {
        checked: Math.abs(ctx.snapshot.ui.zoom - zoom) < 0.001,
      },
    ),
  );
}

export function fileMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "file",
    label: "File",
    items: [
      action("file-new", "New", ctx.actions.newDocument, {
        shortcut: "Ctrl+N",
      }),
      action("file-open", "Open…", ctx.actions.openFiles, {
        shortcut: "Ctrl+O",
      }),
      action("file-save", "Save", ctx.actions.save, {
        shortcut: "Ctrl+S",
        disabled: ctx.snapshot.saving,
        disabledReason: "A save is already in progress.",
      }),
      action("file-import", "Import DOCX…", ctx.actions.openFiles),
      separator("file-sep-1"),
      heading("file-download", "Download"),
      ...exportMenuItems(ctx, "file"),
      separator("file-sep-2"),
      action("file-page-setup", "Page setup…", ctx.actions.openPageSetup),
      action("file-print", "Print / preview", ctx.actions.print, {
        shortcut: "Ctrl+P",
      }),
      separator("file-sep-3"),
      ...skinMenuItems(ctx, "file"),
    ],
  };
}

export function editMenu(ctx: MenuContext): MenuDefinition {
  const enabled = ctx.state.hasRange;
  return {
    id: "edit",
    label: "Edit",
    items: [
      action("edit-undo", "Undo", ctx.actions.undo, {
        shortcut: "Ctrl+Z",
        disabled: !ctx.snapshot.canUndo,
        disabledReason: "Nothing to undo.",
      }),
      action("edit-redo", "Redo", ctx.actions.redo, {
        shortcut: "Ctrl+Y",
        disabled: !ctx.snapshot.canRedo,
        disabledReason: "Nothing to redo.",
      }),
      separator("edit-sep-1"),
      unavailable("edit-cut", "Cut", UNIMPLEMENTED.cut),
      unavailable("edit-copy", "Copy", UNIMPLEMENTED.copy),
      unavailable("edit-paste", "Paste", UNIMPLEMENTED.paste),
      unavailable("edit-select-all", "Select all", UNIMPLEMENTED.selectAll),
      separator("edit-sep-2"),
      action("edit-find", "Find and replace…", ctx.actions.openFind, {
        shortcut: "Ctrl+F",
      }),
      separator("edit-sep-3"),
      action("edit-clear", "Clear formatting", ctx.actions.clearFormatting, {
        disabled: !enabled,
        disabledReason: "Select text first.",
      }),
      ...skinMenuItems(ctx, "edit"),
    ],
  };
}

export function viewMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "view",
    label: "View",
    items: [
      action(
        "view-toggle",
        ctx.snapshot.ui.view === "editor"
          ? "Preview and print"
          : "Back to editor",
        ctx.actions.cycleView,
      ),
      action("view-outline", "Show outline", ctx.actions.toggleOutline, {
        checked: ctx.snapshot.ui.showOutline,
      }),
      action("view-comments", "Show comments", ctx.actions.toggleComments, {
        checked: ctx.snapshot.ui.rightPane === "comments",
      }),
      action("view-ai", "Show AI assistant", ctx.actions.toggleAi, {
        checked: ctx.snapshot.ui.rightPane === "ai",
        disabled: ctx.snapshot.health?.capabilities.ai !== true,
        disabledReason:
          ctx.snapshot.ui.aiUnavailableReason ??
          "The AI assistant is unavailable until the server reports an AI provider.",
      }),
      separator("view-sep-1"),
      action(
        "view-marks",
        "Show formatting marks",
        ctx.actions.toggleFormattingMarks,
        {
          checked: ctx.snapshot.ui.showFormattingMarks,
        },
      ),
      heading("view-zoom", "Zoom"),
      ...zoomItems(ctx, "view"),
      separator("view-sep-2"),
      ...skinMenuItems(ctx, "view"),
    ],
  };
}

export function insertMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "insert",
    label: "Insert",
    items: [
      action("insert-table", "Table…", ctx.actions.openTable),
      action("insert-image", "Image…", ctx.actions.pickImage),
      action("insert-link", "Link…", ctx.actions.openLink, {
        shortcut: "Ctrl+K",
      }),
      action("insert-comment", "Comment…", ctx.actions.openComment),
      separator("insert-sep-1"),
      action("insert-page-break", "Page break", ctx.actions.insertPageBreak, {
        shortcut: "Ctrl+Enter",
      }),
      action(
        "insert-section-break",
        "Section break…",
        ctx.actions.openSectionBreak,
      ),
      action("insert-toc", "Table of contents…", ctx.actions.openToc),
      action("insert-footnote", "Footnote…", ctx.actions.openFootnote),
      separator("insert-sep-2"),
      unavailable(
        "insert-header",
        "Header and footer",
        UNIMPLEMENTED.headerFooter,
      ),
      unavailable("insert-shape", "Shape", UNIMPLEMENTED.shape),
      unavailable("insert-chart", "Chart", UNIMPLEMENTED.chart),
      unavailable("insert-textbox", "Text box", UNIMPLEMENTED.textBox),
      unavailable("insert-symbol", "Special character", UNIMPLEMENTED.symbol),
    ],
  };
}

export function formatMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "format",
    label: "Format",
    items: [
      heading("format-text", "Text"),
      ...CHARACTER_MARKS.map((mark) =>
        action(
          `format-${mark.id}`,
          mark.label,
          () => toggleMarkItem(ctx, mark.id),
          {
            checked: markRun(ctx.state, mark.id),
            shortcut: mark.shortcut,
          },
        ),
      ),
      separator("format-sep-1"),
      heading("format-paragraph", "Paragraph"),
      ...ALIGNMENTS.map((alignment) =>
        action(
          `format-align-${alignment.id}`,
          alignment.label,
          () => ctx.actions.setAlignment(alignment.id),
          { checked: ctx.state.paragraph.alignment === alignment.id },
        ),
      ),
      action(
        "format-bullets",
        "Bulleted list",
        () => ctx.actions.toggleList("bullet"),
        { checked: ctx.state.inBulletList },
      ),
      action(
        "format-numbers",
        "Numbered list",
        () => ctx.actions.toggleList("number"),
        { checked: ctx.state.inNumberList },
      ),
      heading("format-spacing", "Line spacing"),
      ...LINE_SPACING.map((option) =>
        action(
          `format-spacing-${option.value}`,
          option.label,
          () => ctx.actions.setLineSpacing(option.value),
          {
            checked:
              Math.abs(
                (ctx.state.paragraph.lineSpacing?.value ?? 240) / 240 -
                  option.value,
              ) < 0.01,
          },
        ),
      ),
      separator("format-sep-2"),
      heading("format-styles", "Paragraph styles"),
      ...styleItems(ctx, "format"),
      separator("format-sep-3"),
      action("format-clear", "Clear formatting", ctx.actions.clearFormatting, {
        disabled: !ctx.state.hasRange,
        disabledReason: "Select text first.",
      }),
      heading("format-case", "Change case"),
      ...(
        [
          ["upper", "UPPERCASE"],
          ["lower", "lowercase"],
          ["title", "Title Case"],
          ["sentence", "Sentence case"],
        ] as const
      ).map(([mode, label]) =>
        action(
          `format-case-${mode}`,
          label,
          () => ctx.actions.changeCase(mode),
          {
            disabled: !ctx.state.hasRange,
            disabledReason: "Select text first.",
          },
        ),
      ),
    ],
  };
}

export function toolsMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "tools",
    label: "Tools",
    items: [
      action("tools-find", "Find and replace…", ctx.actions.openFind, {
        shortcut: "Ctrl+F",
      }),
      action("tools-track", "Track changes", ctx.actions.toggleTrackChanges, {
        checked: ctx.snapshot.document.settings.trackRevisions,
      }),
      action(
        "tools-marks",
        "Show formatting marks",
        ctx.actions.toggleFormattingMarks,
        {
          checked: ctx.snapshot.ui.showFormattingMarks,
        },
      ),
      separator("tools-sep-1"),
      action("tools-comments", "Comments pane", ctx.actions.toggleComments, {
        checked: ctx.snapshot.ui.rightPane === "comments",
      }),
      action("tools-ai", "AI assistant pane", ctx.actions.toggleAi, {
        checked: ctx.snapshot.ui.rightPane === "ai",
        disabled: ctx.snapshot.health?.capabilities.ai !== true,
        disabledReason:
          ctx.snapshot.ui.aiUnavailableReason ??
          "The AI assistant is unavailable until the server reports an AI provider.",
      }),
      action(
        "tools-shortcuts",
        "Keyboard shortcuts",
        ctx.actions.openShortcuts,
      ),
      separator("tools-sep-2"),
      unavailable(
        "tools-compare",
        "Compare documents",
        UNIMPLEMENTED.findAdvanced,
      ),
      unavailable(
        "tools-word-count",
        "Word count",
        "Word count is shown in the status bar.",
      ),
    ],
  };
}

export function helpMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "help",
    label: "Help",
    items: [
      action("help-shortcuts", "Keyboard shortcuts", ctx.actions.openShortcuts),
      separator("help-sep-1"),
      heading("help-about", "DSH Docs"),
      action("help-preview", "Preview and print", ctx.actions.preview),
      ...skinMenuItems(ctx, "help"),
      unavailable(
        "help-docs",
        "Online documentation",
        "No online documentation is bundled with this build.",
      ),
    ],
  };
}

export function extensionsMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "extensions",
    label: "Extensions",
    items: [
      unavailable(
        "extensions-addons",
        "Add-ons",
        "Add-ons are not implemented.",
      ),
      unavailable(
        "extensions-apps-script",
        "Apps Script",
        "Scripting is not implemented.",
      ),
      separator("extensions-sep"),
      ...skinMenuItems(ctx, "extensions"),
    ],
  };
}

export function stylesMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "styles",
    label: "Styles",
    items: [
      heading("styles-heading", "Paragraph styles"),
      ...styleItems(ctx, "styles", 40),
      separator("styles-sep"),
      unavailable(
        "styles-create",
        "Create style from selection",
        UNIMPLEMENTED.styleUpdate,
      ),
    ],
  };
}

export function tableMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "table",
    label: "Table",
    items: [
      action("table-insert", "Insert table…", ctx.actions.openTable),
      separator("table-sep"),
      unavailable("table-delete", "Delete table", UNIMPLEMENTED.tableEdit),
      unavailable(
        "table-row-above",
        "Insert row above",
        UNIMPLEMENTED.tableEdit,
      ),
      unavailable(
        "table-row-below",
        "Insert row below",
        UNIMPLEMENTED.tableEdit,
      ),
      unavailable("table-columns", "Insert columns", UNIMPLEMENTED.tableEdit),
      unavailable("table-merge", "Merge cells", UNIMPLEMENTED.tableEdit),
    ],
  };
}

export function formMenu(_ctx: MenuContext): MenuDefinition {
  return {
    id: "form",
    label: "Form",
    items: [
      unavailable("form-text", "Text field", UNIMPLEMENTED.formControl),
      unavailable("form-checkbox", "Check box", UNIMPLEMENTED.formControl),
      unavailable("form-dropdown", "Drop-down list", UNIMPLEMENTED.formControl),
      unavailable("form-button", "Push button", UNIMPLEMENTED.formControl),
    ],
  };
}

export function windowMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "window",
    label: "Window",
    items: [
      action(
        "window-outline",
        "Outline / navigator",
        ctx.actions.toggleOutline,
        {
          checked: ctx.snapshot.ui.showOutline,
        },
      ),
      action("window-comments", "Comments", ctx.actions.toggleComments, {
        checked: ctx.snapshot.ui.rightPane === "comments",
      }),
      action("window-ai", "AI assistant", ctx.actions.toggleAi, {
        checked: ctx.snapshot.ui.rightPane === "ai",
        disabled: ctx.snapshot.health?.capabilities.ai !== true,
        disabledReason:
          ctx.snapshot.ui.aiUnavailableReason ??
          "The AI assistant is unavailable until the server reports an AI provider.",
      }),
      separator("window-sep"),
      ...skinMenuItems(ctx, "window"),
    ],
  };
}

export function referencesMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "references",
    label: "References",
    items: [
      action("refs-toc", "Table of contents…", ctx.actions.openToc),
      action("refs-footnote", "Footnote…", ctx.actions.openFootnote),
      separator("refs-sep"),
      unavailable("refs-bookmark", "Bookmark", UNIMPLEMENTED.bookmark),
      unavailable("refs-caption", "Caption", UNIMPLEMENTED.bookmark),
    ],
  };
}

export function layoutMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "layout",
    label: "Layout",
    items: [
      action("layout-page-setup", "Page setup…", ctx.actions.openPageSetup),
      action(
        "layout-section-break",
        "Section break…",
        ctx.actions.openSectionBreak,
      ),
      action("layout-page-break", "Page break", ctx.actions.insertPageBreak),
      separator("layout-sep"),
      heading("layout-spacing", "Line spacing"),
      ...LINE_SPACING.map((option) =>
        action(`layout-spacing-${option.value}`, option.label, () =>
          ctx.actions.setLineSpacing(option.value),
        ),
      ),
      separator("layout-sep-2"),
      heading("layout-zoom", "Zoom"),
      ...zoomItems(ctx, "layout"),
    ],
  };
}

export function reviewMenu(ctx: MenuContext): MenuDefinition {
  return {
    id: "review",
    label: "Review",
    items: [
      action("review-comments", "Comments pane", ctx.actions.toggleComments, {
        checked: ctx.snapshot.ui.rightPane === "comments",
      }),
      action("review-track", "Track changes", ctx.actions.toggleTrackChanges, {
        checked: ctx.snapshot.document.settings.trackRevisions,
      }),
      action(
        "review-accept",
        "Accept all changes",
        ctx.actions.acceptAllChanges,
      ),
      action(
        "review-reject",
        "Reject all changes",
        ctx.actions.rejectAllChanges,
      ),
      separator("review-sep"),
      action("review-find", "Find and replace…", ctx.actions.openFind),
      action("review-ai", "AI assistant", ctx.actions.toggleAi, {
        checked: ctx.snapshot.ui.rightPane === "ai",
        disabled: ctx.snapshot.health?.capabilities.ai !== true,
        disabledReason:
          ctx.snapshot.ui.aiUnavailableReason ??
          "The AI assistant is unavailable until the server reports an AI provider.",
      }),
      separator("review-sep-2"),
      unavailable(
        "review-spelling",
        "Spelling and grammar",
        "A dedicated spelling pane is not implemented; use the AI review action.",
      ),
    ],
  };
}

/** Font-size items for skins whose menu surfaces a size list. */
export function sizeItems(ctx: MenuContext, prefix: string): MenuItem[] {
  return FONT_SIZES.map((size) =>
    action(
      `${prefix}-size-${size}`,
      String(size),
      () => ctx.actions.setFontSize(size),
      {
        checked: Math.abs((ctx.state.run.fontSize ?? 11) - size) < 0.01,
      },
    ),
  );
}
