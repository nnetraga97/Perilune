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

const _occluderDirection = new THREE.Vector3();
const _inverseProxyRotation = new THREE.Quaternion();

export class SolarBodyRenderer implements BodyRenderer {
  readonly bodyId: string;
  readonly kind = 'star' as const;
  readonly root = new THREE.Group();
  readonly exposure = 1;
  readonly shadowLight: THREE.DirectionalLight;
  private readonly proxy = new THREE.Group();
  private readonly diskGeometry = new THREE.CircleGeometry(1, 128);
  private readonly coronaGeometry = new THREE.CircleGeometry(1.85, 128);
  private readonly diskMaterial: PhotosphereMaterial;
  private readonly coronaMaterial: CoronaMaterial;
  private readonly light = new THREE.DirectionalLight('#fff4df', 3.1);
  private readonly lastMode = 'proxy' as const;
  private lastAngularRadius = 0;
  private disposed = false;

  constructor(
    body: Body,
    descriptor: Readonly<BodyMaterialDescriptor>,
    readonly caps: Readonly<RenderCaps>,
    readonly quality: QualityTier,
  ) {
    this.bodyId = body.id;
    this.proxy.name = `solar-proxy:${body.id}`;
    this.proxy.userData.starPresentation = true;
    this.diskMaterial = createPhotosphereMaterial(descriptor.albedo.high);
    this.coronaMaterial = createCoronaMaterial();
    const disk = new THREE.Mesh(this.diskGeometry, this.diskMaterial);
    disk.renderOrder = 20;
    const corona = new THREE.Mesh(this.coronaGeometry, this.coronaMaterial);
    corona.renderOrder = 19;
    this.proxy.add(corona, disk);

    this.light.name = `solar-direct:${body.id}`;
    this.light.userData.solarDirect = true;
    this.light.castShadow = quality !== 'low';
    this.shadowLight = this.light;
    this.root.add(this.proxy, this.light, this.light.target);
  }

  get ready(): boolean { return !this.disposed; }

  stageAssets(pack: Readonly<RuntimeBodyAssetPack> | null): void {
    if (pack !== null) throw new Error(`${this.bodyId} solar renderer accepts procedural assets only`);
  }

  update(frame: Readonly<BodyRenderFrame>): void {
    if (this.disposed) return;
    const { projection } = frame;
    this.lastAngularRadius = projection.angularRadius;

    // A single angular-size-preserving proxy remains valid everywhere outside
    // the photosphere and cannot fall beyond the camera far plane.
    this.proxy.visible = projection.visibility !== 'subpixel' && projection.visibility !== 'inside';
    this.proxy.position.set(
      frame.cameraSunDirection.x * projection.proxyDepth,
      frame.cameraSunDirection.y * projection.proxyDepth,
      frame.cameraSunDirection.z * projection.proxyDepth,
    );
    this.proxy.scale.setScalar(projection.proxyRadius);
    this.proxy.lookAt(0, 0, 0);
    this.diskMaterial.uniforms.uOpacity.value = 1;
    this.diskMaterial.uniforms.uTime.value = frame.time;
    this.coronaMaterial.uniforms.uOpacity.value = 0.18;
    this.coronaMaterial.uniforms.uVisibleSolarFraction.value = frame.solarVisibleFraction;
    this.updateOccluderMask(frame);

    this.light.position.set(
      frame.cameraSunDirection.x * 1e4,
      frame.cameraSunDirection.y * 1e4,
      frame.cameraSunDirection.z * 1e4,
    );
    this.light.target.position.set(0, 0, 0);
    this.light.intensity = 3.1 * frame.solarVisibleFraction;
    this.light.target.updateMatrixWorld();
  }

  private updateOccluderMask(frame: Readonly<BodyRenderFrame>): void {
    const occluder = frame.solarOccluder;
    const tangentSolarRadius = Math.tan(frame.projection.angularRadius);
    if (!occluder || !(occluder.angularRadius > 0) || !(tangentSolarRadius > 0)) {
      this.diskMaterial.uniforms.uUseOccluder.value = 0;
      return;
    }
    _occluderDirection.set(
      occluder.direction.x,
      occluder.direction.y,
      occluder.direction.z,
    ).normalize();
    _inverseProxyRotation.copy(this.proxy.quaternion).invert();
    _occluderDirection.applyQuaternion(_inverseProxyRotation);
    const forward = -_occluderDirection.z;
    if (!(forward > 0)) {
      this.diskMaterial.uniforms.uUseOccluder.value = 0;
      return;
    }
    this.diskMaterial.uniforms.uOccluderCenter.value.set(
      _occluderDirection.x / (forward * tangentSolarRadius),
      _occluderDirection.y / (forward * tangentSolarRadius),
    );
    this.diskMaterial.uniforms.uOccluderRadius.value =
      Math.tan(occluder.angularRadius) / (forward * tangentSolarRadius);
    this.diskMaterial.uniforms.uUseOccluder.value = 1;
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
    this.coronaGeometry.dispose();
    this.diskMaterial.dispose();
    this.coronaMaterial.dispose();
    this.light.dispose();
    this.root.clear();
  }
}
