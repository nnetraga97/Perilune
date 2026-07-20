import * as THREE from 'three';
import type { QuaternionCoordinates, VectorCoordinates } from '../bodyRenderer';
import { geometryByteLength } from '../resourceAccounting';
import type { RenderDiagnosticContext, RenderDiagnosticsPort } from '../renderDiagnostics';
import { resolveTerrainCoverage, type TerrainTileRecord } from './coverageResolver';
import { type TerrainChunkGeometryRequest, type TerrainChunkGeometryResult } from './chunkGeometry';
import type { TerrainChunkWorkerPool } from './chunkWorkerPool';
import { installTerrainLodDither, type TerrainLodDitherBinding } from './lodDither';
import { TerrainLodTransitionManager } from './lodTransition';
import { type TerrainQualityPolicy } from './terrainPolicy';
import { TerrainResidencyManager } from './terrainResidency';
import {
  TerrainRequestScheduler,
  type TerrainRequestClass,
  type TerrainSchedulerExecutor,
} from './terrainScheduler';
import {
  balanceTerrainLeaves,
  selectPredictedTerrainDetail,
  selectTerrainDetail,
  terrainTileBoundingSphere,
  terrainNeighborDepthViolations,
  type TerrainSelectionFrame,
  type TerrainSelectionResult,
  type TerrainVisibilityPredicate,
} from './terrainSelection';
import { screenSpaceErrorPixels } from './terrainPolicy';
import type { PlanetSurfaceProvider, TerrainTileDescriptor } from './surfaceProvider';
import { terrainTileParent } from './tile';
import type { TerrainTileId } from './tile';

export interface PlanetTerrainFrame extends TerrainSelectionFrame {
  readonly cameraRelativeOrigin: VectorCoordinates;
  readonly orientation: QuaternionCoordinates;
  readonly deltaSeconds: number;
  readonly framePressure: boolean;
  readonly generation: number;
  readonly visible?: TerrainVisibilityPredicate;
  readonly visibilitySignature?: string;
  readonly diagnosticContext?: RenderDiagnosticContext & { readonly terrainRequested: boolean };
}

export interface PlanetTerrainEngineOptions {
  readonly provider: PlanetSurfaceProvider;
  readonly quality: TerrainQualityPolicy;
  readonly material: THREE.Material;
  readonly terrainAllocationBytes: number;
  readonly workerPool?: TerrainChunkWorkerPool;
  readonly ownsWorkerPool?: boolean;
  readonly now?: () => number;
  readonly diagnostics?: RenderDiagnosticsPort;
  readonly diagnosticSource?: string;
}

export interface PlanetTerrainEngineStats {
  readonly frame: number;
  readonly chunks: number;
  readonly visible: number;
  readonly triangles: number;
  readonly coverageGaps: number;
  readonly rootsReady: boolean;
  readonly coverageReady: boolean;
  readonly scheduleMs: number;
  readonly installMs: number;
  readonly selectionMs: number;
  readonly balanceMs: number;
  readonly selectionPasses: number;
  readonly selectionReused: boolean;
  readonly selectionInvalidation: string | null;
  readonly geometryBytes: number;
  readonly reservedBytes: number;
  readonly queued: number;
  readonly building: number;
  readonly ready: number;
  readonly failed: number;
  readonly allocationBytes: number;
  readonly protectedBytes: number;
  readonly desiredLeaves: number;
  readonly renderedLeaves: number;
  readonly fallbackTiles: number;
  readonly balanceViolations: number;
  readonly activeTransitions: number;
}

interface InstalledChunk {
  readonly tile: TerrainTileDescriptor;
  readonly mesh: THREE.Mesh;
  readonly origin: readonly [number, number, number];
}

interface CachedTerrainSelection {
  readonly cameraBodyFixed: VectorCoordinates;
  readonly cameraBodyFixedVelocity: VectorCoordinates;
  readonly viewDirectionBodyFixed?: VectorCoordinates;
  readonly viewMarginRadians?: number;
  readonly verticalFovRadians: number;
  readonly drawingBufferHeight: number;
  readonly visibilitySignature?: string;
  readonly selectionQuality: TerrainQualityPolicy;
  readonly selected: TerrainSelectionResult;
  readonly balanced: readonly TerrainTileDescriptor[];
  readonly predicted: TerrainSelectionResult;
  readonly balanceViolations: readonly string[];
  readonly selectionMs: number;
  readonly balanceMs: number;
  readonly selectionPasses: number;
}

