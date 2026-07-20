import { Vec3 } from '../../core/vec3';
import {
  LAUNCH_PAD_DECK_HEIGHT,
  LAUNCH_PAD_FOOTPRINT_RADIUS,
  LAUNCH_PAD_TERRAIN_CLEARANCE,
  launchSiteBodyFixedDirection,
} from '../../sim/launchSite';
import { evaluateRecipeHeight, type BodyFeatureRecipe } from '../../sim/terrainRecipe';
import {
  CUBE_FACE_BASES,
  createTerrainTileId,
  terrainTileUvBounds,
  type CubeFace,
  type TerrainTileId,
} from './tile';

export type TerrainColor = readonly [number, number, number];

export interface TerrainChunkPalette {
  readonly low: TerrainColor;
  readonly mid: TerrainColor;
  readonly high: TerrainColor;
  readonly ocean: TerrainColor;
}

export interface TerrainChunkGeometryRequest {
  readonly jobKey: string;
  readonly generation: number;
  readonly tile: TerrainTileId;
  readonly recipe: BodyFeatureRecipe;
  readonly radius: number;
  readonly resolution: number;
  readonly skirtDepth: number;
  readonly palette: TerrainChunkPalette;
}

export interface TerrainChunkBounds {
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

export interface TerrainChunkGeometryResult {
  readonly jobKey: string;
  readonly generation: number;
  readonly tile: TerrainTileId;
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly color: Float32Array;
  readonly bodyDirection: Float32Array;
  readonly bodyFixedDetailAnchor: Float32Array;
  readonly index: Uint16Array | Uint32Array;
  readonly origin: readonly [number, number, number];
  readonly bounds: TerrainChunkBounds;
  readonly buildMs: number;
}

export function terrainGeometryTransferables(result: TerrainChunkGeometryResult): ArrayBuffer[] {
  return [
    result.position.buffer as ArrayBuffer,
    result.normal.buffer as ArrayBuffer,
    result.color.buffer as ArrayBuffer,
    result.bodyDirection.buffer as ArrayBuffer,
    result.bodyFixedDetailAnchor.buffer as ArrayBuffer,
    result.index.buffer as ArrayBuffer,
  ];
}

const DETAIL_PERIOD_METERS = 8192;

/**
 * A sampled height recipe alone cannot constrain the chord between very coarse
 * terrain vertices. Keep every temporary LOD's triangles below Cape
 * Skyward's deck footprint while the guaranteed maximum-detail ring streams.
 */
function enforceLaunchPadMeshClearance(
  request: Readonly<TerrainChunkGeometryRequest>,
  tile: Readonly<TerrainTileId>,
  origin: readonly [number, number, number],
  position: Float32Array,
  normal: Float32Array,
  bodyDirection: Float32Array,
  bodyFixedDetailAnchor: Float32Array,
): void {
  if (request.recipe.bodyId !== 'veyra') return;
  const site = launchSiteBodyFixedDirection(new Vec3());
  const basis = CUBE_FACE_BASES[tile.face];
  const faceScale = site.x * basis.n[0] + site.y * basis.n[1] + site.z * basis.n[2];
  if (!(faceScale > 0)) return;
  const siteU = Math.atan(
    (site.x * basis.u[0] + site.y * basis.u[1] + site.z * basis.u[2]) / faceScale,
  ) / (Math.PI / 4);
  const siteV = Math.atan(
    (site.x * basis.v[0] + site.y * basis.v[1] + site.z * basis.v[2]) / faceScale,
  ) / (Math.PI / 4);
  const { u0, v0, size } = terrainTileUvBounds(tile);
  const uvMargin = LAUNCH_PAD_FOOTPRINT_RADIUS / request.radius * 2;
  if (
    siteU < u0 - uvMargin || siteU > u0 + size + uvMargin
    || siteV < v0 - uvMargin || siteV > v0 + size + uvMargin
  ) return;

  const east = new Vec3(-site.y, site.x, 0).normalize();
  const north = Vec3.cross(site, east, new Vec3()).normalize();
  const samples = [site.clone()];
  for (let index = 0; index < 16; index++) {
    const angle = index / 16 * Math.PI * 2;
    samples.push(site.clone()
      .addScaled(east, Math.cos(angle) * LAUNCH_PAD_FOOTPRINT_RADIUS / request.radius)
      .addScaled(north, Math.sin(angle) * LAUNCH_PAD_FOOTPRINT_RADIUS / request.radius)
      .normalize());
  }
  const ceiling = evaluateRecipeHeight(request.recipe, site)
    + LAUNCH_PAD_DECK_HEIGHT - LAUNCH_PAD_TERRAIN_CLEARANCE;
  const resolution = request.resolution;
  const touched = new Set<number>();

  const rayTriangleDistance = (direction: Readonly<Vec3>, ia: number, ib: number, ic: number): number => {
    const ao = ia * 3;
    const bo = ib * 3;
    const co = ic * 3;
    const ax = position[ao] + origin[0];
    const ay = position[ao + 1] + origin[1];
    const az = position[ao + 2] + origin[2];
    const e1x = position[bo] + origin[0] - ax;
    const e1y = position[bo + 1] + origin[1] - ay;
    const e1z = position[bo + 2] + origin[2] - az;
    const e2x = position[co] + origin[0] - ax;
    const e2y = position[co + 1] + origin[1] - ay;
    const e2z = position[co + 2] + origin[2] - az;
    const px = direction.y * e2z - direction.z * e2y;
    const py = direction.z * e2x - direction.x * e2z;
    const pz = direction.x * e2y - direction.y * e2x;
    const determinant = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(determinant) < 1e-9) return Infinity;
    const inverse = 1 / determinant;
    const tx = -ax;
    const ty = -ay;
    const tz = -az;
    const u = (tx * px + ty * py + tz * pz) * inverse;
    if (u < 0 || u > 1) return Infinity;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (direction.x * qx + direction.y * qy + direction.z * qz) * inverse;
    if (v < 0 || u + v > 1) return Infinity;
    const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
    return distance > 0 ? distance : Infinity;
  };

