/** Versioned, content-addressed terrain recipes and their shared evaluator. */
import { fbm3, noise3, ridged3 } from '../core/noise';
import type { Vec3 } from '../core/vec3';
import type { Body, TerrainDef } from './universe';

export interface CraterFeature {
  readonly center: { readonly x: number; readonly y: number; readonly z: number };
  readonly angularRadius: number;
  readonly depth: number;
  readonly rimHeight: number;
}

export interface BodyFeatureRecipe {
  readonly bodyId: string;
  readonly version: number;
  readonly hash: string;
  readonly terrain: Readonly<TerrainDef>;
  readonly craters: readonly CraterFeature[];
}

const recipes = new WeakMap<Body, BodyFeatureRecipe>();
const MASK_64 = (1n << 64n) - 1n;

function fnv1a64(text: string, offset: bigint): string {
  let hash = offset;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

function recipeContent(body: Body, craters: readonly CraterFeature[]): string {
  const terrain = body.def.terrain;
  return JSON.stringify([
    body.id,
    body.def.terrainRecipeVersion,
    terrain.seed,
    terrain.amplitude,
    terrain.frequency,
    terrain.octaves,
    terrain.oceanLevel,
    terrain.colorLow,
    terrain.colorMid,
    terrain.colorHigh,
    terrain.colorOcean ?? null,
    craters,
  ]);
}

function contentHash(content: string): string {
  return (
    fnv1a64(content, 0xcbf29ce484222325n) +
    fnv1a64(content, 0x84222325cbf29ce4n)
  );
}

/** Immutable recipe assigned to a runtime body. */
export function recipeForBody(body: Body): BodyFeatureRecipe {
  const cached = recipes.get(body);
  if (cached) return cached;
  const craters: readonly CraterFeature[] = Object.freeze([]);
  const terrain = Object.freeze({ ...body.def.terrain });
  const recipe = Object.freeze({
    bodyId: body.id,
    version: body.def.terrainRecipeVersion,
    hash: contentHash(recipeContent(body, craters)),
    terrain,
    craters,
  });
  recipes.set(body, recipe);
  return recipe;
}

/** The only evaluator for collision-scale terrain height. */
export function evaluateRecipeHeight(
  recipe: BodyFeatureRecipe,
  direction: Readonly<Vec3>,
): number {
  const terrain = recipe.terrain;
  if (terrain.amplitude === 0) return 0;
  const frequency = terrain.frequency;
  const seed = terrain.seed;
  const continents = fbm3(
    direction.x * frequency,
    direction.y * frequency,
    direction.z * frequency,
    seed,
    Math.min(4, terrain.octaves),
  );
  const detailFrequency = frequency * 5;
  const ridges = ridged3(
    direction.x * detailFrequency,
    direction.y * detailFrequency,
    direction.z * detailFrequency,
    seed + 7,
    Math.max(2, terrain.octaves - 3),
  );
  const mask = Math.max(0, continents + 0.35);
  const roughFrequency = frequency * 40;
  const rough =
    noise3(
      direction.x * roughFrequency,
      direction.y * roughFrequency,
      direction.z * roughFrequency,
      seed + 31,
    ) * 0.02;
  let normalizedHeight = continents * 0.55 + ridges * mask * 0.6 + rough;
  if (terrain.oceanLevel > 0) {
    normalizedHeight -= (terrain.oceanLevel - 0.5) * 1.1;
  }
  let height = normalizedHeight * terrain.amplitude;

  for (const crater of recipe.craters) {
    const dot = Math.max(
      -1,
      Math.min(
        1,
        direction.x * crater.center.x +
          direction.y * crater.center.y +
          direction.z * crater.center.z,
      ),
    );
    const distance = Math.acos(dot);
    const normalizedDistance = distance / crater.angularRadius;
    if (normalizedDistance <= 1) {
      const bowl = 1 - normalizedDistance * normalizedDistance;
      height -= crater.depth * bowl * bowl;
    } else if (normalizedDistance < 1.2) {
      const rim = 1 - Math.abs(normalizedDistance - 1) / 0.2;
      height += crater.rimHeight * rim * rim;
    }
  }
  return height;
}
