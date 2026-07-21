import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import type { BodyRenderFrame } from '../src/render/bodyRenderer';
import type { RenderCaps } from '../src/render/context';
import { SolarBodyRenderer } from '../src/render/solarBodyRenderer';

const caps: RenderCaps = {
  backend: 'webgl2',
  fragmentHighp: { precision: 23, rangeMin: 127, rangeMax: 127 },
  atmospherePath: 'analytic',
  compressedTextures: {
    astc: false, etc2: true, etc1: false, s3tc: false, bptc: false, pvrtc: false,
  },
  maxTextureSize: 8192,
  maxAnisotropy: 8,
  drawingBufferSamples: 4,
};

function frame(overrides: Partial<BodyRenderFrame> = {}): BodyRenderFrame {
  return {
    cameraRelativeOrigin: { x: 149_597_870_700, y: 0, z: 0 },
    cameraBodyFixed: { x: 0, y: 0, z: 0 },
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 3,
    drawingBufferHeight: 1080,
    projection: {
      trueObserverDistance: 149_597_870_700,
      angularRadius: 0.00465047,
      projectedPixelRadius: 4.35,
      proxyDepth: 444_000_000,
      proxyRadius: 2_064_000,
      visibility: 'far-field',
    },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraSunDirection: { x: 1, y: 0, z: 0 },
    bodySunDirection: { x: 1, y: 0, z: 0 },
    solarVisibleFraction: 1,
    time: 0,
    deltaSeconds: 1 / 60,
    framePressure: false,
    altitude: 0,
    allowFlightTerrain: false,
    ...overrides,
  };
}

function renderer(): SolarBodyRenderer {
  const sun = new Body(structuredClone(SOL_SYSTEM.find((body) => body.id === 'sun')!), null);
  return new SolarBodyRenderer(sun, bodyMaterialDescriptor(sun), caps, 'medium');
}

describe('SolarBodyRenderer', () => {
  it('uses one finite proxy with logarithmic depth and no unreachable physical branch', () => {
    const solar = renderer();
    solar.update(frame());
    expect(solar.root.getObjectByName('solar-physical:sun')).toBeUndefined();
    const proxy = solar.root.getObjectByName('solar-proxy:sun')!;
    expect(proxy.visible).toBe(true);
    expect(proxy.position.length()).toBeCloseTo(444_000_000, 3);
    const disk = proxy.children.find((child) => (
      child instanceof THREE.Mesh && child.material.userData.solarPhotosphere
    )) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(disk.material.vertexShader).toContain('#include <logdepthbuf_vertex>');
    expect(disk.material.fragmentShader).toContain('#include <logdepthbuf_fragment>');
    expect(solar.shadowLight.name).toBe('solar-direct:sun');
    expect(solar.stats().presentationMode).toBe('proxy');
    solar.dispose();
  });

  it('feeds the strongest analytic occulter into a disk-space limb mask', () => {
    const solar = renderer();
    solar.update(frame({
      solarVisibleFraction: 0,
      solarOccluder: {
        direction: { x: 1, y: 0, z: 0 },
        angularRadius: 0.0047,
      },
    }));
    const disk = solar.root.getObjectByName('solar-proxy:sun')!.children.find((child) => (
      child instanceof THREE.Mesh && child.material.userData.solarPhotosphere
    )) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(disk.material.uniforms.uUseOccluder.value).toBe(1);
    expect(disk.material.uniforms.uOccluderCenter.value.length()).toBeLessThan(1e-8);
    expect(disk.material.uniforms.uOccluderRadius.value).toBeGreaterThan(1);
    expect(solar.shadowLight.intensity).toBe(0);
    solar.dispose();
  });

  it('disables a stale zero-radius occulter without reallocating the frame contract', () => {
    const solar = renderer();
    solar.update(frame({
      solarOccluder: { direction: { x: 0, y: 0, z: 0 }, angularRadius: 0 },
    }));
    const disk = solar.root.getObjectByName('solar-proxy:sun')!.children.find((child) => (
      child instanceof THREE.Mesh && child.material.userData.solarPhotosphere
    )) as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(disk.material.uniforms.uUseOccluder.value).toBe(0);
    solar.dispose();
  });
});
