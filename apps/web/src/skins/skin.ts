/**
 * Skin identity, persistence and the runtime switcher state.
 *
 * The skin is pure chrome: it is deliberately kept out of the document model
 * and even out of `AppStore`. `SkinStore` is a tiny external store (same shape
 * as the app store) so a skin change re-renders the chrome without touching the
 * document, the selection, or the undo history.
 */
import { useSyncExternalStore } from "react";

export const SKIN_IDS = ["gdocs", "word", "pages", "writer"] as const;

export type SkinId = (typeof SKIN_IDS)[number];

export const DEFAULT_SKIN: SkinId = "gdocs";

export type Theme = "system" | "light" | "dark";

export function themeLabel(theme: Theme): string {
  return theme === "system" ? "System" : theme === "light" ? "Light" : "Dark";
}

/** Namespaced localStorage key; other apps must not collide with it. */
export const SKIN_STORAGE_KEY = "dsh-doc:skin";

export interface SkinOption {
  id: SkinId;
  /** Product name shown in the skin menus. */
  name: string;
  /** Compact label for the app-bar switcher. */
  shortName: string;
  /** One-line description used in the menu. */
  description: string;
}

export const SKIN_OPTIONS: readonly SkinOption[] = [
  {
    id: "gdocs",
    name: "Google Docs",
    shortName: "Docs",
    description: "White app bar, compact toolbar, blue-gray canvas",
  },
  {
    id: "word",
    name: "Microsoft Word",
    shortName: "Word",
    description: "Blue title bar, ribbon, ruler and status bar",
  },
  {
    id: "pages",
    name: "Apple Pages",
    shortName: "Pages",
    description: "Light top bar, slim toolbar and Format inspector",
  },
  {
    id: "writer",
    name: "LibreOffice Writer",
    shortName: "Writer",
    description: "Menu bar, two toolbars, gray canvas and sidebar deck",
  },
];

export function isSkinId(value: unknown): value is SkinId {
  return (
    typeof value === "string" && (SKIN_IDS as readonly string[]).includes(value)
  );
}

export function skinOption(id: SkinId): SkinOption {
  return SKIN_OPTIONS.find((option) => option.id === id) ?? SKIN_OPTIONS[0];
}

/** Minimal storage contract so tests can pass a plain object. */
export interface SkinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Returns browser localStorage only when it is actually usable. */
export function browserSkinStorage(): SkinStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const probe = `${SKIN_STORAGE_KEY}:probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export function readStoredSkin(storage: SkinStorage | null): SkinId | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(SKIN_STORAGE_KEY);
    return isSkinId(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Persists the choice; returns false when storage refused the write. */
export function writeStoredSkin(
  storage: SkinStorage | null,
  skin: SkinId,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SKIN_STORAGE_KEY, skin);
    return true;
  } catch {
    return false;
  }
}

/** `?skin=word` testing override; invalid values are ignored, not persisted. */
export function skinFromQuery(search: string): SkinId | null {
  if (!search) return null;
  try {
    const value = new URLSearchParams(
      search.startsWith("?") ? search.slice(1) : search,
    ).get("skin");
    return isSkinId(value) ? value : null;
  } catch {
    return null;
  }
}

export interface ResolveSkinOptions {
  /** Raw `location.search` value (with or without the leading `?`). */
  search?: string;
  storage?: SkinStorage | null;
  fallback?: SkinId;
}

/**
 * Resolution order: `?skin=` override, then the stored preference, then
 * `gdocs`. The query override is intentionally never written back.
 */
export function resolveInitialSkin(options: ResolveSkinOptions = {}): SkinId {
  return (
    skinFromQuery(options.search ?? "") ??
    readStoredSkin(options.storage ?? null) ??
    options.fallback ??
    DEFAULT_SKIN
  );
}

export interface SkinStoreOptions {
  storage?: SkinStorage | null;
  search?: string;
  fallback?: SkinId;
}

/**
 * Observable skin selection. Kept separate from `AppStore` on purpose: a skin
 * change must never touch the document session, its selection or its history.
 */
export class SkinStore {
  private current: SkinId;
  private readonly storage: SkinStorage | null;
  private readonly listeners = new Set<() => void>();

  constructor(options: SkinStoreOptions = {}) {
    this.storage =
      options.storage === undefined ? browserSkinStorage() : options.storage;
    this.current = resolveInitialSkin({
      search: options.search,
      storage: this.storage,
      fallback: options.fallback,
    });
  }

  getSnapshot = (): SkinId => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Selects a skin, persisting it for the next page load. */
  setSkin(skin: SkinId): void {
    if (!isSkinId(skin) || skin === this.current) return;
    this.current = skin;
    writeStoredSkin(this.storage, skin);
    for (const listener of this.listeners) listener();
  }
}

export function useSkin(store: SkinStore): SkinId {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
