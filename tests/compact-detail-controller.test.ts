import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BodyRenderFrame } from '../src/render/bodyRenderer';
import {
  CompactDetailController,
  compactDetailLevelForViewport,
} from '../src/render/planetDetail/compactDetailController';
import { createPlanetDetailMaterialState } from '../src/render/planetDetail/detailMaterial';
import { MOON_WAC_DETAIL } from '../src/render/planetDetail/sourceRegistry';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalCreateImageBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete (globalThis as { document?: Document }).document;
  if (originalCreateImageBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalCreateImageBitmap);
  else delete (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap;
});

function frame(deltaSeconds = 0): BodyRenderFrame {
  const radius = 6_378_137;
  return {
    cameraRelativeOrigin: { x: 0, y: 0, z: 0 },
    cameraBodyFixed: { x: radius + 250_000, y: 0, z: 0 },
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    verticalFovRadians: Math.PI / 3,
    drawingBufferHeight: 1080,
    projection: { trueObserverDistance: radius + 250_000, angularRadius: 1, projectedPixelRadius: 500, proxyDepth: 1, proxyRadius: 1, visibility: 'physical' },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraSunDirection: { x: 1, y: 0, z: 0 },
    bodySunDirection: { x: 1, y: 0, z: 0 },
    solarVisibleFraction: 1,
    time: 0,
    deltaSeconds,
    framePressure: false,
    altitude: 250_000,
    allowFlightTerrain: false,
  };
}

function moonFrame(altitude: number, deltaSeconds = 0): BodyRenderFrame {
  const radius = 1_737_400;
  return {
    ...frame(deltaSeconds),
    cameraBodyFixed: { x: radius + altitude, y: 0, z: 0 },
    drawingBufferWidth: 1920,
    projection: { trueObserverDistance: radius + altitude, angularRadius: 0.5, projectedPixelRadius: 450, proxyDepth: 1, proxyRadius: 1, visibility: 'physical' },
    altitude,
  };
}

describe('compact detail controller', () => {
  it('keeps the Moon atlas coarse enough to cover the whole viewport', () => {
    const radius = 1_737_400;
    const selected = (altitude: number): number => {
      const metersPerPixel = 2 * altitude * Math.tan(Math.PI / 6) / 1_080;
      const desired = MOON_WAC_DETAIL.levelForProjectedFootprint(radius, 0, metersPerPixel);
      return compactDetailLevelForViewport(
        MOON_WAC_DETAIL, desired, radius, radius + altitude, Math.PI / 3, 1_920, 1_080,
      );
    };

    expect(selected(1_100_000)).toBe(2);
    expect(selected(600_000)).toBe(2);
    expect(selected(300_000)).toBe(4);
    expect(selected(156_000)).toBe(5);
    expect(selected(100_000)).toBe(6);
  });

  it('starts a complete coarse Moon atlas at 2,000 km', async () => {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage,
        getImageData: () => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }),
      }),
    };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
    const close = vi.fn();
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: vi.fn(async () => ({ width: 256, height: 256, close })) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([new Uint8Array(64)], { type: 'image/jpeg' }), {
      headers: { 'content-type': 'image/jpeg', 'content-length': '64' },
    })));

    const material = new THREE.MeshStandardMaterial();
    material.userData.planetDetail = createPlanetDetailMaterialState();
    const controller = new CompactDetailController('moon', 1_737_400, 'medium', [material]);
    controller.update(moonFrame(2_000_000));
    expect(controller.stats()).toMatchObject({ state: 'requesting', level: 2 });
    await vi.waitFor(() => expect(controller.stats().state).toBe('crossfading'));
    expect(drawImage).toHaveBeenCalledTimes(16);
    expect(controller.stats()).toMatchObject({ level: 2, pages: 16 });
    controller.dispose();
    material.dispose();
  });

  it('keeps the resident parent until all nine pages decode, then crossfades', async () => {
    const drawImage = vi.fn();
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
    const close = vi.fn();
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: vi.fn(async () => ({ width: 512, height: 512, close })) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob([new Uint8Array(64)], { type: 'image/jpeg' }), {
      headers: { 'content-type': 'image/jpeg', 'content-length': '64' },
    })));

    const material = new THREE.MeshStandardMaterial();
    const state = createPlanetDetailMaterialState();
    material.userData.planetDetail = state;
    const controller = new CompactDetailController('earth', 6_378_137, 'medium', [material]);
    controller.update(frame());
    expect(controller.stats().state).toBe('requesting');
    expect(state.enabled.value).toBe(0);
    await vi.waitFor(() => expect(controller.stats().state).toBe('crossfading'));
    expect(drawImage).toHaveBeenCalledTimes(9);
    expect(state.enabled.value).toBe(1);
    expect(state.opacity.value).toBe(0);
    expect(state.atlas.value?.flipY).toBe(true);
    controller.update(frame(0.35));
    expect(controller.stats().state).toBe('ready');
    expect(state.opacity.value).toBe(1);
    controller.dispose();
    material.dispose();
  });
});