function copyVector(value: Readonly<VectorCoordinates>): VectorCoordinates {
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function vectorDistanceSquared(a: Readonly<VectorCoordinates>, b: Readonly<VectorCoordinates>): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function directionChanged(
  previous: Readonly<VectorCoordinates> | undefined,
  next: Readonly<VectorCoordinates> | undefined,
): boolean {
  if (!previous || !next) return previous !== next;
  const previousLength = Math.hypot(previous.x, previous.y, previous.z);
  const nextLength = Math.hypot(next.x, next.y, next.z);
  if (previousLength < 1e-9 || nextLength < 1e-9) return previousLength !== nextLength;
  const cosine = (
    previous.x * next.x + previous.y * next.y + previous.z * next.z
  ) / (previousLength * nextLength);
  return cosine < Math.cos(THREE.MathUtils.degToRad(0.25));
}

class InlineTerrainExecutor implements TerrainSchedulerExecutor {
  private completed: TerrainChunkGeometryResult[] = [];
  private active = 0;

  constructor(private readonly provider: PlanetSurfaceProvider) {}
  availableSlots(): number { return this.active === 0 ? 1 : 0; }
  submit(request: TerrainChunkGeometryRequest): Promise<TerrainChunkGeometryResult> {
    this.active++;
    try {
      const result = this.provider.build(request);
      this.completed.push(result);
      return Promise.resolve(result);
    } finally {
      this.active--;
    }
  }
  cancelQueued(): boolean { return false; }
  cancelGeneration(generation: number): void {
    this.completed = this.completed.filter((result) => result.generation !== generation);
  }
  drainCompleted(): TerrainChunkGeometryResult[] {
    const result = this.completed;
    this.completed = [];
    return result;
  }
  timings() { return { workers: 1, pending: 0, active: this.active, buildP99Ms: 0 }; }
}

function estimatedGeometryBytes(resolution: number): number {
  const vertices = resolution * resolution + resolution * 4;
  const triangles = (resolution - 1) ** 2 * 2 + (resolution - 1) * 4 * 2;
  return vertices * 64 + triangles * 3 * 4;
}

function skirtDepth(provider: PlanetSurfaceProvider, tile: TerrainTileDescriptor, resolution: number): number {
  const worldSize = provider.radiusMeters * Math.PI / 2 ** (tile.id.depth + 1);
  return Math.min(20, Math.max(2, (worldSize / Math.max(1, resolution - 1)) * 0.08));
}

function surfaceAltitudes(result: TerrainChunkGeometryResult, radius: number): Float32Array {
  const count = result.bodyDirection.length / 3;
  const altitude = new Float32Array(count);
  const [ox, oy, oz] = result.origin;
  for (let index = 0; index < count; index++) {
    const offset = index * 3;
    const px = result.position[offset] + ox;
    const py = result.position[offset + 1] + oy;
    const pz = result.position[offset + 2] + oz;
    altitude[index] = px * result.bodyDirection[offset]
      + py * result.bodyDirection[offset + 1]
      + pz * result.bodyDirection[offset + 2]
      - radius;
  }
  return altitude;
}

export class PlanetTerrainEngine {
  readonly group = new THREE.Group();
  readonly provider: PlanetSurfaceProvider;
  private readonly quality: TerrainQualityPolicy;
  private readonly material: THREE.Material;
  private readonly records = new Map<string, TerrainTileRecord>();
  private readonly chunks = new Map<string, InstalledChunk>();
  private readonly residency: TerrainResidencyManager;
  private readonly scheduler: TerrainRequestScheduler;
  private readonly transitions: TerrainLodTransitionManager;
  private readonly dither: TerrainLodDitherBinding;
  private readonly workerPool?: TerrainChunkWorkerPool;
  private readonly ownsWorkerPool: boolean;
  private readonly now: () => number;
  private readonly diagnostics?: RenderDiagnosticsPort;
  private readonly diagnosticSource: string;
  private installationQueue: ReturnType<TerrainRequestScheduler['drainCompleted']> = [];
  private previousSplitKeys = new Set<string>();
  private previousRenderedKeys = new Set<string>();
  private readonly requestedAt = new Map<string, number>();
  private readonly lastRequestedFrame = new Map<string, number>();
  private requestOrder: string[] = [];
  private requestCursor = 0;
  private newRequestsThisFrame = 0;
  private previousTransitionStates = new Map<string, string>();
  private diagnosticContext: Readonly<RenderDiagnosticContext & { terrainRequested?: boolean }> = {};
  private diagnosticLifecycleBatch: string[] = [];
  private frame = 0;
  private disposed = false;
  private shadowReceiver = false;
  private pendingSince: number | null = null;
  private lastCompletionAt: number | null = null;
  private stallReported = false;
  private cachedSelection: CachedTerrainSelection | null = null;
  stats: PlanetTerrainEngineStats = Object.freeze({
    frame: 0, chunks: 0, visible: 0, triangles: 0, coverageGaps: 0,
    rootsReady: false, coverageReady: false, scheduleMs: 0, installMs: 0,
    selectionMs: 0, balanceMs: 0, selectionPasses: 0, selectionReused: false,
    selectionInvalidation: 'cold',
    geometryBytes: 0, reservedBytes: 0,
    queued: 0, building: 0, ready: 0, failed: 0,
    allocationBytes: 0, protectedBytes: 0, desiredLeaves: 0, renderedLeaves: 0,
    fallbackTiles: 0, balanceViolations: 0, activeTransitions: 0,
  });

  constructor(options: Readonly<PlanetTerrainEngineOptions>) {
    this.provider = options.provider;
    this.quality = options.quality;
    this.material = options.material;
    this.workerPool = options.workerPool;
    this.ownsWorkerPool = options.ownsWorkerPool ?? true;
    this.now = options.now ?? (() => performance.now());
    this.diagnostics = options.diagnostics;
    this.diagnosticSource = options.diagnosticSource ?? `terrain:${options.provider.bodyId}`;
    this.residency = new TerrainResidencyManager(options.terrainAllocationBytes, options.quality.softResidencyRatio);
    this.transitions = new TerrainLodTransitionManager(
      options.quality.normalTransitionSeconds,
      options.quality.pressureTransitionSeconds,
    );
    const executor = options.workerPool ?? new InlineTerrainExecutor(options.provider);
    this.scheduler = new TerrainRequestScheduler(executor, this.residency);
    this.dither = installTerrainLodDither(this.material);
  }

  update(frame: Readonly<PlanetTerrainFrame>): void {
    if (this.disposed) return;
    if (frame.generation !== this.provider.generation) return;
    this.diagnosticContext = frame.diagnosticContext ?? {};
    this.diagnosticLifecycleBatch = [];
    this.frame++;
    this.workerPool?.checkHealth(this.now());
    const installStarted = this.now();
    const completed = this.scheduler.drainCompleted();
    if (completed.length > 0) {
      this.lastCompletionAt = installStarted;
      this.pendingSince = null;
      this.stallReported = false;
    }
    for (const completion of completed) {
      const record = this.records.get(completion.result.jobKey);
      if (record && record.generation === completion.result.generation) {
        this.records.set(record.tile.key, { ...record, state: 'ready' });
        this.terrainEvent('ready', record.tile, { requestClass: completion.requestClass });
      }
    }
    this.installationQueue.push(...completed);
    while (this.installationQueue.length > 0) {
      if (this.now() - installStarted > this.quality.installationBudgetMs) break;
      const completion = this.installationQueue.shift()!;
      try {
        this.install(completion.result, completion.reservationKey, completion.requestClass);
      } catch (cause) {
        const record = this.records.get(completion.result.jobKey);
        if (record && record.generation === completion.result.generation) {
          this.records.set(record.tile.key, { ...record, state: 'failed', gpuValid: false });
          this.terrainEvent('failed', record.tile, {
            phase: 'install',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      } finally {
        this.scheduler.releaseCompleted(completion.result.jobKey, completion.result.generation);
      }
    }
    const installMs = Math.max(0, this.now() - installStarted);

    let selection = this.cachedSelection;
    const selectionInvalidation = selection === null
      ? 'cold'
      : this.selectionInvalidationReason(selection, frame);
    const selectionReused = selectionInvalidation === null;
    if (!selectionReused) {
      selection = this.computeSelection(frame);
      this.cachedSelection = selection;
    } else if (selection && vectorDistanceSquared(
      selection.cameraBodyFixedVelocity, frame.cameraBodyFixedVelocity,
    ) > 1) {
      const speedSquared = frame.cameraBodyFixedVelocity.x ** 2
        + frame.cameraBodyFixedVelocity.y ** 2
        + frame.cameraBodyFixedVelocity.z ** 2;
      selection = Object.freeze({
        ...selection,
        cameraBodyFixedVelocity: copyVector(frame.cameraBodyFixedVelocity),
        predicted: speedSquared < 0.25
          ? selection.selected
          : selectPredictedTerrainDetail(
              this.provider,
              selection.selectionQuality,
              frame,
              this.previousSplitKeys,
              frame.visible,
            ),
      });
      this.cachedSelection = selection;
    }
    if (!selection) throw new Error('Terrain selection cache was not initialized');
    const activeSelection = selection;
    const { selectionQuality, selected, balanced, predicted, balanceViolations } = activeSelection;
    if (balanceViolations.length > 0) {
      this.diagnostics?.anomaly('terrain-neighbor-depth-violation', 'terrain', {
        count: balanceViolations.length,
        first: balanceViolations[0],
      }, this.diagnosticContext);
    }
    const previousRenderedForFrame = this.previousRenderedKeys;
    const coverage = resolveTerrainCoverage({
      provider: this.provider,
      desiredLeaves: balanced,
      records: this.records,
      previousRenderedKeys: this.previousRenderedKeys,
      generation: frame.generation,
      materialGeneration: this.provider.generation,
    });

    const stableRenderedKeys = this.serializeTransitionTarget(
      coverage.renderedKeys,
      this.transitions.snapshots(),
    );
    this.requestTransitions(stableRenderedKeys);
    const transitionSnapshots = this.transitions.advance(
      frame.deltaSeconds, frame.framePressure, this.frame,
    );
    const incompleteTransitions = this.observeTransitions(transitionSnapshots);
    const immediateReplacements = this.countImmediateReplacements(
      this.previousRenderedKeys,
      stableRenderedKeys,
      transitionSnapshots,
    );
    if (immediateReplacements > 0) {
      this.diagnostics?.anomaly('terrain-immediate-replacement', 'terrain', {
        count: immediateReplacements,
      }, this.diagnosticContext);
    }
    const renderKeys = new Set(stableRenderedKeys);
    for (const transition of transitionSnapshots) {
      renderKeys.add(transition.parentKey);
      for (const child of transition.childKeys) renderKeys.add(child);
    }

    const scheduleStarted = this.now();
    const queueBudgetMs = this.quality.schedulingBudgetMs * 0.6;
    this.newRequestsThisFrame = 0;
    for (const request of coverage.requests) {
      if (request.tile.id.depth === 0) this.queue(request.tile, request.requestClass, frame);
    }
    for (const request of coverage.requests) {
      if (request.tile.id.depth === 0) continue;
      if (this.now() - scheduleStarted >= queueBudgetMs) break;
      this.queue(request.tile, request.requestClass, frame);
    }
    for (const tile of balanced) {
      if (this.now() - scheduleStarted >= queueBudgetMs) break;
      this.queue(tile, 'visible-refinement', frame, selected.screenSpaceErrors.get(tile.key));
    }
    for (const tile of predicted.leaves) {
      if (this.now() - scheduleStarted >= queueBudgetMs) break;
      this.queue(tile, 'predicted-refinement', frame, predicted.screenSpaceErrors.get(tile.key));
    }
    this.cancelObsoleteRequests(64);
    this.scheduler.dispatch(this.now(), this.quality.submissionsPerFrame);
    this.synchronizeSchedulerStates();
    const scheduleMs = Math.max(0, this.now() - scheduleStarted);

    this.applyRenderState(renderKeys, transitionSnapshots, frame);
    const protection = new Set([
      ...coverage.protectionKeys,
      ...stableRenderedKeys,
      ...this.transitions.protectionKeys(),
      ...predicted.leaves.map((tile) => tile.key),
    ]);
    this.residency.beginFrame(this.frame, protection);
    if (coverage.rootsReady) {
      for (let face = 0; face < 6; face++) this.residency.protectPermanently(this.provider.rootTile(face as 0 | 1 | 2 | 3 | 4 | 5).key);
    }
    for (const key of protection) this.residency.markUsed(key);
    let protectedEvictions = 0;
    for (const key of this.residency.trimToSoftTarget()) {
      if (protection.has(key)) protectedEvictions++;
      this.disposeChunk(key, false, 'soft-target');
    }
    if (protectedEvictions > 0) {
      this.diagnostics?.anomaly('terrain-protected-eviction', 'terrain', {
        count: protectedEvictions,
      }, this.diagnosticContext);
    }

    this.previousSplitKeys = new Set(selected.splitKeys);
    this.previousRenderedKeys = new Set(stableRenderedKeys);
    const residency = this.residency.stats();
    const scheduler = this.scheduler.stats();
    const pendingWork = scheduler.queued + scheduler.building;
    if (pendingWork > 0) {
      this.pendingSince ??= this.now();
      const progressAt = this.lastCompletionAt ?? this.pendingSince;
      if (!this.stallReported && this.now() - progressAt > 5_000) {
        this.stallReported = true;
        this.diagnostics?.anomaly('terrain-worker-no-progress', 'terrain', {
          pending: pendingWork,
          queued: scheduler.queued,
          building: scheduler.building,
          stalledMs: this.now() - progressAt,
        }, this.diagnosticContext);
      }
    } else {
      this.pendingSince = null;
      this.stallReported = false;
    }
    let triangles = 0;
    for (const key of renderKeys) {
      const index = this.chunks.get(key)?.mesh.geometry.getIndex();
      triangles += index ? index.count / 3 : 0;
    }
    this.stats = Object.freeze({
      frame: this.frame,
      chunks: this.chunks.size,
      visible: [...renderKeys].filter((key) => this.chunks.get(key)?.mesh.visible).length,
      triangles,
      coverageGaps: coverage.completeCoverage ? 0 : 1,
      rootsReady: coverage.rootsReady,
      coverageReady: coverage.completeCoverage,
      scheduleMs,
      installMs,
      selectionMs: selectionReused ? 0 : activeSelection.selectionMs,
      balanceMs: selectionReused ? 0 : activeSelection.balanceMs,
      selectionPasses: selectionReused ? 0 : activeSelection.selectionPasses,
      selectionReused,
      selectionInvalidation,
      geometryBytes: residency.installedBytes,
      reservedBytes: residency.reservedBytes,
      queued: scheduler.queued,
      building: scheduler.building,
      ready: this.installationQueue.length,
      failed: scheduler.failed,
      allocationBytes: residency.allocationBytes,
      protectedBytes: residency.protectedBytes,
      desiredLeaves: balanced.length,
      renderedLeaves: stableRenderedKeys.size,
      fallbackTiles: coverage.fallbackKeys.size,
      balanceViolations: balanceViolations.length,
      activeTransitions: transitionSnapshots.length,
    });
    this.observeFrame(
      coverage,
      balanced,
      renderKeys,
      previousRenderedForFrame,
      transitionSnapshots.length,
      incompleteTransitions,
      protectedEvictions,
      immediateReplacements,
    );
    this.flushDiagnosticLifecycleBatch();
  }

  private selectionInvalidationReason(
    cached: Readonly<CachedTerrainSelection>,
    frame: Readonly<PlanetTerrainFrame>,
  ): string | null {
    if (vectorDistanceSquared(cached.cameraBodyFixed, frame.cameraBodyFixed) > 1) return 'translation';
    if (directionChanged(cached.viewDirectionBodyFixed, frame.viewDirectionBodyFixed)) return 'direction';
    if (Math.abs((cached.viewMarginRadians ?? 0) - (frame.viewMarginRadians ?? 0)) >= 1e-6) return 'margin';
    if (Math.abs(cached.verticalFovRadians - frame.verticalFovRadians) >= 1e-6) return 'fov';
    if (cached.drawingBufferHeight !== frame.drawingBufferHeight) return 'buffer';
    if (cached.visibilitySignature !== frame.visibilitySignature) return 'frustum';
    return null;
  }

  private computeSelection(frame: Readonly<PlanetTerrainFrame>): CachedTerrainSelection {
    let selectionMs = 0;
    let balanceMs = 0;
    let selectionPasses = 0;
    let selectionQuality = this.quality;
    let started = this.now();
    let selected = selectTerrainDetail(
      this.provider, selectionQuality, frame, this.previousSplitKeys, frame.visible,
    );
    selectionMs += Math.max(0, this.now() - started);
    selectionPasses++;
    started = this.now();
    let balanced = balanceTerrainLeaves(this.provider, selected.leaves);
    balanceMs += Math.max(0, this.now() - started);
    // Balancing adds the restricted-quadtree closure after selection. Use the
    // measured closure size to reserve headroom, then make at most one retry.
    // This replaces the old five-pass tighten loop that could never converge
    // while launch-site detail bypassed the selector budget.
    if (balanced.length > this.quality.maximumDesiredLeaves) {
      const closureLeaves = Math.max(0, balanced.length - selected.leaves.length);
      const reducedLimit = Math.max(
        24,
        this.quality.maximumDesiredLeaves - closureLeaves,
      );
      const nextQuality = Object.freeze({ ...this.quality, maximumDesiredLeaves: reducedLimit });
      started = this.now();
      const nextSelected = selectTerrainDetail(
        this.provider, nextQuality, frame, this.previousSplitKeys, frame.visible,
      );
      selectionMs += Math.max(0, this.now() - started);
      selectionPasses++;
      started = this.now();
      const nextBalanced = balanceTerrainLeaves(this.provider, nextSelected.leaves);
      balanceMs += Math.max(0, this.now() - started);
      if (nextBalanced.length < balanced.length) {
        selectionQuality = nextQuality;
        selected = nextSelected;
        balanced = nextBalanced;
      }
      if (balanced.length > this.quality.maximumDesiredLeaves) {
        this.diagnostics?.anomaly('terrain-desired-leaf-cap-unreachable', 'terrain', {
          desiredLeaves: balanced.length,
          maximumDesiredLeaves: this.quality.maximumDesiredLeaves,
          selectionPasses,
        }, this.diagnosticContext);
      }
    }
    const speedSquared = frame.cameraBodyFixedVelocity.x ** 2
      + frame.cameraBodyFixedVelocity.y ** 2
      + frame.cameraBodyFixedVelocity.z ** 2;
    const predicted = speedSquared < 0.25
      ? selected
      : selectPredictedTerrainDetail(
          this.provider, selectionQuality, frame, this.previousSplitKeys, frame.visible,
        );
    return Object.freeze({
      cameraBodyFixed: copyVector(frame.cameraBodyFixed),
      cameraBodyFixedVelocity: copyVector(frame.cameraBodyFixedVelocity),
      viewDirectionBodyFixed: frame.viewDirectionBodyFixed
        ? copyVector(frame.viewDirectionBodyFixed)
        : undefined,
      viewMarginRadians: frame.viewMarginRadians,
      verticalFovRadians: frame.verticalFovRadians,
      drawingBufferHeight: frame.drawingBufferHeight,
      visibilitySignature: frame.visibilitySignature,
      selectionQuality,
      selected,
      balanced,
      predicted,
      balanceViolations: terrainNeighborDepthViolations(balanced),
      selectionMs,
      balanceMs,
      selectionPasses,
    });
  }

  coverageReady(): boolean { return this.stats.coverageReady; }

  detailDemand(): readonly TerrainTileId[] {
    return Object.freeze((this.cachedSelection?.balanced ?? []).map((tile) => tile.id));
  }

  setShadowReceiver(enabled: boolean): void {
    this.shadowReceiver = enabled;
    for (const chunk of this.chunks.values()) {
      chunk.mesh.receiveShadow = enabled;
      chunk.mesh.castShadow = enabled;
    }
  }

  private queue(
    tile: TerrainTileDescriptor,
    requestClass: TerrainRequestClass,
    frame: Readonly<PlanetTerrainFrame>,
    selectedSse?: number,
  ): void {
    const existing = this.records.get(tile.key);
    if (existing?.state === 'installed' || existing?.state === 'ready') return;
    const newRequest = !existing || existing.state === 'unloaded' || existing.state === 'failed';
    const admissionLimit = this.quality.submissionsPerFrame;
    if (newRequest && tile.id.depth > 0 && this.newRequestsThisFrame >= admissionLimit) return;
    this.lastRequestedFrame.set(tile.key, this.frame);
    const request = this.provider.buildRequest(
      tile.id,
      skirtDepth(this.provider, tile, this.quality.gridResolution),
    );
    if (newRequest) {
      this.newRequestsThisFrame++;
      this.records.set(tile.key, {
        tile, state: 'queued', generation: request.generation,
        materialGeneration: this.provider.generation, gpuValid: false,
      });
      this.requestedAt.set(tile.key, this.now());
      this.requestOrder.push(tile.key);
    }
    const bounds = terrainTileBoundingSphere(this.provider, tile);
    const distanceToBounds = Math.max(0, Math.hypot(
      frame.cameraBodyFixed.x - bounds.center.x,
      frame.cameraBodyFixed.y - bounds.center.y,
      frame.cameraBodyFixed.z - bounds.center.z,
    ) - bounds.radius);
    const sse = selectedSse ?? screenSpaceErrorPixels({
      geometricErrorMeters: tile.geometricErrorMeters,
      distanceToBoundingVolumeMeters: distanceToBounds,
      drawingBufferHeight: frame.drawingBufferHeight,
      verticalFovRadians: frame.verticalFovRadians,
    });
    const cameraLength = Math.hypot(
      frame.cameraBodyFixed.x,
      frame.cameraBodyFixed.y,
      frame.cameraBodyFixed.z,
    ) || 1;
    const centerLength = Math.hypot(bounds.center.x, bounds.center.y, bounds.center.z) || 1;
    const viewDot = (
      frame.cameraBodyFixed.x * bounds.center.x
      + frame.cameraBodyFixed.y * bounds.center.y
      + frame.cameraBodyFixed.z * bounds.center.z
    ) / (cameraLength * centerLength);
    const estimatedBytes = estimatedGeometryBytes(this.quality.gridResolution);
    const distanceToViewCenter = Math.acos(Math.max(-1, Math.min(1, viewDot)));
    this.scheduler.request({
      request,
      requestClass,
      visible: requestClass !== 'predicted-refinement' && requestClass !== 'background',
      screenSpaceError: sse,
      distanceToViewCenter,
      depth: tile.id.depth,
      estimatedBytes,
      root: tile.id.depth === 0,
    }, this.now());
    if (newRequest) this.terrainEvent('queued', tile, {
      requestClass,
      screenSpaceError: sse,
      distanceToViewCenter,
      estimatedBytes,
    });
  }

  private install(result: TerrainChunkGeometryResult, reservationKey: string, requestClass: TerrainRequestClass): void {
    if (result.generation !== this.provider.generation) return;
    const tile = this.provider.tile(result.tile);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(result.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(result.normal, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(result.color, 3));
    geo.setAttribute('bodyDirection', new THREE.BufferAttribute(result.bodyDirection, 3));
    geo.setAttribute('bodyFixedDetailAnchor', new THREE.BufferAttribute(result.bodyFixedDetailAnchor, 3));
    geo.setAttribute('surfaceAltitude', new THREE.BufferAttribute(surfaceAltitudes(result, this.provider.radiusMeters), 1));
    geo.setIndex(new THREE.BufferAttribute(result.index, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(...result.bounds.center), result.bounds.radius);
    const bytes = geometryByteLength(geo);
    const decision = this.residency.commitInstallation(
      reservationKey, tile.key, bytes,
      requestClass === 'coverage-blocker' || requestClass === 'previous-frame-continuity',
    );
    if (!decision.installed) {
      geo.dispose();
      this.records.set(tile.key, {
        tile, state: 'unloaded', generation: result.generation,
        materialGeneration: this.provider.generation, gpuValid: false,
      });
      this.terrainEvent('installation-discarded', tile, { reason: decision.reason, bytes });
      this.records.delete(tile.key);
      return;
    }
    this.disposeChunk(tile.key, true);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `terrain:${tile.key}`;
    mesh.userData.terrainTileKey = tile.key;
    mesh.userData.terrainTileId = tile.id;
    mesh.visible = false;
    mesh.receiveShadow = this.shadowReceiver;
    mesh.castShadow = this.shadowReceiver;
    this.dither.bindMesh(mesh);
    this.group.add(mesh);
    this.chunks.set(tile.key, { tile, mesh, origin: result.origin });
    this.records.set(tile.key, {
      tile, state: 'installed', generation: result.generation,
      materialGeneration: this.provider.generation, gpuValid: true,
    });
    this.requestedAt.delete(tile.key);
    this.lastRequestedFrame.delete(tile.key);
    this.terrainEvent('installed', tile, { bytes, requestClass, reservationKey });
    if (tile.id.depth === 0) this.residency.protectPermanently(tile.key);
  }

  private requestTransitions(next: ReadonlySet<string>): void {
    for (const previousKey of this.previousRenderedKeys) {
      if (next.has(previousKey)) continue;
      const previousRecord = this.records.get(previousKey);
      if (!previousRecord || previousRecord.tile.id.depth >= this.provider.maximumDepth) continue;
      const parent = previousRecord.tile;
      const children = this.provider.children(parent).map((tile) => tile.key) as unknown as readonly [string, string, string, string];
      if (children.every((key) => next.has(key) && this.chunks.has(key))) {
        this.transitions.request({ parentKey: previousKey, childKeys: children, direction: 'split', sourceRenderable: this.chunks.has(previousKey), destinationRenderable: true });
      }
    }
    for (const nextKey of next) {
      if (this.previousRenderedKeys.has(nextKey)) continue;
      const parentRecord = this.records.get(nextKey);
      if (!parentRecord || parentRecord.tile.id.depth >= this.provider.maximumDepth) continue;
      const children = this.provider.children(parentRecord.tile).map((tile) => tile.key) as unknown as readonly [string, string, string, string];
      if (children.every((key) => this.previousRenderedKeys.has(key) && this.chunks.has(key))) {
        this.transitions.request({ parentKey: nextKey, childKeys: children, direction: 'merge', sourceRenderable: true, destinationRenderable: this.chunks.has(nextKey) });
      }
    }
  }

  private synchronizeSchedulerStates(): void {
    for (const key of this.lastRequestedFrame.keys()) {
      const record = this.records.get(key);
      if (!record) continue;
      if (record.state === 'installed' || record.state === 'ready') continue;
      const state = this.scheduler.state(key, record.generation);
      if (state === 'queued' || state === 'building' || state === 'failed') {
        if (state !== record.state) this.terrainEvent(state, record.tile);
        this.records.set(key, { ...record, state });
      }
    }
  }

  private cancelObsoleteRequests(maximumCancellations: number): void {
    if (this.requestOrder.length === 0) return;
    let inspected = 0;
    let cancelled = 0;
    const maximumInspections = Math.min(this.requestOrder.length, maximumCancellations * 4);
    while (inspected < maximumInspections && cancelled < maximumCancellations && this.requestOrder.length > 0) {
      if (this.requestCursor >= this.requestOrder.length) this.requestCursor = 0;
      const key = this.requestOrder[this.requestCursor++];
      inspected++;
      const lastRequested = this.lastRequestedFrame.get(key);
      if (lastRequested === undefined || this.frame - lastRequested <= 5) continue;
      const record = this.records.get(key);
      if (!record || (record.state !== 'queued' && record.state !== 'building' && record.state !== 'failed')) {
        this.lastRequestedFrame.delete(key);
        continue;
      }
      this.scheduler.cancel(key, record.generation);
      this.requestedAt.delete(key);
      this.lastRequestedFrame.delete(key);
      this.terrainEvent('cancelled', record.tile, { reason: 'demand-changed' });
      this.records.delete(key);
      cancelled++;
    }
    if (this.requestOrder.length > this.lastRequestedFrame.size * 2 + 1_024) {
      this.requestOrder = this.requestOrder.filter((key) => this.lastRequestedFrame.has(key));
      this.requestCursor = 0;
    }
  }

  private serializeTransitionTarget(
    desired: ReadonlySet<string>,
    transitions: ReturnType<TerrainLodTransitionManager['snapshots']>,
  ): ReadonlySet<string> {
    if (this.previousRenderedKeys.size === 0) return new Set(desired);
    const stable = new Set(this.previousRenderedKeys);
    const desiredTiles = [...desired]
      .map((key) => this.records.get(key)?.tile)
      .filter((tile): tile is TerrainTileDescriptor => tile !== undefined);
    const isDescendantOrSelf = (
      candidate: Readonly<TerrainTileDescriptor>,
      ancestor: Readonly<TerrainTileDescriptor>,
    ): boolean => {
      if (candidate.id.face !== ancestor.id.face || candidate.id.depth < ancestor.id.depth) return false;
      const scale = 2 ** (candidate.id.depth - ancestor.id.depth);
      return Math.floor(candidate.id.x / scale) === ancestor.id.x
        && Math.floor(candidate.id.y / scale) === ancestor.id.y;
    };
    const transitionBlocked = (tile: Readonly<TerrainTileDescriptor>): boolean => transitions.some((transition) => {
      const parent = this.records.get(transition.parentKey)?.tile;
      return parent !== undefined
        && (isDescendantOrSelf(tile, parent) || isDescendantOrSelf(parent, tile));
    });

    // A resolved cover may jump several levels after workers finish a batch.
    // Expose only the next complete quartet so every visible replacement has
    // an explicit parent/child transition instead of popping or deadlocking.
    for (const previousKey of this.previousRenderedKeys) {
      const previous = this.records.get(previousKey)?.tile;
      if (!previous) {
        stable.delete(previousKey);
        continue;
      }
      if (desired.has(previousKey) || transitionBlocked(previous)) continue;
      const wantsFiner = desiredTiles.some((tile) => (
        tile.id.depth > previous.id.depth && isDescendantOrSelf(tile, previous)
      ));
      if (!wantsFiner) continue;
      const children = this.provider.children(previous);
      if (!children.every((child) => this.chunks.has(child.key))) continue;
      stable.delete(previousKey);
      for (const child of children) stable.add(child.key);
    }

    // Merge one complete sibling quartet at a time when the desired cover has
    // moved to an ancestor. Deep branches therefore unwind as smoothly as
    // they refine.
    const mergeParents = new Map<string, TerrainTileDescriptor>();
    for (const key of stable) {
      const tile = this.records.get(key)?.tile;
      if (!tile || tile.id.depth === 0) continue;
      const parentId = terrainTileParent(tile.id);
      if (!parentId) continue;
      const parent = this.provider.tile(parentId);
      mergeParents.set(parent.key, parent);
    }
    for (const parent of [...mergeParents.values()].sort((a, b) => b.id.depth - a.id.depth)) {
      if (transitionBlocked(parent) || !this.chunks.has(parent.key)) continue;
      const children = this.provider.children(parent);
      if (!children.every((child) => stable.has(child.key))) continue;
      const wantsFiner = desiredTiles.some((tile) => (
        tile.id.depth > parent.id.depth && isDescendantOrSelf(tile, parent)
      ));
      // A branch with no desired ancestor or descendant has left the
      // conservative horizon/frustum cover. Unwind it through the same safe
      // quartet merge path instead of retaining its deep chunks forever.
      if (wantsFiner) continue;
      for (const child of children) stable.delete(child.key);
      stable.add(parent.key);
    }

    // A culled partial branch may not form a complete quartet (for example if
    // it left view during a transition). It is safe to drop only deep tiles
    // with no desired relationship and no active transition; coarse coverage
    // remains globally available for rapid pans.
    for (const key of [...stable]) {
      const tile = this.records.get(key)?.tile;
      if (!tile || tile.id.depth < 3 || transitionBlocked(tile)) continue;
      const related = desiredTiles.some((desiredTile) => (
        isDescendantOrSelf(desiredTile, tile) || isDescendantOrSelf(tile, desiredTile)
      ));
      if (!related) stable.delete(key);
    }

    // A newly visible root can have no relationship to the previous frame's
    // cover. Add it directly; related refinement remains serialized above.
    for (const desiredTile of desiredTiles) {
      const overlapsStableCover = [...stable].some((key) => {
        const stableTile = this.records.get(key)?.tile;
        return stableTile !== undefined && (
          isDescendantOrSelf(desiredTile, stableTile)
          || isDescendantOrSelf(stableTile, desiredTile)
        );
      });
      if (!overlapsStableCover && this.chunks.has(desiredTile.key)) stable.add(desiredTile.key);
    }
    return stable;
  }

  private applyRenderState(
    renderKeys: ReadonlySet<string>,
    transitions: ReturnType<TerrainLodTransitionManager['snapshots']>,
    frame: Readonly<PlanetTerrainFrame>,
  ): void {
    const quaternion = new THREE.Quaternion(frame.orientation.x, frame.orientation.y, frame.orientation.z, frame.orientation.w);
    const rotated = new THREE.Vector3();
    for (const [key, chunk] of this.chunks) {
      chunk.mesh.visible = renderKeys.has(key);
      this.dither.setMeshTransition(chunk.mesh, null, 0);
      if (!chunk.mesh.visible) continue;
      rotated.set(...chunk.origin).applyQuaternion(quaternion);
      chunk.mesh.position.set(
        rotated.x + frame.cameraRelativeOrigin.x,
        rotated.y + frame.cameraRelativeOrigin.y,
        rotated.z + frame.cameraRelativeOrigin.z,
      );
      chunk.mesh.quaternion.copy(quaternion);
    }
    for (const transition of transitions) {
      const parent = this.chunks.get(transition.parentKey)?.mesh;
      if (parent) this.dither.setMeshTransition(parent, 'parent', transition.progress);
      for (const childKey of transition.childKeys) {
        const child = this.chunks.get(childKey)?.mesh;
        if (child) this.dither.setMeshTransition(child, 'children', transition.progress);
      }
    }
  }

  private disposeChunk(key: string, keepResidency = false, reason = 'replacement'): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.group.remove(chunk.mesh);
    this.dither.disposeMesh(chunk.mesh);
    chunk.mesh.geometry.dispose();
    this.chunks.delete(key);
    if (!keepResidency) this.residency.removeInstalled(key, true);
    const record = this.records.get(key);
    if (record) this.terrainEvent('evicted', record.tile, { reason });
    this.records.delete(key);
  }

  private terrainEvent(
    event: string,
    tile?: Readonly<TerrainTileDescriptor>,
    data: Readonly<Record<string, string | number | boolean | null>> = {},
  ): void {
    if (!this.diagnostics) return;
    const observation = {
      ...this.diagnosticContext,
      bodyId: this.provider.bodyId,
      rendererIdentity: this.diagnosticSource,
      event,
      key: tile?.key,
      face: tile?.id.face,
      depth: tile?.id.depth,
      generation: this.provider.generation,
      data,
      batched: this.diagnostics.detailed,
    } as const;
    this.diagnostics.observeTerrainEvent?.(observation);
    if (this.diagnostics.detailed) this.diagnosticLifecycleBatch.push(JSON.stringify({
      event,
      key: tile?.key ?? null,
      depth: tile?.id.depth ?? null,
      generation: this.provider.generation,
      ...data,
    }));
  }

  private observeTransitions(
    snapshots: ReturnType<TerrainLodTransitionManager['snapshots']>,
  ): number {
    const next = new Map<string, string>();
    let incomplete = 0;
    for (const snapshot of snapshots) {
      const state = `${snapshot.direction}:${snapshot.state}`;
      next.set(snapshot.id, state);
      if (this.previousTransitionStates.get(snapshot.id) !== state) {
        this.terrainEvent(snapshot.state === 'active' ? 'transition-start' : 'transition-complete', undefined, {
          transitionId: snapshot.id,
          parentKey: snapshot.parentKey,
          direction: snapshot.direction,
          progress: snapshot.progress,
        });
      }
      const completeSet = this.chunks.has(snapshot.parentKey)
        && snapshot.childKeys.every((key) => this.chunks.has(key));
      if (!completeSet) {
        incomplete++;
        this.diagnostics?.anomaly('terrain-transition-incomplete', 'terrain', {
          transitionId: snapshot.id,
          parentKey: snapshot.parentKey,
        }, this.diagnosticContext);
      }
    }
    for (const [id] of this.previousTransitionStates) {
      if (!next.has(id)) this.terrainEvent('transition-release', undefined, { transitionId: id });
    }
    this.previousTransitionStates = next;
    return incomplete;
  }

  private countImmediateReplacements(
    previous: ReadonlySet<string>,
    next: ReadonlySet<string>,
    transitions: ReturnType<TerrainLodTransitionManager['snapshots']>,
  ): number {
    const transitioningParents = new Set(transitions.map((transition) => transition.parentKey));
    const isDescendant = (candidateKey: string, ancestor: Readonly<TerrainTileDescriptor>): boolean => {
      const candidate = this.records.get(candidateKey)?.tile;
      if (!candidate || candidate.id.face !== ancestor.id.face || candidate.id.depth <= ancestor.id.depth) return false;
      const scale = 2 ** (candidate.id.depth - ancestor.id.depth);
      return Math.floor(candidate.id.x / scale) === ancestor.id.x
        && Math.floor(candidate.id.y / scale) === ancestor.id.y;
    };
    let count = 0;
    for (const key of previous) {
      if (next.has(key) || transitioningParents.has(key)) continue;
      const record = this.records.get(key);
      if (!record || record.tile.id.depth >= this.provider.maximumDepth) continue;
      if ([...next].some((candidate) => isDescendant(candidate, record.tile))) count++;
    }
    for (const key of next) {
      if (previous.has(key) || transitioningParents.has(key)) continue;
      const record = this.records.get(key);
      if (!record || record.tile.id.depth >= this.provider.maximumDepth) continue;
      if ([...previous].some((candidate) => isDescendant(candidate, record.tile))) count++;
    }
    return count;
  }

  private observeFrame(
    coverage: ReturnType<typeof resolveTerrainCoverage>,
    balanced: readonly TerrainTileDescriptor[],
    renderKeys: ReadonlySet<string>,
    previousRenderedKeys: ReadonlySet<string>,
    activeTransitions: number,
    incompleteTransitions: number,
    protectedEvictions: number,
    immediateReplacements: number,
  ): void {
    if (!this.diagnostics?.observeTerrainSample) return;
    const now = this.now();
    let oldestPendingAgeMs = 0;
    for (const started of this.requestedAt.values()) {
      oldestPendingAgeMs = Math.max(oldestPendingAgeMs, now - started);
    }
    const visibleByDepth: Record<string, number> = {};
    for (const key of coverage.renderedKeys) {
      const depth = this.records.get(key)?.tile.id.depth;
      if (depth !== undefined) visibleByDepth[String(depth)] = (visibleByDepth[String(depth)] ?? 0) + 1;
    }
    const desiredDepths = balanced.map((tile) => tile.id.depth);
    const resolvedDepths = [...coverage.renderedKeys]
      .map((key) => this.records.get(key)?.tile.id.depth)
      .filter((depth): depth is number => depth !== undefined);
    const renderedDepths = [...renderKeys]
      .map((key) => this.records.get(key)?.tile.id.depth)
      .filter((depth): depth is number => depth !== undefined);
    const previousDepths = [...previousRenderedKeys]
      .map((key) => this.records.get(key)?.tile.id.depth)
      .filter((depth): depth is number => depth !== undefined);
    const residency = this.residency.stats();
    const scheduler = this.scheduler.stats();
    const workers = this.workerPool?.timings();
    this.diagnostics.observeTerrainSample({
      ...this.diagnosticContext,
      bodyId: this.provider.bodyId,
      rendererIdentity: this.diagnosticSource,
      terrainRequested: this.diagnosticContext.terrainRequested ?? true,
      generation: this.provider.generation,
      visible: this.stats.visible,
      chunks: this.stats.chunks,
      triangles: this.stats.triangles,
      geometryBytes: residency.installedBytes,
      pending: scheduler.queued + scheduler.building + this.installationQueue.length,
      oldestPendingAgeMs,
      coverageGaps: this.stats.coverageGaps,
      coverageReady: this.stats.coverageReady,
      replacementRoots: 0,
      workers: workers?.workers ?? 1,
      activeWorkers: workers?.active ?? scheduler.building,
      queuedWorkers: workers?.pending ?? scheduler.queued,
      scheduleMs: this.stats.scheduleMs,
      installMs: this.stats.installMs,
      selectionMs: this.stats.selectionMs,
      balanceMs: this.stats.balanceMs,
      selectionPasses: this.stats.selectionPasses,
      selectionReused: this.stats.selectionReused,
      selectionInvalidation: this.stats.selectionInvalidation,
      buildP99Ms: workers?.buildP99Ms ?? 0,
      visibleByDepth,
      rootsReady: coverage.rootsReady,
      reservedBytes: residency.reservedBytes,
      allocationBytes: residency.allocationBytes,
      protectedBytes: residency.protectedBytes,
      desiredLeaves: balanced.length,
      renderedLeaves: coverage.renderedKeys.size,
      fallbackTiles: coverage.fallbackKeys.size,
      stagingTiles: coverage.stagingKeys.size,
      desiredMinimumDepth: desiredDepths.length ? Math.min(...desiredDepths) : -1,
      desiredMaximumDepth: desiredDepths.length ? Math.max(...desiredDepths) : -1,
      resolvedMinimumDepth: resolvedDepths.length ? Math.min(...resolvedDepths) : -1,
      resolvedMaximumDepth: resolvedDepths.length ? Math.max(...resolvedDepths) : -1,
      renderedMinimumDepth: renderedDepths.length ? Math.min(...renderedDepths) : -1,
      renderedMaximumDepth: renderedDepths.length ? Math.max(...renderedDepths) : -1,
      previousMinimumDepth: previousDepths.length ? Math.min(...previousDepths) : -1,
      previousMaximumDepth: previousDepths.length ? Math.max(...previousDepths) : -1,
      balanceViolations: this.stats.balanceViolations,
      activeTransitions,
      incompleteTransitions,
      protectedEvictions,
      immediateReplacements,
    });
  }

  private flushDiagnosticLifecycleBatch(): void {
    if (!this.diagnostics?.detailed || this.diagnosticLifecycleBatch.length === 0) return;
    let batch = '';
    const batches: string[] = [];
    for (const event of this.diagnosticLifecycleBatch) {
      const next = batch ? `${batch}\n${event}` : event;
      if (next.length > 8_000 && batch) {
        batches.push(batch);
        batch = event;
      } else batch = next;
    }
    if (batch) batches.push(batch);
    for (let index = 0; index < batches.length; index++) {
      this.diagnostics.recordDetailed({
        subsystem: 'terrain',
        event: 'terrain-lifecycle-batch',
        severity: 'state',
        data: {
          frame: this.frame,
          generation: this.provider.generation,
          batchIndex: index,
          batchCount: batches.length,
          eventCount: this.diagnosticLifecycleBatch.length,
          events: batches[index],
        },
      }, this.diagnosticContext);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.cancelGeneration(this.provider.generation);
    if (this.ownsWorkerPool) this.workerPool?.dispose();
    for (const key of [...this.chunks.keys()]) this.disposeChunk(key, true, 'engine-dispose');
    this.records.clear();
    this.requestedAt.clear();
    this.lastRequestedFrame.clear();
    this.requestOrder = [];
    this.residency.clear();
    this.transitions.clear();
    this.dither.dispose();
  }
}
