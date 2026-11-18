/**
 * Client-side document session.
 *
 * Holds the authoritative `DocDocument`, the model selection, undo/redo
 * (`DocumentHistory` from the shared model package), the dirty flag and a
 * local recovery snapshot. All edits happen through `apply()`, which records a
 * history entry so undo/redo restores exact document states.
 */
import {
  DocumentHistory,
  documentStats,
  listBlocks,
} from "@dsh-doc/core/model";
import type {
  DocDocument,
  DocRange,
  DocumentStats,
  RunProps,
  TextPosition,
} from "@dsh-doc/core/model";
import { normalizeRange, type EditorSelection } from "./selection";

export interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage used by tests and as a fallback when localStorage fails. */
export class MemoryStorage implements SessionStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** localStorage backed storage; degrades to memory when unavailable or full. */
export function createBrowserStorage(): SessionStorage {
  try {
    const probe = "__dsh_doc_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
      removeItem: (key) => window.localStorage.removeItem(key),
    };
  } catch {
    return new MemoryStorage();
  }
}

export interface RecoverySnapshot {
  version: 1;
  documentId: string;
  title: string;
  savedAt: number;
  /** `metadata.modified` of the last server-saved copy, to detect staleness. */
  baseModified?: string;
  document: DocDocument;
}

export interface SessionApplyOptions {
  /** Consecutive edits sharing a key within the coalescing window are one undo step. */
  coalesce?: string;
  /** Selection to restore once the mutation has been applied. */
  selection?: EditorSelection;
}

export type SessionChangeReason =
  "document" | "selection" | "dirty" | "history" | "load" | "save";

export interface SessionChange {
  reason: SessionChangeReason;
  label?: string;
}

export interface SessionOptions {
  documentId?: string;
  storage?: SessionStorage | null;
  historyLimit?: number;
  now?: () => number;
}

const COALESCE_WINDOW_MS = 900;
const RECOVERY_PREFIX = "dsh-doc:recovery:";

export function recoveryKey(documentId: string): string {
  return `${RECOVERY_PREFIX}${documentId}`;
}

export class DocumentSession {
  private current: DocDocument;
  private currentSelection: EditorSelection;
  private currentHistory: DocumentHistory;
  private isDirty = false;
  private pendingRunProps: RunProps | undefined;
  private lastCoalesceKey: string | undefined;
  private lastApplyAt = 0;
  private readonly listeners = new Set<(change: SessionChange) => void>();
  private readonly now: () => number;

  /** Storage/recovery identity of the document. */
  documentId: string;
  readonly storage: SessionStorage | null;
  readonly historyLimit: number;

  constructor(document: DocDocument, options: SessionOptions = {}) {
    this.current = document;
    this.documentId = options.documentId ?? document.id ?? "local";
    this.storage = options.storage ?? null;
    this.historyLimit = options.historyLimit ?? 100;
    this.now = options.now ?? (() => Date.now());
    this.currentHistory = new DocumentHistory(document, {
      limit: this.historyLimit,
    });
    this.currentSelection = this.defaultSelection(document);
  }

  private defaultSelection(document: DocDocument): EditorSelection {
    const first = listBlocks(document).find(
      (entry) => entry.block.type === "paragraph",
    );
    const blockId =
      first?.block.id ?? document.sections[0]?.blocks[0]?.id ?? "";
    const position: TextPosition = { blockId, inlineIndex: 0, offset: 0 };
    return { anchor: position, focus: { ...position } };
  }

  get document(): DocDocument {
    return this.current;
  }

  get selection(): EditorSelection {
    return this.currentSelection;
  }

  get dirty(): boolean {
    return this.isDirty;
  }

  /** Direct run formatting applied to text typed at a collapsed caret. */
  get pendingFormat(): RunProps | undefined {
    return this.pendingRunProps;
  }

  setPendingFormat(props: RunProps | undefined): void {
    this.pendingRunProps = props;
    this.emit({ reason: "selection" });
  }

  /** Rebinds the recovery slot when the document is saved/opened. */
  setDocumentId(documentId: string): void {
    this.documentId = documentId;
  }

  get blockOrder(): string[] {
    return listBlocks(this.current).map((entry) => entry.block.id);
  }

  get range(): DocRange {
    return normalizeRange(
      this.blockOrder,
      this.currentSelection.anchor,
      this.currentSelection.focus,
    );
  }

  get canUndo(): boolean {
    return this.currentHistory.canUndo();
  }

  get canRedo(): boolean {
    return this.currentHistory.canRedo();
  }

  stats(): DocumentStats {
    return documentStats(this.current);
  }

  historyEntries(): Array<{ id: number; label: string; timestamp: string }> {
    return this.currentHistory.list();
  }

