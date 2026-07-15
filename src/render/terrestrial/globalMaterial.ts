import * as THREE from 'three';
import type { BodyMaterialDescriptor } from '../bodyMaterial';
import type { RuntimeBodyAssetPack } from '../bodyRenderer';
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
    }>;
  } & Record<string, unknown>;
}

/**
 * Shared authored-map GLSL. The compact global material and the near-ground
 * surface material sample identical authored channels through these snippets so
 * orbit-to-ground identity can never drift between the two programs.
 */
export const GLOBAL_VERTEX_COMMON = 'attribute vec3 bodyDirection;\nvarying vec3 vBodyDirection;';
export const GLOBAL_VERTEX_BEGIN = 'vBodyDirection = bodyDirection;';

export const GLOBAL_FRAGMENT_HEADER = /* glsl */ `
uniform sampler2D globalAlbedoMap;
uniform sampler2D globalNormalMap;
uniform sampler2D globalMaterialMap;
uniform sampler2D globalCloudMap;
uniform float useAuthoredGlobalMaps;
uniform vec3 globalSunDirection;
uniform float globalCloudDriftAngle;
uniform float globalCloudShadowStrength;
uniform mat3 normalMatrix;
varying vec3 vBodyDirection;
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
  diffuseColor.rgb *= authoredAlbedo.rgb;
  diffuseColor.rgb *= mix(0.55, 1.0, authoredMaterial.g);
  float wetShore = 1.0 - abs(authoredMaterial.a * 2.0 - 1.0);
  diffuseColor.rgb *= mix(1.0, 0.72, wetShore);
  float cloudCos = cos(globalCloudDriftAngle);
  float cloudSin = sin(globalCloudDriftAngle);
  vec3 cloudShadowDirection = normalize(vBodyDirection + normalize(globalSunDirection) * 0.012);
  cloudShadowDirection.xy = mat2(cloudCos, -cloudSin, cloudSin, cloudCos) * cloudShadowDirection.xy;
  vec2 cloudShadowField = texture2D(globalCloudMap, bodyFixedUv(cloudShadowDirection)).rg;
  float cloudShadowCoverage = smoothstep(0.10, 0.82, cloudShadowField.r) * cloudShadowField.g;
  float cloudShadowDaylight = max(0.0, dot(normalize(vBodyDirection), normalize(globalSunDirection)));
  diffuseColor.rgb *= 1.0 - cloudShadowCoverage * cloudShadowDaylight * globalCloudShadowStrength;
}`;

export const GLOBAL_ROUGHNESS_APPLY = /* glsl */ `
if (useAuthoredGlobalMaps > 0.5) roughnessFactor *= mix(0.2, 1.0, authoredMaterial.r);`;

export const GLOBAL_NORMAL_APPLY = /* glsl */ `
vec3 globalBodyNormal = normalize(vBodyDirection);
if (useAuthoredGlobalMaps > 0.5) {
  globalBodyNormal = decodeGlobalOctNormal(texture2D(globalNormalMap, globalUv).rg);
  normal = normalize(normalMatrix * globalBodyNormal);
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
  readonly authored: boolean;
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
  if (!pack) owned.push(albedo, normal, packedMaterial, clouds);
  const requestedAnisotropy = pack?.tier === 'high' ? 8 : pack?.tier === 'medium' ? 4 : pack ? 2 : 1;
  const anisotropy = Math.max(1, Math.min(maxAnisotropy, requestedAnisotropy));
  configureTexture(albedo, THREE.SRGBColorSpace, anisotropy, pack !== null);
  configureTexture(normal, THREE.NoColorSpace, anisotropy, pack !== null);
  configureTexture(packedMaterial, THREE.NoColorSpace, anisotropy, pack !== null);
  configureTexture(clouds, THREE.NoColorSpace, anisotropy, pack !== null);
  return { albedo, normal, packedMaterial, clouds, authored: pack !== null, owned };
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
  shader.uniforms.useAuthoredGlobalMaps = { value: textures.authored ? 1 : 0 };
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
      .replace('#include <common>', `#include <common>\n${GLOBAL_VERTEX_COMMON}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${GLOBAL_VERTEX_BEGIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLOBAL_FRAGMENT_HEADER}`)
      .replace('#include <map_fragment>', GLOBAL_ALBEDO_APPLY)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>${GLOBAL_ROUGHNESS_APPLY}`)
      .replace('#include <normal_fragment_maps>', GLOBAL_NORMAL_APPLY);
  };

  let released = false;
  material.addEventListener('dispose', () => {
    if (released) return;
    released = true;
    for (const texture of textures.owned) texture.dispose();
  });
  return material;
}
