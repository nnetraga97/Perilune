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
uniform float useAuthoredGlobalMaps;
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
}`;

export const GLOBAL_ROUGHNESS_APPLY = /* glsl */ `
if (useAuthoredGlobalMaps > 0.5) roughnessFactor *= mix(0.2, 1.0, authoredMaterial.r);`;

export const GLOBAL_NORMAL_APPLY = /* glsl */ `
if (useAuthoredGlobalMaps > 0.5) {
  vec3 bodyNormal = decodeGlobalOctNormal(texture2D(globalNormalMap, globalUv).rg);
  normal = normalize(normalMatrix * bodyNormal);
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

function configureTexture(texture: THREE.Texture, colorSpace: THREE.ColorSpace): void {
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
}

/** Borrowed authored channels plus owned descriptor fallbacks for one terrestrial program. */
export interface TerrestrialAuthoredTextures {
  readonly albedo: THREE.Texture;
  readonly normal: THREE.Texture;
  readonly packedMaterial: THREE.Texture;
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
): TerrestrialAuthoredTextures {
  if (pack && pack.bodyId !== bodyId) {
    throw new Error(`Asset pack ${pack.bodyId} cannot stage for ${bodyId}`);
  }
  const owned: THREE.Texture[] = [];
  const albedo = pack ? requiredTexture(pack, 'albedo') : dataTexture([255, 255, 255, 255], THREE.SRGBColorSpace);
  const normal = pack ? requiredTexture(pack, 'normal') : dataTexture([128, 128, 0, 255], THREE.NoColorSpace);
  const packedMaterial = pack ? requiredTexture(pack, 'material') : dataTexture([190, 255, 80, 0], THREE.NoColorSpace);
  if (!pack) owned.push(albedo, normal, packedMaterial);
  configureTexture(albedo, THREE.SRGBColorSpace);
  configureTexture(normal, THREE.NoColorSpace);
  configureTexture(packedMaterial, THREE.NoColorSpace);
  return { albedo, normal, packedMaterial, authored: pack !== null, owned };
}

/** Bind the authored sampling uniforms shared by both terrestrial programs. */
export function bindTerrestrialAuthoredUniforms(
  shader: { uniforms: Record<string, { value: unknown }> },
  textures: Readonly<TerrestrialAuthoredTextures>,
): void {
  shader.uniforms.globalAlbedoMap = { value: textures.albedo };
  shader.uniforms.globalNormalMap = { value: textures.normal };
  shader.uniforms.globalMaterialMap = { value: textures.packedMaterial };
  shader.uniforms.useAuthoredGlobalMaps = { value: textures.authored ? 1 : 0 };
}

/**
 * Build the shared orbit-to-ground identity material. Runtime pack textures
 * are borrowed; descriptor fallbacks are owned and released with the material.
 */
export function createTerrestrialGlobalMaterial(
  pack: Readonly<RuntimeBodyAssetPack> | null,
  fallback: Readonly<BodyMaterialDescriptor>,
): TerrestrialGlobalMaterial {
  const textures = resolveTerrestrialAuthoredTextures(pack, fallback.bodyId);

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: pack === null,
    roughness: 1,
    metalness: 0,
  }) as TerrestrialGlobalMaterial;
  const maps = Object.freeze({ albedo: textures.albedo, normal: textures.normal, material: textures.packedMaterial });
  Object.assign(material.userData, {
    terrestrialGlobal: true,
    bodyId: fallback.bodyId,
    authored: pack !== null,
    maps,
  });
  material.customProgramCacheKey = () => `terrestrial-global-v1:${pack ? 'authored' : 'palette'}`;
  material.onBeforeCompile = (shader) => {
    bindTerrestrialAuthoredUniforms(shader, textures);
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
