import { createLegacyGameState } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import { GameState } from '../src/sim/state';
import { recipeForBody } from '../src/sim/terrainRecipe';
import { buildTerrainChunkGeometry, type TerrainChunkGeometryRequest, type TerrainChunkGeometryResult } from '../src/render/terrain/chunkGeometry';
import { createTerrainTileId } from '../src/render/terrain/tile';
import {
  TerrainRequestScheduler,
  type TerrainRequestClass,
  type TerrainScheduleRequest,
  type TerrainSchedulerExecutor,
} from '../src/render/terrain/terrainScheduler';

const veyra = createLegacyGameState().universe.get('veyra');

function geometryRequest(jobKey: string, generation = 1): TerrainChunkGeometryRequest {
  return {
    jobKey,
    generation,
    tile: createTerrainTileId(0, 2, 0, 0),
    recipe: structuredClone(recipeForBody(veyra)),
    radius: veyra.radius,
    resolution: 3,
    skirtDepth: 2,
    palette: {
      low: [0.2, 0.3, 0.1], mid: [0.4, 0.5, 0.2],
      high: [0.8, 0.8, 0.7], ocean: [0.05, 0.1, 0.2],
    },
  };
}

function scheduled(
  jobKey: string,
  requestClass: TerrainRequestClass,
  overrides: Partial<TerrainScheduleRequest> = {},
): TerrainScheduleRequest {
  return {
    request: geometryRequest(jobKey),
    requestClass,
    visible: true,
    screenSpaceError: 10,
    distanceToViewCenter: 0,
    depth: 2,
    estimatedBytes: 10,
    ...overrides,
  };
}

class ManualExecutor implements TerrainSchedulerExecutor {
  readonly posted: TerrainChunkGeometryRequest[] = [];
  private readonly active = new Map<string, {
    request: TerrainChunkGeometryRequest;
    resolve: (result: TerrainChunkGeometryResult) => void;
    reject: (error: Error) => void;
  }>();
  private completed: TerrainChunkGeometryResult[] = [];

  constructor(private readonly size = 1) {}

  availableSlots(): number { return this.size - this.active.size; }

  submit(request: TerrainChunkGeometryRequest): Promise<TerrainChunkGeometryResult> {
    this.posted.push(request);
    return new Promise((resolve, reject) => {
      this.active.set(request.jobKey, { request, resolve, reject });
    });
  }

  cancelQueued(): boolean { return false; }

  cancelGeneration(generation: number): void {
    for (const [key, job] of this.active) {
      if (job.request.generation !== generation) continue;
      this.active.delete(key);
      job.reject(new Error('generation cancelled'));
    }
    this.completed = this.completed.filter((result) => result.generation !== generation);
  }

  drainCompleted(): TerrainChunkGeometryResult[] {
    const result = this.completed;
    this.completed = [];
    return result;
  }

  timings() {
    return { workers: this.size, pending: 0, active: this.active.size, buildP99Ms: 0 };
  }

  complete(jobKey: string): void {
    const job = this.active.get(jobKey)!;
    this.active.delete(jobKey);
    const result = buildTerrainChunkGeometry(job.request);
    this.completed.push(result);
    job.resolve(result);
  }

  fail(jobKey: string): void {
    const job = this.active.get(jobKey)!;
    this.active.delete(jobKey);
    job.reject(new Error('worker failed'));
  }
}

function completeAndRelease(
  scheduler: TerrainRequestScheduler,
  executor: ManualExecutor,
  jobKey: string,
): void {
  executor.complete(jobKey);
  expect(scheduler.drainCompleted().map((entry) => entry.result.jobKey)).toEqual([jobKey]);
  expect(scheduler.releaseCompleted(jobKey, 1)).toBe(true);
}

