import type { CoverageTransitionState } from './coverageTransition';

export type DiagnosticQualityTier = 'medium' | 'high';
export type RenderDiagnosticSubsystem = 'renderer' | 'assets' | 'transition' | 'terrain' | 'clouds';
export type RenderDiagnosticSeverity = 'sample' | 'state' | 'anomaly' | 'failure';
export type RenderDiagnosticValue = string | number | boolean | null;
export type RenderDiagnosticData = Readonly<Record<string, RenderDiagnosticValue>>;

export interface RenderDiagnosticContext {
  readonly simulationTime?: number | null;
  readonly bodyId?: string | null;
  readonly altitudeMeters?: number | null;
}

export interface RenderDiagnosticInput {
  readonly subsystem: RenderDiagnosticSubsystem;
  readonly event: string;
  readonly severity: RenderDiagnosticSeverity;
  readonly data?: RenderDiagnosticData;
}

export interface RenderDiagnosticEntry {
  readonly sequence: number;
  readonly wallTimeMs: number;
  readonly simulationTime: number | null;
  readonly bodyId: string | null;
  readonly altitudeMeters: number | null;
  readonly quality: DiagnosticQualityTier;
  readonly subsystem: RenderDiagnosticSubsystem;
  readonly event: string;
  readonly severity: RenderDiagnosticSeverity;
  readonly data: RenderDiagnosticData;
}

export interface RenderDiagnosticsSnapshot {
  readonly configuration: Readonly<{
    quality: DiagnosticQualityTier;
    detailed: boolean;
    capacity: number;
    sampleIntervalMs: number;
  }>;
  readonly entries: readonly RenderDiagnosticEntry[];
  readonly sequence: number;
  readonly overwrittenEntries: number;
  readonly recordingFailures: number;
  readonly anomalyCodes: readonly string[];
}

export interface RenderDiagnosticsBrowserApi {
  snapshot(): RenderDiagnosticsSnapshot;
  exportJson(): string;
  download(): void;
}

export interface RenderDiagnosticsPort {
  readonly detailed: boolean;
  record(input: Readonly<RenderDiagnosticInput>, context?: Readonly<RenderDiagnosticContext>): void;
  recordDetailed(input: Readonly<RenderDiagnosticInput>, context?: Readonly<RenderDiagnosticContext>): void;
  sample(key: string, input: Readonly<RenderDiagnosticInput>, context?: Readonly<RenderDiagnosticContext>): void;
  anomaly(
    code: string,
    subsystem: RenderDiagnosticSubsystem,
    data?: RenderDiagnosticData,
    context?: Readonly<RenderDiagnosticContext>,
  ): void;
}

export interface TransitionDiagnosticObservation extends RenderDiagnosticContext {
  readonly requestedPresentation: 'compact' | 'terrain';
  readonly state: CoverageTransitionState;
  readonly progress: number;
  readonly compactCoverage: number;
  readonly terrainCoverage: number;
  readonly coverageReady: boolean;
  readonly gapCount: number;
  readonly prewarm: boolean;
  readonly visibleBand: boolean;
  readonly framePressure: boolean;
  readonly compactVisible: boolean;
  readonly terrainVisible: boolean;
  readonly terrainVisibleChunks: number;
}

export interface TerrainDiagnosticEvent extends RenderDiagnosticContext {
  readonly event: string;
  readonly key?: string;
  readonly face?: number;
  readonly depth?: number;
  readonly generation?: number;
  readonly parentKey?: string | null;
  readonly data?: RenderDiagnosticData;
}

export interface TerrainDiagnosticSample extends RenderDiagnosticContext {
  readonly terrainRequested: boolean;
  readonly generation: number;
  readonly visible: number;
  readonly chunks: number;
  readonly triangles: number;
  readonly geometryBytes: number;
  readonly pending: number;
  readonly oldestPendingAgeMs: number;
  readonly coverageGaps: number;
  readonly coverageReady: boolean;
  readonly replacementRoots: number;
  readonly workers: number;
  readonly activeWorkers: number;
  readonly queuedWorkers: number;
  readonly scheduleMs: number;
  readonly installMs: number;
  readonly buildP99Ms: number;
  readonly visibleByDepth?: Readonly<Record<string, number>>;
}

export interface CloudShellDiagnosticObservation extends RenderDiagnosticContext {
  readonly shell: 'weather' | 'wisps';
  readonly classification: 'inside' | 'outside' | 'crossing';
  readonly radius: number;
  readonly shellAltitude: number;
  readonly signedDistance: number;
  readonly opacity: number;
  readonly baseOpacity: number;
  readonly side: 'front' | 'back' | 'double' | 'unknown';
  readonly materialVersion: number;
  readonly textureIdentity: string;
  readonly visible: boolean;
  readonly renderOrder: number;
  readonly driftAngle: number;
}

