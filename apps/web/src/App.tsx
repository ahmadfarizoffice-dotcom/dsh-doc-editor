import { useCallback, useEffect, useRef, useState } from "react";
import { applyParagraphStyle } from "./model/ops";
import {
  AppStore,
  useAppStore,
  type AppSnapshot,
  type DialogState,
} from "./app/state";
import {
  CommentDialog,
  FilesDialog,
  FindReplaceDialog,
  FootnoteDialog,
  LinkDialog,
  PageSetupDialog,
  RecoveryDialog,
  SectionBreakDialog,
  ShortcutsDialog,
  TableDialog,
  TocDialog,
} from "./editor/dialogs";
import { SkinApp } from "./skins/SkinApp";
import { SkinStore, useSkin, type SkinId, type Theme } from "./skins/skin";

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
    case "page-setup":
      return <PageSetupDialog store={store} onClose={close} />;
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

  const skinStoreRef = useRef<SkinStore | null>(null);
  if (!skinStoreRef.current)
    skinStoreRef.current = new SkinStore({
      search: typeof window !== "undefined" ? window.location.search : "",
    });
  const skinStore = skinStoreRef.current;
  const skin = useSkin(skinStore);

  const [theme, setTheme] = useState<Theme>(() => {
    const stored =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("dsh-doc:theme")
        : null;
    return stored === "light" || stored === "dark" ? stored : "system";
  });

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
    try {
      localStorage.setItem("dsh-doc:theme", theme);
    } catch {
      // A blocked storage (private mode) must not break theme switching.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-skin", skin);
    return () => document.documentElement.removeAttribute("data-skin");
  }, [skin]);

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

  const selectSkin = useCallback(
    (next: SkinId) => skinStore.setSkin(next),
    [skinStore],
  );

  return (
    <div className="app" data-skin={skin}>
      <GlobalShortcuts store={store} />
      <SkinApp
        store={store}
        snapshot={snapshot}
        skin={skin}
        theme={theme}
        onSkinChange={selectSkin}
        onThemeChange={setTheme}
      />
      <DialogHost store={store} />
      <Toasts store={store} snapshot={snapshot} />
    </div>
  );
}
