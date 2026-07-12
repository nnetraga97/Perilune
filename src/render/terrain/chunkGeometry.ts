import { Vec3 } from '../../core/vec3';
import { evaluateRecipeHeight, type BodyFeatureRecipe } from '../../sim/terrainRecipe';

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
  readonly recipe: BodyFeatureRecipe;
  readonly radius: number;
  readonly face: number;
  readonly u0: number;
  readonly v0: number;
  readonly size: number;
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

interface FaceBasis {
  readonly n: readonly [number, number, number];
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
}

const FACES: readonly FaceBasis[] = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
  { n: [0, -1, 0], u: [0, 0, -1], v: [1, 0, 0] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

const DETAIL_PERIOD_METERS = 8192;

export function terrainFaceToDirection(faceIndex: number, u: number, v: number, out = new Vec3()): Vec3 {
  const face = FACES[faceIndex];
  if (!face) throw new RangeError(`Invalid cube face ${faceIndex}`);
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
  const face = FACES[request.face];
  if (!face) throw new RangeError(`Invalid cube face ${request.face}`);
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
    request.face,
    request.u0 + request.size / 2,
    request.v0 + request.size / 2,
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
  const eps = Math.max(1e-5, request.size / (res * 8));
  const point = new Vec3();
  const sampleU = new Vec3();
  const sampleV = new Vec3();
  let vertex = 0;
  let boundsRadius = 0;

  const writeVertex = (u: number, v: number, sink: number): void => {
    const direction = terrainFaceToDirection(request.face, u, v, point);
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

    terrainFaceToDirection(request.face, u + eps, v, sampleU);
    sampleU.scale(request.radius + evaluateRecipeHeight(request.recipe, sampleU));
    terrainFaceToDirection(request.face, u, v + eps, sampleV);
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
        request.u0 + request.size * i / (res - 1),
        request.v0 + request.size * j / (res - 1),
        0,
      );
    }
  }
  const border: Array<readonly [number, number]> = [];
  for (let i = 0; i < res; i++) border.push([i, 0]);
  for (let i = 0; i < res; i++) border.push([i, res - 1]);
  for (let j = 0; j < res; j++) border.push([0, j]);
  for (let j = 0; j < res; j++) border.push([res - 1, j]);
  for (const [i, j] of border) {
    writeVertex(
      request.u0 + request.size * i / (res - 1),
      request.v0 + request.size * j / (res - 1),
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

  return {
    jobKey: request.jobKey,
    generation: request.generation,
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
