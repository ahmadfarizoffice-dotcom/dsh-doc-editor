import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setMetadata } from "@dsh-doc/core/model";
import {
  AppStore,
  useAppStore,
  type AppSnapshot,
  type DialogState,
} from "./app/state";
import { Toolbar } from "./editor/Toolbar";
import { EditableSurface } from "./editor/EditableSurface";
import {
  CommentDialog,
  FilesDialog,
  FindReplaceDialog,
  FootnoteDialog,
  LinkDialog,
  RecoveryDialog,
  SectionBreakDialog,
  ShortcutsDialog,
  TableDialog,
  TocDialog,
} from "./editor/dialogs";
import { OutlinePane } from "./panels/OutlinePane";
import { CommentsPane } from "./panels/CommentsPane";
import { AiPane } from "./panels/AiPane";
import { PreviewView } from "./pages/PreviewView";
import { applyParagraphStyle, type TextMatch } from "./model/ops";

const MemoisedSurface = memo(EditableSurface);

function downloadSupportedFormats(snapshot: AppSnapshot): string[] {
  return snapshot.health?.capabilities.formats ?? [];
}

function GlobalShortcuts(props: { store: AppStore }): null {
  const { store } = props;
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const inField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;
      const modifier = event.ctrlKey || event.metaKey;

      if (modifier && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!event.repeat) void store.save();
        return;
      }
      if (modifier && event.key.toLowerCase() === "p") {
        event.preventDefault();
        store.setView("preview");
        return;
      }
      if (inField) return;
      if (
        modifier &&
        (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")
      ) {
        // The editing surface handles its own undo; this covers everything else.
        if (target?.closest(".doc-editable")) return;
        event.preventDefault();
        if (event.key.toLowerCase() === "y" || event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (modifier && event.key.toLowerCase() === "f") {
        event.preventDefault();
        store.openDialog({ kind: "find" });
        return;
      }
      if (modifier && event.altKey) {
        const styleByKey: Record<string, string> = {
          "0": "Title",
          "1": "Heading1",
          "2": "Heading2",
          "3": "Heading3",
        };
        const styleId = styleByKey[event.key];
        if (styleId) {
          event.preventDefault();
          store.apply(`Apply ${styleId}`, (document) => {
            applyParagraphStyle(document, store.selection, styleId);
          });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [store]);
  return null;
}

function DialogHost({ store }: { store: AppStore }): React.JSX.Element | null {
  const snapshot = useAppStore(store);
  const dialog: DialogState | null = snapshot.ui.dialog;
  const close = useCallback(() => store.closeDialog(), [store]);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "table":
      return <TableDialog store={store} onClose={close} />;
    case "link":
      return <LinkDialog store={store} onClose={close} />;
    case "footnote":
      return <FootnoteDialog store={store} onClose={close} />;
    case "comment":
      return <CommentDialog store={store} onClose={close} />;
    case "section-break":
      return <SectionBreakDialog store={store} onClose={close} />;
    case "toc":
      return <TocDialog store={store} onClose={close} />;
    case "find":
      return <FindReplaceDialog store={store} onClose={close} />;
    case "files":
      return <FilesDialog store={store} onClose={close} />;
    case "recovery":
      return <RecoveryDialog store={store} onClose={close} />;
    case "shortcuts":
      return <ShortcutsDialog store={store} onClose={close} />;
    default:
      return null;
  }
}

function Toasts({
  store,
  snapshot,
}: {
  store: AppStore;
  snapshot: AppSnapshot;
}): React.JSX.Element {
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {snapshot.toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span>{toast.message}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => store.dismissToast(toast.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function App({
  store: providedStore,
}: { store?: AppStore } = {}): React.JSX.Element {
  const storeRef = useRef<AppStore | null>(providedStore ?? null);
  if (!storeRef.current) storeRef.current = new AppStore();
  const store = storeRef.current;
  const snapshot = useAppStore(store);
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => {
    const stored =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("dsh-doc:theme")
        : null;
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    store.bootstrap().then(() => {
      const hash = window.location.hash;
      const match = /^#\/doc\/([A-Za-z0-9_-]+)$/.exec(hash);
      if (match) void store.openDocumentById(match[1]);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (theme === "system")
      document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("dsh-doc:theme", theme);
  }, [theme]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (!store.session.dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [store]);

  // Flush an autosave when the tab is hidden, in addition to the idle timer.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") store.autosaveNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [store]);

  const activeMatch: TextMatch | null = useMemo(() => {
    const index = snapshot.ui.findActiveIndex;
    if (index < 0) return null;
    return snapshot.ui.findMatches[index] ?? null;
  }, [snapshot.ui.findMatches, snapshot.ui.findActiveIndex]);

  const formats = downloadSupportedFormats(snapshot);
  const capabilities = snapshot.health?.capabilities;

  const setTitle = (title: string): void => {
    store.apply(
      "Rename document",
      (document) => {
        setMetadata(document, { title });
      },
      { coalesce: "title" },
    );
  };

  return (
    <div className="app">
      <GlobalShortcuts store={store} />
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ▤
          </span>
          <span className="brand-name">DSH Docs</span>
        </div>

        <label className="visually-hidden" htmlFor="document-title">
          Document title
        </label>
        <input
          id="document-title"
          className="title-input"
          value={snapshot.title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => (store.session.dirty ? store.autosaveNow() : undefined)}
          placeholder="Untitled document"
        />

        <div className="header-status">
          {snapshot.dirty ? (
            <span className="badge badge-dirty">unsaved</span>
          ) : (
            <span className="badge">saved</span>
          )}
          {snapshot.saving ? <span className="badge">saving…</span> : null}
          {snapshot.offline ? (
            <span className="badge badge-warn">offline</span>
          ) : null}
        </div>

        <div className="header-actions">
          <button
            type="button"
            className="button small"
            onClick={() => store.openDialog({ kind: "files" })}
          >
            Files
          </button>
          <button
            type="button"
            className="button small primary"
            onClick={() => void store.save()}
            disabled={snapshot.saving}
          >
            Save
          </button>
          <details
            className="menu"
            open={exportOpen}
            onToggle={(event) => setExportOpen(event.currentTarget.open)}
          >
            <summary className="button small" aria-label="Export document">
              Export
            </summary>
            <div className="menu-panel" role="menu">
              {formats.length === 0 ? (
                <p className="menu-empty">
                  No export backend is available on the server, so no formats
                  can be produced. Start the API server and/or build the
                  conversion engine.
                </p>
              ) : (
                formats.map((format) => (
                  <button
                    key={format}
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      void store.exportDocument(format);
                      setExportOpen(false);
                    }}
                  >
                    {format.toUpperCase()}
                  </button>
                ))
              )}
            </div>
          </details>
          <button
            type="button"
            className="button small"
            aria-pressed={capabilities?.ai === true}
            onClick={() =>
              store.setUi({
                rightPane: snapshot.ui.rightPane === "ai" ? "none" : "ai",
              })
            }
            title={
              capabilities?.ai
                ? "Open the AI assistant"
                : "AI provider not configured on the server"
            }
          >
            Ask AI
          </button>
          <button
            type="button"
            className="button small"
            aria-pressed={snapshot.ui.rightPane === "comments"}
            onClick={() =>
              store.setUi({
                rightPane:
                  snapshot.ui.rightPane === "comments" ? "none" : "comments",
              })
            }
          >
            Review
          </button>
          <button
            type="button"
            className="button small"
            aria-pressed={snapshot.ui.showOutline}
            onClick={() =>
              store.setUi({ showOutline: !snapshot.ui.showOutline })
            }
          >
            Outline
          </button>
          <button
            type="button"
            className="button small"
            onClick={() =>
              store.setView(
                snapshot.ui.view === "editor" ? "preview" : "editor",
              )
            }
          >
            {snapshot.ui.view === "editor" ? "Preview" : "Editor"}
          </button>
          <button
            type="button"
            className="button small"
            onClick={() =>
              setTheme(
                theme === "dark"
                  ? "light"
                  : theme === "light"
                    ? "system"
                    : "dark",
              )
            }
            title={`Theme: ${theme}`}
            aria-label={`Theme: ${theme}. Click to change.`}
          >
            {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}
          </button>
          <button
            type="button"
            className="button small"
            onClick={() => store.openDialog({ kind: "shortcuts" })}
            title="Keyboard shortcuts"
          >
            ⌨
          </button>
        </div>
      </header>

      {snapshot.ui.view === "editor" ? (
        <>
          <Toolbar store={store} snapshot={snapshot} />
          <main className="workspace">
            {snapshot.ui.showOutline ? (
              <OutlinePane store={store} snapshot={snapshot} />
            ) : null}
            <section className="editor-column" aria-label="Document editor">
              <MemoisedSurface
                store={store}
                document={snapshot.document}
                version={snapshot.documentVersion}
                zoom={snapshot.ui.zoom}
                searchMatches={snapshot.ui.findMatches}
                activeMatch={activeMatch}
                activeCommentId={snapshot.ui.activeCommentId}
                showFormattingMarks={snapshot.ui.showFormattingMarks}
              />
            </section>
            {snapshot.ui.rightPane === "comments" ? (
              <CommentsPane store={store} snapshot={snapshot} />
            ) : snapshot.ui.rightPane === "ai" ? (
              <AiPane store={store} snapshot={snapshot} />
            ) : null}
          </main>
          <footer className="status-bar">
            <span>
              {snapshot.stats.words} words · {snapshot.stats.characters}{" "}
              characters ({snapshot.stats.charactersWithSpaces} with spaces) ·{" "}
              {snapshot.stats.paragraphs} paragraphs
            </span>
            <span>
              {snapshot.stats.tables} tables · {snapshot.stats.images} images
            </span>
            <span className="status-spacer" />
            <label htmlFor="status-zoom">Zoom</label>
            <select
              id="status-zoom"
              value={String(snapshot.ui.zoom)}
              onChange={(event) => store.setZoom(Number(event.target.value))}
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
                <option key={value} value={String(value)}>
                  {Math.round(value * 100)}%
                </option>
              ))}
            </select>
            <span
              className={capabilities ? "server-state ok" : "server-state warn"}
            >
              {capabilities
                ? `server ${snapshot.health?.version ?? ""} · renderer ${capabilities.renderer ? "on" : "off"} · ai ${
                    capabilities.ai ? "on" : "off"
                  }`
                : snapshot.healthError
                  ? `server unavailable: ${snapshot.healthError}`
                  : "connecting…"}
            </span>
          </footer>
        </>
      ) : (
        <>
          <PreviewView store={store} snapshot={snapshot} />
          <footer className="status-bar">
            <span>{snapshot.stats.words} words</span>
            <span className="status-spacer" />
            <span
              className={
                capabilities?.renderer ? "server-state ok" : "server-state warn"
              }
            >
              {capabilities?.renderer
                ? "server renderer available"
                : "server renderer unavailable — approximation shown"}
            </span>
          </footer>
        </>
      )}

      <DialogHost store={store} />
      <Toasts store={store} snapshot={snapshot} />
    </div>
  );
}
