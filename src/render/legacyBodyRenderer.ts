import * as THREE from 'three';
import type { Body } from '../sim/universe';
import type { Quat } from '../core/quat';
import type { RenderCaps } from './context';
import type { BodyMaterialDescriptor } from './bodyMaterial';
import type { BodyRenderer, BodyRendererStats, BodyRenderFrame, QualityTier, RuntimeBodyAssetPack } from './bodyRenderer';
import { PLANET_QUALITY, PlanetRenderer, type PlanetDiagnosticContext, type PlanetRenderProjection } from './planet';
import { CloudLayer } from './clouds';
import { createAirlessGlobalMaterial } from './airless/globalMaterial';
import { createGlobalSphereGeometry } from './terrestrial/globalGeometry';
import { BODY_VISUALS, type BodyId } from '../content/bodyVisuals';
import { terrainPresentationBand } from './terrainPresentation';

interface TerrainAdapter {
  readonly group: THREE.Group;
  readonly stats: { readonly chunks: number; readonly visible: number };
  update(
    cameraBodyFixed: BodyRenderFrame['cameraBodyFixed'],
    orientation: Readonly<Quat>,
    origin: BodyRenderFrame['cameraRelativeOrigin'],
    velocity?: BodyRenderFrame['cameraBodyFixedVelocity'],
    diagnosticContext?: Readonly<PlanetDiagnosticContext>,
    projection?: Readonly<PlanetRenderProjection>,
  ): void;
  dispose(): void;
}

interface CloudAdapter {
  readonly mesh: THREE.Mesh;
  update(origin: BodyRenderFrame['cameraRelativeOrigin'], orientation: Readonly<Quat>, time: number, altitude: number): void;
  dispose(): void;
}

export interface LegacyBodyRendererDependencies {
  readonly createTerrain?: (body: Body, quality: QualityTier) => TerrainAdapter;
  readonly createCloud?: (body: Body) => CloudAdapter | null;
}

export class LegacyBodyRenderer implements BodyRenderer {
  readonly bodyId: string;
  readonly kind = 'legacy' as const;
  readonly root = new THREE.Group();
  private readonly compactGeometry: THREE.SphereGeometry;
  private compactMaterial: THREE.Material;
  private readonly compact: THREE.Mesh<THREE.SphereGeometry, THREE.Material>;
  private terrain: TerrainAdapter | null = null;
  private cloud: CloudAdapter | null = null;
  private disposed = false;
  private terrainActive = false;

  constructor(
    private readonly body: Body,
    descriptor: Readonly<BodyMaterialDescriptor>,
    readonly caps: Readonly<RenderCaps>,
    readonly quality: QualityTier,
    private readonly dependencies: LegacyBodyRendererDependencies = {},
  ) {
    this.bodyId = body.id;
    this.compactGeometry = createGlobalSphereGeometry(quality);
    this.compactMaterial = new THREE.MeshLambertMaterial({ color: descriptor.albedo.mid });
    this.compact = new THREE.Mesh(this.compactGeometry, this.compactMaterial);
    this.compact.scale.setScalar(body.radius);
    this.root.add(this.compact);

  }

  get ready(): boolean { return !this.disposed; }

  stageAssets(pack: Readonly<RuntimeBodyAssetPack> | null): void {
    if (pack === null) return;
    if (pack.bodyId !== this.bodyId || pack.tier !== this.quality) {
      throw new Error(`Cannot stage ${pack.bodyId}/${pack.tier} for ${this.bodyId}/${this.quality}`);
    }
    if (BODY_VISUALS[this.bodyId as BodyId]?.targetArchetype !== 'airless') {
      throw new Error(`${this.bodyId} legacy renderer accepts procedural assets only`);
    }
    const replacement = createAirlessGlobalMaterial(pack, this.caps.maxAnisotropy);
    const previous = this.compactMaterial;
    this.compactMaterial = replacement;
    this.compact.material = replacement;
    previous.dispose();
  }

  private ensureFlightVisuals(): void {
    if (this.terrain || this.body.def.surfaceKind !== 'solid') return;
    const createTerrain = this.dependencies.createTerrain
      ?? ((candidate: Body, tier: QualityTier) => new PlanetRenderer(candidate, PLANET_QUALITY[tier]));
    this.terrain = createTerrain(this.body, this.quality);
    this.root.add(this.terrain.group);
    const createCloud = this.dependencies.createCloud
      ?? ((candidate: Body) => candidate.def.atmosphere ? new CloudLayer(candidate) : null);
    this.cloud = createCloud(this.body);
    if (this.cloud) this.root.add(this.cloud.mesh);
  }

  private releaseFlightVisuals(): void {
    if (this.terrain) {
      this.root.remove(this.terrain.group);
      this.terrain.dispose();
      this.terrain = null;
    }
    if (this.cloud) {
      this.root.remove(this.cloud.mesh);
      this.cloud.dispose();
      this.cloud = null;
    }
    this.terrainActive = false;
  }

  update(frame: Readonly<BodyRenderFrame>): void {
    if (this.disposed) return;
    this.compact.position.set(frame.cameraRelativeOrigin.x, frame.cameraRelativeOrigin.y, frame.cameraRelativeOrigin.z);
    this.compact.quaternion.set(frame.orientation.x, frame.orientation.y, frame.orientation.z, frame.orientation.w);

    const band = terrainPresentationBand(this.body);
    const prewarm = frame.allowFlightTerrain && frame.altitude < band.prewarmAltitude;
    const near = frame.allowFlightTerrain && frame.altitude < band.visibleAltitude;
    if (!frame.allowFlightTerrain) this.releaseFlightVisuals();
    if (prewarm) this.ensureFlightVisuals();
    this.terrainActive = this.terrain !== null && frame.allowFlightTerrain && near;
    this.compact.visible = !this.terrainActive;
    if (this.terrain) {
      this.terrain.group.visible = this.terrainActive;
      if (prewarm) {
        this.terrain.update(
          frame.cameraBodyFixed,
          frame.orientation as Readonly<Quat>,
          frame.cameraRelativeOrigin,
          frame.cameraBodyFixedVelocity,
          { terrainRequested: near, simulationTime: frame.time, altitudeMeters: frame.altitude },
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
    }
    if (this.cloud) {
      this.cloud.mesh.visible = this.terrainActive;
      if (this.terrainActive) {
        this.cloud.update(frame.cameraRelativeOrigin, frame.orientation as Readonly<Quat>, frame.time, frame.altitude);
      }
    }
  }

  stats(): Readonly<BodyRendererStats> {
    if (this.disposed) return Object.freeze({ chunks: 0, visible: 0, terrainActive: false, exposure: 0 });
    return Object.freeze({
      chunks: this.terrain?.stats.chunks ?? 0,
      visible: this.terrainActive ? this.terrain?.stats.visible ?? 0 : 0,
      terrainActive: this.terrainActive,
      exposure: 0,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseFlightVisuals();
    this.compactGeometry.dispose();
    this.compactMaterial.dispose();
    this.root.clear();
  }
}
