import * as THREE from 'three';
import type { RuntimeBodyAssetPack } from '../bodyRenderer';
import { BODY_FIXED_UV_GLSL } from '../terrestrial/globalCoordinates';
import { PLANET_DETAIL_GLSL, bindPlanetDetailUniforms, createPlanetDetailMaterialState } from '../planetDetail/detailMaterial';

export interface AirlessGlobalMaterial extends THREE.MeshStandardMaterial {
  readonly userData: {
    readonly airlessGlobal: true;
    readonly bodyId: string;
  } & Record<string, unknown>;
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
): void {
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
}

/** Authored orbit-scale material for airless bodies; textures remain pack-owned. */
export function createAirlessGlobalMaterial(
  pack: Readonly<RuntimeBodyAssetPack>,
  maxAnisotropy = 1,
  bodyRadius = 1,
): AirlessGlobalMaterial {
  const albedo = requiredTexture(pack, 'albedo');
  const normal = requiredTexture(pack, 'normal');
  const packedMaterial = requiredTexture(pack, 'material');
  const heightMacro = pack.textures.get('heightMacro') ?? packedMaterial;
  const requestedAnisotropy = pack.tier === 'high' ? 16 : pack.tier === 'medium' ? 8 : 4;
  const anisotropy = Math.max(1, Math.min(maxAnisotropy, requestedAnisotropy));
  configureTexture(albedo, THREE.SRGBColorSpace, anisotropy);
  configureTexture(normal, THREE.NoColorSpace, anisotropy);
  configureTexture(packedMaterial, THREE.NoColorSpace, anisotropy);
  if (pack.textures.has('heightMacro')) configureTexture(heightMacro, THREE.NoColorSpace, anisotropy);

  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 }) as AirlessGlobalMaterial;
  const detail = createPlanetDetailMaterialState();
  Object.assign(material.userData, { airlessGlobal: true, bodyId: pack.bodyId, bodyRadius, planetDetail: detail });
  material.customProgramCacheKey = () => 'airless-global-v2:tangent-slope';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.airlessAlbedoMap = { value: albedo };
    shader.uniforms.airlessNormalMap = { value: normal };
    shader.uniforms.airlessMaterialMap = { value: packedMaterial };
    shader.uniforms.airlessHeightMap = { value: heightMacro };
    shader.uniforms.airlessUseHeightMap = { value: pack.textures.has('heightMacro') ? 1 : 0 };
    shader.uniforms.airlessBodyRadius = { value: bodyRadius };
    bindPlanetDetailUniforms(shader, detail);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 bodyDirection;\nuniform sampler2D airlessHeightMap;\nuniform float airlessUseHeightMap;\nuniform float airlessBodyRadius;\nvarying vec3 vAirlessBodyDirection;',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vAirlessBodyDirection = bodyDirection;
if (airlessUseHeightMap > 0.5) {
  vec3 airlessHeightDirection = normalize(bodyDirection);
  float airlessHeightU = fract(atan(airlessHeightDirection.y, airlessHeightDirection.x) / 6.283185307179586 + 0.5);
  float airlessHeightV = clamp(0.5 - asin(clamp(airlessHeightDirection.z, -1.0, 1.0)) / 3.141592653589793, 0.0, 1.0);
  vec2 airlessHeightRg = texture2D(airlessHeightMap, vec2(airlessHeightU, airlessHeightV)).rg;
  float airlessHeightQuantized = airlessHeightRg.r * 65280.0 + airlessHeightRg.g * 255.0;
  float airlessHeightMeters = -12000.0 + airlessHeightQuantized / 65535.0 * 24000.0;
  transformed += airlessHeightDirection * (airlessHeightMeters / max(airlessBodyRadius, 1.0));
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D airlessAlbedoMap;
uniform sampler2D airlessNormalMap;
uniform sampler2D airlessMaterialMap;
uniform mat3 normalMatrix;
varying vec3 vAirlessBodyDirection;
	${BODY_FIXED_UV_GLSL}
	${PLANET_DETAIL_GLSL}
vec3 decodeAirlessTangentSlope(vec2 encoded, vec3 bodyDirection) {
  vec3 radial = normalize(bodyDirection);
  float xy = length(radial.xy);
  vec3 east = xy > 0.00001 ? vec3(-radial.y / xy, radial.x / xy, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 north = normalize(cross(radial, east));
  vec2 slope = ((encoded * 255.0 - 128.0) / 127.0) * 2.0;
  return normalize(radial + east * slope.x + north * slope.y);
}`,
      )
      .replace(
        '#include <map_fragment>',
	`vec2 airlessUv = bodyFixedUv(vAirlessBodyDirection);
	vec4 airlessPackedMaterial = texture2D(airlessMaterialMap, airlessUv);
	vec4 airlessDetail = samplePlanetDetail(vAirlessBodyDirection);
	float airlessPolarDetailFade = 1.0 - smoothstep(0.965, 0.99, abs(normalize(vAirlessBodyDirection).z));
	airlessDetail.a *= airlessPolarDetailFade;
	vec3 airlessResolvedAlbedo = mix(texture2D(airlessAlbedoMap, airlessUv).rgb, airlessDetail.rgb, airlessDetail.a);
	diffuseColor.rgb *= airlessResolvedAlbedo * 0.30;
diffuseColor.rgb *= mix(0.72, 1.0, airlessPackedMaterial.g);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor *= mix(0.2, 1.0, airlessPackedMaterial.r);',
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 airlessRadialNormal = normalize(vAirlessBodyDirection);
vec3 airlessBodyNormal = decodeAirlessTangentSlope(texture2D(airlessNormalMap, airlessUv).rg, vAirlessBodyDirection);
float airlessPolarNormalFade = 1.0 - smoothstep(0.965, 0.99, abs(airlessRadialNormal.z));
float airlessPolarNormalWeight = mix(0.25, 1.0, airlessPolarNormalFade);
airlessBodyNormal = normalize(mix(airlessRadialNormal, airlessBodyNormal, 0.28 * airlessPolarNormalWeight));
normal = normalize(normalMatrix * airlessBodyNormal);`,
      );
  };
  return material;
}
