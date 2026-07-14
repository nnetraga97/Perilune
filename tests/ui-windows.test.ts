/**
 * Profile store and window-position logic for the instrument-window layer
 * (spec: 2026-07-13 UI redesign, workstream 1). DOM-free.
 */
import { describe, expect, it } from 'vitest';
import { ProfileStore, type KeyValueStorage } from '../src/ui/profileStore';
import { clampWindowPos } from '../src/ui/window';

function memoryStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('ProfileStore', () => {
  it('round-trips JSON values under the namespaced key', () => {
    const storage = memoryStorage();
    const store = new ProfileStore(storage);
    store.set('win.alarms', { x: 40, y: 80, collapsed: true, open: true });
    expect(store.get('win.alarms', null)).toEqual({ x: 40, y: 80, collapsed: true, open: true });
    expect([...storage.map.keys()]).toEqual(['perilune.ui.win.alarms']);
  });

  it('returns the fallback for missing keys and corrupt JSON', () => {
    const storage = memoryStorage();
    const store = new ProfileStore(storage);
    expect(store.get('missing', 'fallback')).toBe('fallback');
    storage.map.set('perilune.ui.bad', '{not json');
    expect(store.get('bad', 42)).toBe(42);
  });

  it('degrades silently without storage and on storage errors', () => {
    const nullStore = new ProfileStore(null);
    nullStore.set('a', 1);
    expect(nullStore.get('a', 'fb')).toBe('fb');

    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const store = new ProfileStore(throwing);
    expect(() => store.set('a', 1)).not.toThrow();
    expect(store.get('a', 'fb')).toBe('fb');
    expect(() => store.delete('a')).not.toThrow();
  });

  it('deletes stored keys', () => {
    const storage = memoryStorage();
    const store = new ProfileStore(storage);
    store.set('gone', 1);
    store.delete('gone');
    expect(store.get('gone', 'fb')).toBe('fb');
  });
});

describe('clampWindowPos', () => {
  it('keeps in-range positions unchanged', () => {
    expect(clampWindowPos(100, 200, 250, 1280, 720)).toEqual({ x: 100, y: 200 });
  });

  it('keeps at least a sliver of the title bar reachable on every edge', () => {
    // Dragged far left: at most width-48 off-screen.
    expect(clampWindowPos(-1000, 100, 250, 1280, 720).x).toBe(48 - 250);
    // Dragged far right: 48px must remain visible.
    expect(clampWindowPos(5000, 100, 250, 1280, 720).x).toBe(1280 - 48);
    // Never above the top; never below reach of the bottom.
    expect(clampWindowPos(100, -50, 250, 1280, 720).y).toBe(0);
    expect(clampWindowPos(100, 5000, 250, 1280, 720).y).toBe(720 - 28);
  });
});
