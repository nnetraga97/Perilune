import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AUREN_SYSTEM } from '../src/content/system';
import type { BodyRenderFrame } from '../src/render/bodyRenderer';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import type { RenderCaps } from '../src/render/context';
import { LegacyBodyRenderer } from '../src/render/legacyBodyRenderer';
import { TerrestrialBodyRenderer } from '../src/render/terrestrialBodyRenderer';
import { terrainPresentationBand } from '../src/render/terrainPresentation';
import { Body } from '../src/sim/universe';

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

function frame(candidate: Body, altitude: number): BodyRenderFrame {
  return {
    cameraRelativeOrigin: { x: 0, y: 0, z: 0 },
    cameraBodyFixed: { x: candidate.radius + altitude, y: 0, z: 0 },
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 3,
    drawingBufferHeight: 1080,
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraSunDirection: { x: 1, y: 0, z: 0 },
    bodySunDirection: { x: 1, y: 0, z: 0 },
    time: 0,
    deltaSeconds: 0,
    framePressure: false,
    altitude,
    allowFlightTerrain: true,
  };
}

describe('shared terrain presentation band', () => {
  it.each(['veyra', 'rusk', 'palla', 'wisp'])('%s keeps safe orbit above terrain prewarm', (id) => {
    const candidate = body(id);
    const band = terrainPresentationBand(candidate);
    expect(band.visibleAltitude).toBeGreaterThan(candidate.def.terrain.amplitude);
    expect(band.prewarmAltitude).toBeGreaterThan(band.visibleAltitude);
    expect(band.orbitalAltitude).toBeGreaterThan(band.prewarmAltitude);
  });

  it('keeps Veyra on its compact globe in orbit and enables terrain on approach', () => {
    const candidate = body('veyra');
    const band = terrainPresentationBand(candidate);
    const renderer = new TerrestrialBodyRenderer(candidate, bodyMaterialDescriptor(candidate), caps, 'medium');
    renderer.update(frame(candidate, band.orbitalAltitude));
    expect(renderer.stats()).toMatchObject({ terrainActive: false, coverageProgress: 0 });
    expect(renderer.root.getObjectByName('terrestrial-compact:veyra')?.visible).toBe(true);
    renderer.update(frame(candidate, band.visibleAltitude - 1));
    renderer.update(frame(candidate, band.visibleAltitude - 1));
    renderer.update(frame(candidate, band.visibleAltitude - 1));
    renderer.update({ ...frame(candidate, band.visibleAltitude - 1), deltaSeconds: 0.35 });
    expect(renderer.stats().terrainActive).toBe(true);
    renderer.dispose();
  });

  it.each(['rusk', 'palla', 'wisp'])('%s legacy renderer avoids terrain work in orbit', (id) => {
    const candidate = body(id);
    const band = terrainPresentationBand(candidate);
    const terrain = { group: new THREE.Group(), stats: { chunks: 1, visible: 1 }, update: vi.fn(), dispose: vi.fn() };
    const createTerrain = vi.fn(() => terrain);
    const renderer = new LegacyBodyRenderer(candidate, bodyMaterialDescriptor(candidate), caps, 'medium', {
      createTerrain,
      createCloud: () => null,
    });
    renderer.update(frame(candidate, band.orbitalAltitude));
    expect(createTerrain).not.toHaveBeenCalled();
    expect(renderer.stats().terrainActive).toBe(false);
    renderer.update(frame(candidate, band.visibleAltitude - 1));
    expect(createTerrain).toHaveBeenCalledOnce();
    expect(terrain.update).toHaveBeenCalledOnce();
    expect(renderer.stats().terrainActive).toBe(true);
    renderer.dispose();
  });
});
