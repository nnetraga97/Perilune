import { describe, expect, it } from 'vitest';
import { reconcileCatalog } from '../src/cloud/reconcile';
import type { SaveSlotMeta } from '../src/save/persistence';
import type { CloudSaveMeta } from '../src/cloud/types';

const local: SaveSlotMeta = {
  slot: 'mission', label: 'Mission', createdAt: 1, time: 0, vesselCount: 0, activeVesselName: null,
};
const cloud: CloudSaveMeta = {
  slot: 'mission', label: 'Mission', saveVersion: 7, payloadHash: 'same', revision: 1,
  fingerprintVersion: 2,
  createdAt: '2026-07-13T00:00:00Z', updatedAt: '2026-07-13T00:00:00Z',
};

describe('cloud reconciliation', () => {
  it('distinguishes local-only, cloud-only, synced, and conflict slots', () => {
    expect(reconcileCatalog([local], [], {})).toMatchObject([{ kind: 'upload', slot: 'mission' }]);
    expect(reconcileCatalog([], [cloud], {})).toMatchObject([{ kind: 'cloud-only', slot: 'mission' }]);
    expect(reconcileCatalog([local], [cloud], { mission: 'same' })).toMatchObject([{ kind: 'synced' }]);
    expect(reconcileCatalog([local], [cloud], { mission: 'different' })).toMatchObject([{ kind: 'conflict' }]);
  });

  it('does not treat legacy raw-json hashes as canonical matches', () => {
    expect(reconcileCatalog([local], [{ ...cloud, fingerprintVersion: 1 }], { mission: 'same' }))
      .toMatchObject([{ kind: 'conflict' }]);
  });
});
