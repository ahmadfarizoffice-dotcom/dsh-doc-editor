/**
 * LibreOffice Writer skin: menu bar, two toolbar rows, gray canvas with ruler,
 * a sidebar deck (Properties/Page/Styles plus the reused comment and AI panes)
 * and a Writer-style status bar.
 */
import { useEffect, useRef, useState } from "react";
import { AiPane } from "../panels/AiPane";
import { CommentsPane } from "../panels/CommentsPane";
import { OutlinePane } from "../panels/OutlinePane";
import { PreviewView } from "../pages/PreviewView";
import { sectionIndexForPosition } from "../model/sections";
import { UNIMPLEMENTED } from "./unimplemented";
import { MenuBar } from "./MenuBar";
import { FormatButtons, type FormatGroup } from "./FormattingBar";
import { ToolButton } from "./controls";
import {
  DocumentTitleInput,
  DockTabs,
  EditorColumn,
  LanguageStatus,
  PageStatus,
  SaveStatus,
  ServerStatus,
  WordCount,
} from "./shared";
import {
  editMenu,
  fileMenu,
  formMenu,
  formatMenu,
  helpMenu,
  insertMenu,
  skinSwitcherMenu,
  stylesMenu,
  tableMenu,
  toolsMenu,
  viewMenu,
  windowMenu,
} from "./menus";
import { useSkinContext, type SkinProps } from "./skinContext";
import { Icon } from "./icons";

const STANDARD_GROUPS: readonly FormatGroup[] = [
  { id: "file", items: ["newDoc", "open", "save", "exportPdf", "print"] },
  { id: "clipboard", items: ["cut", "copy", "paste"] },
  { id: "history", items: ["undo", "redo"] },
  { id: "find", items: ["find", "formatMarks"] },
];

const WRITER_FORMAT_GROUPS: readonly FormatGroup[] = [
  {
    id: "text",
    items: [
      "styles",
      "font",
      "size",
      "|",
      "bold",
      "italic",
      "underline",
      "strike",
      "|",
      "textColor",
      "highlight",
    ],
  },
  {
    id: "paragraph",
    items: [
      "alignLeft",
      "alignCenter",
      "alignRight",
      "alignJustify",
      "|",
      "bulletList",
      "numberList",
      "|",
      "outdent",
      "indent",
      "|",
      "lineSpacing",
      "paragraph",
      "|",
      "clearFormatting",
      "more",
    ],
  },
  { id: "insert", items: ["table", "image", "link", "comment"] },
];

const WRITER_PROPERTIES: readonly FormatGroup[] = [
  {
    id: "character",
    label: "Character",
    items: [
      "styles",
      "font",
      "size",
      "|",
      "bold",
      "italic",
      "underline",
      "|",
      "textColor",
      "highlight",
    ],
  },
  {
    id: "paragraph",
    label: "Paragraph",
    items: [
      "alignLeft",
      "alignCenter",
      "alignRight",
      "alignJustify",
      "|",
      "lineSpacing",
      "paragraph",
      "|",
      "bulletList",
      "numberList",
    ],
  },
];

type DeckTab = "properties" | "page" | "styles" | "comments" | "ai";

