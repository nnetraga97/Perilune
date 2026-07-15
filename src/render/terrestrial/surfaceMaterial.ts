import * as THREE from 'three';
import type { BodyMaterialDescriptor } from '../bodyMaterial';
import type { QualityTier, RuntimeBodyAssetPack } from '../bodyRenderer';
import {
  GLOBAL_ALBEDO_APPLY,
  GLOBAL_FRAGMENT_HEADER,
  GLOBAL_NORMAL_APPLY,
  GLOBAL_ROUGHNESS_APPLY,
  GLOBAL_VERTEX_BEGIN,
  GLOBAL_VERTEX_COMMON,
  bindTerrestrialAuthoredUniforms,
  createTerrestrialCloudLightingState,
  resolveTerrestrialAuthoredTextures,
} from './globalMaterial';

/** Body-fixed period over which local surface detail repeats exactly (meters). */
export const SURFACE_DETAIL_PERIOD_METERS = 8192;

/**
 * Regional-classification thresholds shared verbatim by the CPU classifier and
 * the injected GLSL, so ground tests and the shader can never disagree.
 */
export const SURFACE_THRESHOLDS = Object.freeze({
  slopeRockStart: 0.34,
  slopeRockFull: 0.72,
  slopeRockLinear: 0.2,
  highlandAltStart: 1400,
  highlandAltFull: 3200,
  coldLatStart: 0.55,
  coldLatFull: 0.95,
  moistVegStart: 0.25,
  moistVegFull: 0.75,
  shoreSandStart: 0.35,
  shoreSandFull: 0.85,
  aridSandAltFull: 900,
  soilBase: 0.35,
  soilGain: 0.6,
  rockDrive: 0.9,
  rockHighland: 0.85,
});

export interface TerrestrialSurfaceSample {
  /** Authored biome class 0..1 (arid → lush). */
  readonly biomeClass: number;
  /** Shore proximity 0..1. */
  readonly shore: number;
  /** Ocean fraction 0..1 (1 = open water; land classes cannot appear). */
  readonly ocean: number;
  /** Evaluator altitude above sea level in meters. */
  readonly altitude: number;
  /** Geometric slope 0 (flat) .. 1 (vertical). */
  readonly slope: number;
  /** Absolute latitude 0 (equator) .. 1 (pole). */
  readonly latitude: number;
  /** Deterministic moisture 0..1. */
  readonly moisture: number;
}

