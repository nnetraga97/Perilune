import * as THREE from 'three';
import type { BodyRenderFrame, QualityTier } from '../bodyRenderer';
import type { RenderDiagnosticsPort } from '../renderDiagnostics';
import { PlanetDetailSessionBudget, planetDetailBudget } from './detailBudget';
import { planetDetailState, type PlanetDetailMaterialState } from './detailMaterial';
import { selectEquirectPages, type EquirectPageSelection } from './equirectPageTable';
import { PersistentPlanetTileCache } from './persistentTileCache';
import { planetVisualDetailSource, planetVisualDetailSourceForView } from './sourceRegistry';
import { requestPlanetTile } from './tileRequest';
import type { DetailTileAddress, PlanetDetailSourceAdapter } from './sourceAdapter';
import { detailColorTransform } from './detailColorTransform';

const COMPACT_DETAIL_GRID_SIZE = 3;
const DEFAULT_DRAWING_BUFFER_ASPECT = 16 / 9;
const MOON_COMPACT_DETAIL_CEILING_METERS = 2_000_000;
const MOON_COARSE_GLOBAL_LEVEL = 2;

/**
 * Limits local detail to a level whose fixed 3x3 atlas covers every lunar
 * surface point visible through the viewport, including its corners. This
 * prevents a sharp center patch surrounded by the resident global parent.
 */
export function compactDetailLevelForViewport(
  source: Readonly<PlanetDetailSourceAdapter>,
  desiredLevel: number,
  bodyRadius: number,
  cameraDistance: number,
  verticalFovRadians: number,
  drawingBufferWidth: number,
  drawingBufferHeight: number,
): number {
  if (!(bodyRadius > 0) || !(cameraDistance > bodyRadius)) return 0;
  const height = Math.max(1, drawingBufferHeight);
  const aspect = drawingBufferWidth > 0
    ? Math.max(1, drawingBufferWidth / height)
    : DEFAULT_DRAWING_BUFFER_ASPECT;
  const halfVertical = verticalFovRadians * 0.5;
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * aspect);
  const cornerRay = Math.atan(Math.hypot(Math.tan(halfVertical), Math.tan(halfHorizontal)));
  const apparentRadius = Math.asin(Math.min(1, bodyRadius / cameraDistance));
  const rayAngle = Math.min(apparentRadius, cornerRay);
  const surfaceHalfAngle = rayAngle >= apparentRadius - 1e-9
    ? Math.acos(Math.min(1, bodyRadius / cameraDistance))
    : Math.asin(Math.min(1, cameraDistance / bodyRadius * Math.sin(rayAngle))) - rayAngle;

  for (let level = Math.min(source.maxLevel, Math.max(0, desiredLevel)); level >= 0; level--) {
    const matrix = source.matrix(level);
    const longitudeHalfSpan = COMPACT_DETAIL_GRID_SIZE * Math.PI / matrix.width;
    const latitudeHalfSpan = COMPACT_DETAIL_GRID_SIZE * Math.PI / (2 * matrix.height);
    if (Math.min(longitudeHalfSpan, latitudeHalfSpan) >= surfaceHalfAngle) return level;
  }
  return 0;
}

export interface CompactDetailStats {
  readonly state: 'disabled' | 'resident-parent' | 'requesting' | 'crossfading' | 'ready' | 'failed';
  readonly level: number;
  readonly pages: number;
  readonly gpuBytes: number;
  readonly requestBytes: number;
  readonly generation: number;
  readonly datasetId?: string;
  readonly fallbackReason?: string;
}

export class CompactDetailController {
  private static readonly CROSSFADE_SECONDS = 0.35;
  /** The checked global parent already oversamples a body that fits on screen. */
  private static readonly FULL_DISK_VERTICAL_FOV_FRACTION = 0.98;
  private source: PlanetDetailSourceAdapter | null;
  private readonly budget;
  private persistent: PersistentPlanetTileCache | null;
  private readonly suppressedSources = new Set<string>();
  private readonly states: PlanetDetailMaterialState[];
  private abort = new AbortController();
  private signature = '';
  private atlas: THREE.CanvasTexture | null = null;
  private previousAtlas: THREE.CanvasTexture | null = null;
  private generation = 0;
  private currentState: CompactDetailStats = Object.freeze({ state: 'resident-parent', level: 0, pages: 0, gpuBytes: 0, requestBytes: 0, generation: 0 });
  private disposed = false;

