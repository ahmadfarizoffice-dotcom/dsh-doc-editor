/**
 * Lightweight application store (no redux): document session, UI state, toasts,
 * dirty tracking, a 5s idle autosave and server synchronization.
 */
import { useSyncExternalStore } from "react";
import { createDocument } from "@dsh-doc/core/model";
import type { DocDocument, TextPosition } from "@dsh-doc/core/model";
import {
  ApiError,
  DocumentApiClient,
  downloadBlob,
  errorMessage,
  type AiAssistRequest,
  type AiAssistResponse,
  type DocumentSummary,
  type HealthResponse,
} from "./api";
import {
  DocumentSession,
  createBrowserStorage,
  type MemoryStorage,
  type RecoverySnapshot,
  type SessionStorage,
} from "../model/session";
import type { EditorSelection } from "../model/selection";
import type { TextMatch } from "../model/ops";

export type ViewMode = "editor" | "preview";
export type ToastKind = "info" | "success" | "error";
export type AiMode = "ask" | "suggest" | "edit";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export type DialogState =
  | { kind: "table" }
  | { kind: "link" }
  | { kind: "footnote" }
  | { kind: "comment" }
  | { kind: "section-break" }
  | { kind: "toc" }
  | { kind: "find" }
  | { kind: "files" }
  | { kind: "recovery"; snapshot: RecoverySnapshot }
  | { kind: "shortcuts" };

export interface UiState {
  view: ViewMode;
  showOutline: boolean;
  rightPane: "none" | "comments" | "ai";
  aiMode: AiMode;
  zoom: number;
  showFormattingMarks: boolean;
  activeCommentId: string | null;
  dialog: DialogState | null;
  aiAvailable: boolean;
  aiUnavailableReason: string | null;
  aiBusy: boolean;
  aiError: string | null;
  aiResult: AiAssistResponse | null;
  aiHistory: Array<{
    id: number;
    mode: AiMode;
    prompt: string;
    result: AiAssistResponse | null;
    error: string | null;
  }>;
  findQuery: string;
  findCaseSensitive: boolean;
  findWholeWord: boolean;
  findMatches: TextMatch[];
  findActiveIndex: number;
}

export interface AppSnapshot {
  version: number;
  /** Increments only when the document content changes (UI changes excluded). */
  documentVersion: number;
  document: DocDocument;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  documentId: string | null;
  title: string;
  ui: UiState;
  toasts: Toast[];
  documents: DocumentSummary[];
  health: HealthResponse | null;
  healthError: string | null;
  saving: boolean;
  offline: boolean;
  stats: {
    words: number;
    characters: number;
    charactersWithSpaces: number;
    paragraphs: number;
    tables: number;
    images: number;
  };
}

export interface AppStoreOptions {
  api?: DocumentApiClient;
  session?: DocumentSession;
  storage?: SessionStorage | null;
  initialDocument?: DocDocument;
  autosaveDelayMs?: number;
  now?: () => number;
}

const DEFAULT_UI: UiState = {
  view: "editor",
  showOutline: true,
  rightPane: "none",
  aiMode: "ask",
  zoom: 1,
  showFormattingMarks: false,
  activeCommentId: null,
  dialog: null,
  aiAvailable: false,
  aiUnavailableReason: null,
  aiBusy: false,
  aiError: null,
  aiResult: null,
  aiHistory: [],
  findQuery: "",
  findCaseSensitive: false,
  findWholeWord: false,
  findMatches: [],
  findActiveIndex: -1,
};

/** Selection notification channel: keeps toolbar re-renders away from the surface. */
export class SelectionBus {
  private version = 0;
  private readonly listeners = new Set<() => void>();

  notify = (): void => {
    this.version += 1;
    for (const listener of this.listeners) listener();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.version;
}

export class AppStore {
  readonly api: DocumentApiClient;
  readonly session: DocumentSession;
  readonly selectionBus = new SelectionBus();
  private readonly autosaveDelayMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private snapshot: AppSnapshot;
  private version = 0;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private toastSequence = 0;
  private aiSequence = 0;
  private readonly toastTimers = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();
  private readonly unsubscribeSession: () => void;