export interface TerrestrialSurfaceWeights {
  readonly soil: number;
  readonly rock: number;
  readonly sand: number;
  readonly vegetation: number;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** GLSL-compatible smoothstep so CPU classification matches the shader exactly. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Deterministic regional classification. Returns normalized soil/rock/sand/
 * vegetation weights (summing to one) from biome, shore, ocean, altitude, slope,
 * latitude, and moisture. Purely arithmetic and shared with the fragment shader.
 */
export function classifyTerrestrialSurface(sample: Readonly<TerrestrialSurfaceSample>): TerrestrialSurfaceWeights {
  const t = SURFACE_THRESHOLDS;
  const land = 1 - clamp01(sample.ocean);
  const biome = clamp01(sample.biomeClass);
  const aridity = 1 - biome;

  const slopeRock = smoothstep(t.slopeRockStart, t.slopeRockFull, sample.slope);
  const slopeDrive = slopeRock + t.slopeRockLinear * clamp01(sample.slope);
  const slopeSupp = clamp01(slopeDrive);
  const highland = smoothstep(t.highlandAltStart, t.highlandAltFull, sample.altitude);
  const cold = smoothstep(t.coldLatStart, t.coldLatFull, clamp01(sample.latitude));
  const moistVeg = smoothstep(t.moistVegStart, t.moistVegFull, clamp01(sample.moisture));
  const shoreSand = smoothstep(t.shoreSandStart, t.shoreSandFull, clamp01(sample.shore));
  const lowland = 1 - smoothstep(0, t.aridSandAltFull, sample.altitude);

  const vegetation = land * biome * moistVeg * (1 - slopeSupp) * (1 - highland) * (1 - cold);
  const sand = land * Math.max(shoreSand, aridity * lowland) * (1 - slopeSupp) * (1 - vegetation);
  const rock = slopeDrive * t.rockDrive + highland * (1 - slopeSupp) * t.rockHighland;
  const soil = t.soilBase + land * (1 - moistVeg) * (1 - slopeSupp) * (1 - highland) * t.soilGain;

  const total = soil + rock + sand + vegetation;
  return {
    soil: soil / total,
    rock: rock / total,
    sand: sand / total,
    vegetation: vegetation / total,
  };
}

/** Geometric-normal triplanar blend weights (sum to one). */
export function triplanarBlendWeights(nx: number, ny: number, nz: number): [number, number, number] {
  const ax = Math.abs(nx) ** 4;
  const ay = Math.abs(ny) ** 4;
  const az = Math.abs(nz) ** 4;
  const sum = ax + ay + az || 1;
  return [ax / sum, ay / sum, az / sum];
}

export interface SurfaceDetailTierParams {
  readonly maxOctave: number;
}

const SURFACE_DETAIL_TIERS: Record<QualityTier, SurfaceDetailTierParams> = {
  low: { maxOctave: 3 },
  medium: { maxOctave: 4 },
  high: { maxOctave: 5 },
};

export function surfaceDetailTier(tier: QualityTier): SurfaceDetailTierParams {
  return SURFACE_DETAIL_TIERS[tier];
}

/**
 * Fixed octave wavevectors (integer multiples of 1/period along each axis) and
 * phases. Integer components guarantee the field repeats exactly over the
 * body-fixed period on every axis independently, so it stays continuous across
 * chunk seams and floating-origin shifts. Later octaves carry higher spatial
 * frequency, so higher tiers add finer detail without changing the period.
 */
const DETAIL_WAVEVECTORS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 1],
  [2, 1, 0],
  [0, 2, 1],
  [2, 2, 1],
  [3, 1, 2],
];
const DETAIL_PHASES: readonly number[] = [0.0, 1.7, 3.4, 5.1, 2.2, 4.0, 0.9, 5.9];

export interface SurfaceDetailSample {
  readonly value: number;
  readonly gradient: [number, number, number];
}

/**
 * CPU twin of the shader detail field: a periodic multi-octave sum of sines in
 * body-fixed meters. `value` is bounded to [-1, 1]; `gradient` is the analytic
 * spatial derivative (per meter) used for shading-normal perturbation.
 */
export function sampleSurfaceDetail(x: number, y: number, z: number, tier: QualityTier): SurfaceDetailSample {
  const maxOctave = SURFACE_DETAIL_TIERS[tier].maxOctave;
  const twoPiOverPeriod = (Math.PI * 2) / SURFACE_DETAIL_PERIOD_METERS;
  let value = 0;
  let ampTotal = 0;
  let gx = 0;
  let gy = 0;
  let gz = 0;
  for (let octave = 0; octave <= maxOctave; octave++) {
    const k = DETAIL_WAVEVECTORS[octave % DETAIL_WAVEVECTORS.length];
    const phase = DETAIL_PHASES[octave % DETAIL_PHASES.length];
    const amp = 0.5 ** octave;
    const theta = twoPiOverPeriod * (x * k[0] + y * k[1] + z * k[2]) + phase;
    value += amp * Math.sin(theta);
    ampTotal += amp;
    const dcos = amp * Math.cos(theta) * twoPiOverPeriod;
    gx += dcos * k[0];
    gy += dcos * k[1];
    gz += dcos * k[2];
  }
  const inv = ampTotal === 0 ? 0 : 1 / ampTotal;
  return { value: value * inv, gradient: [gx * inv, gy * inv, gz * inv] };
}

