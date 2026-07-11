import * as THREE from 'three';
import type { Body } from '../../sim/universe';
import type { BodyRenderFrame, QualityTier } from '../bodyRenderer';
import { createCloudMaterial, createCloudShadowMaterial } from './cloudMaterial';

const DRIFT_AXIS = new THREE.Vector3(0, 0, 1);
const DRIFT_QUATERNION = new THREE.Quaternion();

export interface TerrestrialCloudShell {
  readonly name: 'weather' | 'wisps';
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  readonly altitude: number;
  readonly driftRate: number;
}

export class TerrestrialCloudDeck {
  readonly group = new THREE.Group();
  readonly shells: readonly [TerrestrialCloudShell, TerrestrialCloudShell];
  private disposed = false;
  private shadowRequested = true;

  constructor(
    readonly body: Body,
    readonly quality: QualityTier,
    cloudTexture: THREE.Texture,
  ) {
    if (!body.def.atmosphere) throw new Error(`${body.id} has no atmosphere for clouds`);
    const makeShell = (
      name: TerrestrialCloudShell['name'],
      altitudeFraction: number,
      driftRate: number,
      textureScale: number,
      opacity: number,
      segments: readonly [number, number],
    ): TerrestrialCloudShell => {
      const altitude = body.def.atmosphere!.height * altitudeFraction;
      const geometry = new THREE.SphereGeometry(1, segments[0], segments[1]);
      const material = createCloudMaterial(cloudTexture, {
        textureScale,
        opacity,
        tint: name === 'weather' ? '#e9edf0' : '#d7e1e8',
      });
      material.name = `terrestrial-cloud:${name}`;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `terrestrial-cloud:${body.id}:${name}`;
      mesh.scale.setScalar(body.radius + altitude);
      mesh.renderOrder = name === 'weather' ? 30 : 31;
      if (name === 'weather' && quality !== 'low') {
        mesh.customDepthMaterial = createCloudShadowMaterial(cloudTexture, textureScale);
      }
      return Object.freeze({ name, mesh, altitude, driftRate });
    };
    const segments: readonly [number, number] = quality === 'low' ? [48, 30] : quality === 'medium' ? [72, 44] : [96, 60];
    this.shells = Object.freeze([
      makeShell('weather', 0.11, 9e-6, 1, 0.88, segments),
      makeShell('wisps', 0.22, -3.5e-6, 3, 0.42, segments),
    ]) as unknown as readonly [TerrestrialCloudShell, TerrestrialCloudShell];
    this.group.name = `terrestrial-cloud-deck:${body.id}`;
    this.group.add(this.shells[0].mesh, this.shells[1].mesh);
    this.applyShadowPolicy();
  }

  setShadowEnabled(enabled: boolean): void {
    this.shadowRequested = enabled;
    this.applyShadowPolicy();
  }

  private applyShadowPolicy(): void {
    this.shells[0].mesh.castShadow = this.quality !== 'low' && this.shadowRequested;
    this.shells[1].mesh.castShadow = false;
  }

  update(frame: Pick<BodyRenderFrame, 'cameraRelativeOrigin' | 'orientation' | 'bodySunDirection' | 'time'>): void {
    if (this.disposed) return;
    const origin = frame.cameraRelativeOrigin;
    this.group.position.set(origin.x, origin.y, origin.z);
    for (const shell of this.shells) {
      DRIFT_QUATERNION.setFromAxisAngle(DRIFT_AXIS, frame.time * shell.driftRate);
      shell.mesh.quaternion
        .set(frame.orientation.x, frame.orientation.y, frame.orientation.z, frame.orientation.w)
        .multiply(DRIFT_QUATERNION);
      (shell.mesh.material.uniforms.uSunDirection.value as THREE.Vector3).set(
        frame.bodySunDirection.x,
        frame.bodySunDirection.y,
        frame.bodySunDirection.z,
      ).normalize();
      shell.mesh.material.uniforms.uTime.value = frame.time;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const shell of this.shells) {
      shell.mesh.geometry.dispose();
      shell.mesh.material.dispose();
      shell.mesh.customDepthMaterial?.dispose();
    }
    this.group.clear();
  }
}
