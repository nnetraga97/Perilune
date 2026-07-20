import * as THREE from 'three';

export interface PlanetDetailMaterialState {
  readonly atlas: { value: THREE.Texture | null };
  readonly enabled: { value: number };
  readonly opacity: { value: number };
  readonly matrixSize: { value: THREE.Vector2 };
  readonly atlasStart: { value: THREE.Vector2 };
  readonly atlasGrid: { value: THREE.Vector2 };
  readonly colorScale: { value: THREE.Vector3 };
  readonly colorBias: { value: THREE.Vector3 };
}

export function createPlanetDetailMaterialState(): PlanetDetailMaterialState {
  return {
    atlas: { value: null },
    enabled: { value: 0 },
    opacity: { value: 0 },
    matrixSize: { value: new THREE.Vector2(1, 1) },
    atlasStart: { value: new THREE.Vector2() },
    atlasGrid: { value: new THREE.Vector2(3, 3) },
    colorScale: { value: new THREE.Vector3(1, 1, 1) },
    colorBias: { value: new THREE.Vector3() },
  };
}

export function bindPlanetDetailUniforms(
  shader: { uniforms: Record<string, { value: unknown }> },
  state: Readonly<PlanetDetailMaterialState>,
): void {
  shader.uniforms.planetDetailAtlas = state.atlas;
  shader.uniforms.planetDetailEnabled = state.enabled;
  shader.uniforms.planetDetailOpacity = state.opacity;
  shader.uniforms.planetDetailMatrixSize = state.matrixSize;
  shader.uniforms.planetDetailAtlasStart = state.atlasStart;
  shader.uniforms.planetDetailAtlasGrid = state.atlasGrid;
  shader.uniforms.planetDetailColorScale = state.colorScale;
  shader.uniforms.planetDetailColorBias = state.colorBias;
}

export const PLANET_DETAIL_GLSL = /* glsl */ `
uniform sampler2D planetDetailAtlas;
uniform float planetDetailEnabled;
uniform float planetDetailOpacity;
uniform vec2 planetDetailMatrixSize;
uniform vec2 planetDetailAtlasStart;
uniform vec2 planetDetailAtlasGrid;
uniform vec3 planetDetailColorScale;
uniform vec3 planetDetailColorBias;

vec4 samplePlanetDetail(vec3 direction) {
  if (planetDetailEnabled < 0.5) return vec4(0.0);
  vec2 page = bodyFixedUv(direction) * planetDetailMatrixSize;
  if (page.x < planetDetailAtlasStart.x) page.x += planetDetailMatrixSize.x;
  if (page.x >= planetDetailAtlasStart.x + planetDetailAtlasGrid.x) page.x -= planetDetailMatrixSize.x;
  vec2 local = page - planetDetailAtlasStart;
  if (local.x < 0.0 || local.y < 0.0 || local.x >= planetDetailAtlasGrid.x || local.y >= planetDetailAtlasGrid.y) {
    return vec4(0.0);
  }
  vec2 atlasUv = local / planetDetailAtlasGrid;
  vec3 color = clamp(texture2D(planetDetailAtlas, atlasUv).rgb * planetDetailColorScale + planetDetailColorBias, 0.0, 1.0);
  float edge = min(min(local.x, planetDetailAtlasGrid.x - local.x), min(local.y, planetDetailAtlasGrid.y - local.y));
  // Blend through a substantial part of the prediction ring. A one-texel
  // feather exposes the rectangular page allocation whenever source and
  // resident-parent color transforms differ even slightly.
  float footprint = max(length(fwidth(page.x)), length(fwidth(page.y)));
  float coverage = smoothstep(0.0, max(0.45, footprint * 2.0), edge);
  return vec4(color, coverage * planetDetailOpacity);
}
`;

export function planetDetailState(material: THREE.Material): PlanetDetailMaterialState | null {
  return material.userData.planetDetail as PlanetDetailMaterialState | undefined ?? null;
}
