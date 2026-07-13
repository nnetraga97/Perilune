import type { TerrainChunkGeometryRequest, TerrainChunkGeometryResult } from './chunkGeometry';
import type { TerrainWorkerTimings } from './chunkWorkerPool';

export type TerrainRequestClass =
  | 'coverage-blocker'
  | 'previous-frame-continuity'
  | 'visible-refinement'
  | 'predicted-refinement'
  | 'background';

export interface TerrainScheduleRequest {
  readonly request: TerrainChunkGeometryRequest;
  readonly requestClass: TerrainRequestClass;
  readonly visible: boolean;
  readonly screenSpaceError: number;
  readonly distanceToViewCenter: number;
  readonly depth: number;
  readonly estimatedBytes: number;
}

export interface TerrainSchedulerExecutor {
  availableSlots(): number;
  submit(request: TerrainChunkGeometryRequest): Promise<TerrainChunkGeometryResult>;
  cancelQueued(jobKey: string, generation: number): boolean;
  cancelGeneration(generation: number): void;
  drainCompleted(): TerrainChunkGeometryResult[];
  timings(): TerrainWorkerTimings;
}

export interface TerrainScheduledCompletion {
  readonly result: TerrainChunkGeometryResult;
  readonly requestClass: TerrainRequestClass;
  readonly reservedBytes: number;
}

export interface TerrainSchedulerStats {
  readonly queued: number;
  readonly building: number;
  readonly completed: number;
  readonly failed: number;
  readonly reservedBytes: number;
  readonly hardReservationBytes: number;
}

type ScheduleState = 'queued' | 'building' | 'completed' | 'failed';

interface ScheduleEntry {
  input: TerrainScheduleRequest;
  state: ScheduleState;
  requested: boolean;
  queuedAt: number;
  failures: number;
  nextRetryAt: number;
  reservedBytes: number;
}

const CLASS_RANK: Readonly<Record<TerrainRequestClass, number>> = Object.freeze({
  'coverage-blocker': 0,
  'previous-frame-continuity': 1,
  'visible-refinement': 2,
  'predicted-refinement': 3,
  background: 4,
});

const RETRY_DELAYS_MS = Object.freeze([250, 500, 1_000, 2_000]);

function entryKey(jobKey: string, generation: number): string {
  return `${generation}:${jobKey}`;
}

function validateInput(input: Readonly<TerrainScheduleRequest>): void {
  if (!Number.isFinite(input.screenSpaceError) || input.screenSpaceError < 0) {
    throw new Error(`Invalid scheduled terrain SSE ${input.screenSpaceError}`);
  }
  if (!Number.isFinite(input.distanceToViewCenter) || input.distanceToViewCenter < 0) {
    throw new Error(`Invalid terrain view-center distance ${input.distanceToViewCenter}`);
  }
  if (!Number.isInteger(input.depth) || input.depth < 0) {
    throw new Error(`Invalid scheduled terrain depth ${input.depth}`);
  }
  if (!Number.isInteger(input.estimatedBytes) || input.estimatedBytes < 0) {
    throw new Error(`Invalid terrain byte estimate ${input.estimatedBytes}`);
  }
}

export class TerrainRequestScheduler {
  private readonly entries = new Map<string, ScheduleEntry>();
  private reservedBytes = 0;

  constructor(
    private readonly executor: TerrainSchedulerExecutor,
    private readonly hardReservationBytes: number,
  ) {
    if (!Number.isFinite(hardReservationBytes) || hardReservationBytes < 0) {
      throw new Error(`Invalid terrain hard reservation ${hardReservationBytes}`);
    }
  }

  request(input: Readonly<TerrainScheduleRequest>, now: number): void {
    validateInput(input);
    if (!Number.isFinite(now)) throw new Error(`Invalid terrain scheduler time ${now}`);
    const key = entryKey(input.request.jobKey, input.request.generation);
    const existing = this.entries.get(key);
    if (existing) {
      existing.input = input;
      existing.requested = true;
      return;
    }
    this.entries.set(key, {
      input,
      state: 'queued',
      requested: true,
      queuedAt: now,
      failures: 0,
      nextRetryAt: now,
      reservedBytes: 0,
    });
  }

  cancel(jobKey: string, generation: number): boolean {
    const key = entryKey(jobKey, generation);
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.requested = false;
    if (entry.state === 'building') {
      // Scheduler dispatches only into a free executor slot, so this normally
      // cannot be pool-queued. Keep its reservation until completion is shed.
      if (!this.executor.cancelQueued(jobKey, generation)) return true;
    }
    this.release(entry);
    this.entries.delete(key);
    return true;
  }

