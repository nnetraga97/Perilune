import * as THREE from 'three';
import type { BodyMaterialDescriptor } from '../bodyMaterial';
import type { QualityTier, RuntimeBodyAssetPack } from '../bodyRenderer';
import { BODY_FIXED_UV_GLSL } from '../terrestrial/globalCoordinates';
import { PLANET_DETAIL_GLSL, bindPlanetDetailUniforms, createPlanetDetailMaterialState } from '../planetDetail/detailMaterial';
import { bindTerrainDetailUniforms, createTerrainDetailMaterialState, TERRAIN_DETAIL_GLSL } from '../planetDetail/terrainDetailMaterial';

function requiredTexture(pack: Readonly<RuntimeBodyAssetPack>, channel: string): THREE.Texture {
  const texture = pack.textures.get(channel);
  if (!texture) throw new Error(`${pack.bodyId}/${pack.tier} is missing required ${channel} texture`);
  return texture;
}

function configure(texture: THREE.Texture, colorSpace: THREE.ColorSpace, anisotropy: number): void {
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
}

export interface AirlessSurfaceMaterial extends THREE.MeshStandardMaterial {
  readonly userData: {
    readonly airlessSurface: true;
    readonly bodyId: string;
    readonly authored: boolean;
    readonly tier: QualityTier;
  } & Record<string, unknown>;
}

/**
 * Terrain material for the Moon and future airless bodies. Geometric terrain
 * normals remain authoritative; the source macro normal contributes only its
 * tangent-space departure from the datum sphere, so it cannot flatten local
 * crater rims or streamed terrain slopes.
 */
export function createAirlessSurfaceMaterial(
  pack: Readonly<RuntimeBodyAssetPack> | null,
  descriptor: Readonly<BodyMaterialDescriptor>,
  tier: QualityTier,
  maxAnisotropy = 1,
): AirlessSurfaceMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: pack ? 0xffffff : descriptor.albedo.mid,
    vertexColors: pack === null,
    roughness: 1,
    metalness: 0,
  }) as AirlessSurfaceMaterial;
  const detail = createPlanetDetailMaterialState();
  const terrainDetail = createTerrainDetailMaterialState();
  Object.assign(material.userData, {
    airlessSurface: true,
    bodyId: descriptor.bodyId,
    authored: pack !== null,
    tier,
    planetDetail: detail,
    terrainDetail,
  });
  material.customProgramCacheKey = () => `airless-surface-v2:${pack ? 'authored' : 'fallback'}:${tier}`;
  if (!pack) return material;

  const albedo = requiredTexture(pack, 'albedo');
  const normalMap = requiredTexture(pack, 'normal');
  const packedMaterial = requiredTexture(pack, 'material');
  const localDetail = pack.textures.get('localDetail') ?? null;
  const requestedAnisotropy = tier === 'high' ? 16 : tier === 'medium' ? 8 : 4;
  const anisotropy = Math.max(1, Math.min(maxAnisotropy, requestedAnisotropy));
  configure(albedo, THREE.SRGBColorSpace, anisotropy);
  configure(normalMap, THREE.NoColorSpace, anisotropy);
  configure(packedMaterial, THREE.NoColorSpace, anisotropy);
  if (localDetail) {
    localDetail.colorSpace = THREE.NoColorSpace;
    localDetail.wrapS = THREE.RepeatWrapping;
    localDetail.wrapT = THREE.RepeatWrapping;
    localDetail.minFilter = THREE.LinearMipmapLinearFilter;
    localDetail.magFilter = THREE.LinearFilter;
    localDetail.anisotropy = anisotropy;
    localDetail.needsUpdate = true;
  }

  material.onBeforeCompile = (shader) => {
    shader.uniforms.airlessAlbedoMap = { value: albedo };
    shader.uniforms.airlessNormalMap = { value: normalMap };
    shader.uniforms.airlessMaterialMap = { value: packedMaterial };
    shader.uniforms.airlessLocalDetailMap = { value: localDetail };
    shader.uniforms.airlessUseLocalDetail = { value: localDetail ? 1 : 0 };
    shader.uniforms.airlessMacroNormalWeight = { value: tier === 'low' ? 0.2 : tier === 'medium' ? 0.32 : 0.42 };
    bindPlanetDetailUniforms(shader, detail);
    bindTerrainDetailUniforms(shader, terrainDetail);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 bodyDirection;\nattribute vec3 bodyFixedDetailAnchor;\nvarying vec3 vAirlessBodyDirection;\nvarying vec3 vAirlessGeometryNormal;\nvarying vec3 vAirlessDetailAnchor;',
      )
      .replace(
        '#include <beginnormal_vertex>',
        '#include <beginnormal_vertex>\nvAirlessGeometryNormal = normalize(objectNormal);',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvAirlessBodyDirection = bodyDirection;\nvAirlessDetailAnchor = bodyFixedDetailAnchor;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D airlessAlbedoMap;
uniform sampler2D airlessNormalMap;
uniform sampler2D airlessMaterialMap;
uniform sampler2D airlessLocalDetailMap;
uniform float airlessUseLocalDetail;
uniform float airlessMacroNormalWeight;
uniform mat3 normalMatrix;
varying vec3 vAirlessBodyDirection;
varying vec3 vAirlessGeometryNormal;
varying vec3 vAirlessDetailAnchor;
	${BODY_FIXED_UV_GLSL}
	${PLANET_DETAIL_GLSL}
	${TERRAIN_DETAIL_GLSL}
vec3 decodeAirlessSurfaceOctNormal(vec2 encoded) {
  vec2 f = encoded * 2.0 - 1.0;
  vec3 n = vec3(f, 1.0 - abs(f.x) - abs(f.y));
  if (n.z < 0.0) n.xy = (1.0 - abs(n.yx)) * sign(n.xy);
  return normalize(n);
}
vec4 sampleAirlessLocal(vec2 uv) {
  vec2 wrapped = fract(uv);
  vec2 atlasUv = vec2(wrapped.x * 0.5, wrapped.y);
  return textureGrad(
    airlessLocalDetailMap,
    atlasUv,
    vec2(dFdx(uv.x) * 0.5, dFdx(uv.y)),
    vec2(dFdy(uv.x) * 0.5, dFdy(uv.y))
  );
}
vec4 sampleAirlessLocalTriplanar(vec3 anchor, vec3 n) {
  vec3 axes = pow(abs(n), vec3(4.0));
  vec3 blend = axes / max(0.0001, axes.x + axes.y + axes.z);
  return sampleAirlessLocal(anchor.yz / 6.0) * blend.x
    + sampleAirlessLocal(anchor.xz / 6.0) * blend.y
    + sampleAirlessLocal(anchor.xy / 6.0) * blend.z;
}
vec3 decodeAirlessLocalNormal(vec2 encoded) {
  vec2 xy = encoded * 2.0 - 1.0;
  return normalize(vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy)))));
}
vec3 sampleAirlessLocalNormal(vec3 anchor, vec3 bodyNormal) {
  vec3 axes = pow(abs(bodyNormal), vec3(4.0));
  vec3 blend = axes / max(0.0001, axes.x + axes.y + axes.z);
  vec3 nx = decodeAirlessLocalNormal(sampleAirlessLocal(anchor.yz / 6.0).gb);
  vec3 ny = decodeAirlessLocalNormal(sampleAirlessLocal(anchor.xz / 6.0).gb);
  vec3 nz = decodeAirlessLocalNormal(sampleAirlessLocal(anchor.xy / 6.0).gb);
  vec3 worldX = vec3(nx.z * sign(bodyNormal.x), nx.x, nx.y);
  vec3 worldY = vec3(ny.x, ny.z * sign(bodyNormal.y), ny.y);
  vec3 worldZ = vec3(nz.x, nz.y, nz.z * sign(bodyNormal.z));
  return normalize(worldX * blend.x + worldY * blend.y + worldZ * blend.z);
}`,
      )
      .replace(
        '#include <map_fragment>',
	`vec2 airlessSurfaceUv = bodyFixedUv(vAirlessBodyDirection);
	vec4 airlessSurfaceMaterial = texture2D(airlessMaterialMap, airlessSurfaceUv);
	vec4 airlessSurfaceDetail = samplePlanetDetail(vAirlessBodyDirection);
	vec4 airlessTerrainDetail = sampleTerrainDetail(vAirlessBodyDirection);
