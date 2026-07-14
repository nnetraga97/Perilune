import type { TerrainChunkGeometryRequest, TerrainChunkGeometryResult } from './chunkGeometry';

export interface WorkerLike {
  onmessage: ((event: MessageEvent<TerrainChunkGeometryResult>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: TerrainChunkGeometryRequest): void;
  terminate(): void;
}

export type TerrainWorkerFactory = () => WorkerLike;

export interface TerrainChunkWorkerPoolOptions {
  readonly size?: number;
  readonly hardwareConcurrency?: number;
  readonly workerFactory?: TerrainWorkerFactory;
  readonly jobTimeoutMs?: number;
}

export interface TerrainWorkerTimings {
  readonly workers: number;
  readonly pending: number;
  readonly active: number;
  readonly buildP99Ms: number;
}

interface Job {
  readonly request: TerrainChunkGeometryRequest;
  readonly resolve: (result: TerrainChunkGeometryResult) => void;
  readonly reject: (reason: Error) => void;
}

interface Slot {
  worker: WorkerLike;
  job: Job | null;
  dead: boolean;
  dispatchedAt: number;
}

/** Replacement workers allowed per slot before the slot is retired. */
const RESPAWNS_PER_SLOT = 2;

export function terrainWorkerPoolSize(hardwareConcurrency: number): number {
  const concurrency = Number.isFinite(hardwareConcurrency) ? Math.floor(hardwareConcurrency) : 2;
  return Math.max(1, Math.min(4, concurrency - 1));
}

function productionWorker(): WorkerLike {
  return new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module' });
}

export class TerrainChunkWorkerPool {
  private readonly slots: Slot[];
  private readonly jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private completed: TerrainChunkGeometryResult[] = [];
  private readonly buildTimings: number[] = [];
  private readonly factory: TerrainWorkerFactory;
  private readonly jobTimeoutMs: number;
  private respawnsRemaining: number;
  private disposed = false;

  constructor(options: Readonly<TerrainChunkWorkerPoolOptions> = {}) {
    const hardwareConcurrency = options.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency ?? 2;
    const size = options.size ?? terrainWorkerPoolSize(hardwareConcurrency);
    if (!Number.isInteger(size) || size < 1) throw new RangeError(`Invalid worker pool size ${size}`);
    this.factory = options.workerFactory ?? productionWorker;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 15_000;
    if (!Number.isFinite(this.jobTimeoutMs) || this.jobTimeoutMs <= 0) {
      throw new RangeError(`Invalid terrain worker timeout ${this.jobTimeoutMs}`);
    }
    this.respawnsRemaining = size * RESPAWNS_PER_SLOT;
    this.slots = Array.from({ length: size }, () => ({
      worker: this.factory(), job: null, dead: false, dispatchedAt: 0,
    }));
    for (const slot of this.slots) this.wireSlot(slot);
  }

  private wireSlot(slot: Slot): void {
    slot.worker.onmessage = (event) => this.complete(slot, event.data);
    slot.worker.onerror = (event) => this.fail(slot, new Error(event.message || 'Terrain worker failed'));
  }

  submit(request: TerrainChunkGeometryRequest): Promise<TerrainChunkGeometryResult> {
    if (this.disposed) return Promise.reject(new Error('Terrain worker pool is disposed'));
    if (this.slots.every((slot) => slot.dead)) {
      return Promise.reject(new Error('Terrain worker pool has no live workers'));
    }
    if (this.jobs.has(request.jobKey)) {
      return Promise.reject(new Error(`Duplicate terrain job key: ${request.jobKey}`));
    }
    return new Promise((resolve, reject) => {
      const job: Job = { request, resolve, reject };
      this.jobs.set(request.jobKey, job);
      this.queue.push(job);
      this.dispatch();
    });
  }

  availableSlots(): number {
    if (this.disposed) return 0;
    return this.slots.filter((slot) => !slot.dead && slot.job === null).length;
  }

  /** Fail and replace workers whose dispatched job stopped making progress. */
  checkHealth(now = performance.now()): void {
    if (this.disposed) return;
    for (const slot of this.slots) {
      if (!slot.job || slot.dead || now - slot.dispatchedAt <= this.jobTimeoutMs) continue;
      this.fail(slot, new Error(
        `Terrain worker timed out after ${Math.round(now - slot.dispatchedAt)} ms`,
      ));
    }
  }

