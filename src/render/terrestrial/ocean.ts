import * as THREE from 'three';
import type { Body } from '../../sim/universe';
import type { BodyRenderFrame, QualityTier } from '../bodyRenderer';
import { createOceanCapMaterial, oceanCapAngle, oceanCapSegments } from './oceanMaterial';

/**
 * Camera-anchored gnomonic ocean cap. Every generated vertex lies on the exact
 * datum sphere; local tessellation keeps triangle-chord error sub-metre during
 * landing without paying for a multi-million-triangle global sphere.
 */
export class TerrestrialOcean {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly datumRadius: number;
  private readonly anchor = new THREE.Vector3(0, 0, 1);
  private readonly east = new THREE.Vector3(1, 0, 0);
  private readonly north = new THREE.Vector3(0, 1, 0);
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
    const segments = oceanCapSegments(quality);
    const geometry = new THREE.PlaneGeometry(2, 2, segments, segments);
    const material = createOceanCapMaterial(quality, shoreMask, body.def.terrain.colorOcean, body.radius);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = `terrestrial-ocean:${body.id}`;
    this.mesh.scale.setScalar(this.datumRadius);
    this.mesh.renderOrder = 20;
    // Shader-projected vertices invalidate PlaneGeometry's local bounds.
    this.mesh.frustumCulled = false;
  }

  get material(): THREE.ShaderMaterial { return this.mesh.material; }

  update(frame: Pick<BodyRenderFrame,
    'cameraRelativeOrigin' | 'cameraBodyFixed' | 'bodySunDirection' | 'time' | 'orientation'>): void {
    if (this.disposed) return;
    const { cameraRelativeOrigin: origin, cameraBodyFixed: camera, orientation } = frame;
    this.mesh.position.set(origin.x, origin.y, origin.z);
    this.mesh.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);

    const cameraDistance = Math.hypot(camera.x, camera.y, camera.z) || 1;
    this.anchor.set(camera.x / cameraDistance, camera.y / cameraDistance, camera.z / cameraDistance);
    this.east.set(-this.anchor.y, this.anchor.x, 0);
    if (this.east.lengthSq() < 1e-12) this.east.set(1, 0, 0);
    this.east.normalize();
    this.north.crossVectors(this.anchor, this.east).normalize();

    const uniforms = this.material.uniforms;
    (uniforms.uAnchorDirection.value as THREE.Vector3).copy(this.anchor);
    (uniforms.uEast.value as THREE.Vector3).copy(this.east);
    (uniforms.uNorth.value as THREE.Vector3).copy(this.north);
    uniforms.uCapAngle.value = oceanCapAngle(this.datumRadius, cameraDistance - this.datumRadius);
    (uniforms.uCameraBodyFixed.value as THREE.Vector3).set(camera.x, camera.y, camera.z);
    (uniforms.uSunDirection.value as THREE.Vector3).set(
      frame.bodySunDirection.x,
      frame.bodySunDirection.y,
      frame.bodySunDirection.z,
    ).normalize();
    uniforms.uTime.value = frame.time;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
