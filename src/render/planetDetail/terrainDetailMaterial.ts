import * as THREE from 'three';

/** Fixed 3x3 neighborhood retained around the low-altitude camera footprint. */
export const TERRAIN_DETAIL_ATLAS_GRID = 3;
export const TERRAIN_DETAIL_PAGE_SLOTS = TERRAIN_DETAIL_ATLAS_GRID ** 2;

export interface TerrainDetailMaterialSlotState {
  readonly normalEnabled: { value: number };
  readonly face: { value: number };
  readonly bounds: { value: THREE.Vector3 };
  readonly gutterScaleBias: { value: THREE.Vector2 };
  readonly colorScale: { value: THREE.Vector3 };
  readonly colorBias: { value: THREE.Vector3 };
}

export interface TerrainDetailMaterialState {
  readonly pageAtlas: { value: THREE.Texture | null };
  readonly normalAtlas: { value: THREE.Texture | null };
  readonly enabled: { value: number };
  readonly opacity: { value: number };
  readonly pageCount: { value: number };
  readonly normalStrength: { value: number };
  readonly slots: readonly TerrainDetailMaterialSlotState[];
}

function createSlot(): TerrainDetailMaterialSlotState {
  return {
    normalEnabled: { value: 0 },
    face: { value: 0 },
    bounds: { value: new THREE.Vector3(-1, -1, 2) },
    gutterScaleBias: { value: new THREE.Vector2(1, 0) },
    colorScale: { value: new THREE.Vector3(1, 1, 1) },
    colorBias: { value: new THREE.Vector3() },
  };
}

export function createTerrainDetailMaterialState(): TerrainDetailMaterialState {
  return {
    pageAtlas: { value: null },
    normalAtlas: { value: null },
    enabled: { value: 0 },
    opacity: { value: 0 },
    pageCount: { value: 0 },
    normalStrength: { value: 0.72 },
    slots: Object.freeze(Array.from({ length: TERRAIN_DETAIL_PAGE_SLOTS }, createSlot)),
  };
}

export function bindTerrainDetailUniforms(
  shader: { uniforms: Record<string, { value: unknown }> },
  state: Readonly<TerrainDetailMaterialState>,
): void {
  shader.uniforms.terrainDetailEnabled = state.enabled;
  shader.uniforms.terrainDetailPageAtlas = state.pageAtlas;
  shader.uniforms.terrainDetailNormalAtlas = state.normalAtlas;
  shader.uniforms.terrainDetailOpacity = state.opacity;
  shader.uniforms.terrainDetailPageCount = state.pageCount;
  shader.uniforms.terrainDetailNormalStrength = state.normalStrength;
  state.slots.forEach((slot, index) => {
    shader.uniforms[`terrainDetailNormalEnabled${index}`] = slot.normalEnabled;
    shader.uniforms[`terrainDetailFace${index}`] = slot.face;
    shader.uniforms[`terrainDetailBounds${index}`] = slot.bounds;
    shader.uniforms[`terrainDetailGutterScaleBias${index}`] = slot.gutterScaleBias;
    shader.uniforms[`terrainDetailColorScale${index}`] = slot.colorScale;
    shader.uniforms[`terrainDetailColorBias${index}`] = slot.colorBias;
  });
}

const SLOT_UNIFORMS = Array.from({ length: TERRAIN_DETAIL_PAGE_SLOTS }, (_, index) => `
uniform float terrainDetailNormalEnabled${index};
uniform float terrainDetailFace${index};
uniform vec3 terrainDetailBounds${index};
uniform vec2 terrainDetailGutterScaleBias${index};
uniform vec3 terrainDetailColorScale${index};
uniform vec3 terrainDetailColorBias${index};`).join('');

const COLOR_SAMPLES = Array.from({ length: TERRAIN_DETAIL_PAGE_SLOTS }, (_, index) => `
  if (terrainDetailPageCount > ${index}.5) {
    vec4 candidate${index} = sampleTerrainDetailSlot(
      terrainDetailPageAtlas, ${index}.0, terrainDetailFace${index}, terrainDetailBounds${index},
      terrainDetailGutterScaleBias${index}, terrainDetailColorScale${index}, terrainDetailColorBias${index}, direction
    );
    if (candidate${index}.a > result.a) result = candidate${index};
  }`).join('');

const NORMAL_SAMPLES = Array.from({ length: TERRAIN_DETAIL_PAGE_SLOTS }, (_, index) => `
  if (terrainDetailPageCount > ${index}.5 && terrainDetailNormalEnabled${index} > 0.5) {
    vec4 candidate${index} = sampleTerrainDetailNormalSlot(
      terrainDetailNormalAtlas, ${index}.0, terrainDetailFace${index}, terrainDetailBounds${index},
      terrainDetailGutterScaleBias${index}, direction
    );
    if (candidate${index}.a > result.a) result = candidate${index};
  }`).join('');

