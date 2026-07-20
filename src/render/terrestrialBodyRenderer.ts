import * as THREE from 'three';
import { Vec3 } from '../core/vec3';
import { BODY_VISUALS } from '../content/bodyVisuals';
import type { BodyId } from '../content/bodyVisuals';
import type { Body } from '../sim/universe';
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
import { createGlobalSphereGeometry } from './terrestrial/globalGeometry';
import {
  createTerrestrialGlobalMaterial,
  updateTerrestrialCloudLighting,
} from './terrestrial/globalMaterial';
import { updateTerrestrialAerialPerspective } from './terrestrial/aerialPerspective';
import { createTerrestrialSurfaceMaterial } from './terrestrial/surfaceMaterial';
import { TerrestrialAtmosphere } from './terrestrial/atmosphere';
import { TerrestrialOcean } from './terrestrial/ocean';
import { createEarthSurfaceClassSampler } from './terrestrial/surfaceClassAuthority';
import { CompactDetailController } from './planetDetail/compactDetailController';
import { PlanetDetailSessionBudget, planetDetailBudget } from './planetDetail/detailBudget';
import { TerrainDetailController } from './planetDetail/terrainDetailController';
import { sampleEarthSurfaceClass } from './terrestrial/surfaceClassAuthority';
import { TerrestrialCloudDeck, WEATHER_CLOUD_DRIFT_RATE } from './terrestrial/cloudLayer';
import { TerrainChunkWorkerPool } from './terrain/chunkWorkerPool';
import type { RenderDiagnosticsPort } from './renderDiagnostics';
import {
  DEFAULT_ACTIVE_BODY_BUDGET,
  objectGeometryBytes,
  terrainGeometryAllocation,
} from './resourceAccounting';
import { launchPadTerrainEnvelope, naturalContactSurface } from '../sim/terrain';
import { launchSiteBodyFixedDirection } from '../sim/launchSite';
import { terrainPresentationBand } from './terrainPresentation';
import { sampleSourceMacroHeight, sourceHeightCacheBytes } from '../sim/sourceHeightAuthority';
import { localShadowPolicy } from './lightingPolicy';
import { LAUNCH_PAD_FOOTPRINT_RADIUS } from '../sim/launchSite';
import { recipeForBody } from '../sim/terrainRecipe';
import {
  createRecipeSurfaceSampler,
  scatterProfileByName,
  scatterStreamCeiling,
  TerrestrialScatter,
  type SuppressionSphere,
} from './terrestrial/scatter';
import type { FlightAerialPerspectiveController } from './flightAerialPerspective';

/** Visual-only exclusion volume covering an authored launch-pad foundation. */
export function launchPadScatterSuppressionSphere(body: Body): SuppressionSphere {
  if (!body.def.launchSite || body.def.surfaceKind !== 'solid') {
    throw new Error(`${body.name} has no launch-pad scatter footprint`);
  }
  const direction = launchSiteBodyFixedDirection(new Vec3());
  const centerRadius = body.radius + launchPadTerrainEnvelope(body).centerHeight;
  return Object.freeze({
    x: direction.x * centerRadius,
    y: direction.y * centerRadius,
    z: direction.z * centerRadius,
    radius: LAUNCH_PAD_FOOTPRINT_RADIUS,
  });
}

