import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import type { BodyRenderer, QualityTier } from '../src/render/bodyRenderer';
import {
  BodyRendererManager,
  RendererResourceLedger,
  type LoadedRendererAssets,
} from '../src/render/bodyRendererManager';
import {
  PlanetAssetLoader,
  type CheckedPlanetManifest,
} from '../src/render/planetAssetLoader';
import { compileRendererCandidate } from '../src/render/shaderCompiler';
import { RenderFailureTracker } from '../src/render/renderFailures';

function candidate(bodyId: string, quality: QualityTier = 'medium') {
  const root = new THREE.Group();
  const dispose = vi.fn(() => root.clear());
  const renderer: BodyRenderer = {
    bodyId,
    kind: 'legacy',
    quality,
    root,
    ready: true,
    update: vi.fn(),
    stats: () => ({ chunks: 0, visible: 0, terrainActive: false, exposure: 0 }),
    dispose,
  };
  return { renderer, root, dispose };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const body = (id: string) => ({ id }) as never;
const assets = (overrides: Partial<LoadedRendererAssets> = {}): LoadedRendererAssets => ({
  gpuBytes: 20,
  transientBytes: 10,
  flightScale: true,
  dispose: vi.fn(),
  ...overrides,
});

function managerHarness(overrides: Partial<ConstructorParameters<typeof BodyRendererManager>[0]> = {}) {
  const scene = new THREE.Scene();
  const made: ReturnType<typeof candidate>[] = [];
  const ledger = overrides.ledger ?? new RendererResourceLedger({
    activeBodyGpuBytes: { low: 100, medium: 100, high: 100 },
    transientPeakBytes: { low: 100, medium: 100, high: 100 },
  });
  const manager = new BodyRendererManager({
    scene,
    quality: 'medium',
    createCandidate: (nextBody, tier) => {
      const next = candidate(nextBody.id, tier);
      made.push(next);
      return next.renderer;
    },
    loadAssets: async () => assets(),
    compileCandidate: async () => undefined,
    awaitCoverage: async () => undefined,
    ledger,
    failures: new RenderFailureTracker(() => undefined),
    ...overrides,
  });
  return { manager, scene, made, ledger };
}

describe('transactional body renderer replacement', () => {
  test('adopts a truthful initial renderer synchronously without a blank first frame', () => {
    const { manager, scene } = managerHarness();
    const initial = candidate('veyra');
    manager.adoptInitial(body('veyra'), initial.renderer, assets({ flightScale: false }));

    expect(manager.current()).toBe(initial.renderer);
    expect(scene.children).toEqual([initial.root]);
    expect(initial.root.visible).toBe(true);
  });

  test('keeps the old root visible until load, compile, coverage, and budget readiness complete', async () => {
    const load = deferred<LoadedRendererAssets>();
    const compile = deferred<void>();
    const coverage = deferred<void>();
    const { manager, scene, made } = managerHarness();
    await manager.ensure(body('veyra'));
    manager.setBoundaries({
      loadAssets: () => load.promise,
      compileCandidate: () => compile.promise,
      awaitCoverage: () => coverage.promise,
    });
    const previous = made[0];
    const replacing = manager.replaceQuality('high');
    await Promise.resolve();
    expect(scene.children).toEqual([previous.root]);
    expect(previous.root.visible).toBe(true);
    expect(made[1].root.visible).toBe(false);

    load.resolve(assets());
    await Promise.resolve();
    compile.resolve();
    await Promise.resolve();
    expect(scene.children).toEqual([previous.root]);
    coverage.resolve();
    await replacing;

    expect(scene.children).toEqual([made[1].root]);
    expect(made[1].root.visible).toBe(true);
    expect(previous.dispose).toHaveBeenCalledOnce();
  });

  test.each([
    ['load', { loadAssets: async () => { throw new Error('load failed'); } }],
    ['compile', { compileCandidate: async () => { throw new Error('compile failed'); } }],
    ['coverage', { awaitCoverage: async () => { throw new Error('coverage failed'); } }],
  ] as const)('disposes a partial candidate and retains committed root on %s rejection', async (_phase, failure) => {
    const { manager, scene, made } = managerHarness();
    await manager.ensure(body('veyra'));
    manager.setBoundaries(failure);

    await expect(manager.replaceQuality('high')).rejects.toThrow(/failed/);

    expect(scene.children).toEqual([made[0].root]);
    expect(made[0].dispose).not.toHaveBeenCalled();
    expect(made[1].dispose).toHaveBeenCalledOnce();
  });

  test('a failed quality request can be retried because only committed quality advances', async () => {
    const { manager, made } = managerHarness();
    await manager.ensure(body('veyra'));
    manager.setBoundaries({ loadAssets: async () => { throw new Error('load failed'); } });
    await expect(manager.replaceQuality('high')).rejects.toThrow('load failed');
    manager.setBoundaries({ loadAssets: async () => assets() });

    await manager.replaceQuality('high');

    expect(made).toHaveLength(3);
    expect(manager.current()?.quality).toBe('high');
  });

  test('rejects a candidate whose transient allocation exceeds the tier budget', async () => {
    const { manager, scene, made, ledger } = managerHarness();
    await manager.ensure(body('veyra'));
    manager.setBoundaries({ loadAssets: async () => assets({ transientBytes: 101 }) });

    await expect(manager.replaceQuality('high')).rejects.toThrow(/transient.*budget/i);

    expect(scene.children).toEqual([made[0].root]);
    expect(made[1].dispose).toHaveBeenCalledOnce();
    expect(ledger.residentFlightBodyIds()).toEqual(['veyra']);
  });

  test('keeps exactly one flight-scale pack resident when the committed body changes', async () => {
    const { manager, made, ledger } = managerHarness();
    await manager.ensure(body('veyra'));
    await manager.ensure(body('cinder'));

    expect(ledger.residentFlightBodyIds()).toEqual(['cinder']);
    expect(made[0].dispose).toHaveBeenCalledOnce();
    expect(made[1].dispose).not.toHaveBeenCalled();
  });

  test('a non-flight commit clears and disposes the prior flight-scale residency', async () => {
    const firstAssets = assets();
    const nextAssets = assets({ flightScale: false });
    const loadAssets = vi.fn()
      .mockResolvedValueOnce(firstAssets)
      .mockResolvedValueOnce(nextAssets);
    const { manager, ledger } = managerHarness({ loadAssets });
    await manager.ensure(body('veyra'));

    await manager.ensure(body('auren'));

    expect(ledger.residentFlightBodyIds()).toEqual([]);
    expect(firstAssets.dispose).toHaveBeenCalledOnce();
  });

  test('compact managers cannot evict another owner and flight claims wait for explicit release', async () => {
    const ledger = new RendererResourceLedger({
      activeBodyGpuBytes: { low: 100, medium: 100, high: 100 },
      transientPeakBytes: { low: 100, medium: 100, high: 100 },
    });
    const flightA = assets();
    const compactB = assets({ flightScale: false });
    const flightB = assets();
    const a = managerHarness({ ledger, loadAssets: async () => flightA });
    const b = managerHarness({ ledger, loadAssets: async () => compactB });
    await a.manager.ensure(body('veyra'));

    await b.manager.ensure(body('auren'));
    expect(ledger.residentFlightBodyIds()).toEqual(['veyra']);
    expect(flightA.dispose).not.toHaveBeenCalled();

    b.manager.setBoundaries({ loadAssets: async () => flightB });
    await expect(b.manager.rebuildCommitted()).rejects.toThrow(/flight.*resident|owned/i);
    expect(ledger.residentFlightBodyIds()).toEqual(['veyra']);
    expect(flightB.dispose).toHaveBeenCalledOnce();

    a.manager.dispose();
    expect(ledger.residentFlightBodyIds()).toEqual([]);
    await b.manager.rebuildCommitted();
    expect(ledger.residentFlightBodyIds()).toEqual(['auren']);
  });

  test('dispose invalidates an in-flight transaction before it can commit', async () => {
    const load = deferred<LoadedRendererAssets>();
    const loaded = assets();
    const { manager, scene, made, ledger } = managerHarness({ loadAssets: () => load.promise });
    const pending = manager.ensure(body('veyra'));
    await Promise.resolve();

    manager.dispose();
    load.resolve(loaded);

    await expect(pending).rejects.toThrow(/stale|disposed/i);
    expect(scene.children).toHaveLength(0);
    expect(made[0].dispose).toHaveBeenCalledOnce();
    expect(loaded.dispose).toHaveBeenCalledOnce();
    expect(ledger.residentFlightBodyIds()).toEqual([]);
  });

  test('rebuildCommitted retains quality and replaces visual state only', async () => {
    const simulationRecipe = Object.freeze({ terrainSeed: 17, collisionRadius: 9 });
    const visualBody = { id: 'veyra', def: { simulationRecipe } } as never;
    const { manager, made } = managerHarness();
    await manager.ensure(visualBody);

    await manager.rebuildCommitted();

    expect(made).toHaveLength(2);
    expect(made[1].renderer.quality).toBe('medium');
    expect((visualBody as { def: { simulationRecipe: unknown } }).def.simulationRecipe).toBe(simulationRecipe);
  });

  test('inherits the committed root transform before exposing a replacement', async () => {
    const { manager, made } = managerHarness();
    await manager.ensure(body('veyra'));
    made[0].root.position.set(11, 12, 13);
    made[0].root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
    made[0].root.scale.set(2, 3, 4);

    await manager.replaceQuality('high');

    expect(made[1].root.position).toEqual(made[0].root.position);
    expect(made[1].root.quaternion.toArray()).toEqual(made[0].root.quaternion.toArray());
    expect(made[1].root.scale).toEqual(made[0].root.scale);
  });
});

describe('planet asset loading boundary', () => {
  const checkedManifest: CheckedPlanetManifest = {
    approvedByValidator: true,
    packs: [{
      bodyId: 'veyra', tier: 'medium', transientBytes: 10,
      channels: [{
        name: 'albedo',
        packagePath: 'veyra/albedo.ktx2',
        fallbackPath: 'veyra/albedo.webp',
        gpuBytes: 20,
      }],
    }],
  };

  test('detects KTX support before loading and uses the declared conventional fallback when unavailable', async () => {
    const order: string[] = [];
    const ktx2 = {
      setTranscoderPath: vi.fn().mockReturnThis(),
      detectSupport: vi.fn(() => { order.push('detect'); return ktx2; }),
      loadAsync: vi.fn(async () => { order.push('ktx'); return new THREE.Texture(); }),
    };
    const loadConventional = vi.fn(async (path: string) => {
      order.push(`fallback:${path}`);
      return new THREE.Texture();
    });
    const loader = new PlanetAssetLoader({
      renderer: {} as never,
      manifest: checkedManifest,
      compressedSupported: false,
      ktx2,
      loadConventional,
    });

    await loader.load('veyra', 'medium');

    expect(ktx2.setTranscoderPath).toHaveBeenCalledWith('./basis/');
    expect(order).toEqual(['detect', 'fallback:veyra/albedo.webp']);
    expect(ktx2.loadAsync).not.toHaveBeenCalled();
  });

  test('rejects manifests not approved by validation and non-local entries', async () => {
    const base = { renderer: {} as never, ktx2: {
      setTranscoderPath: vi.fn().mockReturnThis(), detectSupport: vi.fn(), loadAsync: vi.fn(),
    }, compressedSupported: false, loadConventional: vi.fn() };
    expect(() => new PlanetAssetLoader({ ...base, manifest: { ...checkedManifest, approvedByValidator: false } })).toThrow(/validator-approved/i);
    const remote = structuredClone(checkedManifest) as {
      approvedByValidator: boolean;
      packs: Array<{ bodyId: string; tier: QualityTier; transientBytes: number; channels: Array<{
        name: string; packagePath: string; fallbackPath: string; gpuBytes: number;
      }> }>;
    };
    remote.packs[0].channels[0].fallbackPath = 'https://example.test/albedo.webp';
    const loader = new PlanetAssetLoader({ ...base, manifest: remote });
    await expect(loader.load('veyra', 'medium')).rejects.toThrow(/local manifest entry/i);
  });
});

describe('shader compile boundary and failure accounting', () => {
  test('compiles in an isolated staging scene and restores the debug callback after a shader failure', async () => {
    const previous = vi.fn();
    const renderer = {
      debug: { onShaderError: previous as (...args: unknown[]) => void },
      compileAsync: vi.fn(async (scene: THREE.Scene) => {
        expect(scene.parent).toBeNull();
        expect(scene.children).toHaveLength(1);
        renderer.debug.onShaderError?.('gl', 'program', 'vert', 'frag');
      }),
    };
    const root = new THREE.Group();

    await expect(compileRendererCandidate({
      renderer: renderer as never,
      camera: new THREE.PerspectiveCamera(),
      root,
      body: 'veyra',
      channel: 'surface',
    })).rejects.toThrow(/veyra.*surface.*shader/i);

    expect(renderer.debug.onShaderError).toBe(previous);
    expect(root.parent).toBeNull();
  });

  test('scopes compileAsync rejection and restores the debug callback in finally', async () => {
    const previous = vi.fn();
    const renderer = {
      debug: { onShaderError: previous },
      compileAsync: vi.fn(async () => { throw new Error('driver rejected'); }),
    };
    await expect(compileRendererCandidate({
      renderer: renderer as never,
      camera: new THREE.PerspectiveCamera(),
      root: new THREE.Group(),
      body: 'cinder',
      channel: 'clouds',
    })).rejects.toThrow(/cinder.*clouds.*compile/i);
    expect(renderer.debug.onShaderError).toBe(previous);
  });

  test('logs once per body, tier, channel, and phase while retaining counters', () => {
    const log = vi.fn();
    const failures = new RenderFailureTracker(log);
    const key = { body: 'veyra', tier: 'medium' as const, channel: 'albedo', phase: 'load' as const };
    failures.record(key, new Error('first'));
    failures.record(key, new Error('again'));
    failures.record({ ...key, phase: 'compile' }, new Error('compile'));
    failures.record({ ...key, body: 'cinder' }, new Error('other body'));

    expect(log).toHaveBeenCalledTimes(3);
    expect(failures.stats()).toEqual({ total: 4, load: 3, compile: 1, coverage: 0, budget: 0 });
  });
});
