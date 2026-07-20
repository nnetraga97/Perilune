import { createLegacyGameState } from './fixtures/legacyGameState';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import { LEGACY_AUREN_SYSTEM as AUREN_SYSTEM } from './fixtures/legacyAurenSystem';
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
import type { RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import { WorldScene } from '../src/render/worldScene';
import { RenderContextLifecycle } from '../src/render/contextLifecycle';
import { GameState } from '../src/sim/state';
import { createCraft } from '../src/sim/vessel';

const universe = new Universe(structuredClone(AUREN_SYSTEM));

function authoredPack(tier: 'low' | 'medium' | 'high' = 'high'): RuntimeBodyAssetPack {
  const texture = () => new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
  return {
    bodyId: 'veyra', tier, width: 4096, height: 2048, manifestDigest: 'map-test', gpuBytes: 12,
    textures: new Map([['albedo', texture()], ['normal', texture()], ['material', texture()], ['clouds', texture()]]),
  };
}

describe('compact map body presentation', () => {
  test('returns default map focus to the active vessel SOI body', () => {
    const game = createLegacyGameState();
    const active = game.spawnInOrbit(createCraft('Map focus probe'), 'Map focus probe', 'palla', 10_000);
    game.activeVesselId = active.runtime.id;

    const map = Object.create(MapView.prototype) as MapView;
    Object.assign(map as unknown as Record<string, unknown>, {
      focusBodyId: 'veyra',
      followsActiveVessel: false,
      desiredFocus: new THREE.Vector3(12, 34, 56),
      camFocus: new THREE.Vector3(65, 43, 21),
    });

    map.focusActiveVessel(game);

    expect((map as unknown as { focusBodyId: string }).focusBodyId).toBe('palla');
    expect((map as unknown as { followsActiveVessel: boolean }).followsActiveVessel).toBe(true);
    expect((map as unknown as { desiredFocus: THREE.Vector3 }).desiredFocus).toEqual(new THREE.Vector3());
    expect((map as unknown as { camFocus: THREE.Vector3 }).camFocus).toEqual(new THREE.Vector3());
  });

  test('selects solid, gas, and star materials from the shared descriptor identity', () => {
    const solid = compactBodyMesh(bodyMaterialDescriptor(universe.get('veyra')));
    const gas = compactBodyMesh(bodyMaterialDescriptor(universe.get('tyran')));
    const star = compactBodyMesh(bodyMaterialDescriptor(universe.get('auren')));

    expect(solid.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(gas.material).toBeInstanceOf(THREE.MeshPhongMaterial);
    expect(star.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(solid.userData.bodyMaterial).toMatchObject({ bodyId: 'veyra', identity: 'solid' });
    expect(gas.userData.bodyMaterial).toMatchObject({ bodyId: 'tyran', identity: 'gas' });
    expect(star.userData.bodyMaterial).toMatchObject({ bodyId: 'auren', identity: 'star' });
    expect(solid.userData.bodyMaterial.albedo).toEqual(bodyMaterialDescriptor(universe.get('veyra')).albedo);
    expect(solid.geometry.getAttribute('bodyDirection')).toBeDefined();
    expect((solid.material as THREE.Material).userData).toMatchObject({ terrestrialGlobal: true, authored: false });
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

  test('uses the borrowed authored pack and quality-tier sphere resolution for terrestrial bodies', () => {
    const pack = authoredPack('high');
    const mesh = compactBodyMesh(bodyMaterialDescriptor(universe.get('veyra')), pack, 16, 'high');
    const material = mesh.material as THREE.MeshStandardMaterial;

    expect(material.userData).toMatchObject({ terrestrialGlobal: true, authored: true, bodyId: 'veyra' });
    expect(material.userData.maps.albedo).toBe(pack.textures.get('albedo'));
    expect(material.userData.maps.albedo.anisotropy).toBe(8);
    expect(mesh.geometry.parameters).toMatchObject({ widthSegments: 160, heightSegments: 96 });
    expect(mesh.userData.assetPack).toBe(pack);
  });

  test('uses the authored airless material for a moon pack without requiring clouds', () => {
    const texture = () => new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
    const pack: RuntimeBodyAssetPack = {
      bodyId: 'palla', tier: 'medium', width: 2048, height: 1024,
      manifestDigest: 'map-test', gpuBytes: 12,
      textures: new Map([['albedo', texture()], ['normal', texture()], ['material', texture()]]),
    };
    const mesh = compactBodyMesh(bodyMaterialDescriptor(universe.get('palla')), pack, 16, 'medium');

    expect(mesh.material.userData).toMatchObject({ airlessGlobal: true, bodyId: 'palla' });
    expect(pack.textures.get('albedo')!.anisotropy).toBe(8);
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

  test('borrows committed packs without creating a second loader or terrain renderer', () => {
    const source = readFileSync(new URL('../src/ui/mapView.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/PlanetAssetLoader|KTX2Loader|createTerrain|scatter/);
    expect(source).toContain('getBodyAssetPack');
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
    // Styles are kit-owned and shared across screens; dispose must not touch them.
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
    expect(style.remove).not.toHaveBeenCalled();
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
    expect(source).toContain('invalidateAfterContextLoss()');
    expect(source).not.toContain('recreate({ disposePrevious: false })');
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

    expect(overlay.snapshot()).toMatchObject({
      chunks: 5, disjointQueries: 0, transitionMs: 0, estimatedGpuMB: null,
    });
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
        ['auren', { platformStats: () => ({ transactionActive: false, transitionMs: 70, failures: 0 }) }],
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

  test('defers restored query allocation until the lifecycle is renderable', async () => {
    const canvas = new EventTarget();
    const lifecycle = new RenderContextLifecycle(canvas);
    const first = timer();
    const second = timer();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const profiler = new GpuSubmissionProfiler(factory);
    lifecycle.subscribeRestoration(async () => profiler.invalidateAfterContextLoss());
    let releaseRestoration!: () => void;
    const holdRestoration = new Promise<void>((resolve) => { releaseRestoration = resolve; });
    lifecycle.subscribeRestoration(() => holdRestoration);

    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    await vi.waitFor(() => expect(lifecycle.state).toBe('restoring'));
    expect(factory).toHaveBeenCalledOnce();
    expect(first.dispose).not.toHaveBeenCalled();
    releaseRestoration();
    await vi.waitFor(() => expect(lifecycle.state).toBe('ready'));

    expect(factory).toHaveBeenCalledOnce();
    expect(first.dispose).not.toHaveBeenCalled();
    profiler.submit('flight', vi.fn());
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.begin).toHaveBeenCalledWith('flight');
  });

  test('does not retry a failed lazy restored allocation every frame', () => {
    const first = timer();
    const factory = vi.fn().mockReturnValueOnce(first).mockImplementationOnce(() => { throw new Error('still unavailable'); });
    const profiler = new GpuSubmissionProfiler(factory);
    profiler.invalidateAfterContextLoss();

    profiler.submit('flight', vi.fn());
    profiler.submit('flight', vi.fn());

    expect(factory).toHaveBeenCalledTimes(2);
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
