import * as THREE from 'three';
import type { Body } from '../sim/universe';
import type { RenderCaps } from './context';
import type { BodyMaterialDescriptor } from './bodyMaterial';
import type {
  BodyRenderer,
  BodyRendererStats,
  BodyRenderFrame,
  QualityTier,
  RuntimeBodyAssetPack,
} from './bodyRenderer';
import { createCoronaMaterial, type CoronaMaterial } from './solar/coronaMaterial';
import { createPhotosphereMaterial, type PhotosphereMaterial } from './solar/photosphereMaterial';
import { solarPresentationBlend } from './solar/solarPresentation';

export class SolarBodyRenderer implements BodyRenderer {
  readonly bodyId: string;
  readonly kind = 'star' as const;
  readonly root = new THREE.Group();
  readonly exposure = 1;
  private readonly proxy = new THREE.Group();
  private readonly physical = new THREE.Group();
  private readonly diskGeometry = new THREE.CircleGeometry(1, 128);
  private readonly sphereGeometry: THREE.SphereGeometry;
  private readonly coronaGeometry = new THREE.CircleGeometry(1.85, 128);
  private readonly diskMaterial: PhotosphereMaterial;
  private readonly sphereMaterial: PhotosphereMaterial;
  private readonly coronaMaterial: CoronaMaterial;
  private readonly light = new THREE.DirectionalLight('#fff4df', 3.1);
  private lastMode: 'physical' | 'transition' | 'proxy' = 'proxy';
  private lastAngularRadius = 0;
  private disposed = false;

  constructor(
    private readonly body: Body,
    descriptor: Readonly<BodyMaterialDescriptor>,
    readonly caps: Readonly<RenderCaps>,
    readonly quality: QualityTier,
  ) {
    this.bodyId = body.id;
    this.proxy.name = `solar-proxy:${body.id}`;
    this.proxy.userData.starPresentation = true;
    this.physical.name = `solar-physical:${body.id}`;
    this.diskMaterial = createPhotosphereMaterial(descriptor.albedo.high);
    this.sphereMaterial = createPhotosphereMaterial(descriptor.albedo.high);
    this.sphereMaterial.uniforms.uSphereMode.value = 1;
    this.coronaMaterial = createCoronaMaterial();
    const disk = new THREE.Mesh(this.diskGeometry, this.diskMaterial);
    disk.renderOrder = 20;
    const corona = new THREE.Mesh(this.coronaGeometry, this.coronaMaterial);
    corona.renderOrder = 19;
    this.proxy.add(corona, disk);

    const segments = quality === 'low' ? 48 : quality === 'medium' ? 96 : 128;
    this.sphereGeometry = new THREE.SphereGeometry(1, segments, Math.max(32, segments / 2));
    this.physical.add(new THREE.Mesh(this.sphereGeometry, this.sphereMaterial));
    this.light.name = `solar-direct:${body.id}`;
    this.light.userData.solarDirect = true;
    this.light.castShadow = quality !== 'low';
    this.root.add(this.proxy, this.physical, this.light, this.light.target);
  }

  get ready(): boolean { return !this.disposed; }

  stageAssets(pack: Readonly<RuntimeBodyAssetPack> | null): void {
    if (pack !== null) throw new Error(`${this.bodyId} solar renderer accepts procedural assets only`);
  }

  update(frame: Readonly<BodyRenderFrame>): void {
    if (this.disposed) return;
    const { projection } = frame;
    const distanceInRadii = projection.trueObserverDistance / this.body.radius;
    const blend = solarPresentationBlend(distanceInRadii);
    this.lastMode = blend.mode;
    this.lastAngularRadius = projection.angularRadius;

    this.proxy.visible = blend.proxyOpacity > 0 && projection.visibility !== 'subpixel';
    this.proxy.position.set(
      frame.cameraSunDirection.x * projection.proxyDepth,
      frame.cameraSunDirection.y * projection.proxyDepth,
      frame.cameraSunDirection.z * projection.proxyDepth,
    );
    this.proxy.scale.setScalar(projection.proxyRadius);
    this.proxy.lookAt(0, 0, 0);
    this.diskMaterial.uniforms.uOpacity.value = blend.proxyOpacity;
    this.diskMaterial.uniforms.uTime.value = frame.time;
    this.coronaMaterial.uniforms.uOpacity.value = 0.18 * blend.proxyOpacity;
    this.coronaMaterial.uniforms.uVisibleSolarFraction.value = frame.solarVisibleFraction;

    this.physical.visible = blend.physicalOpacity > 0;
    this.physical.position.set(
      frame.cameraRelativeOrigin.x,
      frame.cameraRelativeOrigin.y,
      frame.cameraRelativeOrigin.z,
    );
    this.physical.scale.setScalar(this.body.radius);
    this.sphereMaterial.uniforms.uOpacity.value = blend.physicalOpacity;
    this.sphereMaterial.uniforms.uTime.value = frame.time;

    this.light.position.set(
      frame.cameraSunDirection.x * 1e4,
      frame.cameraSunDirection.y * 1e4,
      frame.cameraSunDirection.z * 1e4,
    );
    this.light.target.position.set(0, 0, 0);
    this.light.intensity = 3.1 * frame.solarVisibleFraction;
    this.light.target.updateMatrixWorld();
  }

  stats(): Readonly<BodyRendererStats> {
    return Object.freeze({
      chunks: 0,
      visible: this.disposed || !this.root.visible ? 0 : 1,
      terrainActive: false,
      exposure: this.disposed ? 0 : this.exposure,
      presentationMode: this.lastMode,
      angularRadius: this.lastAngularRadius,
      assetTier: 'procedural',
      assetBytes: 0,
      lutBytes: 0,
      cloudHistoryBytes: 0,
      heightCacheBytes: 0,
      shadowBytes: this.quality === 'low' ? 0 : (this.quality === 'high' ? 2048 : 1024) ** 2 * 4,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.diskGeometry.dispose();
    this.sphereGeometry.dispose();
    this.coronaGeometry.dispose();
    this.diskMaterial.dispose();
    this.sphereMaterial.dispose();
    this.coronaMaterial.dispose();
    this.light.dispose();
    this.root.clear();
  }
}
