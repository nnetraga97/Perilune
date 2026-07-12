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
  readonly worker: WorkerLike;
  job: Job | null;
}

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
  private disposed = false;

  constructor(options: Readonly<TerrainChunkWorkerPoolOptions> = {}) {
    const hardwareConcurrency = options.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency ?? 2;
    const size = options.size ?? terrainWorkerPoolSize(hardwareConcurrency);
    if (!Number.isInteger(size) || size < 1) throw new RangeError(`Invalid worker pool size ${size}`);
    const factory = options.workerFactory ?? productionWorker;
    this.slots = Array.from({ length: size }, () => ({ worker: factory(), job: null }));
    for (const slot of this.slots) {
      slot.worker.onmessage = (event) => this.complete(slot, event.data);
      slot.worker.onerror = (event) => this.fail(slot, new Error(event.message || 'Terrain worker failed'));
    }
  }

  submit(request: TerrainChunkGeometryRequest): Promise<TerrainChunkGeometryResult> {
    if (this.disposed) return Promise.reject(new Error('Terrain worker pool is disposed'));
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
      workers: this.slots.length,
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
      if (slot.job !== null) continue;
      while (slot.job === null) {
        const job = this.queue.shift();
        if (!job) return;
        slot.job = job;
        try {
          slot.worker.postMessage(job.request);
        } catch (cause) {
          slot.job = null;
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
    if (dispatched && this.jobs.get(dispatched.request.jobKey) === dispatched) {
      this.jobs.delete(dispatched.request.jobKey);
      dispatched.reject(error);
    }
    this.dispatch();
  }
}
