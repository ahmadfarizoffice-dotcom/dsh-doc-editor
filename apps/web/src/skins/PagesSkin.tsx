/**
 * Apple Pages skin: light top bar, slim single toolbar, warm canvas and a
 * collapsible right Inspector whose Format/Document tabs and panel dock reuse
 * the existing outline, comments and AI panes.
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
  SaveStatus,
  ServerStatus,
  WordCount,
} from "./shared";
import { viewMenu } from "./menus";
import { estimatePages } from "./pages";
import { useSkinContext, type SkinProps } from "./skinContext";
import { Icon } from "./icons";
import { formatZoom } from "./formatting";

const PAGES_TOOLBAR: readonly FormatGroup[] = [
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
      "|",
      "textColor",
      "highlight",
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
      "|",
      "table",
      "chart",
      "image",
      "shape",
      "|",
      "link",
      "comment",
      "more",
    ],
  },
];

const PAGES_INSPECTOR: readonly FormatGroup[] = [
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
    ],
  },
  {
    id: "lists",
    label: "Lists",
    items: ["bulletList", "numberList", "checklist"],
  },
];

type SidebarTab = "format" | "document" | "comments" | "ai" | "outline";

export function PagesSkin(props: SkinProps): React.JSX.Element {
  const { store, snapshot } = props;
  const { actions, state, menu } = useSkinContext(props);
  const [tab, setTab] = useState<SidebarTab>("format");
  const [open, setOpen] = useState(true);
  const firstSync = useRef(true);
  const rightPane = snapshot.ui.rightPane;

  useEffect(() => {
    if (firstSync.current) {
      firstSync.current = false;
      return;
    }
    if (rightPane === "comments") setTab("comments");
    else if (rightPane === "ai") setTab("ai");
    else if (snapshot.ui.showOutline) setTab("outline");
  }, [rightPane, snapshot.ui.showOutline]);

  const estimate = estimatePages(snapshot.document, {
    position: store.selection.focus,
  });
  const sectionIndex = sectionIndexForPosition(
    snapshot.document,
    store.selection.focus,
  );
  const page =
    snapshot.document.sections[sectionIndex]?.page ??
    snapshot.document.sections[0]?.page;
  const formats = snapshot.health?.capabilities.formats ?? [];
  const aiAvailable = snapshot.health?.capabilities.ai === true;

  const selectTab = (next: SidebarTab): void => {
    setOpen(true);
    setTab(next);
    if (next === "comments")
      store.setUi({ rightPane: "comments", showOutline: false });
    else if (next === "ai")
      store.setUi({ rightPane: "ai", showOutline: false });
    else if (next === "outline")
      store.setUi({ rightPane: "none", showOutline: true });
    else store.setUi({ rightPane: "none" });
  };

  return (
    <>
      <header className="s-pages-topbar">
        <div className="s-pages-brand">
          <span className="s-pages-appicon" aria-hidden="true">
            <Icon name="pages" size={26} />
          </span>
          <span className="s-pages-brandname">Pages</span>
        </div>
        <DocumentTitleInput
          store={store}
          snapshot={snapshot}
          className="s-pages-title"
        />
        <div className="s-pages-actions">
          <button
            type="button"
            className="s-pages-button"
            title={UNIMPLEMENTED.share}
            disabled
          >
            Share
          </button>
          <button
            type="button"
            className="s-pages-button"
            title={UNIMPLEMENTED.collaborate}
            disabled
          >
            Collaborate
          </button>
          <MenuBar
            menus={[viewMenu(menu)]}
            align="end"
            className="s-pages-viewmenu"
            ariaLabel="View options"
          />
          <ToolButton
            label={open ? "Hide inspector" : "Show inspector"}
            pressed={open}
            title="Inspector"
            onClick={() => {
              setOpen((value) => !value);
              setTab("format");
            }}
            className="s-pages-inspector-toggle"
          >
            <Icon name="inspector" />
          </ToolButton>
        </div>
      </header>

      <div
        className="s-pages-toolbar"
        role="toolbar"
        aria-label="Pages toolbar"
      >
        <FormatButtons
          actions={actions}
          snapshot={snapshot}
          state={state}
          groups={PAGES_TOOLBAR}
          label="Pages toolbar"
          className="s-pages-format"
        />
        <span className="s-pages-toolbar-hint" aria-hidden="true">
          {formatZoom(snapshot.ui.zoom)}
        </span>
      </div>

      {snapshot.ui.view === "editor" ? (
        <main className="s-workspace s-pages-workspace">
          <EditorColumn
            store={store}
            snapshot={snapshot}
            className="s-pages-editor"
          />
          {open ? (
            <aside className="s-pages-sidebar" aria-label="Inspector">
              <DockTabs
                ariaLabel="Inspector and document panels"
                className="s-pages-sidebar-tabs"
                tabs={[
                  {
                    id: "format",
                    label: "Format",
                    active: tab === "format",
                    onSelect: () => selectTab("format"),
                  },
                  {
                    id: "document",
                    label: "Document",
                    active: tab === "document",
                    onSelect: () => selectTab("document"),
                  },
                  {
                    id: "comments",
                    label: "Comments",
                    active: tab === "comments",
                    onSelect: () => selectTab("comments"),
                  },
                  {
                    id: "ai",
                    label: "AI",
                    active: tab === "ai",
                    disabled: !aiAvailable,
                    title:
                      snapshot.ui.aiUnavailableReason ??
                      "The AI assistant needs a configured server provider.",
                    onSelect: () => selectTab("ai"),
                  },
                  {
                    id: "outline",
                    label: "Outline",
                    active: tab === "outline",
                    onSelect: () => selectTab("outline"),
                  },
                ]}
                onClose={() => {
                  setOpen(false);
                  store.setUi({ rightPane: "none", showOutline: false });
                }}
              />
              <div className="s-pages-sidebar-body">
                {tab === "format" ? (
                  <FormatButtons
                    actions={actions}
                    snapshot={snapshot}
                    state={state}
                    groups={PAGES_INSPECTOR}
                    label="Format inspector"
                    showLabels
                    className="s-pages-inspector-format"
                  />
                ) : tab === "document" ? (
                  <div className="s-pages-document">
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
                        <dt>Size</dt>
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
                            ? `${Math.round(page.margins.top)}/${Math.round(page.margins.right)}/${Math.round(page.margins.bottom)}/${Math.round(page.margins.left)} pt`
                            : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>Pages</dt>
                        <dd>{estimate.pageCount} (estimated)</dd>
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
                    <h3>Export</h3>
                    {formats.length === 0 ? (
                      <p className="s-pages-hint">
                        The server reports no export backend. Start the API
                        server or build the conversion engine.
                      </p>
                    ) : (
                      <div className="s-pages-export">
                        {formats.map((format) => (
                          <button
                            key={format}
                            type="button"
                            className="s-pages-button"
                            onClick={() => actions.exportDocument(format)}
                          >
                            {format.toUpperCase()}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : tab === "comments" ? (
                  <CommentsPane store={store} snapshot={snapshot} />
                ) : tab === "ai" ? (
                  <AiPane store={store} snapshot={snapshot} />
                ) : (
                  <OutlinePane store={store} snapshot={snapshot} />
                )}
              </div>
            </aside>
          ) : null}
        </main>
      ) : (
        <PreviewView store={store} snapshot={snapshot} />
      )}

      <footer className="s-pages-statusbar">
        <WordCount snapshot={snapshot} />
        <span className="s-status-spacer" />
        <span className="s-pages-pageindicator" title="Estimated page position">
          {estimate.currentPage} of {estimate.pageCount}
        </span>
        <span className="s-status-spacer" />
        <SaveStatus snapshot={snapshot} withLabel />
        <ServerStatus snapshot={snapshot} />
      </footer>
    </>
  );
}
