import * as THREE from 'three';
import type { BodyMaterialDescriptor } from '../bodyMaterial';
import type { RuntimeBodyAssetPack } from '../bodyRenderer';
import { BODY_FIXED_UV_GLSL } from './globalCoordinates';
import {
  attachTerrestrialAerialPerspective,
  bindTerrestrialAerialPerspectiveUniforms,
  createTerrestrialAerialPerspectiveState,
  TERRESTRIAL_AERIAL_FRAGMENT_GLSL,
} from './aerialPerspective';
import {
  SURFACE_CLASS_GLSL,
  bindSurfaceClassUniforms,
  resolveSurfaceClassTextures,
  type SurfaceClassTextureSet,
} from './surfaceClass';
import {
  PLANET_DETAIL_GLSL,
  bindPlanetDetailUniforms,
  createPlanetDetailMaterialState,
} from '../planetDetail/detailMaterial';

export interface TerrestrialGlobalMaterial extends THREE.MeshStandardMaterial {
  readonly userData: {
    readonly terrestrialGlobal: true;
    readonly bodyId: string;
    readonly authored: boolean;
    readonly maps: Readonly<{
      albedo: THREE.Texture;
      normal: THREE.Texture;
      material: THREE.Texture;
      clouds: THREE.Texture;
      emissive: THREE.Texture;
      heightMacro: THREE.Texture;
      surfaceClass: THREE.Texture;
      surfaceClassRegional: THREE.Texture;
    }>;
  } & Record<string, unknown>;
}

/**
 * Shared authored-map GLSL. The compact global material and the near-ground
 * surface material sample identical authored channels through these snippets so
 * orbit-to-ground identity can never drift between the two programs.
 */
export const GLOBAL_VERTEX_COMMON = 'attribute vec3 bodyDirection;\nvarying vec3 vBodyDirection;\nvarying float vGlobalSurfaceAltitude;';
export const GLOBAL_VERTEX_BEGIN = 'vBodyDirection = bodyDirection;\nvGlobalSurfaceAltitude = 0.0;';
const GLOBAL_COMPACT_HEIGHT_VERTEX = /* glsl */ `
vBodyDirection = bodyDirection;
if (useGlobalHeightMap > 0.5) {
  vec3 globalHeightDirection = normalize(bodyDirection);
  float globalHeightU = fract(atan(globalHeightDirection.y, globalHeightDirection.x) / 6.283185307179586 + 0.5);
  float globalHeightV = clamp(0.5 - asin(clamp(globalHeightDirection.z, -1.0, 1.0)) / 3.141592653589793, 0.0, 1.0);
  vec2 globalHeightRg = texture2D(globalHeightMap, vec2(globalHeightU, globalHeightV)).rg;
  float globalHeightQuantized = globalHeightRg.r * 65280.0 + globalHeightRg.g * 255.0;
  float globalHeightMeters = -12000.0 + globalHeightQuantized / 65535.0 * 24000.0;
  vGlobalSurfaceAltitude = globalHeightMeters;
  transformed += globalHeightDirection * (globalHeightMeters / max(terrestrialAerialBodyRadius, 1.0));
}`;

export const GLOBAL_FRAGMENT_HEADER = /* glsl */ `
uniform sampler2D globalAlbedoMap;
uniform sampler2D globalNormalMap;
uniform sampler2D globalMaterialMap;
uniform sampler2D globalCloudMap;
uniform sampler2D globalEmissiveMap;
uniform float useAuthoredGlobalMaps;
uniform float useGlobalEmissiveMap;
uniform float useGlobalIceMap;
uniform vec3 globalSunDirection;
uniform float globalCloudDriftAngle;
uniform float globalCloudShadowStrength;
uniform mat3 normalMatrix;
varying vec3 vBodyDirection;
varying float vGlobalSurfaceAltitude;
// Blue Marble-style albedo maps are display-stretched imagery, not
// reflectance: decoded as sRGB, Florida vegetation lands near 0.02 green where
// measured canopy reflectance is ~0.08. A per-channel power fitted to
// vegetation (0.017 -> 0.07), desert (0.41 -> 0.42) and ice (0.87 -> 0.75)
// restores physical reflectance and the natural blue of vegetation.
vec3 terrestrialLandReflectance(vec3 albedo) {
  return 0.81 * pow(max(albedo, vec3(0.0)), vec3(0.6));
}
${BODY_FIXED_UV_GLSL}
${SURFACE_CLASS_GLSL}
${PLANET_DETAIL_GLSL}
vec3 decodeGlobalOctNormal(vec2 encoded) {
  vec2 f = encoded * 2.0 - 1.0;
  vec3 n = vec3(f, 1.0 - abs(f.x) - abs(f.y));
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * sign(n.xy);
  return normalize(n);
}`;

