import * as THREE from 'three';
import type { Body } from '../../sim/universe';
import type { BodyRenderFrame, QualityTier } from '../bodyRenderer';
import type { RenderCaps } from '../context';
import {
  createAtmosphereMaterial,
  type AtmosphereVisualCoefficients,
} from './atmosphereMaterial';

export class TerrestrialAtmosphere {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  readonly path: RenderCaps['atmospherePath'];
  readonly shellRadius: number;
  private readonly lookupTextures: readonly THREE.DataTexture[];
  readonly aerialPerspectiveTexture: THREE.DataTexture;
  private disposed = false;

  constructor(
    readonly body: Body,
    caps: Pick<RenderCaps, 'atmospherePath'>,
    visual: Readonly<AtmosphereVisualCoefficients>,
    quality: QualityTier = 'medium',
  ) {
    const physical = body.def.atmosphere;
    if (!physical) throw new Error(`${body.id} has no physical atmosphere`);
    this.path = caps.atmospherePath;
    this.shellRadius = body.radius + physical.height;
    const bundle = createAtmosphereMaterial(this.path, body.radius, physical, visual, quality);
    this.lookupTextures = bundle.lookupTextures;
    this.aerialPerspectiveTexture = bundle.material.uniforms.uAerialPerspectiveLut.value as THREE.DataTexture;
    const shellSegments = quality === 'high'
      ? [192, 128] as const
      : quality === 'medium'
        ? [144, 96] as const
        : [96, 64] as const;
    const geometry = new THREE.SphereGeometry(1, shellSegments[0], shellSegments[1]);
    this.mesh = new THREE.Mesh(geometry, bundle.material);
    this.mesh.name = `terrestrial-atmosphere:${body.id}`;
    this.mesh.scale.setScalar(this.shellRadius);
    this.mesh.renderOrder = 40;
    this.mesh.frustumCulled = true;
  }

  get material(): THREE.ShaderMaterial { return this.mesh.material; }

  get lookupBytes(): number {
    return this.lookupTextures.reduce((total, texture) => {
      const data = texture.image?.data as ArrayBufferView | undefined;
      return total + (data?.byteLength ?? 0);
    }, 0);
  }

  update(frame: Pick<BodyRenderFrame, 'cameraRelativeOrigin' | 'cameraBodyFixed' | 'bodySunDirection'> &
    { readonly solarVisibleFraction?: number }): void {
    if (this.disposed) return;
    const { cameraRelativeOrigin: origin, cameraBodyFixed, bodySunDirection: sunDirection } = frame;
    this.mesh.position.set(origin.x, origin.y, origin.z);
    const camera = this.material.uniforms.uCameraBodyFixed.value as THREE.Vector3;
    camera.set(cameraBodyFixed.x, cameraBodyFixed.y, cameraBodyFixed.z);
    const sun = this.material.uniforms.uSunDirection.value as THREE.Vector3;
    sun.set(sunDirection.x, sunDirection.y, sunDirection.z).normalize();
    const cameraRadius = Math.hypot(cameraBodyFixed.x, cameraBodyFixed.y, cameraBodyFixed.z);
    const inside = cameraRadius < this.shellRadius;
    this.material.uniforms.uInsideAtmosphere.value = inside ? 1 : 0;
    this.material.uniforms.uSolarVisibility.value = Math.max(0, Math.min(1, frame.solarVisibleFraction ?? 1));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    for (const texture of this.lookupTextures) texture.dispose();
  }
}
