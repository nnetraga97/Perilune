import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  categorizeResources,
  drawingBufferResourceBytes,
  fullMipChainBytes,
  geometryByteLength,
  instancedResourceBytes,
} from '../src/render/resourceAccounting';

describe('resource accounting', () => {
  it('counts every BufferGeometry attribute and its index', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Int16Array(12), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Uint16Array(8), 2));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2, 2, 3, 0]), 1));

    expect(geometryByteLength(geometry)).toBe(48 + 24 + 16 + 24);
  });

  it('counts instanced geometry plus per-instance matrix and color buffers', () => {
    const geometry = new THREE.PlaneGeometry(1, 1); // pos(12)+normal(12)+uv(8) f32 + index
    const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial(), 10);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(10 * 3), 3);
    const expected = geometryByteLength(geometry) + 10 * 16 * 4 + 10 * 3 * 4;
    expect(instancedResourceBytes(mesh)).toBe(expected);
    mesh.dispose();
  });

  it('counts full mip chains, faces, layers, and samples', () => {
    expect(fullMipChainBytes({ width: 4, height: 2, bytesPerPixel: 4 })).toBe((8 + 2 + 1) * 4);
    expect(fullMipChainBytes({
      width: 4, height: 2, bytesPerPixel: 4, faces: 6, layers: 2, samples: 4,
    })).toBe((8 + 2 + 1) * 4 * 6 * 2 * 4);
  });

  it('derives color and depth storage from actual drawing-buffer samples', () => {
    expect(drawingBufferResourceBytes(10, 5, 4)).toEqual({
      width: 10,
      height: 5,
      samples: 4,
      colorBytes: 800,
      depthBytes: 800,
      totalBytes: 1600,
    });
  });

  it('produces exact categorized active and renderer sums', () => {
    const resources = categorizeResources({
      activeBody: { terrainGeometryBytes: 10, shadowBytes: 20 },
      rendererOnly: { starfieldGeometryBytes: 5, drawingBufferColorBytes: 7 },
      transientBytes: 3,
    });
    expect(resources.activeBodyBytes).toBe(30);
    expect(resources.totalRendererBytes).toBe(42);
    expect(resources.uncompressedWorstCaseBytes).toBe(45);
  });
});
