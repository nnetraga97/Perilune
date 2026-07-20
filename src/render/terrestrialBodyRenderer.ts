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
  updateTerrestrialEnvironment,
} from './terrestrial/globalMaterial';
import { createTerrestrialSurfaceMaterial } from './terrestrial/surfaceMaterial';
import { TerrestrialAtmosphere } from './terrestrial/atmosphere';
import { TerrestrialOcean } from './terrestrial/ocean';
import { TerrestrialCloudDeck, WEATHER_CLOUD_DRIFT_RATE } from './terrestrial/cloudLayer';
import { TerrainChunkWorkerPool } from './terrain/chunkWorkerPool';
import type { RenderDiagnosticsPort } from './renderDiagnostics';
import { geometryByteLength, terrainGeometryAllocation } from './resourceAccounting';
import { launchPadTerrainEnvelope, naturalContactSurface } from '../sim/terrain';
import { launchSiteBodyFixedDirection } from '../sim/launchSite';
import { terrainPresentationBand } from './terrainPresentation';
import { sampleSourceMacroHeight, sourceHeightCacheBytes } from '../sim/sourceHeightAuthority';
import { localShadowPolicy } from './lightingPolicy';

const DEFAULT_ACTIVE_BODY_BUDGET: Readonly<Record<QualityTier, number>> = Object.freeze({
  low: 64 * 1024 * 1024,
  medium: 128 * 1024 * 1024,
  high: 320 * 1024 * 1024,
});

function uniqueGeometryBytes(objects: readonly THREE.Object3D[]): number {
  const geometries = new Set<THREE.BufferGeometry>();
  for (const root of objects) {
    root.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Points) geometries.add(object.geometry);
    });
  }
  let bytes = 0;
  for (const geometry of geometries) bytes += geometryByteLength(geometry);
  return bytes;
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
        ? ['albedo', 'normal', 'material', 'clouds', 'heightMacro', 'localDetail']
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
    this.ocean = new TerrestrialOcean(this.body, this.quality, materialMap);

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

    const fixedPassBytes = uniqueGeometryBytes([
      this.compact,
      this.ocean.mesh,
      this.atmosphere.mesh,
      this.clouds.group,
    ]) + (this.fallbackCloudTexture ? 4 : 0);
    const allocation = terrainGeometryAllocation({
      activeBodyBudgetBytes: this.activeBodyBudgetBytes,
      committedTextureBytes: pack?.gpuBytes ?? 0,
      fixedPassBytes,
      scatterBytes: 0,
      effectBytes: 0,
    });
    const terrainMaterial = createTerrestrialSurfaceMaterial(
      pack,
      this.descriptor,
      this.quality,
      this.caps.maxAnisotropy,
    );
    this.surfaceMaterial = terrainMaterial;
    this.terrain = new PlanetRenderer(this.body, PLANET_QUALITY[this.quality], {
      material: terrainMaterial,
      oceanEnabled: false,
      workerPool: this.workerPool,
      ownsWorkerPool: false,
      terrainAllocationBytes: allocation.allocationBytes,
      diagnostics: this.diagnostics,
      diagnosticSource: this.root.uuid,
    });
    this.terrain.group.name = `terrestrial-terrain:${this.bodyId}`;
    this.terrain.setShadowReceiver(this.quality !== 'low');

    this.root.add(
      this.compact,
      this.terrain.group,
      this.ocean.mesh,
      this.atmosphere.mesh,
      this.clouds.group,
    );
    this.transition.requestCompact();
    this.applyCoverage(0, false);
    this.initialized = true;
  }

  update(frame: Readonly<BodyRenderFrame>): void {
    if (!this.ready) return;
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
    updateTerrestrialEnvironment(this.compact.material, this.body, frame, this.atmosphere.aerialPerspectiveTexture);
    updateTerrestrialEnvironment(this.surfaceMaterial, this.body, frame, this.atmosphere.aerialPerspectiveTexture);
    this.atmosphere.update(frame);
    this.ocean.update(frame);
    this.clouds.update(frame);

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
        // until streamed terrain owns depth around Cape Skyward.
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
    return Object.freeze({
      chunks: this.terrain.stats.chunks,
      visible: this.terrainActive ? this.terrain.stats.visible : 0,
      terrainActive: this.terrainActive,
      exposure: 0,
      coverageProgress: this.coverageProgress,
      visualScatter: 0,
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
      scatterBytes: 0,
      effectBytes: 0,
      presentationMode: this.coverageProgress <= 0 ? 'proxy' : this.coverageProgress >= 1 ? 'physical' : 'transition',
      angularRadius: this.lastAngularRadius,
      assetTier: this.stagedAssetBytes > 0 ? this.quality : 'procedural',
      assetBytes: this.stagedAssetBytes,
      lutBytes: this.atmosphere.lookupBytes,
      cloudHistoryBytes: 0,
      heightCacheBytes: sourceHeightCacheBytes(this.bodyId),
      shadowBytes: localShadowPolicy(this.quality, this.body.radius, 0).mapSize ** 2 * 4,
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
    this.fallbackCloudTexture?.dispose();
    this.fallbackCloudTexture = null;
    this.initialized = false;
    this.terrainActive = false;
    this.coverageProgress = 0;
    this.stagedAssetBytes = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.releaseStack();
    this.workerPool?.dispose();
    this.disposed = true;
  }
}
