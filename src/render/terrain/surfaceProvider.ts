import type { Body } from '../../sim/universe';
import {
  recipeForBody,
  terrainRecipeBounds,
  type BodyFeatureRecipe,
  type TerrainRecipeBounds,
} from '../../sim/terrainRecipe';
import {
  buildTerrainChunkGeometry,
  type TerrainChunkGeometryRequest,
  type TerrainChunkGeometryResult,
  type TerrainChunkPalette,
} from './chunkGeometry';
import {
  createTerrainTileId,
  terrainTileChildren,
  terrainTileKey,
  terrainTileUvBounds,
  type CubeFace,
  type TerrainTileId,
  type TerrainTileKey,
  type TerrainTileUvBounds,
} from './tile';

export interface TerrainBuildSnapshot {
  readonly recipe: BodyFeatureRecipe;
  readonly radius: number;
  readonly palette: TerrainChunkPalette;
}

export interface TerrainTileDescriptor {
  readonly id: TerrainTileId;
  readonly key: TerrainTileKey;
  readonly uvBounds: TerrainTileUvBounds;
  readonly geometricErrorMeters: number;
}

export interface PlanetSurfaceProvider {
  readonly bodyId: string;
  readonly radiusMeters: number;
  readonly maximumDepth: number;
  readonly generation: number;
  readonly displacementBounds: TerrainRecipeBounds;
  readonly buildSnapshot: TerrainBuildSnapshot;

  tile(id: Readonly<TerrainTileId>): TerrainTileDescriptor;
  rootTile(face: CubeFace): TerrainTileDescriptor;
  children(tile: Readonly<TerrainTileDescriptor>): readonly [
    TerrainTileDescriptor,
    TerrainTileDescriptor,
    TerrainTileDescriptor,
    TerrainTileDescriptor,
  ];
  geometricErrorMeters(tile: Readonly<TerrainTileId>): number;
  buildRequest(
    tile: Readonly<TerrainTileId>,
    skirtDepth: number,
    jobKey?: string,
  ): TerrainChunkGeometryRequest;
  build(request: Readonly<TerrainChunkGeometryRequest>): TerrainChunkGeometryResult;
}

export interface BodySurfaceProviderOptions {
  readonly generation: number;
  readonly gridResolution: number;
  readonly maximumDepth?: number;
}

function freezeRecipe(recipe: Readonly<BodyFeatureRecipe>): BodyFeatureRecipe {
  return Object.freeze({
    ...recipe,
    terrain: Object.freeze({ ...recipe.terrain }),
    craters: Object.freeze(recipe.craters.map((crater) => Object.freeze({
      ...crater,
      center: Object.freeze({ ...crater.center }),
    }))),
  });
}

function colorTuple(value: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!match) throw new Error(`Invalid terrain palette color ${value}`);
  const srgbToLinear = (component: string): number => {
    const value = Number.parseInt(component, 16) / 255;
    return value < 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  return Object.freeze([
    srgbToLinear(match[1]),
    srgbToLinear(match[2]),
    srgbToLinear(match[3]),
  ]);
}

function paletteForBody(body: Readonly<Body>): TerrainChunkPalette {
  const terrain = body.def.terrain;
  return Object.freeze({
    low: colorTuple(terrain.colorLow),
    mid: colorTuple(terrain.colorMid),
    high: colorTuple(terrain.colorHigh),
    ocean: colorTuple(terrain.colorOcean ?? terrain.colorLow),
  });
}

export function validateGeometricErrorTable(values: readonly number[]): readonly number[] {
  if (values.length === 0) throw new Error('Geometric error table is empty');
  let previous = Number.POSITIVE_INFINITY;
  const validated: number[] = [];
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error('Geometric error must be finite');
    if (value < 0) throw new Error('Geometric error must be nonnegative');
    if (value > previous) throw new Error('Geometric error must be monotonically non-increasing');
    validated.push(value);
    previous = value;
  }
  return Object.freeze(validated);
}

function maximumDepthForRadius(radius: number): number {
  return Math.max(6, Math.min(16, Math.ceil(Math.log2(radius / 30))));
}

