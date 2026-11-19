/**
 * Google Docs skin: white app bar, one compact toolbar row, blue-gray canvas,
 * floating page/word pill and a right-side panel dock (outline/comments/AI).
 */
import { AiPane } from "../panels/AiPane";
import { CommentsPane } from "../panels/CommentsPane";
import { OutlinePane } from "../panels/OutlinePane";
import { PreviewView } from "../pages/PreviewView";
import { UNIMPLEMENTED } from "./unimplemented";
import { MenuBar } from "./MenuBar";
import { FormatButtons, type FormatGroup } from "./FormattingBar";
import {
  DocumentTitleInput,
  DockTabs,
  EditorColumn,
  SaveStatus,
  ServerStatus,
} from "./shared";
import {
  editMenu,
  extensionsMenu,
  fileMenu,
  formatMenu,
  helpMenu,
  insertMenu,
  skinSwitcherMenu,
  toolsMenu,
  viewMenu,
} from "./menus";
import { estimatePages } from "./pages";
import { useSkinContext, type SkinProps } from "./skinContext";
import { Icon } from "./icons";

const TOOLBAR_GROUPS: readonly FormatGroup[] = [
  {
    id: "docs-toolbar",
    items: [
      "undo",
      "redo",
      "|",
      "print",
      "paintFormat",
      "|",
      "zoom",
      "|",
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
      "|",
      "link",
      "comment",
      "image",
      "|",
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
      "checklist",
      "|",
      "outdent",
      "indent",
      "|",
      "clearFormatting",
      "more",
    ],
  },
];

export function GdocsSkin(props: SkinProps): React.JSX.Element {
  const { store, snapshot } = props;
  const { actions, state, menu } = useSkinContext(props);
  const menus = [
    fileMenu(menu),
    editMenu(menu),
    viewMenu(menu),
    insertMenu(menu),
    formatMenu(menu),
    toolsMenu(menu),
    extensionsMenu(menu),
    helpMenu(menu),
  ];
  const estimate = estimatePages(snapshot.document, {
    position: store.selection.focus,
  });
  const rightPane = snapshot.ui.rightPane;
  const dockTab =
    rightPane === "comments"
      ? "comments"
      : rightPane === "ai"
        ? "ai"
        : snapshot.ui.showOutline
          ? "outline"
          : null;
  const aiAvailable = snapshot.health?.capabilities.ai === true;

  return (
    <>
      <header className="s-gdocs-appbar">
        <div className="s-gdocs-left">
          <span className="s-gdocs-logo" aria-hidden="true">
            <Icon name="gdocs" size={30} />
          </span>
          <DocumentTitleInput
            store={store}
            snapshot={snapshot}
            className="s-gdocs-title"
          />
          <MenuBar
            menus={menus}
            className="s-gdocs-menus"
            ariaLabel="Google Docs menus"
          />
        </div>
        <div className="s-gdocs-right">
          <MenuBar
            menus={[skinSwitcherMenu(menu)]}
            align="end"
            className="s-gdocs-skin"
            ariaLabel="Skin and theme"
          />
          <span className="s-gdocs-save">
            <SaveStatus snapshot={snapshot} withLabel />
          </span>
          <button
            type="button"
            className="s-gdocs-icon"
            aria-label="Version history"
            title={UNIMPLEMENTED.history}
            disabled
          >
            <Icon name="history" />
          </button>
          <button
            type="button"
            className="s-gdocs-share"
            title={UNIMPLEMENTED.share}
            disabled
          >
            Share
          </button>
          <button
            type="button"
            className="s-gdocs-avatar"
            aria-label="Account: AF"
            title="Account settings are not implemented."
            disabled
          >
            AF
          </button>
        </div>
      </header>

      <div
        className="s-gdocs-toolbar"
        role="toolbar"
        aria-label="Google Docs toolbar"
      >
        <FormatButtons
          actions={actions}
          snapshot={snapshot}
          state={state}
          groups={TOOLBAR_GROUPS}
          sizeStyle="stepper"
          label="Google Docs toolbar"
          className="s-gdocs-format"
        />
        <span className="s-gdocs-toolbar-spacer" />
        <button
          type="button"
          className="s-gdocs-mode"
          title={UNIMPLEMENTED.commentMode}
          disabled
        >
          Editing
          <Icon name="chevronDown" size={14} />
        </button>
      </div>

      {snapshot.ui.view === "editor" ? (
        <main
          className={
            dockTab
              ? "s-workspace s-gdocs-workspace has-dock"
              : "s-workspace s-gdocs-workspace"
          }
        >
          <EditorColumn
            store={store}
            snapshot={snapshot}
            className="s-gdocs-editor"
          />
          <div
            className="s-gdocs-pagepill"
            role="status"
            aria-live="polite"
            title="Estimated page position; the server layout renderer is authoritative."
          >
            {estimate.currentPage} of {estimate.pageCount} ·{" "}
            {snapshot.stats.words} words
          </div>
          {dockTab ? (
            <aside className="s-gdocs-dock" aria-label="Side panel">
              <DockTabs
                ariaLabel="Side panel"
                className="s-gdocs-dock-tabs"
                tabs={[
                  {
                    id: "outline",
                    label: "Outline",
                    active: dockTab === "outline",
                    onSelect: () =>
                      store.setUi({ showOutline: true, rightPane: "none" }),
                  },
                  {
                    id: "comments",
                    label: "Comments",
                    active: dockTab === "comments",
                    onSelect: () =>
                      store.setUi({
                        showOutline: false,
                        rightPane: "comments",
                      }),
                  },
                  {
                    id: "ai",
                    label: "AI",
                    active: dockTab === "ai",
                    disabled: !aiAvailable,
                    title: aiAvailable
                      ? "AI assistant"
                      : (snapshot.ui.aiUnavailableReason ?? "AI unavailable"),
                    onSelect: () =>
                      store.setUi({ showOutline: false, rightPane: "ai" }),
                  },
                ]}
                onClose={() =>
                  store.setUi({ showOutline: false, rightPane: "none" })
                }
              />
              <div className="s-dock-body">
                {dockTab === "outline" ? (
                  <OutlinePane store={store} snapshot={snapshot} />
                ) : dockTab === "comments" ? (
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

      <footer className="s-gdocs-statusbar">
        <SaveStatus snapshot={snapshot} withLabel />
        <span className="s-status-spacer" />
        <ServerStatus snapshot={snapshot} />
        <span className="s-gdocs-status-sep" aria-hidden="true">
          ·
        </span>
        <span>{estimate.pageCount} pages (estimated)</span>
      </footer>
    </>
  );
}
