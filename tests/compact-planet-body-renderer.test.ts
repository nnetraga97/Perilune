import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { BODY_VISUALS } from '../src/content/bodyVisuals';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import {
  CompactPlanetBodyRenderer,
  compactPlanetPresentation,
} from '../src/render/compactPlanetBodyRenderer';
import type { BodyRenderFrame, RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import type { RenderCaps } from '../src/render/context';
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

const mars = new Universe([...SOL_SYSTEM], 'earth').get('mars');

function frame(overrides: Partial<BodyRenderFrame> = {}): BodyRenderFrame {
  return {
    cameraRelativeOrigin: { x: 500_000_000, y: 0, z: 0 },
    cameraBodyFixed: { x: 500_000_000, y: 0, z: 0 },
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 3,
    drawingBufferHeight: 1080,
    projection: {
      trueObserverDistance: 500_000_000,
      angularRadius: 0.006,
      projectedPixelRadius: 8,
      proxyDepth: 300_000_000,
      proxyRadius: 1_800_000,
      physicalOpacity: 1,
      proxyOpacity: 0,
      visibility: 'physical',
    },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraSunDirection: { x: 1, y: 0, z: 0 },
    bodySunDirection: { x: 1, y: 0, z: 0 },
    solarVisibleFraction: 1,
    time: 0,
    deltaSeconds: 1 / 60,
    framePressure: false,
    altitude: 500_000_000 - mars.radius,
    allowFlightTerrain: false,
    ...overrides,
  };
}

function renderer(): CompactPlanetBodyRenderer {
  return new CompactPlanetBodyRenderer(
    mars,
    bodyMaterialDescriptor(mars),
    BODY_VISUALS.mars.compactPlanetVisual!,
    caps,
    'medium',
  );
}

describe('compact planet presentation policy', () => {
  it('uses explicit physical-to-proxy and proxy-to-point overlap bands', () => {
    expect(compactPlanetPresentation(frame().projection)).toMatchObject({
      mode: 'physical', physicalOpacity: 1, proxyOpacity: 0, pointOpacity: 0,
    });
    expect(compactPlanetPresentation(frame({
      projection: { ...frame().projection, physicalOpacity: 0.4, proxyOpacity: 0.6 },
    }).projection)).toMatchObject({
      mode: 'transition', physicalOpacity: 0.4, proxyOpacity: 0.6, pointOpacity: 0,
    });
    const pointTransition = compactPlanetPresentation(frame({
      projection: {
        ...frame().projection,
        visibility: 'far-field',
        physicalOpacity: 0,
        proxyOpacity: 1,
        projectedPixelRadius: 0.9,
      },
    }).projection);
    expect(pointTransition.mode).toBe('transition');
    expect(pointTransition.proxyOpacity).toBeGreaterThan(0);
    expect(pointTransition.pointOpacity).toBeGreaterThan(0);
  });
});

describe('CompactPlanetBodyRenderer', () => {
  it('renders the physical sphere, crossfades to a proxy, then resolves to a point', () => {
    const subject = renderer();
    const physical = subject.root.getObjectByName('compact-planet-globe:mars:physical')!;
    const proxy = subject.root.getObjectByName('compact-planet-globe:mars:proxy')!;
    const point = subject.root.getObjectByName('compact-planet-point:mars')!;

    subject.update(frame());
    expect(physical.visible).toBe(true);
    expect(proxy.visible).toBe(false);
    expect(point.visible).toBe(false);
    expect(physical.position.x).toBe(500_000_000);
    expect(physical.scale.x).toBe(mars.radius);
    expect(subject.stats()).toMatchObject({ presentationMode: 'physical', terrainActive: false });

    subject.update(frame({
      projection: { ...frame().projection, physicalOpacity: 0.4, proxyOpacity: 0.6 },
    }));
    expect(physical.visible).toBe(true);
    expect(proxy.visible).toBe(true);
    expect(proxy.position.x).toBe(300_000_000);
    expect(proxy.scale.x).toBe(1_800_000);
    expect(subject.stats().presentationMode).toBe('transition');

    subject.update(frame({
      projection: {
        ...frame().projection,
        visibility: 'subpixel',
        projectedPixelRadius: 0.2,
        physicalOpacity: 0,
        proxyOpacity: 1,
      },
    }));
    expect(physical.visible).toBe(false);
    expect(proxy.visible).toBe(false);
    expect(point.visible).toBe(true);
    expect(subject.stats().presentationMode).toBe('point');
    subject.dispose();
  });

  it('accepts exactly one borrowed albedo texture and no terrain channels', () => {
    const subject = renderer();
    const albedo = new THREE.DataTexture(new Uint8Array([180, 90, 50, 255]), 1, 1, THREE.RGBAFormat);
    const pack: RuntimeBodyAssetPack = {
      bodyId: 'mars', tier: 'medium', width: 2048, height: 1024,
      manifestDigest: '0'.repeat(64), gpuBytes: 4,
      textures: new Map([['albedo', albedo]]),
    };
    expect(() => subject.stageAssets(pack)).not.toThrow();
    expect(subject.stats()).toMatchObject({ assetTier: 'medium', assetBytes: 4, terrainActive: false });
    expect(() => subject.stageAssets({
      ...pack,
      textures: new Map([['albedo', albedo], ['normal', albedo]]),
    })).toThrow(/exact channel albedo/i);
    expect(() => subject.stageAssets({ ...pack, bodyId: 'earth' })).toThrow(/cannot stage/i);
    const surface = subject.root.getObjectByName('compact-planet-surface:mars:physical') as THREE.Mesh;
    expect((surface.material as THREE.ShaderMaterial).fragmentShader).toContain('bodyFixedUv');
    subject.dispose();
    albedo.dispose();
  });
});
