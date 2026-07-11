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

/**
 * Build the shared orbit-to-ground identity material. Runtime pack textures
 * are borrowed; descriptor fallbacks are owned and released with the material.
 */
export function createTerrestrialGlobalMaterial(
  pack: Readonly<RuntimeBodyAssetPack> | null,
  fallback: Readonly<BodyMaterialDescriptor>,
): TerrestrialGlobalMaterial {
  if (pack && pack.bodyId !== fallback.bodyId) {
    throw new Error(`Asset pack ${pack.bodyId} cannot stage for ${fallback.bodyId}`);
  }

  const ownedTextures: THREE.Texture[] = [];
  const albedo = pack ? requiredTexture(pack, 'albedo') : dataTexture([255, 255, 255, 255], THREE.SRGBColorSpace);
  const normal = pack ? requiredTexture(pack, 'normal') : dataTexture([128, 128, 0, 255], THREE.NoColorSpace);
  const packedMaterial = pack ? requiredTexture(pack, 'material') : dataTexture([190, 255, 80, 0], THREE.NoColorSpace);
  if (!pack) ownedTextures.push(albedo, normal, packedMaterial);
  configureTexture(albedo, THREE.SRGBColorSpace);
  configureTexture(normal, THREE.NoColorSpace);
  configureTexture(packedMaterial, THREE.NoColorSpace);

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: pack === null,
    roughness: 1,
    metalness: 0,
  }) as TerrestrialGlobalMaterial;
  const maps = Object.freeze({ albedo, normal, material: packedMaterial });
  Object.assign(material.userData, {
    terrestrialGlobal: true,
    bodyId: fallback.bodyId,
    authored: pack !== null,
    maps,
  });
  material.customProgramCacheKey = () => `terrestrial-global-v1:${pack ? 'authored' : 'palette'}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.globalAlbedoMap = { value: albedo };
    shader.uniforms.globalNormalMap = { value: normal };
    shader.uniforms.globalMaterialMap = { value: packedMaterial };
    shader.uniforms.useAuthoredGlobalMaps = { value: pack ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 bodyDirection;\nvarying vec3 vBodyDirection;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBodyDirection = bodyDirection;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
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
}`)
      .replace('#include <map_fragment>', `
vec2 globalUv = bodyFixedUv(vBodyDirection);
vec4 authoredMaterial = texture2D(globalMaterialMap, globalUv);
if (useAuthoredGlobalMaps > 0.5) {
  vec4 authoredAlbedo = texture2D(globalAlbedoMap, globalUv);
  diffuseColor.rgb *= sRGBTransferEOTF(vec4(authoredAlbedo.rgb, 1.0)).rgb;
  diffuseColor.rgb *= mix(0.55, 1.0, authoredMaterial.g);
  float wetShore = 1.0 - abs(authoredMaterial.a * 2.0 - 1.0);
  diffuseColor.rgb *= mix(1.0, 0.72, wetShore);
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
if (useAuthoredGlobalMaps > 0.5) roughnessFactor *= mix(0.2, 1.0, authoredMaterial.r);`)
      .replace('#include <normal_fragment_maps>', `
if (useAuthoredGlobalMaps > 0.5) {
  vec3 bodyNormal = decodeGlobalOctNormal(texture2D(globalNormalMap, globalUv).rg);
  normal = normalize(normalMatrix * bodyNormal);
}`);
  };

  let released = false;
  material.addEventListener('dispose', () => {
    if (released) return;
    released = true;
    for (const texture of ownedTextures) texture.dispose();
  });
  return material;
}
