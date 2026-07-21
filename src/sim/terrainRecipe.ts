/** Versioned, content-addressed terrain recipes and their shared evaluator. */
import {
  fbm3,
  noise3,
  ridged3,
  NOISE3_GRADIENT_BOUND,
  NOISE3_VALUE_BOUND,
} from '../core/noise';
import type { Body, TerrainDef } from './universe';
import {
  LAUNCH_PAD_TERRAIN_BLEND_RADIUS,
  LAUNCH_PAD_TERRAIN_FLAT_RADIUS,
  LAUNCH_SITE_LAT,
  LAUNCH_SITE_LON,
  LAUNCH_SITE_MINIMUM_GROUND_HEIGHT,
} from './launchSite';
import {
  CHECKED_HEIGHT_AUTHORITY_VERSION,
  sampleCanonicalLocalRelief,
  samplePromotedHeightRegion,
  sampleSourceMacroHeight,
  sourceHeightGrid,
  type FrozenSourceHeightRegion,
} from './sourceHeightAuthority';
import {
  planetDataAuthorityForBody,
  type FrozenPlanetDataAuthority,
} from './planetDataAuthority';

export interface CraterFeature {
  readonly center: { readonly x: number; readonly y: number; readonly z: number };
  readonly angularRadius: number;
  readonly depth: number;
  readonly rimHeight: number;
}

export interface BodyFeatureRecipe {
  readonly bodyId: string;
  readonly radiusMeters: number;
  readonly version: number;
  readonly hash: string;
  readonly authorityGeneration: string;
  readonly terrainGeneration: number;
  readonly sourceHeightRegion?: FrozenSourceHeightRegion;
  readonly terrain: Readonly<TerrainDef>;
  readonly craters: readonly CraterFeature[];
}

export interface TerrainRecipeBounds {
  readonly minimumHeightMeters: number;
  readonly maximumHeightMeters: number;
  /** Conservative height change per radian along the unit sphere. */
  readonly maximumAngularSlopeMeters: number;
}

const recipes = new WeakMap<Body, Map<string, BodyFeatureRecipe>>();
const MASK_64 = (1n << 64n) - 1n;
const LAUNCH_SITE = Object.freeze({
  x: Math.cos(LAUNCH_SITE_LAT) * Math.cos(LAUNCH_SITE_LON),
  y: Math.cos(LAUNCH_SITE_LAT) * Math.sin(LAUNCH_SITE_LON),
  z: Math.sin(LAUNCH_SITE_LAT),
});
const launchSiteHeight = new Map<string, number>();