  // Corrections can share vertices, so make a few bounded passes until every
  // footprint ray is safely below the physical deck plane.
  for (let pass = 0; pass < 4; pass++) {
    let corrected = false;
    for (const direction of samples) {
      let bestDistance = Infinity;
      let bestTriangle: readonly [number, number, number] | null = null;
      for (let row = 0; row < resolution - 1; row++) {
        for (let column = 0; column < resolution - 1; column++) {
          const a = row * resolution + column;
          const b = a + 1;
          const c = a + resolution;
          const d = c + 1;
          for (const triangle of [[a, b, c], [b, d, c]] as const) {
            const distance = rayTriangleDistance(direction, ...triangle);
            if (distance < bestDistance) {
              bestDistance = distance;
              bestTriangle = triangle;
            }
          }
        }
      }
      if (!bestTriangle || bestDistance - request.radius <= ceiling) continue;
      const correction = bestDistance - request.radius - ceiling + 0.05;
      for (const vertex of bestTriangle) {
        const offset = vertex * 3;
        position[offset] -= bodyDirection[offset] * correction;
        position[offset + 1] -= bodyDirection[offset + 1] * correction;
        position[offset + 2] -= bodyDirection[offset + 2] * correction;
        bodyFixedDetailAnchor[offset] -= bodyDirection[offset] * correction;
        bodyFixedDetailAnchor[offset + 1] -= bodyDirection[offset + 1] * correction;
        bodyFixedDetailAnchor[offset + 2] -= bodyDirection[offset + 2] * correction;
        touched.add(vertex);
      }
      corrected = true;
    }
    if (!corrected) break;
  }

  if (touched.size === 0) return;
  const affected = new Set(touched);
  for (const vertex of touched) {
    const row = Math.floor(vertex / resolution);
    const column = vertex % resolution;
    for (let y = Math.max(0, row - 1); y <= Math.min(resolution - 1, row + 1); y++) {
      for (let x = Math.max(0, column - 1); x <= Math.min(resolution - 1, column + 1); x++) {
        affected.add(y * resolution + x);
      }
    }
  }
  const accumulated = new Float64Array(resolution * resolution * 3);
  for (let row = 0; row < resolution - 1; row++) {
    for (let column = 0; column < resolution - 1; column++) {
      const a = row * resolution + column;
      const b = a + 1;
      const c = a + resolution;
      const d = c + 1;
      for (const [ia, ib, ic] of [[a, b, c], [b, d, c]] as const) {
        if (!affected.has(ia) && !affected.has(ib) && !affected.has(ic)) continue;
        const ao = ia * 3;
        const bo = ib * 3;
        const co = ic * 3;
        const abx = position[bo] - position[ao];
        const aby = position[bo + 1] - position[ao + 1];
        const abz = position[bo + 2] - position[ao + 2];
        const acx = position[co] - position[ao];
        const acy = position[co + 1] - position[ao + 1];
        const acz = position[co + 2] - position[ao + 2];
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        for (const vertex of [ia, ib, ic]) {
          if (!affected.has(vertex)) continue;
          const offset = vertex * 3;
          accumulated[offset] += nx;
          accumulated[offset + 1] += ny;
          accumulated[offset + 2] += nz;
        }
      }
    }
  }
  for (const vertex of affected) {
    const offset = vertex * 3;
    const length = Math.hypot(accumulated[offset], accumulated[offset + 1], accumulated[offset + 2]);
    if (!(length > 0)) continue;
    const sign = accumulated[offset] * bodyDirection[offset]
      + accumulated[offset + 1] * bodyDirection[offset + 1]
      + accumulated[offset + 2] * bodyDirection[offset + 2] < 0 ? -1 : 1;
    normal[offset] = accumulated[offset] / length * sign;
    normal[offset + 1] = accumulated[offset + 1] / length * sign;
    normal[offset + 2] = accumulated[offset + 2] / length * sign;
  }
}

