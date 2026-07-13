import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { installTerrainLodDither, terrainLodSampleVisible } from '../src/render/terrain/lodDither';

function compile(material: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, { value: number }>,
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
    const shaders = [color, binding.depthMaterial, binding.distanceMaterial].map(compile);
    for (const shader of shaders) {
      expect(shader.fragmentShader).toContain('floor(gl_FragCoord.xy)');
      expect(shader.fragmentShader).toContain('terrainLodNoise < uTerrainLodProgress');
      expect(shader.fragmentShader).toContain('terrainLodNoise >= uTerrainLodProgress');
      expect(shader.fragmentShader).not.toMatch(/time/i);
      expect(shader.uniforms.uTerrainLodRole).toBe(binding.uniforms.role);
      expect(shader.uniforms.uTerrainLodProgress).toBe(binding.uniforms.progress);
    }
    expect(color.customProgramCacheKey()).toContain('terrain-lod-dither:color');
    expect(binding.depthMaterial.customProgramCacheKey()).toContain('terrain-lod-dither:depth');
    binding.dispose();
    color.dispose();
  });

  it('updates shared uniforms per mesh draw without cloning the material', () => {
    const material = new THREE.MeshBasicMaterial();
    const binding = installTerrainLodDither(material);
    const parent = new THREE.Mesh(new THREE.PlaneGeometry(), material);
    const child = new THREE.Mesh(new THREE.PlaneGeometry(), material);
    binding.bindMesh(parent);
    binding.bindMesh(child);
    binding.setMeshTransition(parent, 'parent', 0.4);
    binding.setMeshTransition(child, 'children', 0.4);
    parent.onBeforeRender(...Array(8).fill(null) as Parameters<typeof parent.onBeforeRender>);
    expect(binding.uniforms).toMatchObject({ role: { value: 0 }, progress: { value: 0.4 } });
    child.onBeforeRender(...Array(8).fill(null) as Parameters<typeof child.onBeforeRender>);
    expect(binding.uniforms).toMatchObject({ role: { value: 1 }, progress: { value: 0.4 } });
    expect(parent.material).toBe(child.material);
    expect(parent.customDepthMaterial).toBe(binding.depthMaterial);
    const depthDispose = vi.spyOn(binding.depthMaterial, 'dispose');
    binding.dispose();
    expect(depthDispose).toHaveBeenCalledOnce();
    parent.geometry.dispose();
    child.geometry.dispose();
    material.dispose();
  });
});
