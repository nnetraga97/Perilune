import * as THREE from 'three';

export type TerrainLodDitherRole = 'parent' | 'children';

export interface TerrainLodDitherBinding {
  readonly depthMaterial: THREE.MeshDepthMaterial;
  readonly distanceMaterial: THREE.MeshDistanceMaterial;
  readonly uniforms: {
    readonly role: { value: number };
    readonly progress: { value: number };
  };
  bindMesh(mesh: THREE.Mesh): void;
  setMeshTransition(mesh: THREE.Mesh, role: TerrainLodDitherRole | null, progress: number): void;
  dispose(): void;
}

interface MeshDitherState {
  role: TerrainLodDitherRole | null;
  progress: number;
}

export function terrainLodSampleVisible(
  noise: number,
  role: TerrainLodDitherRole | null,
  progress: number,
): boolean {
  if (role === null) return true;
  const clamped = Math.max(0, Math.min(1, progress));
  return role === 'parent' ? noise >= clamped : noise < clamped;
}

function patchMaterial(
  material: THREE.Material,
  uniforms: TerrainLodDitherBinding['uniforms'],
  pass: string,
): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile(shader, renderer);
    shader.uniforms.uTerrainLodRole = uniforms.role;
    shader.uniforms.uTerrainLodProgress = uniforms.progress;
    shader.fragmentShader = `uniform float uTerrainLodRole;\nuniform float uTerrainLodProgress;\n${shader.fragmentShader}`;
    const predicate = `
if (uTerrainLodRole > -0.5) {
  float terrainLodNoise = fract(52.9829189 * fract(dot(floor(gl_FragCoord.xy), vec2(0.06711056, 0.00583715))));
  if (uTerrainLodRole < 0.5) {
    if (terrainLodNoise < uTerrainLodProgress) discard;
  } else {
    if (terrainLodNoise >= uTerrainLodProgress) discard;
  }
}`;
    shader.fragmentShader = shader.fragmentShader.includes('#include <clipping_planes_fragment>')
      ? shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>${predicate}`,
      )
      : shader.fragmentShader.replace('void main() {', `void main() {${predicate}`);
  };
  material.customProgramCacheKey = () => `${previousKey()}:terrain-lod-dither:${pass}`;
  material.needsUpdate = true;
}

export function installTerrainLodDither(material: THREE.Material): TerrainLodDitherBinding {
  const uniforms = Object.freeze({
    role: { value: -1 },
    progress: { value: 0 },
  });
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const distanceMaterial = new THREE.MeshDistanceMaterial();
  patchMaterial(material, uniforms, 'color');
  patchMaterial(depthMaterial, uniforms, 'depth');
  patchMaterial(distanceMaterial, uniforms, 'distance');
  const states = new WeakMap<THREE.Mesh, MeshDitherState>();

  const apply = (mesh: THREE.Mesh): void => {
    const state = states.get(mesh) ?? { role: null, progress: 0 };
    uniforms.role.value = state.role === null ? -1 : state.role === 'parent' ? 0 : 1;
    uniforms.progress.value = Math.max(0, Math.min(1, state.progress));
  };

  return Object.freeze({
    depthMaterial,
    distanceMaterial,
    uniforms,
    bindMesh(mesh: THREE.Mesh) {
      const previousRender = mesh.onBeforeRender;
      const previousShadow = mesh.onBeforeShadow;
      mesh.customDepthMaterial = depthMaterial;
      mesh.customDistanceMaterial = distanceMaterial;
      states.set(mesh, { role: null, progress: 0 });
      mesh.onBeforeRender = function (...args) {
        apply(mesh);
        previousRender.apply(this, args);
      };
      mesh.onBeforeShadow = function (...args) {
        apply(mesh);
        previousShadow.apply(this, args);
      };
    },
    setMeshTransition(mesh: THREE.Mesh, role: TerrainLodDitherRole | null, progress: number) {
      if (!Number.isFinite(progress)) throw new Error(`Invalid terrain LOD dither progress ${progress}`);
      states.set(mesh, { role, progress: Math.max(0, Math.min(1, progress)) });
    },
    dispose() {
      depthMaterial.dispose();
      distanceMaterial.dispose();
    },
  });
}
