import * as THREE from 'three';
import type { QuaternionCoordinates, VectorCoordinates } from '../bodyRenderer';
import { geometryByteLength } from '../resourceAccounting';
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
  type TerrainSelectionFrame,
  type TerrainVisibilityPredicate,
} from './terrainSelection';
import { screenSpaceErrorPixels } from './terrainPolicy';
import type { PlanetSurfaceProvider, TerrainTileDescriptor } from './surfaceProvider';

export interface PlanetTerrainFrame extends TerrainSelectionFrame {
  readonly cameraRelativeOrigin: VectorCoordinates;
  readonly orientation: QuaternionCoordinates;
  readonly deltaSeconds: number;
  readonly framePressure: boolean;
  readonly generation: number;
  readonly visible?: TerrainVisibilityPredicate;
}

export interface PlanetTerrainEngineOptions {
  readonly provider: PlanetSurfaceProvider;
  readonly quality: TerrainQualityPolicy;
  readonly material: THREE.Material;
  readonly terrainAllocationBytes: number;
  readonly workerPool?: TerrainChunkWorkerPool;
  readonly now?: () => number;
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
  readonly geometryBytes: number;
  readonly reservedBytes: number;
  readonly queued: number;
  readonly building: number;
  readonly ready: number;
  readonly failed: number;
}

interface InstalledChunk {
  readonly tile: TerrainTileDescriptor;
  readonly mesh: THREE.Mesh;
  readonly origin: readonly [number, number, number];
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
  private readonly transitions = new TerrainLodTransitionManager();
  private readonly dither: TerrainLodDitherBinding;
  private readonly workerPool?: TerrainChunkWorkerPool;
  private readonly now: () => number;
  private installationQueue: ReturnType<TerrainRequestScheduler['drainCompleted']> = [];
  private previousSplitKeys = new Set<string>();
  private previousRenderedKeys = new Set<string>();
  private requestedThisFrame = new Set<string>();
  private frame = 0;
  private disposed = false;
  private shadowReceiver = false;
  stats: PlanetTerrainEngineStats = Object.freeze({
    frame: 0, chunks: 0, visible: 0, triangles: 0, coverageGaps: 0,
    rootsReady: false, coverageReady: false, scheduleMs: 0, installMs: 0,
    geometryBytes: 0, reservedBytes: 0,
    queued: 0, building: 0, ready: 0, failed: 0,
  });

  constructor(options: Readonly<PlanetTerrainEngineOptions>) {
    this.provider = options.provider;
    this.quality = options.quality;
    this.material = options.material;
    this.workerPool = options.workerPool;
    this.now = options.now ?? (() => performance.now());
    this.residency = new TerrainResidencyManager(options.terrainAllocationBytes, options.quality.softResidencyRatio);
    const executor = options.workerPool ?? new InlineTerrainExecutor(options.provider);
    this.scheduler = new TerrainRequestScheduler(executor, this.residency);
    this.dither = installTerrainLodDither(this.material);
  }

