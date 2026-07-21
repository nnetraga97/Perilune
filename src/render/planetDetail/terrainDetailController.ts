import * as THREE from 'three';
import type { BodyRenderFrame, QualityTier } from '../bodyRenderer';
import type { RenderDiagnosticsPort } from '../renderDiagnostics';
import {
  CUBE_FACE_BASES,
  terrainTileAtDirection,
  terrainTileKey,
  terrainTileUvBounds,
  type TerrainTileId,
} from '../terrain/tile';
import { directionForCubeFace, type NumericHeightAtlas } from './cubePageReprojector';
import { PlanetDetailSessionBudget, planetDetailBudget } from './detailBudget';
import { handleDetailWorkerRequest, type DetailWorkerRequest, type DetailWorkerResponse } from './detailWorker';
import { selectEquirectPages, type EquirectPageSelection } from './equirectPageTable';
import { kscNavd88ToEgm2008Correction } from './heightDatum';
import { planetHeightDetailSource, type HeightImageAddress } from './heightSourceAdapter';
import { decodeFloat32Tiff } from './numericTiff';
import { PersistentPlanetTileCache } from './persistentTileCache';
import { planetVisualDetailSource, planetVisualDetailSourceForView } from './sourceRegistry';
import type { DetailTileAddress, PlanetDetailSourceAdapter } from './sourceAdapter';
import {
  TERRAIN_DETAIL_ATLAS_GRID,
  TERRAIN_DETAIL_PAGE_SLOTS,
  terrainDetailState,
  type TerrainDetailMaterialState,
} from './terrainDetailMaterial';
import { requestPlanetTile, type PlanetTileResponse } from './tileRequest';
import { detailColorTransform } from './detailColorTransform';

export interface TerrainDetailStats {
  readonly state: 'disabled' | 'resident-parent' | 'requesting' | 'reprojecting' | 'crossfading' | 'ready' | 'failed';
  readonly datasetId?: string;
  readonly numericDatasetId?: string;
  readonly numericDatum?: string;
  readonly heightMode: 'resident' | 'shading-only';
  readonly sourceLevel: number;
  readonly tileKey?: string;
  readonly tileKeys: readonly string[];
  readonly pages: number;
  readonly sourcePages: number;
  readonly normalPages: number;
  readonly gpuBytes: number;
  readonly decodedCpuBytes: number;
  readonly persistentBytes: number;
  readonly requestBytes: number;
  readonly requestCount: number;
  readonly cacheHits: Readonly<{ memory: number; persistent: number; network: number }>;
  readonly sourceCellMeters?: number;
  readonly heightRangeMeters?: readonly [number, number];
  readonly timingsMs: Readonly<{ fetch: number; decode: number; reproject: number; upload: number }>;
  readonly generation: number;
  readonly fallbackReason?: string;
}

interface LoadedHeightAtlas {
  readonly atlas: NumericHeightAtlas;
  readonly response: PlanetTileResponse;
  readonly address: HeightImageAddress;
}

const EMPTY_TIMINGS = Object.freeze({ fetch: 0, decode: 0, reproject: 0, upload: 0 });
const EMPTY_HITS = Object.freeze({ memory: 0, persistent: 0, network: 0 });

function centerDirection(tile: Readonly<TerrainTileId>): Readonly<{ x: number; y: number; z: number }> {
  const bounds = terrainTileUvBounds(tile);
  const direction = directionForCubeFace(tile.face, bounds.u0 + bounds.size * 0.5, bounds.v0 + bounds.size * 0.5);
  return Object.freeze({ x: direction[0], y: direction[1], z: direction[2] });
}

function directionDot(left: Readonly<{ x: number; y: number; z: number }>, right: Readonly<{ x: number; y: number; z: number }>): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