  constructor(
    private readonly bodyId: string,
    private readonly bodyRadius: number,
    tier: QualityTier,
    materials: readonly THREE.Material[],
    private readonly diagnostics?: RenderDiagnosticsPort,
    private readonly sessionBudget = new PlanetDetailSessionBudget(planetDetailBudget(tier)),
  ) {
    this.source = planetVisualDetailSource(bodyId);
    this.budget = planetDetailBudget(tier);
    this.persistent = this.source && this.budget.enabled
      ? new PersistentPlanetTileCache(this.source.generation, Math.floor(this.budget.persistentBytes / 2))
      : null;
    this.states = materials.map(planetDetailState).filter((state): state is PlanetDetailMaterialState => state !== null);
    if (!this.source || !this.budget.enabled) this.disable('quality-or-source-disabled');
  }

  update(frame: Readonly<BodyRenderFrame>): void {
    if (this.disposed || !this.source || !this.budget.enabled) return;
    if (this.currentState.state === 'crossfading') {
      const opacity = Math.min(1, (this.states[0]?.opacity.value ?? 0) + frame.deltaSeconds / CompactDetailController.CROSSFADE_SECONDS);
      for (const state of this.states) {
        state.opacity.value = opacity;
        state.previousOpacity.value = this.previousAtlas ? 1 - opacity : 0;
      }
      if (opacity >= 1) {
        this.releasePreviousAtlas();
        this.currentState = Object.freeze({ ...this.currentState, state: 'ready', gpuBytes: this.atlasBytes() });
      }
    }
    const cameraDistance = Math.hypot(frame.cameraBodyFixed.x, frame.cameraBodyFixed.y, frame.cameraBodyFixed.z);
    if (!(cameraDistance > this.bodyRadius)) return this.suspend('camera-inside-body');
    const altitude = Math.max(1, cameraDistance - this.bodyRadius);
    const apparentDiameter = 2 * Math.asin(Math.min(1, this.bodyRadius / cameraDistance));
    // A full-disk view is bounded by the drawing-buffer resolution, while the
    // resident global map already supplies more texels than the disk can show.
    // Streaming a moving 3x3 local atlas here only introduces page/level
    // transitions across the visible globe (notably around 12-15 Mm at Earth).
    const moonCoarseDetailActive = this.bodyId === 'moon'
      && altitude <= MOON_COMPACT_DETAIL_CEILING_METERS;
    if (
      apparentDiameter <= frame.verticalFovRadians * CompactDetailController.FULL_DISK_VERTICAL_FOV_FRACTION
      && !moonCoarseDetailActive
    ) {
      return this.suspend('resident-parent-full-disk');
    }
    const metersPerPixel = 2 * altitude * Math.tan(frame.verticalFovRadians * 0.5) / Math.max(1, frame.drawingBufferHeight);
    const selectedSource = planetVisualDetailSourceForView(this.bodyId, frame.cameraBodyFixed, metersPerPixel, this.suppressedSources);
    if (selectedSource?.datasetId !== this.source?.datasetId) {
      this.source = selectedSource;
      this.persistent = selectedSource
        ? new PersistentPlanetTileCache(selectedSource.generation, Math.floor(this.budget.persistentBytes / 2))
        : null;
      this.signature = '';
      this.abort.abort();
      this.abort = new AbortController();
    }
    if (!this.source) return this.suspend('no-source-fallback');
    const latitude = Math.asin(Math.max(-1, Math.min(1, frame.cameraBodyFixed.z / cameraDistance)));
    const desiredLevel = this.source.levelForProjectedFootprint(this.bodyRadius, latitude, metersPerPixel);
    const level = this.bodyId === 'moon'
      ? compactDetailLevelForViewport(
          this.source,
          desiredLevel,
          this.bodyRadius,
          cameraDistance,
          frame.verticalFovRadians,
          frame.drawingBufferWidth ?? 0,
          frame.drawingBufferHeight,
        )
      : desiredLevel;
    const coarseMoonAtlas = this.bodyId === 'moon' && level === MOON_COARSE_GLOBAL_LEVEL;
    const selection = selectEquirectPages(
      this.source,
      level,
      frame.cameraBodyFixed,
      coarseMoonAtlas ? 4 : COMPACT_DETAIL_GRID_SIZE,
      coarseMoonAtlas ? 4 : COMPACT_DETAIL_GRID_SIZE,
    );
    const minimumUsefulLevel = this.bodyId === 'moon' ? MOON_COARSE_GLOBAL_LEVEL : 3;
    if (!selection || level < minimumUsefulLevel) return this.suspend('resident-parent-is-sufficient');
    if (selection.signature === this.signature) return;
    this.signature = selection.signature;
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.currentState = Object.freeze({ state: 'requesting', level, pages: 0, gpuBytes: this.atlasBytes(), requestBytes: 0, generation: this.generation, datasetId: this.source.datasetId });
    void this.load(selection, this.generation, this.abort.signal);
  }

