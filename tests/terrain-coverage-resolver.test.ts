import { describe, expect, it } from 'vitest';
import { LEGACY_AUREN_SYSTEM as AUREN_SYSTEM } from './fixtures/legacyAurenSystem';
import { Body } from '../src/sim/universe';
import {
  isTerrainTileRenderable,
  resolveTerrainCoverage,
  type TerrainTileRecord,
  type TerrainTileState,
} from '../src/render/terrain/coverageResolver';
import { createBodySurfaceProvider, type TerrainTileDescriptor } from '../src/render/terrain/surfaceProvider';
import { createTerrainTileId } from '../src/render/terrain/tile';

function provider() {
  const definition = structuredClone(AUREN_SYSTEM.find((candidate) => candidate.id === 'palla')!);
  definition.id = 'coverage-test';
  definition.radius = 1_000;
  definition.terrain.amplitude = 0;
  return createBodySurfaceProvider(new Body(definition, null), {
    generation: 3, gridResolution: 9, maximumDepth: 5,
  });
}

function record(
  tile: TerrainTileDescriptor,
  state: TerrainTileState = 'installed',
  overrides: Partial<TerrainTileRecord> = {},
): TerrainTileRecord {
  return {
    tile,
    state,
    generation: 3,
    materialGeneration: 9,
    gpuValid: true,
    ...overrides,
  };
}

function rootRecords(surface: ReturnType<typeof provider>): Map<string, TerrainTileRecord> {
  return new Map(Array.from({ length: 6 }, (_, face) => {
    const root = surface.rootTile(face as 0 | 1 | 2 | 3 | 4 | 5);
    return [root.key, record(root)];
  }));
}

function resolve(
  surface: ReturnType<typeof provider>,
  desiredLeaves: TerrainTileDescriptor[],
  records: Map<string, TerrainTileRecord>,
  previousRenderedKeys: ReadonlySet<string> = new Set(),
) {
  return resolveTerrainCoverage({
    provider: surface,
    desiredLeaves,
    records,
    previousRenderedKeys,
    generation: 3,
    materialGeneration: 9,
  });
}

describe('terrain tile renderability', () => {
  it('requires installed current-generation geometry, committed material, and valid GPU state', () => {
    const surface = provider();
    const tile = surface.rootTile(0);
    expect(isTerrainTileRenderable(record(tile), 3, 9)).toBe(true);
    for (const state of ['unloaded', 'queued', 'building', 'ready', 'failed'] as const) {
      expect(isTerrainTileRenderable(record(tile, state), 3, 9)).toBe(false);
    }
    expect(isTerrainTileRenderable(record(tile, 'installed', { generation: 2 }), 3, 9)).toBe(false);
    expect(isTerrainTileRenderable(record(tile, 'installed', { materialGeneration: 8 }), 3, 9)).toBe(false);
    expect(isTerrainTileRenderable(record(tile, 'installed', { gpuValid: false }), 3, 9)).toBe(false);
  });
});

describe('complete terrain coverage resolution', () => {
  it('requests all roots and withholds detailed readiness before initial coverage', () => {
    const surface = provider();
    const root = surface.rootTile(0);
    const result = resolve(surface, [root], new Map());
    expect(result.rootsReady).toBe(false);
    expect(result.completeCoverage).toBe(false);
    expect(result.renderedKeys.size).toBe(0);
    expect(result.requests.filter((request) => request.reason === 'root')).toHaveLength(6);
  });

  it('keeps an installed parent until all four immediate child quadrants are covered', () => {
    const surface = provider();
    const records = rootRecords(surface);
    const root = surface.rootTile(0);
    const children = [...surface.children(root)];
    records.set(children[0].key, record(children[0]));
    const result = resolve(surface, children, records);
    expect([...result.renderedKeys]).toEqual([root.key]);
    expect(result.fallbackKeys.has(root.key)).toBe(true);
    expect([...result.stagingKeys]).toEqual([children[0].key]);
    expect(result.protectionKeys.has(children[0].key)).toBe(true);
    expect(result.requests.filter((request) => request.reason === 'replacement').map((request) => request.tile.key))
      .toEqual(children.slice(1).map((child) => child.key).sort());
    expect(result.completeCoverage).toBe(true);
  });

  it('requires hidden sibling readiness before replacing a parent', () => {
    const surface = provider();
    const records = rootRecords(surface);
    const root = surface.rootTile(0);
    const children = [...surface.children(root)];
    const visibleChild = children[0];
    records.set(visibleChild.key, record(visibleChild));
    const result = resolve(surface, [visibleChild], records);
    expect([...result.renderedKeys]).toEqual([root.key]);
    expect(result.requests.map((request) => request.tile.key)).toEqual(children.slice(1).map((child) => child.key).sort());
  });

  it('uses a complete deeper subtree as an immediate-child stand-in', () => {
    const surface = provider();
    const records = rootRecords(surface);
    const root = surface.rootTile(0);
    const children = [...surface.children(root)];
    for (let index = 1; index < children.length; index++) records.set(children[index].key, record(children[index]));
    const grandchildren = [...surface.children(children[0])];
    for (const grandchild of grandchildren) records.set(grandchild.key, record(grandchild));
    const result = resolve(surface, children, records);
    expect(result.renderedKeys.has(root.key)).toBe(false);
    expect(grandchildren.every((tile) => result.renderedKeys.has(tile.key))).toBe(true);
    expect(children.slice(1).every((tile) => result.renderedKeys.has(tile.key))).toBe(true);
  });

  it('retains a complete previous descendant set while its coarse destination loads', () => {
    const surface = provider();
    const records = rootRecords(surface);
    const root = surface.rootTile(0);
    const children = [...surface.children(root)];
    const child = children[0];
    for (const sibling of children.slice(1)) records.set(sibling.key, record(sibling));
    const grandchildren = [...surface.children(child)];
    for (const grandchild of grandchildren) records.set(grandchild.key, record(grandchild));
    const previous = new Set(grandchildren.map((tile) => tile.key));
    const result = resolve(surface, [child], records, previous);
    expect([...result.renderedKeys].sort()).toEqual([...previous].sort());
    expect([...result.continuityKeys].sort()).toEqual([...previous].sort());
    expect(result.requests).toEqual([
      expect.objectContaining({ tile: child, requestClass: 'previous-frame-continuity', reason: 'continuity' }),
    ]);
  });

  it('protects every root for the generation after root readiness', () => {
    const surface = provider();
    const records = rootRecords(surface);
    const desired = [surface.tile(createTerrainTileId(0, 0, 0, 0))];
    const result = resolve(surface, desired, records);
    expect(result.rootsReady).toBe(true);
    expect(result.completeCoverage).toBe(true);
    for (let face = 0; face < 6; face++) {
      expect(result.protectionKeys.has(surface.rootTile(face as 0 | 1 | 2 | 3 | 4 | 5).key)).toBe(true);
    }
  });
});
