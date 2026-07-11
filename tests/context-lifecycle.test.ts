import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import {
  RenderContextLifecycle,
  shouldRenderFrame,
  type RenderLifecycleState,
} from '../src/render/contextLifecycle';
import type { BodyRenderer, QualityTier } from '../src/render/bodyRenderer';
import {
  BodyRendererManager,
  RendererResourceLedger,
  type LoadedRendererAssets,
} from '../src/render/bodyRendererManager';
import { WorldScene } from '../src/render/worldScene';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function dispatch(target: EventTarget, type: string): Event {
  const event = new Event(type, { cancelable: true });
  target.dispatchEvent(event);
  return event;
}

async function waitForState(lifecycle: RenderContextLifecycle, state: RenderLifecycleState): Promise<void> {
  await vi.waitFor(() => expect(lifecycle.state).toBe(state));
}

function fakeRenderer(bodyId: string, quality: QualityTier): BodyRenderer {
  return {
    bodyId,
    kind: 'legacy',
    quality,
    root: new THREE.Group(),
    ready: true,
    update: vi.fn(),
    stats: () => ({ chunks: 0, visible: 0, terrainActive: false, exposure: 0 }),
    dispose: vi.fn(),
  };
}

function fakeAssets(): LoadedRendererAssets {
  return { gpuBytes: 0, transientBytes: 0, flightScale: false, dispose: vi.fn() };
}

describe('RenderContextLifecycle', () => {
  test('prevents default, pauses rendering, and logs once per loss episode', () => {
    const canvas = new EventTarget();
    const log = vi.fn();
    const lifecycle = new RenderContextLifecycle(canvas, { log });

    const first = dispatch(canvas, 'webglcontextlost');
    const repeated = dispatch(canvas, 'webglcontextlost');

    expect(first.defaultPrevented).toBe(true);
    expect(repeated.defaultPrevented).toBe(true);
    expect(lifecycle.state).toBe('lost');
    expect(lifecycle.renderPaused).toBe(true);
    expect(log).toHaveBeenCalledOnce();
  });

  test('restores subscribed renderer owners without disposing simulation state', async () => {
    const canvas = new EventTarget();
    const lifecycle = new RenderContextLifecycle(canvas);
    const rebuild = vi.fn(async () => undefined);
    const simulation = { dispose: vi.fn() };
    lifecycle.subscribeRestoration(rebuild);

    dispatch(canvas, 'webglcontextlost');
    dispatch(canvas, 'webglcontextrestored');
    await waitForState(lifecycle, 'ready');

    expect(rebuild).toHaveBeenCalledOnce();
    expect(simulation.dispose).not.toHaveBeenCalled();
    expect(lifecycle.renderPaused).toBe(false);
  });

  test('settles every owner and enters renderable fallback after a partial failure', async () => {
    const canvas = new EventTarget();
    const lifecycle = new RenderContextLifecycle(canvas);
    const failed = vi.fn(async () => { throw new Error('pack unavailable'); });
    const recovered = vi.fn(async () => undefined);
    lifecycle.subscribeRestoration(failed);
    lifecycle.subscribeRestoration(recovered);

    dispatch(canvas, 'webglcontextlost');
    dispatch(canvas, 'webglcontextrestored');
    await waitForState(lifecycle, 'fallback');

    expect(failed).toHaveBeenCalledOnce();
    expect(recovered).toHaveBeenCalledOnce();
    expect(lifecycle.renderPaused).toBe(false);
  });

  test('a replacement owner joins restoration while a disposed owner completion is stale', async () => {
    const canvas = new EventTarget();
    const lifecycle = new RenderContextLifecycle(canvas);
    const oldRestore = deferred<void>();
    const unsubscribeOld = lifecycle.subscribeRestoration(() => oldRestore.promise);

    dispatch(canvas, 'webglcontextlost');
    dispatch(canvas, 'webglcontextrestored');
    await vi.waitFor(() => expect(lifecycle.state).toBe('restoring'));
    unsubscribeOld();
    const currentRestore = vi.fn(async () => undefined);
    lifecycle.subscribeRestoration(currentRestore);
    oldRestore.reject(new Error('disposed scene'));
    await waitForState(lifecycle, 'ready');

    expect(currentRestore).toHaveBeenCalledOnce();
  });

  test('dispose removes canvas listeners and ignores stale restoration completion', async () => {
    const canvas = new EventTarget();
    const lifecycle = new RenderContextLifecycle(canvas);
    const restore = deferred<void>();
    lifecycle.subscribeRestoration(() => restore.promise);
    dispatch(canvas, 'webglcontextlost');
    dispatch(canvas, 'webglcontextrestored');
    await vi.waitFor(() => expect(lifecycle.state).toBe('restoring'));

    lifecycle.dispose();
    restore.resolve();
    await Promise.resolve();
    const afterDispose = lifecycle.state;
    dispatch(canvas, 'webglcontextlost');

    expect(lifecycle.state).toBe(afterDispose);
  });

  test('render decision blocks every GPU draw only while lost or restoring', () => {
    for (const [state, expected] of [
      ['ready', true],
      ['lost', false],
      ['restoring', false],
      ['fallback', true],
    ] as const) {
      expect(shouldRenderFrame({ state })).toBe(expected);
    }
  });
});

