import { createLegacyGameState } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import { GameState } from '../src/sim/state';
import { serializeGame } from '../src/save/persistence';
import { createSaveCollectionHandler, createSaveItemHandler, type CloudSaveRecord, type CloudSaveRepository } from '../server/saveHandlers';
import { RateLimiter } from '../server/rateLimit';
import type { CacheStore } from '../server/redis';

class MemoryCache implements CacheStore {
  values = new Map<string, unknown>();
  deleted: string[] = [];
  async getJson<T>(key: string): Promise<T | null> { return (this.values.get(key) as T) ?? null; }
  async setJson(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  async delete(...keys: string[]): Promise<void> { this.deleted.push(...keys); keys.forEach((key) => this.values.delete(key)); }
  async increment(): Promise<{ count: number; ttlSeconds: number }> { return { count: 1, ttlSeconds: 60 }; }
}

function record(revision = 1): CloudSaveRecord {
  const payload = serializeGame(createLegacyGameState(), 'Cloud test');
  return {
    slot: 'cloud-test', label: payload.label, saveVersion: payload.saveVersion,
    payloadHash: 'a'.repeat(64), revision,
    createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z', payload,
  };
}

function repository(overrides: Partial<CloudSaveRepository> = {}): CloudSaveRepository {
  return {
    list: async () => [record()], read: async () => record(),
    create: async () => record(), update: async () => record(2), delete: async () => 'deleted',
    ...overrides,
  };
}

function dependencies(repo: CloudSaveRepository, cache = new MemoryCache()) {
  return {
    cache,
    limiter: new RateLimiter(cache),
    authenticate: async () => ({ userId: 'user-1', repository: repo }),
  };
}

describe('cloud save handlers', () => {
  it('serves list reads from Redis after authentication', async () => {
    const cache = new MemoryCache();
    cache.values.set('perilune:saves:list:user-1', [record()]);
    const response = await createSaveCollectionHandler(dependencies(repository({
      list: async () => { throw new Error('database should not run'); },
    }), cache))(new Request('https://perilune.test/api/saves'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-perilune-cache')).toBe('hit');
  });

  it('creates a validated save and invalidates item and catalog caches', async () => {
    const cache = new MemoryCache();
    const save = record().payload;
    const response = await createSaveItemHandler(dependencies(repository(), cache), 'cloud-test')(
      new Request('https://perilune.test/api/saves/cloud-test', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ save, expectedRevision: null }),
      }),
    );
    expect(response.status).toBe(201);
    expect(cache.deleted).toEqual([
      'perilune:saves:item:user-1:cloud-test', 'perilune:saves:list:user-1',
    ]);
  });

  it('returns conflict without overwriting a stale revision', async () => {
    const save = record().payload;
    const response = await createSaveItemHandler(dependencies(repository({ update: async () => 'conflict' })), 'cloud-test')(
      new Request('https://perilune.test/api/saves/cloud-test', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ save, expectedRevision: 1 }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'SAVE_CONFLICT' } });
  });
});
