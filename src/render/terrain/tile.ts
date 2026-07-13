export type CubeFace = 0 | 1 | 2 | 3 | 4 | 5;
export type TerrainTileEdge = 'west' | 'east' | 'south' | 'north';
export type TerrainTileKey = `${number}/${number}/${number}/${number}`;

export interface TerrainTileId {
  readonly face: CubeFace;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
}

export interface TerrainTileUvBounds {
  readonly u0: number;
  readonly v0: number;
  readonly size: number;
}

export interface CubeFaceBasis {
  readonly n: readonly [number, number, number];
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
}

export interface CubeFaceEdgeTransform {
  readonly face: CubeFace;
  /** Edge on the target face that touches the source edge. */
  readonly edge: TerrainTileEdge;
  /** Whether the integer coordinate running along the edge changes direction. */
  readonly reversed: boolean;
}

export const MAX_TERRAIN_TILE_DEPTH = 30;

/**
 * Cube orientation used by the existing terrain projection. Keeping this table
 * next to seam topology prevents worker geometry and neighbor lookup drifting.
 */
function faceBasis(
  n: readonly [number, number, number],
  u: readonly [number, number, number],
  v: readonly [number, number, number],
): CubeFaceBasis {
  return Object.freeze({ n: Object.freeze(n), u: Object.freeze(u), v: Object.freeze(v) });
}

export const CUBE_FACE_BASES: Readonly<Record<CubeFace, CubeFaceBasis>> = Object.freeze({
  0: faceBasis([1, 0, 0], [0, 1, 0], [0, 0, 1]),
  1: faceBasis([-1, 0, 0], [0, -1, 0], [0, 0, 1]),
  2: faceBasis([0, 1, 0], [0, 0, 1], [1, 0, 0]),
  3: faceBasis([0, -1, 0], [0, 0, -1], [1, 0, 0]),
  4: faceBasis([0, 0, 1], [1, 0, 0], [0, 1, 0]),
  5: faceBasis([0, 0, -1], [-1, 0, 0], [0, 1, 0]),
});

function edgeTransform(
  face: CubeFace,
  edge: TerrainTileEdge,
  reversed: boolean,
): CubeFaceEdgeTransform {
  return Object.freeze({ face, edge, reversed });
}

/** Explicit adjacency and orientation for all 24 directed cube-face edges. */
export const CUBE_FACE_EDGE_TABLE: Readonly<
  Record<CubeFace, Readonly<Record<TerrainTileEdge, CubeFaceEdgeTransform>>>
> = Object.freeze({
  0: Object.freeze({
    west: edgeTransform(3, 'north', true),
    east: edgeTransform(2, 'north', false),
    south: edgeTransform(5, 'west', false),
    north: edgeTransform(4, 'east', false),
  }),
  1: Object.freeze({
    west: edgeTransform(2, 'south', false),
    east: edgeTransform(3, 'south', true),
    south: edgeTransform(5, 'east', true),
    north: edgeTransform(4, 'west', true),
  }),
  2: Object.freeze({
    west: edgeTransform(5, 'north', true),
    east: edgeTransform(4, 'north', false),
    south: edgeTransform(1, 'west', false),
    north: edgeTransform(0, 'east', false),
  }),
  3: Object.freeze({
    west: edgeTransform(4, 'south', false),
    east: edgeTransform(5, 'south', true),
    south: edgeTransform(1, 'east', true),
    north: edgeTransform(0, 'west', true),
  }),
  4: Object.freeze({
    west: edgeTransform(1, 'north', true),
    east: edgeTransform(0, 'north', false),
    south: edgeTransform(3, 'west', false),
    north: edgeTransform(2, 'east', false),
  }),
  5: Object.freeze({
    west: edgeTransform(0, 'south', false),
    east: edgeTransform(1, 'south', true),
    south: edgeTransform(3, 'east', true),
    north: edgeTransform(2, 'west', true),
  }),
});