  update(frame: Readonly<PlanetTerrainFrame>): void {
    if (this.disposed) return;
    if (frame.generation !== this.provider.generation) return;
    this.frame++;
    const installStarted = this.now();
    const completed = this.scheduler.drainCompleted();
    for (const completion of completed) {
      const record = this.records.get(completion.result.jobKey);
      if (record && record.generation === completion.result.generation) {
        this.records.set(record.tile.key, { ...record, state: 'ready' });
      }
    }
    this.installationQueue.push(...completed);
    while (this.installationQueue.length > 0) {
      if (this.now() - installStarted > this.quality.installationBudgetMs) break;
      const completion = this.installationQueue.shift()!;
      try {
        this.install(completion.result, completion.reservationKey, completion.requestClass);
      } catch {
        const record = this.records.get(completion.result.jobKey);
        if (record && record.generation === completion.result.generation) {
          this.records.set(record.tile.key, { ...record, state: 'failed', gpuValid: false });
        }
      } finally {
        this.scheduler.releaseCompleted(completion.result.jobKey, completion.result.generation);
      }
    }
    const installMs = Math.max(0, this.now() - installStarted);

    const selected = selectTerrainDetail(
      this.provider, this.quality, frame, this.previousSplitKeys, frame.visible,
    );
    const balanced = balanceTerrainLeaves(this.provider, selected.leaves);
    const coverage = resolveTerrainCoverage({
      provider: this.provider,
      desiredLeaves: balanced,
      records: this.records,
      previousRenderedKeys: this.previousRenderedKeys,
      generation: frame.generation,
      materialGeneration: this.provider.generation,
    });

    this.requestTransitions(coverage.renderedKeys);
    const transitionSnapshots = this.transitions.advance(
      frame.deltaSeconds, frame.framePressure, this.frame,
    );
    const renderKeys = new Set(coverage.renderedKeys);
    for (const transition of transitionSnapshots) {
      renderKeys.add(transition.parentKey);
      for (const child of transition.childKeys) renderKeys.add(child);
    }

    const predicted = selectPredictedTerrainDetail(
      this.provider, this.quality, frame, this.previousSplitKeys, frame.visible,
    );
    const scheduleStarted = this.now();
    this.requestedThisFrame = new Set();
    for (const request of coverage.requests) this.queue(request.tile, request.requestClass, frame);
    for (const tile of balanced) {
      if (this.now() - scheduleStarted >= this.quality.schedulingBudgetMs) break;
      this.queue(tile, 'visible-refinement', frame, selected.screenSpaceErrors.get(tile.key));
    }
    for (const tile of predicted.leaves) {
      if (this.now() - scheduleStarted >= this.quality.schedulingBudgetMs) break;
      this.queue(tile, 'predicted-refinement', frame, predicted.screenSpaceErrors.get(tile.key));
    }
    this.cancelObsoleteRequests();
    this.scheduler.dispatch(this.now(), this.quality.submissionsPerFrame);
    this.synchronizeSchedulerStates();
    const scheduleMs = Math.max(0, this.now() - scheduleStarted);

    this.applyRenderState(renderKeys, transitionSnapshots, frame);
    const protection = new Set([
      ...coverage.protectionKeys,
      ...this.transitions.protectionKeys(),
      ...predicted.leaves.map((tile) => tile.key),
    ]);
    this.residency.beginFrame(this.frame, protection);
    if (coverage.rootsReady) {
      for (let face = 0; face < 6; face++) this.residency.protectPermanently(this.provider.rootTile(face as 0 | 1 | 2 | 3 | 4 | 5).key);
    }
    for (const key of protection) this.residency.markUsed(key);
    for (const key of this.residency.trimToSoftTarget()) this.disposeChunk(key);

    this.previousSplitKeys = new Set(selected.splitKeys);
    this.previousRenderedKeys = new Set(coverage.renderedKeys);
    const residency = this.residency.stats();
    const scheduler = this.scheduler.stats();
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
      geometryBytes: residency.installedBytes,
      reservedBytes: residency.reservedBytes,
      queued: scheduler.queued,
      building: scheduler.building,
      ready: this.installationQueue.length,
      failed: scheduler.failed,
    });
  }

  coverageReady(): boolean { return this.stats.coverageReady; }

  setShadowReceiver(enabled: boolean): void {
    this.shadowReceiver = enabled;
    for (const chunk of this.chunks.values()) chunk.mesh.receiveShadow = enabled;
  }

  private queue(
    tile: TerrainTileDescriptor,
    requestClass: TerrainRequestClass,
    frame: Readonly<PlanetTerrainFrame>,
    selectedSse?: number,
  ): void {
    const existing = this.records.get(tile.key);
    if (existing?.state === 'installed' || existing?.state === 'ready') return;
    this.requestedThisFrame.add(tile.key);
    const request = this.provider.buildRequest(
      tile.id,
      skirtDepth(this.provider, tile, this.quality.gridResolution),
    );
    if (!existing || existing.state === 'unloaded' || existing.state === 'failed') {
      this.records.set(tile.key, {
        tile, state: 'queued', generation: request.generation,
        materialGeneration: this.provider.generation, gpuValid: false,
      });
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
    this.scheduler.request({
      request,
      requestClass,
      visible: requestClass !== 'predicted-refinement' && requestClass !== 'background',
      screenSpaceError: sse,
      distanceToViewCenter: Math.acos(Math.max(-1, Math.min(1, viewDot))),
      depth: tile.id.depth,
      estimatedBytes: estimatedGeometryBytes(this.quality.gridResolution),
      root: tile.id.depth === 0,
    }, this.now());
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
      return;
    }
    this.disposeChunk(tile.key, true);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `terrain:${tile.key}`;
    mesh.userData.terrainTileKey = tile.key;
    mesh.userData.terrainTileId = tile.id;
    mesh.visible = false;
    mesh.receiveShadow = this.shadowReceiver;
    this.dither.bindMesh(mesh);
    this.group.add(mesh);
    this.chunks.set(tile.key, { tile, mesh, origin: result.origin });
    this.records.set(tile.key, {
      tile, state: 'installed', generation: result.generation,
      materialGeneration: this.provider.generation, gpuValid: true,
    });
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
    for (const [key, record] of this.records) {
      if (record.state === 'installed' || record.state === 'ready') continue;
      const state = this.scheduler.state(key, record.generation);
      if (state === 'queued' || state === 'building' || state === 'failed') {
        this.records.set(key, { ...record, state });
      }
    }
  }

  private cancelObsoleteRequests(): void {
    for (const [key, record] of this.records) {
      if (
        this.requestedThisFrame.has(key)
        || (record.state !== 'queued' && record.state !== 'building' && record.state !== 'failed')
      ) continue;
      this.scheduler.cancel(key, record.generation);
      this.records.set(key, { ...record, state: 'unloaded', gpuValid: false });
    }
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

  private disposeChunk(key: string, keepResidency = false): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.group.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    this.chunks.delete(key);
    if (!keepResidency) this.residency.removeInstalled(key, true);
    const record = this.records.get(key);
    if (record) this.records.set(key, { ...record, state: 'unloaded', gpuValid: false });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.cancelGeneration(this.provider.generation);
    this.workerPool?.dispose();
    for (const key of [...this.chunks.keys()]) this.disposeChunk(key, true);
    this.records.clear();
    this.residency.clear();
    this.transitions.clear();
    this.dither.dispose();
  }
}