export interface RenderDiagnosticsOptions {
  readonly quality: DiagnosticQualityTier;
  readonly detailed: boolean;
  readonly capacity?: number;
  readonly sampleIntervalMs?: number;
  readonly now?: () => number;
  readonly warn?: (message: string, data?: RenderDiagnosticData) => void;
  readonly document?: Pick<Document, 'createElement'>;
  readonly url?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
}

const DEFAULT_CAPACITY = 4_096;
const DEFAULT_SAMPLE_INTERVAL_MS = 100;
const COVERAGE_TOLERANCE = 1e-6;
const MAX_TEXT_LENGTH = 500;

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundedText(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : String(value);
  } catch {
    text = '[unprintable]';
  }
  return text.length <= MAX_TEXT_LENGTH ? text : `${text.slice(0, MAX_TEXT_LENGTH)}…`;
}

function normalizeData(source: RenderDiagnosticData | undefined): Readonly<Record<string, RenderDiagnosticValue>> {
  if (source === undefined) return Object.freeze({});
  const result: Record<string, RenderDiagnosticValue> = {};
  for (const key of Object.keys(source)) {
    const value: unknown = (source as Record<string, unknown>)[key];
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      result[key] = typeof value === 'string' ? boundedText(value) : value;
    } else if (typeof value === 'number') {
      result[key] = Number.isFinite(value) ? value : boundedText(value);
    } else {
      result[key] = boundedText(value);
    }
  }
  return Object.freeze(result);
}

function cloneEntry(entry: RenderDiagnosticEntry): RenderDiagnosticEntry {
  return Object.freeze({ ...entry, data: Object.freeze({ ...entry.data }) });
}

export function normalizeDiagnosticError(cause: unknown): Readonly<{ name: string; message: string }> {
  try {
    if (cause instanceof Error) {
      return Object.freeze({ name: boundedText(cause.name || 'Error'), message: boundedText(cause.message) });
    }
    return Object.freeze({ name: typeof cause, message: boundedText(cause) });
  } catch {
    return Object.freeze({ name: 'unknown', message: '[error normalization failed]' });
  }
}

export class RenderDiagnostics implements RenderDiagnosticsPort {
  readonly detailed: boolean;
  readonly quality: DiagnosticQualityTier;
  private readonly capacity: number;
  private readonly sampleIntervalMs: number;
  private readonly now: () => number;
  private readonly warn: (message: string, data?: RenderDiagnosticData) => void;
  private readonly documentRef: Pick<Document, 'createElement'> | undefined;
  private readonly urlRef: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> | undefined;
  private readonly entries: RenderDiagnosticEntry[] = [];
  private writeIndex = 0;
  private nextSequence = 1;
  private overwritten = 0;
  private failures = 0;
  private readonly lastSampleByKey = new Map<string, number>();
  private readonly anomalyCodeSet = new Set<string>();
  private transitionState: TransitionDiagnosticObservation | null = null;
  private terrainState: TerrainDiagnosticSample | null = null;
  private readonly installedTerrainKeys = new Map<string, number>();
  private readonly pendingTerrainKeys = new Map<string, Readonly<{ generation: number; startedMs: number }>>();
  private readonly cloudState = new Map<string, CloudShellDiagnosticObservation>();
  private boundaryGeneration = 0;

