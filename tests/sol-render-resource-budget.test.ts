import { describe, expect, it } from 'vitest';
import artifact from '../src/generated/checked-planet-manifest.json';

type Tier = keyof typeof artifact.manifest.budgets.activeBodyGpuBytes;

describe('Sol renderer resource ceilings', () => {
  it('keeps authored packs and transient preparation within checked tier budgets', () => {
    const { budgets, packs } = artifact.manifest;
    for (const pack of packs.filter((entry) => (
      entry.bodyId === 'mercury' || entry.bodyId === 'venus' || entry.bodyId === 'earth' || entry.bodyId === 'moon' ||
      entry.bodyId === 'mars' || entry.bodyId === 'jupiter' || entry.bodyId === 'callisto'
    ))) {
      const tier = pack.tier as Tier;
      const gpuBytes = pack.channels.reduce((sum, channel) => sum + channel.fallbackGpuBytes, 0);
      expect(gpuBytes, `${pack.bodyId}/${pack.tier} GPU`).toBeLessThanOrEqual(budgets.activeBodyGpuBytes[tier]);
      expect(pack.transientBytes, `${pack.bodyId}/${pack.tier} transient`).toBeLessThanOrEqual(
        budgets.transientPeakBytes[tier],
      );
    }
  });
});
