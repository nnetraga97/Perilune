import * as THREE from 'three';
import { Vec3 } from '../core/vec3';
import { BODY_VISUALS, type BodyId } from '../content/bodyVisuals';
import type { Body } from '../sim/universe';
import { naturalContactSurface } from '../sim/terrain';
import { recipeForBody } from '../sim/terrainRecipe';
import {
  planetDataAuthorityForBody,
  type FrozenPlanetDataAuthority,
} from '../sim/planetDataAuthority';
import type { BodyMaterialDescriptor } from './bodyMaterial';
import type {
  BodyRenderer,
  BodyRendererStats,
  BodyRenderFrame,
  QualityTier,
  RuntimeBodyAssetPack,
} from './bodyRenderer';
import type { RenderCaps } from './context';
import { CoverageTransition } from './coverageTransition';
import { PLANET_QUALITY, PlanetRenderer } from './planet';
import { createAirlessGlobalMaterial } from './airless/globalMaterial';
import { createAirlessSurfaceMaterial } from './airless/surfaceMaterial';
import { createGlobalSphereGeometry } from './terrestrial/globalGeometry';
import { TerrainChunkWorkerPool } from './terrain/chunkWorkerPool';
import { terrainPresentationBand } from './terrainPresentation';
import type { RenderDiagnosticsPort } from './renderDiagnostics';
import { sampleSourceMacroHeight, sourceHeightCacheBytes } from '../sim/sourceHeightAuthority';
import { localShadowPolicy } from './lightingPolicy';
import {
  DEFAULT_TERRAIN_GEOMETRY_BUDGET,
  terrainGeometryAllocation,
} from './resourceAccounting';
import {
  createRecipeSurfaceSampler,
  scatterProfileByName,
  scatterStreamCeiling,
  TerrestrialScatter,
} from './terrestrial/scatter';
import type { FlightAerialPerspectiveController } from './flightAerialPerspective';
import { CompactDetailController } from './planetDetail/compactDetailController';
import { PlanetDetailSessionBudget, planetDetailBudget } from './planetDetail/detailBudget';
import { TerrainDetailController } from './planetDetail/terrainDetailController';

export class AirlessBodyRenderer implements BodyRenderer {
  readonly bodyId: string;
  readonly kind = 'airless' as const;
  readonly root = new THREE.Group();
  readonly terrainAuthorityGeneration: string;
  readonly terrainGeneration: number;
  private readonly transition = new CoverageTransition();
  private readonly workerPool = typeof Worker === 'undefined' ? undefined : new TerrainChunkWorkerPool();
  private compact!: THREE.Mesh<THREE.SphereGeometry, THREE.Material>;
  private terrain!: PlanetRenderer;
  private scatter: TerrestrialScatter | null = null;
  private detail: CompactDetailController | null = null;
  private terrainDetail: TerrainDetailController | null = null;
  private detailSessionBudget: PlanetDetailSessionBudget | null = null;
  private disposed = false;
  private initialized = false;
  private terrainActive = false;
  private coverageProgress = 0;
  private readonly anchorDirection = new Vec3();
  private stagedAssetBytes = 0;
  private lastAngularRadius = 0;
  private scatterVisible = false;
  private terrainAllocationBytes = 0;

  constructor(
    private readonly body: Body,
    private readonly descriptor: Readonly<BodyMaterialDescriptor>,
    private readonly caps: Readonly<RenderCaps>,
    readonly quality: QualityTier,
    private readonly diagnostics?: RenderDiagnosticsPort,
    private readonly flightAerial?: FlightAerialPerspectiveController,
    private readonly authority: Readonly<FrozenPlanetDataAuthority> = planetDataAuthorityForBody(body),
  ) {
    if (body.def.surfaceKind !== 'solid' || body.def.atmosphere) {
      throw new Error(`${body.id} airless renderer requires an atmosphere-free solid body`);
    }
    this.bodyId = body.id;
    const frozenAuthority = this.authority;
    if (frozenAuthority.bodyId !== body.id) {
      throw new Error(`${body.id} airless renderer requires its frozen terrain authority`);
    }
    this.terrainAuthorityGeneration = frozenAuthority.generation;
    this.terrainGeneration = frozenAuthority.terrainGeneration;
    this.root.name = `airless-renderer:${body.id}`;
    this.buildStack(null);
  }

  get ready(): boolean { return this.initialized && !this.disposed; }

