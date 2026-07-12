/**
 * Deterministic canonical physical-scatter compiler for Veyra.
 *
 * Reads only the canonical quantized height buffer (integer int16 texels) and a
 * documented integer PRNG; it never samples lossy, transcoded, filtered, or
 * GPU-resident textures. Output is byte-stable across platforms because every
 * decision is made from integer height texels and integer PRNG draws.
 */
import { Vec3 } from '../../src/core/vec3';
import { terrainFaceToDirection } from '../../src/render/terrain/chunkGeometry';
import {
  buildScatterRecipe,
  mulberry32,
  proxyKindFromIndex,
  scatterCellSeed,
  scatterRecordId,
  SCATTER_CELL_QUANTUM,
  SCATTER_CELL_RESOLUTION,
  SCATTER_SIZE_QUANTUM_METERS,
  type PhysicalScatterRecipe,
  type PhysicalScatterRecord,
  type ScatterCell,
} from '../../src/sim/scatterRecipe';

const TAU = Math.PI * 2;
const QUANT_METERS = 0.5; // canonical height quantization step

export interface CanonicalHeightField {
  readonly width: number;
  readonly height: number;
  readonly texels: Int16Array;
}

/** Nearest-texel canonical height (meters) for a body-fixed direction. */
function heightMetersAt(field: CanonicalHeightField, direction: Readonly<Vec3>): number {
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const nx = direction.x / length;
  const ny = direction.y / length;
  const nz = Math.max(-1, Math.min(1, direction.z / length));
  const u = (Math.atan2(ny, nx) + Math.PI) / TAU;
  const v = 0.5 - Math.asin(nz) / Math.PI;
  let px = Math.floor(u * field.width);
  px = ((px % field.width) + field.width) % field.width;
  let py = Math.floor(v * field.height);
  py = py < 0 ? 0 : py >= field.height ? field.height - 1 : py;
  return field.texels[py * field.width + px] * QUANT_METERS;
}

/** Integer biome class from canonical height: 1 lowland, 2 mid, 3 highland. Ocean returns 0. */
function biomeClassFromHeight(heightMeters: number): number {
  if (heightMeters < 0) return 0;
  if (heightMeters > 2500) return 3;
  if (heightMeters > 300) return 2;
  return 1;
}

/** Local slope proxy (0 flat .. ~1 steep) from neighbor height texels. */
function slopeAt(field: CanonicalHeightField, radius: number, direction: Readonly<Vec3>): number {
  const base = heightMetersAt(field, direction);
  const step = TAU / field.width; // one-texel angular step
  const tangentA = new Vec3(-direction.y, direction.x, 0);
  if (tangentA.lengthSq() < 1e-9) tangentA.set(1, 0, 0);
  tangentA.normalize();
  const tangentB = Vec3.cross(direction, tangentA, new Vec3()).normalize();
  const arc = radius * step;
  let maxDelta = 0;
  for (const tangent of [tangentA, tangentB]) {
    const probe = new Vec3(
      direction.x + tangent.x * step,
      direction.y + tangent.y * step,
      direction.z + tangent.z * step,
    ).normalize();
    maxDelta = Math.max(maxDelta, Math.abs(heightMetersAt(field, probe) - base));
  }
  return Math.min(1, maxDelta / Math.max(1, arc));
}

export interface VeyraScatterOptions {
  readonly bodyId: string;
  readonly terrainRecipeHash: string;
  readonly radius: number;
  readonly height: CanonicalHeightField;
}

/** Compile the canonical Veyra physical-scatter recipe. */
export function generateVeyraScatter(options: VeyraScatterOptions): PhysicalScatterRecipe {
  const { bodyId, terrainRecipeHash, radius, height } = options;
  const resolution = SCATTER_CELL_RESOLUTION;
  const cells: ScatterCell[] = [];
  const direction = new Vec3();
  for (let face = 0; face < 6; face++) {
    for (let cy = 0; cy < resolution; cy++) {
      for (let cx = 0; cx < resolution; cx++) {
        const cellId = { face, cx, cy };
        const seed = scatterCellSeed(bodyId, terrainRecipeHash, cellId);
        const random = mulberry32(seed);
        // Sparse physical layer: most cells hold no collidable obstacle; a small
        // fraction hold one or two large boulders, trees, cliffs, or landmarks.
        const spawnRoll = random() % 1000;
        const candidateCount = spawnRoll < 120 ? 1 : spawnRoll < 165 ? 2 : 0;
        const records: PhysicalScatterRecord[] = [];
        for (let index = 0; index < candidateCount; index++) {
          const qu = random() % SCATTER_CELL_QUANTUM;
          const qv = random() % SCATTER_CELL_QUANTUM;
          const u = -1 + ((cx + (qu + 0.5) / SCATTER_CELL_QUANTUM) * 2) / resolution;
          const v = -1 + ((cy + (qv + 0.5) / SCATTER_CELL_QUANTUM) * 2) / resolution;
          terrainFaceToDirection(face, u, v, direction);
          const heightMeters = heightMetersAt(height, direction);
          const biome = biomeClassFromHeight(heightMeters);
          if (biome === 0) continue; // never place obstacles in the ocean
          const slope = slopeAt(height, radius, direction);
          const kindRoll = random() % 100;
          const visual = biome === 3
            ? 0 // highland boulders
            : slope > 0.5
              ? 0 // steep rock outcrops
              : kindRoll < 55 ? 1 : kindRoll < 85 ? 2 : 3; // boulder / tree / landmark
          const proxy = proxyKindFromIndex(visual === 2 ? 1 : visual === 3 ? 2 : 0);
          const sizeRoll = random() % 1000;
          const radiusMeters = visual === 3
            ? 14 + (sizeRoll / 1000) * 26 // landmarks: 14-40 m
            : visual === 2
              ? 1.5 + (sizeRoll / 1000) * 2.5 // trees: 1.5-4 m
              : 2 + (sizeRoll / 1000) * 6; // boulders/rock: 2-8 m
          const heightRatio = visual === 2 ? 3.2 : visual === 3 ? 2.0 : 0.9;
          const qRadius = Math.max(1, Math.round(radiusMeters / SCATTER_SIZE_QUANTUM_METERS));
          const qHeight = Math.max(1, Math.round((radiusMeters * heightRatio) / SCATTER_SIZE_QUANTUM_METERS));
          records.push({
            id: scatterRecordId(bodyId, terrainRecipeHash, cellId, index),
            qu,
            qv,
            qRadius,
            qHeight,
            proxy,
            biome,
            visual,
          });
        }
        if (records.length === 0) continue;
        records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        cells.push({ face, cx, cy, seed, records });
      }
    }
  }
  return buildScatterRecipe({ bodyId, terrainRecipeHash, cells });
}
