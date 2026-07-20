import * as THREE from 'three';
import { Vec3 } from '../core/vec3';
import type { Body } from '../sim/universe';
import { naturalContactSurface } from '../sim/terrain';
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

export class AirlessBodyRenderer implements BodyRenderer {
  readonly bodyId: string;
  readonly kind = 'airless' as const;
  readonly root = new THREE.Group();
  private readonly transition = new CoverageTransition();
  private readonly workerPool = typeof Worker === 'undefined' ? undefined : new TerrainChunkWorkerPool();
  private compact!: THREE.Mesh<THREE.SphereGeometry, THREE.Material>;
  private terrain!: PlanetRenderer;
  private disposed = false;
  private initialized = false;
  private terrainActive = false;
  private coverageProgress = 0;
  private readonly anchorDirection = new Vec3();
  private stagedAssetBytes = 0;
  private lastAngularRadius = 0;

  constructor(
    private readonly body: Body,
    private readonly descriptor: Readonly<BodyMaterialDescriptor>,
    private readonly caps: Readonly<RenderCaps>,
    readonly quality: QualityTier,
    private readonly diagnostics?: RenderDiagnosticsPort,
  ) {
    if (body.def.surfaceKind !== 'solid' || body.def.atmosphere) {
      throw new Error(`${body.id} airless renderer requires an atmosphere-free solid body`);
    }
    this.bodyId = body.id;
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
    this.stagedAssetBytes = pack?.gpuBytes ?? 0;
    const compactGeometry = createGlobalSphereGeometry(this.quality);
    const compactMaterial = pack
      ? createAirlessGlobalMaterial(pack, this.caps.maxAnisotropy, this.body.radius)
      : new THREE.MeshStandardMaterial({ color: this.descriptor.albedo.mid, roughness: 1, metalness: 0 });
    this.compact = new THREE.Mesh(compactGeometry, compactMaterial);
    this.compact.name = `airless-compact:${this.bodyId}`;
    this.compact.scale.setScalar(this.body.radius);

    const terrainMaterial = createAirlessSurfaceMaterial(
      pack,
      this.descriptor,
      this.quality,
      this.caps.maxAnisotropy,
    );
    this.terrain = new PlanetRenderer(this.body, PLANET_QUALITY[this.quality], {
      material: terrainMaterial,
      oceanEnabled: false,
      workerPool: this.workerPool,
      ownsWorkerPool: false,
      diagnostics: this.diagnostics,
      diagnosticSource: this.root.uuid,
    });
    this.terrain.group.name = `airless-terrain:${this.bodyId}`;
    this.terrain.setShadowReceiver(this.quality !== 'low');
    this.root.add(this.compact, this.terrain.group);
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
    }
    if (visibleBand) this.transition.requestTerrain();
    else this.transition.requestCompact();
    const snapshot = this.transition.update(frame.deltaSeconds, prewarm && this.terrain.coverageReady(), frame.framePressure);
    this.applyCoverage(snapshot.progress, prewarm);
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
    return Object.freeze({
      chunks: this.terrain.stats.chunks,
      visible: this.terrainActive ? this.terrain.stats.visible : 0,
      terrainActive: this.terrainActive,
      exposure: 0,
      coverageProgress: this.coverageProgress,
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
