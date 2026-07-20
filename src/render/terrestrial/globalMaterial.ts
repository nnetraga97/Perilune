import * as THREE from 'three';
import type { BodyMaterialDescriptor } from '../bodyMaterial';
import type { RuntimeBodyAssetPack } from '../bodyRenderer';
import type { Body } from '../../sim/universe';
import type { BodyRenderFrame } from '../bodyRenderer';
import { BODY_FIXED_UV_GLSL } from './globalCoordinates';

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
  transformed += globalHeightDirection * (globalHeightMeters / max(globalBodyRadius, 1.0));
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
uniform vec3 globalCameraBodyFixed;
uniform float globalBodyRadius;
uniform float globalAtmosphereHeight;
uniform float globalScaleHeight;
uniform float globalSolarVisibleFraction;
uniform sampler2D globalAerialPerspectiveLut;
uniform float useGlobalAerialPerspectiveLut;
uniform mat3 normalMatrix;
varying vec3 vBodyDirection;
varying float vGlobalSurfaceAltitude;
${BODY_FIXED_UV_GLSL}
vec3 decodeGlobalOctNormal(vec2 encoded) {
  vec2 f = encoded * 2.0 - 1.0;
  vec3 n = vec3(f, 1.0 - abs(f.x) - abs(f.y));
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * sign(n.xy);
  return normalize(n);
}`;

export const GLOBAL_ALBEDO_APPLY = /* glsl */ `
vec2 globalUv = bodyFixedUv(vBodyDirection);
vec4 authoredMaterial = texture2D(globalMaterialMap, globalUv);
if (useAuthoredGlobalMaps > 0.5) {
  vec4 authoredAlbedo = texture2D(globalAlbedoMap, globalUv);
  vec3 globalOceanColor = mix(vec3(0.008, 0.035, 0.075), vec3(0.018, 0.09, 0.16),
    0.5 + 0.5 * abs(normalize(vBodyDirection).z));
  diffuseColor.rgb *= mix(authoredAlbedo.rgb, globalOceanColor, authoredMaterial.b);
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
  totalEmissiveRadiance += globalNightEmission * globalNight * (1.0 - globalCloudOcclusion * 0.72) * 1.35;
}`;

export const GLOBAL_ROUGHNESS_APPLY = /* glsl */ `
if (useAuthoredGlobalMaps > 0.5) {
  float globalResolvedRoughness = max(authoredMaterial.r, authoredMaterial.b * 0.42);
  roughnessFactor *= mix(0.2, 1.0, globalResolvedRoughness);
}`;

export const GLOBAL_NORMAL_APPLY = /* glsl */ `
vec3 globalBodyNormal = normalize(vBodyDirection);
if (useAuthoredGlobalMaps > 0.5) {
  globalBodyNormal = decodeGlobalOctNormal(texture2D(globalNormalMap, globalUv).rg);
  normal = normalize(normalMatrix * globalBodyNormal);
}`;

/** Distance- and altitude-aware aerial perspective for opaque Earth pixels. */
export const GLOBAL_AERIAL_APPLY = /* glsl */ `
if (globalAtmosphereHeight > 0.0) {
  vec3 globalSurfacePoint = normalize(vBodyDirection) * (globalBodyRadius + vGlobalSurfaceAltitude);
  vec3 globalViewSegment = globalCameraBodyFixed - globalSurfacePoint;
  float globalViewDistance = length(globalViewSegment);
  vec3 globalViewRay = globalViewDistance > 0.0 ? globalViewSegment / globalViewDistance : normalize(vBodyDirection);
  float globalViewUpCosine = max(0.025, abs(dot(globalViewRay, normalize(vBodyDirection))));
  float globalAirPath = min(globalViewDistance, globalAtmosphereHeight / globalViewUpCosine);
  float globalCameraAltitude = max(0.0, length(globalCameraBodyFixed) - globalBodyRadius);
  float globalObserverDensity = exp(-min(globalCameraAltitude, globalAtmosphereHeight) / max(globalScaleHeight, 1.0));
  float globalOpticalDepth = globalAirPath * 0.0000105 * mix(0.52, 1.0, globalObserverDensity);
  float globalAerial = clamp(1.0 - exp(-globalOpticalDepth), 0.0, 0.94);
  vec2 globalAerialUv = vec2(clamp(globalAirPath / 200000.0, 0.0, 1.0),
    clamp(globalCameraAltitude / max(globalAtmosphereHeight, 1.0), 0.0, 1.0));
  vec4 globalAerialLut = texture2D(globalAerialPerspectiveLut, globalAerialUv);
  globalAerial = mix(globalAerial, min(0.94, globalAerialLut.a * 1.18), useGlobalAerialPerspectiveLut);
  float globalSunElevation = dot(normalize(vBodyDirection), normalize(globalSunDirection));
  vec3 globalHazeColor = mix(vec3(0.30, 0.43, 0.62), vec3(0.48, 0.68, 0.96),
    smoothstep(-0.18, 0.34, globalSunElevation));
  globalHazeColor = mix(globalHazeColor, max(globalHazeColor, globalAerialLut.rgb * 1.7),
    useGlobalAerialPerspectiveLut);
  float globalOcclusionLight = mix(0.08, 1.0, globalSolarVisibleFraction);
  outgoingLight = outgoingLight * (1.0 - globalAerial * 0.86)
    + globalHazeColor * globalAerial * globalOcclusionLight;
}`;

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
  if (!pack) owned.push(albedo, normal, packedMaterial, clouds);
  if (!pack?.textures.has('emissive')) owned.push(emissive);
  if (!pack?.textures.has('heightMacro')) owned.push(heightMacro);
  const requestedAnisotropy = pack?.tier === 'high' ? 8 : pack?.tier === 'medium' ? 4 : pack ? 2 : 1;
  const anisotropy = Math.max(1, Math.min(maxAnisotropy, requestedAnisotropy));
  configureTexture(albedo, THREE.SRGBColorSpace, anisotropy, pack !== null);
  configureTexture(normal, THREE.NoColorSpace, anisotropy, pack !== null);
  configureTexture(packedMaterial, THREE.NoColorSpace, anisotropy, pack !== null);
  configureTexture(clouds, THREE.NoColorSpace, anisotropy, pack !== null);
  configureTexture(emissive, THREE.SRGBColorSpace, anisotropy, pack?.textures.has('emissive') === true);
  configureTexture(heightMacro, THREE.NoColorSpace, anisotropy, pack?.textures.has('heightMacro') === true);
  return {
    albedo, normal, packedMaterial, clouds, emissive, heightMacro,
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
  readonly cameraBodyFixed: { value: THREE.Vector3 };
  readonly bodyRadius: { value: number };
  readonly atmosphereHeight: { value: number };
  readonly scaleHeight: { value: number };
  readonly solarVisibleFraction: { value: number };
  readonly aerialPerspectiveLut: { value: THREE.Texture | null };
  readonly useAerialPerspectiveLut: { value: number };
}

export function createTerrestrialCloudLightingState(): TerrestrialCloudLightingState {
  return {
    sunDirection: { value: new THREE.Vector3(1, 0, 0) },
    driftAngle: { value: 0 },
    shadowStrength: { value: 0.28 },
    cameraBodyFixed: { value: new THREE.Vector3() },
    bodyRadius: { value: 1 },
    atmosphereHeight: { value: 0 },
    scaleHeight: { value: 1 },
    solarVisibleFraction: { value: 1 },
    aerialPerspectiveLut: { value: null },
    useAerialPerspectiveLut: { value: 0 },
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

export function updateTerrestrialEnvironment(
  material: THREE.Material,
  body: Readonly<Body>,
  frame: Pick<BodyRenderFrame, 'cameraBodyFixed' | 'solarVisibleFraction'>,
  aerialPerspectiveLut?: THREE.Texture,
): void {
  const state = material.userData.terrestrialCloudLighting as TerrestrialCloudLightingState | undefined;
  if (!state) return;
  state.cameraBodyFixed.value.set(frame.cameraBodyFixed.x, frame.cameraBodyFixed.y, frame.cameraBodyFixed.z);
  state.bodyRadius.value = body.radius;
  state.atmosphereHeight.value = body.def.atmosphere?.height ?? 0;
  state.scaleHeight.value = body.def.atmosphere?.scaleHeight ?? 1;
  state.solarVisibleFraction.value = Math.max(0, Math.min(1, frame.solarVisibleFraction));
  state.aerialPerspectiveLut.value = aerialPerspectiveLut ?? null;
  state.useAerialPerspectiveLut.value = aerialPerspectiveLut ? 1 : 0;
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
  shader.uniforms.useGlobalHeightMap = { value: textures.hasHeightMacro ? 1 : 0 };
  shader.uniforms.useAuthoredGlobalMaps = { value: textures.authored ? 1 : 0 };
  shader.uniforms.useGlobalEmissiveMap = { value: textures.hasEmissive ? 1 : 0 };
  shader.uniforms.useGlobalIceMap = { value: textures.hasIceMask ? 1 : 0 };
  shader.uniforms.globalSunDirection = cloudLighting.sunDirection;
  shader.uniforms.globalCloudDriftAngle = cloudLighting.driftAngle;
  shader.uniforms.globalCloudShadowStrength = cloudLighting.shadowStrength;
  shader.uniforms.globalCameraBodyFixed = cloudLighting.cameraBodyFixed;
  shader.uniforms.globalBodyRadius = cloudLighting.bodyRadius;
  shader.uniforms.globalAtmosphereHeight = cloudLighting.atmosphereHeight;
  shader.uniforms.globalScaleHeight = cloudLighting.scaleHeight;
  shader.uniforms.globalSolarVisibleFraction = cloudLighting.solarVisibleFraction;
  shader.uniforms.globalAerialPerspectiveLut = cloudLighting.aerialPerspectiveLut;
  shader.uniforms.useGlobalAerialPerspectiveLut = cloudLighting.useAerialPerspectiveLut;
}

/**
 * Build the shared orbit-to-ground identity material. Runtime pack textures
 * are borrowed; descriptor fallbacks are owned and released with the material.
 */
export function createTerrestrialGlobalMaterial(
  pack: Readonly<RuntimeBodyAssetPack> | null,
  fallback: Readonly<BodyMaterialDescriptor>,
  maxAnisotropy = 1,
): TerrestrialGlobalMaterial {
  const textures = resolveTerrestrialAuthoredTextures(pack, fallback.bodyId, maxAnisotropy);
  const cloudLighting = createTerrestrialCloudLightingState();

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
  });
  Object.assign(material.userData, {
    terrestrialGlobal: true,
    bodyId: fallback.bodyId,
    authored: pack !== null,
    maps,
    terrestrialCloudLighting: cloudLighting,
  });
  material.customProgramCacheKey = () => `terrestrial-global-v2:${pack ? 'authored' : 'palette'}`;
  material.onBeforeCompile = (shader) => {
    bindTerrestrialAuthoredUniforms(shader, textures, cloudLighting);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
${GLOBAL_VERTEX_COMMON}
uniform sampler2D globalHeightMap;
uniform float useGlobalHeightMap;
uniform float globalBodyRadius;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GLOBAL_COMPACT_HEIGHT_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLOBAL_FRAGMENT_HEADER}`)
      .replace('#include <map_fragment>', GLOBAL_ALBEDO_APPLY)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${GLOBAL_EMISSIVE_APPLY}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>${GLOBAL_ROUGHNESS_APPLY}`)
      .replace('#include <normal_fragment_maps>', GLOBAL_NORMAL_APPLY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <opaque_fragment>', `${GLOBAL_AERIAL_APPLY}\n#include <opaque_fragment>`);
  };

  let released = false;
  material.addEventListener('dispose', () => {
    if (released) return;
    released = true;
    for (const texture of textures.owned) texture.dispose();
  });
  return material;
}