export function selectTerrainVisualPages(
  demandedTiles: readonly Readonly<TerrainTileId>[],
  cameraDirection: Readonly<{ x: number; y: number; z: number }>,
  predictionDirection: Readonly<{ x: number; y: number; z: number }>,
  visualDepth: number,
  maximumPages = TERRAIN_DETAIL_PAGE_SLOTS,
): readonly TerrainTileId[] {
  const result: TerrainTileId[] = [];
  const seen = new Set<string>();
  const add = (tile: TerrainTileId): void => {
    const key = terrainTileKey(tile);
    if (!seen.has(key) && result.length < maximumPages) { seen.add(key); result.push(tile); }
  };
  // Coverage parent first: the page containing the camera/focus point.
  add(terrainTileAtDirection(cameraDirection, visualDepth));
  // Visible refinement next: selected geometric leaves projected into the
  // independent visual quadtree, nearest to the camera direction first.
  [...demandedTiles]
    .map(centerDirection)
    .sort((left, right) => directionDot(right, cameraDirection) - directionDot(left, cameraDirection))
    .forEach((direction) => add(terrainTileAtDirection(direction, visualDepth)));
  // Prediction last and strictly bounded by the same fixed page slot count.
  add(terrainTileAtDirection(predictionDirection, visualDepth));
  return Object.freeze(result);
}

export function geographicBoundsForTerrainTile(
  tile: Readonly<TerrainTileId>,
  gutterFraction = 2 / 256,
): readonly [number, number, number, number] {
  const bounds = terrainTileUvBounds(tile);
  const center = centerDirection(tile);
  const centerLongitude = Math.atan2(center.y, center.x) * 180 / Math.PI;
  const longitudes: number[] = [];
  const latitudes: number[] = [];
  for (const y of [-gutterFraction, 0.5, 1 + gutterFraction]) {
    for (const x of [-gutterFraction, 0.5, 1 + gutterFraction]) {
      const direction = directionForCubeFace(tile.face, bounds.u0 + bounds.size * x, bounds.v0 + bounds.size * y);
      let longitude = Math.atan2(direction[1], direction[0]) * 180 / Math.PI;
      while (longitude - centerLongitude > 180) longitude -= 360;
      while (longitude - centerLongitude < -180) longitude += 360;
      longitudes.push(longitude);
      latitudes.push(Math.asin(Math.max(-1, Math.min(1, direction[2]))) * 180 / Math.PI);
    }
  }
  return Object.freeze([
    Math.min(...longitudes), Math.min(...latitudes), Math.max(...longitudes), Math.max(...latitudes),
  ]);
}

async function reprojectInWorker(request: DetailWorkerRequest, signal: AbortSignal): Promise<DetailWorkerResponse> {
  if (typeof Worker === 'undefined') return handleDetailWorkerRequest(request);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./detailWorker.ts', import.meta.url), { type: 'module' });
    const finish = (): void => worker.terminate();
    const abort = (): void => { finish(); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => { signal.removeEventListener('abort', abort); finish(); reject(new Error('Planet detail worker failed')); };
    worker.onmessage = (event: MessageEvent<DetailWorkerResponse>) => {
      signal.removeEventListener('abort', abort);
      finish();
      resolve(event.data);
    };
    const transfers: Transferable[] = [request.atlas.pixels.buffer as ArrayBuffer];
    for (const page of request.pages) if (page.heightAtlas) transfers.push(page.heightAtlas.values.buffer as ArrayBuffer);
    worker.postMessage(request, transfers);
  });
}

function intersectsCoverage(
  bounds: readonly [number, number, number, number],
  coverage: readonly [number, number, number, number],
): boolean {
  return bounds[0] >= coverage[0] && bounds[2] <= coverage[2]
    && bounds[1] >= coverage[1] && bounds[3] <= coverage[3];
}

function incrementCacheHit(hits: { memory: number; persistent: number; network: number }, cache: PlanetTileResponse['cache']): void {
  hits[cache]++;
}

