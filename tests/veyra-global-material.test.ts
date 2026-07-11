import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GameState } from '../src/sim/state';
import { Vec3 } from '../src/core/vec3';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import type { RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import { PLANET_QUALITY, PlanetRenderer } from '../src/render/planet';
import {
  bodyFixedUv,
  installBodyFixedDirectionAttribute,
} from '../src/render/terrestrial/globalCoordinates';
import { createTerrestrialGlobalMaterial } from '../src/render/terrestrial/globalMaterial';

const veyra = new GameState().universe.get('veyra');
const descriptor = bodyMaterialDescriptor(veyra);

function texture(): THREE.DataTexture {
  const value = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
  value.needsUpdate = true;
  return value;
}

describe('Veyra global coordinates and material', () => {
  it('uses north-at-row-zero coordinates and remains adjacent at the longitude seam', () => {
    expect(bodyFixedUv({ x: 0, y: 0, z: 1 })).toEqual({ u: 0, v: 0 });
    expect(bodyFixedUv({ x: 0, y: 0, z: -1 })).toEqual({ u: 0, v: 1 });
    expect(bodyFixedUv({ x: 0, y: 1, z: 0 })).toEqual({ u: 0.25, v: 0.5 });
    const above = bodyFixedUv({ x: 1, y: 1e-12, z: 0 });
    const below = bodyFixedUv({ x: 1, y: -1e-12, z: 0 });
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
    const material = createTerrestrialGlobalMaterial(pack, descriptor);
    expect(material.userData).toMatchObject({ terrestrialGlobal: true, bodyId: 'veyra', authored: true });
    expect(material.vertexColors).toBe(false);
    expect(albedo.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(normal.colorSpace).toBe(THREE.NoColorSpace);
    expect(packed.colorSpace).toBe(THREE.NoColorSpace);

    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <normal_fragment_maps>',
    };
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute vec3 bodyDirection');
    expect(shader.fragmentShader).toContain('bodyFixedUv(vBodyDirection)');
    expect(shader.fragmentShader).toContain('decodeGlobalOctNormal');
    expect(shader.fragmentShader).toContain('diffuseColor.rgb *= authoredAlbedo.rgb;');
    expect(shader.fragmentShader).not.toContain('sRGBTransferEOTF(vec4(authoredAlbedo');
    expect(shader.uniforms.globalMaterialMap.value).toBe(packed);
  });

  it('keeps descriptor fallback visible and rejects incomplete authored packs', () => {
    const fallback = createTerrestrialGlobalMaterial(null, descriptor);
    expect(fallback.vertexColors).toBe(true);
    expect(fallback.color.getHex()).not.toBe(0);
    expect(() => createTerrestrialGlobalMaterial({
      bodyId: 'veyra', tier: 'low', width: 1, height: 1, manifestDigest: 'x', gpuBytes: 0,
      textures: new Map([['albedo', texture()]]),
    }, descriptor)).toThrow(/missing required normal/i);
    fallback.dispose();
  });

  it('lets terrain own an injected material and omit its legacy ocean', () => {
    const material = createTerrestrialGlobalMaterial(null, descriptor);
    const dispose = vi.spyOn(material, 'dispose');
    const renderer = new PlanetRenderer(veyra, PLANET_QUALITY.low, { material, oceanEnabled: false });
    const requestChunk = (renderer as unknown as { requestChunk(key: string, node: unknown): void }).requestChunk.bind(renderer);
    requestChunk('test', {
      face: 0, depth: 0, u0: -1, v0: -1, size: 2,
      centerDir: new Vec3(1, 0, 0), worldSize: veyra.radius * 2,
    });
    const meshes = renderer.group.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
    expect(meshes).toHaveLength(1);
    expect(meshes[0].material).toBe(material);
    expect(meshes[0].geometry.getAttribute('bodyDirection').count)
      .toBe(meshes[0].geometry.getAttribute('position').count);
    expect(meshes[0].geometry.getAttribute('bodyFixedDetailAnchor').count)
      .toBe(meshes[0].geometry.getAttribute('position').count);
    renderer.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
