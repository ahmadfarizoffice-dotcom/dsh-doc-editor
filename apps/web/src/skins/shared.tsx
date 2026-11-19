/**
 * Shared workspace pieces: the editing column (the only place `EditableSurface`
 * is mounted), the rulers, the editable title and the small status fragments
 * each skin's own status bar composes.
 */
import { memo, useMemo, type ReactNode } from "react";
import { setMetadata } from "@dsh-doc/core/model";
import type { AppSnapshot, AppStore } from "../app/state";
import { EditableSurface } from "../editor/EditableSurface";
import { ptToPx } from "../model/dom";
import { createSkinActions } from "./actions";
import { estimatePages } from "./pages";

const MemoisedSurface = memo(EditableSurface);

export function EditorColumn({
  store,
  snapshot,
  ruler = false,
  className,
  children,
}: {
  store: AppStore;
  snapshot: AppSnapshot;
  ruler?: boolean;
  className?: string;
  children?: ReactNode;
}): React.JSX.Element {
  const activeMatch = useMemo(() => {
    const index = snapshot.ui.findActiveIndex;
    if (index < 0) return null;
    return snapshot.ui.findMatches[index] ?? null;
  }, [snapshot.ui.findMatches, snapshot.ui.findActiveIndex]);

  return (
    <section
      className={className ? `editor-column ${className}` : "editor-column"}
      aria-label="Document editor"
    >
      {ruler ? <Ruler snapshot={snapshot} /> : null}
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
      {children}
    </section>
  );
}

/** Chrome-only ruler aligned with the document's own page geometry. */
export function Ruler({
  snapshot,
}: {
  snapshot: AppSnapshot;
}): React.JSX.Element {
  const section = snapshot.document.sections[0];
  const zoom = snapshot.ui.zoom;
  const page = section?.page;
  const width = page?.width ?? 595.3;
  const margins = page?.margins ?? {
    left: 72,
    right: 72,
    top: 72,
    bottom: 72,
  };
  const ticks = useMemo(() => {
    const result: Array<{ at: number; major: boolean; label?: string }> = [];
    for (let at = 0; at <= width; at += 9) {
      const major = Math.round(at) % 72 === 0;
      result.push({
        at,
        major,
        label: major ? String(Math.round(at / 72)) : undefined,
      });
    }
    return result;
  }, [width]);

  return (
    <div className="s-ruler-row" aria-hidden="true">
      <div className="s-ruler" style={{ width: `${ptToPx(width, zoom)}px` }}>
        <div
          className="s-ruler-content"
          style={{
            left: `${ptToPx(margins.left, zoom)}px`,
            width: `${ptToPx(Math.max(1, width - margins.left - margins.right), zoom)}px`,
          }}
        />
        {ticks.map((tick) => (
          <span
            key={tick.at}
            className={tick.major ? "s-ruler-tick is-major" : "s-ruler-tick"}
            style={{ left: `${ptToPx(tick.at, zoom)}px` }}
          >
            {tick.label ? (
              <span className="s-ruler-label">{tick.label}</span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface DockTab {
  id: string;
  label: string;
  active: boolean;
  disabled?: boolean;
  title?: string;
  onSelect(): void;
}

export function DockTabs({
  tabs,
  onClose,
  ariaLabel,
  className,
}: {
  tabs: readonly DockTab[];
  onClose?: () => void;
  ariaLabel: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={className ? `s-dock-tabs ${className}` : "s-dock-tabs"}
      role="tablist"
      aria-label={ariaLabel}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.active}
          className={tab.active ? "s-dock-tab is-active" : "s-dock-tab"}
          disabled={tab.disabled}
          title={tab.title ?? tab.label}
          onClick={tab.onSelect}
        >
          {tab.label}
        </button>
      ))}
      {onClose ? (
        <button
          type="button"
          className="s-dock-close"
          aria-label="Close side panel"
          title="Close side panel"
          onClick={onClose}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export function DocumentTitleInput({
  store,
  snapshot,
  className,
  ariaLabel = "Document title",
}: {
  store: AppStore;
  snapshot: AppSnapshot;
  className?: string;
  ariaLabel?: string;
}): React.JSX.Element {
  return (
    <input
      className={className ? `s-title-input ${className}` : "s-title-input"}
      aria-label={ariaLabel}
      value={snapshot.title}
      onChange={(event) => {
        const title = event.target.value;
        store.apply(
          "Rename document",
          (document) => {
            setMetadata(document, { title });
          },
          { coalesce: "title" },
        );
      }}
      onBlur={() => {
        if (store.session.dirty) store.autosaveNow();
      }}
      placeholder="Untitled document"
      spellCheck={false}
    />
  );
}

export function SaveStatus({
  snapshot,
  withLabel = false,
}: {
  snapshot: AppSnapshot;
  withLabel?: boolean;
}): React.JSX.Element {
  const state = snapshot.saving ? "saving" : snapshot.dirty ? "dirty" : "saved";
  const label = snapshot.saving
    ? "Saving…"
    : snapshot.dirty
      ? "Unsaved changes"
      : "Saved";
  return (
    <span
      className={`s-save-status is-${state}`}
      title={
        snapshot.offline
          ? `${label} · local recovery only (server unreachable)`
          : label
      }
    >
      <span className="s-status-dot" aria-hidden="true" />
      {withLabel ? label : null}
      {snapshot.offline ? (
        <span className="s-offline-chip">offline</span>
      ) : null}
    </span>
  );
}

export function ServerStatus({
  snapshot,
}: {
  snapshot: AppSnapshot;
}): React.JSX.Element {
  const capabilities = snapshot.health?.capabilities;
  const label = capabilities
    ? `Server ${snapshot.health?.version ?? ""}`
    : snapshot.healthError
      ? "Server unavailable"
      : "Connecting…";
  return (
    <span
      className={
        capabilities ? "s-server-status is-ok" : "s-server-status is-warn"
      }
      title={
        capabilities
          ? `API server ${snapshot.health?.version ?? ""}: renderer ${capabilities.renderer ? "on" : "off"}, AI ${capabilities.ai ? "on" : "off"}`
          : snapshot.healthError
            ? `API server unavailable: ${snapshot.healthError}`
            : "Connecting to the API server…"
      }
    >
      <span className="s-status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function PageStatus({
  snapshot,
  store,
  className,
}: {
  snapshot: AppSnapshot;
  store: AppStore;
  className?: string;
}): React.JSX.Element {
  const estimate = useMemo(
    () => estimatePages(snapshot.document, { position: store.selection.focus }),
    // The document is mutated in place; documentVersion is the real signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.document, snapshot.documentVersion, store.selection],
  );
  return (
    <span
      className={className ?? "s-page-status"}
      title="Estimated from content length; the server layout renderer is authoritative."
    >
      Page {estimate.currentPage} of {estimate.pageCount}
    </span>
  );
}

export function WordCount({
  snapshot,
}: {
  snapshot: AppSnapshot;
}): React.JSX.Element {
  return <span className="s-word-count">{snapshot.stats.words} words</span>;
}

export function LanguageStatus({
  snapshot,
}: {
  snapshot: AppSnapshot;
}): React.JSX.Element {
  const language = snapshot.document.styles.defaults.run?.language ?? "en-US";
  return (
    <span
      className="s-language-status"
      title={`Proofing language: ${language}`}
    >
      {language}
    </span>
  );
}

export function useSkinActions(store: AppStore) {
  return useMemo(() => createSkinActions(store), [store]);
}