describe('terrain request scheduler', () => {
  it('dispatches strict queue classes before within-class priority', () => {
    const executor = new ManualExecutor();
    const scheduler = new TerrainRequestScheduler(executor, 1_000);
    for (const [jobKey, requestClass] of [
      ['background', 'background'],
      ['predicted', 'predicted-refinement'],
      ['visible', 'visible-refinement'],
      ['continuity', 'previous-frame-continuity'],
      ['coverage', 'coverage-blocker'],
    ] as const) scheduler.request(scheduled(jobKey, requestClass), 0);

    for (const expected of ['coverage', 'continuity', 'visible', 'predicted', 'background']) {
      expect(scheduler.dispatch(0, 10)).toBe(1);
      expect(executor.posted.at(-1)?.jobKey).toBe(expected);
      completeAndRelease(scheduler, executor, expected);
    }
  });

  it('uses visibility, aged SSE, view center, depth, then key deterministically', () => {
    const executor = new ManualExecutor();
    const scheduler = new TerrainRequestScheduler(executor, 1_000);
    scheduler.request(scheduled('invisible', 'visible-refinement', { visible: false, screenSpaceError: 100 }), 0);
    scheduler.request(scheduled('young', 'visible-refinement', { screenSpaceError: 10 }), 9_000);
    scheduler.request(scheduled('old', 'visible-refinement', { screenSpaceError: 2 }), 0);
    expect(scheduler.dispatch(10_000, 1)).toBe(1);
    expect(executor.posted.at(-1)?.jobKey).toBe('old');
    completeAndRelease(scheduler, executor, 'old');
    expect(scheduler.dispatch(10_000, 1)).toBe(1);
    expect(executor.posted.at(-1)?.jobKey).toBe('young');
    completeAndRelease(scheduler, executor, 'young');
    expect(scheduler.dispatch(10_000, 1)).toBe(1);
    expect(executor.posted.at(-1)?.jobKey).toBe('invisible');
  });

  it('never promotes old background work above a coverage blocker', () => {
    const executor = new ManualExecutor();
    const scheduler = new TerrainRequestScheduler(executor, 1_000);
    scheduler.request(scheduled('ancient', 'background', { screenSpaceError: 1 }), 0);
    scheduler.request(scheduled('coverage', 'coverage-blocker', { screenSpaceError: 0 }), 1_000_000);
    scheduler.dispatch(1_000_000, 1);
    expect(executor.posted.at(-1)?.jobKey).toBe('coverage');
  });

  it('promotes repeated requests without allowing a later priority downgrade', () => {
    const executor = new ManualExecutor();
    const scheduler = new TerrainRequestScheduler(executor, 1_000);
    scheduler.request(scheduled('shared', 'predicted-refinement'), 0);
    scheduler.request(scheduled('shared', 'coverage-blocker', { root: true }), 1);
    scheduler.request(scheduled('shared', 'visible-refinement'), 2);
    scheduler.request(scheduled('other', 'coverage-blocker'), 2);
    scheduler.dispatch(2, 1);
    expect(executor.posted.at(-1)?.jobKey).toBe('shared');
  });

  it('reserves before dispatch and blocks oversubmission until installation releases bytes', () => {
    const executor = new ManualExecutor(2);
    const scheduler = new TerrainRequestScheduler(executor, 100);
    scheduler.request(scheduled('first', 'visible-refinement', { estimatedBytes: 60 }), 0);
    scheduler.request(scheduled('second', 'visible-refinement', { estimatedBytes: 60 }), 0);
    expect(scheduler.dispatch(0, 2)).toBe(1);
    expect(scheduler.stats()).toMatchObject({ building: 1, reservedBytes: 60, hardReservationBytes: 100 });
    completeAndRelease(scheduler, executor, 'first');
    expect(scheduler.stats().reservedBytes).toBe(0);
    expect(scheduler.dispatch(0, 2)).toBe(1);
    expect(executor.posted.at(-1)?.jobKey).toBe('second');
  });

  it('cancels queued prediction without dispatch and sheds a cancelled active completion', () => {
    const executor = new ManualExecutor();
    const scheduler = new TerrainRequestScheduler(executor, 100);
    scheduler.request(scheduled('queued', 'predicted-refinement'), 0);
    expect(scheduler.cancel('queued', 1)).toBe(true);
    expect(scheduler.dispatch(0, 1)).toBe(0);
    expect(executor.posted).toEqual([]);

    scheduler.request(scheduled('active', 'predicted-refinement'), 0);
    scheduler.dispatch(0, 1);
    expect(scheduler.cancel('active', 1)).toBe(true);
    executor.complete('active');
    expect(scheduler.drainCompleted()).toEqual([]);
    expect(scheduler.stats().reservedBytes).toBe(0);
  });

  it('retries requested failures at 0.25, 0.5, 1, and capped 2 second delays', async () => {
    const executor = new ManualExecutor();
    const scheduler = new TerrainRequestScheduler(executor, 100);
    scheduler.request(scheduled('retry', 'coverage-blocker'), 0);
    const attempts = [0, 250, 750, 1_750, 3_750, 5_750];
    for (let index = 0; index < attempts.length; index++) {
      expect(scheduler.dispatch(attempts[index], 1)).toBe(1);
      executor.fail('retry');
      await Promise.resolve();
      expect(scheduler.stats().failed).toBe(1);
      if (index < attempts.length - 1) {
        expect(scheduler.dispatch(attempts[index + 1] - 1, 1)).toBe(0);
      }
    }
    expect(executor.posted).toHaveLength(attempts.length);
    expect(scheduler.stats().reservedBytes).toBe(0);
  });

  it('cancels a generation and releases every reservation', async () => {
    const executor = new ManualExecutor(2);
    const scheduler = new TerrainRequestScheduler(executor, 100);
    scheduler.request(scheduled('one', 'coverage-blocker', { estimatedBytes: 40 }), 0);
    scheduler.request(scheduled('two', 'visible-refinement', { estimatedBytes: 40 }), 0);
    scheduler.dispatch(0, 2);
    expect(scheduler.stats().reservedBytes).toBe(80);
    scheduler.cancelGeneration(1);
    await Promise.resolve();
    expect(scheduler.stats()).toMatchObject({ queued: 0, building: 0, reservedBytes: 0 });
  });
});
