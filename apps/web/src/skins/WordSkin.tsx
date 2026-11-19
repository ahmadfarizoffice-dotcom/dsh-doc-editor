/**
 * Microsoft Word (Microsoft 365) skin: dark blue title bar, ribbon tab row,
 * grouped ribbon, rulers and a Word-style status bar.
 */
import { useState } from "react";
import { AiPane } from "../panels/AiPane";
import { CommentsPane } from "../panels/CommentsPane";
import { OutlinePane } from "../panels/OutlinePane";
import { PreviewView } from "../pages/PreviewView";
import { UNIMPLEMENTED } from "./unimplemented";
import { MenuBar } from "./MenuBar";
import { FormatButtons, type FormatGroup } from "./FormattingBar";
import { ToolButton, ZoomSelect } from "./controls";
import {
  DocumentTitleInput,
  EditorColumn,
  LanguageStatus,
  PageStatus,
  SaveStatus,
  ServerStatus,
  WordCount,
} from "./shared";
import { fileMenu, skinSwitcherMenu, type MenuContext } from "./menus";
import { useSkinContext, type SkinProps } from "./skinContext";
import { Icon, type IconName } from "./icons";

type WordTab =
  | "home"
  | "insert"
  | "draw"
  | "design"
  | "layout"
  | "references"
  | "mailings"
  | "review"
  | "view"
  | "help";

const WORD_TABS: readonly { id: WordTab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "insert", label: "Insert" },
  { id: "draw", label: "Draw" },
  { id: "design", label: "Design" },
  { id: "layout", label: "Layout" },
  { id: "references", label: "References" },
  { id: "mailings", label: "Mailings" },
  { id: "review", label: "Review" },
  { id: "view", label: "View" },
  { id: "help", label: "Help" },
];

const HOME_GROUPS: readonly FormatGroup[] = [
  { id: "clipboard", label: "Clipboard", items: ["paste", "cut", "copy"] },
  { id: "undo", label: "Undo", items: ["undo", "redo"] },
  {
    id: "font",
    label: "Font",
    items: [
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
      "|",
      "clearFormatting",
    ],
  },
  {
    id: "paragraph",
    label: "Paragraph",
    items: [
      "bulletList",
      "numberList",
      "checklist",
      "|",
      "outdent",
      "indent",
      "|",
      "alignLeft",
      "alignCenter",
      "alignRight",
      "alignJustify",
      "|",
      "lineSpacing",
      "paragraph",
      "|",
      "formatMarks",
    ],
  },
  { id: "styles", label: "Styles", items: ["styles"] },
  {
    id: "editing",
    label: "Editing",
    items: ["find", "comment", "trackChanges"],
  },
];

const INSERT_GROUPS: readonly FormatGroup[] = [
  { id: "tables", label: "Tables", items: ["table"] },
  {
    id: "illustrations",
    label: "Illustrations",
    items: ["image", "chart", "shape"],
  },
  { id: "links", label: "Links", items: ["link"] },
  { id: "comments", label: "Comments", items: ["comment"] },
  { id: "pages", label: "Pages", items: ["pageBreak", "sectionBreak"] },
  { id: "text", label: "Text", items: ["toc", "footnote"] },
];

const LAYOUT_GROUPS: readonly FormatGroup[] = [
  {
    id: "page-setup",
    label: "Page Setup",
    items: ["pageSetup", "pageBreak", "sectionBreak"],
  },
  {
    id: "paragraph",
    label: "Paragraph",
    items: ["outdent", "indent", "lineSpacing", "paragraph"],
  },
  { id: "arrange", label: "Arrange", items: ["formatMarks"] },
];

const REFERENCES_GROUPS: readonly FormatGroup[] = [
  { id: "toc", label: "Table of Contents", items: ["toc"] },
  { id: "notes", label: "Footnotes", items: ["footnote"] },
];

const REVIEW_GROUPS: readonly FormatGroup[] = [
  { id: "comments", label: "Comments", items: ["comment", "find"] },
  { id: "track", label: "Tracking", items: ["trackChanges"] },
];

function RibbonNote({ children }: { children: string }): React.JSX.Element {
  return <p className="s-ribbon-note">{children}</p>;
}