  stageAssets(pack: Readonly<RuntimeBodyAssetPack> | null): void {
    if (this.disposed) throw new Error(`${this.bodyId} airless renderer is disposed`);
    if (pack && (pack.bodyId !== this.bodyId || pack.tier !== this.quality)) {
      throw new Error(`Cannot stage ${pack.bodyId}/${pack.tier} for ${this.bodyId}/${this.quality}`);
    }
    if (pack) {
      const requiredChannels = this.bodyId === 'moon'
        ? ['albedo', 'normal', 'material', 'heightMacro', 'localDetail']
        : ['albedo', 'normal', 'material'];
      for (const channel of requiredChannels) {
        if (!pack.textures.has(channel)) throw new Error(`${pack.bodyId}/${pack.tier} is missing required ${channel} texture`);
      }
    }
    this.releaseStack();
    this.buildStack(pack);
  }

  private buildStack(pack: Readonly<RuntimeBodyAssetPack> | null): void {
    const terrainRecipe = recipeForBody(this.body, this.authority);
    this.stagedAssetBytes = pack?.gpuBytes ?? 0;
    const compactGeometry = createGlobalSphereGeometry(this.quality);
    const compactMaterial = pack
      ? createAirlessGlobalMaterial(pack, this.caps.maxAnisotropy, this.body.radius)
      : new THREE.MeshStandardMaterial({ color: this.descriptor.albedo.mid, roughness: 1, metalness: 0 });
    this.compact = new THREE.Mesh(compactGeometry, compactMaterial);
    this.compact.name = `airless-compact:${this.bodyId}`;
    this.compact.scale.setScalar(this.body.radius);

    const scatterProfileName = BODY_VISUALS[this.body.id as BodyId]?.scatterProfile;
    this.scatter = scatterProfileName
      ? new TerrestrialScatter(
        this.body.radius,
        this.body.def.terrain.seed,
        createRecipeSurfaceSampler(terrainRecipe),
        this.quality,
        scatterProfileByName(scatterProfileName),
      )
      : null;
    this.scatter?.setShadows(this.quality !== 'low');
    const scatterBytes = this.scatter?.stats().bufferBytes ?? 0;
    const allocation = terrainGeometryAllocation({
      // Planet packs are admitted and charged by RendererResourceLedger. Keep
      // the proven terrain pool separate and charge renderer-owned scatter
      // directly against the geometry reservation it competes with.
      activeBodyBudgetBytes: DEFAULT_TERRAIN_GEOMETRY_BUDGET,
      committedTextureBytes: 0,
      fixedPassBytes: planetDetailBudget(this.quality).activeGpuBytes,
      scatterBytes,
      effectBytes: 0,
    });
    this.terrainAllocationBytes = allocation.allocationBytes;

    const terrainMaterial = createAirlessSurfaceMaterial(
      pack,
      this.descriptor,
      this.quality,
      this.caps.maxAnisotropy,
    );
    const detailSessionBudget = new PlanetDetailSessionBudget(planetDetailBudget(this.quality));
    this.detailSessionBudget = detailSessionBudget;
    this.detail = pack ? new CompactDetailController(
      this.bodyId,
      this.body.radius,
      this.quality,
      [compactMaterial],
      this.diagnostics,
      detailSessionBudget,
    ) : null;
    this.terrain = new PlanetRenderer(this.body, PLANET_QUALITY[this.quality], {
      material: terrainMaterial,
      oceanEnabled: false,
      workerPool: this.workerPool,
      ownsWorkerPool: false,
      terrainAllocationBytes: allocation.allocationBytes,
      diagnostics: this.diagnostics,
      diagnosticSource: this.root.uuid,
      recipe: terrainRecipe,
    });
    this.terrainDetail = pack ? new TerrainDetailController(
      this.bodyId,
      this.body.radius,
      this.quality,
      terrainMaterial,
      () => this.terrain.detailDemand(),
      this.diagnostics,
      detailSessionBudget,
    ) : null;
    this.terrain.group.name = `airless-terrain:${this.bodyId}`;
    this.terrain.setShadowReceiver(this.quality !== 'low');
    this.root.add(this.compact, this.terrain.group);
    if (this.scatter) {
      this.scatter.group.visible = false;
      this.root.add(this.scatter.group);
    }
    this.transition.requestCompact();
    this.applyCoverage(0, false);
    this.initialized = true;
  }