export function createTerrainTileId(
  face: number,
  depth: number,
  x: number,
  y: number,
): TerrainTileId {
  if (!Number.isInteger(face) || face < 0 || face > 5) {
    throw new RangeError(`Invalid terrain tile face ${face}`);
  }
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_TERRAIN_TILE_DEPTH) {
    throw new RangeError(`Invalid terrain tile depth ${depth}`);
  }
  const count = 2 ** depth;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= count || y >= count) {
    throw new RangeError(`Invalid terrain tile coordinate (${x}, ${y}) at depth ${depth}`);
  }
  return Object.freeze({ face: face as CubeFace, depth, x, y });
}

const ROOT_IDS = Object.freeze(
  Array.from({ length: 6 }, (_, face) => createTerrainTileId(face, 0, 0, 0)),
) as readonly TerrainTileId[];

export function terrainRootIds(): readonly TerrainTileId[] {
  return ROOT_IDS;
}

export function terrainTileKey(tile: Readonly<TerrainTileId>): TerrainTileKey {
  return `${tile.face}/${tile.depth}/${tile.x}/${tile.y}`;
}

export function parseTerrainTileKey(key: string): TerrainTileId {
  const parts = key.split('/');
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d*)$/.test(part))) {
    throw new Error(`Invalid terrain tile key: ${key}`);
  }
  try {
    const tile = createTerrainTileId(...parts.map(Number) as [number, number, number, number]);
    if (terrainTileKey(tile) !== key) throw new Error('noncanonical');
    return tile;
  } catch {
    throw new Error(`Invalid terrain tile key: ${key}`);
  }
}

export function terrainTileParent(tile: Readonly<TerrainTileId>): TerrainTileId | null {
  if (tile.depth === 0) return null;
  return createTerrainTileId(
    tile.face,
    tile.depth - 1,
    Math.floor(tile.x / 2),
    Math.floor(tile.y / 2),
  );
}

export function terrainTileChildren(tile: Readonly<TerrainTileId>): readonly [
  TerrainTileId,
  TerrainTileId,
  TerrainTileId,
  TerrainTileId,
] {
  if (tile.depth >= MAX_TERRAIN_TILE_DEPTH) {
    throw new RangeError(`Terrain tile at maximum depth ${tile.depth} has no representable children`);
  }
  const depth = tile.depth + 1;
  const x = tile.x * 2;
  const y = tile.y * 2;
  return Object.freeze([
    createTerrainTileId(tile.face, depth, x, y),
    createTerrainTileId(tile.face, depth, x + 1, y),
    createTerrainTileId(tile.face, depth, x, y + 1),
    createTerrainTileId(tile.face, depth, x + 1, y + 1),
  ]);
}

export function terrainTileUvBounds(tile: Readonly<TerrainTileId>): TerrainTileUvBounds {
  const count = 2 ** tile.depth;
  const size = 2 / count;
  return Object.freeze({
    u0: -1 + tile.x * size,
    v0: -1 + tile.y * size,
    size,
  });
}

export function edgeNeighbor(
  tile: Readonly<TerrainTileId>,
  edge: TerrainTileEdge,
): TerrainTileId {
  const count = 2 ** tile.depth;
  if (edge === 'west' && tile.x > 0) {
    return createTerrainTileId(tile.face, tile.depth, tile.x - 1, tile.y);
  }
  if (edge === 'east' && tile.x < count - 1) {
    return createTerrainTileId(tile.face, tile.depth, tile.x + 1, tile.y);
  }
  if (edge === 'south' && tile.y > 0) {
    return createTerrainTileId(tile.face, tile.depth, tile.x, tile.y - 1);
  }
  if (edge === 'north' && tile.y < count - 1) {
    return createTerrainTileId(tile.face, tile.depth, tile.x, tile.y + 1);
  }

  const transform = CUBE_FACE_EDGE_TABLE[tile.face][edge];
  const sourceAlong = edge === 'west' || edge === 'east' ? tile.y : tile.x;
  const targetAlong = transform.reversed ? count - 1 - sourceAlong : sourceAlong;
  switch (transform.edge) {
    case 'west': return createTerrainTileId(transform.face, tile.depth, 0, targetAlong);
    case 'east': return createTerrainTileId(transform.face, tile.depth, count - 1, targetAlong);
    case 'south': return createTerrainTileId(transform.face, tile.depth, targetAlong, 0);
    case 'north': return createTerrainTileId(transform.face, tile.depth, targetAlong, count - 1);
  }
}