  constructor(options: Readonly<RenderDiagnosticsOptions>) {
    this.quality = options.quality;
    this.detailed = options.detailed;
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) throw new RangeError('Diagnostics capacity must be positive');
    if (!Number.isFinite(this.sampleIntervalMs) || this.sampleIntervalMs < 0) throw new RangeError('Sample interval must be non-negative');
    this.now = options.now ?? (() => performance.now());
    this.warn = options.warn ?? ((message, data) => console.warn(message, data ?? {}));
    this.documentRef = options.document ?? globalThis.document;
    this.urlRef = options.url ?? globalThis.URL;
  }

  record(input: Readonly<RenderDiagnosticInput>, context: Readonly<RenderDiagnosticContext> = {}): void {
    try {
      const wallTimeMs = finiteOrNull(this.now());
      if (wallTimeMs === null) throw new TypeError('Diagnostic clock returned a non-finite value');
      const entry: RenderDiagnosticEntry = Object.freeze({
        sequence: this.nextSequence++,
        wallTimeMs,
        simulationTime: finiteOrNull(context.simulationTime),
        bodyId: context.bodyId == null ? null : boundedText(context.bodyId),
        altitudeMeters: finiteOrNull(context.altitudeMeters),
        quality: this.quality,
        subsystem: input.subsystem,
        event: boundedText(input.event),
        severity: input.severity,
        data: normalizeData(input.data),
      });
      if (this.entries.length < this.capacity) {
        this.entries.push(entry);
      } else {
        this.entries[this.writeIndex] = entry;
        this.writeIndex = (this.writeIndex + 1) % this.capacity;
        this.overwritten++;
      }
    } catch {
      this.failures++;
    }
  }

  recordDetailed(input: Readonly<RenderDiagnosticInput>, context?: Readonly<RenderDiagnosticContext>): void {
    if (this.detailed) this.record(input, context);
  }

  sample(key: string, input: Readonly<RenderDiagnosticInput>, context?: Readonly<RenderDiagnosticContext>): void {
    if (!this.detailed) return;
    try {
      const current = this.now();
      if (!Number.isFinite(current)) throw new TypeError('Diagnostic clock returned a non-finite value');
      const sampleKey = boundedText(key);
      const last = this.lastSampleByKey.get(sampleKey);
      if (last !== undefined && current - last < this.sampleIntervalMs) return;
      this.lastSampleByKey.set(sampleKey, current);
      this.record(input, context);
    } catch {
      this.failures++;
    }
  }

  anomaly(
    code: string,
    subsystem: RenderDiagnosticSubsystem,
    data: RenderDiagnosticData = {},
    context: Readonly<RenderDiagnosticContext> = {},
  ): void {
    try {
      const normalizedCode = boundedText(code);
      this.record({ subsystem, event: normalizedCode, severity: 'anomaly', data: { code: normalizedCode, ...data } }, context);
      if (this.anomalyCodeSet.has(normalizedCode)) return;
      this.anomalyCodeSet.add(normalizedCode);
      try {
        this.warn(`[render diagnostics] ${normalizedCode}`, normalizeData(data));
      } catch {
        this.failures++;
      }
    } catch {
      this.failures++;
    }
  }

  observeTransition(observation: Readonly<TransitionDiagnosticObservation>): void {
    try {
      const previous = this.transitionState;
      const context = this.contextFrom(observation);
      const data: RenderDiagnosticData = {
        requestedPresentation: observation.requestedPresentation,
        state: observation.state,
        progress: observation.progress,
        compactCoverage: observation.compactCoverage,
        terrainCoverage: observation.terrainCoverage,
        coverageReady: observation.coverageReady,
        gapCount: observation.gapCount,
        prewarm: observation.prewarm,
        visibleBand: observation.visibleBand,
        framePressure: observation.framePressure,
        compactVisible: observation.compactVisible,
        terrainVisible: observation.terrainVisible,
        terrainVisibleChunks: observation.terrainVisibleChunks,
      };
      if (!previous || previous.state !== observation.state || previous.requestedPresentation !== observation.requestedPresentation) {
        this.record({ subsystem: 'transition', event: 'presentation-state', severity: 'state', data }, context);
      }
      this.sample(`transition:${observation.bodyId ?? 'unknown'}`, {
        subsystem: 'transition', event: 'presentation-sample', severity: 'sample', data,
      }, context);
      if (previous && previous.requestedPresentation === 'terrain' && observation.requestedPresentation === 'terrain') {
        if (observation.progress + COVERAGE_TOLERANCE < previous.progress) {
          this.anomaly('transition-progress-regressed', 'transition', data, context);
        }
        if ((previous.state === 'fading' || previous.state === 'terrain') && observation.state === 'prewarming') {
          this.anomaly('transition-rollback-without-request-change', 'transition', data, context);
        }
        if (previous.coverageReady && !observation.coverageReady) {
          this.anomaly('transition-coverage-readiness-lost', 'transition', data, context);
        }
      }
      if (observation.compactCoverage + observation.terrainCoverage < 1 - COVERAGE_TOLERANCE) {
        this.anomaly('transition-combined-coverage-gap', 'transition', data, context);
      }
      if (!observation.compactVisible && (!observation.terrainVisible || observation.terrainVisibleChunks === 0)) {
        this.anomaly('transition-zero-visible-coverage', 'transition', data, context);
      }
      this.transitionState = Object.freeze({ ...observation });
    } catch {
      this.failures++;
    }
  }

  observeTerrainEvent(observation: Readonly<TerrainDiagnosticEvent>): void {
    try {
      const context = this.contextFrom(observation);
      const data: RenderDiagnosticData = {
        key: observation.key ?? null,
        face: observation.face ?? null,
        depth: observation.depth ?? null,
        generation: observation.generation ?? null,
        parentKey: observation.parentKey ?? null,
        ...(observation.data ?? {}),
      };
      if (observation.event === 'request' && observation.key && observation.generation !== undefined) {
        if (this.installedTerrainKeys.get(observation.key) === observation.generation) {
          this.anomaly('terrain-repeat-request-after-install', 'terrain', data, context);
        }
        this.pendingTerrainKeys.set(observation.key, Object.freeze({ generation: observation.generation, startedMs: this.now() }));
      }
      if (observation.event === 'installed' && observation.key && observation.generation !== undefined) {
        this.pendingTerrainKeys.delete(observation.key);
        this.installedTerrainKeys.set(observation.key, observation.generation);
      }
      if ((observation.event === 'cancelled' || observation.event === 'failed' || observation.event === 'stale-completion') && observation.key) {
        this.pendingTerrainKeys.delete(observation.key);
      }
      this.recordDetailed({ subsystem: 'terrain', event: `chunk-${observation.event}`, severity: 'state', data }, context);
    } catch {
      this.failures++;
    }
  }

  observeTerrainSample(observation: Readonly<TerrainDiagnosticSample>): void {
    try {
      const previous = this.terrainState;
      const context = this.contextFrom(observation);
      const depths: Record<string, number> = {};
      for (const [key, value] of Object.entries(observation.visibleByDepth ?? {})) depths[`visibleDepth${key}`] = value;
      const data: RenderDiagnosticData = {
        generation: observation.generation,
        terrainRequested: observation.terrainRequested,
        visible: observation.visible,
        chunks: observation.chunks,
        triangles: observation.triangles,
        geometryBytes: observation.geometryBytes,
        pending: observation.pending,
        oldestPendingAgeMs: observation.oldestPendingAgeMs,
        coverageGaps: observation.coverageGaps,
        coverageReady: observation.coverageReady,
        replacementRoots: observation.replacementRoots,
        workers: observation.workers,
        activeWorkers: observation.activeWorkers,
        queuedWorkers: observation.queuedWorkers,
        scheduleMs: observation.scheduleMs,
        installMs: observation.installMs,
        buildP99Ms: observation.buildP99Ms,
        ...depths,
      };
      this.sample(`terrain:${observation.bodyId ?? 'unknown'}`, {
        subsystem: 'terrain', event: 'terrain-sample', severity: 'sample', data,
      }, context);
      if (observation.oldestPendingAgeMs > 2_000) {
        this.anomaly('terrain-job-pending-over-two-seconds', 'terrain', data, context);
      }
      if (previous && previous.generation === observation.generation && previous.terrainRequested && observation.terrainRequested) {
        if (previous.coverageReady && !observation.coverageReady) {
          this.anomaly('terrain-coverage-readiness-lost', 'terrain', data, context);
        }
        if (this.factorOfTwoChange(previous.visible, observation.visible) || this.factorOfTwoChange(previous.geometryBytes, observation.geometryBytes)) {
          this.anomaly('terrain-factor-of-two-sample-delta', 'terrain', data, context);
        }
      }
      this.terrainState = Object.freeze({ ...observation, visibleByDepth: Object.freeze({ ...(observation.visibleByDepth ?? {}) }) });
    } catch {
      this.failures++;
    }
  }

  observeCloudShell(observation: Readonly<CloudShellDiagnosticObservation>): void {
    try {
      const key = `${observation.bodyId ?? 'unknown'}:${observation.shell}`;
      const previous = this.cloudState.get(key);
      const context = this.contextFrom(observation);
      const data: RenderDiagnosticData = {
        shell: observation.shell,
        classification: observation.classification,
        radius: observation.radius,
        shellAltitude: observation.shellAltitude,
        signedDistance: observation.signedDistance,
        opacity: observation.opacity,
        baseOpacity: observation.baseOpacity,
        side: observation.side,
        materialVersion: observation.materialVersion,
        textureIdentity: observation.textureIdentity,
        visible: observation.visible,
        renderOrder: observation.renderOrder,
        driftAngle: observation.driftAngle,
      };
      if (!previous || previous.side !== observation.side || previous.classification !== observation.classification) {
        this.record({ subsystem: 'clouds', event: 'cloud-shell-state', severity: 'state', data }, context);
      }
      this.sample(`cloud:${key}`, { subsystem: 'clouds', event: 'cloud-shell-sample', severity: 'sample', data }, context);
      if (!Number.isFinite(observation.opacity) || observation.opacity < 0 || observation.opacity > observation.baseOpacity + COVERAGE_TOLERANCE) {
        this.anomaly('cloud-opacity-out-of-range', 'clouds', data, context);
      }
      if (previous) {
        if (previous.side !== observation.side && previous.classification !== 'crossing' && observation.classification !== 'crossing') {
          this.anomaly('cloud-side-oscillation-away-from-crossing', 'clouds', data, context);
        }
        if (observation.materialVersion > previous.materialVersion && previous.classification !== 'crossing' && observation.classification !== 'crossing') {
          this.anomaly('cloud-material-version-change-away-from-crossing', 'clouds', data, context);
        }
        if (observation.textureIdentity !== previous.textureIdentity) {
          this.anomaly('cloud-texture-changed-without-boundary', 'clouds', data, context);
        }
      }
      this.cloudState.set(key, Object.freeze({ ...observation }));
    } catch {
      this.failures++;
    }
  }

  noteRendererBoundary(data: RenderDiagnosticData = {}, context: Readonly<RenderDiagnosticContext> = {}): void {
    try {
      this.boundaryGeneration++;
      this.transitionState = null;
      this.terrainState = null;
      this.installedTerrainKeys.clear();
      this.pendingTerrainKeys.clear();
      this.cloudState.clear();
      this.record({ subsystem: 'renderer', event: 'renderer-boundary', severity: 'state', data: {
        boundaryGeneration: this.boundaryGeneration,
        ...data,
      } }, context);
    } catch {
      this.failures++;
    }
  }

  snapshot(): RenderDiagnosticsSnapshot {
    try {
      const chronological = this.entries.length < this.capacity || this.writeIndex === 0
        ? this.entries
        : [...this.entries.slice(this.writeIndex), ...this.entries.slice(0, this.writeIndex)];
      const entries = Object.freeze(chronological.map(cloneEntry));
      return Object.freeze({
        configuration: Object.freeze({
          quality: this.quality,
          detailed: this.detailed,
          capacity: this.capacity,
          sampleIntervalMs: this.sampleIntervalMs,
        }),
        entries,
        sequence: this.nextSequence - 1,
        overwrittenEntries: this.overwritten,
        recordingFailures: this.failures,
        anomalyCodes: Object.freeze([...this.anomalyCodeSet]),
      });
    } catch {
      this.failures++;
      return Object.freeze({
        configuration: Object.freeze({ quality: this.quality, detailed: this.detailed, capacity: this.capacity, sampleIntervalMs: this.sampleIntervalMs }),
        entries: Object.freeze([]),
        sequence: this.nextSequence - 1,
        overwrittenEntries: this.overwritten,
        recordingFailures: this.failures,
        anomalyCodes: Object.freeze([]),
      });
    }
  }

  exportJson(): string {
    try {
      return JSON.stringify(this.snapshot(), null, 2);
    } catch {
      this.failures++;
      return JSON.stringify({ error: 'render diagnostics export failed', recordingFailures: this.failures });
    }
  }

  download(): void {
    let objectUrl: string | null = null;
    try {
      if (!this.documentRef || !this.urlRef) throw new Error('Download is unavailable');
      const blob = new Blob([this.exportJson()], { type: 'application/json' });
      objectUrl = this.urlRef.createObjectURL(blob);
      const anchor = this.documentRef.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `perilune-render-diagnostics-${this.quality}.json`;
      anchor.click();
    } catch {
      this.failures++;
    } finally {
      if (objectUrl && this.urlRef) {
        try {
          this.urlRef.revokeObjectURL(objectUrl);
        } catch {
          this.failures++;
        }
      }
    }
  }

  browserApi(): RenderDiagnosticsBrowserApi {
    return Object.freeze({
      snapshot: () => this.snapshot(),
      exportJson: () => this.exportJson(),
      download: () => this.download(),
    });
  }

  private contextFrom(source: Readonly<RenderDiagnosticContext>): RenderDiagnosticContext {
    return {
      simulationTime: source.simulationTime,
      bodyId: source.bodyId,
      altitudeMeters: source.altitudeMeters,
    };
  }

  private factorOfTwoChange(previous: number, current: number): boolean {
    if (previous === current) return false;
    if (previous <= 0 || current <= 0) return previous > 0 || current > 0;
    return current > previous * 2 || previous > current * 2;
  }
}

declare global {
  interface Window {
    __RENDER_DIAGNOSTICS__?: RenderDiagnosticsBrowserApi;
  }
}