export const GLOBAL_ALBEDO_APPLY = /* glsl */ `
vec2 globalUv = bodyFixedUv(vBodyDirection);
vec4 authoredMaterial = texture2D(globalMaterialMap, globalUv);
float authoredSurfaceClass = resolvedSurfaceClass(vBodyDirection);
float globalOceanOwnership = useGlobalSurfaceClassMap > 0.5
  ? surfaceClassOceanCoverage(vBodyDirection)
  : authoredMaterial.b;
if (useAuthoredGlobalMaps > 0.5) {
  vec4 authoredAlbedo = texture2D(globalAlbedoMap, globalUv);
  vec4 globalDetail = samplePlanetDetail(vBodyDirection);
  vec3 globalLandAlbedo = terrestrialLandReflectance(
    mix(authoredAlbedo.rgb, globalDetail.rgb, globalDetail.a));
  // Open-ocean diffuse reflectance: deep navy, a few percent in blue only.
  vec3 globalOceanColor = mix(vec3(0.004, 0.013, 0.03), vec3(0.007, 0.03, 0.055),
    0.5 + 0.5 * abs(normalize(vBodyDirection).z));
  diffuseColor.rgb *= mix(globalLandAlbedo, globalOceanColor, globalOceanOwnership);
  diffuseColor.rgb *= mix(0.55, 1.0, authoredMaterial.g);
  float cloudCos = cos(globalCloudDriftAngle);
  float cloudSin = sin(globalCloudDriftAngle);
  vec3 cloudShadowDirection = normalize(vBodyDirection + normalize(globalSunDirection) * 0.012);
  cloudShadowDirection.xy = mat2(cloudCos, -cloudSin, cloudSin, cloudCos) * cloudShadowDirection.xy;
  vec2 cloudShadowField = texture2D(globalCloudMap, bodyFixedUv(cloudShadowDirection)).rg;
  float cloudShadowCoverage = smoothstep(0.10, 0.82, cloudShadowField.r) * cloudShadowField.g;
  float cloudShadowDaylight = max(0.0, dot(normalize(vBodyDirection), normalize(globalSunDirection)));
  diffuseColor.rgb *= 1.0 - cloudShadowCoverage * cloudShadowDaylight * globalCloudShadowStrength;
}`;

export const GLOBAL_EMISSIVE_APPLY = /* glsl */ `
if (useAuthoredGlobalMaps > 0.5 && useGlobalEmissiveMap > 0.5) {
  float globalSolarCosine = dot(normalize(vBodyDirection), normalize(globalSunDirection));
  float globalNight = 1.0 - smoothstep(-0.18, 0.08, globalSolarCosine);
  float globalCloudOcclusion = texture2D(globalCloudMap, globalUv).g;
  vec3 globalNightEmission = texture2D(globalEmissiveMap, globalUv).rgb;
  // Sodium/LED city light: lift dense cores more than sparse rural glow.
  vec3 globalCityLight = globalNightEmission * (0.6 + 2.4 * smoothstep(0.02, 0.5, globalNightEmission.r));
  globalCityLight *= vec3(1.0, 0.84, 0.62);
  totalEmissiveRadiance += globalCityLight * globalNight * (1.0 - globalCloudOcclusion * 0.78) * 2.2;
}`;

