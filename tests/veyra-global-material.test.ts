import { createLegacyGameState } from './fixtures/legacyGameState';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GameState } from '../src/sim/state';
import { Vec3 } from '../src/core/vec3';
import { evaluateRecipeHeight, recipeForBody } from '../src/sim/terrainRecipe';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import type { RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import { PLANET_QUALITY, PlanetRenderer } from '../src/render/planet';
import {
  bodyFixedUv,
  installBodyFixedDirectionAttribute,
} from '../src/render/terrestrial/globalCoordinates';
import {
  createTerrestrialGlobalMaterial,
  updateTerrestrialCloudLighting,
} from '../src/render/terrestrial/globalMaterial';

const veyra = createLegacyGameState().universe.get('veyra');
const descriptor = bodyMaterialDescriptor(veyra);

function texture(): THREE.DataTexture {
  const value = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
  value.needsUpdate = true;
  return value;
}

describe('Veyra global coordinates and material', () => {
  const warmTerrain = async (renderer: PlanetRenderer): Promise<THREE.Mesh[]> => {
    let meshes: THREE.Mesh[] = [];
    await vi.waitFor(() => {
      renderer.update(
        { x: veyra.radius * 100, y: 0, z: 0 },
        { x: 0, y: 0, z: 0, w: 1 },
        { x: 0, y: 0, z: 0 },
      );
      meshes = [];
      renderer.engine.group.traverse((child) => {
        if (child instanceof THREE.Mesh) meshes.push(child);
      });
      expect(meshes.length).toBeGreaterThanOrEqual(6);
    }, { timeout: 2_000, interval: 10 });
    return meshes;
  };

  it('uses north-at-row-zero coordinates and remains adjacent at the longitude seam', () => {
    expect(bodyFixedUv({ x: 0, y: 0, z: 1 })).toEqual({ u: 0.5, v: 0 });
    expect(bodyFixedUv({ x: 0, y: 0, z: -1 })).toEqual({ u: 0.5, v: 1 });
    expect(bodyFixedUv({ x: 0, y: 1, z: 0 })).toEqual({ u: 0.75, v: 0.5 });
    const above = bodyFixedUv({ x: -1, y: -1e-12, z: 0 });
    const below = bodyFixedUv({ x: -1, y: 1e-12, z: 0 });
    expect(above.u + (1 - below.u)).toBeLessThan(1e-9);
  });

  it('installs normalized body directions without seam-interpolated scalar UVs', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([2, 0, 0, 0, -3, 0, 0, 0, 4], 3));
    const directions = installBodyFixedDirectionAttribute(geometry);
    expect(Array.from(directions.array)).toEqual([1, 0, 0, 0, -1, 0, 0, 0, 1]);
    expect(geometry.getAttribute('uv')).toBeUndefined();
  });

  it('binds validated authored channels with correct color spaces and shader sampling', () => {
    const albedo = texture();
    const normal = texture();
    const packed = texture();
    const clouds = texture();
    const pack: RuntimeBodyAssetPack = {
      bodyId: 'veyra', tier: 'medium', width: 2048, height: 1024,
      manifestDigest: 'digest', gpuBytes: 1,
      textures: new Map([['albedo', albedo], ['normal', normal], ['material', packed], ['clouds', clouds]]),
    };
    const material = createTerrestrialGlobalMaterial(pack, descriptor, 8);
    expect(material.userData).toMatchObject({ terrestrialGlobal: true, bodyId: 'veyra', authored: true });
    expect(material.vertexColors).toBe(false);
    expect(albedo.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(normal.colorSpace).toBe(THREE.NoColorSpace);
    expect(packed.colorSpace).toBe(THREE.NoColorSpace);
    expect(albedo.anisotropy).toBe(4);
    expect(normal.anisotropy).toBe(4);
    expect(packed.anisotropy).toBe(4);
    expect(albedo.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(normal.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(packed.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(albedo.magFilter).toBe(THREE.LinearFilter);
    expect(material.userData.maps.clouds).toBe(clouds);
    updateTerrestrialCloudLighting(material, { x: 0, y: 2, z: 0 }, 0.4);

    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <normal_fragment_maps>',
    };
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute vec3 bodyDirection');
    expect(shader.fragmentShader).toContain('bodyFixedUv(vBodyDirection)');
    expect(shader.fragmentShader).toContain('decodeGlobalOctNormal');
    expect(shader.fragmentShader).not.toContain('vec3 globalBodyNormal =');
    expect(shader.fragmentShader).toContain('#include <normal_fragment_maps>');
    expect(shader.fragmentShader).toContain('mix(globalLandAlbedo, globalOceanColor, globalOceanOwnership)');
    expect(shader.fragmentShader).toContain('samplePlanetDetail(vBodyDirection)');
    expect(shader.fragmentShader).toContain('useGlobalSurfaceClassMap > 0.5');
    expect(shader.fragmentShader).toContain('cloudShadowCoverage');
    expect(shader.fragmentShader).not.toContain('sRGBTransferEOTF(vec4(authoredAlbedo');
    expect(shader.uniforms.globalMaterialMap.value).toBe(packed);
    expect(shader.uniforms.globalCloudMap.value).toBe(clouds);
    expect(shader.uniforms.useGlobalIceMap.value).toBe(0);
    expect((shader.uniforms.globalSunDirection.value as THREE.Vector3).toArray()).toEqual([0, 1, 0]);
    expect(shader.uniforms.globalCloudDriftAngle.value).toBe(0.4);
  });

  it('keeps descriptor fallback visible and rejects incomplete authored packs', () => {
    const fallback = createTerrestrialGlobalMaterial(null, descriptor);
    expect(fallback.vertexColors).toBe(true);
    expect(fallback.color.getHex()).not.toBe(0);
    expect(fallback.userData.maps.albedo.minFilter).toBe(THREE.LinearFilter);
    expect(() => createTerrestrialGlobalMaterial({
      bodyId: 'veyra', tier: 'low', width: 1, height: 1, manifestDigest: 'x', gpuBytes: 0,
      textures: new Map([['albedo', texture()]]),
    }, descriptor)).toThrow(/missing required normal/i);
    fallback.dispose();
  });

  it('lets terrain own chunk material clones while retaining ownership of the injected base material', async () => {
    const material = createTerrestrialGlobalMaterial(null, descriptor);
    const dispose = vi.spyOn(material, 'dispose');
    const renderer = new PlanetRenderer(veyra, PLANET_QUALITY.low, { material, oceanEnabled: false });
    const meshes = await warmTerrain(renderer);
    expect(meshes.length).toBeGreaterThanOrEqual(6);
    const firstMaterial = meshes[0].material as THREE.MeshStandardMaterial;
    const secondMaterial = meshes[1].material as THREE.MeshStandardMaterial;
    expect(firstMaterial).not.toBe(material);
    expect(secondMaterial).not.toBe(firstMaterial);
    expect(firstMaterial.customProgramCacheKey()).toBe(secondMaterial.customProgramCacheKey());
    expect(firstMaterial.customProgramCacheKey()).toContain('terrestrial-global-v4:palette');
    expect(firstMaterial.customProgramCacheKey()).toContain('terrain-lod-dither:color');
    expect(firstMaterial.vertexColors).toBe(material.vertexColors);
    expect(firstMaterial.userData.maps).toBe(material.userData.maps);
    expect(firstMaterial.userData.terrestrialCloudLighting)
      .toBe(material.userData.terrestrialCloudLighting);
    expect(meshes[0].geometry.getAttribute('bodyDirection').count)
      .toBe(meshes[0].geometry.getAttribute('position').count);
    expect(meshes[0].geometry.getAttribute('bodyFixedDetailAnchor').count)
      .toBe(meshes[0].geometry.getAttribute('position').count);

    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <clipping_planes_fragment>\n#include <map_fragment>\n#include <normal_fragment_maps>',
    };
    firstMaterial.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute vec3 bodyDirection');
    expect(shader.fragmentShader).toContain('bodyFixedUv(vBodyDirection)');
    expect(shader.fragmentShader).toContain('terrainLodNoise');
    updateTerrestrialCloudLighting(material, { x: 0, y: 1, z: 0 }, 0.6);
    expect((shader.uniforms.globalSunDirection.value as THREE.Vector3).toArray()).toEqual([0, 1, 0]);
    expect(shader.uniforms.globalCloudDriftAngle.value).toBe(0.6);

    const chunkDispose = vi.spyOn(firstMaterial, 'dispose');
    const depthDispose = vi.spyOn(meshes[0].customDepthMaterial!, 'dispose');
    const distanceDispose = vi.spyOn(meshes[0].customDistanceMaterial!, 'dispose');
    renderer.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(chunkDispose).toHaveBeenCalledOnce();
    expect(depthDispose).toHaveBeenCalledOnce();
    expect(distanceDispose).toHaveBeenCalledOnce();
  });

  it('installs a per-vertex surface altitude attribute matching the evaluator', async () => {
    const renderer = new PlanetRenderer(veyra, PLANET_QUALITY.low, { oceanEnabled: false });
    const mesh = (await warmTerrain(renderer))[0];
    const altitude = mesh.geometry.getAttribute('surfaceAltitude');
    const direction = mesh.geometry.getAttribute('bodyDirection');
    expect(altitude.count).toBe(direction.count);
    const recipe = recipeForBody(veyra);
    // Sample only the main grid; skirt vertices are intentionally sunk.
    const mainCount = PLANET_QUALITY.low.gridRes * PLANET_QUALITY.low.gridRes;
    for (let i = 0; i < mainCount; i += 7) {
      const expected = evaluateRecipeHeight(recipe, new Vec3(direction.getX(i), direction.getY(i), direction.getZ(i)));
      expect(Math.abs(altitude.getX(i) - expected)).toBeLessThan(0.5);
    }
    renderer.dispose();
  });
});
