import * as THREE from 'three';
import type { Body } from '../sim/universe';
import type { Quat } from '../core/quat';
import type { RenderCaps } from './context';
import type { BodyMaterialDescriptor } from './bodyMaterial';
import type { BodyRenderer, BodyRendererStats, BodyRenderFrame, QualityTier } from './bodyRenderer';
import { PLANET_QUALITY, PlanetRenderer } from './planet';
import { CloudLayer } from './clouds';

interface TerrainAdapter {
  readonly group: THREE.Group;
  readonly stats: { readonly chunks: number; readonly visible: number };
  update(cameraBodyFixed: BodyRenderFrame['cameraBodyFixed'], orientation: Readonly<Quat>, origin: BodyRenderFrame['cameraRelativeOrigin']): void;
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
  private readonly compactMaterial: THREE.MeshLambertMaterial;
  private readonly compact: THREE.Mesh;
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
    this.compactGeometry = new THREE.SphereGeometry(1, 28, 18);
    this.compactMaterial = new THREE.MeshLambertMaterial({ color: descriptor.albedo.mid });
    this.compact = new THREE.Mesh(this.compactGeometry, this.compactMaterial);
    this.compact.scale.setScalar(body.radius);
    this.root.add(this.compact);

  }

  get ready(): boolean { return !this.disposed; }

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

  update(frame: Readonly<BodyRenderFrame>): void {
    if (this.disposed) return;
    this.compact.position.set(frame.cameraRelativeOrigin.x, frame.cameraRelativeOrigin.y, frame.cameraRelativeOrigin.z);
    this.compact.quaternion.set(frame.orientation.x, frame.orientation.y, frame.orientation.z, frame.orientation.w);

    const near = Math.hypot(frame.cameraBodyFixed.x, frame.cameraBodyFixed.y, frame.cameraBodyFixed.z) < this.body.radius * 60;
    if (frame.allowFlightTerrain && near) this.ensureFlightVisuals();
    this.terrainActive = this.terrain !== null && frame.allowFlightTerrain && near;
    this.compact.visible = !this.terrainActive;
    if (this.terrain) {
      this.terrain.group.visible = this.terrainActive;
      if (this.terrainActive) {
        this.terrain.update(frame.cameraBodyFixed, frame.orientation as Readonly<Quat>, frame.cameraRelativeOrigin);
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
    this.terrain?.dispose();
    this.cloud?.dispose();
    this.compactGeometry.dispose();
    this.compactMaterial.dispose();
    this.root.clear();
  }
}