/** Deterministic body-fixed moisture proxy in [0, 1] from a surface direction. */
export function deterministicMoisture(dx: number, dy: number, dz: number): number {
  const length = Math.hypot(dx, dy, dz) || 1;
  const nx = dx / length;
  const ny = dy / length;
  const nz = dz / length;
  const banded =
    Math.sin(nx * 6.283185307179586 + 0.5) * 0.5 +
    Math.sin(ny * 12.566370614359172 + 1.7) * 0.3 +
    Math.sin(nz * 9.42477796076938 + 3.1) * 0.2;
  return clamp01(0.5 + 0.5 * banded);
}

export interface TerrestrialSurfaceMaterial extends THREE.MeshStandardMaterial {
  readonly userData: {
    readonly terrestrialSurface: true;
    readonly bodyId: string;
    readonly authored: boolean;
    readonly tier: QualityTier;
  } & Record<string, unknown>;
}

const T = SURFACE_THRESHOLDS;

/** GLSL classification + detail, generated from the shared numeric thresholds. */
const SURFACE_FRAGMENT_FUNCTIONS = /* glsl */ `
uniform float surfaceDetailMaxOctave;
varying vec3 vDetailAnchor;
varying float vSurfaceAltitude;
varying vec3 vBodyFixedNormal;

struct SurfaceWeights { float soil; float rock; float sand; float vegetation; };

SurfaceWeights classifyTerrestrialSurface(
  float biomeClass, float shore, float ocean, float altitude,
  float slope, float latitude, float moisture
) {
  float land = 1.0 - clamp(ocean, 0.0, 1.0);
  float biome = clamp(biomeClass, 0.0, 1.0);
  float aridity = 1.0 - biome;
  float slopeRock = smoothstep(${T.slopeRockStart.toFixed(4)}, ${T.slopeRockFull.toFixed(4)}, slope);
  float slopeDrive = slopeRock + ${T.slopeRockLinear.toFixed(4)} * clamp(slope, 0.0, 1.0);
  float slopeSupp = clamp(slopeDrive, 0.0, 1.0);
  float highland = smoothstep(${T.highlandAltStart.toFixed(1)}, ${T.highlandAltFull.toFixed(1)}, altitude);
  float cold = smoothstep(${T.coldLatStart.toFixed(4)}, ${T.coldLatFull.toFixed(4)}, clamp(latitude, 0.0, 1.0));
  float moistVeg = smoothstep(${T.moistVegStart.toFixed(4)}, ${T.moistVegFull.toFixed(4)}, clamp(moisture, 0.0, 1.0));
  float shoreSand = smoothstep(${T.shoreSandStart.toFixed(4)}, ${T.shoreSandFull.toFixed(4)}, clamp(shore, 0.0, 1.0));
  float lowland = 1.0 - smoothstep(0.0, ${T.aridSandAltFull.toFixed(1)}, altitude);
  float vegetation = land * biome * moistVeg * (1.0 - slopeSupp) * (1.0 - highland) * (1.0 - cold);
  float sand = land * max(shoreSand, aridity * lowland) * (1.0 - slopeSupp) * (1.0 - vegetation);
  float rock = slopeDrive * ${T.rockDrive.toFixed(4)} + highland * (1.0 - slopeSupp) * ${T.rockHighland.toFixed(4)};
  float soil = ${T.soilBase.toFixed(4)} + land * (1.0 - moistVeg) * (1.0 - slopeSupp) * (1.0 - highland) * ${T.soilGain.toFixed(4)};
  float total = soil + rock + sand + vegetation;
  SurfaceWeights w;
  w.soil = soil / total;
  w.rock = rock / total;
  w.sand = sand / total;
  w.vegetation = vegetation / total;
  return w;
}

vec3 triplanarBlendWeights(vec3 n) {
  vec3 a = pow(abs(n), vec3(4.0));
  float s = a.x + a.y + a.z;
  return s > 0.0 ? a / s : vec3(0.3333333);
}

// GLSL ES 1.00 forbids const-array constructors and dynamic array indexing, so
// the octave wavevectors and phases are returned by branch selection instead.
vec3 surfaceDetailWavevector(int octave) {
  if (octave == 0) return vec3(1.0, 0.0, 0.0);
  if (octave == 1) return vec3(0.0, 1.0, 0.0);
  if (octave == 2) return vec3(0.0, 0.0, 1.0);
  if (octave == 3) return vec3(1.0, 1.0, 1.0);
  if (octave == 4) return vec3(2.0, 1.0, 0.0);
  if (octave == 5) return vec3(0.0, 2.0, 1.0);
  if (octave == 6) return vec3(2.0, 2.0, 1.0);
  return vec3(3.0, 1.0, 2.0);
}

float surfaceDetailPhase(int octave) {
  if (octave == 0) return 0.0;
  if (octave == 1) return 1.7;
  if (octave == 2) return 3.4;
  if (octave == 3) return 5.1;
  if (octave == 4) return 2.2;
  if (octave == 5) return 4.0;
  if (octave == 6) return 0.9;
  return 5.9;
}

void surfaceDetail(vec3 anchor, float maxOctave, out float value, out vec3 gradient) {
  float twoPiOverPeriod = 6.283185307179586 / ${SURFACE_DETAIL_PERIOD_METERS.toFixed(1)};
  value = 0.0;
  gradient = vec3(0.0);
  float ampTotal = 0.0;
  for (int octave = 0; octave <= 7; octave++) {
    if (float(octave) > maxOctave) break;
    vec3 k = surfaceDetailWavevector(octave);
    float phase = surfaceDetailPhase(octave);
    float amp = pow(0.5, float(octave));
    float theta = twoPiOverPeriod * dot(anchor, k) + phase;
    value += amp * sin(theta);
    ampTotal += amp;
    gradient += amp * cos(theta) * twoPiOverPeriod * k;
  }
  float inv = ampTotal > 0.0 ? 1.0 / ampTotal : 0.0;
  value *= inv;
  gradient *= inv;
}

float triplanarSurfaceDetail(vec3 anchor, vec3 bodyNormal, float maxOctave, out vec3 gradient) {
  float value;
  surfaceDetail(anchor, maxOctave, value, gradient);
  // Triplanar weighting keeps detail anchored to geometric axes on steep faces.
  vec3 w = triplanarBlendWeights(bodyNormal);
  gradient *= (w.x + w.y + w.z);
  return value;
}

float deterministicMoisture(vec3 rawDir) {
  vec3 n = normalize(rawDir);
  float banded =
    sin(n.x * 6.283185307179586 + 0.5) * 0.5 +
    sin(n.y * 12.566370614359172 + 1.7) * 0.3 +
    sin(n.z * 9.42477796076938 + 3.1) * 0.2;
  return clamp(0.5 + 0.5 * banded, 0.0, 1.0);
}
`;