  private async load(selection: EquirectPageSelection, generation: number, signal: AbortSignal): Promise<void> {
    const source = this.source!;
    const matrix = source.matrix(selection.level);
    const jobs: Array<{ x: number; y: number; address: DetailTileAddress }> = [];
    for (let y = 0; y < selection.gridHeight; y++) for (let x = 0; x < selection.gridWidth; x++) {
      jobs.push({ x, y, address: source.address(selection.level, selection.startRow + y, selection.startColumn + x) });
    }
    let next = 0;
    let requestBytes = 0;
    const decoded: Array<{ x: number; y: number; bitmap: ImageBitmap }> = [];
    try {
      if (jobs.length > this.budget.maximumVisualRequestsPerGeneration) {
        throw new Error(`Planet detail selection exceeds ${this.budget.maximumVisualRequestsPerGeneration} visual requests`);
      }
      const workers = Array.from({ length: Math.min(this.budget.concurrentRequests, jobs.length) }, async () => {
        for (;;) {
          const job = jobs[next++];
          if (!job) return;
          const response = await requestPlanetTile(job.address, signal, this.persistent ?? undefined, this.sessionBudget);
          requestBytes += response.bytes;
          const bitmap = await createImageBitmap(response.blob);
          if (bitmap.width !== source.tileSize || bitmap.height !== source.tileSize) {
            bitmap.close();
            throw new Error(`Unexpected ${source.datasetId} tile dimensions`);
          }
          decoded.push({ x: job.x, y: job.y, bitmap });
        }
      });
      const workerResults = await Promise.allSettled(workers);
      const rejectedWorker = workerResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejectedWorker) throw rejectedWorker.reason;
      if (signal.aborted || generation !== this.generation || this.disposed) return;
      const canvas = document.createElement('canvas');
      canvas.width = source.tileSize * selection.gridWidth;
      canvas.height = source.tileSize * selection.gridHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Planet detail atlas requires a 2D context');
      for (const item of decoded) context.drawImage(item.bitmap, item.x * source.tileSize, item.y * source.tileSize);
      const decodedBytes = canvas.width * canvas.height * 4;
      const bytes = decodedBytes * 4 / 3;
      if (bytes > this.budget.gpuBytes || decodedBytes > this.budget.decodedCpuBytes) throw new Error('Planet detail atlas exceeds tier budget');
      if (bytes + this.textureBytes(this.atlas) > this.budget.gpuBytes) throw new Error('Planet detail transition exceeds tier GPU budget');
      const transform = source.datasetId === 'nasa-moontrek-wac-303ppd-v02'
        ? detailColorTransform(source.datasetId, context.getImageData(0, 0, canvas.width, canvas.height).data)
        : detailColorTransform(source.datasetId, new Uint8ClampedArray());
      const previous = this.atlas;
      this.previousAtlas?.dispose();
      this.previousAtlas = previous;
      this.atlas = new THREE.CanvasTexture(canvas);
      this.atlas.colorSpace = THREE.SRGBColorSpace;
      // Source atlases are assembled in image order (north/top at row zero),
      // while bodyFixedUv also assigns north to v=0. Canvas uploads therefore
      // need Three's vertical flip. Disabling it reverses every source row and
      // makes otherwise adjacent WMTS pages meet unrelated neighbours.
      this.atlas.flipY = true;
      this.atlas.wrapS = THREE.ClampToEdgeWrapping;
      this.atlas.wrapT = THREE.ClampToEdgeWrapping;
      this.atlas.minFilter = THREE.LinearMipmapLinearFilter;
      this.atlas.magFilter = THREE.LinearFilter;
      this.atlas.anisotropy = 4;
      this.atlas.needsUpdate = true;
      for (const state of this.states) {
        state.previousAtlas.value = previous;
        state.previousMatrixSize.value.copy(state.matrixSize.value);
        state.previousAtlasStart.value.copy(state.atlasStart.value);
        state.previousAtlasGrid.value.copy(state.atlasGrid.value);
        state.previousColorScale.value.copy(state.colorScale.value);
        state.previousColorBias.value.copy(state.colorBias.value);
        state.previousOpacity.value = previous ? 1 : 0;
        state.atlas.value = this.atlas;
        state.matrixSize.value.set(matrix.width, matrix.height);
        state.atlasStart.value.set(selection.startColumn, selection.startRow);
        state.atlasGrid.value.set(selection.gridWidth, selection.gridHeight);
        state.colorScale.value.fromArray(transform.scale);
        state.colorBias.value.fromArray(transform.bias);
        state.opacity.value = 0;
        state.enabled.value = 1;
      }
      this.currentState = Object.freeze({ state: 'crossfading', level: selection.level, pages: decoded.length, gpuBytes: this.atlasBytes(), requestBytes, generation, datasetId: source.datasetId });
      this.diagnostics?.record({ subsystem: 'assets', event: 'planet-detail-ready', severity: 'state', data: {
        body: this.bodyId, dataset: source.datasetId, level: selection.level, pages: decoded.length, gpuBytes: bytes, requestBytes,
      } }, { bodyId: this.bodyId });
    } catch (error) {
      if (!signal.aborted) {
        this.suppressedSources.add(source.datasetId);
        this.signature = '';
        if (!this.atlas) this.setEnabled(false);
        this.currentState = Object.freeze({ state: 'failed', level: selection.level, pages: 0, gpuBytes: this.atlasBytes(), requestBytes, generation, datasetId: source.datasetId, fallbackReason: String(error) });
      }
    } finally {
      for (const item of decoded) item.bitmap.close();
    }
  }

  private setEnabled(enabled: boolean): void { for (const state of this.states) state.enabled.value = enabled ? 1 : 0; }
  private suspend(reason: string): void {
    // Invalidate an in-flight request so it cannot re-enable a detail atlas a
    // frame after the camera has returned to a parent-only presentation.
    if (this.signature) {
      this.signature = '';
      this.abort.abort();
      this.abort = new AbortController();
    }
    this.releasePreviousAtlas();
    for (const state of this.states) state.opacity.value = this.atlas ? 1 : 0;
    this.disable(reason);
  }
  private disable(reason: string): void {
    this.setEnabled(false);
    this.currentState = Object.freeze({ state: 'disabled', level: 0, pages: 0, gpuBytes: this.atlasBytes(), requestBytes: 0, generation: this.generation, fallbackReason: reason });
  }
  private releasePreviousAtlas(): void {
    this.previousAtlas?.dispose();
    this.previousAtlas = null;
    for (const state of this.states) {
      state.previousAtlas.value = null;
      state.previousOpacity.value = 0;
    }
  }
  private textureBytes(texture: THREE.CanvasTexture | null): number {
    return texture ? texture.image.width * texture.image.height * 4 * 4 / 3 : 0;
  }
  private atlasBytes(): number { return this.textureBytes(this.atlas) + this.textureBytes(this.previousAtlas); }
  stats(): Readonly<CompactDetailStats> { return this.currentState; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.releasePreviousAtlas();
    this.atlas?.dispose();
    this.atlas = null;
    for (const state of this.states) {
      state.enabled.value = 0;
      state.atlas.value = null;
      state.opacity.value = 0;
    }
  }
}
