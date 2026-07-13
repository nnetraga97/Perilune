import { describe, expect, it } from 'vitest';
import {
  TERRAIN_QUALITY_POLICY,
  distanceToTerrainBoundingSphereMeters,
  nextTerrainSplitState,
  screenSpaceErrorPixels,
} from '../src/render/terrain/terrainPolicy';

describe('terrain quality policy', () => {
  it('defines the approved tier thresholds and bounded work policy', () => {
    expect(TERRAIN_QUALITY_POLICY.low).toMatchObject({
      gridResolution: 9, maximumSsePixels: 4, mergeSsePixels: 2.8,
    });
    expect(TERRAIN_QUALITY_POLICY.medium).toMatchObject({
      gridResolution: 17, maximumSsePixels: 2.5, mergeSsePixels: 1.75,
    });
    expect(TERRAIN_QUALITY_POLICY.high).toMatchObject({
      gridResolution: 33, maximumSsePixels: 1.5, mergeSsePixels: 1.05,
    });
    for (const policy of Object.values(TERRAIN_QUALITY_POLICY)) {
      expect(policy.mergeSsePixels).toBeLessThan(policy.maximumSsePixels);
      expect(policy.softResidencyRatio).toBe(0.75);
      expect(policy.hardReservationRatio).toBe(1);
      expect(policy.normalTransitionSeconds).toBe(0.35);
      expect(policy.pressureTransitionSeconds).toBe(0.2);
      expect(Object.isFrozen(policy)).toBe(true);
    }
  });
});

describe('terrain screen-space error', () => {
  const base = {
    geometricErrorMeters: 10,
    distanceToBoundingVolumeMeters: 1_000,
    drawingBufferHeight: 1_080,
    verticalFovRadians: Math.PI / 3,
  };

  it('matches the approved projection formula', () => {
    expect(screenSpaceErrorPixels(base)).toBeCloseTo(
      10 * 1_080 / (2 * 1_000 * Math.tan(Math.PI / 6)),
      12,
    );
  });

  it('responds proportionally to error, physical resolution, and distance', () => {
    const value = screenSpaceErrorPixels(base);
    expect(screenSpaceErrorPixels({ ...base, geometricErrorMeters: 20 })).toBeCloseTo(value * 2, 12);
    expect(screenSpaceErrorPixels({ ...base, drawingBufferHeight: 2_160 })).toBeCloseTo(value * 2, 12);
    expect(screenSpaceErrorPixels({ ...base, distanceToBoundingVolumeMeters: 2_000 })).toBeCloseTo(value / 2, 12);
  });

  it('requests more detail for a narrower FOV and clamps an inside-bound camera', () => {
    const wide = screenSpaceErrorPixels({ ...base, verticalFovRadians: Math.PI / 2 });
    const narrow = screenSpaceErrorPixels({ ...base, verticalFovRadians: Math.PI / 4 });
    expect(narrow).toBeGreaterThan(wide);
    expect(screenSpaceErrorPixels({ ...base, distanceToBoundingVolumeMeters: 0 })).toBeGreaterThan(0);
    expect(screenSpaceErrorPixels({ ...base, geometricErrorMeters: 0 })).toBe(0);
  });

  it('rejects invalid projection inputs rather than producing NaN selection', () => {
    expect(() => screenSpaceErrorPixels({ ...base, geometricErrorMeters: -1 })).toThrow(/error/i);
    expect(() => screenSpaceErrorPixels({ ...base, drawingBufferHeight: 0 })).toThrow(/height/i);
    expect(() => screenSpaceErrorPixels({ ...base, verticalFovRadians: 0 })).toThrow(/fov/i);
    expect(() => screenSpaceErrorPixels({ ...base, verticalFovRadians: Math.PI })).toThrow(/fov/i);
    expect(() => screenSpaceErrorPixels({ ...base, distanceToBoundingVolumeMeters: Number.NaN })).toThrow(/distance/i);
  });

  it('measures distance to a displacement-aware bounding sphere', () => {
    expect(distanceToTerrainBoundingSphereMeters(
      { x: 100, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      20,
    )).toBe(70);
    expect(distanceToTerrainBoundingSphereMeters(
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      20,
    )).toBe(0);
  });
});

describe('terrain split/merge hysteresis', () => {
  const policy = TERRAIN_QUALITY_POLICY.medium;

  it('splits only above the maximum and merges only below the lower threshold', () => {
    expect(nextTerrainSplitState(false, policy.maximumSsePixels, policy)).toBe(false);
    expect(nextTerrainSplitState(false, policy.maximumSsePixels + 0.001, policy)).toBe(true);
    expect(nextTerrainSplitState(true, policy.mergeSsePixels, policy)).toBe(true);
    expect(nextTerrainSplitState(true, policy.mergeSsePixels - 0.001, policy)).toBe(false);
  });

  it('retains prior state throughout the hysteresis band', () => {
    for (const sse of [1.75, 1.9, 2.1, 2.3, 2.5]) {
      expect(nextTerrainSplitState(false, sse, policy)).toBe(false);
      expect(nextTerrainSplitState(true, sse, policy)).toBe(true);
    }
  });
});
