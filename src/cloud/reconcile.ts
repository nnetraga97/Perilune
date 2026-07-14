import type { SaveSlotMeta } from '../save/persistence';
import type { CloudSaveMeta } from './types';

export type ReconcileAction =
  | { kind: 'upload'; slot: string; local: SaveSlotMeta }
  | { kind: 'cloud-only'; slot: string; cloud: CloudSaveMeta }
  | { kind: 'synced'; slot: string; cloud: CloudSaveMeta }
  | { kind: 'conflict'; slot: string; local: SaveSlotMeta; cloud: CloudSaveMeta };

export function reconcileCatalog(
  local: readonly SaveSlotMeta[],
  cloud: readonly CloudSaveMeta[],
  localHashes: Readonly<Record<string, string>>,
): ReconcileAction[] {
  const localBySlot = new Map(local.map((item) => [item.slot, item]));
  const cloudBySlot = new Map(cloud.map((item) => [item.slot, item]));
  const slots = new Set([...localBySlot.keys(), ...cloudBySlot.keys()]);
  const actions: ReconcileAction[] = [];
  for (const slot of slots) {
    const localItem = localBySlot.get(slot);
    const cloudItem = cloudBySlot.get(slot);
    if (localItem && !cloudItem) actions.push({ kind: 'upload', slot, local: localItem });
    else if (!localItem && cloudItem) actions.push({ kind: 'cloud-only', slot, cloud: cloudItem });
    else if (localItem && cloudItem) {
      actions.push(localHashes[slot] === cloudItem.payloadHash
        ? { kind: 'synced', slot, cloud: cloudItem }
        : { kind: 'conflict', slot, local: localItem, cloud: cloudItem });
    }
  }
  return actions;
}