export function createBodySurfaceProvider(
  body: Readonly<Body>,
  options: Readonly<BodySurfaceProviderOptions>,
): PlanetSurfaceProvider {
  if (!Number.isFinite(body.radius) || body.radius <= 0) throw new Error(`Invalid body radius ${body.radius}`);
  if (!Number.isInteger(options.generation) || options.generation < 1) {
    throw new Error(`Invalid terrain generation ${options.generation}`);
  }
  if (!Number.isInteger(options.gridResolution) || options.gridResolution < 2) {
    throw new Error(`Invalid terrain grid resolution ${options.gridResolution}`);
  }
  const maximumDepth = options.maximumDepth ?? maximumDepthForRadius(body.radius);
  if (!Number.isInteger(maximumDepth) || maximumDepth < 0 || maximumDepth > 30) {
    throw new Error(`Invalid terrain maximum depth ${maximumDepth}`);
  }

  const recipe = freezeRecipe(recipeForBody(body));
  const displacementBounds = terrainRecipeBounds(recipe);
  const palette = paletteForBody(body);
  const buildSnapshot: TerrainBuildSnapshot = Object.freeze({
    recipe,
    radius: body.radius,
    palette,
  });
  const maximumAbsoluteHeight = Math.max(
    Math.abs(displacementBounds.minimumHeightMeters),
    Math.abs(displacementBounds.maximumHeightMeters),
  );
  const errors = validateGeometricErrorTable(
    Array.from({ length: maximumDepth + 1 }, (_, depth) => {
      const angularCellDiagonal = (
        Math.PI * Math.SQRT2
      ) / (2 * 2 ** depth * (options.gridResolution - 1));
      const curvatureError = (body.radius + maximumAbsoluteHeight)
        * (1 - Math.cos(angularCellDiagonal));
      const heightError = displacementBounds.maximumAngularSlopeMeters * angularCellDiagonal;
      return curvatureError + heightError;
    }),
  );

  const descriptor = (id: Readonly<TerrainTileId>): TerrainTileDescriptor => {
    const validatedId = createTerrainTileId(id.face, id.depth, id.x, id.y);
    if (validatedId.depth > maximumDepth) {
      throw new Error(`Terrain tile depth ${validatedId.depth} exceeds provider maximum ${maximumDepth}`);
    }
    return Object.freeze({
      id: validatedId,
      key: terrainTileKey(validatedId),
      uvBounds: terrainTileUvBounds(validatedId),
      geometricErrorMeters: errors[validatedId.depth],
    });
  };

  return Object.freeze({
    bodyId: body.id,
    radiusMeters: body.radius,
    maximumDepth,
    generation: options.generation,
    displacementBounds,
    buildSnapshot,
    tile: descriptor,
    rootTile: (face: CubeFace) => descriptor(createTerrainTileId(face, 0, 0, 0)),
    children: (tile: Readonly<TerrainTileDescriptor>) => {
      if (tile.id.depth >= maximumDepth) {
        throw new Error(`Terrain tile ${tile.key} is at provider maximum depth`);
      }
      return Object.freeze(terrainTileChildren(tile.id).map(descriptor)) as unknown as readonly [
        TerrainTileDescriptor,
        TerrainTileDescriptor,
        TerrainTileDescriptor,
        TerrainTileDescriptor,
      ];
    },
    geometricErrorMeters: (tile: Readonly<TerrainTileId>) => descriptor(tile).geometricErrorMeters,
    buildRequest: (
      tile: Readonly<TerrainTileId>,
      skirtDepth: number,
      jobKey = terrainTileKey(tile),
    ) => {
      const described = descriptor(tile);
      if (!Number.isFinite(skirtDepth) || skirtDepth < 0) {
        throw new Error(`Invalid terrain skirt depth ${skirtDepth}`);
      }
      return Object.freeze({
        jobKey,
        generation: options.generation,
        tile: described.id,
        recipe,
        radius: body.radius,
        resolution: options.gridResolution,
        skirtDepth,
        palette,
      });
    },
    build: (request: Readonly<TerrainChunkGeometryRequest>) => buildTerrainChunkGeometry(request),
  });
}