export const GLOBAL_ROUGHNESS_APPLY = /* glsl */ `
if (useAuthoredGlobalMaps > 0.5) {
  // Open water reads as a defined sun glint from high orbit. Near the ground
  // the streamed ocean owns the glint, so the compact cover keeps the matte
  // value that matches it wherever the two meet.
  float globalViewAltitude = length(terrestrialAerialCameraBodyFixed) - terrestrialAerialBodyRadius;
  float globalOceanRoughness = mix(0.42, 0.13, smoothstep(150000.0, 600000.0, globalViewAltitude));
  float globalResolvedRoughness = mix(authoredMaterial.r, globalOceanRoughness, globalOceanOwnership);
  roughnessFactor *= mix(0.2, 1.0, globalResolvedRoughness);
}`;

/** Direct sunlight passes through the atmosphere column: sunset colour near the terminator. */
export const GLOBAL_SUN_TINT_APPLY = /* glsl */ `
vec3 terrestrialDirectSunTint = terrestrialSurfaceSunTint(
  normalize(vBodyDirection) * (terrestrialAerialBodyRadius + vGlobalSurfaceAltitude));
reflectedLight.directDiffuse *= terrestrialDirectSunTint;
reflectedLight.directSpecular *= terrestrialDirectSunTint;`;

export const GLOBAL_NORMAL_APPLY = /* glsl */ `
vec3 globalBodyNormal = normalize(vBodyDirection);
if (useAuthoredGlobalMaps > 0.5) {
  globalBodyNormal = decodeGlobalOctNormal(texture2D(globalNormalMap, globalUv).rg);
  normal = normalize(normalMatrix * globalBodyNormal);
}`;

/** Distance- and altitude-aware aerial perspective for opaque Earth pixels. */
function dataTexture(bytes: number[], colorSpace: THREE.ColorSpace): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array(bytes), 1, 1, THREE.RGBAFormat);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function requiredTexture(pack: Readonly<RuntimeBodyAssetPack>, channel: string): THREE.Texture {
  const texture = pack.textures.get(channel);
  if (!texture) throw new Error(`${pack.bodyId}/${pack.tier} is missing required ${channel} texture`);
  return texture;
}

function configureTexture(
  texture: THREE.Texture,
  colorSpace: THREE.ColorSpace,
  anisotropy: number,
  mipmapped: boolean,
): void {
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = mipmapped ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
}

/** Borrowed authored channels plus owned descriptor fallbacks for one terrestrial program. */
export interface TerrestrialAuthoredTextures {
  readonly albedo: THREE.Texture;
  readonly normal: THREE.Texture;
  readonly packedMaterial: THREE.Texture;
  readonly clouds: THREE.Texture;
  readonly emissive: THREE.Texture;
  readonly heightMacro: THREE.Texture;
  readonly surfaceClasses: SurfaceClassTextureSet;
  readonly authored: boolean;
  readonly hasEmissive: boolean;
  readonly hasHeightMacro: boolean;
  readonly hasIceMask: boolean;
  /** Textures the material owns and must dispose (only present on the fallback path). */
  readonly owned: readonly THREE.Texture[];
}

/**
 * Resolve the authored albedo/normal/material trio for a body, borrowing runtime
 * pack textures when present and synthesizing owned 1×1 fallbacks otherwise.
 */