function DisabledGroup({
  label,
  items,
}: {
  label: string;
  items: readonly { label: string; reason: string; icon: IconName }[];
}): React.JSX.Element {
  return (
    <div className="s-fmt-group s-ribbon-group">
      <span className="s-fmt-label">{label}</span>
      <div className="s-fmt-items">
        {items.map((item) => (
          <ToolButton
            key={item.label}
            label={item.label}
            disabled
            title={item.reason}
          >
            <Icon name={item.icon} />
          </ToolButton>
        ))}
      </div>
    </div>
  );
}

function WordRibbon({
  tab,
  menu,
  store,
}: {
  tab: WordTab;
  menu: MenuContext;
  store: SkinProps["store"];
}): React.JSX.Element {
  const { actions, snapshot, state } = menu;
  switch (tab) {
    case "home":
      return (
        <FormatButtons
          actions={actions}
          snapshot={snapshot}
          state={state}
          groups={HOME_GROUPS}
          sizeStyle="select"
          label="Home ribbon"
          showLabels
          className="s-word-ribbon-format"
        />
      );
    case "insert":
      return (
        <>
          <FormatButtons
            actions={actions}
            snapshot={snapshot}
            state={state}
            groups={INSERT_GROUPS}
            label="Insert ribbon"
            showLabels
            className="s-word-ribbon-format"
          />
          <DisabledGroup
            label="Header & Footer"
            items={[
              {
                label: "Header",
                reason: UNIMPLEMENTED.headerFooter,
                icon: "page",
              },
              {
                label: "Footer",
                reason: UNIMPLEMENTED.headerFooter,
                icon: "page",
              },
              {
                label: "Page number",
                reason: UNIMPLEMENTED.headerFooter,
                icon: "page",
              },
            ]}
          />
        </>
      );
    case "draw":
      return (
        <>
          <DisabledGroup
            label="Pen"
            items={[
              {
                label: "Draw with pen",
                reason: UNIMPLEMENTED.drawing,
                icon: "paint",
              },
              {
                label: "Highlighter",
                reason: UNIMPLEMENTED.drawing,
                icon: "paint",
              },
              {
                label: "Eraser",
                reason: UNIMPLEMENTED.drawing,
                icon: "clearFormat",
              },
            ]}
          />
          <RibbonNote>
            Freehand drawing is not implemented in this build. Text editing,
            tables and images remain fully available.
          </RibbonNote>
        </>
      );
    case "design":
      return (
        <>
          <DisabledGroup
            label="Document Formatting"
            items={[
              { label: "Themes", reason: UNIMPLEMENTED.design, icon: "theme" },
              {
                label: "Colours",
                reason: UNIMPLEMENTED.design,
                icon: "format",
              },
              { label: "Fonts", reason: UNIMPLEMENTED.design, icon: "styles" },
              {
                label: "Paragraph spacing",
                reason: UNIMPLEMENTED.design,
                icon: "lineSpacing",
              },
            ]}
          />
          <RibbonNote>
            Document theme editing is not implemented; the stored theme and
            style sheet are used as-is.
          </RibbonNote>
        </>
      );
    case "layout":
      return (
        <FormatButtons
          actions={actions}
          snapshot={snapshot}
          state={state}
          groups={LAYOUT_GROUPS}
          label="Layout ribbon"
          showLabels
          className="s-word-ribbon-format"
        />
      );
    case "references":
      return (
        <>
          <FormatButtons
            actions={actions}
            snapshot={snapshot}
            state={state}
            groups={REFERENCES_GROUPS}
            label="References ribbon"
            showLabels
            className="s-word-ribbon-format"
          />
          <DisabledGroup
            label="Citations & Bibliography"
            items={[
              {
                label: "Insert citation",
                reason: UNIMPLEMENTED.bookmark,
                icon: "bookmark",
              },
              {
                label: "Manage sources",
                reason: UNIMPLEMENTED.bookmark,
                icon: "open",
              },
            ]}
          />
        </>
      );
    case "mailings":
      return (
        <>
          <DisabledGroup
            label="Mail Merge"
            items={[
              {
                label: "Start mail merge",
                reason: UNIMPLEMENTED.mailMerge,
                icon: "open",
              },
              {
                label: "Select recipients",
                reason: UNIMPLEMENTED.mailMerge,
                icon: "account",
              },
              {
                label: "Merge",
                reason: UNIMPLEMENTED.mailMerge,
                icon: "export",
              },
            ]}
          />
          <RibbonNote>Mail merge is not implemented.</RibbonNote>
        </>
      );
    case "review": {
      const hasRevisions = snapshot.document.revisions.length > 0;
      return (
        <>
          <FormatButtons
            actions={actions}
            snapshot={snapshot}
            state={state}
            groups={REVIEW_GROUPS}
            label="Review ribbon"
            showLabels
            className="s-word-ribbon-format"
          />
          <div className="s-fmt-group s-ribbon-group">
            <span className="s-fmt-label">Changes</span>
            <div className="s-fmt-items">
              <ToolButton
                label="Accept all changes"
                disabled={!hasRevisions}
                title={
                  hasRevisions
                    ? "Accept all tracked changes"
                    : "No tracked changes to accept"
                }
                onClick={actions.acceptAllChanges}
              >
                <Icon name="check" />
              </ToolButton>
              <ToolButton
                label="Reject all changes"
                disabled={!hasRevisions}
                title={
                  hasRevisions
                    ? "Reject all tracked changes"
                    : "No tracked changes to reject"
                }
                onClick={actions.rejectAllChanges}
              >
                <Icon name="close" />
              </ToolButton>
              <ToolButton
                label="Comments pane"
                pressed={snapshot.ui.rightPane === "comments"}
                onClick={actions.toggleComments}
              >
                <Icon name="comment" />
              </ToolButton>
            </div>
          </div>
        </>
      );
    }
    case "view":
      return (
        <>
          <div className="s-fmt-group s-ribbon-group">
            <span className="s-fmt-label">Views</span>
            <div className="s-fmt-items">
              <ToolButton
                label={
                  snapshot.ui.view === "editor" ? "Preview" : "Back to editor"
                }
                onClick={actions.cycleView}
              >
                <Icon name="print" />
              </ToolButton>
              <ToolButton
                label="Outline pane"
                pressed={snapshot.ui.showOutline}
                onClick={actions.toggleOutline}
              >
                <Icon name="toc" />
              </ToolButton>
              <ToolButton
                label="Comments pane"
                pressed={snapshot.ui.rightPane === "comments"}
                onClick={actions.toggleComments}
              >
                <Icon name="comment" />
              </ToolButton>
              <ToolButton
                label="AI assistant"
                pressed={snapshot.ui.rightPane === "ai"}
                disabled={snapshot.health?.capabilities.ai !== true}
                title={
                  snapshot.ui.aiUnavailableReason ??
                  "The AI assistant needs a configured server provider."
                }
                onClick={actions.toggleAi}
              >
                <Icon name="format" />
              </ToolButton>
              <ToolButton
                label="Formatting marks"
                pressed={snapshot.ui.showFormattingMarks}
                onClick={actions.toggleFormattingMarks}
              >
                <Icon name="formatMarks" />
              </ToolButton>
            </div>
          </div>
          <div className="s-fmt-group s-ribbon-group">
            <span className="s-fmt-label">Zoom</span>
            <div className="s-fmt-items">
              <ZoomSelect value={snapshot.ui.zoom} onChange={actions.setZoom} />
            </div>
          </div>
          <div className="s-fmt-group s-ribbon-group">
            <span className="s-fmt-label">Skin</span>
            <div className="s-fmt-items">
              <MenuBar
                menus={[skinSwitcherMenu(menu)]}
                align="end"
                ariaLabel="Skin and theme"
              />
            </div>
          </div>
        </>
      );
    case "help":
      return (
        <div className="s-word-help">
          <div className="s-fmt-group s-ribbon-group">
            <span className="s-fmt-label">Help</span>
            <div className="s-fmt-items">
              <ToolButton
                label="Keyboard shortcuts"
                onClick={actions.openShortcuts}
              >
                <Icon name="format" />
              </ToolButton>
              <MenuBar
                menus={[skinSwitcherMenu(menu)]}
                align="end"
                ariaLabel="Skin and theme"
              />
            </div>
          </div>
          <ServerStatus snapshot={snapshot} />
          <span className="s-word-help-title">
            {store.session.document.metadata.title || "Untitled document"}
          </span>
        </div>
      );
    default:
      return (
        <RibbonNote>This ribbon tab has no implemented commands.</RibbonNote>
      );
  }
}

