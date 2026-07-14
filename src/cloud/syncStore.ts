import type { ProfileStore } from '../ui/profileStore';
import type { CloudSaveMeta, CloudSyncState } from './types';

export interface SlotSyncRecord {
  revision: number | null;
  payloadHash: string | null;
  state: CloudSyncState;
  attempts: number;
  nextRetryAt: number;
  cloud: CloudSaveMeta | null;
}

interface PersistedSyncState {
  version: 1;
  users: Record<string, Record<string, SlotSyncRecord>>;
}

const EMPTY: PersistedSyncState = { version: 1, users: {} };

export class SyncStore {
  constructor(private readonly profile: ProfileStore) {}

  all(userId: string): Record<string, SlotSyncRecord> {
    const state = this.read();
    return structuredClone(state.users[userId] ?? {});
  }

  set(userId: string, slot: string, record: SlotSyncRecord): void {
    const state = this.read();
    state.users[userId] ??= {};
    state.users[userId][slot] = structuredClone(record);
    this.profile.set('cloud.sync.v1', state);
  }

  delete(userId: string, slot: string): void {
    const state = this.read();
    delete state.users[userId]?.[slot];
    this.profile.set('cloud.sync.v1', state);
  }

  private read(): PersistedSyncState {
    const value = this.profile.get<PersistedSyncState>('cloud.sync.v1', EMPTY);
    if (value.version !== 1 || typeof value.users !== 'object' || value.users === null) return structuredClone(EMPTY);
    return structuredClone(value);
  }
}
