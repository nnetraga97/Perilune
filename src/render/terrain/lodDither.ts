import * as THREE from 'three';

export type TerrainLodDitherRole = 'parent' | 'children';

export interface TerrainLodDitherUniforms {
  readonly role: { value: number };
  readonly progress: { value: number };
}

export interface TerrainLodDitherBinding {
  bindMesh(mesh: THREE.Mesh): void;
  setMeshTransition(mesh: THREE.Mesh, role: TerrainLodDitherRole | null, progress: number): void;
  uniformsFor(mesh: THREE.Mesh): TerrainLodDitherUniforms | null;
  disposeMesh(mesh: THREE.Mesh): void;
  dispose(): void;
}

interface MeshDitherBinding {
  readonly mesh: THREE.Mesh;
  readonly colorMaterial: THREE.Material;
  readonly depthMaterial: THREE.MeshDepthMaterial;
  readonly distanceMaterial: THREE.MeshDistanceMaterial;
  readonly uniforms: TerrainLodDitherUniforms;
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
  uniforms: TerrainLodDitherUniforms,
  pass: string,
): void {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
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
  material.customProgramCacheKey = () => `${previousKey.call(material)}:terrain-lod-dither:${pass}`;
  material.needsUpdate = true;
}

function cloneWithShaderHooks(material: THREE.Material): THREE.Material {
  const cloned = material.clone();
  cloned.defines = material.defines ? { ...material.defines } : undefined;
  // Material.copy JSON-clones userData, which strips runtime values such as
  // Vector3 instances. Preserve those values by reference while keeping the
  // top-level metadata object independently extensible for each chunk.
  cloned.userData = { ...material.userData };
  cloned.onBeforeCompile = material.onBeforeCompile;
  cloned.customProgramCacheKey = material.customProgramCacheKey;
  return cloned;
}

export function installTerrainLodDither(material: THREE.Material): TerrainLodDitherBinding {
  const bindings = new WeakMap<THREE.Mesh, MeshDitherBinding>();
  const owned = new Set<MeshDitherBinding>();

  const release = (binding: MeshDitherBinding): void => {
    binding.colorMaterial.dispose();
    binding.depthMaterial.dispose();
    binding.distanceMaterial.dispose();
    bindings.delete(binding.mesh);
    owned.delete(binding);
  };

  return Object.freeze({
    bindMesh(mesh: THREE.Mesh) {
      if (bindings.has(mesh)) return;
      if (Array.isArray(mesh.material)) throw new Error('Terrain LOD dither requires one material per chunk');
      const uniforms = Object.freeze({
        role: { value: -1 },
        progress: { value: 0 },
      });
      const colorMaterial = cloneWithShaderHooks(material);
      const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      const distanceMaterial = new THREE.MeshDistanceMaterial();
      patchMaterial(colorMaterial, uniforms, 'color');
      patchMaterial(depthMaterial, uniforms, 'depth');
      patchMaterial(distanceMaterial, uniforms, 'distance');
      mesh.material = colorMaterial;
      mesh.customDepthMaterial = depthMaterial;
      mesh.customDistanceMaterial = distanceMaterial;
      const binding = Object.freeze({ mesh, colorMaterial, depthMaterial, distanceMaterial, uniforms });
      bindings.set(mesh, binding);
      owned.add(binding);
    },
    setMeshTransition(mesh: THREE.Mesh, role: TerrainLodDitherRole | null, progress: number) {
      if (!Number.isFinite(progress)) throw new Error(`Invalid terrain LOD dither progress ${progress}`);
      const binding = bindings.get(mesh);
      if (!binding) throw new Error('Terrain LOD dither mesh is not bound');
      binding.uniforms.role.value = role === null ? -1 : role === 'parent' ? 0 : 1;
      binding.uniforms.progress.value = Math.max(0, Math.min(1, progress));
    },
    uniformsFor(mesh: THREE.Mesh) {
      return bindings.get(mesh)?.uniforms ?? null;
    },
    disposeMesh(mesh: THREE.Mesh) {
      const binding = bindings.get(mesh);
      if (binding) release(binding);
    },
    dispose() {
      for (const binding of [...owned]) release(binding);
    },
  });
}
