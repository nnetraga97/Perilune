import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import { AUREN_SYSTEM } from '../src/content/system';
import { Vec3 } from '../src/core/vec3';
import { Quat } from '../src/core/quat';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import { GpuSubmissionProfiler, PerfOverlay } from '../src/ui/perfOverlay';
import {
  MapView,
  compactBodyMesh,
  mapStarDirection,
  updateCompactBodyOrientation,
} from '../src/ui/mapView';
import { Universe } from '../src/sim/universe';
import { bodyOrientation } from '../src/sim/bodyOrientation';
import type { GpuTimerSnapshot, GpuTimingSample } from '../src/render/gpuTimer';
import { WorldScene } from '../src/render/worldScene';

const universe = new Universe(structuredClone(AUREN_SYSTEM));

describe('compact map body presentation', () => {
  test('selects solid, gas, and star materials from the shared descriptor identity', () => {
    const solid = compactBodyMesh(bodyMaterialDescriptor(universe.get('veyra')));
    const gas = compactBodyMesh(bodyMaterialDescriptor(universe.get('tyran')));
    const star = compactBodyMesh(bodyMaterialDescriptor(universe.get('auren')));

    expect(solid.material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(gas.material).toBeInstanceOf(THREE.MeshPhongMaterial);
    expect(star.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(solid.userData.bodyMaterial).toMatchObject({ bodyId: 'veyra', identity: 'solid' });
    expect(gas.userData.bodyMaterial).toMatchObject({ bodyId: 'tyran', identity: 'gas' });
    expect(star.userData.bodyMaterial).toMatchObject({ bodyId: 'auren', identity: 'star' });
    expect(solid.userData.bodyMaterial.albedo).toEqual(bodyMaterialDescriptor(universe.get('veyra')).albedo);
  });

  test('colors body-local vertices from the descriptor palette and body-fixed UV convention', () => {
    const descriptor = bodyMaterialDescriptor(universe.get('tyran'));
    const mesh = compactBodyMesh(descriptor);
    const colors = (mesh.geometry.getAttribute('color') as THREE.BufferAttribute).array as Float32Array;
    const palette = new Set<string>();
    for (let i = 0; i < colors.length; i += 3) {
      palette.add(new THREE.Color(colors[i], colors[i + 1], colors[i + 2]).getHexString());
    }

    expect(mesh.userData.orientationConvention).toBe('body-fixed-z-up-atan2-y-x');
    expect(palette.size).toBeGreaterThan(1);
  });

  test('applies the authoritative body orientation to every compact mesh at simulation time', () => {
    const body = universe.get('veyra');
    const mesh = compactBodyMesh(bodyMaterialDescriptor(body));
    const time = 12_345;
    const expected = bodyOrientation(body, time, new Quat());

    updateCompactBodyOrientation(mesh, body, time);

    expect(mesh.quaternion.x).toBeCloseTo(expected.x, 12);
    expect(mesh.quaternion.y).toBeCloseTo(expected.y, 12);
    expect(mesh.quaternion.z).toBeCloseTo(expected.z, 12);
    expect(mesh.quaternion.w).toBeCloseTo(expected.w, 12);
  });

  test('computes phase-correct map light direction from the focus center toward Auren', () => {
    const focus = universe.get('veyra');
    const time = 91_337;
    const actual = mapStarDirection(universe, focus, time, new Vec3());
    const expected = new Vec3();
    universe.relativePosition(universe.root, focus, time, expected);
    expected.normalize();

    expect(actual.x).toBeCloseTo(expected.x, 12);
    expect(actual.y).toBeCloseTo(expected.y, 12);
    expect(actual.z).toBeCloseTo(expected.z, 12);
  });

  test('keeps compact map code independent of flight terrain, scatter, and asset packs', () => {
    const source = readFileSync(new URL('../src/ui/mapView.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/PlanetAssetLoader|KTX2Loader|createTerrain|scatter|planetAssetPack/);
    expect(source).toContain('bodyMaterialDescriptor');
  });

  test('dispose is idempotent and releases shared map-owned resources exactly once', () => {
    const sharedGeometry = new THREE.SphereGeometry();
    const sharedMaterial = new THREE.MeshBasicMaterial();
    const sharedTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    sharedMaterial.map = sharedTexture;
    const meshA = new THREE.Mesh(sharedGeometry, sharedMaterial);
    const meshB = new THREE.Mesh(sharedGeometry, sharedMaterial);
    const starfield = new THREE.Points(sharedGeometry, sharedMaterial);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sharedTexture }));
    const line = new THREE.Line(sharedGeometry, sharedMaterial);
    const panel = { remove: vi.fn() };
    const style = { remove: vi.fn() };
    const removeEventListener = vi.fn();
    vi.stubGlobal('window', { removeEventListener });
    const map = Object.create(MapView.prototype) as MapView;
    const scene = new THREE.Scene();
    scene.add(meshA, meshB, starfield, sprite, line);
    Object.assign(map as unknown as Record<string, unknown>, {
      scene,
      bodyMeshes: new Map([['a', meshA], ['b', meshB]]),
      bodyOrbits: new Map([['a', line]]),
      soiMeshes: new Map(),
      vesselLine: line,
      nodeLine: line,
      encounterLine: line,
      vesselMarker: sprite,
      nodeMarker: sprite,
      encounterMarker: sprite,
      depositMarkers: [sprite],
      depositCache: new Map([['a', []]]),
      starfield,
      panel,
      ownedStyle: style,
      resizeHandler: vi.fn(),
      disposed: false,
    });
    const geometryDispose = vi.spyOn(sharedGeometry, 'dispose');
    const materialDispose = vi.spyOn(sharedMaterial, 'dispose');
    const textureDispose = vi.spyOn(sharedTexture, 'dispose');
    const spriteMaterialDispose = vi.spyOn(sprite.material, 'dispose');

    map.dispose();
    map.dispose();

    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
    expect(spriteMaterialDispose).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(panel.remove).toHaveBeenCalledOnce();
    expect(style.remove).toHaveBeenCalledOnce();
  });
});

interface FakeTimer {
  begin(label: string): boolean;
  end(): void;
  poll(): GpuTimingSample[];
  snapshot(): Readonly<GpuTimerSnapshot>;
  dispose(): void;
}

function timer(overrides: Partial<FakeTimer> = {}): FakeTimer {
  return {
    begin: vi.fn(() => true),
    end: vi.fn(),
    poll: vi.fn(() => []),
    snapshot: vi.fn(() => ({
      supported: true, pending: 0, validSamples: 0, disjointSamples: 0,
      invalidSamples: 0, unavailablePolls: 0, saturatedBegins: 0,
    })),
    dispose: vi.fn(),
    ...overrides,
  };
}

describe('production GPU submission profiling', () => {
  test('game loop profiles only actual flight/map draws and skips all query work while render-paused', () => {
    const source = readFileSync(new URL('../src/game.ts', import.meta.url), 'utf8');
    expect(source).toContain("gpuProfiler.submit('map'");
    expect(source).toContain("gpuProfiler.submit('flight'");
    expect(source).not.toContain("gpuProfiler.submit('editor'");
    expect(source).toMatch(/if \(!this\.ctx\.renderPaused\)[\s\S]*gpuProfiler\.poll\(\)/);
    expect(source).toContain('recreate({ disposePrevious: false })');
    expect(source).toContain('if (event.persisted) return');
    expect(source).toContain("window.removeEventListener('pagehide', this.onPageHide)");
    expect(source).not.toContain("addEventListener('pagehide', this.onPageHide, { once: true })");
  });

  test('typed renderer metrics win even when their truthful value is zero', () => {
    const overlay = Object.create(PerfOverlay.prototype) as PerfOverlay;
    Object.assign(overlay as unknown as Record<string, unknown>, {
      frameTimes: [], simMs: 0, renderMs: 0, frames: 0,
      extra: { chunks: 99, disjoint: 99, 'transition ms': 99 },
      rendererMetrics: {
        chunks: 8, visibleChunks: 5, rendererManagers: 2, residentFlightPacks: 0,
        residentPackGpuBytes: 0, rendererFailures: 0, transitionActive: false,
        transitionMs: 0, contextFallback: false,
      },
      gpuMetrics: {
        gpuTimingSupported: true, flightGpuMs: 0, mapGpuMs: null,
        gpuQueriesPending: 0, gpuQueriesValid: 1, gpuQueriesDisjoint: 0,
        gpuQueriesInvalid: 0, gpuQueriesUnavailable: 0, gpuQueriesSaturated: 0,
      },
    });

    expect(overlay.snapshot()).toMatchObject({ chunks: 5, disjointQueries: 0, transitionMs: 0 });
  });

  test('WorldScene reports manager, resource, transition, and fallback state without invented pack data', () => {
    const world = Object.create(WorldScene.prototype) as WorldScene;
    Object.assign(world as unknown as Record<string, unknown>, {
      bodyRenderers: new Map([
        ['veyra', { stats: () => ({ chunks: 8, visible: 5 }) }],
        ['auren', { stats: () => ({ chunks: 0, visible: 0 }) }],
      ]),
      bodyRendererManagers: new Map([
        ['veyra', { platformStats: () => ({ transactionActive: true, transitionMs: 18, failures: 2 }) }],
        ['auren', { platformStats: () => ({ transactionActive: false, transitionMs: 7, failures: 0 }) }],
      ]),
      rendererLedger: {
        residentFlightBodyIds: () => ['veyra'],
        snapshot: () => ({ bodyId: 'veyra', tier: 'medium', gpuBytes: 12_345, transientBytes: 50 }),
      },
      context: { lifecycle: { state: 'fallback' } },
    });

    expect(world.renderStats()).toEqual({
      chunks: 8,
      visibleChunks: 5,
      rendererManagers: 2,
      residentFlightPacks: 1,
      residentPackGpuBytes: 12_345,
      rendererFailures: 2,
      transitionActive: true,
      transitionMs: 18,
      contextFallback: true,
    });
  });

  test('balances begin/end around actual submissions when unsupported, saturated, or throwing', () => {
    for (const beginResult of [false, true]) {
      const fake = timer({ begin: vi.fn(() => beginResult) });
      const profiler = new GpuSubmissionProfiler(() => fake as never);
      expect(() => profiler.submit('flight', () => { throw new Error('render failed'); })).toThrow('render failed');
      expect(fake.begin).toHaveBeenCalledWith('flight');
      expect(fake.end).toHaveBeenCalledOnce();
    }
  });

  test('profiling failures never interrupt rendering or replace a render exception', () => {
    const endFails = timer({ end: vi.fn(() => { throw new Error('query end failed'); }) });
    const profiler = new GpuSubmissionProfiler(() => endFails as never);
    const successfulRender = vi.fn();
    expect(() => profiler.submit('map', successfulRender)).not.toThrow();
    expect(successfulRender).toHaveBeenCalledOnce();
    expect(() => profiler.submit('flight', () => { throw new Error('render failed'); })).toThrow('render failed');

    const renderedWithoutTimer = vi.fn();
    const disabled = new GpuSubmissionProfiler(() => { throw new Error('allocation failed'); });
    expect(() => disabled.submit('flight', renderedWithoutTimer)).not.toThrow();
    expect(renderedWithoutTimer).toHaveBeenCalledOnce();
    expect(disabled.metrics().gpuTimingSupported).toBe(false);
  });

  test('a begin failure disables the broken timer before the next frame', () => {
    const broken = timer({ begin: vi.fn(() => { throw new Error('begin failed'); }) });
    const profiler = new GpuSubmissionProfiler(() => broken as never);

    profiler.submit('flight', vi.fn());
    profiler.submit('flight', vi.fn());

    expect(broken.begin).toHaveBeenCalledOnce();
    expect(broken.dispose).toHaveBeenCalledOnce();
  });

  test('polls non-blockingly, attributes samples, and exposes query accounting', () => {
    const fake = timer({
      poll: vi.fn((): GpuTimingSample[] => [
        { label: 'map', status: 'valid', milliseconds: 2.5 },
        { label: 'flight', status: 'disjoint' },
        { label: 'map', status: 'invalid' },
      ]),
      snapshot: vi.fn(() => ({
        supported: true, pending: 2, validSamples: 7, disjointSamples: 3,
        invalidSamples: 1, unavailablePolls: 9, saturatedBegins: 4,
      })),
    });
    const profiler = new GpuSubmissionProfiler(() => fake as never);

    profiler.poll();

    expect(profiler.metrics()).toMatchObject({
      mapGpuMs: 2.5,
      flightGpuMs: null,
      gpuQueriesPending: 2,
      gpuQueriesValid: 7,
      gpuQueriesDisjoint: 3,
      gpuQueriesInvalid: 1,
      gpuQueriesUnavailable: 9,
      gpuQueriesSaturated: 4,
    });
  });

  test('recreates the ring after restoration and never reuses old queries', () => {
    const first = timer();
    const second = timer();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const profiler = new GpuSubmissionProfiler(factory);

    profiler.recreate();
    profiler.submit('map', vi.fn());

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(first.begin).not.toHaveBeenCalled();
    expect(second.begin).toHaveBeenCalledWith('map');
  });

  test('disables timing safely when poll or restored allocation fails', () => {
    const first = timer({ poll: vi.fn(() => { throw new Error('context invalid'); }) });
    const factory = vi.fn().mockReturnValueOnce(first).mockImplementationOnce(() => { throw new Error('restore allocation'); });
    const profiler = new GpuSubmissionProfiler(factory);

    expect(() => profiler.poll()).not.toThrow();
    expect(() => profiler.recreate()).not.toThrow();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(profiler.metrics().gpuTimingSupported).toBe(false);
  });
});
