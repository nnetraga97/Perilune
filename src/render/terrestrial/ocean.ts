import * as THREE from 'three';
import type { Body } from '../../sim/universe';
import type { BodyRenderFrame, QualityTier } from '../bodyRenderer';
import { createOceanMaterial } from './oceanMaterial';

export class TerrestrialOcean {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  readonly datumRadius: number;
  private disposed = false;

  constructor(
    readonly body: Body,
    readonly quality: QualityTier,
    shoreMask: THREE.Texture | null,
  ) {
    if (body.def.surfaceKind !== 'solid' || body.def.terrain.oceanLevel <= 0 || !body.def.terrain.colorOcean) {
      throw new Error(`${body.id} has no solid ocean datum`);
    }
    this.datumRadius = body.radius;
    const segments = quality === 'low' ? [64, 40] : quality === 'medium' ? [96, 64] : [128, 80];
    const geometry = new THREE.SphereGeometry(1, segments[0], segments[1]);
    const material = createOceanMaterial(quality, shoreMask, body.def.terrain.colorOcean, body.radius);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = `terrestrial-ocean:${body.id}`;
    this.mesh.scale.setScalar(this.datumRadius);
    this.mesh.renderOrder = 20;
  }

  get material(): THREE.ShaderMaterial { return this.mesh.material; }

  update(frame: Pick<BodyRenderFrame, 'cameraRelativeOrigin' | 'cameraBodyFixed' | 'bodySunDirection' | 'time'>): void {
    if (this.disposed) return;
    const { cameraRelativeOrigin: origin } = frame;
    this.mesh.position.set(origin.x, origin.y, origin.z);
    (this.material.uniforms.uCameraBodyFixed.value as THREE.Vector3).set(
      frame.cameraBodyFixed.x,
      frame.cameraBodyFixed.y,
      frame.cameraBodyFixed.z,
    );
    (this.material.uniforms.uSunDirection.value as THREE.Vector3).set(
      frame.bodySunDirection.x,
      frame.bodySunDirection.y,
      frame.bodySunDirection.z,
    ).normalize();
    this.material.uniforms.uTime.value = frame.time;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