export class TerrestrialBodyRenderer implements BodyRenderer {
  readonly bodyId: string;
  readonly kind = 'terrestrial' as const;
  readonly root = new THREE.Group();
  private readonly transition = new CoverageTransition();
  private compact!: THREE.Mesh<THREE.SphereGeometry, THREE.Material>;
  private terrain!: PlanetRenderer;
  private surfaceMaterial!: THREE.Material;
  private atmosphere!: TerrestrialAtmosphere;
  private ocean!: TerrestrialOcean;
  private clouds!: TerrestrialCloudDeck;
  private scatter: TerrestrialScatter | null = null;
  private detail: CompactDetailController | null = null;
  private terrainDetail: TerrainDetailController | null = null;
  private lastSurfaceClassCode: number | undefined;
  private detailSessionBudget: PlanetDetailSessionBudget | null = null;
  private scatterSuppression: readonly SuppressionSphere[] = Object.freeze([]);
  private fallbackCloudTexture: THREE.DataTexture | null = null;
  private disposed = false;
  private initialized = false;
  private lastDiagnosticObservationAt = Number.NEGATIVE_INFINITY;
  private terrainActive = false;
  private coverageProgress = 0;
  private compactRadius: number;
  private compactAnchorHeight = 0;
  private compactAnchorSource: 'surface' | 'camera' | 'datum' = 'datum';
  private readonly compactAnchorDirection = new Vec3();
  private readonly launchSiteDirection = new Vec3();
  private stagedAssetBytes = 0;
  private lastAngularRadius = 0;
  private terrainAllocationBytes = 0;
  private scatterVisible = false;
  private readonly workerPool = typeof Worker === 'undefined'
    ? undefined
    : new TerrainChunkWorkerPool();

  constructor(
    private readonly body: Body,
    private readonly descriptor: Readonly<BodyMaterialDescriptor>,
    private readonly caps: Readonly<RenderCaps>,
    readonly quality: QualityTier,
    private readonly diagnostics?: RenderDiagnosticsPort,
    private readonly activeBodyBudgetBytes = DEFAULT_ACTIVE_BODY_BUDGET[quality],
    private readonly flightAerial?: FlightAerialPerspectiveController,
  ) {
    this.bodyId = body.id;
    this.compactRadius = body.radius;
    if (body.def.surfaceKind !== 'solid') throw new Error(`${body.id} is not a solid terrestrial body`);
    if (!BODY_VISUALS[body.id as BodyId]?.atmosphereVisual || !body.def.atmosphere) {
      throw new Error(`${body.id} terrestrial renderer requires physical and visual atmosphere data`);
    }
    this.root.name = `terrestrial-renderer:${body.id}`;
    this.buildStack(null);
  }

  get ready(): boolean { return this.initialized && !this.disposed; }

  stageAssets(pack: Readonly<RuntimeBodyAssetPack> | null): void {
    if (this.disposed) throw new Error(`${this.bodyId} terrestrial renderer is disposed`);
    if (pack && (pack.bodyId !== this.bodyId || pack.tier !== this.quality)) {
      throw new Error(`Cannot stage ${pack.bodyId}/${pack.tier} for ${this.bodyId}/${this.quality}`);
    }
    if (pack) {
      const requiredChannels = this.bodyId === 'earth'
        ? ['albedo', 'normal', 'material', 'clouds', 'heightMacro', 'localDetail', 'surfaceClass', 'surfaceClassRegional']
        : ['albedo', 'normal', 'material', 'clouds'];
      for (const channel of requiredChannels) {
        if (!pack.textures.has(channel)) throw new Error(`${pack.bodyId}/${pack.tier} is missing required ${channel} texture`);
      }
    }
    this.releaseStack();
    this.buildStack(pack);
  }

