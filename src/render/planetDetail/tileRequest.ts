import type { DetailTileAddress } from './sourceAdapter';
import type { PersistentPlanetTileCache } from './persistentTileCache';
import type { PlanetDetailSessionBudget } from './detailBudget';

export interface PlanetTileResponse { readonly blob: Blob; readonly bytes: number; readonly cache: 'memory' | 'persistent' | 'network' }
interface MemoryEntry { readonly blob: Blob; lastAccess: number }

const MAX_MEMORY_ENTRIES = 128;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const memory = new Map<string, MemoryEntry>();
let memoryBytes = 0;

function remember(key: string, blob: Blob): void {
  const replaced = memory.get(key);
  if (replaced) memoryBytes -= replaced.blob.size;
  memory.set(key, { blob, lastAccess: Date.now() });
  memoryBytes += blob.size;
  while (memory.size > MAX_MEMORY_ENTRIES || memoryBytes > MAX_MEMORY_BYTES) {
    let oldestKey: string | null = null;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [candidateKey, entry] of memory) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = candidateKey;
      }
    }
    if (oldestKey === null) break;
    memoryBytes -= memory.get(oldestKey)!.blob.size;
    memory.delete(oldestKey);
  }
}

function validMime(address: Readonly<DetailTileAddress>, type: string): boolean {
  return (address.expectedMimeTypes ?? ['image/jpeg', 'image/png']).includes(type);
}

export async function requestPlanetTile(
  address: Readonly<DetailTileAddress>,
  signal: AbortSignal,
  persistent?: PersistentPlanetTileCache,
  sessionBudget?: PlanetDetailSessionBudget,
): Promise<PlanetTileResponse> {
  const memoryHit = memory.get(address.cacheKey);
  if (memoryHit) {
    memoryHit.lastAccess = Date.now();
    return { blob: memoryHit.blob, bytes: memoryHit.blob.size, cache: 'memory' };
  }
  const persistentHit = await persistent?.get(address.cacheKey);
  if (persistentHit) {
    const blob = await persistentHit.blob();
    if (validMime(address, blob.type) && blob.size <= address.maximumBytes) {
      remember(address.cacheKey, blob);
      return { blob, bytes: blob.size, cache: 'persistent' };
    }
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const timeout = AbortSignal.timeout(10_000);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const proxyBacked = address.url.startsWith('/api/planet-data?');
      if (proxyBacked) sessionBudget?.beginProxyRequest();
      const response = await fetch(address.url, { mode: 'cors', signal: combined, credentials: 'omit' });
      if (!response.ok) {
        if (response.status < 500 && response.status !== 429) throw new Error(`Permanent tile HTTP ${response.status}`);
        throw new Error(`Transient tile HTTP ${response.status}`);
      }
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > address.maximumBytes) throw new Error('Permanent: planet tile exceeds declared byte bound');
      const blob = await response.blob();
      if (!validMime(address, blob.type) || blob.size < 32 || blob.size > address.maximumBytes) throw new Error('Permanent: planet tile has invalid MIME or size');
      if (proxyBacked) sessionBudget?.recordProxyBytes(blob.size);
      remember(address.cacheKey, blob);
      await persistent?.put(address.cacheKey, new Response(blob, { headers: { 'content-type': blob.type } }), blob.size);
      return { blob, bytes: blob.size, cache: 'network' };
    } catch (error) {
      lastError = error;
      if (signal.aborted || String(error).includes('Permanent')) throw error;
      if (attempt < 2) {
        const jitter = Math.floor(Math.random() * 75);
        await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt + jitter));
      }
    }
  }
  throw lastError;
}