  cancelGeneration(generation: number): void {
    this.executor.cancelGeneration(generation);
    for (const [key, entry] of this.entries) {
      if (entry.input.request.generation !== generation) continue;
      this.release(entry);
      this.entries.delete(key);
    }
  }

  dispatch(now: number, maximumSubmissions: number): number {
    if (!Number.isFinite(now)) throw new Error(`Invalid terrain scheduler time ${now}`);
    if (!Number.isInteger(maximumSubmissions) || maximumSubmissions < 0) {
      throw new Error(`Invalid terrain submission limit ${maximumSubmissions}`);
    }
    let submitted = 0;
    while (submitted < maximumSubmissions && this.executor.availableSlots() > 0) {
      const candidates = [...this.entries.values()]
        .filter((entry) => (
          entry.requested
          && (entry.state === 'queued' || entry.state === 'failed')
          && entry.nextRetryAt <= now
          && this.reservedBytes + entry.input.estimatedBytes <= this.hardReservationBytes
        ))
        .sort((a, b) => this.compare(a, b, now));
      const entry = candidates[0];
      if (!entry) break;
      entry.state = 'building';
      entry.reservedBytes = entry.input.estimatedBytes;
      this.reservedBytes += entry.reservedBytes;
      submitted++;
      const key = entryKey(entry.input.request.jobKey, entry.input.request.generation);
      void this.executor.submit(entry.input.request).catch(() => {
        const current = this.entries.get(key);
        if (current !== entry || current.state !== 'building') return;
        this.release(current);
        if (!current.requested) {
          this.entries.delete(key);
          return;
        }
        current.failures++;
        current.state = 'failed';
        current.nextRetryAt = now + RETRY_DELAYS_MS[Math.min(
          current.failures - 1,
          RETRY_DELAYS_MS.length - 1,
        )];
      });
    }
    return submitted;
  }

  drainCompleted(): TerrainScheduledCompletion[] {
    const completed: TerrainScheduledCompletion[] = [];
    for (const result of this.executor.drainCompleted()) {
      const key = entryKey(result.jobKey, result.generation);
      const entry = this.entries.get(key);
      if (!entry || entry.state !== 'building') continue;
      if (!entry.requested) {
        this.release(entry);
        this.entries.delete(key);
        continue;
      }
      entry.state = 'completed';
      completed.push(Object.freeze({
        result,
        requestClass: entry.input.requestClass,
        reservedBytes: entry.reservedBytes,
      }));
    }
    return completed;
  }

  releaseCompleted(jobKey: string, generation: number): boolean {
    const key = entryKey(jobKey, generation);
    const entry = this.entries.get(key);
    if (!entry || entry.state !== 'completed') return false;
    this.release(entry);
    this.entries.delete(key);
    return true;
  }

  stats(): TerrainSchedulerStats {
    const counts: Record<ScheduleState, number> = {
      queued: 0,
      building: 0,
      completed: 0,
      failed: 0,
    };
    for (const entry of this.entries.values()) counts[entry.state]++;
    return Object.freeze({
      ...counts,
      reservedBytes: this.reservedBytes,
      hardReservationBytes: this.hardReservationBytes,
    });
  }

  private compare(a: Readonly<ScheduleEntry>, b: Readonly<ScheduleEntry>, now: number): number {
    const classDifference = CLASS_RANK[a.input.requestClass] - CLASS_RANK[b.input.requestClass];
    if (classDifference !== 0) return classDifference;
    if (a.input.visible !== b.input.visible) return a.input.visible ? -1 : 1;
    const aAgeSeconds = Math.max(0, now - a.queuedAt) / 1_000;
    const bAgeSeconds = Math.max(0, now - b.queuedAt) / 1_000;
    const scoreDifference = (b.input.screenSpaceError + bAgeSeconds)
      - (a.input.screenSpaceError + aAgeSeconds);
    if (scoreDifference !== 0) return scoreDifference;
    const centerDifference = a.input.distanceToViewCenter - b.input.distanceToViewCenter;
    if (centerDifference !== 0) return centerDifference;
    const depthDifference = a.input.depth - b.input.depth;
    if (depthDifference !== 0) return depthDifference;
    return a.input.request.jobKey.localeCompare(b.input.request.jobKey);
  }

  private release(entry: ScheduleEntry): void {
    this.reservedBytes -= entry.reservedBytes;
    if (this.reservedBytes < 0) this.reservedBytes = 0;
    entry.reservedBytes = 0;
  }
}
