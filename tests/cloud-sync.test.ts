import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from '../src/cloud/auth';
import { CloudClientError, type CloudSaveClient } from '../src/cloud/client';
import { SaveSyncService, type RetryClock } from '../src/cloud/saveSync';
import { SyncStore } from '../src/cloud/syncStore';
import type { CloudSaveMeta, CloudSaveRecord } from '../src/cloud/types';
import { ProfileStore, type KeyValueStorage } from '../src/ui/profileStore';
import { serializeGame, writeSaveDocument } from '../src/save/persistence';
import { createLegacyGameState } from './fixtures/legacyGameState';
import { telemetry } from '../src/telemetry/service';

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  clear(): void { this.values.clear(); }
}

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let storage: MemoryStorage;

beforeEach(() => {
  telemetry.setEnabled(false);
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
});

afterEach(() => {
  telemetry.setEnabled(true);
  vi.restoreAllMocks();
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

function auth(): AuthService {
  return {
    state: { kind: 'signed-in', session: { userId: 'user-1', email: 'pilot@example.com', accessToken: 'a', refreshToken: 'r' } },
    subscribe: () => () => {},
  } as unknown as AuthService;
}

function cloudMeta(revision: number, payloadHash = 'a'.repeat(64)): CloudSaveMeta {
  return {
    slot: 'mission', label: 'Mission', saveVersion: 9, payloadHash, fingerprintVersion: 2,
    revision, createdAt: '2026-07-21T00:00:00Z', updatedAt: '2026-07-21T00:00:00Z',
  };
}

describe('cloud save synchronization', () => {
  it('returns false and records the newest revision when keep-local races again', async () => {
    const save = serializeGame(createLegacyGameState(), 'Mission');
    expect(await writeSaveDocument('mission', save)).toBe(true);
    const profile = new ProfileStore(storage);
    const store = new SyncStore(profile);
    store.set('user-1', 'mission', {
      revision: 1, payloadHash: 'local', state: 'conflict', attempts: 0, nextRetryAt: 0, cloud: cloudMeta(1),
    });
    const read = vi.fn()
      .mockResolvedValueOnce({ ...cloudMeta(2), payload: save } satisfies CloudSaveRecord)
      .mockResolvedValueOnce({ ...cloudMeta(3), payload: save } satisfies CloudSaveRecord);
    const cloud = {
      read,
      put: vi.fn().mockRejectedValue(new CloudClientError('SAVE_CONFLICT', 409, 'race')),
    } as unknown as CloudSaveClient;
    const service = new SaveSyncService(auth(), cloud, store);

    expect(await service.resolveConflict('mission', 'keep-local')).toBe(false);
    expect(cloud.put).toHaveBeenCalledWith('mission', save, 2);
    expect(store.all('user-1').mission).toMatchObject({ state: 'conflict', revision: 3 });
  });

  it('resumes a persisted pending upload from one deterministic timer', async () => {
    const save = serializeGame(createLegacyGameState(), 'Mission');
    expect(await writeSaveDocument('mission', save)).toBe(true);
    const store = new SyncStore(new ProfileStore(storage));
    store.set('user-1', 'mission', {
      revision: 2, payloadHash: 'local', state: 'pending', attempts: 2, nextRetryAt: 1_500, cloud: cloudMeta(2),
    });
    let now = 1_000;
    let callback: (() => void) | null = null;
    const clock: RetryClock = {
      now: () => now,
      setTimeout: vi.fn((next, delay) => { callback = next; expect(delay).toBe(500); return 1; }),
      clearTimeout: vi.fn(),
    };
    const uploaded = { ...cloudMeta(3), payload: save } satisfies CloudSaveRecord;
    const cloud = { put: vi.fn().mockResolvedValue(uploaded) } as unknown as CloudSaveClient;
    const service = new SaveSyncService(auth(), cloud, store, clock);
    (service as unknown as { schedulePending(): void }).schedulePending();

    now = 1_500;
    callback!();
    await vi.waitFor(() => expect(store.all('user-1').mission.state).toBe('synced'));
    expect(cloud.put).toHaveBeenCalledWith('mission', save, 2);
  });

  it('marks authentication and validation failures as action-required instead of retrying', async () => {
    const save = serializeGame(createLegacyGameState(), 'Mission');
    expect(await writeSaveDocument('mission', save)).toBe(true);
    const store = new SyncStore(new ProfileStore(storage));
    store.set('user-1', 'mission', {
      revision: 1, payloadHash: 'local', state: 'pending', attempts: 0, nextRetryAt: 0, cloud: cloudMeta(1),
    });
    const cloud = {
      put: vi.fn().mockRejectedValue(new CloudClientError('INVALID_SAVE', 400, 'invalid')),
    } as unknown as CloudSaveClient;
    const service = new SaveSyncService(auth(), cloud, store);

    await service.retryPending();
    expect(store.all('user-1').mission).toMatchObject({ state: 'failed', attempts: 1, nextRetryAt: 0 });
  });
});