export class TerrainDetailController {
  private static readonly CROSSFADE_SECONDS = 0.35;
  private readonly budget;
  private readonly state: TerrainDetailMaterialState | null;
  private source: PlanetDetailSourceAdapter | null;
  private persistent: PersistentPlanetTileCache | null;
  private readonly suppressedSources = new Set<string>();
  private abort = new AbortController();
  private signature = '';
  private textures: THREE.DataTexture[] = [];
  private normalTextures: THREE.DataTexture[] = [];
  private generation = 0;
  private disposed = false;
  private current: TerrainDetailStats = Object.freeze({
    state: 'resident-parent', sourceLevel: 0, tileKeys: Object.freeze([]), pages: 0, sourcePages: 0,
    normalPages: 0, gpuBytes: 0, decodedCpuBytes: 0, persistentBytes: 0, requestBytes: 0,
    requestCount: 0, cacheHits: EMPTY_HITS, timingsMs: EMPTY_TIMINGS, generation: 0, heightMode: 'resident',
  });

  constructor(
    private readonly bodyId: string,
    private readonly bodyRadius: number,
    tier: QualityTier,
    material: THREE.Material,
    private readonly demandedTiles: () => readonly TerrainTileId[],
    private readonly diagnostics?: RenderDiagnosticsPort,
    private readonly sessionBudget = new PlanetDetailSessionBudget(planetDetailBudget(tier)),
  ) {
    this.budget = planetDetailBudget(tier);
    this.state = terrainDetailState(material);
    if (this.state) this.state.normalStrength.value = tier === 'high' ? 0.82 : 0.68;
    this.source = planetVisualDetailSource(bodyId);
    this.persistent = this.source && this.budget.enabled
      ? new PersistentPlanetTileCache(`terrain-${this.source.generation}`, Math.floor(this.budget.persistentBytes / 2))
      : null;
    if (!this.source || !this.state || !this.budget.enabled) this.disable('quality-material-or-source-disabled');
  }