const SURFACE_ALBEDO_APPLY = /* glsl */ `
vec3 surfBodyNormal = normalize(vBodyFixedNormal);
float surfSlope = 1.0 - clamp(dot(surfBodyNormal, normalize(vBodyDirection)), 0.0, 1.0);
float surfLatitude = asin(clamp(abs(normalize(vBodyDirection).z), 0.0, 1.0)) * 0.6366197723675814;
float surfBiome = mix(0.5, authoredMaterial.b, step(0.5, useAuthoredGlobalMaps));
float surfShore = useAuthoredGlobalMaps > 0.5 ? (1.0 - abs(authoredMaterial.a * 2.0 - 1.0)) : 0.0;
float surfOcean = useAuthoredGlobalMaps > 0.5 ? step(authoredMaterial.a, 0.5) : 0.0;
float surfMoisture = deterministicMoisture(vBodyDirection);
SurfaceWeights surfWeights = classifyTerrestrialSurface(
  surfBiome, surfShore, surfOcean, vSurfaceAltitude, surfSlope, surfLatitude, surfMoisture);
vec3 surfDetailGradient;
float surfDetail = triplanarSurfaceDetail(vDetailAnchor, surfBodyNormal, surfaceDetailMaxOctave, surfDetailGradient);
vec3 surfTint = surfWeights.soil * vec3(1.0, 0.98, 0.95)
  + surfWeights.rock * vec3(0.86, 0.84, 0.82)
  + surfWeights.sand * vec3(1.12, 1.06, 0.92)
  + surfWeights.vegetation * vec3(0.9, 1.02, 0.86);
diffuseColor.rgb *= surfTint;
diffuseColor.rgb *= 1.0 + surfDetail * mix(0.04, 0.14, surfWeights.rock);
`;