export function WordSkin(props: SkinProps): React.JSX.Element {
  const { store, snapshot } = props;
  const { actions, menu } = useSkinContext(props);
  const [tab, setTab] = useState<WordTab>("home");
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");

  return (
    <>
      <header className="s-word-titlebar">
        <button
          type="button"
          className="s-word-appgrid"
          aria-label="App launcher"
          title="The app launcher is not part of this build."
          disabled
        >
          <Icon name="grid" size={18} />
        </button>
        <DocumentTitleInput
          store={store}
          snapshot={snapshot}
          className="s-word-title"
          ariaLabel="Document title"
        />
        <div className="s-word-title-actions">
          <form
            className="s-word-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              store.setUi({ findQuery: search });
              actions.openFind();
            }}
          >
            <Icon name="search" size={15} />
            <input
              type="search"
              aria-label="Search the document"
              placeholder="Search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </form>
          <MenuBar
            menus={[skinSwitcherMenu(menu)]}
            align="end"
            className="s-word-skin"
            ariaLabel="Skin and theme"
          />
          <button
            type="button"
            className="s-word-account"
            aria-label="Account: AF"
            title="Account settings are not implemented."
            disabled
          >
            AF
          </button>
        </div>
      </header>

      <div className="s-word-tabrow">
        <MenuBar
          menus={[fileMenu(menu)]}
          className="s-word-filetab"
          ariaLabel="File menu"
        />
        <div
          className="s-word-tabs"
          role="tablist"
          aria-label="Word ribbon tabs"
        >
          {WORD_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={
                tab === entry.id ? "s-word-tab is-active" : "s-word-tab"
              }
              onClick={() => {
                setTab(entry.id);
                setCollapsed(false);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="s-word-ribbon-toggle"
          aria-label={collapsed ? "Expand ribbon" : "Collapse ribbon"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand ribbon" : "Collapse ribbon"}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Icon name={collapsed ? "chevronDown" : "chevronUp"} size={16} />
        </button>
      </div>

      {!collapsed ? (
        <div
          className="s-word-ribbon"
          role="tabpanel"
          aria-label={`${tab} ribbon`}
        >
          <WordRibbon tab={tab} menu={menu} store={store} />
        </div>
      ) : null}

      {snapshot.ui.view === "editor" ? (
        <main className="s-workspace s-word-workspace">
          {snapshot.ui.showOutline ? (
            <OutlinePane store={store} snapshot={snapshot} />
          ) : null}
          <EditorColumn
            store={store}
            snapshot={snapshot}
            ruler
            className="s-word-editor"
          />
          {snapshot.ui.rightPane === "comments" ? (
            <CommentsPane store={store} snapshot={snapshot} />
          ) : snapshot.ui.rightPane === "ai" ? (
            <AiPane store={store} snapshot={snapshot} />
          ) : null}
        </main>
      ) : (
        <PreviewView store={store} snapshot={snapshot} />
      )}

      <footer className="s-word-statusbar">
        <SaveStatus snapshot={snapshot} />
        <span className="s-status-sep" aria-hidden="true">
          |
        </span>
        <PageStatus snapshot={snapshot} store={store} />
        <WordCount snapshot={snapshot} />
        <LanguageStatus snapshot={snapshot} />
        <span className="s-status-spacer" />
        <ServerStatus snapshot={snapshot} />
        <span className="s-word-viewicons" aria-label="View mode">
          <span
            className="s-word-viewicon is-active"
            title="Print layout (current view)"
            aria-current="page"
          >
            <Icon name="page" size={15} />
          </span>
          <span
            className="s-word-viewicon is-disabled"
            title={UNIMPLEMENTED.viewMode}
            aria-label="Web layout (not implemented)"
          >
            <Icon name="grid" size={15} />
          </span>
        </span>
        <span className="s-word-zoom">
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
          <span className="s-word-zoom-value">
            {Math.round(snapshot.ui.zoom * 100)}%
          </span>
        </span>
      </footer>
    </>
  );
}
