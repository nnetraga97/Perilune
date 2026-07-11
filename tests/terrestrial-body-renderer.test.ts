import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AUREN_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import type { BodyRenderFrame, RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import type { RenderCaps } from '../src/render/context';
import { createBodyRendererCandidate } from '../src/render/bodyRendererFactory';
import { LegacyBodyRenderer } from '../src/render/legacyBodyRenderer';
import { TerrestrialBodyRenderer } from '../src/render/terrestrialBodyRenderer';

const caps: RenderCaps = {
  backend: 'webgl2',
  fragmentHighp: { precision: 23, rangeMin: 127, rangeMax: 127 },
  atmospherePath: 'analytic',
  compressedTextures: { astc: false, etc2: true, etc1: false, s3tc: false, bptc: false, pvrtc: false },
  maxTextureSize: 8192,
  maxAnisotropy: 8,
  drawingBufferSamples: 4,
};

function body(id: string): Body {
  return new Body(structuredClone(AUREN_SYSTEM.find((candidate) => candidate.id === id)!), null);
}

function texture(bytes = [128, 128, 128, 255]): THREE.DataTexture {
  const value = new THREE.DataTexture(new Uint8Array(bytes), 1, 1, THREE.RGBAFormat);
  value.needsUpdate = true;
  return value;
}

function pack(tier: 'low' | 'medium' | 'high' = 'medium'): RuntimeBodyAssetPack {
  return {
    bodyId: 'veyra', tier, width: 2048, height: 1024, manifestDigest: 'a'.repeat(64), gpuBytes: 100,
    textures: new Map([
      ['albedo', texture([120, 150, 110, 255])],
      ['normal', texture([128, 128, 0, 255])],
      ['material', texture([190, 240, 80, 128])],
      ['clouds', texture([180, 210, 0, 255])],
    ]),
  };
}

function frame(radius: number, overrides: Partial<BodyRenderFrame> = {}): BodyRenderFrame {
  return {
    cameraRelativeOrigin: { x: 10, y: 20, z: 30 },
    cameraBodyFixed: { x: radius * 2, y: 0, z: 0 },
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraSunDirection: { x: 1, y: 0, z: 0 },
    bodySunDirection: { x: 1, y: 0, z: 0 },
    time: 10,
    deltaSeconds: 1 / 60,
    framePressure: false,
    altitude: radius,
    allowFlightTerrain: true,
    ...overrides,
  };
}

describe('TerrestrialBodyRenderer integration', () => {
  it('selects only Veyra explicitly while retaining legacy relatives', () => {
    const veyraRenderer = createBodyRendererCandidate({ body: body('veyra'), caps, quality: 'medium' });
    const vessRenderer = createBodyRendererCandidate({ body: body('vess'), caps, quality: 'medium' });
    expect(veyraRenderer).toBeInstanceOf(TerrestrialBodyRenderer);
    expect(vessRenderer).toBeInstanceOf(LegacyBodyRenderer);
    veyraRenderer.dispose();
    vessRenderer.dispose();
  });

  it('composes one compact, terrain, ocean, atmosphere, and two-shell cloud stack', () => {
    const renderer = createBodyRendererCandidate({ body: body('veyra'), caps, quality: 'medium' }) as TerrestrialBodyRenderer;
    renderer.stageAssets(pack());
    expect(renderer.root.children.map((child) => child.name)).toEqual([
      'terrestrial-compact:veyra',
      'terrestrial-terrain:veyra',
      'terrestrial-ocean:veyra',
      'terrestrial-atmosphere:veyra',
      'terrestrial-cloud-deck:veyra',
      'terrestrial-scatter',
      'terrestrial-surface-effects',
    ]);
    expect(renderer.root.getObjectByName('terrestrial-cloud:veyra:weather')).toBeDefined();
    expect(renderer.root.getObjectByName('terrestrial-cloud:veyra:wisps')).toBeDefined();
    const lights: THREE.Light[] = [];
    renderer.root.traverse((object) => { if (object instanceof THREE.Light) lights.push(object); });
    expect(lights).toHaveLength(0);
    renderer.dispose();
  });

  it('keeps compact coverage through prewarm then completes the terrain transition', () => {
    const veyra = body('veyra');
    const renderer = createBodyRendererCandidate({ body: veyra, caps, quality: 'low' }) as TerrestrialBodyRenderer;
    renderer.stageAssets(pack('low'));
    renderer.update(frame(veyra.radius, { deltaSeconds: 0 }));
    expect(renderer.stats()).toMatchObject({ terrainActive: false, coverageProgress: 0 });
    renderer.update(frame(veyra.radius, { deltaSeconds: 0.35 }));
    expect(renderer.stats()).toMatchObject({ terrainActive: true, coverageProgress: 1 });
    const compact = renderer.root.getObjectByName('terrestrial-compact:veyra')!;
    expect(compact.visible).toBe(false);
    renderer.update(frame(veyra.radius, { allowFlightTerrain: false }));
    expect(renderer.stats()).toMatchObject({ terrainActive: false, coverageProgress: 0 });
    expect(compact.visible).toBe(true);
    renderer.dispose();
  });

  it('streams visual scatter and surface effects only near the surface', () => {
    const veyra = body('veyra');
    const renderer = createBodyRendererCandidate({ body: veyra, caps, quality: 'medium' }) as TerrestrialBodyRenderer;
    renderer.stageAssets(pack('medium'));
    const near = { cameraBodyFixed: { x: veyra.radius + 80, y: 0, z: 0 }, altitude: 80 };
    for (let i = 0; i < 4; i++) renderer.update(frame(veyra.radius, { ...near, deltaSeconds: 0.35 }));
    const surfaceStats = renderer.stats();
    expect(surfaceStats.terrainActive).toBe(true);
    expect(surfaceStats.scatterBytes).toBeGreaterThan(0);
    expect(surfaceStats.effectBytes).toBeGreaterThan(0);
    expect(surfaceStats.visualScatter).toBeGreaterThanOrEqual(0);
    const scatterGroup = renderer.root.getObjectByName('terrestrial-scatter')!;
    expect(scatterGroup.visible).toBe(true);
    // High above the surface the decorative layers switch off entirely.
    renderer.update(frame(veyra.radius, { cameraBodyFixed: { x: veyra.radius * 3, y: 0, z: 0 }, altitude: veyra.radius, allowFlightTerrain: false }));
    expect(renderer.stats().visualScatter).toBe(0);
    expect(scatterGroup.visible).toBe(false);
    renderer.dispose();
  });

  it('has a runnable procedural fallback and validates staged pack ownership', () => {
    const renderer = createBodyRendererCandidate({ body: body('veyra'), caps, quality: 'medium' }) as TerrestrialBodyRenderer;
    expect(renderer.ready).toBe(true);
    expect(renderer.root.getObjectByName('terrestrial-compact:veyra')).toBeDefined();
    expect(() => renderer.stageAssets({ ...pack(), bodyId: 'palla' })).toThrow(/cannot stage/i);
    expect(() => renderer.stageAssets({ ...pack('high') })).toThrow(/cannot stage/i);
    renderer.stageAssets(null);
    expect(renderer.ready).toBe(true);
    renderer.dispose();
  });

  it('disposes the complete stack exactly once without releasing borrowed textures', () => {
    const borrowed = pack();
    const textureDisposals = [...borrowed.textures.values()].map((value) => vi.spyOn(value, 'dispose'));
    const renderer = createBodyRendererCandidate({ body: body('veyra'), caps, quality: 'medium' }) as TerrestrialBodyRenderer;
    renderer.stageAssets(borrowed);
    const materials = new Set<THREE.Material>();
    const geometries = new Set<THREE.BufferGeometry>();
    renderer.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    const materialDisposals = [...materials].map((material) => vi.spyOn(material, 'dispose'));
    const geometryDisposals = [...geometries].map((geometry) => vi.spyOn(geometry, 'dispose'));
    renderer.dispose();
    renderer.dispose();
    expect(renderer.root.children).toHaveLength(0);
    for (const dispose of materialDisposals) expect(dispose).toHaveBeenCalledOnce();
    for (const dispose of geometryDisposals) expect(dispose).toHaveBeenCalledOnce();
    for (const dispose of textureDisposals) expect(dispose).not.toHaveBeenCalled();
  });
});
