import { afterEach, describe, expect, it } from 'vitest';
import { PersistentPlanetTileCache } from '../src/render/planetDetail/persistentTileCache';

class MemoryCache {
  readonly values = new Map<string, Response>();
  async match(request: Request): Promise<Response | undefined> { return this.values.get(request.url)?.clone(); }
  async put(request: Request, response: Response): Promise<void> { this.values.set(request.url, response.clone()); }
  async delete(request: Request): Promise<boolean> { return this.values.delete(request.url); }
}

const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
  else delete (globalThis as { caches?: CacheStorage }).caches;
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete (globalThis as { window?: Window }).window;
});

describe('persistent planet tile cache', () => {
  it('namespaces by source generation and evicts least-recently-used bytes', async () => {
    const backing = new Map<string, MemoryCache>();
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: {
      open: async (name: string) => {
        const cache = backing.get(name) ?? new MemoryCache();
        backing.set(name, cache);
        return cache;
      },
    } });
    const stored = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      localStorage,
      location: { origin: 'https://perilune.test' },
    } });

    const cache = new PersistentPlanetTileCache('generation-a', 80);
    await cache.put('first', new Response(new Uint8Array(48)), 48);
    await cache.put('second', new Response(new Uint8Array(48)), 48);
    expect(await cache.get('first')).toBeNull();
    expect(await cache.get('second')).not.toBeNull();
    expect(cache.stats()).toEqual({ entries: 1, bytes: 48, byteBudget: 80 });

    const otherGeneration = new PersistentPlanetTileCache('generation-b', 80);
    expect(await otherGeneration.get('second')).toBeNull();
  });
});
