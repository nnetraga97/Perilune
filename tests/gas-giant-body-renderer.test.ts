import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BODY_VISUALS } from '../src/content/bodyVisuals';
import { SOL_SYSTEM } from '../src/content/system';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import type { BodyRenderFrame, RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import type { RenderCaps } from '../src/render/context';
import { GasGiantBodyRenderer } from '../src/render/gasGiantBodyRenderer';
import { Universe } from '../src/sim/universe';

const caps: RenderCaps = {
  backend: 'webgl2',
  fragmentHighp: { precision: 23, rangeMin: 127, rangeMax: 127 },
  atmospherePath: 'analytic',
  compressedTextures: { astc: false, etc2: true, etc1: false, s3tc: false, bptc: false, pvrtc: false },
  maxTextureSize: 8192,
  maxAnisotropy: 8,
  drawingBufferSamples: 4,
};
const jupiter = new Universe([...SOL_SYSTEM], 'earth').get('jupiter');

function frame(projection: Partial<BodyRenderFrame['projection']> = {}): BodyRenderFrame {
  return {
    cameraRelativeOrigin: { x: 400_000_000, y: 0, z: 0 },
    cameraBodyFixed: { x: 400_000_000, y: 0, z: 0 },
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 3,
    drawingBufferHeight: 1080,
    projection: {
      trueObserverDistance: 400_000_000,
      angularRadius: 0.18,
      projectedPixelRadius: 170,
      proxyDepth: 300_000_000,
      proxyRadius: 54_000_000,
      physicalOpacity: 1,
      proxyOpacity: 0,
      visibility: 'physical',
      ...projection,
    },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraSunDirection: { x: 1, y: 0, z: 0 },
    bodySunDirection: { x: 1, y: 0, z: 0 },
    solarVisibleFraction: 1,
    time: 0,
    deltaSeconds: 1 / 60,
    framePressure: false,
    altitude: 400_000_000 - jupiter.radius,
    allowFlightTerrain: false,
  };
}

function renderer(): GasGiantBodyRenderer {
  return new GasGiantBodyRenderer(
    jupiter,
    bodyMaterialDescriptor(jupiter),
    BODY_VISUALS.jupiter.gasGiantVisual!,
    caps,
    'medium',
  );
}

describe('GasGiantBodyRenderer', () => {
  it('preserves measured oblateness through physical and proxy presentations', () => {
    const subject = renderer();
    const physical = subject.root.getObjectByName('gas-giant-globe:jupiter:physical')!;
    const proxy = subject.root.getObjectByName('gas-giant-globe:jupiter:proxy')!;
    subject.update(frame());
    expect(subject.kind).toBe('gas-giant');
    expect(physical.scale.x).toBe(jupiter.equatorialRadius);
    expect(physical.scale.z).toBe(jupiter.polarRadius);
    expect(physical.scale.z / physical.scale.x).toBeCloseTo(66_854 / 71_492, 10);
    subject.update(frame({ physicalOpacity: 0.25, proxyOpacity: 0.75 }));
    expect(proxy.visible).toBe(true);
    expect(proxy.scale.z / proxy.scale.x).toBeCloseTo(jupiter.polarRadius / jupiter.equatorialRadius, 10);
    expect(subject.stats()).toMatchObject({ presentationMode: 'transition', terrainActive: false });
    subject.dispose();
  });

  it('accepts only the exact borrowed albedo channel', () => {
    const subject = renderer();
    const albedo = new THREE.DataTexture(new Uint8Array([200, 170, 130, 255]), 1, 1, THREE.RGBAFormat);
    const pack: RuntimeBodyAssetPack = {
      bodyId: 'jupiter', tier: 'medium', width: 2048, height: 1024,
      manifestDigest: '0'.repeat(64), gpuBytes: 4,
      textures: new Map([['albedo', albedo]]),
    };
    expect(() => subject.stageAssets(pack)).not.toThrow();
    expect(() => subject.stageAssets({
      ...pack,
      textures: new Map([['albedo', albedo], ['normal', albedo]]),
    })).toThrow(/exact channel albedo/i);
    const surface = subject.root.getObjectByName('gas-giant-surface:jupiter:physical') as THREE.Mesh;
    expect((surface.material as THREE.ShaderMaterial).fragmentShader).toContain('0.24 + diffuse * 0.96');
    subject.dispose();
    albedo.dispose();
  });
});