  constructor(options: AppStoreOptions = {}) {
    this.api = options.api ?? new DocumentApiClient();
    this.autosaveDelayMs = options.autosaveDelayMs ?? 5000;
    this.now = options.now ?? (() => Date.now());
    const initialDocument =
      options.initialDocument ??
      options.session?.document ??
      this.newLocalDocument();
    const storage =
      options.storage === undefined ? safeBrowserStorage() : options.storage;
    this.session =
      options.session ??
      new DocumentSession(initialDocument, { storage, documentId: "local" });
    this.snapshot = {
      version: 0,
      documentVersion: 0,
      document: this.session.document,
      dirty: this.session.dirty,
      canUndo: false,
      canRedo: false,
      documentId: null,
      title: this.session.document.metadata.title ?? "Untitled document",
      ui: { ...DEFAULT_UI },
      toasts: [],
      documents: [],
      health: null,
      healthError: null,
      saving: false,
      offline: false,
      stats: this.session.stats(),
    };
    this.unsubscribeSession = this.session.subscribe((change) => {
      if (
        change.reason === "document" ||
        change.reason === "history" ||
        change.reason === "load" ||
        change.reason === "save"
      ) {
        this.syncFromSession();
        if (change.reason === "document" && this.session.dirty)
          this.scheduleAutosave();
      }
    });
  }

  private newLocalDocument(): DocDocument {
    const document = createDocument({ title: "Untitled document" });
    return document;
  }

  /* ------------------------------------------------------------ plumbing */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppSnapshot => this.snapshot;

  private commit(patch: Partial<AppSnapshot>): void {
    this.version += 1;
    this.snapshot = { ...this.snapshot, ...patch, version: this.version };
    for (const listener of this.listeners) listener();
  }

  private syncFromSession(): void {
    this.commit({
      document: this.session.document,
      documentVersion: this.snapshot.documentVersion + 1,
      dirty: this.session.dirty,
      canUndo: this.session.canUndo,
      canRedo: this.session.canRedo,
      title: this.session.document.metadata.title ?? "Untitled document",
      stats: this.session.stats(),
    });
  }

  dispose(): void {
    this.unsubscribeSession();
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    for (const timer of this.toastTimers.values()) clearTimeout(timer);
  }

  /* --------------------------------------------------------------- editing */

  apply(
    label: string,
    mutate: (document: DocDocument) => void,
    options: { coalesce?: string; selection?: EditorSelection } = {},
  ): boolean {
    try {
      this.session.apply(label, mutate, options);
      return true;
    } catch (error) {
      this.toast(errorMessage(error), "error");
      return false;
    }
  }

  undo(): void {
    if (!this.session.undo()) this.toast("Nothing to undo", "info");
    this.selectionBus.notify();
  }

  redo(): void {
    if (!this.session.redo()) this.toast("Nothing to redo", "info");
    this.selectionBus.notify();
  }

  setSelection(anchor: TextPosition, focus: TextPosition): void {
    this.session.setSelection(anchor, focus, { notify: false });
    this.selectionBus.notify();
  }

  setPendingFormat(
    patch: Parameters<DocumentSession["setPendingFormat"]>[0],
  ): void {
    this.session.setPendingFormat(patch);
    this.selectionBus.notify();
  }

  /* ------------------------------------------------------------------- ui */

  setUi(patch: Partial<UiState>): void {
    this.commit({ ui: { ...this.snapshot.ui, ...patch } });
  }

  openDialog(dialog: DialogState): void {
    this.setUi({ dialog });
  }

  closeDialog(): void {
    this.setUi({ dialog: null });
  }

  setView(view: ViewMode): void {
    this.setUi({ view });
  }

  setZoom(zoom: number): void {
    this.setUi({ zoom: Math.min(2, Math.max(0.5, zoom)) });
  }

  toast(message: string, kind: ToastKind = "info"): void {
    this.toastSequence += 1;
    const toast: Toast = { id: this.toastSequence, kind, message };
    const toasts = [...this.snapshot.toasts, toast].slice(-4);
    this.commit({ toasts });
    const timer = setTimeout(
      () => this.dismissToast(toast.id),
      kind === "error" ? 9000 : 4500,
    );
    this.toastTimers.set(toast.id, timer);
  }