export function WriterSkin(props: SkinProps): React.JSX.Element {
  const { store, snapshot } = props;
  const { actions, state, menu } = useSkinContext(props);
  const [deck, setDeck] = useState<DeckTab>("properties");
  const [open, setOpen] = useState(true);
  const rightPane = snapshot.ui.rightPane;
  const firstSync = useRef(true);

  useEffect(() => {
    if (rightPane === "none") return;
    if (firstSync.current) {
      firstSync.current = false;
      setOpen(true);
      setDeck(rightPane === "comments" ? "comments" : "ai");
      return;
    }
    setOpen(true);
    setDeck(rightPane === "comments" ? "comments" : "ai");
  }, [rightPane]);

  const sectionIndex = sectionIndexForPosition(
    snapshot.document,
    store.selection.focus,
  );
  const page =
    snapshot.document.sections[sectionIndex]?.page ??
    snapshot.document.sections[0]?.page;

  const selectDeck = (next: DeckTab): void => {
    setOpen(true);
    setDeck(next);
    if (next === "comments") store.setUi({ rightPane: "comments" });
    else if (next === "ai") store.setUi({ rightPane: "ai" });
    else if (rightPane !== "none") store.setUi({ rightPane: "none" });
  };

  const menus = [
    fileMenu(menu),
    editMenu(menu),
    viewMenu(menu),
    insertMenu(menu),
    formatMenu(menu),
    stylesMenu(menu),
    tableMenu(menu),
    formMenu(menu),
    toolsMenu(menu),
    windowMenu(menu),
    helpMenu(menu),
  ];

  return (
    <>
      <header className="s-writer-menubar">
        <span className="s-writer-appicon" aria-hidden="true">
          <Icon name="writer" size={22} />
        </span>
        <DocumentTitleInput
          store={store}
          snapshot={snapshot}
          className="s-writer-title"
        />
        <MenuBar
          menus={menus}
          className="s-writer-menus"
          ariaLabel="LibreOffice Writer menus"
        />
        <span className="s-writer-menubar-spacer" />
        <MenuBar
          menus={[skinSwitcherMenu(menu)]}
          align="end"
          className="s-writer-skin"
          ariaLabel="Skin and theme"
        />
      </header>

      <div
        className="s-writer-standard"
        role="toolbar"
        aria-label="Standard toolbar"
      >
        <FormatButtons
          actions={actions}
          snapshot={snapshot}
          state={state}
          groups={STANDARD_GROUPS}
          label="Standard toolbar"
          className="s-writer-standard-format"
        />
      </div>
      <div
        className="s-writer-format"
        role="toolbar"
        aria-label="Formatting toolbar"
      >
        <FormatButtons
          actions={actions}
          snapshot={snapshot}
          state={state}
          groups={WRITER_FORMAT_GROUPS}
          label="Formatting toolbar"
          className="s-writer-formatting"
        />
      </div>

      {snapshot.ui.view === "editor" ? (
        <main className="s-workspace s-writer-workspace">
          {snapshot.ui.showOutline ? (
            <OutlinePane store={store} snapshot={snapshot} />
          ) : null}
          <EditorColumn
            store={store}
            snapshot={snapshot}
            ruler
            className="s-writer-editor"
          />
          {open ? (
            <aside className="s-writer-deck" aria-label="Sidebar">
              <DockTabs
                ariaLabel="Sidebar deck"
                className="s-writer-deck-tabs"
                tabs={[
                  {
                    id: "properties",
                    label: "Properties",
                    active: deck === "properties",
                    onSelect: () => selectDeck("properties"),
                  },
                  {
                    id: "page",
                    label: "Page",
                    active: deck === "page",
                    onSelect: () => selectDeck("page"),
                  },
                  {
                    id: "styles",
                    label: "Styles",
                    active: deck === "styles",
                    onSelect: () => selectDeck("styles"),
                  },
                  {
                    id: "comments",
                    label: "Comments",
                    active: deck === "comments",
                    onSelect: () => selectDeck("comments"),
                  },
                  {
                    id: "ai",
                    label: "AI",
                    active: deck === "ai",
                    disabled: snapshot.health?.capabilities.ai !== true,
                    title:
                      snapshot.ui.aiUnavailableReason ??
                      "The AI assistant needs a configured server provider.",
                    onSelect: () => selectDeck("ai"),
                  },
                ]}
                onClose={() => {
                  setOpen(false);
                  store.setUi({ rightPane: "none" });
                }}
              />
              <div className="s-writer-deck-body">
                {deck === "properties" ? (
                  <FormatButtons
                    actions={actions}
                    snapshot={snapshot}
                    state={state}
                    groups={WRITER_PROPERTIES}
                    label="Properties deck"
                    showLabels
                    className="s-writer-properties"
                  />
                ) : deck === "page" ? (
                  <div className="s-writer-page-deck">
                    <h3>Page</h3>
                    <dl className="s-pages-properties">
                      <div>
                        <dt>Section</dt>
                        <dd>
                          {sectionIndex + 1} of{" "}
                          {snapshot.document.sections.length}
                        </dd>
                      </div>
                      <div>
                        <dt>Page size</dt>
                        <dd>
                          {page?.preset && page.preset !== "custom"
                            ? page.preset
                            : page
                              ? `${Math.round(page.width)} × ${Math.round(page.height)} pt`
                              : "Unavailable"}
                        </dd>
                      </div>
                      <div>
                        <dt>Orientation</dt>
                        <dd>{page?.orientation ?? "portrait"}</dd>
                      </div>
                      <div>
                        <dt>Margins</dt>
                        <dd>
                          {page
                            ? `${Math.round(page.margins.top)} / ${Math.round(page.margins.right)} / ${Math.round(page.margins.bottom)} / ${Math.round(page.margins.left)} pt`
                            : "—"}
                        </dd>
                      </div>
                    </dl>
                    <div className="s-pages-document-actions">
                      <button
                        type="button"
                        className="s-pages-button is-primary"
                        onClick={actions.openPageSetup}
                      >
                        Page setup…
                      </button>
                      <button
                        type="button"
                        className="s-pages-button"
                        onClick={actions.openSectionBreak}
                      >
                        Section break…
                      </button>
                      <button
                        type="button"
                        className="s-pages-button"
                        onClick={actions.print}
                      >
                        Print / preview
                      </button>
                    </div>
                  </div>
                ) : deck === "styles" ? (
                  <div className="s-writer-styles-deck">
                    <h3>Paragraph styles</h3>
                    <ul className="s-writer-style-list">
                      {state.styles.map((style) => (
                        <li key={style.id}>
                          <button
                            type="button"
                            className={
                              style.id === state.styleId
                                ? "s-writer-style is-active"
                                : "s-writer-style"
                            }
                            aria-pressed={style.id === state.styleId}
                            onClick={() => actions.applyStyle(style.id)}
                          >
                            {style.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : deck === "comments" ? (
                  <CommentsPane store={store} snapshot={snapshot} />
                ) : (
                  <AiPane store={store} snapshot={snapshot} />
                )}
              </div>
            </aside>
          ) : null}
        </main>
      ) : (
        <PreviewView store={store} snapshot={snapshot} />
      )}

      <footer className="s-writer-statusbar">
        <SaveStatus snapshot={snapshot} />
        <PageStatus snapshot={snapshot} store={store} />
        <WordCount snapshot={snapshot} />
        <span className="s-status-sep" aria-hidden="true">
          |
        </span>
        <span
          className="s-writer-pagestyle"
          title="Page styles are not implemented; the section's page setup is used."
        >
          Default Page Style
        </span>
        <LanguageStatus snapshot={snapshot} />
        <button
          type="button"
          className="s-writer-insertmode"
          disabled
          title={UNIMPLEMENTED.overwrite}
        >
          Insert
        </button>
        <span className="s-status-spacer" />
        <ServerStatus snapshot={snapshot} />
        <span className="s-writer-zoom">
          <Icon name="zoomOut" size={14} />
          <input
            type="range"
            min={50}
            max={200}
            step={10}
            value={Math.round(snapshot.ui.zoom * 100)}
            aria-label="Zoom"
            title="Zoom"
            onChange={(event) =>
              actions.setZoom(Number(event.target.value) / 100)
            }
          />
          <span>{Math.round(snapshot.ui.zoom * 100)}%</span>
        </span>
        <ToolButton
          label="Help"
          title="Keyboard shortcuts"
          onClick={actions.openShortcuts}
        >
          <Icon name="format" size={15} />
        </ToolButton>
      </footer>
    </>
  );
}