const SURFACE_ROUGHNESS_APPLY = /* glsl */ `
float surfClassRough = surfWeights.soil * 0.9 + surfWeights.rock * 1.0
  + surfWeights.sand * 0.8 + surfWeights.vegetation * 0.85;
roughnessFactor = clamp(roughnessFactor * surfClassRough + surfDetail * 0.05 * surfWeights.rock, 0.05, 1.0);
`;

const SURFACE_NORMAL_APPLY = /* glsl */ `
vec3 surfMacroNormal = normalize(mix(surfBodyNormal, globalBodyNormal, 0.68 * useAuthoredGlobalMaps));
vec3 surfTangentGradient = surfDetailGradient - surfMacroNormal * dot(surfDetailGradient, surfMacroNormal);
float surfBump = mix(80.0, 240.0, surfWeights.rock);
vec3 surfPerturbed = normalize(surfMacroNormal - surfTangentGradient * surfBump);
normal = normalize(normalMatrix * surfPerturbed);
`;

/**
 * Near-ground terrestrial material: reuses the authored orbit-to-ground identity
 * program, then adds body-fixed regional classification and periodic triplanar
 * detail that perturb only albedo, roughness, and the shading normal. Vertex
 * positions and collision height are never touched.
 */
export function createTerrestrialSurfaceMaterial(
  pack: Readonly<RuntimeBodyAssetPack> | null,
  descriptor: Readonly<BodyMaterialDescriptor>,
  tier: QualityTier,
  maxAnisotropy = 1,
): TerrestrialSurfaceMaterial {
  const textures = resolveTerrestrialAuthoredTextures(pack, descriptor.bodyId, maxAnisotropy);
  const cloudLighting = createTerrestrialCloudLightingState();
  const maxOctave = SURFACE_DETAIL_TIERS[tier].maxOctave;

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: pack === null,
    roughness: 1,
    metalness: 0,
  }) as TerrestrialSurfaceMaterial;
  Object.assign(material.userData, {
    terrestrialSurface: true,
    bodyId: descriptor.bodyId,
    authored: pack !== null,
    tier,
    terrestrialCloudLighting: cloudLighting,
  });
  material.customProgramCacheKey = () => `terrestrial-surface-v2:${pack ? 'authored' : 'palette'}:${tier}`;
  material.onBeforeCompile = (shader) => {
    bindTerrestrialAuthoredUniforms(shader, textures, cloudLighting);
    shader.uniforms.surfaceDetailMaxOctave = { value: maxOctave };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${GLOBAL_VERTEX_COMMON}\n`
          + 'attribute vec3 bodyFixedDetailAnchor;\nvarying vec3 vDetailAnchor;\n'
          + 'attribute float surfaceAltitude;\nvarying float vSurfaceAltitude;\n'
          + 'varying vec3 vBodyFixedNormal;',
      )
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nvBodyFixedNormal = normalize(objectNormal);',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${GLOBAL_VERTEX_BEGIN}\n`
          + 'vDetailAnchor = bodyFixedDetailAnchor;\nvSurfaceAltitude = surfaceAltitude;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLOBAL_FRAGMENT_HEADER}\n${SURFACE_FRAGMENT_FUNCTIONS}`)
      .replace('#include <map_fragment>', `${GLOBAL_ALBEDO_APPLY}\n${SURFACE_ALBEDO_APPLY}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>${GLOBAL_ROUGHNESS_APPLY}\n${SURFACE_ROUGHNESS_APPLY}`,
      )
      .replace('#include <normal_fragment_maps>', `${GLOBAL_NORMAL_APPLY}\n${SURFACE_NORMAL_APPLY}`);
  };

  let released = false;
  material.addEventListener('dispose', () => {
    if (released) return;
    released = true;
    for (const texture of textures.owned) texture.dispose();
  });
  return material;
}