export const TERRAIN_DETAIL_GLSL = /* glsl */ `
uniform float terrainDetailEnabled;
uniform sampler2D terrainDetailPageAtlas;
uniform sampler2D terrainDetailNormalAtlas;
uniform float terrainDetailOpacity;
uniform float terrainDetailPageCount;
uniform float terrainDetailNormalStrength;
${SLOT_UNIFORMS}

void terrainDetailBasis(float face, out vec3 n, out vec3 u, out vec3 v) {
  if (face < 0.5) { n=vec3(1,0,0); u=vec3(0,1,0); v=vec3(0,0,1); }
  else if (face < 1.5) { n=vec3(-1,0,0); u=vec3(0,-1,0); v=vec3(0,0,1); }
  else if (face < 2.5) { n=vec3(0,1,0); u=vec3(0,0,1); v=vec3(1,0,0); }
  else if (face < 3.5) { n=vec3(0,-1,0); u=vec3(0,0,-1); v=vec3(1,0,0); }
  else if (face < 4.5) { n=vec3(0,0,1); u=vec3(1,0,0); v=vec3(0,1,0); }
  else { n=vec3(0,0,-1); u=vec3(-1,0,0); v=vec3(0,1,0); }
}

float terrainDetailCoordinates(
  float face, vec3 bounds, vec2 gutterScaleBias, vec3 direction, out vec2 pageUv
) {
  vec3 n; vec3 u; vec3 v;
  terrainDetailBasis(face, n, u, v);
  float denominator = dot(direction, n);
  if (denominator <= 0.0) return 0.0;
  vec2 faceUv = vec2(atan(dot(direction, u) / denominator), atan(dot(direction, v) / denominator)) / (3.141592653589793 / 4.0);
  vec2 local = (faceUv - bounds.xy) / bounds.z;
  if (local.x < 0.0 || local.y < 0.0 || local.x > 1.0 || local.y > 1.0) return 0.0;
  pageUv = local * gutterScaleBias.x + gutterScaleBias.y;
  float edge = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
  float footprint = max(length(fwidth(local.x)), length(fwidth(local.y)));
  return smoothstep(0.0, max(0.12, footprint * 2.0), edge);
}

vec4 sampleTerrainDetailSlot(
  sampler2D page, float slotIndex, float face, vec3 bounds, vec2 gutterScaleBias,
  vec3 colorScale, vec3 colorBias, vec3 direction
) {
  vec2 pageUv = vec2(0.5);
  float coverage = terrainDetailCoordinates(face, bounds, gutterScaleBias, direction, pageUv);
  if (coverage <= 0.0) return vec4(0.0);
  vec2 atlasOffset = vec2(mod(slotIndex, ${TERRAIN_DETAIL_ATLAS_GRID}.0), floor(slotIndex / ${TERRAIN_DETAIL_ATLAS_GRID}.0))
    / ${TERRAIN_DETAIL_ATLAS_GRID}.0;
  vec4 pageSample = texture2D(page, pageUv / ${TERRAIN_DETAIL_ATLAS_GRID}.0 + atlasOffset);
  vec3 color = clamp(pageSample.rgb * colorScale + colorBias, 0.0, 1.0);
  return vec4(color, terrainDetailOpacity * coverage * pageSample.a);
}

vec4 sampleTerrainDetailNormalSlot(
  sampler2D page, float slotIndex, float face, vec3 bounds, vec2 gutterScaleBias, vec3 direction
) {
  vec2 pageUv = vec2(0.5);
  float coverage = terrainDetailCoordinates(face, bounds, gutterScaleBias, direction, pageUv);
  if (coverage <= 0.0) return vec4(0.0);
  vec2 atlasOffset = vec2(mod(slotIndex, ${TERRAIN_DETAIL_ATLAS_GRID}.0), floor(slotIndex / ${TERRAIN_DETAIL_ATLAS_GRID}.0))
    / ${TERRAIN_DETAIL_ATLAS_GRID}.0;
  vec4 encoded = texture2D(page, pageUv / ${TERRAIN_DETAIL_ATLAS_GRID}.0 + atlasOffset);
  vec3 bodyNormal = normalize(encoded.rgb * 2.0 - 1.0);
  return vec4(bodyNormal, terrainDetailOpacity * coverage * encoded.a);
}

vec4 sampleTerrainDetail(vec3 rawDirection) {
  if (terrainDetailEnabled < 0.5) return vec4(0.0);
  vec3 direction = normalize(rawDirection);
  vec4 result = vec4(0.0);
  ${COLOR_SAMPLES}
  return result;
}

vec4 sampleTerrainDetailNormal(vec3 rawDirection) {
  if (terrainDetailEnabled < 0.5) return vec4(0.0);
  vec3 direction = normalize(rawDirection);
  vec4 result = vec4(0.0);
  ${NORMAL_SAMPLES}
  return result;
}
`;

export function terrainDetailState(material: THREE.Material): TerrainDetailMaterialState | null {
  return material.userData.terrainDetail as TerrainDetailMaterialState | undefined ?? null;
}