export function resolveTerrestrialAuthoredTextures(
  pack: Readonly<RuntimeBodyAssetPack> | null,
  bodyId: string,
  maxAnisotropy = 1,
): TerrestrialAuthoredTextures {
  if (pack && pack.bodyId !== bodyId) {
    throw new Error(`Asset pack ${pack.bodyId} cannot stage for ${bodyId}`);
  }
  const owned: THREE.Texture[] = [];
  const albedo = pack ? requiredTexture(pack, 'albedo') : dataTexture([255, 255, 255, 255], THREE.SRGBColorSpace);
  const normal = pack ? requiredTexture(pack, 'normal') : dataTexture([128, 128, 0, 255], THREE.NoColorSpace);
  const packedMaterial = pack ? requiredTexture(pack, 'material') : dataTexture([190, 255, 80, 0], THREE.NoColorSpace);
  const clouds = pack ? requiredTexture(pack, 'clouds') : dataTexture([0, 0, 0, 255], THREE.NoColorSpace);
  const emissive = pack?.textures.get('emissive') ?? dataTexture([0, 0, 0, 255], THREE.SRGBColorSpace);
  // RG = 32768, the exact zero-datum code in the signed height contract.
  const heightMacro = pack?.textures.get('heightMacro') ?? dataTexture([128, 0, 0, 255], THREE.NoColorSpace);
  const surfaceClasses = resolveSurfaceClassTextures(pack?.textures ?? null);
  if (!pack) owned.push(albedo, normal, packedMaterial, clouds);
  if (!pack?.textures.has('emissive')) owned.push(emissive);
  if (!pack?.textures.has('heightMacro')) owned.push(heightMacro);
  owned.push(...surfaceClasses.owned);
  const requestedAnisotropy = pack?.tier === 'high' ? 8 : pack?.tier === 'medium' ? 4 : pack ? 2 : 1;
  const anisotropy = Math.max(1, Math.min(maxAnisotropy, requestedAnisotropy));
  configureTexture(albedo, THREE.SRGBColorSpace, anisotropy, pack !== null);
  configureTexture(normal, THREE.NoColorSpace, anisotropy, pack !== null);
  configureTexture(packedMaterial, THREE.NoColorSpace, anisotropy, pack !== null);
  configureTexture(clouds, THREE.NoColorSpace, anisotropy, pack !== null);
  configureTexture(emissive, THREE.SRGBColorSpace, anisotropy, pack?.textures.has('emissive') === true);
  configureTexture(heightMacro, THREE.NoColorSpace, anisotropy, pack?.textures.has('heightMacro') === true);
  return {
    albedo, normal, packedMaterial, clouds, emissive, heightMacro, surfaceClasses,
    authored: pack !== null,
    hasEmissive: pack?.textures.has('emissive') === true,
    hasHeightMacro: pack?.textures.has('heightMacro') === true,
    hasIceMask: bodyId === 'earth' && pack !== null,
    owned,
  };
}

export interface TerrestrialCloudLightingState {
  readonly sunDirection: { value: THREE.Vector3 };
  readonly driftAngle: { value: number };
  readonly shadowStrength: { value: number };
}

export function createTerrestrialCloudLightingState(): TerrestrialCloudLightingState {
  return {
    sunDirection: { value: new THREE.Vector3(1, 0, 0) },
    driftAngle: { value: 0 },
    shadowStrength: { value: 0.28 },
  };
}

export function updateTerrestrialCloudLighting(
  material: THREE.Material,
  sunDirection: Readonly<{ x: number; y: number; z: number }>,
  driftAngle: number,
): void {
  const state = material.userData.terrestrialCloudLighting as TerrestrialCloudLightingState | undefined;
  if (!state) return;
  state.sunDirection.value.set(sunDirection.x, sunDirection.y, sunDirection.z).normalize();
  state.driftAngle.value = driftAngle;
}

/** Bind the authored sampling uniforms shared by both terrestrial programs. */
export function bindTerrestrialAuthoredUniforms(
  shader: { uniforms: Record<string, { value: unknown }> },
  textures: Readonly<TerrestrialAuthoredTextures>,
  cloudLighting: TerrestrialCloudLightingState,
): void {
  shader.uniforms.globalAlbedoMap = { value: textures.albedo };
  shader.uniforms.globalNormalMap = { value: textures.normal };
  shader.uniforms.globalMaterialMap = { value: textures.packedMaterial };
  shader.uniforms.globalCloudMap = { value: textures.clouds };
  shader.uniforms.globalEmissiveMap = { value: textures.emissive };
  shader.uniforms.globalHeightMap = { value: textures.heightMacro };
  bindSurfaceClassUniforms(shader, textures.surfaceClasses);
  shader.uniforms.useGlobalHeightMap = { value: textures.hasHeightMacro ? 1 : 0 };
  shader.uniforms.useAuthoredGlobalMaps = { value: textures.authored ? 1 : 0 };
  shader.uniforms.useGlobalEmissiveMap = { value: textures.hasEmissive ? 1 : 0 };
  shader.uniforms.useGlobalIceMap = { value: textures.hasIceMask ? 1 : 0 };
  shader.uniforms.globalSunDirection = cloudLighting.sunDirection;
  shader.uniforms.globalCloudDriftAngle = cloudLighting.driftAngle;
  shader.uniforms.globalCloudShadowStrength = cloudLighting.shadowStrength;
}

