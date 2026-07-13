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
  /** Universal generation fallbacks win within the coverage-blocker class. */
  readonly root?: boolean;
}

export interface TerrainSchedulerExecutor {
  availableSlots(): number;
  submit(request: TerrainChunkGeometryRequest): Promise<TerrainChunkGeometryResult>;
  cancelQueued(jobKey: string, generation: number): boolean;
  cancelGeneration(generation: number): void;
  drainCompleted(): TerrainChunkGeometryResult[];
  timings(): TerrainWorkerTimings;
}

export interface TerrainReservationPort {
  readonly hardReservationBytes: number;
  tryReserve(key: string, bytes: number, requestClass: TerrainRequestClass): boolean;
  releaseReservation(key: string): boolean;
  reservationBytes(): number;
}

export interface TerrainScheduledCompletion {
  readonly result: TerrainChunkGeometryResult;
  readonly requestClass: TerrainRequestClass;
  readonly reservationKey: string;
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

class SimpleTerrainReservationPort implements TerrainReservationPort {
  private readonly reservations = new Map<string, number>();
  private total = 0;

  constructor(readonly hardReservationBytes: number) {}

  tryReserve(key: string, bytes: number): boolean {
    if (this.reservations.has(key)) return false;
    if (this.total + bytes > this.hardReservationBytes) return false;
    this.reservations.set(key, bytes);
    this.total += bytes;
    return true;
  }

  releaseReservation(key: string): boolean {
    const bytes = this.reservations.get(key);
    if (bytes === undefined) return false;
    this.reservations.delete(key);
    this.total -= bytes;
    return true;
  }

  reservationBytes(): number { return this.total; }
}

export class TerrainRequestScheduler {
  private readonly entries = new Map<string, ScheduleEntry>();
  private readonly reservations: TerrainReservationPort;

  constructor(
    private readonly executor: TerrainSchedulerExecutor,
    reservationPolicy: number | TerrainReservationPort,
  ) {
    const hardReservationBytes = typeof reservationPolicy === 'number'
      ? reservationPolicy
      : reservationPolicy.hardReservationBytes;
    if (!Number.isFinite(hardReservationBytes) || hardReservationBytes < 0) {
      throw new Error(`Invalid terrain hard reservation ${hardReservationBytes}`);
    }
    this.reservations = typeof reservationPolicy === 'number'
      ? new SimpleTerrainReservationPort(reservationPolicy)
      : reservationPolicy;
  }

  request(input: Readonly<TerrainScheduleRequest>, now: number): void {
    validateInput(input);
    if (!Number.isFinite(now)) throw new Error(`Invalid terrain scheduler time ${now}`);
    const key = entryKey(input.request.jobKey, input.request.generation);
    const existing = this.entries.get(key);
    if (existing) {
      const requestClass = CLASS_RANK[input.requestClass] < CLASS_RANK[existing.input.requestClass]
        ? input.requestClass
        : existing.input.requestClass;
      existing.input = Object.freeze({
        ...input,
        requestClass,
        visible: existing.input.visible || input.visible,
        root: Boolean(existing.input.root || input.root),
      });
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
    const candidates = [...this.entries.values()]
      .filter((entry) => (
        entry.requested
        && (entry.state === 'queued' || entry.state === 'failed')
        && entry.nextRetryAt <= now
      ))
      .sort((a, b) => this.compare(a, b, now));
    for (const entry of candidates) {
      if (submitted >= maximumSubmissions || this.executor.availableSlots() <= 0) break;
      const reserved = this.reservations.tryReserve(
        entryKey(entry.input.request.jobKey, entry.input.request.generation),
        entry.input.estimatedBytes,
        entry.input.requestClass,
      );
      if (!reserved) continue;
      entry.state = 'building';
      entry.reservedBytes = entry.input.estimatedBytes;
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
        reservationKey: key,
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
      reservedBytes: this.reservations.reservationBytes(),
      hardReservationBytes: this.reservations.hardReservationBytes,
    });
  }

  state(jobKey: string, generation: number): 'queued' | 'building' | 'completed' | 'failed' | null {
    return this.entries.get(entryKey(jobKey, generation))?.state ?? null;
  }

  private compare(a: Readonly<ScheduleEntry>, b: Readonly<ScheduleEntry>, now: number): number {
    const classDifference = CLASS_RANK[a.input.requestClass] - CLASS_RANK[b.input.requestClass];
    if (classDifference !== 0) return classDifference;
    if (Boolean(a.input.root) !== Boolean(b.input.root)) return a.input.root ? -1 : 1;
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
    this.reservations.releaseReservation(entryKey(
      entry.input.request.jobKey,
      entry.input.request.generation,
    ));
    entry.reservedBytes = 0;
  }
}
