import { describe, expect, it } from 'vitest';
import { AUREN_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import { createBodySurfaceProvider } from '../src/render/terrain/surfaceProvider';
import { createTerrainTileId, edgeNeighbor, terrainTileParent } from '../src/render/terrain/tile';
import {
  TERRAIN_QUALITY_POLICY,
  distanceToTerrainBoundingSphereMeters,
  nextTerrainSplitState,
  screenSpaceErrorPixels,
} from '../src/render/terrain/terrainPolicy';
import {
  balanceTerrainLeaves,
  selectPredictedTerrainDetail,
  selectTerrainDetail,
  terrainNeighborDepthViolations,
} from '../src/render/terrain/terrainSelection';

function flatProvider(maximumDepth = 5) {
  const definition = structuredClone(AUREN_SYSTEM.find((candidate) => candidate.id === 'palla')!);
  definition.id = 'synthetic-flat';
  definition.radius = 1_000;
  definition.terrain.amplitude = 0;
  return createBodySurfaceProvider(new Body(definition, null), {
    generation: 1,
    gridResolution: 9,
    maximumDepth,
  });
}

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

describe('desired terrain traversal', () => {
  const frame = {
    cameraBodyFixed: { x: 2_000, y: 0, z: 0 },
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 3,
    drawingBufferHeight: 1_080,
  };

  it('is deterministic, honors visibility, and never exceeds provider depth', () => {
    const provider = flatProvider(4);
    const first = selectTerrainDetail(
      provider,
      TERRAIN_QUALITY_POLICY.medium,
      frame,
      new Set(),
      (tile) => tile.id.face !== 1,
    );
    const second = selectTerrainDetail(
      provider,
      TERRAIN_QUALITY_POLICY.medium,
      frame,
      new Set(),
      (tile) => tile.id.face !== 1,
    );
    expect(first.leaves.map((tile) => tile.key)).toEqual(second.leaves.map((tile) => tile.key));
    expect(first.leaves.every((tile) => tile.id.face !== 1)).toBe(true);
    expect(Math.max(...first.leaves.map((tile) => tile.id.depth))).toBeLessThanOrEqual(4);
    expect(first.leaves.length).toBeGreaterThan(0);
  });

  it('uses previous split state inside the hysteresis band', () => {
    const provider = flatProvider(2);
    const root = provider.rootTile(0);
    const distance = root.geometricErrorMeters * 1_080
      / (2 * 2.1 * Math.tan(Math.PI / 6));
    const bandFrame = { ...frame, cameraBodyFixed: { x: provider.radiusMeters + distance, y: 0, z: 0 } };
    const merged = selectTerrainDetail(provider, TERRAIN_QUALITY_POLICY.medium, bandFrame);
    const retained = selectTerrainDetail(
      provider,
      TERRAIN_QUALITY_POLICY.medium,
      bandFrame,
      new Set([root.key]),
    );
    expect(merged.splitKeys.has(root.key)).toBe(false);
    expect(retained.splitKeys.has(root.key)).toBe(true);
  });

  it('projects prediction by wall-clock velocity without mutating current selection', () => {
    const provider = flatProvider(4);
    const moving = {
      ...frame,
      cameraBodyFixed: { x: 8_000, y: 0, z: 0 },
      cameraBodyFixedVelocity: { x: -12_000, y: 0, z: 0 },
    };
    const current = selectTerrainDetail(provider, TERRAIN_QUALITY_POLICY.high, moving);
    const before = current.leaves.map((tile) => tile.key);
    const predicted = selectPredictedTerrainDetail(provider, TERRAIN_QUALITY_POLICY.high, moving);
    expect(predicted.leaves.length).toBeGreaterThan(current.leaves.length);
    expect(current.leaves.map((tile) => tile.key)).toEqual(before);
  });
});

describe('restricted planetary quadtree balancing', () => {
  const edges = ['west', 'east', 'south', 'north'] as const;

  it('repairs depth differences across every cube-face seam', () => {
    const provider = flatProvider(6);
    for (let face = 0; face < 6; face++) {
      for (const edge of edges) {
        const last = 2 ** 4 - 1;
        const fineId = edge === 'west' || edge === 'east'
          ? createTerrainTileId(face, 4, edge === 'west' ? 0 : last, 7)
          : createTerrainTileId(face, 4, 7, edge === 'south' ? 0 : last);
        let coarseId = edgeNeighbor(fineId, edge);
        while (coarseId.depth > 1) coarseId = terrainTileParent(coarseId)!;
        const balanced = balanceTerrainLeaves(provider, [provider.tile(fineId), provider.tile(coarseId)]);
        expect(terrainNeighborDepthViolations(balanced), `${face}:${edge}`).toEqual([]);
        expect(balanced.some((tile) => tile.id.face !== face && tile.id.depth === 3)).toBe(true);
      }
    }
  });

  it('repairs same-face neighbors and is stable when already balanced', () => {
    const provider = flatProvider(6);
    const fine = provider.tile(createTerrainTileId(0, 5, 16, 8));
    let coarseId = edgeNeighbor(fine.id, 'west');
    while (coarseId.depth > 2) coarseId = terrainTileParent(coarseId)!;
    const balanced = balanceTerrainLeaves(provider, [fine, provider.tile(coarseId)]);
    expect(terrainNeighborDepthViolations(balanced)).toEqual([]);
    expect(balanceTerrainLeaves(provider, balanced).map((tile) => tile.key))
      .toEqual(balanced.map((tile) => tile.key));
  });
});