/**
 * Build the shared orbit-to-ground identity material. Runtime pack textures
 * are borrowed; descriptor fallbacks are owned and released with the material.
 */
export function createTerrestrialGlobalMaterial(
  pack: Readonly<RuntimeBodyAssetPack> | null,
  fallback: Readonly<BodyMaterialDescriptor>,
  maxAnisotropy = 1,
  bodyRadius = 1,
): TerrestrialGlobalMaterial {
  const textures = resolveTerrestrialAuthoredTextures(pack, fallback.bodyId, maxAnisotropy);
  const cloudLighting = createTerrestrialCloudLightingState();
  const aerialPerspective = createTerrestrialAerialPerspectiveState('compact-land', bodyRadius);
  const detail = createPlanetDetailMaterialState();

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: pack === null,
    roughness: 1,
    metalness: 0,
  }) as TerrestrialGlobalMaterial;
  const maps = Object.freeze({
    albedo: textures.albedo,
    normal: textures.normal,
    material: textures.packedMaterial,
    clouds: textures.clouds,
    emissive: textures.emissive,
    heightMacro: textures.heightMacro,
    surfaceClass: textures.surfaceClasses.global,
    surfaceClassRegional: textures.surfaceClasses.regional,
  });
  Object.assign(material.userData, {
    terrestrialGlobal: true,
    bodyId: fallback.bodyId,
    authored: pack !== null,
    maps,
    terrestrialCloudLighting: cloudLighting,
    planetDetail: detail,
  });
  attachTerrestrialAerialPerspective(material, aerialPerspective);
  // Body-space oct normals have unavoidable fold discontinuities. Orbital mip
  // levels average across those folds into sun-dependent wedges, so the
  // compact globe keeps its smooth geometric normal. Streamed near-field
  // terrain still applies the authored relief normal.
  material.customProgramCacheKey = () => `terrestrial-global-v5:${pack ? 'authored' : 'palette'}`;
  material.onBeforeCompile = (shader) => {
    bindTerrestrialAuthoredUniforms(shader, textures, cloudLighting);
    bindPlanetDetailUniforms(shader, detail);
    bindTerrestrialAerialPerspectiveUniforms(shader, aerialPerspective);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
${GLOBAL_VERTEX_COMMON}
uniform sampler2D globalHeightMap;
uniform float useGlobalHeightMap;
uniform float terrestrialAerialBodyRadius;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GLOBAL_COMPACT_HEIGHT_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLOBAL_FRAGMENT_HEADER}\n${TERRESTRIAL_AERIAL_FRAGMENT_GLSL}`)
      .replace('#include <map_fragment>', GLOBAL_ALBEDO_APPLY)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${GLOBAL_EMISSIVE_APPLY}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>${GLOBAL_ROUGHNESS_APPLY}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${GLOBAL_SUN_TINT_APPLY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <opaque_fragment>', `outgoingLight = applyTerrestrialAerialPerspective(\n  normalize(vBodyDirection) * (terrestrialAerialBodyRadius + vGlobalSurfaceAltitude),\n  outgoingLight\n);\n#include <opaque_fragment>`);
  };

  let released = false;
  material.addEventListener('dispose', () => {
    if (released) return;
    released = true;
    for (const texture of textures.owned) texture.dispose();
  });
  return material;
}
