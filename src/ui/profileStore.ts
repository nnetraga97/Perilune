/**
 * Local profile store for UI preferences: window positions, open panels,
 * and (later) keybindings and settings.
 *
 * Deliberately separate from the versioned game save (spec: UI redesign,
 * "two persistence tiers"): switching or deleting a save never resets the
 * player's layout, and UI iteration never forces a save-schema migration.
 * Backed by localStorage when available; degrades to in-memory silently
 * (private browsing, storage quota, embedded harnesses).
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'perilune.ui.';

export class ProfileStore {
  constructor(private readonly storage: KeyValueStorage | null) {}

  get<T>(key: string, fallback: T): T {
    if (!this.storage) return fallback;
    try {
      const raw = this.storage.getItem(PREFIX + key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Quota/permission failures lose a preference, never gameplay.
    }
  }

  delete(key: string): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  }
}

/** The browser-backed store; null storage when localStorage is unusable. */
export function browserProfileStore(): ProfileStore {
  try {
    const probe = '__perilune_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return new ProfileStore(window.localStorage);
  } catch {
    return new ProfileStore(null);
  }
}