float airlessLocalFootprint = max(max(length(fwidth(vAirlessDetailAnchor.yz / 6.0)), length(fwidth(vAirlessDetailAnchor.xz / 6.0))), length(fwidth(vAirlessDetailAnchor.xy / 6.0)));
float airlessLocalFade = airlessUseLocalDetail * (1.0 - smoothstep(0.035, 0.28, airlessLocalFootprint));
vec4 airlessLocal = sampleAirlessLocalTriplanar(vAirlessDetailAnchor, normalize(vAirlessGeometryNormal));
	vec3 airlessSurfaceAlbedo = mix(texture2D(airlessAlbedoMap, airlessSurfaceUv).rgb, airlessSurfaceDetail.rgb, airlessSurfaceDetail.a);
	airlessSurfaceAlbedo = mix(airlessSurfaceAlbedo, airlessTerrainDetail.rgb, airlessTerrainDetail.a);
	diffuseColor.rgb *= airlessSurfaceAlbedo * 0.30;
diffuseColor.rgb *= mix(0.76, 1.0, airlessSurfaceMaterial.g);
diffuseColor.rgb *= mix(1.0, mix(0.88, 1.1, airlessLocal.r), airlessLocalFade * 0.45);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor *= mix(0.65, 1.0, airlessSurfaceMaterial.r);
roughnessFactor = mix(roughnessFactor, airlessLocal.a, airlessLocalFade * 0.55);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 airlessRadialNormal = normalize(vAirlessBodyDirection);
vec3 airlessMacroNormal = decodeAirlessSurfaceOctNormal(texture2D(airlessNormalMap, airlessSurfaceUv).rg);
vec3 airlessMacroDelta = airlessMacroNormal - airlessRadialNormal * dot(airlessMacroNormal, airlessRadialNormal);
vec3 airlessComposedNormal = normalize(normalize(vAirlessGeometryNormal) + airlessMacroDelta * airlessMacroNormalWeight);
vec3 airlessLocalNormal = sampleAirlessLocalNormal(vAirlessDetailAnchor, normalize(vAirlessGeometryNormal));
airlessComposedNormal = normalize(mix(airlessComposedNormal, airlessLocalNormal, airlessLocalFade * 0.14));
vec4 airlessSourceNormal = sampleTerrainDetailNormal(vAirlessBodyDirection);
airlessComposedNormal = normalize(mix(airlessComposedNormal, airlessSourceNormal.rgb, airlessSourceNormal.a * terrainDetailNormalStrength));
normal = normalize(normalMatrix * airlessComposedNormal);`,
      );
  };
  return material;
}