  private buildStack(pack: Readonly<RuntimeBodyAssetPack> | null): void {
    this.stagedAssetBytes = pack?.gpuBytes ?? 0;
    const compactMaterial = createTerrestrialGlobalMaterial(pack, this.descriptor, this.caps.maxAnisotropy);
    const compactGeometry = createGlobalSphereGeometry(this.quality);
    this.compact = new THREE.Mesh(compactGeometry, compactMaterial);
    this.compact.name = `terrestrial-compact:${this.bodyId}`;
    this.compact.scale.setScalar(this.body.radius);

    const visual = BODY_VISUALS[this.body.id as BodyId].atmosphereVisual!;
    this.atmosphere = new TerrestrialAtmosphere(this.body, this.caps, visual, this.quality);
    const materialMap = pack?.textures.get('material') ?? null;
    this.ocean = new TerrestrialOcean(this.body, this.quality, materialMap, pack?.textures ?? null);

    let cloudMap = pack?.textures.get('clouds') ?? null;
    if (!cloudMap) {
      this.fallbackCloudTexture = new THREE.DataTexture(
        new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat,
      );
      this.fallbackCloudTexture.colorSpace = THREE.NoColorSpace;
      this.fallbackCloudTexture.needsUpdate = true;
      cloudMap = this.fallbackCloudTexture;
    }
    this.clouds = new TerrestrialCloudDeck(
      this.body,
      this.quality,
      cloudMap,
      this.diagnostics,
      this.root.uuid,
      this.caps.maxAnisotropy,
    );

    // The current Sol rollout enables neutral geology for Earth only. Veyra's
    // existing presentation remains unchanged even though its legacy profile
    // is retained as the deterministic compatibility reference.
    const scatterProfileName = this.bodyId === 'earth'
      ? BODY_VISUALS[this.body.id as BodyId].scatterProfile
      : undefined;
    this.scatter = scatterProfileName
      ? new TerrestrialScatter(
        this.body.radius,
        this.body.def.terrain.seed,
        createRecipeSurfaceSampler(recipeForBody(this.body)),
        this.quality,
        scatterProfileByName(scatterProfileName),
        this.flightAerial,
        createEarthSurfaceClassSampler(),
      )
      : null;
    this.scatter?.setShadows(this.quality !== 'low');
    this.scatterSuppression = this.scatter && this.body.def.launchSite
      ? Object.freeze([launchPadScatterSuppressionSphere(this.body)])
      : Object.freeze([]);
    const scatterBytes = this.scatter?.stats().bufferBytes ?? 0;

    const fixedPassBytes = objectGeometryBytes([
      this.compact,
      this.ocean.mesh,
      this.atmosphere.mesh,
      this.clouds.group,
    ]) + (this.fallbackCloudTexture ? 4 : 0) + planetDetailBudget(this.quality).activeGpuBytes;
    const allocation = terrainGeometryAllocation({
      activeBodyBudgetBytes: this.activeBodyBudgetBytes,
      committedTextureBytes: pack?.gpuBytes ?? 0,
      fixedPassBytes,
      scatterBytes,
      effectBytes: 0,
    });
    this.terrainAllocationBytes = allocation.allocationBytes;
    const terrainMaterial = createTerrestrialSurfaceMaterial(
      pack,
      this.descriptor,
      this.quality,
      this.caps.maxAnisotropy,
    );
    this.surfaceMaterial = terrainMaterial;
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
    this.terrain.group.name = `terrestrial-terrain:${this.bodyId}`;
    this.terrain.setShadowReceiver(this.quality !== 'low');

    this.root.add(
      this.compact,
      this.terrain.group,
      this.ocean.mesh,
      this.atmosphere.mesh,
      this.clouds.group,
    );
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
    this.lastSurfaceClassCode = this.bodyId === 'earth'
      ? sampleEarthSurfaceClass(frame.cameraBodyFixed.x, frame.cameraBodyFixed.y, frame.cameraBodyFixed.z)
      : undefined;
    this.detail?.update(frame);
    this.lastAngularRadius = frame.projection.angularRadius;
    const band = terrainPresentationBand(this.body);
    const prewarm = frame.allowFlightTerrain && frame.altitude < band.prewarmAltitude;
    const visibleBand = frame.allowFlightTerrain && frame.altitude < band.visibleAltitude;
    this.updateCompactSurface(frame, prewarm);
    const origin = frame.cameraRelativeOrigin;
    this.compact.position.set(origin.x, origin.y, origin.z);
    this.compact.quaternion.set(frame.orientation.x, frame.orientation.y, frame.orientation.z, frame.orientation.w);
    const cloudDriftAngle = frame.time * WEATHER_CLOUD_DRIFT_RATE;
    updateTerrestrialCloudLighting(this.compact.material, frame.bodySunDirection, cloudDriftAngle);
    updateTerrestrialCloudLighting(this.surfaceMaterial, frame.bodySunDirection, cloudDriftAngle);
    updateTerrestrialAerialPerspective(
      this.compact.material,
      this.body,
      frame,
      this.atmosphere.aerialPerspectiveTexture,
    );
    updateTerrestrialAerialPerspective(
      this.surfaceMaterial,
      this.body,
      frame,
      this.atmosphere.aerialPerspectiveTexture,
    );
    this.atmosphere.update(frame);
    this.ocean.update(frame, this.atmosphere.aerialPerspectiveTexture);
    this.clouds.update(frame);
    if (frame.allowFlightTerrain) {
      this.flightAerial?.update(
        this.body,
        frame,
        this.atmosphere.aerialPerspectiveTexture,
      );
    }

    if (prewarm) {
      this.terrain.group.visible = true;
      this.terrain.update(
        frame.cameraBodyFixed,
        frame.orientation,
        origin,
        frame.cameraBodyFixedVelocity,
        {
          simulationTime: frame.time,
          altitudeMeters: frame.altitude,
          terrainRequested: visibleBand,
        },
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
    } else {
      this.terrain.group.visible = false;
    }

    if (visibleBand) this.transition.requestTerrain();
    else this.transition.requestCompact();
    const snapshot = this.transition.update(
      frame.deltaSeconds,
      prewarm && this.terrain.coverageReady(),
      frame.framePressure,
    );
    this.applyCoverage(snapshot.progress, prewarm);
    this.updateScatter(frame);
    const diagnosticNow = performance.now();
    if (this.diagnostics && (this.diagnostics.detailed || diagnosticNow - this.lastDiagnosticObservationAt >= 100)) {
      this.lastDiagnosticObservationAt = diagnosticNow;
      this.diagnostics.observeTransition?.({
        simulationTime: frame.time,
        bodyId: this.bodyId,
        rendererIdentity: this.root.uuid,
        altitudeMeters: frame.altitude,
        requestedPresentation: visibleBand ? 'terrain' : 'compact',
        state: snapshot.state,
        progress: snapshot.progress,
        compactCoverage: snapshot.compactCoverage,
        terrainCoverage: snapshot.terrainCoverage,
        coverageReady: prewarm && this.terrain.coverageReady(),
        gapCount: this.terrain.stats.coverageGaps,
        prewarm,
        visibleBand,
        framePressure: frame.framePressure,
        compactVisible: this.compact.visible,
        terrainVisible: this.terrain.group.visible && this.terrainActive,
        terrainVisibleChunks: this.terrainActive ? this.terrain.stats.visible : 0,
        compactRadiusMeters: this.compactRadius,
        compactAnchorHeightMeters: this.compactAnchorHeight,
        compactAnchorSource: this.compactAnchorSource,
      });
    }
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
      suppression: this.scatterSuppression,
    });
  }

  /**
   * During near-surface prewarm the compact mesh is an emergency cover, not a
   * second ground authority. Anchor it to the shared terrain recipe beneath
   * the active vessel so the temporary sphere cannot sit kilometres below a
   * launch site. Distant compact presentation remains at the reference datum.
   */
  private updateCompactSurface(frame: Readonly<BodyRenderFrame>, prewarm: boolean): void {
    if (!prewarm) {
      this.compactRadius = this.body.radius;
      this.compactAnchorHeight = 0;
      this.compactAnchorSource = 'datum';
      this.compact.scale.setScalar(this.compactRadius);
      return;
    }
    const anchor = frame.surfaceAnchorBodyFixed ?? frame.cameraBodyFixed;
    const length = Math.hypot(anchor.x, anchor.y, anchor.z);
    if (!(length > 0) || !Number.isFinite(length)) {
      this.compactRadius = this.body.radius;
      this.compactAnchorHeight = 0;
      this.compactAnchorSource = 'datum';
      this.compact.scale.setScalar(this.compactRadius);
      return;
    }
    this.compactAnchorDirection.set(anchor.x / length, anchor.y / length, anchor.z / length);
    const surface = naturalContactSurface(this.body, this.compactAnchorDirection);
    this.compactAnchorHeight = surface.kind === 'none' ? 0 : surface.height;
    if (this.body.def.launchSite) {
      const launchDirection = launchSiteBodyFixedDirection(this.launchSiteDirection);
      const angularDistance = Math.acos(Math.max(-1, Math.min(1,
        this.compactAnchorDirection.x * launchDirection.x
          + this.compactAnchorDirection.y * launchDirection.y
          + this.compactAnchorDirection.z * launchDirection.z,
      )));
      if (angularDistance * this.body.radius < 10_000) {
        // The compact emergency sphere must remain below the visible deck
        // until streamed terrain owns depth around LC-39B.
        this.compactAnchorHeight = Math.min(
          this.compactAnchorHeight,
          launchPadTerrainEnvelope(this.body).deckHeight - 0.25,
        );
      }
    }
    const sourceMacro = sampleSourceMacroHeight(this.bodyId, this.compactAnchorDirection);
    // Authored compact geometry already carries the source macro displacement;
    // the uniform scale contributes only the residual canonical local relief.
    this.compactRadius = this.body.radius + this.compactAnchorHeight - (sourceMacro ?? 0);
    this.compactAnchorSource = frame.surfaceAnchorBodyFixed ? 'surface' : 'camera';
    this.compact.scale.setScalar(this.compactRadius);
  }

  private applyCoverage(progress: number, prewarm: boolean): void {
    this.coverageProgress = progress;
    const fading = progress > 0 && progress < 1;
    // Streamed terrain is opaque and owns depth once complete coverage exists.
    // The compact emergency cover then fades over it. Screen-door discard
    // cannot safely bridge geometries with different silhouettes: it exposes
    // stars/clouds through pixels covered by only one of the two surfaces.
    this.compact.material.opacity = 1 - progress;
    this.compact.material.transparent = fading;
    this.compact.material.depthWrite = !fading;
    this.compact.visible = progress < 1;
    this.ocean.mesh.visible = prewarm && progress > 0;
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
      decals: 0,
      dust: 0,
      physicalProxies: 0,
      collisions: 0,
      terrainScheduleMs: this.terrain.stats.scheduleMs,
      terrainInstallMs: this.terrain.stats.installMs,
      terrainSelectionMs: this.terrain.stats.selectionMs,
      terrainBalanceMs: this.terrain.stats.balanceMs,
      terrainSelectionReused: this.terrain.stats.selectionReused,
      terrainPending: this.terrain.stats.pending,
      terrainTransitions: this.terrain.stats.activeTransitions,
      scatterBytes: scatterStats?.bufferBytes ?? 0,
      effectBytes: 0,
      terrainAllocationBytes: this.terrainAllocationBytes,
      presentationMode: this.coverageProgress <= 0 ? 'proxy' : this.coverageProgress >= 1 ? 'physical' : 'transition',
      angularRadius: this.lastAngularRadius,
      assetTier: this.stagedAssetBytes > 0 ? this.quality : 'procedural',
      assetBytes: this.stagedAssetBytes,
      lutBytes: this.atmosphere.lookupBytes,
      cloudHistoryBytes: 0,
      heightCacheBytes: sourceHeightCacheBytes(this.bodyId),
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
      surfaceClassCode: this.lastSurfaceClassCode,
      surfaceClassSource: this.lastSurfaceClassCode === undefined ? 'not-applicable' : 'regional-or-global-exact',
      aerialConsumers: Object.freeze(['compact-land', 'streamed-land', 'ocean']),
    });
  }

  private releaseStack(): void {
    if (!this.initialized) return;
    this.root.clear();
    this.compact.geometry.dispose();
    this.compact.material.dispose();
    this.terrain.dispose();
    this.atmosphere.dispose();
    this.ocean.dispose();
    this.clouds.dispose();
    this.scatter?.dispose();
    this.scatter = null;
    this.detail?.dispose();
    this.detail = null;
    this.terrainDetail?.dispose();
    this.terrainDetail = null;
    this.detailSessionBudget = null;
    this.scatterSuppression = Object.freeze([]);
    this.fallbackCloudTexture?.dispose();
    this.fallbackCloudTexture = null;
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
