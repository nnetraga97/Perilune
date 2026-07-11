import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GameState } from '../src/sim/state';
import { renderedTerrainHeight } from '../src/render/planet';
import { TerrestrialOcean } from '../src/render/terrestrial/ocean';

const universe = new GameState().universe;
const veyra = universe.get('veyra');

function maskTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([190, 255, 80, 128]), 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

describe('Veyra ocean', () => {
  it('owns an exact datum sphere while leaving negative terrain authoritative', () => {
    const ocean = new TerrestrialOcean(veyra, 'medium', maskTexture());
    expect(ocean.datumRadius).toBe(veyra.radius);
    expect(ocean.mesh.scale.toArray()).toEqual([veyra.radius, veyra.radius, veyra.radius]);
    expect(renderedTerrainHeight(-4_200, true)).toBe(-4_200);
    ocean.dispose();
  });

  it('updates body-local camera, sun, and deterministic simulation time', () => {
    const ocean = new TerrestrialOcean(veyra, 'high', maskTexture());
    ocean.update({
      cameraRelativeOrigin: { x: 11, y: 12, z: 13 },
      cameraBodyFixed: { x: veyra.radius + 10, y: 20, z: 30 },
      bodySunDirection: { x: 0, y: 4, z: 0 },
      time: 123.5,
    });
    expect(ocean.mesh.position.toArray()).toEqual([11, 12, 13]);
    expect((ocean.material.uniforms.uCameraBodyFixed.value as THREE.Vector3).toArray())
      .toEqual([veyra.radius + 10, 20, 30]);
    expect((ocean.material.uniforms.uSunDirection.value as THREE.Vector3).toArray()).toEqual([0, 1, 0]);
    expect(ocean.material.uniforms.uTime.value).toBe(123.5);
    ocean.dispose();
  });

  it('reduces Low glitter without changing datum authority and supports a mask fallback', () => {
    const low = new TerrestrialOcean(veyra, 'low', null);
    const high = new TerrestrialOcean(veyra, 'high', null);
    expect(low.material.uniforms.uGlitterStrength.value).toBeLessThan(high.material.uniforms.uGlitterStrength.value);
    expect(low.datumRadius).toBe(high.datumRadius);
    expect(low.material.uniforms.uHasShoreMask.value).toBe(0);
    expect(low.material.userData.shoreMaskFallback).toBe(true);
    expect(low.material.fragmentShader).toContain('float shore');
    low.dispose();
    high.dispose();
  });

  it('rejects non-ocean bodies and disposes owned resources only once', () => {
    expect(() => new TerrestrialOcean(universe.get('palla'), 'low', null)).toThrow(/no solid ocean datum/i);
    const borrowedMask = maskTexture();
    const maskDispose = vi.spyOn(borrowedMask, 'dispose');
    const ocean = new TerrestrialOcean(veyra, 'medium', borrowedMask);
    const geometryDispose = vi.spyOn(ocean.mesh.geometry, 'dispose');
    const materialDispose = vi.spyOn(ocean.mesh.material, 'dispose');
    ocean.dispose();
    ocean.dispose();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(maskDispose).not.toHaveBeenCalled();
  });
});
