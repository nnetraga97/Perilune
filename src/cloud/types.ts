import type { SaveGame } from '../save/schema';

export interface CloudSaveMeta {
  slot: string;
  label: string;
  saveVersion: number;
  payloadHash: string;
  fingerprintVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CloudSaveRecord extends CloudSaveMeta {
  payload: SaveGame;
}

export type CloudSyncState = 'local' | 'cloud' | 'synced' | 'pending' | 'conflict' | 'failed';

export interface UnifiedSaveSlot {
  slot: string;
  label: string;
  createdAt: number;
  time: number | null;
  vesselCount: number | null;
  activeVesselName: string | null;
  local: boolean;
  cloud: CloudSaveMeta | null;
  state: CloudSyncState;
}

export type ConflictChoice = 'keep-local' | 'keep-cloud' | 'keep-both';
