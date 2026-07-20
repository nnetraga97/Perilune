import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import { AirlessBodyRenderer } from '../src/render/airlessBodyRenderer';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import type { BodyRenderFrame, RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import type { RenderCaps } from '../src/render/context';

const caps: RenderCaps = {
  backend: 'webgl2', fragmentHighp: { precision: 23, rangeMin: 127, rangeMax: 127 },
  atmospherePath: 'analytic',
  compressedTextures: {
    astc: false, etc2: true, etc1: false, s3tc: false, bptc: false, pvrtc: false,
  },
  maxTextureSize: 8192, maxAnisotropy: 8, drawingBufferSamples: 4,
};

function moon(): Body {
  return new Body(structuredClone(SOL_SYSTEM.find((body) => body.id === 'moon')!), null);
}

function texture(): THREE.DataTexture {
  const value = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  value.needsUpdate = true;
  return value;
}

function pack(): RuntimeBodyAssetPack & { textures: Map<string, THREE.Texture> } {
  return {
    bodyId: 'moon', tier: 'medium', width: 2048, height: 1024,
    manifestDigest: 'a'.repeat(64), gpuBytes: 1234,
    textures: new Map(['albedo', 'normal', 'material', 'heightMacro', 'localDetail']
      .map((channel) => [channel, texture()])),
  };
}

function frame(body: Body, overrides: Partial<BodyRenderFrame> = {}): BodyRenderFrame {
  return {
    cameraRelativeOrigin: { x: body.radius * 2, y: 0, z: 0 },
    cameraBodyFixed: { x: body.radius * 2, y: 0, z: 0 },
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 3, drawingBufferHeight: 1080,
    projection: {
      trueObserverDistance: body.radius * 2, angularRadius: Math.asin(0.5),
      projectedPixelRadius: 540, proxyDepth: 3e8, proxyRadius: 173205081,
      visibility: 'physical',
    },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraSunDirection: { x: 1, y: 0, z: 0 }, bodySunDirection: { x: 1, y: 0, z: 0 },
    solarVisibleFraction: 1, time: 0, deltaSeconds: 1 / 60, framePressure: false,
    altitude: body.radius, allowFlightTerrain: false,
    ...overrides,
  };
}

describe('AirlessBodyRenderer', () => {
  it('stages the complete Moon pack and preserves lossless height-map sampling', () => {
    const body = moon();
    const renderer = new AirlessBodyRenderer(body, bodyMaterialDescriptor(body), caps, 'medium');
    const assets = pack();
    renderer.stageAssets(assets);
    renderer.update(frame(body));
    const compact = renderer.root.getObjectByName('airless-compact:moon') as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    expect(compact.material.userData).toMatchObject({ airlessGlobal: true, bodyId: 'moon' });
    expect(assets.textures.get('heightMacro')!.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(renderer.stats()).toMatchObject({ assetTier: 'medium', assetBytes: 1234 });
    renderer.dispose();
  });

  it('rejects incomplete or foreign packs and disposes without owning borrowed textures', () => {
    const body = moon();
    const renderer = new AirlessBodyRenderer(body, bodyMaterialDescriptor(body), caps, 'medium');
    const assets = pack();
    assets.textures.delete('heightMacro');
    expect(() => renderer.stageAssets(assets)).toThrow(/heightMacro/i);
    const complete = pack();
    const borrowedDisposals = [...complete.textures.values()].map((value) => vi.spyOn(value, 'dispose'));
    renderer.stageAssets(complete);
    renderer.dispose();
    renderer.dispose();
    expect(renderer.root.children).toHaveLength(0);
    for (const dispose of borrowedDisposals) expect(dispose).not.toHaveBeenCalled();
  });
});