  update(frame: Readonly<BodyRenderFrame>): void {
    if (!this.ready) return;
    this.detail?.update(frame);
    if (frame.allowFlightTerrain) this.flightAerial?.disable(this.body, frame);
    this.lastAngularRadius = frame.projection.angularRadius;
    const band = terrainPresentationBand(this.body);
    const prewarm = frame.allowFlightTerrain && frame.altitude < band.prewarmAltitude;
    const visibleBand = frame.allowFlightTerrain && frame.altitude < band.visibleAltitude;
    this.updateCompactRadius(frame, prewarm);
    this.compact.position.set(
      frame.cameraRelativeOrigin.x,
      frame.cameraRelativeOrigin.y,
      frame.cameraRelativeOrigin.z,
    );
    this.compact.quaternion.set(
      frame.orientation.x,
      frame.orientation.y,
      frame.orientation.z,
      frame.orientation.w,
    );
    if (prewarm) {
      this.terrain.group.visible = true;
      this.terrain.update(
        frame.cameraBodyFixed,
        frame.orientation,
        frame.cameraRelativeOrigin,
        frame.cameraBodyFixedVelocity,
        { simulationTime: frame.time, altitudeMeters: frame.altitude, terrainRequested: visibleBand },
        {
          verticalFovRadians: frame.verticalFovRadians,
          drawingBufferHeight: frame.drawingBufferHeight,
          viewDirectionBodyFixed: frame.cameraViewDirectionBodyFixed,
          bodyFixedFrustum: frame.bodyFixedFrustum,
          deltaSeconds: frame.deltaSeconds,
          framePressure: frame.framePressure,
        },
      );
      this.terrainDetail?.update(frame);
    }
    if (visibleBand) this.transition.requestTerrain();
    else this.transition.requestCompact();
    const snapshot = this.transition.update(frame.deltaSeconds, prewarm && this.terrain.coverageReady(), frame.framePressure);
    this.applyCoverage(snapshot.progress, prewarm);
    this.updateScatter(frame);
  }

  private updateScatter(frame: Readonly<BodyRenderFrame>): void {
    if (!this.scatter) return;
    this.scatterVisible = frame.allowFlightTerrain
      && this.terrainActive
      && this.coverageProgress >= 1
      && frame.altitude <= scatterStreamCeiling(this.quality);
    this.scatter.group.visible = this.scatterVisible;
    if (!this.scatterVisible) return;
    this.scatter.update({
      cameraBodyFixed: frame.cameraBodyFixed,
      orientation: frame.orientation,
      cameraRelativeOrigin: frame.cameraRelativeOrigin,
    });
  }

  private updateCompactRadius(frame: Readonly<BodyRenderFrame>, prewarm: boolean): void {
    if (!prewarm) {
      this.compact.scale.setScalar(this.body.radius);
      return;
    }
    const anchor = frame.surfaceAnchorBodyFixed ?? frame.cameraBodyFixed;
    const length = Math.hypot(anchor.x, anchor.y, anchor.z);
    if (!(length > 0)) {
      this.compact.scale.setScalar(this.body.radius);
      return;
    }
    this.anchorDirection.set(anchor.x / length, anchor.y / length, anchor.z / length);
    const surface = naturalContactSurface(this.body, this.anchorDirection);
    const height = surface.kind === 'none' ? 0 : surface.height;
    const sourceMacro = sampleSourceMacroHeight(this.bodyId, this.anchorDirection) ?? 0;
    this.compact.scale.setScalar(this.body.radius + height - sourceMacro);
  }

  private applyCoverage(progress: number, prewarm: boolean): void {
    this.coverageProgress = progress;
    const fading = progress > 0 && progress < 1;
    this.compact.material.opacity = 1 - progress;
    this.compact.material.transparent = fading;
    this.compact.material.depthWrite = !fading;
    this.compact.visible = progress < 1;
    this.terrainActive = prewarm && progress > 0;
    this.terrain.group.visible = this.terrainActive;
  }

