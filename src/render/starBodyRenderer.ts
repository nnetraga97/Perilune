import * as THREE from 'three';
import type { Body } from '../sim/universe';
import type { RenderCaps } from './context';
import type { BodyMaterialDescriptor } from './bodyMaterial';
import type { BodyRenderer, BodyRendererStats, BodyRenderFrame, QualityTier, RuntimeBodyAssetPack } from './bodyRenderer';

export class StarBodyRenderer implements BodyRenderer {
  readonly bodyId: string;
  readonly kind = 'star' as const;
  readonly root = new THREE.Group();
  readonly exposure = 1;
  private readonly presentation = new THREE.Group();
  private readonly diskGeometry: THREE.CircleGeometry;
  private readonly diskMaterial: THREE.MeshBasicMaterial;
  private readonly coronaTexture: THREE.DataTexture;
  private readonly sourceMaterial: THREE.SpriteMaterial;
  private readonly corona: THREE.Sprite;
  private readonly light: THREE.DirectionalLight;
  private disposed = false;

  constructor(
    body: Body,
    descriptor: Readonly<BodyMaterialDescriptor>,
    readonly caps: Readonly<RenderCaps>,
    readonly quality: QualityTier,
  ) {
    this.bodyId = body.id;
    this.presentation.userData.starPresentation = true;
    this.diskGeometry = new THREE.CircleGeometry(1, 64);
    this.diskMaterial = new THREE.MeshBasicMaterial({ color: descriptor.albedo.mid, side: THREE.DoubleSide });
    this.presentation.add(new THREE.Mesh(this.diskGeometry, this.diskMaterial));
    const coronaSize = 16;
    const coronaData = new Uint8Array(coronaSize * coronaSize * 4);
    const center = (coronaSize - 1) / 2;
    for (let y = 0; y < coronaSize; y++) {
      for (let x = 0; x < coronaSize; x++) {
        const offset = (y * coronaSize + x) * 4;
        const radius = Math.hypot(x - center, y - center) / center;
        const alpha = Math.max(0, 1 - radius);
        coronaData[offset] = 255;
        coronaData[offset + 1] = 247;
        coronaData[offset + 2] = 221;
        coronaData[offset + 3] = Math.round(alpha * alpha * 255);
      }
    }
    this.coronaTexture = new THREE.DataTexture(coronaData, coronaSize, coronaSize);
    this.coronaTexture.needsUpdate = true;
    this.sourceMaterial = new THREE.SpriteMaterial({
      color: descriptor.albedo.mid,
      map: this.coronaTexture,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: false,
    });
    this.corona = new THREE.Sprite(this.sourceMaterial);
    this.corona.scale.setScalar(2.4);
    this.presentation.add(this.corona);
    this.presentation.scale.setScalar(Math.max(body.radius * 0.06, 4e6));
    this.light = new THREE.DirectionalLight('#fff4e0', 2.6);
    this.root.add(this.presentation, this.light, this.light.target);
  }

  get ready(): boolean { return !this.disposed; }

  stageAssets(pack: Readonly<RuntimeBodyAssetPack> | null): void {
    if (pack !== null) throw new Error(`${this.bodyId} star renderer accepts procedural assets only`);
  }

  update(frame: Readonly<BodyRenderFrame>): void {
    if (this.disposed) return;
    const actualDistance = Math.hypot(
      frame.cameraRelativeOrigin.x,
      frame.cameraRelativeOrigin.y,
      frame.cameraRelativeOrigin.z,
    );
    const visibleDistance = Math.min(actualDistance, 3e8);
    this.presentation.position.set(
      frame.cameraSunDirection.x * visibleDistance,
      frame.cameraSunDirection.y * visibleDistance,
      frame.cameraSunDirection.z * visibleDistance,
    );
    this.presentation.lookAt(0, 0, 0);
    this.light.position.set(
      frame.cameraSunDirection.x * 1e4,
      frame.cameraSunDirection.y * 1e4,
      frame.cameraSunDirection.z * 1e4,
    );
    this.light.target.position.set(0, 0, 0);
    this.light.target.updateMatrixWorld();
  }

  stats(): Readonly<BodyRendererStats> {
    return Object.freeze({ chunks: 0, visible: 0, terrainActive: false, exposure: this.disposed ? 0 : this.exposure });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.coronaTexture.dispose();
    this.sourceMaterial.dispose();
    this.diskGeometry.dispose();
    this.diskMaterial.dispose();
    this.root.clear();
  }
}
