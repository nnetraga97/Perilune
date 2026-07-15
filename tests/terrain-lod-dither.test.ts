import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { installTerrainLodDither, terrainLodSampleVisible } from '../src/render/terrain/lodDither';

function compile(material: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '',
    fragmentShader: '#include <clipping_planes_fragment>',
  };
  material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
  return shader;
}

describe('terrain LOD complementary dither', () => {
  it('assigns every sample to exactly one replacement side', () => {
    for (let step = 0; step <= 100; step++) {
      const progress = step / 100;
      for (let sample = 0; sample < 100; sample++) {
        const noise = (sample + 0.5) / 100;
        const parent = terrainLodSampleVisible(noise, 'parent', progress);
        const children = terrainLodSampleVisible(noise, 'children', progress);
        expect(Number(parent) + Number(children)).toBe(1);
      }
    }
    expect(terrainLodSampleVisible(0.5, null, 0.5)).toBe(true);
  });

  it('installs the identical stable predicate in color, depth, and distance passes', () => {
    const color = new THREE.MeshStandardMaterial();
    const binding = installTerrainLodDither(color);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), color);
    binding.bindMesh(mesh);
    binding.setMeshTransition(mesh, 'children', 0.35);
    const shaders = [mesh.material, mesh.customDepthMaterial!, mesh.customDistanceMaterial!].map((material) => (
      compile(material as THREE.Material)
    ));
    const uniforms = binding.uniformsFor(mesh)!;
    for (const shader of shaders) {
      expect(shader.fragmentShader).toContain('floor(gl_FragCoord.xy)');
      expect(shader.fragmentShader).toContain('terrainLodNoise < uTerrainLodProgress');
      expect(shader.fragmentShader).toContain('terrainLodNoise >= uTerrainLodProgress');
      expect(shader.fragmentShader).not.toMatch(/time/i);
      expect(shader.uniforms.uTerrainLodRole).toBe(uniforms.role);
      expect(shader.uniforms.uTerrainLodProgress).toBe(uniforms.progress);
      expect(shader.uniforms.uTerrainLodRole.value).toBe(1);
      expect(shader.uniforms.uTerrainLodProgress.value).toBe(0.35);
    }
    expect((mesh.material as THREE.Material).customProgramCacheKey()).toContain('terrain-lod-dither:color');
    expect(mesh.customDepthMaterial!.customProgramCacheKey()).toContain('terrain-lod-dither:depth');
    binding.dispose();
    mesh.geometry.dispose();
    color.dispose();
  });

  it('owns per-chunk uniforms while sharing shader program cache keys', () => {
    const material = new THREE.MeshBasicMaterial();
    const binding = installTerrainLodDither(material);
    const parent = new THREE.Mesh(new THREE.PlaneGeometry(), material);
    const child = new THREE.Mesh(new THREE.PlaneGeometry(), material);
    binding.bindMesh(parent);
    binding.bindMesh(child);
    binding.setMeshTransition(parent, 'parent', 0.4);
    binding.setMeshTransition(child, 'children', 0.4);
    expect(binding.uniformsFor(parent)).toMatchObject({ role: { value: 0 }, progress: { value: 0.4 } });
    expect(binding.uniformsFor(child)).toMatchObject({ role: { value: 1 }, progress: { value: 0.4 } });
    expect(binding.uniformsFor(parent)).not.toBe(binding.uniformsFor(child));
    expect(parent.material).not.toBe(child.material);
    expect((parent.material as THREE.Material).customProgramCacheKey())
      .toBe((child.material as THREE.Material).customProgramCacheKey());
    const parentColor = parent.material as THREE.Material;
    const parentDepth = parent.customDepthMaterial!;
    const parentDistance = parent.customDistanceMaterial!;
    const colorDispose = vi.spyOn(parentColor, 'dispose');
    const depthDispose = vi.spyOn(parentDepth, 'dispose');
    const distanceDispose = vi.spyOn(parentDistance, 'dispose');
    binding.disposeMesh(parent);
    binding.disposeMesh(parent);
    expect(colorDispose).toHaveBeenCalledOnce();
    expect(depthDispose).toHaveBeenCalledOnce();
    expect(distanceDispose).toHaveBeenCalledOnce();
    expect(binding.uniformsFor(parent)).toBeNull();
    expect(binding.uniformsFor(child)).not.toBeNull();
    binding.dispose();
    expect(colorDispose).toHaveBeenCalledOnce();
    expect(depthDispose).toHaveBeenCalledOnce();
    expect(distanceDispose).toHaveBeenCalledOnce();
    parent.geometry.dispose();
    child.geometry.dispose();
    material.dispose();
  });

  it('preserves base shader hooks, cache keys, maps, defines, and runtime user data', () => {
    const map = new THREE.Texture();
    const runtimeDirection = new THREE.Vector3(1, 0, 0);
    const base = new THREE.MeshStandardMaterial({ map });
    base.defines = { TERRAIN_GLOBAL_MAP: 1 };
    base.userData.runtimeDirection = runtimeDirection;
    base.customProgramCacheKey = () => 'terrain-global-program';
    const baseCompile = vi.fn((shader: THREE.WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uRuntimeDirection = { value: runtimeDirection };
      shader.fragmentShader = `// terrain-global-hook\n${shader.fragmentShader}`;
    });
    base.onBeforeCompile = baseCompile;

    const binding = installTerrainLodDither(base);
    const first = new THREE.Mesh(new THREE.PlaneGeometry(), base);
    const second = new THREE.Mesh(new THREE.PlaneGeometry(), base);
    binding.bindMesh(first);
    binding.bindMesh(second);

    const firstMaterial = first.material as THREE.MeshStandardMaterial;
    const secondMaterial = second.material as THREE.MeshStandardMaterial;
    const shader = compile(firstMaterial);
    expect(baseCompile).toHaveBeenCalledOnce();
    expect(shader.fragmentShader).toContain('terrain-global-hook');
    expect(shader.uniforms.uRuntimeDirection.value).toBe(runtimeDirection);
    expect(firstMaterial.map).toBe(map);
    expect(firstMaterial.defines).toEqual(base.defines);
    expect(firstMaterial.userData.runtimeDirection).toBe(runtimeDirection);
    expect(firstMaterial.userData).not.toBe(base.userData);
    expect(firstMaterial.customProgramCacheKey()).toBe('terrain-global-program:terrain-lod-dither:color');
    expect(secondMaterial.customProgramCacheKey()).toBe(firstMaterial.customProgramCacheKey());

    runtimeDirection.set(0, 1, 0);
    expect((shader.uniforms.uRuntimeDirection.value as THREE.Vector3).toArray()).toEqual([0, 1, 0]);

    binding.dispose();
    first.geometry.dispose();
    second.geometry.dispose();
    base.dispose();
    map.dispose();
  });
});
