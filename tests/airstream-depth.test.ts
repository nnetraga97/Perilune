import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AirstreamDepthPass } from '../src/render/airstreamDepth';

describe('airstream occlusion depth contract', () => {
  it('projects the upstream face before the downstream face using conventional depth', () => {
    const pass = new AirstreamDepthPass(new THREE.BoxGeometry(2, 2, 2), 64);
    pass.update(new THREE.Vector3(0, 1, 0));
    const upstream = new THREE.Vector3(0, 1, 0).applyMatrix4(pass.matrix);
    const downstream = new THREE.Vector3(0, -1, 0).applyMatrix4(pass.matrix);
    expect(upstream.z).toBeLessThan(downstream.z);
    expect(pass.target.depthTexture).toBeInstanceOf(THREE.DepthTexture);
    expect(pass.texelSize.toArray()).toEqual([1 / 64, 1 / 64]);
    for (const value of pass.matrix.elements) expect(Number.isFinite(value)).toBe(true);
    pass.dispose();
  });
});
