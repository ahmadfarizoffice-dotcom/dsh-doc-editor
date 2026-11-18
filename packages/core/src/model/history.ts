import type { DocDocument } from "./types.js";

export interface HistoryEntry {
  id: number;
  label: string;
  timestamp: number;
  document: DocDocument;
}

export interface HistoryOptions {
  /** Maximum retained snapshots (default 100). */
  limit?: number;
}

/**
 * Snapshot based undo/redo stack. Snapshots are structured clones, which keeps
 * restoration exact (no partial rollback) at the cost of memory; the limit keeps
 * that bounded.
 */
export class DocumentHistory {
  private entries: HistoryEntry[] = [];
  private index = -1;
  private sequence = 0;
  private readonly limit: number;

  constructor(initial: DocDocument, options: HistoryOptions = {}) {
    this.limit = Math.max(1, options.limit ?? 100);
    this.entries.push({
      id: this.sequence,
      label: "Initial state",
      timestamp: Date.now(),
      document: structuredClone(initial),
    });
    this.index = 0;
  }

  /** Records a new snapshot after a mutation. */
  push(document: DocDocument, label: string): HistoryEntry {
    // Drop redo branch.
    this.entries = this.entries.slice(0, this.index + 1);
    this.sequence += 1;
    const entry: HistoryEntry = {
      id: this.sequence,
      label,
      timestamp: Date.now(),
      document: structuredClone(document),
    };
    this.entries.push(entry);
    while (this.entries.length > this.limit) {
      this.entries.shift();
      this.index -= 1;
    }
    this.index = this.entries.length - 1;
    return entry;
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  undo(): HistoryEntry | undefined {
    if (!this.canUndo()) return undefined;
    this.index -= 1;
    const entry = this.entries[this.index];
    return { ...entry, document: structuredClone(entry.document) };
  }

  redo(): HistoryEntry | undefined {
    if (!this.canRedo()) return undefined;
    this.index += 1;
    const entry = this.entries[this.index];
    return { ...entry, document: structuredClone(entry.document) };
  }

  current(): HistoryEntry | undefined {
    return this.entries[this.index];
  }

  /** Revision list for the version history pane (newest first). */
  list(): Array<{ id: number; label: string; timestamp: string }> {
    return this.entries
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        timestamp: new Date(entry.timestamp).toISOString(),
      }))
      .reverse();
  }

  /** Restores a specific snapshot by id (version history). */
  restore(id: number): HistoryEntry | undefined {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index < 0) return undefined;
    this.index = index;
    const entry = this.entries[index];
    return { ...entry, document: structuredClone(entry.document) };
  }

  get size(): number {
    return this.entries.length;
  }
}
