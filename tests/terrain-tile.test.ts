import { describe, expect, it } from 'vitest';
import {
  CUBE_FACE_EDGE_TABLE,
  CUBE_FACE_BASES,
  MAX_TERRAIN_TILE_DEPTH,
  createTerrainTileId,
  edgeNeighbor,
  parseTerrainTileKey,
  terrainRootIds,
  terrainTileChildren,
  terrainTileKey,
  terrainTileParent,
  terrainTileUvBounds,
  type CubeFace,
  type TerrainTileEdge,
} from '../src/render/terrain/tile';

const edges = ['west', 'east', 'south', 'north'] as const;

function cubePoint(face: CubeFace, u: number, v: number): readonly number[] {
  const basis = CUBE_FACE_BASES[face];
  return basis.n.map((component, axis) => (
    component + basis.u[axis] * u + basis.v[axis] * v
  ));
}

function tileContainsCubePoint(
  tile: ReturnType<typeof createTerrainTileId>,
  point: readonly number[],
): boolean {
  const bounds = terrainTileUvBounds(tile);
  return [bounds.u0, bounds.u0 + bounds.size].some((u) => (
    [bounds.v0, bounds.v0 + bounds.size].some((v) => (
      cubePoint(tile.face, u, v).every((component, axis) => component === point[axis]
      )
    ))
  ));
}

function opposite(edge: TerrainTileEdge): TerrainTileEdge {
  switch (edge) {
    case 'west': return 'east';
    case 'east': return 'west';
    case 'south': return 'north';
    case 'north': return 'south';
  }
}

describe('integer terrain tile identity', () => {
  it('creates six canonical roots and round-trips stable keys', () => {
    const roots = terrainRootIds();
    expect(roots.map(terrainTileKey)).toEqual([
      '0/0/0/0', '1/0/0/0', '2/0/0/0',
      '3/0/0/0', '4/0/0/0', '5/0/0/0',
    ]);
    for (const root of roots) {
      expect(parseTerrainTileKey(terrainTileKey(root))).toEqual(root);
      expect(Object.isFrozen(root)).toBe(true);
    }
    expect(Object.isFrozen(CUBE_FACE_BASES[0].n)).toBe(true);
  });

  it('rejects invalid faces, depths, coordinates, and noncanonical keys', () => {
    expect(() => createTerrainTileId(6, 0, 0, 0)).toThrow(/face/i);
    expect(() => createTerrainTileId(0, -1, 0, 0)).toThrow(/depth/i);
    expect(() => createTerrainTileId(0, MAX_TERRAIN_TILE_DEPTH + 1, 0, 0)).toThrow(/depth/i);
    expect(() => createTerrainTileId(0, 2, 4, 0)).toThrow(/coordinate/i);
    expect(() => createTerrainTileId(0, 2, 0, -1)).toThrow(/coordinate/i);
    expect(() => createTerrainTileId(0, 1.5, 0, 0)).toThrow(/depth/i);
    expect(() => parseTerrainTileKey('0/01/0/0')).toThrow(/key/i);
    expect(() => parseTerrainTileKey('0/1/0')).toThrow(/key/i);
    expect(() => parseTerrainTileKey('not/a/tile/key')).toThrow(/key/i);
  });

  it('derives parents, ordered children, and UV bounds from integers', () => {
    const tile = createTerrainTileId(5, 3, 2, 5);
    expect(terrainTileParent(tile)).toEqual(createTerrainTileId(5, 2, 1, 2));
    expect(terrainTileChildren(tile)).toEqual([
      createTerrainTileId(5, 4, 4, 10),
      createTerrainTileId(5, 4, 5, 10),
      createTerrainTileId(5, 4, 4, 11),
      createTerrainTileId(5, 4, 5, 11),
    ]);
    expect(terrainTileUvBounds(tile)).toEqual({ u0: -0.5, v0: 0.25, size: 0.25 });
    expect(terrainTileParent(createTerrainTileId(5, 0, 0, 0))).toBeNull();
  });

  it('round-trips every parent and child through depth 6', () => {
    for (let face = 0; face < 6; face++) {
      for (let depth = 0; depth < 6; depth++) {
        const count = 2 ** depth;
        for (let y = 0; y < count; y++) {
          for (let x = 0; x < count; x++) {
            const parent = createTerrainTileId(face, depth, x, y);
            for (const child of terrainTileChildren(parent)) {
              expect(terrainTileParent(child)).toEqual(parent);
            }
          }
        }
      }
    }
  });
});