export function terrainFaceToDirection(faceIndex: number, u: number, v: number, out = new Vec3()): Vec3 {
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex > 5) {
    throw new RangeError(`Invalid cube face ${faceIndex}`);
  }
  const face = CUBE_FACE_BASES[faceIndex as CubeFace];
  const su = Math.tan(u * (Math.PI / 4));
  const sv = Math.tan(v * (Math.PI / 4));
  return out.set(
    face.n[0] + face.u[0] * su + face.v[0] * sv,
    face.n[1] + face.u[1] * su + face.v[1] * sv,
    face.n[2] + face.u[2] * su + face.v[2] * sv,
  ).normalize();
}

function mix(a: TerrainColor, b: TerrainColor, t: number): TerrainColor {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function periodicOffset(value: number): number {
  return ((value % DETAIL_PERIOD_METERS) + DETAIL_PERIOD_METERS) % DETAIL_PERIOD_METERS;
}

export function terrainGridIndices(resolution: number): number[] {
  const indices: number[] = [];
  for (let j = 0; j < resolution - 1; j++) {
    for (let i = 0; i < resolution - 1; i++) {
      const a = j * resolution + i;
      const b = a + 1;
      const c = a + resolution;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  return indices;
}

/** Build worker-safe terrain geometry without constructing a Body or reading Three.js state. */
export function buildTerrainChunkGeometry(
  request: Readonly<TerrainChunkGeometryRequest>,
): TerrainChunkGeometryResult {
  const started = performance.now();
  const tile = createTerrainTileId(
    request.tile.face,
    request.tile.depth,
    request.tile.x,
    request.tile.y,
  );
  const { u0, v0, size } = terrainTileUvBounds(tile);
  if (!Number.isInteger(request.resolution) || request.resolution < 2) {
    throw new RangeError(`Invalid terrain resolution ${request.resolution}`);
  }

  const res = request.resolution;
  const vertexCount = res * res + res * 4;
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const bodyDirection = new Float32Array(vertexCount * 3);
  const bodyFixedDetailAnchor = new Float32Array(vertexCount * 3);
  const centerDirection = terrainFaceToDirection(
    tile.face,
    u0 + size / 2,
    v0 + size / 2,
    new Vec3(),
  );
  const originHeight = request.radius + evaluateRecipeHeight(request.recipe, centerDirection);
  const origin: [number, number, number] = [
    centerDirection.x * originHeight,
    centerDirection.y * originHeight,
    centerDirection.z * originHeight,
  ];
  const detailOffset: TerrainColor = [
    periodicOffset(origin[0]),
    periodicOffset(origin[1]),
    periodicOffset(origin[2]),
  ];
  // Sample normals at a fraction of this tile's actual vertex spacing. A
  // world-scale UV floor (formerly 1e-5) spans a large portion of a depth-16
  // tile and smooths away the relief the vertex itself represents.
  const cellUvSize = size / Math.max(1, res - 1);
  // Normal sampling is a property of the canonical surface, not of the tile
  // currently representing it. Capping the stencil to a fixed metric span
  // prevents adjacent parent/child LODs from producing rectangular shading
  // bands while retaining the finer stencil of the deepest tiles.
  const metricNormalUv = 4 / Math.max(1, request.radius);
  const eps = Math.max(1e-9, Math.min(cellUvSize / 8, metricNormalUv));
  const point = new Vec3();
  const sampleU = new Vec3();
  const sampleV = new Vec3();
  let vertex = 0;
  let boundsRadius = 0;

  const writeVertex = (u: number, v: number, sink: number): void => {
    const direction = terrainFaceToDirection(tile.face, u, v, point);
    const rawHeight = evaluateRecipeHeight(request.recipe, direction);
    const surfaceRadius = request.radius + rawHeight;
    const radius = surfaceRadius - sink;
    const offset = vertex * 3;
    position[offset] = direction.x * radius - origin[0];
    position[offset + 1] = direction.y * radius - origin[1];
    position[offset + 2] = direction.z * radius - origin[2];
    bodyDirection[offset] = direction.x;
    bodyDirection[offset + 1] = direction.y;
    bodyDirection[offset + 2] = direction.z;
    bodyFixedDetailAnchor[offset] = position[offset] + detailOffset[0];
    bodyFixedDetailAnchor[offset + 1] = position[offset + 1] + detailOffset[1];
    bodyFixedDetailAnchor[offset + 2] = position[offset + 2] + detailOffset[2];

    terrainFaceToDirection(tile.face, u + eps, v, sampleU);
    sampleU.scale(request.radius + evaluateRecipeHeight(request.recipe, sampleU));
    terrainFaceToDirection(tile.face, u, v + eps, sampleV);
    sampleV.scale(request.radius + evaluateRecipeHeight(request.recipe, sampleV));
    const px = direction.x * surfaceRadius;
    const py = direction.y * surfaceRadius;
    const pz = direction.z * surfaceRadius;
    sampleU.set(sampleU.x - px, sampleU.y - py, sampleU.z - pz);
    sampleV.set(sampleV.x - px, sampleV.y - py, sampleV.z - pz);
    Vec3.cross(sampleU, sampleV, sampleU).normalize();
    if (Vec3.dot(sampleU, direction) < 0) sampleU.negate();
    normal[offset] = sampleU.x;
    normal[offset + 1] = sampleU.y;
    normal[offset + 2] = sampleU.z;

    const relativeHeight = Math.min(
      1,
      Math.max(0, rawHeight / (request.recipe.terrain.amplitude * 0.8) + 0.5),
    );
    const baseColor = request.recipe.terrain.oceanLevel > 0 && rawHeight < 0
      ? request.palette.ocean
      : relativeHeight < 0.5
        ? mix(request.palette.low, request.palette.mid, relativeHeight * 2)
        : mix(request.palette.mid, request.palette.high, (relativeHeight - 0.5) * 2);
    const slopeShade = 0.75 + 0.25 * Math.max(0, Vec3.dot(sampleU, direction));
    color[offset] = baseColor[0] * slopeShade;
    color[offset + 1] = baseColor[1] * slopeShade;
    color[offset + 2] = baseColor[2] * slopeShade;
    boundsRadius = Math.max(boundsRadius, Math.hypot(position[offset], position[offset + 1], position[offset + 2]));
    vertex++;
  };

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      writeVertex(
        u0 + size * i / (res - 1),
        v0 + size * j / (res - 1),
        0,
      );
    }
  }
  enforceLaunchPadMeshClearance(
    request,
    tile,
    origin,
    position,
    normal,
    bodyDirection,
    bodyFixedDetailAnchor,
  );
  const border: Array<readonly [number, number]> = [];
  for (let i = 0; i < res; i++) border.push([i, 0]);
  for (let i = 0; i < res; i++) border.push([i, res - 1]);
  for (let j = 0; j < res; j++) border.push([0, j]);
  for (let j = 0; j < res; j++) border.push([res - 1, j]);
  for (const [i, j] of border) {
    writeVertex(
      u0 + size * i / (res - 1),
      v0 + size * j / (res - 1),
      request.skirtDepth,
    );
  }

  const rawIndices = terrainGridIndices(res);
  const skirtBase = res * res;
  // All four edges are traversed in +u or +v order, so the winding that faces
  // outward on the v0/u1 edges faces inward on the v1/u0 edges; those two are
  // flipped so every skirt wall survives front-face culling.
  const addEdge = (grid: readonly number[], skirtOffset: number, flip: boolean): void => {
    for (let index = 0; index < grid.length - 1; index++) {
      const g0 = grid[index];
      const g1 = grid[index + 1];
      const s0 = skirtBase + skirtOffset + index;
      if (flip) rawIndices.push(g0, g1, s0, g1, s0 + 1, s0);
      else rawIndices.push(g0, s0, g1, g1, s0, s0 + 1);
    }
  };
  addEdge(Array.from({ length: res }, (_, i) => i), 0, false);
  addEdge(Array.from({ length: res }, (_, i) => (res - 1) * res + i), res, true);
  addEdge(Array.from({ length: res }, (_, j) => j * res), res * 2, true);
  addEdge(Array.from({ length: res }, (_, j) => j * res + res - 1), res * 3, false);
  const index = vertexCount <= 65_535 ? new Uint16Array(rawIndices) : new Uint32Array(rawIndices);

  // Clearance correction can only lower vertices, but recomputing here keeps
  // the bound exact and makes the invariant explicit for future changes.
  boundsRadius = 0;
  for (let index = 0; index < vertexCount; index++) {
    const offset = index * 3;
    boundsRadius = Math.max(boundsRadius, Math.hypot(
      position[offset], position[offset + 1], position[offset + 2],
    ));
  }

  return {
    jobKey: request.jobKey,
    generation: request.generation,
    tile,
    position,
    normal,
    color,
    bodyDirection,
    bodyFixedDetailAnchor,
    index,
    origin,
    bounds: { center: [0, 0, 0], radius: boundsRadius },
    buildMs: Math.max(0, performance.now() - started),
  };
}