  subscribe(listener: (change: SessionChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: SessionChange): void {
    for (const listener of this.listeners) listener(change);
  }

  setSelection(
    anchor: TextPosition,
    focus: TextPosition,
    options: { notify?: boolean } = {},
  ): void {
    this.currentSelection = { anchor, focus };
    this.pendingRunProps = undefined;
    if (options.notify !== false) this.emit({ reason: "selection" });
  }

  /**
   * Applies a mutation to the document and records it in the undo history.
   *
   * The mutation receives the live document; history snapshots are clones, so
   * restoring always yields an exact previous state.
   */
  apply(
    label: string,
    mutate: (document: DocDocument) => void,
    options: SessionApplyOptions = {},
  ): boolean {
    const previousSnapshot = this.currentHistory.current()?.document;
    try {
      mutate(this.current);
    } catch (error) {
      // Roll back to the last recorded snapshot so a partially applied
      // operation can never leave the model in a half-edited state.
      if (previousSnapshot) this.current = structuredClone(previousSnapshot);
      throw error;
    }

    const now = this.now();
    const coalesceKey = options.coalesce;
    const coalesced =
      coalesceKey !== undefined &&
      coalesceKey === this.lastCoalesceKey &&
      now - this.lastApplyAt < COALESCE_WINDOW_MS;

    if (!coalesced) {
      this.currentHistory.push(this.current, label);
    }
    this.lastCoalesceKey = coalesceKey;
    this.lastApplyAt = now;
    this.isDirty = true;
    if (options.selection) {
      this.currentSelection = options.selection;
      this.pendingRunProps = undefined;
    }
    this.emit({ reason: "document", label });
    return true;
  }

  undo(): boolean {
    const entry = this.currentHistory.undo();
    if (!entry) return false;
    this.restore(entry.document, entry.label, "Undo");
    return true;
  }

  redo(): boolean {
    const entry = this.currentHistory.redo();
    if (!entry) return false;
    this.restore(entry.document, entry.label, "Redo");
    return true;
  }

  private restore(document: DocDocument, label: string, kind: string): void {
    this.current = document;
    this.isDirty = true;
    this.lastCoalesceKey = undefined;
    this.ensureSelectionInDocument();
    this.emit({ reason: "history", label: `${kind}: ${label}` });
  }

  private ensureSelectionInDocument(): void {
    const order = new Set(this.blockOrder);
    if (order.has(this.currentSelection.focus.blockId)) return;
    this.currentSelection = this.defaultSelection(this.current);
  }

  /** Replaces the document wholesale (open, import, recovery, new document). */
  setDocument(
    document: DocDocument,
    options: {
      label?: string;
      resetHistory?: boolean;
      markClean?: boolean;
      selection?: EditorSelection;
    } = {},
  ): void {
    this.current = document;
    if (options.resetHistory !== false) {
      this.currentHistory = new DocumentHistory(document, {
        limit: this.historyLimit,
      });
    } else {
      this.currentHistory.push(document, options.label ?? "Document replaced");
    }
    this.currentSelection =
      options.selection ?? this.defaultSelection(document);
    this.isDirty = options.markClean ? false : true;
    this.lastCoalesceKey = undefined;
    this.pendingRunProps = undefined;
    this.emit({ reason: "load", label: options.label ?? "load" });
  }

  markSaved(savedDocument?: DocDocument): void {
    if (savedDocument) this.current = savedDocument;
    this.isDirty = false;
    this.discardRecovery();
    this.emit({ reason: "save" });
  }

  /* -------------------------------------------------------------- recovery */

  autosave(title?: string, savedAt = this.now()): boolean {
    if (!this.storage) return false;
    const key = recoveryKey(this.documentId);
    const snapshot: RecoverySnapshot = {
      version: 1,
      documentId: this.documentId,
      title: title ?? this.current.metadata.title ?? "Untitled document",
      savedAt,
      baseModified: this.current.metadata.modified,
      document: this.current,
    };
    try {
      this.storage.setItem(key, JSON.stringify(snapshot));
      return true;
    } catch {
      return false;
    }
  }

  readRecovery(): RecoverySnapshot | null {
    if (!this.storage) return null;
    const raw = this.storage.getItem(recoveryKey(this.documentId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as RecoverySnapshot;
      if (!parsed || parsed.version !== 1 || !parsed.document) return null;
      if (parsed.documentId !== this.documentId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  recover(snapshot: RecoverySnapshot): void {
    this.setDocument(snapshot.document, {
      label: "Recovered unsaved changes",
      resetHistory: true,
    });
  }

  discardRecovery(): void {
    this.storage?.removeItem(recoveryKey(this.documentId));
  }

  /** True when an unsaved recovery snapshot exists for this document. */
  hasNewerRecovery(): boolean {
    return this.readRecovery() !== null;
  }
}
