import * as THREE from 'three';

export interface PlanetDetailMaterialState {
  readonly atlas: { value: THREE.Texture | null };
  readonly previousAtlas: { value: THREE.Texture | null };
  readonly enabled: { value: number };
  readonly opacity: { value: number };
  readonly previousOpacity: { value: number };
  readonly matrixSize: { value: THREE.Vector2 };
  readonly previousMatrixSize: { value: THREE.Vector2 };
  readonly atlasStart: { value: THREE.Vector2 };
  readonly previousAtlasStart: { value: THREE.Vector2 };
  readonly atlasGrid: { value: THREE.Vector2 };
  readonly previousAtlasGrid: { value: THREE.Vector2 };
  readonly colorScale: { value: THREE.Vector3 };
  readonly previousColorScale: { value: THREE.Vector3 };
  readonly colorBias: { value: THREE.Vector3 };
  readonly previousColorBias: { value: THREE.Vector3 };
}

export function createPlanetDetailMaterialState(): PlanetDetailMaterialState {
  return {
    atlas: { value: null },
    previousAtlas: { value: null },
    enabled: { value: 0 },
    opacity: { value: 0 },
    previousOpacity: { value: 0 },
    matrixSize: { value: new THREE.Vector2(1, 1) },
    previousMatrixSize: { value: new THREE.Vector2(1, 1) },
    atlasStart: { value: new THREE.Vector2() },
    previousAtlasStart: { value: new THREE.Vector2() },
    atlasGrid: { value: new THREE.Vector2(3, 3) },
    previousAtlasGrid: { value: new THREE.Vector2(3, 3) },
    colorScale: { value: new THREE.Vector3(1, 1, 1) },
    previousColorScale: { value: new THREE.Vector3(1, 1, 1) },
    colorBias: { value: new THREE.Vector3() },
    previousColorBias: { value: new THREE.Vector3() },
  };
}

export function bindPlanetDetailUniforms(
  shader: { uniforms: Record<string, { value: unknown }> },
  state: Readonly<PlanetDetailMaterialState>,
): void {
  shader.uniforms.planetDetailAtlas = state.atlas;
  shader.uniforms.planetDetailPreviousAtlas = state.previousAtlas;
  shader.uniforms.planetDetailEnabled = state.enabled;
  shader.uniforms.planetDetailOpacity = state.opacity;
  shader.uniforms.planetDetailPreviousOpacity = state.previousOpacity;
  shader.uniforms.planetDetailMatrixSize = state.matrixSize;
  shader.uniforms.planetDetailPreviousMatrixSize = state.previousMatrixSize;
  shader.uniforms.planetDetailAtlasStart = state.atlasStart;
  shader.uniforms.planetDetailPreviousAtlasStart = state.previousAtlasStart;
  shader.uniforms.planetDetailAtlasGrid = state.atlasGrid;
  shader.uniforms.planetDetailPreviousAtlasGrid = state.previousAtlasGrid;
  shader.uniforms.planetDetailColorScale = state.colorScale;
  shader.uniforms.planetDetailPreviousColorScale = state.previousColorScale;
  shader.uniforms.planetDetailColorBias = state.colorBias;
  shader.uniforms.planetDetailPreviousColorBias = state.previousColorBias;
}

export const PLANET_DETAIL_GLSL = /* glsl */ `
uniform sampler2D planetDetailAtlas;
uniform sampler2D planetDetailPreviousAtlas;
uniform float planetDetailEnabled;
uniform float planetDetailOpacity;
uniform float planetDetailPreviousOpacity;
uniform vec2 planetDetailMatrixSize;
uniform vec2 planetDetailPreviousMatrixSize;
uniform vec2 planetDetailAtlasStart;
uniform vec2 planetDetailPreviousAtlasStart;
uniform vec2 planetDetailAtlasGrid;
uniform vec2 planetDetailPreviousAtlasGrid;
uniform vec3 planetDetailColorScale;
uniform vec3 planetDetailPreviousColorScale;
uniform vec3 planetDetailColorBias;
uniform vec3 planetDetailPreviousColorBias;

vec4 samplePlanetDetailLayer(
  sampler2D detailAtlas,
  vec2 detailMatrixSize,
  vec2 detailAtlasStart,
  vec2 detailAtlasGrid,
  vec3 detailColorScale,
  vec3 detailColorBias,
  float detailOpacity,
  vec3 direction
) {
  if (detailOpacity <= 0.0) return vec4(0.0);
  vec2 page = bodyFixedUv(direction) * detailMatrixSize;
  if (page.x < detailAtlasStart.x) page.x += detailMatrixSize.x;
  if (page.x >= detailAtlasStart.x + detailAtlasGrid.x) page.x -= detailMatrixSize.x;
  vec2 local = page - detailAtlasStart;
  if (local.x < 0.0 || local.y < 0.0 || local.x >= detailAtlasGrid.x || local.y >= detailAtlasGrid.y) {
    return vec4(0.0);
  }
  vec2 atlasUv = local / detailAtlasGrid;
  vec4 texel = texture2D(detailAtlas, atlasUv);
  vec3 color = clamp(texel.rgb * detailColorScale + detailColorBias, 0.0, 1.0);
  float edge = min(min(local.x, detailAtlasGrid.x - local.x), min(local.y, detailAtlasGrid.y - local.y));
  // Blend through a substantial part of the prediction ring. A one-texel
  // feather exposes the rectangular page allocation whenever source and
  // resident-parent color transforms differ even slightly.
  float footprint = max(length(fwidth(page.x)), length(fwidth(page.y)));
  float coverage = smoothstep(0.0, max(0.45, footprint * 2.0), edge);
  // Texel alpha carries source no-data masks; opaque sources are unaffected.
  return vec4(color, coverage * detailOpacity * texel.a);
}

vec4 samplePlanetDetail(vec3 direction) {
  if (planetDetailEnabled < 0.5) return vec4(0.0);
  vec4 previous = samplePlanetDetailLayer(
    planetDetailPreviousAtlas,
    planetDetailPreviousMatrixSize,
    planetDetailPreviousAtlasStart,
    planetDetailPreviousAtlasGrid,
    planetDetailPreviousColorScale,
    planetDetailPreviousColorBias,
    planetDetailPreviousOpacity,
    direction);
  vec4 current = samplePlanetDetailLayer(
    planetDetailAtlas,
    planetDetailMatrixSize,
    planetDetailAtlasStart,
    planetDetailAtlasGrid,
    planetDetailColorScale,
    planetDetailColorBias,
    planetDetailOpacity,
    direction);
  // The two opacity weights sum to one during replacement. Add their covered
  // contributions so overlapping pages never reveal the resident parent at
  // the midpoint of an otherwise complete atlas-to-atlas transition.
  float alpha = min(1.0, current.a + previous.a);
  if (alpha <= 0.00001) return vec4(0.0);
  vec3 premultiplied = current.rgb * current.a + previous.rgb * previous.a;
  return vec4(premultiplied / alpha, alpha);
}
`;

export function planetDetailState(material: THREE.Material): PlanetDetailMaterialState | null {
  return material.userData.planetDetail as PlanetDetailMaterialState | undefined ?? null;
}
