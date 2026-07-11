import * as THREE from 'three';
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
import { TerrestrialAtmosphere } from './terrestrial/atmosphere';
import { TerrestrialOcean } from './terrestrial/ocean';
import { TerrestrialCloudDeck } from './terrestrial/cloudLayer';
import { installCoverageDither, type CoverageDitherBinding } from './terrestrial/coverageDither';

const PREWARM_RADIUS_MULTIPLIER = 70;
const VISIBLE_RADIUS_MULTIPLIER = 60;

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
  private compactDither!: CoverageDitherBinding;
  private terrainDither!: CoverageDitherBinding;
  private oceanDither!: CoverageDitherBinding;
  private fallbackCloudTexture: THREE.DataTexture | null = null;
  private disposed = false;
  private initialized = false;
  private terrainActive = false;
  private coverageProgress = 0;

  constructor(
    private readonly body: Body,
    private readonly descriptor: Readonly<BodyMaterialDescriptor>,
    private readonly caps: Readonly<RenderCaps>,
    readonly quality: QualityTier,
  ) {
    this.bodyId = body.id;
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
    this.compactDither = installCoverageDither(compactMaterial, 'compact');
    this.compact = new THREE.Mesh(compactGeometry, compactMaterial);
    this.compact.name = `terrestrial-compact:${this.bodyId}`;
    this.compact.scale.setScalar(this.body.radius);

    const terrainMaterial = createTerrestrialGlobalMaterial(pack, this.descriptor);
    this.terrainDither = installCoverageDither(terrainMaterial, 'terrain');
    this.terrain = new PlanetRenderer(this.body, PLANET_QUALITY[this.quality], {
      material: terrainMaterial,
      oceanEnabled: false,
    });
    this.terrain.group.name = `terrestrial-terrain:${this.bodyId}`;
    this.terrain.setShadowReceiver(this.quality !== 'low');

    const visual = BODY_VISUALS[this.body.id as BodyId].atmosphereVisual!;
    this.atmosphere = new TerrestrialAtmosphere(this.body, this.caps, visual);
    const materialMap = pack?.textures.get('material') ?? null;
    this.ocean = new TerrestrialOcean(this.body, this.quality, materialMap);
    this.oceanDither = installCoverageDither(this.ocean.material, 'terrain');

    let cloudMap = pack?.textures.get('clouds') ?? null;
    if (!cloudMap) {
      this.fallbackCloudTexture = new THREE.DataTexture(
        new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat,
      );
      this.fallbackCloudTexture.colorSpace = THREE.NoColorSpace;
      this.fallbackCloudTexture.needsUpdate = true;
      cloudMap = this.fallbackCloudTexture;
    }
    this.clouds = new TerrestrialCloudDeck(this.body, this.quality, cloudMap);

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
    const origin = frame.cameraRelativeOrigin;
    this.compact.position.set(origin.x, origin.y, origin.z);
    this.compact.quaternion.set(frame.orientation.x, frame.orientation.y, frame.orientation.z, frame.orientation.w);
    this.atmosphere.update(frame);
    this.ocean.update(frame);
    this.clouds.update(frame);

    const cameraDistance = Math.hypot(frame.cameraBodyFixed.x, frame.cameraBodyFixed.y, frame.cameraBodyFixed.z);
    const prewarm = frame.allowFlightTerrain && cameraDistance < this.body.radius * PREWARM_RADIUS_MULTIPLIER;
    const visibleBand = frame.allowFlightTerrain && cameraDistance < this.body.radius * VISIBLE_RADIUS_MULTIPLIER;
    if (prewarm) {
      this.terrain.group.visible = true;
      this.terrain.update(frame.cameraBodyFixed, frame.orientation, origin);
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
  }

  private applyCoverage(progress: number, prewarm: boolean): void {
    this.coverageProgress = progress;
    this.compactDither.setProgress(progress);
    this.terrainDither.setProgress(progress);
    this.oceanDither.setProgress(progress);
    this.compact.visible = progress < 1;
    this.ocean.mesh.visible = prewarm && progress > 0;
    this.terrainActive = prewarm && progress > 0;
  }

  stats(): Readonly<BodyRendererStats> {
    if (!this.ready) return Object.freeze({ chunks: 0, visible: 0, terrainActive: false, exposure: 0 });
    return Object.freeze({
      chunks: this.terrain.stats.chunks,
      visible: this.terrainActive ? this.terrain.stats.visible : 0,
      terrainActive: this.terrainActive,
      exposure: 0,
      coverageProgress: this.coverageProgress,
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
