import type { GameState } from '../sim/state';
import {
  deleteSave,
  listSaves,
  readSave,
  writeSave,
  writeSaveDocument,
  type SaveSlotMeta,
} from '../save/persistence';
import type { SaveGame } from '../save/schema';
import type { AuthService, AuthState } from './auth';
import { CloudClientError, type CloudSaveClient } from './client';
import { reconcileCatalog } from './reconcile';
import { SyncStore, type SlotSyncRecord } from './syncStore';
import type { CloudSaveMeta, ConflictChoice, UnifiedSaveSlot } from './types';
import { telemetry } from '../telemetry/service';

type Listener = () => void;

function blankRecord(state: SlotSyncRecord['state']): SlotSyncRecord {
  return { revision: null, payloadHash: null, state, attempts: 0, nextRetryAt: 0, cloud: null };
}

export async function hashSave(save: SaveGame): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(save));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class SaveSyncService {
  private cloudCatalog = new Map<string, CloudSaveMeta>();
  private readonly listeners = new Set<Listener>();
  private authUnsubscribe: (() => void) | null = null;
  private refreshing: Promise<void> | null = null;
  private lastUserId: string | null = null;
  private readonly onlineHandler = () => void this.retryPending();

  constructor(
    private readonly auth: AuthService,
    private readonly cloud: CloudSaveClient,
    private readonly store: SyncStore,
  ) {}

  initialize(): void {
    if (this.authUnsubscribe) return;
    this.authUnsubscribe = this.auth.subscribe((state) => this.onAuthState(state));
    if (typeof window !== 'undefined') window.addEventListener('online', this.onlineHandler);
  }

  dispose(): void {
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onlineHandler);
    this.listeners.clear();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<void> {
    const userId = this.userId();
    if (!userId) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.reconcile(userId).finally(() => {
      this.refreshing = null;
      this.emit();
    });
    return this.refreshing;
  }

  async write(game: GameState, slot: string, label: string): Promise<boolean> {
    const localOk = await writeSave(game, slot, label);
    if (!localOk) return false;
    telemetry.track('local_save', { kind: slot === 'auto' ? 'auto' : slot === 'quick' ? 'quick' : 'named' });
    const userId = this.userId();
    if (!userId) {
      this.emit();
      return true;
    }
    const save = await readSave(slot);
    if (save) await this.upload(userId, slot, save);
    this.emit();
    return true;
  }

  async read(slot: string): Promise<SaveGame | null> {
    const local = await readSave(slot);
    if (local) {
      telemetry.track('load', { source: 'local' });
      return local;
    }
    const userId = this.userId();
    if (!userId || !this.cloudCatalog.has(slot)) return null;
    try {
      const record = await this.cloud.read(slot);
      if (!await writeSaveDocument(slot, record.payload)) return null;
      this.cloudCatalog.set(slot, record);
      this.store.set(userId, slot, {
        revision: record.revision,
        payloadHash: record.payloadHash,
        state: 'synced', attempts: 0, nextRetryAt: 0, cloud: record,
      });
      this.emit();
      telemetry.track('load', { source: 'cloud' });
      return record.payload;
    } catch {
      return null;
    }
  }

  async list(): Promise<UnifiedSaveSlot[]> {
    const local = await listSaves();
    const userId = this.userId();
    const records = userId ? this.store.all(userId) : {};
    const localMap = new Map(local.map((item) => [item.slot, item]));
    const slots = new Set([...localMap.keys(), ...this.cloudCatalog.keys()]);
    return [...slots].map((slot): UnifiedSaveSlot => {
      const localMeta = localMap.get(slot);
      const cloud = this.cloudCatalog.get(slot) ?? records[slot]?.cloud ?? null;
      const defaultState = localMeta && cloud ? 'synced' : localMeta ? 'local' : 'cloud';
      return {
        slot,
        label: localMeta?.label ?? cloud?.label ?? slot,
        createdAt: localMeta?.createdAt ?? (cloud ? Date.parse(cloud.updatedAt) : Date.now()),
        time: localMeta?.time ?? null,
        vesselCount: localMeta?.vesselCount ?? null,
        activeVesselName: localMeta?.activeVesselName ?? null,
        local: Boolean(localMeta),
        cloud,
        state: records[slot]?.state ?? defaultState,
      };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }

  async delete(slot: string): Promise<boolean> {
    const userId = this.userId();
    const record = userId ? this.store.all(userId)[slot] : undefined;
    const cloud = this.cloudCatalog.get(slot) ?? record?.cloud;
    if (userId && cloud) {
      try {
        await this.cloud.delete(slot, cloud.revision);
      } catch {
        return false;
      }
      this.cloudCatalog.delete(slot);
      this.store.delete(userId, slot);
    }
    await deleteSave(slot);
    this.emit();
    return true;
  }

  async resolveConflict(slot: string, choice: ConflictChoice): Promise<boolean> {
    const userId = this.userId();
    if (!userId) return false;
    const record = this.store.all(userId)[slot];
    const cloud = record?.cloud ?? this.cloudCatalog.get(slot);
    if (!cloud) return false;
    try {
      if (choice === 'keep-local') {
        const save = await readSave(slot);
        if (!save) return false;
        await this.upload(userId, slot, save, cloud.revision);
      } else if (choice === 'keep-cloud') {
        const remote = await this.cloud.read(slot);
        if (!await writeSaveDocument(slot, remote.payload)) return false;
        this.cloudCatalog.set(slot, remote);
        this.store.set(userId, slot, {
          revision: remote.revision, payloadHash: remote.payloadHash, state: 'synced',
          attempts: 0, nextRetryAt: 0, cloud: remote,
        });
      } else {
        const save = await readSave(slot);
        if (!save) return false;
        const occupied = new Set((await this.list()).map((item) => item.slot));
        let renamed = `${slot}-local`.slice(0, 48).replace(/-$/, '');
        let suffix = 2;
        while (occupied.has(renamed)) {
          const tail = `-${suffix++}`;
          renamed = `${slot.slice(0, 48 - tail.length)}${tail}`.replace(/-+$/, tail);
        }
        if (!await writeSaveDocument(renamed, save)) return false;
        const uploaded = await this.cloud.put(renamed, save, null);
        await deleteSave(slot);
        this.cloudCatalog.set(renamed, uploaded);
        this.store.set(userId, renamed, {
          revision: uploaded.revision, payloadHash: uploaded.payloadHash, state: 'synced',
          attempts: 0, nextRetryAt: 0, cloud: uploaded,
        });
        this.store.set(userId, slot, {
          revision: cloud.revision, payloadHash: cloud.payloadHash, state: 'cloud',
          attempts: 0, nextRetryAt: 0, cloud,
        });
      }
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  async retryPending(): Promise<void> {
    const userId = this.userId();
    if (!userId) return;
    const records = this.store.all(userId);
    for (const [slot, record] of Object.entries(records)) {
      if (record.state !== 'pending' || record.nextRetryAt > Date.now()) continue;
      const save = await readSave(slot);
      if (save) await this.upload(userId, slot, save, record.revision);
    }
    this.emit();
  }

  private async reconcile(userId: string): Promise<void> {
    let cloud: CloudSaveMeta[];
    try {
      cloud = await this.cloud.list();
    } catch {
      return;
    }
    this.cloudCatalog = new Map(cloud.map((item) => [item.slot, item]));
    const local = await listSaves();
    const localHashes: Record<string, string> = {};
    for (const meta of local) {
      const save = await readSave(meta.slot);
      if (save) localHashes[meta.slot] = await hashSave(save);
    }
    const prior = this.store.all(userId);
    for (const action of reconcileCatalog(local, cloud, localHashes)) {
      if (action.kind === 'upload') {
        const save = await readSave(action.slot);
        if (save) await this.upload(userId, action.slot, save);
      } else if (action.kind === 'cloud-only') {
        this.store.set(userId, action.slot, {
          revision: action.cloud.revision, payloadHash: action.cloud.payloadHash, state: 'cloud',
          attempts: 0, nextRetryAt: 0, cloud: action.cloud,
        });
      } else if (action.kind === 'synced') {
        this.store.set(userId, action.slot, {
          revision: action.cloud.revision, payloadHash: action.cloud.payloadHash, state: 'synced',
          attempts: 0, nextRetryAt: 0, cloud: action.cloud,
        });
      } else {
        const previous = prior[action.slot];
        if (previous?.state === 'pending' && previous.revision === action.cloud.revision) {
          const save = await readSave(action.slot);
          if (save) await this.upload(userId, action.slot, save, action.cloud.revision);
        } else {
          this.store.set(userId, action.slot, {
            revision: action.cloud.revision, payloadHash: localHashes[action.slot] ?? null,
            state: 'conflict', attempts: 0, nextRetryAt: 0, cloud: action.cloud,
          });
        }
      }
    }
  }

  private async upload(userId: string, slot: string, save: SaveGame, revision?: number | null): Promise<void> {
    const prior = this.store.all(userId)[slot] ?? blankRecord('local');
    const expected = revision === undefined ? prior.revision : revision;
    try {
      const uploaded = await this.cloud.put(slot, save, expected);
      this.cloudCatalog.set(slot, uploaded);
      this.store.set(userId, slot, {
        revision: uploaded.revision, payloadHash: uploaded.payloadHash, state: 'synced',
        attempts: 0, nextRetryAt: 0, cloud: uploaded,
      });
      telemetry.track('cloud_sync', { result: 'synced' });
      if (prior.state === 'pending') telemetry.track('pending_sync_recovered');
    } catch (error) {
      if (error instanceof CloudClientError && error.code === 'SAVE_CONFLICT') {
        const cloud = this.cloudCatalog.get(slot) ?? await this.cloud.read(slot).catch(() => null);
        this.store.set(userId, slot, {
          revision: cloud?.revision ?? prior.revision,
          payloadHash: await hashSave(save),
          state: 'conflict', attempts: 0, nextRetryAt: 0, cloud,
        });
        telemetry.track('save_conflict');
        telemetry.track('cloud_sync', { result: 'conflict' });
        return;
      }
      const attempts = Math.min(prior.attempts + 1, 5);
      const delays = [1, 2, 4, 8, 30];
      this.store.set(userId, slot, {
        ...prior,
        payloadHash: await hashSave(save),
        state: 'pending',
        attempts,
        nextRetryAt: Date.now() + delays[attempts - 1] * 1000,
      });
      telemetry.track('cloud_sync', { result: 'pending' });
      telemetry.captureError(error);
    }
  }

  private userId(): string | null {
    return this.auth.state.kind === 'signed-in' ? this.auth.state.session.userId : null;
  }

  private onAuthState(state: AuthState): void {
    const userId = state.kind === 'signed-in' ? state.session.userId : null;
    if (userId === this.lastUserId) return;
    this.lastUserId = userId;
    this.cloudCatalog.clear();
    if (userId) void this.refresh();
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