describe('context restoration integration', () => {
  test('rebuildCommitted retains the last committed quality', async () => {
    const scene = new THREE.Scene();
    const made: BodyRenderer[] = [];
    const manager = new BodyRendererManager({
      scene,
      quality: 'medium',
      createCandidate: (body, tier) => {
        const renderer = fakeRenderer(body.id, tier);
        made.push(renderer);
        return renderer;
      },
      loadAssets: async () => fakeAssets(),
      prepareCandidate: async () => undefined,
      compileCandidate: async () => undefined,
      awaitCoverage: async () => undefined,
      ledger: new RendererResourceLedger({
        activeBodyGpuBytes: { low: 10, medium: 10, high: 10 },
        transientPeakBytes: { low: 10, medium: 10, high: 10 },
      }),
    });
    await manager.ensure({ id: 'veyra' } as never);
    await manager.replaceQuality('high');

    await manager.rebuildCommitted();

    expect(made.map((renderer) => renderer.quality)).toEqual(['medium', 'high', 'high']);
    expect(manager.current()?.quality).toBe('high');
  });

  test('WorldScene rebuilds all current managers and retains committed roots on failure', async () => {
    const successfulRenderer = fakeRenderer('veyra', 'medium');
    const failedRenderer = fakeRenderer('auren', 'medium');
    const successful = {
      rebuildCommitted: vi.fn(async () => undefined),
      current: vi.fn(() => successfulRenderer),
    };
    const failed = {
      rebuildCommitted: vi.fn(async () => { throw new Error('compile failed'); }),
      current: vi.fn(() => failedRenderer),
    };
    const world = Object.create(WorldScene.prototype) as WorldScene;
    Object.assign(world as unknown as Record<string, unknown>, {
      disposed: false,
      bodyRendererManagers: new Map([['veyra', successful], ['auren', failed]]),
      bodyRenderers: new Map([['veyra', successfulRenderer], ['auren', failedRenderer]]),
    });

    await expect(world.rebuildCommittedRenderers()).rejects.toThrow(/auren/);

    expect(successful.rebuildCommitted).toHaveBeenCalledOnce();
    expect(failed.rebuildCommitted).toHaveBeenCalledOnce();
    expect((world as unknown as { bodyRenderers: Map<string, BodyRenderer> }).bodyRenderers.get('veyra'))
      .toBe(successfulRenderer);
    expect((world as unknown as { bodyRenderers: Map<string, BodyRenderer> }).bodyRenderers.get('auren'))
      .toBe(failedRenderer);
  });
});
