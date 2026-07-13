import { describe, expect, it } from 'vitest';
import { TerrainResidencyManager } from '../src/render/terrain/terrainResidency';

describe('terrain byte residency', () => {
  it('combines installed and reserved bytes at the hard limit', () => {
    const residency = new TerrainResidencyManager(100);
    residency.beginFrame(1);
    residency.installCoverageWithoutReservation('root', 40);
    residency.protectPermanently('root');
    expect(residency.tryReserve('1:a', 60, 'visible-refinement')).toBe(true);
    expect(residency.tryReserve('1:b', 1, 'visible-refinement')).toBe(false);
    expect(residency.stats()).toMatchObject({
      allocationBytes: 100,
      softTargetBytes: 75,
      installedBytes: 40,
      reservedBytes: 60,
      protectedBytes: 40,
    });
  });

  it('transfers a reservation to actual installed bytes exactly once', () => {
    const residency = new TerrainResidencyManager(100);
    residency.beginFrame(2);
    expect(residency.tryReserve('1:tile', 50, 'visible-refinement')).toBe(true);
    expect(residency.commitInstallation('1:tile', 'tile', 40)).toEqual({
      installed: true, discarded: false, overflow: false, reason: 'installed',
    });
    expect(residency.stats()).toMatchObject({ installedBytes: 40, reservedBytes: 0, residentCount: 1 });
    expect(residency.commitInstallation('1:tile', 'tile', 40)).toMatchObject({
      installed: false, discarded: true, reason: 'missing-reservation',
    });
  });

  it('installs an underestimated coverage blocker, records overflow, and pauses new work', () => {
    const residency = new TerrainResidencyManager(100);
    residency.beginFrame(3);
    residency.installCoverageWithoutReservation('fallback', 60);
    expect(residency.tryReserve('1:blocker', 40, 'coverage-blocker')).toBe(true);
    expect(residency.commitInstallation('1:blocker', 'blocker', 60)).toEqual({
      installed: true, discarded: false, overflow: true, reason: 'coverage-overflow',
    });
    expect(residency.stats()).toMatchObject({ installedBytes: 120, overflow: true });
    expect(residency.tryReserve('1:new', 0, 'visible-refinement')).toBe(false);
    expect(residency.trimToSoftTarget()).toEqual(['blocker']);
    expect(residency.stats()).toMatchObject({ installedBytes: 60, overflow: false });
  });

  it('discards an underestimated prediction or refinement result instead of overflowing', () => {
    for (const requestClass of ['predicted-refinement', 'background', 'visible-refinement'] as const) {
      const residency = new TerrainResidencyManager(100);
      residency.beginFrame(1);
      residency.installCoverageWithoutReservation('root', 60);
      residency.protectPermanently('root');
      expect(residency.tryReserve('1:detail', 40, requestClass)).toBe(true);
      expect(residency.commitInstallation('1:detail', 'detail', 60)).toEqual({
        installed: false, discarded: true, overflow: false, reason: 'refinement-overflow',
      });
      expect(residency.residentKeys()).toEqual(['root']);
      expect(residency.stats()).toMatchObject({ installedBytes: 60, reservedBytes: 0 });
    }
  });

  it('trims unprotected LRU resources but may remain above soft target for protected coverage', () => {
    const residency = new TerrainResidencyManager(1_000);
    residency.beginFrame(1);
    residency.installCoverageWithoutReservation('root', 400);
    residency.protectPermanently('root');
    residency.installCoverageWithoutReservation('old', 250);
    residency.beginFrame(2, new Set(['current']));
    residency.installCoverageWithoutReservation('current', 250);
    residency.installCoverageWithoutReservation('new', 100);
    expect(residency.stats().installedBytes).toBe(1_000);
    expect(residency.trimToSoftTarget()).toEqual(['old']);
    expect(residency.residentKeys()).toEqual(['current', 'new', 'root']);
    expect(residency.stats()).toMatchObject({ installedBytes: 750, protectedBytes: 650 });

    const protectedOnly = new TerrainResidencyManager(100);
    protectedOnly.beginFrame(1);
    protectedOnly.installCoverageWithoutReservation('roots', 90);
    protectedOnly.protectPermanently('roots');
    expect(protectedOnly.trimToSoftTarget()).toEqual([]);
    expect(protectedOnly.stats().installedBytes).toBe(90);
  });

  it('never removes frame or permanent protection without an explicit forced teardown', () => {
    const residency = new TerrainResidencyManager(100);
    residency.beginFrame(1, new Set(['current']));
    residency.installCoverageWithoutReservation('current', 20);
    residency.installCoverageWithoutReservation('root', 20);
    residency.protectPermanently('root');
    expect(residency.removeInstalled('current')).toBe(false);
    expect(residency.removeInstalled('root')).toBe(false);
    expect(residency.removeInstalled('current', true)).toBe(true);
    residency.clear();
    expect(residency.stats()).toMatchObject({ installedBytes: 0, reservedBytes: 0, residentCount: 0 });
  });

  it('supports a zero allocation while retaining explicitly required root coverage', () => {
    const residency = new TerrainResidencyManager(0);
    residency.beginFrame(1);
    expect(residency.tryReserve('1:detail', 0, 'visible-refinement')).toBe(true);
    expect(residency.releaseReservation('1:detail')).toBe(true);
    expect(residency.installCoverageWithoutReservation('root', 10)).toMatchObject({ overflow: true });
    residency.protectPermanently('root');
    expect(residency.trimToSoftTarget()).toEqual([]);
    expect(residency.stats()).toMatchObject({ installedBytes: 10, protectedBytes: 10, overflow: true });
  });
});