  update(frame: Readonly<BodyRenderFrame>): void {
    if (this.disposed || !this.state || !this.budget.enabled) return;
    if (this.current.state === 'crossfading') {
      this.state.opacity.value = Math.min(1, this.state.opacity.value + frame.deltaSeconds / TerrainDetailController.CROSSFADE_SECONDS);
      if (this.state.opacity.value >= 1) this.current = Object.freeze({ ...this.current, state: 'ready' });
    }
    const distance = Math.hypot(frame.cameraBodyFixed.x, frame.cameraBodyFixed.y, frame.cameraBodyFixed.z);
    if (!(distance > this.bodyRadius)) return this.disable('camera-inside-body');
    const altitude = Math.max(1, distance - this.bodyRadius);
    const metersPerPixel = 2 * altitude * Math.tan(frame.verticalFovRadians * 0.5) / Math.max(1, frame.drawingBufferHeight);
    const nextSource = planetVisualDetailSourceForView(this.bodyId, frame.cameraBodyFixed, metersPerPixel, this.suppressedSources);
    if (nextSource?.datasetId !== this.source?.datasetId) {
      this.source = nextSource;
      this.persistent = nextSource
        ? new PersistentPlanetTileCache(`terrain-${nextSource.generation}`, Math.floor(this.budget.persistentBytes / 2))
        : null;
      this.signature = '';
    }
    if (!this.source) return this.disable('no-source-fallback');
    const demand = this.demandedTiles();
    if (demand.length === 0) return this.disable('no-terrain-demand');
    const latitude = Math.asin(Math.max(-1, Math.min(1, frame.cameraBodyFixed.z / distance)));
    const level = this.source.levelForProjectedFootprint(this.bodyRadius, latitude, metersPerPixel);
    const selection = selectEquirectPages(this.source, level, frame.cameraBodyFixed);
    if (!selection || level < 3) return this.disable('resident-parent-is-sufficient');
    const matrix = this.source.matrix(level);
    const visualDepth = Math.max(0, Math.min(30, Math.ceil(Math.log2(matrix.width / 4)) - 1));
    const prediction = {
      x: frame.cameraBodyFixed.x + frame.cameraBodyFixedVelocity.x * 2,
      y: frame.cameraBodyFixed.y + frame.cameraBodyFixedVelocity.y * 2,
      z: frame.cameraBodyFixed.z + frame.cameraBodyFixedVelocity.z * 2,
    };
    const tiles = selectTerrainVisualPages(demand, frame.cameraBodyFixed, prediction, visualDepth);
    const tileKeys = tiles.map(terrainTileKey);
    const signature = `${selection.signature}/${tileKeys.join('|')}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.current = Object.freeze({
      state: 'requesting', datasetId: this.source.datasetId, sourceLevel: level,
      tileKey: tileKeys[0], tileKeys: Object.freeze(tileKeys), pages: 0, sourcePages: 0, normalPages: 0,
      gpuBytes: this.gpuBytes(), decodedCpuBytes: 0, persistentBytes: this.persistent?.stats().bytes ?? 0,
      requestBytes: 0, requestCount: 0, cacheHits: EMPTY_HITS, timingsMs: EMPTY_TIMINGS,
      generation: this.generation, heightMode: 'resident',
    });
    void this.load(this.source, selection, tiles, this.generation, this.abort.signal);
  }

  private async load(
    source: PlanetDetailSourceAdapter,
    selection: EquirectPageSelection,
    tiles: readonly TerrainTileId[],
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const state = this.state;
    if (!state) return;
    const jobs: Array<{ x: number; y: number; address: DetailTileAddress }> = [];
    for (let y = 0; y < selection.gridHeight; y++) for (let x = 0; x < selection.gridWidth; x++) {
      jobs.push({ x, y, address: source.address(selection.level, selection.startRow + y, selection.startColumn + x) });
    }
    const decoded: Array<{ x: number; y: number; bitmap: ImageBitmap }> = [];
    let next = 0;
    let requestBytes = 0;
    let requestCount = 0;
    let decodedCpuBytes = 0;
    const cacheHits = { memory: 0, persistent: 0, network: 0 };
    const timings = { fetch: 0, decode: 0, reproject: 0, upload: 0 };
    let numericFallback: string | undefined;
    const heightSource = planetHeightDetailSource(this.bodyId);
    const heightTiles = heightSource && (this.bodyId === 'moon' || source.datasetId === 'usda-naip-ksc-2025-29992')
      ? tiles.filter((tile) => intersectsCoverage(geographicBoundsForTerrainTile(tile), heightSource.coverage))
        .slice(0, this.budget.maximumNumericRequestsPerGeneration)
      : [];
    try {
      if (jobs.length > this.budget.maximumVisualRequestsPerGeneration) throw new Error('Terrain visual-detail request budget exceeded');
      if (jobs.length + heightTiles.length > this.budget.maximumRequestsPerGeneration) {
        throw new Error('Terrain numeric-detail request budget exceeded');
      }
      const fetchStarted = performance.now();
      const workers = Array.from({ length: Math.min(this.budget.concurrentRequests, jobs.length) }, async () => {
        for (;;) {
          const job = jobs[next++];
          if (!job) return;
          const response = await requestPlanetTile(job.address, signal, this.persistent ?? undefined, this.sessionBudget);
          requestBytes += response.bytes;
          requestCount++;
          incrementCacheHit(cacheHits, response.cache);
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
      timings.fetch += performance.now() - fetchStarted;
      if (signal.aborted || generation !== this.generation || this.disposed) return;
      const decodeStarted = performance.now();
      const canvas = document.createElement('canvas');
      canvas.width = source.tileSize * selection.gridWidth;
      canvas.height = source.tileSize * selection.gridHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Terrain detail reprojection requires a 2D context');
      for (const item of decoded) context.drawImage(item.bitmap, item.x * source.tileSize, item.y * source.tileSize);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      decodedCpuBytes += image.data.byteLength;
      const colorTransform = detailColorTransform(source.datasetId, image.data);
      timings.decode += performance.now() - decodeStarted;

      const heightAtlases = new Map<string, LoadedHeightAtlas>();
      if (heightSource) {
        for (const tile of heightTiles) {
          const bounds = geographicBoundsForTerrainTile(tile);
          try {
            const started = performance.now();
            const address = heightSource.request(bounds, 258, 258);
            const response = await requestPlanetTile(address, signal, this.persistent ?? undefined, this.sessionBudget);
            timings.fetch += performance.now() - started;
            requestBytes += response.bytes;
            requestCount++;
            incrementCacheHit(cacheHits, response.cache);
            const tiffStarted = performance.now();
            const decodedTiff = decodeFloat32Tiff(await response.blob.arrayBuffer(), 258 * 258);
            if (decodedTiff.width !== address.width || decodedTiff.height !== address.height) throw new Error('Numeric height dimensions changed');
            const values = decodedTiff.values;
            for (let index = 0; index < values.length; index++) {
              if (!Number.isFinite(values[index]) || Math.abs(values[index]) > 10_000_000) { values[index] = Number.NaN; continue; }
              if (this.bodyId === 'earth') {
                const x = index % decodedTiff.width;
                const y = Math.floor(index / decodedTiff.width);
                const longitude = bounds[0] + x / Math.max(1, decodedTiff.width - 1) * (bounds[2] - bounds[0]);
                const latitude = bounds[3] - y / Math.max(1, decodedTiff.height - 1) * (bounds[3] - bounds[1]);
                values[index] += kscNavd88ToEgm2008Correction(longitude, latitude);
              }
            }
            decodedCpuBytes += values.byteLength;
            timings.decode += performance.now() - tiffStarted;
            heightAtlases.set(terrainTileKey(tile), {
              atlas: { values, width: decodedTiff.width, height: decodedTiff.height, boundsDegrees: bounds },
              response,
              address,
            });
          } catch (error) {
            if (signal.aborted) throw error;
            numericFallback = `numeric-shading-fallback: ${String(error)}`;
          }
        }
      }
      if (decodedCpuBytes > this.budget.decodedCpuBytes) throw new Error('Terrain detail decode budget exceeded');
      this.current = Object.freeze({
        ...this.current, state: 'reprojecting', sourcePages: decoded.length, requestBytes, requestCount,
        decodedCpuBytes, cacheHits: Object.freeze({ ...cacheHits }), timingsMs: Object.freeze({ ...timings }),
      });
      const matrix = source.matrix(selection.level);
      const reprojectStarted = performance.now();
      const result = await reprojectInWorker({
        generation,
        bodyRadius: this.bodyRadius,
        pages: tiles.map((tile) => ({ tile, heightAtlas: heightAtlases.get(terrainTileKey(tile))?.atlas })),
        pageSize: 256,
        gutter: 2,
        atlas: {
          pixels: image.data, width: image.width, height: image.height,
          matrixWidth: matrix.width, matrixHeight: matrix.height,
          startColumn: selection.startColumn, startRow: selection.startRow,
          gridWidth: selection.gridWidth, gridHeight: selection.gridHeight,
        },
      }, signal);
      timings.reproject = performance.now() - reprojectStarted;
      if (signal.aborted || result.generation !== this.generation || this.disposed) return;

      const uploadStarted = performance.now();
      const pageWidth = result.pages[0]?.width ?? 0;
      const pageHeight = result.pages[0]?.height ?? 0;
      if (pageWidth <= 0 || pageHeight <= 0) throw new Error('Terrain detail worker returned no complete pages');
      const atlasWidth = pageWidth * TERRAIN_DETAIL_ATLAS_GRID;
      const atlasHeight = pageHeight * TERRAIN_DETAIL_ATLAS_GRID;
      const colorAtlasPixels = new Uint8Array(atlasWidth * atlasHeight * 4);
      const normalAtlasPixels = new Uint8Array(atlasWidth * atlasHeight * 4);
      const copyIntoAtlas = (sourcePixels: Uint8Array | Uint8ClampedArray, slotIndex: number, target: Uint8Array): void => {
        const slotX = slotIndex % TERRAIN_DETAIL_ATLAS_GRID;
        const slotY = Math.floor(slotIndex / TERRAIN_DETAIL_ATLAS_GRID);
        for (let row = 0; row < pageHeight; row++) {
          const sourceOffset = row * pageWidth * 4;
          const targetOffset = ((slotY * pageHeight + row) * atlasWidth + slotX * pageWidth) * 4;
          target.set(sourcePixels.subarray(sourceOffset, sourceOffset + pageWidth * 4), targetOffset);
        }
      };
      let normalPages = 0;
      let sourceCellMeters = 0;
      let minimumHeight = Number.POSITIVE_INFINITY;
      let maximumHeight = Number.NEGATIVE_INFINITY;
      result.pages.forEach((page, index) => {
        copyIntoAtlas(page.pixels, index, colorAtlasPixels);
        let hasNormal = false;
        if (page.normalPixels && (page.normalValidFraction ?? 0) > 0) {
          copyIntoAtlas(page.normalPixels, index, normalAtlasPixels);
          hasNormal = true;
          normalPages++;
          sourceCellMeters = Math.max(sourceCellMeters, page.sourceCellMeters ?? 0);
          minimumHeight = Math.min(minimumHeight, page.minimumHeightMeters ?? minimumHeight);
          maximumHeight = Math.max(maximumHeight, page.maximumHeightMeters ?? maximumHeight);
        }
        const slot = state.slots[index];
        const bounds = terrainTileUvBounds(page.tile);
        slot.normalEnabled.value = hasNormal ? 1 : 0;
        slot.face.value = page.tile.face;
        slot.bounds.value.set(bounds.u0, bounds.v0, bounds.size);
        slot.gutterScaleBias.value.set(page.pageSize / page.width, page.gutter / page.width);
        slot.colorScale.value.fromArray(colorTransform.scale);
        slot.colorBias.value.fromArray(colorTransform.bias);
      });
      for (let index = result.pages.length; index < state.slots.length; index++) {
        state.slots[index].normalEnabled.value = 0;
      }
      const colorTexture = new THREE.DataTexture(
        colorAtlasPixels, atlasWidth, atlasHeight, THREE.RGBAFormat, THREE.UnsignedByteType,
      );
      colorTexture.colorSpace = THREE.SRGBColorSpace;
      colorTexture.wrapS = colorTexture.wrapT = THREE.ClampToEdgeWrapping;
      colorTexture.minFilter = THREE.LinearMipmapLinearFilter;
      colorTexture.magFilter = THREE.LinearFilter;
      colorTexture.generateMipmaps = true;
      colorTexture.needsUpdate = true;
      const normalTexture = normalPages > 0
        ? new THREE.DataTexture(normalAtlasPixels, atlasWidth, atlasHeight, THREE.RGBAFormat, THREE.UnsignedByteType)
        : null;
      if (normalTexture) {
        normalTexture.colorSpace = THREE.NoColorSpace;
        normalTexture.wrapS = normalTexture.wrapT = THREE.ClampToEdgeWrapping;
        normalTexture.minFilter = THREE.LinearMipmapLinearFilter;
        normalTexture.magFilter = THREE.LinearFilter;
        normalTexture.generateMipmaps = true;
        normalTexture.needsUpdate = true;
      }
      const nextTextures = [colorTexture];
      const nextNormalTextures = normalTexture ? [normalTexture] : [];
      const gpuBytes = atlasWidth * atlasHeight * 4 * 4 / 3 * (normalTexture ? 2 : 1);
      if (gpuBytes > this.budget.gpuBytes) {
        colorTexture.dispose();
        normalTexture?.dispose();
        throw new Error('Terrain detail GPU budget exceeded');
      }
      // All requested visual pages are installed in one material-state commit.
      state.pageAtlas.value = colorTexture;
      state.normalAtlas.value = normalTexture;
      state.pageCount.value = result.pages.length;
      state.opacity.value = 0;
      state.enabled.value = 1;
      const previousTextures = this.textures;
      const previousNormals = this.normalTextures;
      this.textures = nextTextures;
      this.normalTextures = nextNormalTextures;
      previousTextures.forEach((texture) => texture.dispose());
      previousNormals.forEach((texture) => texture.dispose());
      timings.upload = performance.now() - uploadStarted;
      const heightRangeMeters = Number.isFinite(minimumHeight) && Number.isFinite(maximumHeight)
        ? Object.freeze([minimumHeight, maximumHeight] as const)
        : undefined;
      this.current = Object.freeze({
        state: 'crossfading', datasetId: source.datasetId,
        numericDatasetId: normalPages > 0 ? heightSource?.datasetId : undefined,
        numericDatum: normalPages > 0 ? heightSource?.engineDatum : undefined,
        heightMode: normalPages > 0 ? 'shading-only' : 'resident',
        sourceLevel: selection.level, tileKey: terrainTileKey(tiles[0]),
        tileKeys: Object.freeze(tiles.map(terrainTileKey)), pages: result.pages.length,
        sourcePages: decoded.length, normalPages, gpuBytes, decodedCpuBytes,
        persistentBytes: this.persistent?.stats().bytes ?? 0, requestBytes, requestCount,
        cacheHits: Object.freeze({ ...cacheHits }), sourceCellMeters: sourceCellMeters || undefined,
        heightRangeMeters, timingsMs: Object.freeze({ ...timings }), generation,
        fallbackReason: numericFallback,
      });
      this.diagnostics?.record({ subsystem: 'assets', event: 'terrain-detail-ready', severity: 'state', data: {
        body: this.bodyId, dataset: source.datasetId, numericDataset: heightSource?.datasetId ?? 'none',
        sourceLevel: selection.level, tiles: tiles.map(terrainTileKey).join(','), sourcePages: decoded.length,
        visualPages: result.pages.length, normalPages, gpuBytes, decodedCpuBytes, requestBytes,
        requestCount, cacheHits: JSON.stringify(cacheHits), timings: JSON.stringify(timings),
        heightMode: normalPages > 0 ? 'shading-only' : 'resident',
      } }, { bodyId: this.bodyId });
    } catch (error) {
      if (!signal.aborted) {
        this.suppressedSources.add(source.datasetId);
        this.signature = '';
        if (this.textures.length === 0) state.enabled.value = 0;
        this.current = Object.freeze({
          ...this.current, state: 'failed', sourcePages: 0, pages: this.textures.length,
          normalPages: this.normalTextures.length, gpuBytes: this.gpuBytes(), decodedCpuBytes,
          persistentBytes: this.persistent?.stats().bytes ?? 0, requestBytes, requestCount,
          cacheHits: Object.freeze({ ...cacheHits }), timingsMs: Object.freeze({ ...timings }),
          generation, fallbackReason: String(error),
        });
      }
    } finally {
      for (const item of decoded) item.bitmap.close();
    }
  }

  private gpuBytes(): number {
    return [...this.textures, ...this.normalTextures]
      .reduce((sum, texture) => sum + texture.image.width * texture.image.height * 4 * 4 / 3, 0);
  }

  private disable(reason: string): void {
    if (this.state) this.state.enabled.value = 0;
    this.current = Object.freeze({
      ...this.current, state: 'disabled', sourceLevel: 0, pages: this.textures.length,
      normalPages: this.normalTextures.length, gpuBytes: this.gpuBytes(), generation: this.generation,
      fallbackReason: reason,
    });
  }

  stats(): Readonly<TerrainDetailStats> { return this.current; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.textures.forEach((texture) => texture.dispose());
    this.normalTextures.forEach((texture) => texture.dispose());
    this.textures = [];
    this.normalTextures = [];
    if (this.state) {
      this.state.enabled.value = 0;
      this.state.pageCount.value = 0;
      this.state.pageAtlas.value = null;
      this.state.normalAtlas.value = null;
      for (const slot of this.state.slots) {
        slot.normalEnabled.value = 0;
      }
    }
  }
}