  stats(): Readonly<BodyRendererStats> {
    if (!this.ready) return Object.freeze({ chunks: 0, visible: 0, terrainActive: false, exposure: 0 });
    const scatterStats = this.scatter?.stats();
    const detailStats = this.detail?.stats();
    const terrainDetailStats = this.terrainDetail?.stats();
    const detailSessionStats = this.detailSessionBudget?.stats();
    return Object.freeze({
      chunks: this.terrain.stats.chunks,
      visible: this.terrainActive ? this.terrain.stats.visible : 0,
      terrainActive: this.terrainActive,
      exposure: 0,
      coverageProgress: this.coverageProgress,
      visualScatter: this.scatterVisible ? scatterStats?.total ?? 0 : 0,
      scatterBytes: scatterStats?.bufferBytes ?? 0,
      terrainAllocationBytes: this.terrainAllocationBytes,
      terrainScheduleMs: this.terrain.stats.scheduleMs,
      terrainInstallMs: this.terrain.stats.installMs,
      terrainSelectionMs: this.terrain.stats.selectionMs,
      terrainBalanceMs: this.terrain.stats.balanceMs,
      terrainSelectionReused: this.terrain.stats.selectionReused,
      terrainPending: this.terrain.stats.pending,
      terrainTransitions: this.terrain.stats.activeTransitions,
      presentationMode: this.coverageProgress <= 0 ? 'proxy' : this.coverageProgress >= 1 ? 'physical' : 'transition',
      angularRadius: this.lastAngularRadius,
      assetTier: this.stagedAssetBytes > 0 ? this.quality : 'procedural',
      assetBytes: this.stagedAssetBytes,
      lutBytes: 0,
      cloudHistoryBytes: 0,
      heightCacheBytes: sourceHeightCacheBytes(this.bodyId)
        + (this.authority.region?.samples?.byteLength ?? 0),
      shadowBytes: localShadowPolicy(this.quality, this.body.radius, 0).mapSize ** 2 * 4,
      detailGpuBytes: detailStats?.gpuBytes ?? 0,
      detailPages: detailStats?.pages ?? 0,
      detailLevel: detailStats?.level ?? 0,
      detailState: detailStats?.state ?? 'disabled',
      detailDatasetId: detailStats?.datasetId,
      detailRequestBytes: detailStats?.requestBytes ?? 0,
      detailGeneration: detailStats?.generation ?? 0,
      detailFallbackReason: detailStats?.fallbackReason,
      terrainDetailGpuBytes: terrainDetailStats?.gpuBytes ?? 0,
      terrainDetailPages: terrainDetailStats?.pages ?? 0,
      terrainDetailLevel: terrainDetailStats?.sourceLevel ?? 0,
      terrainDetailState: terrainDetailStats?.state ?? 'disabled',
      terrainDetailDatasetId: terrainDetailStats?.datasetId,
      terrainDetailRequestBytes: terrainDetailStats?.requestBytes ?? 0,
      terrainDetailGeneration: terrainDetailStats?.generation ?? 0,
      terrainDetailFallbackReason: terrainDetailStats?.fallbackReason,
      terrainDetailTileKeys: terrainDetailStats?.tileKeys,
      terrainDetailNormalPages: terrainDetailStats?.normalPages ?? 0,
      terrainDetailNumericDatasetId: terrainDetailStats?.numericDatasetId,
      terrainDetailNumericDatum: terrainDetailStats?.numericDatum,
      terrainDetailHeightMode: terrainDetailStats?.heightMode ?? 'resident',
      terrainDetailDecodedCpuBytes: terrainDetailStats?.decodedCpuBytes ?? 0,
      terrainDetailPersistentBytes: terrainDetailStats?.persistentBytes ?? 0,
      terrainDetailRequestCount: terrainDetailStats?.requestCount ?? 0,
      terrainDetailCacheHits: terrainDetailStats?.cacheHits,
      terrainDetailTimingsMs: terrainDetailStats?.timingsMs,
      terrainDetailSourceCellMeters: terrainDetailStats?.sourceCellMeters,
      terrainDetailHeightRangeMeters: terrainDetailStats?.heightRangeMeters,
      detailProxyRequests: detailSessionStats?.proxyRequests ?? 0,
      detailProxyBytes: detailSessionStats?.proxyBytes ?? 0,
      surfaceClassSource: 'not-applicable',
      terrainAuthorityGeneration: this.authority.generation,
      terrainAuthorityDatasetId: this.authority.datasetId,
      terrainAuthorityVersion: this.authority.version,
      terrainAuthorityCoverage: this.authority.coverage,
      terrainAuthorityDatum: this.authority.datum,
      terrainAuthorityMode: this.authority.mode,
      terrainAuthorityFallbackReason: this.authority.fallbackReason,
    });
  }

  private releaseStack(): void {
    if (!this.initialized) return;
    this.root.clear();
    this.compact.geometry.dispose();
    this.compact.material.dispose();
    this.terrain.dispose();
    this.scatter?.dispose();
    this.scatter = null;
    this.detail?.dispose();
    this.detail = null;
    this.terrainDetail?.dispose();
    this.terrainDetail = null;
    this.detailSessionBudget = null;
    this.initialized = false;
    this.terrainActive = false;
    this.coverageProgress = 0;
    this.scatterVisible = false;
    this.stagedAssetBytes = 0;
    this.terrainAllocationBytes = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.releaseStack();
    this.workerPool?.dispose();
    this.disposed = true;
  }
}