  /** Cancel work that has not reached a worker. Building jobs are immutable. */
  cancelQueued(jobKey: string, generation: number): boolean {
    const index = this.queue.findIndex((job) => (
      job.request.jobKey === jobKey && job.request.generation === generation
    ));
    if (index < 0) return false;
    const [job] = this.queue.splice(index, 1);
    if (this.jobs.get(jobKey) === job) this.jobs.delete(jobKey);
    job.reject(new Error(`Terrain job ${jobKey} cancelled before dispatch`));
    return true;
  }

  cancelGeneration(generation: number): void {
    for (const job of [...this.jobs.values()]) {
      if (job.request.generation !== generation) continue;
      this.jobs.delete(job.request.jobKey);
      job.reject(new Error(`Terrain generation ${generation} cancelled`));
    }
    this.queue = this.queue.filter((job) => job.request.generation !== generation);
    this.completed = this.completed.filter((result) => result.generation !== generation);
  }

  drainCompleted(): TerrainChunkGeometryResult[] {
    const drained = this.completed;
    this.completed = [];
    return drained;
  }

  timings(): TerrainWorkerTimings {
    const ordered = [...this.buildTimings].sort((a, b) => a - b);
    const p99Index = Math.max(0, Math.ceil(ordered.length * 0.99) - 1);
    return Object.freeze({
      workers: this.slots.filter((slot) => !slot.dead).length,
      pending: this.queue.length,
      active: this.slots.filter((slot) => slot.job !== null).length,
      buildP99Ms: ordered[p99Index] ?? 0,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.jobs.values()) job.reject(new Error('Terrain worker pool disposed'));
    this.jobs.clear();
    this.queue = [];
    this.completed = [];
    for (const slot of this.slots) {
      slot.worker.onmessage = null;
      slot.worker.onerror = null;
      slot.worker.terminate();
      slot.job = null;
    }
  }

  private dispatch(): void {
    if (this.disposed) return;
    for (const slot of this.slots) {
      if (slot.dead || slot.job !== null) continue;
      while (slot.job === null) {
        const job = this.queue.shift();
        if (!job) return;
        slot.job = job;
        slot.dispatchedAt = performance.now();
        try {
          slot.worker.postMessage(job.request);
        } catch (cause) {
          slot.job = null;
          slot.dispatchedAt = 0;
          if (this.jobs.get(job.request.jobKey) === job) {
            this.jobs.delete(job.request.jobKey);
            job.reject(cause instanceof Error ? cause : new Error(String(cause)));
          }
        }
      }
    }
  }

  private complete(slot: Slot, result: TerrainChunkGeometryResult): void {
    const dispatched = slot.job;
    slot.job = null;
    slot.dispatchedAt = 0;
    if (
      dispatched?.request.jobKey === result.jobKey &&
      dispatched.request.generation === result.generation
    ) {
      const job = this.jobs.get(result.jobKey);
      if (job === dispatched) {
        this.jobs.delete(result.jobKey);
        this.completed.push(result);
        this.buildTimings.push(result.buildMs);
        if (this.buildTimings.length > 128) this.buildTimings.shift();
        job.resolve(result);
      }
    }
    this.dispatch();
  }

  private fail(slot: Slot, error: Error): void {
    const dispatched = slot.job;
    slot.job = null;
    slot.dispatchedAt = 0;
    if (dispatched && this.jobs.get(dispatched.request.jobKey) === dispatched) {
      this.jobs.delete(dispatched.request.jobKey);
      dispatched.reject(error);
    }
    // An errored worker may be permanently broken (failed module load, crash);
    // replace it within the bounded respawn budget instead of feeding it jobs.
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    slot.worker.terminate();
    if (this.respawnsRemaining > 0) {
      this.respawnsRemaining--;
      slot.worker = this.factory();
      this.wireSlot(slot);
    } else {
      slot.dead = true;
      if (this.slots.every((candidate) => candidate.dead)) {
        for (const job of this.jobs.values()) job.reject(new Error('Terrain worker pool has no live workers'));
        this.jobs.clear();
        this.queue = [];
      }
    }
    this.dispatch();
  }
}
