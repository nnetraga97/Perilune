import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import type { BodyRenderer, QualityTier, RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import {
  BodyRendererManager,
  RendererResourceLedger,
  type LoadedRendererAssets,
} from '../src/render/bodyRendererManager';
import {
  checkPlanetManifest,
  PlanetAssetLoader,
} from '../src/render/planetAssetLoader';
import { compileRendererCandidate } from '../src/render/shaderCompiler';
import { RenderBoundaryError, RenderFailureTracker } from '../src/render/renderFailures';
import { canonicalJson, sha256Utf8 } from '../src/render/checkedManifestDigest';
import { WorldScene } from '../src/render/worldScene';
import checkedPlanetArtifact from '../src/generated/checked-planet-manifest.json';
import { RenderDiagnostics } from '../src/render/renderDiagnostics';

function candidate(bodyId: string, quality: QualityTier = 'medium') {
  const root = new THREE.Group();
  const dispose = vi.fn(() => root.clear());
  const stageAssets = vi.fn();
  const renderer: BodyRenderer = {
    bodyId,
    kind: 'legacy',
    quality,
    root,
    ready: true,
    stageAssets,
    update: vi.fn(),
    stats: () => ({ chunks: 0, visible: 0, terrainActive: false, exposure: 0 }),
    dispose,
  };
  return { renderer, root, dispose, stageAssets };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const body = (id: string) => ({ id }) as never;
const manifestBudgets = {
  activeBodyGpuBytes: { low: 100, medium: 200, high: 300 },
  transientPeakBytes: { low: 150, medium: 250, high: 350 },
};
const artifactFor = (manifest: unknown) => ({
  schemaVersion: 1,
  manifestSha256: sha256Utf8(canonicalJson(manifest)),
  manifest,
});
const assets = (overrides: Partial<LoadedRendererAssets> = {}): LoadedRendererAssets => ({
  gpuBytes: 20,
  transientBytes: 10,
  flightScale: true,
  pack: null,
  dispose: vi.fn(),
  ...overrides,
});

const runtimePack = (
  bodyId: string,
  tier: QualityTier,
  marker: string = tier,
): RuntimeBodyAssetPack => Object.freeze({
  bodyId,
  tier,
  width: tier === 'high' ? 4096 : tier === 'medium' ? 2048 : 1024,
  height: tier === 'high' ? 2048 : tier === 'medium' ? 1024 : 512,
  manifestDigest: marker.padEnd(64, '0').slice(0, 64),
  gpuBytes: 20,
  textures: new Map([[marker, new THREE.Texture()]]),
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
    prepareCandidate: async () => undefined,
    compileCandidate: async () => undefined,
    awaitCoverage: async () => undefined,
    ledger,
    failures: new RenderFailureTracker(() => undefined),
    ...overrides,
  });
  return { manager, scene, made, ledger };
}

describe('transactional body renderer replacement', () => {
  test('exposes tier limits without granting mutation ownership', () => {
    const source = structuredClone(manifestBudgets);
    const ledger = new RendererResourceLedger(source);
    source.activeBodyGpuBytes.low = 999;
    expect(ledger.activeBodyBudget('low')).toBe(100);
    expect(ledger.activeBodyBudget('medium')).toBe(200);
    expect(ledger.activeBodyBudget('high')).toBe(300);
  });

  test('records the successful transaction phases in causal order', async () => {
    let now = 0;
    const diagnostics = new RenderDiagnostics({ quality: 'medium', detailed: true, now: () => now++ });
    const { manager } = managerHarness({ diagnostics });

    await manager.ensure(body('veyra'));

    const events = diagnostics.snapshot().entries
      .filter((entry) => entry.subsystem === 'renderer')
      .map((entry) => entry.event);
    expect(events).toEqual([
      'candidate-created',
      'asset-load-start',
      'assets-staged',
      'candidate-prepared',
      'compile-start',
      'compile-success',
      'coverage-ready',
      'budget-accepted',
      'renderer-committed',
      'renderer-boundary',
    ]);
  });

  test('stages the typed runtime pack before preparation and compilation', async () => {
    const order: string[] = [];
    const pack = runtimePack('veyra', 'medium');
    const stagedCandidates: ReturnType<typeof candidate>[] = [];
    const { manager } = managerHarness({
      loadAssets: async () => {
        order.push('load');
        return assets({ pack });
      },
      createCandidate: (nextBody, tier) => {
        const next = candidate(nextBody.id, tier);
        next.stageAssets.mockImplementation((staged) => {
          expect(staged).toBe(pack);
          order.push('stage');
        });
        stagedCandidates.push(next);
        return next.renderer;
      },
      prepareCandidate: async () => { order.push('prepare'); },
      compileCandidate: async () => { order.push('compile'); },
    });

    await manager.ensure(body('veyra'));

    expect(order).toEqual(['load', 'stage', 'prepare', 'compile']);
    expect(stagedCandidates[0].stageAssets).toHaveBeenCalledWith(pack);
    expect(manager.currentAssetPack()).toBe(pack);
  });

  test('disposes loaded textures and the candidate when staging fails while retaining committed coverage', async () => {
    let failStaging = false;
    const stagedCandidates: ReturnType<typeof candidate>[] = [];
    const { manager, scene } = managerHarness({
      createCandidate: (nextBody, tier) => {
        const next = candidate(nextBody.id, tier);
        if (failStaging) next.stageAssets.mockImplementation(() => { throw new Error('stage failed'); });
        stagedCandidates.push(next);
        return next.renderer;
      },
    });
    await manager.ensure(body('veyra'));
    const pack = runtimePack('veyra', 'high');
    const textureDispose = vi.spyOn([...pack.textures.values()][0], 'dispose');
    const loaded = assets({
      pack,
      dispose: vi.fn(() => { for (const texture of pack.textures.values()) texture.dispose(); }),
    });
    manager.setBoundaries({ loadAssets: async () => loaded });
    stagedCandidates[0].root.visible = true;
    failStaging = true;

    await expect(manager.replaceQuality('high')).rejects.toThrow('stage failed');

    expect(scene.children).toEqual([stagedCandidates[0].root]);
    expect(stagedCandidates[0].dispose).not.toHaveBeenCalled();
    expect(stagedCandidates[1].dispose).toHaveBeenCalledOnce();
    expect(loaded.dispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
  });

  test('stages null as a valid procedural fallback', async () => {
    const { manager, made } = managerHarness({ loadAssets: async () => assets({ pack: null }) });

    await manager.ensure(body('auren'));

    expect(made[0].stageAssets).toHaveBeenCalledOnce();
    expect(made[0].stageAssets).toHaveBeenCalledWith(null);
  });

  test('quality and context rebuilds stage only the pack loaded for each candidate', async () => {
    const medium = runtimePack('veyra', 'medium', 'medium');
    const high = runtimePack('veyra', 'high', 'high');
    const restored = runtimePack('veyra', 'high', 'restored');
    const packs = [medium, high, restored];
    const { manager, made } = managerHarness({
      loadAssets: async () => assets({ pack: packs.shift()! }),
    });

    await manager.ensure(body('veyra'));
    expect(manager.currentAssetPack()).toBe(medium);
    await manager.replaceQuality('high');
    expect(manager.currentAssetPack()).toBe(high);
    await manager.rebuildCommitted();
    expect(manager.currentAssetPack()).toBe(restored);

    expect(made.map((entry) => entry.stageAssets.mock.calls.map(([pack]) => pack))).toEqual([
      [medium], [high], [restored],
    ]);
  });

  test('cycles Earth and Moon plus tier rebuilds without accumulating renderer roots or assets', async () => {
    const loadedAssets: LoadedRendererAssets[] = [];
    const { manager, made, scene } = managerHarness({
      loadAssets: async () => {
        const loaded = assets({ dispose: vi.fn() });
        loadedAssets.push(loaded);
        return loaded;
      },
    });

    await manager.ensure(body('earth'));
    await manager.ensure(body('moon'));
    await manager.ensure(body('earth'));
    await manager.replaceQuality('high');
    await manager.rebuildCommitted();

    expect(scene.children).toEqual([made.at(-1)!.root]);
    for (const renderer of made.slice(0, -1)) expect(renderer.dispose).toHaveBeenCalledOnce();
    for (const loaded of loadedAssets.slice(0, -1)) expect(loaded.dispose).toHaveBeenCalledOnce();
    manager.dispose();
    expect(made.at(-1)!.dispose).toHaveBeenCalledOnce();
    expect(loadedAssets.at(-1)!.dispose).toHaveBeenCalledOnce();
    expect(scene.children).toHaveLength(0);
  });

  test('reports truthful committed, transaction, failure, and resident resource state', async () => {
    const load = deferred<LoadedRendererAssets>();
    let now = 100;
    const { manager, ledger } = managerHarness({ now: () => now });
    const initialAssets = assets({ gpuBytes: 42, transientBytes: 7 });
    manager.adoptInitial(body('veyra'), candidate('veyra').renderer, initialAssets);
    expect(manager.platformStats()).toMatchObject({ committed: true, transactionActive: false, failures: 0 });
    expect(ledger.snapshot()).toEqual({ bodyId: 'veyra', tier: 'medium', gpuBytes: 42, transientBytes: 7 });

    manager.setBoundaries({ loadAssets: () => load.promise });
    const replacing = manager.replaceQuality('high');
    await vi.waitFor(() => expect(manager.platformStats().transactionActive).toBe(true));
    now = 125;
    expect(manager.platformStats().transitionMs).toBe(25);
    now = 145;
    load.resolve(assets({ gpuBytes: 55, transientBytes: 8 }));
    await replacing;

    expect(manager.platformStats()).toMatchObject({ committed: true, transactionActive: false, transitionMs: 45, failures: 0 });
    expect(ledger.snapshot()).toEqual({ bodyId: 'veyra', tier: 'high', gpuBytes: 55, transientBytes: 8 });
  });

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

  test('materializes the cached active-SOI visual before compile while keeping the candidate hidden', async () => {
    const order: string[] = [];
    const { manager, scene, made } = managerHarness({
      prepareCandidate: async (renderer) => {
        order.push('prepare');
        renderer.root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
        expect(renderer.root.visible).toBe(false);
      },
      compileCandidate: async (renderer) => {
        order.push('compile');
        expect(renderer.root.children.some((child) => child instanceof THREE.Mesh)).toBe(true);
        expect(scene.children).toHaveLength(0);
      },
      awaitCoverage: async () => { order.push('coverage'); },
    });

    await manager.ensure(body('veyra'));

    expect(order).toEqual(['prepare', 'compile', 'coverage']);
    expect(made[0].root.visible).toBe(true);
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

  test('uses a boundary error channel in the log-once failure key', async () => {
    const log = vi.fn();
    const failures = new RenderFailureTracker(log);
    const { manager } = managerHarness({
      failures,
      loadAssets: async (_body, tier) => {
        throw new RenderBoundaryError({ body: 'veyra', tier, channel: 'albedo', phase: 'load' }, 'asset failed');
      },
    });

    await expect(manager.ensure(body('veyra'))).rejects.toThrow('asset failed');

    expect(log).toHaveBeenCalledWith('[renderer:veyra/medium/albedo/load]', expect.any(RenderBoundaryError));
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

  test('active-SOI transition releases the old claim without discarding its live renderer', async () => {
    const ledger = new RendererResourceLedger({
      activeBodyGpuBytes: { low: 100, medium: 100, high: 100 },
      transientPeakBytes: { low: 100, medium: 100, high: 100 },
    });
    const a = managerHarness({ ledger, loadAssets: async () => assets() });
    let promoteB = false;
    let promotionAttempts = 0;
    const b = managerHarness({
      ledger,
      loadAssets: async () => {
        if (promoteB && ++promotionAttempts === 1) throw new Error('promotion load failed');
        return assets({ flightScale: promoteB });
      },
    });
    await a.manager.ensure(body('veyra'));
    await b.manager.ensure(body('cinder'));
    promoteB = true;
    const world = Object.create(WorldScene.prototype) as WorldScene;
    const promotionPending = new Set<string>();
    Object.assign(world as unknown as Record<string, unknown>, {
      scene: new THREE.Scene(),
      bodyRendererManagers: new Map([['veyra', a.manager], ['cinder', b.manager]]),
      bodyRenderers: new Map([['veyra', a.manager.current()], ['cinder', b.manager.current()]]),
      checkedPlanetManifest: { hasPack: () => true },
      flightTerrainBodyId: 'veyra',
      flightPromotionPending: promotionPending,
      flightPromotionFailed: new Set<string>(),
      flightPromotedBodyId: 'veyra',
      quality: 'medium',
      disposed: false,
    });

    (world as unknown as { setFlightTerrainOwner(bodyId: string): void }).setFlightTerrainOwner('cinder');

    await vi.waitFor(() => expect(promotionPending.size).toBe(0));
    expect(ledger.residentFlightBodyIds()).toEqual([]);
    expect(b.manager.current()).toBe(b.made[0].renderer);
    (world as unknown as { setFlightTerrainOwner(bodyId: string): void }).setFlightTerrainOwner('cinder');
    await Promise.resolve();
    expect(promotionAttempts).toBe(1);
    expect(world.retryActiveBodyRenderer()).toBe(true);
    expect(world.retryActiveBodyRenderer()).toBe(false);
    await vi.waitFor(() => expect(ledger.residentFlightBodyIds()).toEqual(['cinder']));
    expect(a.manager.current()).toBe(a.made[0].renderer);
    expect(b.made).toHaveLength(3);
    expect(b.manager.current()).toBe(b.made[2].renderer);
    expect(promotionAttempts).toBe(2);
    Object.assign(world as unknown as Record<string, unknown>, { flightTerrainBodyId: null });
    expect(world.retryActiveBodyRenderer()).toBe(false);
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
  const manifest = {
    schemaVersion: 1,
    budgets: manifestBudgets,
    packs: [{
      bodyId: 'veyra', tier: 'medium', width: 2048, height: 1024, transientBytes: 10,
      channels: [{
        name: 'albedo',
        packagePath: 'veyra/albedo.ktx2',
        fallbackPath: 'veyra/albedo.webp',
        gpuBytes: 20,
        fallbackGpuBytes: 80,
      }, {
        name: 'normal',
        packagePath: 'veyra/normal.ktx2',
        fallbackPath: 'veyra/normal.png',
        gpuBytes: 10,
        fallbackGpuBytes: 40,
      }],
    }],
  };
  const checkedManifest = checkPlanetManifest(artifactFor(manifest));

  test('matches canonical script hashing and rejects a tampered checked artifact', () => {
    expect(sha256Utf8('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
    const original = structuredClone(manifest);
    const artifact = artifactFor(original);
    original.packs[0].channels[0].gpuBytes++;
    expect(() => checkPlanetManifest(artifact)).toThrow(/digest/i);
  });

  test('detects KTX support before loading and uses the declared conventional fallback when unavailable', async () => {
    const order: string[] = [];
    const diagnostics = new RenderDiagnostics({ quality: 'medium', detailed: true, now: () => 1 });
    const ktx2 = {
      setTranscoderPath: vi.fn().mockReturnThis(),
      detectSupport: vi.fn(() => { order.push('detect'); return ktx2; }),
      loadAsync: vi.fn(async () => { order.push('ktx'); return new THREE.Texture(); }),
      dispose: vi.fn(),
    };
    const loadConventional = vi.fn(async (path: string) => {
      order.push(`fallback:${path}`);
      return new THREE.Texture();
    });
    const loader = new PlanetAssetLoader({
      renderer: {} as never,
      manifest: checkedManifest,
      compressedSupported: false,
      transcoderPath: '/perilune/basis/',
      resolveAssetUrl: (path) => `./planets/${path}`,
      ktx2,
      loadConventional,
      diagnostics,
    });

    const loaded = await loader.load('veyra', 'medium');

    expect(ktx2.setTranscoderPath).toHaveBeenCalledWith('/perilune/basis/');
    expect(order).toEqual([
      'detect',
      'fallback:./planets/veyra/albedo.webp',
      'fallback:./planets/veyra/normal.png',
    ]);
    expect(ktx2.loadAsync).not.toHaveBeenCalled();
    expect(loaded.gpuBytes).toBe(120);
    expect(loaded.textures.get('albedo')?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(loaded.textures.get('normal')?.colorSpace).toBe(THREE.NoColorSpace);
    expect(loaded.textures.get('albedo')?.flipY).toBe(false);
    expect(loaded.textures.get('normal')?.flipY).toBe(false);
    expect(diagnostics.snapshot().entries
      .filter((entry) => entry.event === 'asset-channel-selected')
      .map((entry) => entry.data)).toEqual([
      expect.objectContaining({ channel: 'albedo', selectedType: 'conventional', fallback: true }),
      expect.objectContaining({ channel: 'normal', selectedType: 'conventional', fallback: true }),
    ]);
    loader.dispose();
    loader.dispose();
    expect(ktx2.dispose).toHaveBeenCalledOnce();
  });

  test('requires the opaque checked-artifact boundary and rejects invalid artifact paths', () => {
    const base = { renderer: {} as never, ktx2: {
      setTranscoderPath: vi.fn().mockReturnThis(), detectSupport: vi.fn(), loadAsync: vi.fn(), dispose: vi.fn(),
    }, compressedSupported: false, transcoderPath: '/perilune/basis/', resolveAssetUrl: (path: string) => `./planets/${path}`, loadConventional: vi.fn() };
    expect(() => new PlanetAssetLoader({ ...base, manifest: manifest as never })).toThrow(/checked manifest boundary/i);
    const remote = structuredClone(manifest);
    remote.packs[0].channels[0].fallbackPath = 'https://example.test/albedo.webp';
    expect(() => checkPlanetManifest(artifactFor(remote))).toThrow(/local manifest entry/i);
  });

  test('does not dispose an application-owned shared KTX2 decoder', () => {
    const ktx2 = {
      setTranscoderPath: vi.fn().mockReturnThis(),
      detectSupport: vi.fn().mockReturnThis(),
      loadAsync: vi.fn(),
      dispose: vi.fn(),
    };
    const loader = new PlanetAssetLoader({
      renderer: {} as never,
      manifest: checkedManifest,
      ktx2,
      ownsKtx2: false,
      compressedSupported: false,
      transcoderPath: '/perilune/basis/',
      resolveAssetUrl: (path) => `./planets/${path}`,
      loadConventional: vi.fn(),
    });

    loader.dispose();

    expect(ktx2.dispose).not.toHaveBeenCalled();
  });

  test('checked artifacts expose authored pack lookup and preserve the real empty baseline', () => {
    const emptyManifest = { schemaVersion: 1, budgets: manifestBudgets, packs: [] };
    const empty = checkPlanetManifest(artifactFor(emptyManifest));
    expect(empty.hasPack('veyra', 'medium')).toBe(false);
    expect(checkedManifest.hasPack('veyra', 'medium')).toBe(true);
    expect(checkedManifest.packs[0]).toMatchObject({ width: 2048, height: 1024 });
    expect(checkedManifest.packs[0].channels[0]).toMatchObject({ gpuBytes: 20, fallbackGpuBytes: 80 });
    expect(empty.budgets).toEqual(manifestBudgets);
    const production = checkPlanetManifest(checkedPlanetArtifact);
    expect(production.packs).toHaveLength(20);
    expect(production.hasPack('earth', 'low')).toBe(true);
    expect(production.hasPack('earth', 'medium')).toBe(true);
    expect(production.hasPack('sun', 'low')).toBe(true);
    expect(production.hasPack('sun', 'medium')).toBe(true);
    expect(production.hasPack('sun', 'high')).toBe(true);
    expect(production.hasPack('earth', 'high')).toBe(true);
    expect(production.hasPack('moon', 'low')).toBe(true);
    expect(production.hasPack('moon', 'medium')).toBe(true);
    expect(production.hasPack('moon', 'high')).toBe(true);
    expect(production.hasPack('mars', 'low')).toBe(true);
    expect(production.hasPack('mars', 'medium')).toBe(true);
    expect(production.hasPack('mars', 'high')).toBe(true);
    expect(production.hasPack('mercury', 'low')).toBe(true);
    expect(production.hasPack('mercury', 'medium')).toBe(true);
    expect(production.hasPack('mercury', 'high')).toBe(true);
    expect(production.hasPack('palla', 'medium')).toBe(true);
    expect(production.hasPack('wisp', 'medium')).toBe(true);
  });

  test('accepts validator-authorized zero resource values', () => {
    const zeroManifest = {
      schemaVersion: 1,
      budgets: {
        activeBodyGpuBytes: { low: 0, medium: 0, high: 0 },
        transientPeakBytes: { low: 0, medium: 0, high: 0 },
      },
      packs: [{
        bodyId: 'veyra', tier: 'medium', width: 1024, height: 512, transientBytes: 0,
        channels: [{ name: 'albedo', packagePath: 'a.ktx2', fallbackPath: 'a.webp', gpuBytes: 0, fallbackGpuBytes: 0 }],
      }],
    };
    expect(checkPlanetManifest(artifactFor(zeroManifest)).hasPack('veyra', 'medium')).toBe(true);
  });

  test('rejects authored packs without positive integer dimensions', () => {
    const missingDimensions = structuredClone(manifest) as Record<string, unknown>;
    delete (missingDimensions.packs as Array<Record<string, unknown>>)[0].width;
    expect(() => checkPlanetManifest(artifactFor(missingDimensions))).toThrow(/dimensions/i);
  });
});

describe('shader compile boundary and failure accounting', () => {
  test('compiles in an isolated staging scene and restores the debug callback after a shader failure', async () => {
    const previous = vi.fn();
    const finish = vi.fn();
    const renderer = {
      debug: { onShaderError: previous as (...args: unknown[]) => void },
      getContext: () => ({ finish }),
      compile: vi.fn((scene: THREE.Scene) => {
        expect(scene.parent).toBeNull();
        expect(scene.children).toHaveLength(1);
        expect(root.visible).toBe(true);
        expect(root.children[0].visible).toBe(true);
        let materials = 0;
        root.traverse((object) => { if (object instanceof THREE.Mesh) materials++; });
        expect(materials).toBe(1);
        renderer.debug.onShaderError?.('gl', 'program', 'vert', 'frag');
      }),
    };
    const originalParent = new THREE.Group();
    const before = new THREE.Group();
    const root = new THREE.Group();
    root.visible = false;
    const hiddenChild = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    hiddenChild.visible = false;
    root.add(hiddenChild);
    originalParent.add(before, root);

    await expect(compileRendererCandidate({
      renderer: renderer as never,
      camera: new THREE.PerspectiveCamera(),
      root,
      body: 'veyra',
      tier: 'medium',
      channel: 'surface',
    })).rejects.toThrow(/veyra.*surface.*shader/i);

    expect(renderer.debug.onShaderError).toBe(previous);
    expect(root.visible).toBe(false);
    expect(hiddenChild.visible).toBe(false);
    expect(root.parent).toBe(originalParent);
    expect(originalParent.children).toEqual([before, root]);
    expect(finish).toHaveBeenCalledOnce();
  });

  test('serializes callback ownership for overlapping compiles on one renderer', async () => {
    const callbacks: Array<(...args: never[]) => void> = [];
    const previous = vi.fn();
    const renderer = {
      debug: { onShaderError: previous as ((...args: never[]) => void) | null },
      compile: vi.fn(() => {
        callbacks.push(renderer.debug.onShaderError!);
        if (callbacks.length === 1) callbacks[0]();
      }),
    };
    const a = compileRendererCandidate({ renderer: renderer as never, camera: new THREE.Camera(), root: new THREE.Group(), body: 'veyra', tier: 'medium', channel: 'albedo' });
    const b = compileRendererCandidate({ renderer: renderer as never, camera: new THREE.Camera(), root: new THREE.Group(), body: 'auren', tier: 'high', channel: 'clouds' });
    await expect(a).rejects.toThrow(/veyra.*albedo.*shader/i);
    await expect(b).resolves.toBeUndefined();
    expect(renderer.compile).toHaveBeenCalledTimes(2);
    expect(callbacks[1]).not.toBe(callbacks[0]);
    expect(renderer.debug.onShaderError).toBe(previous);
  });

  test('scopes compile rejection and restores the debug callback in finally', async () => {
    const previous = vi.fn();
    const renderer = {
      debug: { onShaderError: previous },
      compile: vi.fn(() => { throw new Error('driver rejected'); }),
    };
    await expect(compileRendererCandidate({
      renderer: renderer as never,
      camera: new THREE.PerspectiveCamera(),
      root: new THREE.Group(),
      body: 'cinder',
      tier: 'medium',
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