  dismissToast(id: number): void {
    const timer = this.toastTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.toastTimers.delete(id);
    }
    this.commit({
      toasts: this.snapshot.toasts.filter((toast) => toast.id !== id),
    });
  }

  /* -------------------------------------------------------------- autosave */

  private scheduleAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      this.autosaveNow();
    }, this.autosaveDelayMs);
  }

  autosaveNow(): boolean {
    if (!this.session.dirty) return false;
    const stored = this.session.autosave(this.snapshot.title, this.now());
    if (!stored)
      this.commit({
        healthError:
          this.snapshot.healthError ??
          "Autosave is unavailable: local storage is disabled.",
      });
    return stored;
  }

  /* --------------------------------------------------------------- backend */

  async bootstrap(): Promise<void> {
    const recovery = this.session.hasNewerRecovery()
      ? this.session.readRecovery()
      : null;
    if (recovery) this.openDialog({ kind: "recovery", snapshot: recovery });

    try {
      const health = await this.api.health();
      this.commit({
        health,
        healthError: null,
        offline: false,
        ui: {
          ...this.snapshot.ui,
          aiAvailable: health.capabilities.ai,
          aiUnavailableReason: health.capabilities.ai
            ? null
            : "The server reports that no AI provider is configured (POST /api/ai/assist returns AI_PROVIDER_NOT_CONFIGURED).",
        },
      });
    } catch (error) {
      this.commit({
        health: null,
        healthError: errorMessage(error),
        offline: true,
        ui: {
          ...this.snapshot.ui,
          aiAvailable: false,
          aiUnavailableReason:
            "The document server is unreachable, so AI assistance is unavailable.",
        },
      });
    }
    await this.refreshDocuments();
  }

  async refreshDocuments(): Promise<void> {
    try {
      const documents = await this.api.listDocuments();
      this.commit({ documents, offline: false });
    } catch (error) {
      this.commit({
        documents: [],
        offline: true,
        healthError: errorMessage(error),
      });
    }
  }

  async createDocument(title = "Untitled document"): Promise<boolean> {
    const local = createDocument({ title });
    try {
      const record = await this.api.createDocument({ title, document: local });
      this.loadRecord(record.id, record.document, record.title);
      await this.refreshDocuments();
      this.toast("Document created on the server", "success");
      return true;
    } catch (error) {
      this.session.setDocument(local, { resetHistory: true, markClean: false });
      this.commit({ documentId: null, offline: true });
      this.toast(`Working locally: ${errorMessage(error)}`, "error");
      return false;
    }
  }

  async openDocumentById(id: string): Promise<boolean> {
    try {
      const record = await this.api.getDocument(id);
      this.loadRecord(record.id, record.document, record.title);
      this.closeDialog();
      this.toast(`Opened “${record.title}”`, "success");
      return true;
    } catch (error) {
      this.toast(`Could not open “${id}”: ${errorMessage(error)}`, "error");
      return false;
    }
  }

  async openUpload(file: File): Promise<boolean> {
    try {
      const record = await this.api.openDocument(file, file.name);
      this.loadRecord(record.id, record.document, record.title);
      this.closeDialog();
      this.toast(`Imported ${file.name}`, "success");
      await this.refreshDocuments();
      return true;
    } catch (error) {
      this.toast(`Import failed: ${errorMessage(error)}`, "error");
      return false;
    }
  }

  async save(): Promise<boolean> {
    const document = this.session.document;
    const title = document.metadata.title ?? "Untitled document";
    this.commit({ saving: true });
    try {
      const record = this.snapshot.documentId
        ? await this.api.saveDocument(this.snapshot.documentId, document, title)
        : await this.api.createDocument({ title, document });
      this.session.markSaved(record.document ?? document);
      this.commit({ documentId: record.id, saving: false, offline: false });
      await this.refreshDocuments();
      this.toast("Saved", "success");
      return true;
    } catch (error) {
      this.commit({ saving: false });
      this.toast(`Save failed: ${errorMessage(error)}`, "error");
      return false;
    }
  }

  private loadRecord(id: string, document: DocDocument, title: string): void {
    this.session.setDocumentId(id);
    this.session.setDocument(document, { resetHistory: true, markClean: true });
    this.session.document.metadata.title =
      title ?? this.session.document.metadata.title;
    this.commit({
      documentId: id,
      dirty: false,
      document: this.session.document,
    });
  }

  async deleteDocument(id: string): Promise<boolean> {
    try {
      await this.api.deleteDocument(id);
      if (this.snapshot.documentId === id) this.commit({ documentId: null });
      await this.refreshDocuments();
      this.toast("Document deleted", "success");
      return true;
    } catch (error) {
      this.toast(`Delete failed: ${errorMessage(error)}`, "error");
      return false;
    }
  }

  async exportDocument(format: string): Promise<boolean> {
    const id = this.snapshot.documentId;
    if (!id) {
      const saved = await this.save();
      if (!saved) return false;
    }
    const documentId = this.snapshot.documentId;
    if (!documentId) return false;
    try {
      const { blob, fileName } = await this.api.exportDocument(
        documentId,
        format,
      );
      downloadBlob(blob, fileName);
      this.toast(`Exported ${format.toUpperCase()}`, "success");
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 501) {
        this.toast(`Export unavailable: ${error.message}`, "error");
      } else {
        this.toast(`Export failed: ${errorMessage(error)}`, "error");
      }
      return false;
    }
  }

  /* -------------------------------------------------------------------- ai */

  async runAi(request: Omit<AiAssistRequest, "document">): Promise<void> {
    this.aiSequence += 1;
    const entryId = this.aiSequence;
    const mode = request.mode;
    this.setUi({ aiBusy: true, aiResult: null, aiError: null });
    try {
      const result = await this.api.assist({
        ...request,
        document: this.session.document,
      });
      const history = [
        ...this.snapshot.ui.aiHistory,
        { id: entryId, mode, prompt: request.prompt, result, error: null },
      ].slice(-8);
      this.setUi({
        aiBusy: false,
        aiResult: result,
        aiHistory: history,
        aiError: null,
      });
    } catch (error) {
      const message =
        error instanceof ApiError && error.code === "AI_PROVIDER_NOT_CONFIGURED"
          ? "The server has no AI provider configured (AI_PROVIDER_NOT_CONFIGURED). No AI output was generated."
          : errorMessage(error);
      const history = [
        ...this.snapshot.ui.aiHistory,
        {
          id: entryId,
          mode,
          prompt: request.prompt,
          result: null,
          error: message,
        },
      ].slice(-8);
      this.setUi({
        aiBusy: false,
        aiResult: null,
        aiHistory: history,
        aiError: message,
      });
      if (error instanceof ApiError && error.status === 501) {
        this.toast(message, "error");
      }
    }
  }

  /* -------------------------------------------------------------- recovery */

  acceptRecovery(): void {
    const dialog = this.snapshot.ui.dialog;
    if (!dialog || dialog.kind !== "recovery") return;
    this.session.recover(dialog.snapshot);
    this.closeDialog();
    this.toast("Recovered unsaved changes", "success");
  }

  discardRecovery(): void {
    this.session.discardRecovery();
    this.closeDialog();
    this.toast("Recovery copy discarded", "info");
  }

  /* --------------------------------------------------------------- helpers */

  /** Current model selection (used by panels and the toolbar at action time). */
  get selection(): EditorSelection {
    return this.session.selection;
  }

  hasServer(): boolean {
    return this.snapshot.health !== null;
  }
}

function safeBrowserStorage(): SessionStorage | MemoryStorage | null {
  if (typeof window === "undefined") return null;
  return createBrowserStorage();
}

export function useAppStore(store: AppStore): AppSnapshot {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

export function useSelectionVersion(store: AppStore): number {
  return useSyncExternalStore(
    store.selectionBus.subscribe,
    store.selectionBus.getSnapshot,
    store.selectionBus.getSnapshot,
  );
}
