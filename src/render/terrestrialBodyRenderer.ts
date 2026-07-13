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
import { installBodyFixedDirectionAttribute } from './terrestrial/globalCoordinates';
import { createTerrestrialGlobalMaterial } from './terrestrial/globalMaterial';
import { createTerrestrialSurfaceMaterial } from './terrestrial/surfaceMaterial';
import { TerrestrialAtmosphere } from './terrestrial/atmosphere';
import { TerrestrialOcean } from './terrestrial/ocean';
import { TerrestrialCloudDeck } from './terrestrial/cloudLayer';
import { TerrainChunkWorkerPool } from './terrain/chunkWorkerPool';
import type { RenderDiagnosticsPort } from './renderDiagnostics';
import { geometryByteLength, terrainGeometryAllocation } from './resourceAccounting';
import { naturalContactSurface } from '../sim/terrain';

const PREWARM_RADIUS_MULTIPLIER = 70;
const VISIBLE_RADIUS_MULTIPLIER = 60;
const DEFAULT_ACTIVE_BODY_BUDGET: Readonly<Record<QualityTier, number>> = Object.freeze({
  low: 64 * 1024 * 1024,
  medium: 128 * 1024 * 1024,
  high: 256 * 1024 * 1024,
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
      for (const channel of ['albedo', 'normal', 'material', 'clouds']) {
        if (!pack.textures.has(channel)) throw new Error(`${pack.bodyId}/${pack.tier} is missing required ${channel} texture`);
      }
    }
    this.releaseStack();
    this.buildStack(pack);
  }

  private buildStack(pack: Readonly<RuntimeBodyAssetPack> | null): void {
    const compactMaterial = createTerrestrialGlobalMaterial(pack, this.descriptor);
    const compactGeometry = new THREE.SphereGeometry(1, 48, 32);
    installBodyFixedDirectionAttribute(compactGeometry);
    this.compact = new THREE.Mesh(compactGeometry, compactMaterial);
    this.compact.name = `terrestrial-compact:${this.bodyId}`;
    this.compact.scale.setScalar(this.body.radius);

    const visual = BODY_VISUALS[this.body.id as BodyId].atmosphereVisual!;
    this.atmosphere = new TerrestrialAtmosphere(this.body, this.caps, visual);
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
    const terrainMaterial = createTerrestrialSurfaceMaterial(pack, this.descriptor, this.quality);
    this.terrain = new PlanetRenderer(this.body, PLANET_QUALITY[this.quality], {
      material: terrainMaterial,
      oceanEnabled: false,
      workerPool: typeof Worker === 'undefined' ? undefined : new TerrainChunkWorkerPool(),
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
    const cameraDistance = Math.hypot(frame.cameraBodyFixed.x, frame.cameraBodyFixed.y, frame.cameraBodyFixed.z);
    const prewarm = frame.allowFlightTerrain && cameraDistance < this.body.radius * PREWARM_RADIUS_MULTIPLIER;
    const visibleBand = frame.allowFlightTerrain && cameraDistance < this.body.radius * VISIBLE_RADIUS_MULTIPLIER;
    this.updateCompactSurface(frame, prewarm);
    const origin = frame.cameraRelativeOrigin;
    this.compact.position.set(origin.x, origin.y, origin.z);
    this.compact.quaternion.set(frame.orientation.x, frame.orientation.y, frame.orientation.z, frame.orientation.w);
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
    this.compactRadius = this.body.radius + this.compactAnchorHeight;
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
      scatterBytes: 0,
      effectBytes: 0,
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
  }

  dispose(): void {
    if (this.disposed) return;
    this.releaseStack();
    this.disposed = true;
  }
}
