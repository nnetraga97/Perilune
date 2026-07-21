interface CacheIndexEntry { readonly key: string; readonly bytes: number; lastAccess: number }

export class PersistentPlanetTileCache {
  private readonly indexKey: string;
  private readonly cacheName: string;
  private readonly storage: Storage | null;
  private index: CacheIndexEntry[];

  constructor(namespace: string, private readonly byteBudget: number) {
    this.cacheName = `perilune-planet-detail-${namespace}`;
    this.indexKey = `${this.cacheName}:index`;
    try { this.storage = typeof window === 'undefined' ? null : window.localStorage; }
    catch { this.storage = null; }
    try { this.index = JSON.parse(this.storage?.getItem(this.indexKey) ?? '[]') as CacheIndexEntry[]; }
    catch { this.index = []; }
  }

  private available(): boolean { return this.byteBudget > 0 && typeof caches !== 'undefined'; }
  private request(key: string): Request {
    const origin = typeof window === 'undefined' ? 'https://perilune.invalid' : window.location.origin;
    return new Request(`${origin}/__planet-detail-cache/${encodeURIComponent(key)}`);
  }

  async get(key: string): Promise<Response | null> {
    if (!this.available()) return null;
    const response = await (await caches.open(this.cacheName)).match(this.request(key));
    if (!response) return null;
    const entry = this.index.find((candidate) => candidate.key === key);
    if (entry) entry.lastAccess = Date.now();
    this.persistIndex();
    return response;
  }

  async put(key: string, response: Response, bytes: number): Promise<void> {
    if (!this.available() || bytes > this.byteBudget) return;
    const cache = await caches.open(this.cacheName);
    await cache.put(this.request(key), response.clone());
    this.index = this.index.filter((entry) => entry.key !== key);
    this.index.push({ key, bytes, lastAccess: Date.now() });
    this.index.sort((left, right) => left.lastAccess - right.lastAccess);
    let total = this.index.reduce((sum, entry) => sum + entry.bytes, 0);
    while (total > this.byteBudget && this.index.length > 0) {
      const evicted = this.index.shift()!;
      total -= evicted.bytes;
      await cache.delete(this.request(evicted.key));
    }
    this.persistIndex();
  }

  private persistIndex(): void {
    try { this.storage?.setItem(this.indexKey, JSON.stringify(this.index)); } catch {}
  }

  stats(): Readonly<{ entries: number; bytes: number; byteBudget: number }> {
    return Object.freeze({
      entries: this.index.length,
      bytes: this.index.reduce((sum, entry) => sum + entry.bytes, 0),
      byteBudget: this.byteBudget,
    });
  }
}