function fnv1a64(text: string, offset: bigint): string {
  let hash = offset;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

function recipeContent(
  body: Body,
  craters: readonly CraterFeature[],
  authority: Readonly<FrozenPlanetDataAuthority>,
): string {
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
    ...(body.id === 'earth' || body.id === 'moon'
      ? [CHECKED_HEIGHT_AUTHORITY_VERSION, authority.generation, authority.region?.digest ?? null]
      : []),
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
export function recipeForBody(
  body: Body,
  authority: Readonly<FrozenPlanetDataAuthority> = planetDataAuthorityForBody(body),
): BodyFeatureRecipe {
  if (authority.bodyId !== body.id) throw new Error(`Terrain authority body mismatch for ${body.id}`);
  let byGeneration = recipes.get(body);
  if (!byGeneration) {
    byGeneration = new Map();
    recipes.set(body, byGeneration);
  }
  const cached = byGeneration.get(authority.generation);
  if (cached) return cached;
  const craters: readonly CraterFeature[] = Object.freeze([]);
  const terrain = Object.freeze({ ...body.def.terrain });
  const recipe = Object.freeze({
    bodyId: body.id,
    radiusMeters: body.radius,
    version: body.def.terrainRecipeVersion,
    hash: contentHash(recipeContent(body, craters, authority)),
    authorityGeneration: authority.generation,
    terrainGeneration: authority.terrainGeneration,
    ...(authority.region ? { sourceHeightRegion: authority.region } : {}),
    terrain,
    craters,
  });
  byGeneration.set(authority.generation, recipe);
  return recipe;
}

function normalizedFrequencyMoment(
  octaves: number,
  lacunarity: number,
  gain: number,
): number {
  let amplitude = 1;
  let frequency = 1;
  let weighted = 0;
  let normalization = 0;
  for (let octave = 0; octave < octaves; octave++) {
    weighted += amplitude * frequency;
    normalization += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return weighted / normalization;
}

/** Conservative finite bounds for the exact evaluator below. */
export function terrainRecipeBounds(recipe: Readonly<BodyFeatureRecipe>): TerrainRecipeBounds {
  const terrain = recipe.terrain;
  if (!Number.isFinite(terrain.amplitude) || terrain.amplitude < 0) {
    throw new Error(`Invalid terrain amplitude ${terrain.amplitude}`);
  }
  if (!Number.isFinite(terrain.frequency) || terrain.frequency < 0) {
    throw new Error(`Invalid terrain frequency ${terrain.frequency}`);
  }
  if (!Number.isInteger(terrain.octaves) || terrain.octaves < 1) {
    throw new Error(`Invalid terrain octaves ${terrain.octaves}`);
  }
  if (!Number.isFinite(terrain.oceanLevel)) {
    throw new Error(`Invalid terrain ocean level ${terrain.oceanLevel}`);
  }
  const sourceGrid = sourceHeightGrid(recipe.bodyId);
  if (sourceGrid) {
    const localReliefBound = recipe.bodyId === 'earth' ? 80 : 150;
    const region = recipe.sourceHeightRegion;
    const regionCellRadians = region
      ? Math.max(
        Math.abs(region.coverage[2] - region.coverage[0]) * Math.PI / 180 / Math.max(1, region.width - 1),
        Math.abs(region.coverage[3] - region.coverage[1]) * Math.PI / 180 / Math.max(1, region.height - 1),
      )
      : Number.POSITIVE_INFINITY;
    const regionSlope = region
      ? (region.maximumHeightMeters - region.minimumHeightMeters) / Math.max(1e-12, regionCellRadians)
      : 0;
    return Object.freeze({
      minimumHeightMeters: Math.min(
        sourceGrid.minimumHeightMeters - localReliefBound,
        region?.minimumHeightMeters ?? Number.POSITIVE_INFINITY,
      ),
      maximumHeightMeters: Math.max(
        sourceGrid.maximumHeightMeters + localReliefBound,
        region?.maximumHeightMeters ?? Number.NEGATIVE_INFINITY,
      ),
      // Bilinear source slopes are conservatively bounded by the complete
      // source range per grid cell plus the local relief bands.
      maximumAngularSlopeMeters:
        (sourceGrid.maximumHeightMeters - sourceGrid.minimumHeightMeters) * sourceGrid.width
        + localReliefBound * recipe.radiusMeters / 125
        + regionSlope,
    });
  }
  // The evaluator returns before ocean/crater work for a flat recipe.
  if (terrain.amplitude === 0) {
    return Object.freeze({
      minimumHeightMeters: 0,
      maximumHeightMeters: 0,
      maximumAngularSlopeMeters: 0,
    });
  }

  const continentOctaves = Math.min(4, terrain.octaves);
  const ridgeOctaves = Math.max(2, terrain.octaves - 3);
  const continentSlope = NOISE3_GRADIENT_BOUND * terrain.frequency
    * normalizedFrequencyMoment(continentOctaves, 2, 0.5);
  const ridgeInputFrequency = terrain.frequency * 5;
  const ridgeValueBound = (1 + NOISE3_VALUE_BOUND) ** 2;
  const ridgeDerivativeFactor = 2 * (1 + NOISE3_VALUE_BOUND);
  const ridgeSlope = ridgeDerivativeFactor * NOISE3_GRADIENT_BOUND * ridgeInputFrequency
    * normalizedFrequencyMoment(ridgeOctaves, 2.1, 0.5);
  const maskBound = NOISE3_VALUE_BOUND + 0.35;
  const roughSlope = NOISE3_GRADIENT_BOUND * terrain.frequency * 40;
  const oceanShift = terrain.oceanLevel > 0
    ? Math.abs((terrain.oceanLevel - 0.5) * 1.1)
    : 0;
  const normalizedHeightBound =
    NOISE3_VALUE_BOUND * 0.55
    + ridgeValueBound * maskBound * 0.6
    + NOISE3_VALUE_BOUND * 0.02
    + oceanShift;
  let maximumAbsoluteHeight = normalizedHeightBound * terrain.amplitude;
  let maximumAngularSlope = (
    continentSlope * 0.55
    + (ridgeSlope * maskBound + ridgeValueBound * continentSlope) * 0.6
    + roughSlope * 0.02
  ) * terrain.amplitude;

  for (const crater of recipe.craters) {
    if (
      !Number.isFinite(crater.angularRadius) || crater.angularRadius <= 0
      || !Number.isFinite(crater.depth) || !Number.isFinite(crater.rimHeight)
      || !Number.isFinite(crater.center.x)
      || !Number.isFinite(crater.center.y)
      || !Number.isFinite(crater.center.z)
    ) {
      throw new Error('Invalid crater metadata in terrain recipe');
    }
    maximumAbsoluteHeight += Math.abs(crater.depth) + Math.abs(crater.rimHeight);
    maximumAngularSlope += (
      4 * Math.abs(crater.depth) + 10 * Math.abs(crater.rimHeight)
    ) / crater.angularRadius;
  }

  if (!Number.isFinite(maximumAbsoluteHeight) || !Number.isFinite(maximumAngularSlope)) {
    throw new Error('Terrain recipe bounds are not finite');
  }
  return Object.freeze({
    minimumHeightMeters: -maximumAbsoluteHeight,
    maximumHeightMeters: maximumAbsoluteHeight,
    maximumAngularSlopeMeters: maximumAngularSlope,
  });
}

/** The only evaluator for collision-scale terrain height. */
export function evaluateRecipeHeight(
  recipe: BodyFeatureRecipe,
  direction: Readonly<{ x: number; y: number; z: number }>,
): number {
  const naturalHeight = evaluateNaturalRecipeHeight(recipe, direction);
  if (recipe.bodyId !== 'veyra' && recipe.bodyId !== 'earth') return naturalHeight;

  // The launch site is authored into the same immutable terrain recipe consumed
  // by physics, workers, and baked assets. A flat center plus a wide smooth
  // grade ensures nearby LOD vertices cannot bridge a steep hillside over the
  // small physical deck footprint.
  const dot = Math.max(-1, Math.min(1,
    direction.x * LAUNCH_SITE.x + direction.y * LAUNCH_SITE.y + direction.z * LAUNCH_SITE.z,
  ));
  const distanceMeters = Math.acos(dot) * recipe.radiusMeters;
  if (distanceMeters >= LAUNCH_PAD_TERRAIN_BLEND_RADIUS) return naturalHeight;
  let plateauHeight = launchSiteHeight.get(recipe.hash);
  if (plateauHeight === undefined) {
    const sourceHeight = evaluateNaturalRecipeHeight(recipe, LAUNCH_SITE);
    plateauHeight = recipe.bodyId === 'earth'
      ? Math.max(LAUNCH_SITE_MINIMUM_GROUND_HEIGHT, sourceHeight)
      : sourceHeight;
    launchSiteHeight.set(recipe.hash, plateauHeight);
  }
  if (distanceMeters <= LAUNCH_PAD_TERRAIN_FLAT_RADIUS) return plateauHeight;
  const t = (distanceMeters - LAUNCH_PAD_TERRAIN_FLAT_RADIUS)
    / (LAUNCH_PAD_TERRAIN_BLEND_RADIUS - LAUNCH_PAD_TERRAIN_FLAT_RADIUS);
  const smooth = t * t * (3 - 2 * t);
  return plateauHeight + (naturalHeight - plateauHeight) * smooth;
}

function evaluateNaturalRecipeHeight(
  recipe: BodyFeatureRecipe,
  direction: Readonly<{ x: number; y: number; z: number }>,
): number {
  const sourceHeight = sampleSourceMacroHeight(recipe.bodyId, direction);
  if (sourceHeight !== null) {
    const parentHeight = sourceHeight + sampleCanonicalLocalRelief(
      recipe.bodyId,
      recipe.radiusMeters,
      direction,
    );
    const promoted = recipe.sourceHeightRegion
      ? samplePromotedHeightRegion(recipe.sourceHeightRegion, direction)
      : null;
    return promoted
      ? parentHeight + (promoted.heightMeters - parentHeight) * promoted.sourceWeight
      : parentHeight;
  }
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