describe('cube-face terrain neighbors', () => {
  it('uses the expected renderer face orientation at representative edges', () => {
    expect(CUBE_FACE_EDGE_TABLE[0]).toEqual({
      west: { face: 3, edge: 'north', reversed: true },
      east: { face: 2, edge: 'north', reversed: false },
      south: { face: 5, edge: 'west', reversed: false },
      north: { face: 4, edge: 'east', reversed: false },
    });
    expect(edgeNeighbor(createTerrainTileId(0, 2, 3, 1), 'east'))
      .toEqual(createTerrainTileId(2, 2, 1, 3));
    expect(edgeNeighbor(createTerrainTileId(0, 2, 0, 1), 'west'))
      .toEqual(createTerrainTileId(3, 2, 2, 3));
  });

  it('moves within a face without consulting a seam transform', () => {
    const tile = createTerrainTileId(4, 3, 3, 4);
    expect(edgeNeighbor(tile, 'west')).toEqual(createTerrainTileId(4, 3, 2, 4));
    expect(edgeNeighbor(tile, 'east')).toEqual(createTerrainTileId(4, 3, 4, 4));
    expect(edgeNeighbor(tile, 'south')).toEqual(createTerrainTileId(4, 3, 3, 3));
    expect(edgeNeighbor(tile, 'north')).toEqual(createTerrainTileId(4, 3, 3, 5));
    for (const edge of edges) {
      expect(edgeNeighbor(edgeNeighbor(tile, edge), opposite(edge))).toEqual(tile);
    }
  });

  it('round-trips every cube seam in both directions through depth 6', () => {
    for (let depth = 0; depth <= 6; depth++) {
      const count = 2 ** depth;
      for (let face = 0; face < 6; face++) {
        for (const edge of edges) {
          const crossing = CUBE_FACE_EDGE_TABLE[face as CubeFace][edge];
          for (let along = 0; along < count; along++) {
            const source = edge === 'west' || edge === 'east'
              ? createTerrainTileId(face, depth, edge === 'west' ? 0 : count - 1, along)
              : createTerrainTileId(face, depth, along, edge === 'south' ? 0 : count - 1);
            const target = edgeNeighbor(source, edge);
            expect(target.face).toBe(crossing.face);
            expect(edgeNeighbor(target, crossing.edge)).toEqual(source);
          }
        }
      }
    }
  });

  it('preserves both axes at cube corners without producing invalid coordinates', () => {
    for (let face = 0; face < 6; face++) {
      for (let depth = 0; depth <= 6; depth++) {
        const last = 2 ** depth - 1;
        for (const [x, y, horizontal, vertical] of [
          [0, 0, 'west', 'south'],
          [last, 0, 'east', 'south'],
          [0, last, 'west', 'north'],
          [last, last, 'east', 'north'],
        ] as const) {
          const corner = createTerrainTileId(face, depth, x, y);
          const point = cubePoint(
            corner.face,
            horizontal === 'west' ? -1 : 1,
            vertical === 'south' ? -1 : 1,
          );
          for (const edge of [horizontal, vertical]) {
            const neighbor = edgeNeighbor(corner, edge);
            expect(neighbor.x).toBeGreaterThanOrEqual(0);
            expect(neighbor.y).toBeGreaterThanOrEqual(0);
            expect(neighbor.x).toBeLessThanOrEqual(last);
            expect(neighbor.y).toBeLessThanOrEqual(last);
            expect(tileContainsCubePoint(neighbor, point)).toBe(true);
          }
        }
      }
    }
  });
});
