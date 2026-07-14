import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { AUREN_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import {
  evaluateRecipeHeight,
  recipeForBody,
  terrainRecipeBounds,
} from '../src/sim/terrainRecipe';
import {
  createBodySurfaceProvider,
  validateGeometricErrorTable,
} from '../src/render/terrain/surfaceProvider';
import { createTerrainTileId, terrainTileKey } from '../src/render/terrain/tile';

function body(id: string, overrides: Partial<Body['def']['terrain']> = {}, radius?: number): Body {
  const source = structuredClone(AUREN_SYSTEM.find((candidate) => candidate.id === id)!);
  source.terrain = { ...source.terrain, ...overrides };
  if (radius !== undefined) source.radius = radius;
  return new Body(source, null);
}

describe('terrain recipe bounds', () => {
  it('contains deterministic evaluator heights across every authored solid recipe', () => {
    for (const definition of AUREN_SYSTEM.filter((candidate) => candidate.surfaceKind === 'solid')) {
      const candidate = new Body(structuredClone(definition), null);
      const recipe = recipeForBody(candidate);
      const bounds = terrainRecipeBounds(recipe);
      expect(bounds.minimumHeightMeters).toBeLessThanOrEqual(bounds.maximumHeightMeters);
      expect(bounds.maximumAngularSlopeMeters).toBeGreaterThanOrEqual(0);
      expect(Object.values(bounds).every(Number.isFinite)).toBe(true);
      for (let index = 0; index < 2_000; index++) {
        const z = -1 + 2 * ((index * 0.6180339887498948) % 1);
        const longitude = 2 * Math.PI * ((index * 0.414213562373095) % 1);
        const radial = Math.sqrt(Math.max(0, 1 - z * z));
        const direction = new Vec3(
          radial * Math.cos(longitude),
          radial * Math.sin(longitude),
          z,
        );
        const height = evaluateRecipeHeight(recipe, direction);
        expect(height).toBeGreaterThanOrEqual(bounds.minimumHeightMeters);
        expect(height).toBeLessThanOrEqual(bounds.maximumHeightMeters);
      }
    }
  });

  it('returns an exact zero bound when the evaluator short-circuits flat terrain', () => {
    const recipe = recipeForBody(body('veyra', { amplitude: 0 }));
    expect(terrainRecipeBounds(recipe)).toEqual({
      minimumHeightMeters: 0,
      maximumHeightMeters: 0,
      maximumAngularSlopeMeters: 0,
    });
  });

  it('includes crater depth, rim, and angular slope contributions', () => {
    const base = structuredClone(recipeForBody(body('veyra')));
    const cratered = { ...base, craters: [{
      center: { x: 1, y: 0, z: 0 },
      angularRadius: 0.1,
      depth: 500,
      rimHeight: 100,
    }] };
    const without = terrainRecipeBounds({ ...base, craters: [] });
    const withCrater = terrainRecipeBounds(cratered);
    expect(withCrater.minimumHeightMeters).toBeLessThanOrEqual(without.minimumHeightMeters - 500);
    expect(withCrater.maximumHeightMeters).toBeGreaterThanOrEqual(without.maximumHeightMeters + 100);
    expect(withCrater.maximumAngularSlopeMeters).toBeGreaterThan(without.maximumAngularSlopeMeters);
  });

  it('rejects invalid finite-frequency metadata', () => {
    expect(() => terrainRecipeBounds(recipeForBody(body('veyra', { frequency: Number.NaN }))))
      .toThrow(/frequency/i);
    expect(() => terrainRecipeBounds(recipeForBody(body('veyra', { octaves: 0 }))))
      .toThrow(/octaves/i);
    const recipe = structuredClone(recipeForBody(body('veyra')));
    const cratered = {
      ...recipe,
      craters: [{ center: { x: 1, y: 0, z: 0 }, angularRadius: 0, depth: 1, rimHeight: 1 }],
    };
    expect(() => terrainRecipeBounds(cratered)).toThrow(/crater/i);
  });
});

describe('Body-backed planetary surface provider', () => {
  it('provides immutable integer descriptors and monotonic error metadata', () => {
    const provider = createBodySurfaceProvider(body('veyra'), {
      generation: 7,
      gridResolution: 17,
      maximumDepth: 12,
    });
    expect(provider.bodyId).toBe('veyra');
    expect(provider.generation).toBe(7);
    expect(provider.maximumDepth).toBe(12);
    const root = provider.rootTile(0);
    expect(root.id).toEqual(createTerrainTileId(0, 0, 0, 0));
    expect(root.key).toBe('0/0/0/0');
    expect(provider.children(root).map((child) => child.key)).toEqual([
      '0/1/0/0', '0/1/1/0', '0/1/0/1', '0/1/1/1',
    ]);
    const errors = Array.from({ length: provider.maximumDepth + 1 }, (_, depth) => (
      provider.geometricErrorMeters(createTerrainTileId(0, depth, 0, 0))
    ));
    expect(validateGeometricErrorTable(errors)).toEqual(Object.freeze(errors));
    for (let depth = 1; depth < errors.length; depth++) {
      expect(errors[depth]).toBeLessThanOrEqual(errors[depth - 1]);
    }
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(provider.buildSnapshot)).toBe(true);
    expect(structuredClone(provider.buildSnapshot)).toEqual(provider.buildSnapshot);
    const legacyLow = new THREE.Color('#4a7c46');
    expect(provider.buildSnapshot.palette.low[0]).toBeCloseTo(legacyLow.r, 9);
    expect(provider.buildSnapshot.palette.low[1]).toBeCloseTo(legacyLow.g, 9);
    expect(provider.buildSnapshot.palette.low[2]).toBeCloseTo(legacyLow.b, 9);
  });

  it('scales curvature error with radius without changing engine behavior', () => {
    const options = { generation: 1, gridResolution: 17, maximumDepth: 8 };
    const small = createBodySurfaceProvider(body('palla', { amplitude: 0 }, 1_000), options);
    const large = createBodySurfaceProvider(body('palla', { amplitude: 0 }, 10_000_000), options);
    for (let depth = 0; depth <= 8; depth++) {
      const tile = createTerrainTileId(0, depth, 0, 0);
      expect(large.geometricErrorMeters(tile)).toBeCloseTo(
        small.geometricErrorMeters(tile) * 10_000,
        8,
      );
    }
  });

  it('builds worker-safe geometry from the same authoritative recipe', () => {
    const provider = createBodySurfaceProvider(body('veyra'), {
      generation: 4,
      gridResolution: 9,
      maximumDepth: 8,
    });
    const tile = createTerrainTileId(2, 3, 4, 1);
    const request = provider.buildRequest(tile, 12);
    expect(request).toMatchObject({
      jobKey: terrainTileKey(tile),
      generation: 4,
      tile,
      resolution: 9,
      skirtDepth: 12,
    });
    const result = provider.build(request);
    expect(result).toMatchObject({ jobKey: terrainTileKey(tile), generation: 4, tile });
    const direction = new Vec3(
      result.bodyDirection[0], result.bodyDirection[1], result.bodyDirection[2],
    ).normalize();
    const absolute = new Vec3(
      result.origin[0] + result.position[0],
      result.origin[1] + result.position[1],
      result.origin[2] + result.position[2],
    );
    expect(absolute.length() - provider.radiusMeters)
      .toBeCloseTo(evaluateRecipeHeight(provider.buildSnapshot.recipe, direction), 0);
  });

  it('rejects invalid provider error tables', () => {
    expect(() => validateGeometricErrorTable([10, 11])).toThrow(/monotonic/i);
    expect(() => validateGeometricErrorTable([10, Number.NaN])).toThrow(/finite/i);
    expect(() => validateGeometricErrorTable([10, -1])).toThrow(/nonnegative/i);
  });
});
