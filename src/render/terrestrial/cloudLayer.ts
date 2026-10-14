import * as THREE from 'three';
import type { Body } from '../../sim/universe';
import type { BodyRenderFrame, QualityTier } from '../bodyRenderer';
import { createCloudMaterial } from './cloudMaterial';
import { bodyScatteringProfile } from './aerialPerspective';
import type { RenderDiagnosticsPort } from '../renderDiagnostics';

const DRIFT_AXIS = new THREE.Vector3(0, 0, 1);
const DRIFT_QUATERNION = new THREE.Quaternion();
const INVERSE_DRIFT_QUATERNION = new THREE.Quaternion();
const CAMERA_CLOUD_FIXED = new THREE.Vector3();
const SUN_CLOUD_FIXED = new THREE.Vector3();
export const WEATHER_CLOUD_DRIFT_RATE = 9e-6;

export interface TerrestrialCloudShell {
  readonly name: 'weather' | 'wisps';
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  readonly altitude: number;
  readonly driftRate: number;
  readonly baseOpacity: number;
}

export class TerrestrialCloudDeck {
  readonly group = new THREE.Group();
  readonly shells: readonly [TerrestrialCloudShell, TerrestrialCloudShell];
  private disposed = false;
  private lastDiagnosticObservationAt = Number.NEGATIVE_INFINITY;

  constructor(
    readonly body: Body,
    readonly quality: QualityTier,
    cloudTexture: THREE.Texture,
    private readonly diagnostics?: RenderDiagnosticsPort,
    private readonly diagnosticSource: string = `clouds:${body.id}`,
    maxAnisotropy = 1,
  ) {
    if (!body.def.atmosphere) throw new Error(`${body.id} has no atmosphere for clouds`);
    const requestedAnisotropy = quality === 'low' ? 2 : quality === 'medium' ? 4 : 8;
    cloudTexture.anisotropy = Math.max(1, Math.min(maxAnisotropy, requestedAnisotropy));
    cloudTexture.needsUpdate = true;
    const makeShell = (
      name: TerrestrialCloudShell['name'],
      altitudeFraction: number,
      driftRate: number,
      textureScale: number,
      opacity: number,
      parallaxStrength: number,
      segments: readonly [number, number],
    ): TerrestrialCloudShell => {
      const volumetric = quality === 'high' && name === 'weather';
      const volumeBaseAltitude = body.def.atmosphere!.height * 0.04;
      const volumeTopAltitude = body.def.atmosphere!.height * 0.18;
      const altitude = volumetric ? volumeTopAltitude : body.def.atmosphere!.height * altitudeFraction;
      const shellRadius = body.radius + altitude;
      const geometry = new THREE.SphereGeometry(1, segments[0], segments[1]);
      const material = createCloudMaterial(cloudTexture, {
        textureScale,
        opacity,
        tint: name === 'weather' ? '#e9edf0' : '#d7e1e8',
        shellRadius,
        parallaxStrength,
        scattering: bodyScatteringProfile(body) ?? undefined,
        volume: volumetric ? {
          baseRadius: body.radius + volumeBaseAltitude,
          topRadius: body.radius + volumeTopAltitude,
          // Tangent rays traverse a long distance through a thin layer. A
          // 12-step march exposes its radial slices as horizontal horizon
          // lines; High spends the extra samples to keep the volume smooth.
          samples: quality === 'high' ? 24 : 6,
          noiseOctaves: quality === 'high' ? 3 : 2,
        } : undefined,
      });
      material.name = `terrestrial-cloud:${name}`;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `terrestrial-cloud:${body.id}:${name}`;
      mesh.scale.setScalar(shellRadius);
      // Default launch ordering: render the farther outer wisps first.
      mesh.renderOrder = name === 'wisps' ? 30 : 31;
      this.diagnostics?.record({
        subsystem: 'clouds',
        event: 'cloud-shell-created',
        severity: 'state',
        data: {
          body: body.id,
          quality,
          shell: name,
          radius: shellRadius,
          shellAltitude: altitude,
          geometryType: geometry.type,
          widthSegments: segments[0],
          heightSegments: segments[1],
          side: 'front',
          renderOrder: mesh.renderOrder,
          baseOpacity: opacity,
          textureIdentity: cloudTexture.uuid,
          wrapS: cloudTexture.wrapS,
          wrapT: cloudTexture.wrapT,
          minFilter: cloudTexture.minFilter,
          magFilter: cloudTexture.magFilter,
          anisotropy: cloudTexture.anisotropy,
          colorSpace: cloudTexture.colorSpace,
          textureScale,
          shadowMaterial: false,
          cloudModel: material.userData.cloudModel,
          volumeBaseAltitude: volumetric ? volumeBaseAltitude : null,
          volumeTopAltitude: volumetric ? volumeTopAltitude : null,
        },
      }, { bodyId: body.id });
      return Object.freeze({ name, mesh, altitude, driftRate, baseOpacity: opacity });
    };
    // Tangent views amplify interpolation error on a sphere. Keep cloud shells
    // at the atmosphere-shell tessellation so triangle latitude bands cannot
    // become radial streaks along a ground/ocean horizon.
    const segments: readonly [number, number] = quality === 'low'
      ? [96, 64]
      : quality === 'medium' ? [144, 96] : [192, 128];
    this.shells = Object.freeze([
      makeShell('weather', 0.11, WEATHER_CLOUD_DRIFT_RATE, 1, quality === 'high' ? 0.9 : quality === 'medium' ? 0.68 : 0.6, 0.009, segments),
      makeShell('wisps', 0.22, -3.5e-6, 2.4, 0.14, 0.004, segments),
    ]) as unknown as readonly [TerrestrialCloudShell, TerrestrialCloudShell];
    this.group.name = `terrestrial-cloud-deck:${body.id}`;
    this.group.add(this.shells[0].mesh, this.shells[1].mesh);
  }

  update(frame: Pick<BodyRenderFrame, 'cameraRelativeOrigin' | 'cameraBodyFixed' | 'orientation' | 'bodySunDirection' | 'time' | 'altitude'> &
    { readonly solarVisibleFraction?: number }): void {
    if (this.disposed) return;
    const origin = frame.cameraRelativeOrigin;
    this.group.position.set(origin.x, origin.y, origin.z);
    const diagnosticNow = performance.now();
    const diagnosticDue = this.diagnostics !== undefined
      && (this.diagnostics.detailed || diagnosticNow - this.lastDiagnosticObservationAt >= 100);
    const outsideDeck = frame.altitude >= this.shells[1].altitude;
    // Back-to-front ordering reverses when the camera moves outside both shells.
    this.shells[0].mesh.renderOrder = outsideDeck ? 30 : 31;
    this.shells[1].mesh.renderOrder = outsideDeck ? 31 : 30;
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
      shell.mesh.material.uniforms.uSolarVisibility.value = Math.max(0, Math.min(1, frame.solarVisibleFraction ?? 1));
      INVERSE_DRIFT_QUATERNION.copy(DRIFT_QUATERNION).invert();
      CAMERA_CLOUD_FIXED.set(
        frame.cameraBodyFixed.x,
        frame.cameraBodyFixed.y,
        frame.cameraBodyFixed.z,
      ).applyQuaternion(INVERSE_DRIFT_QUATERNION);
      (shell.mesh.material.uniforms.uCameraCloudFixed.value as THREE.Vector3).copy(CAMERA_CLOUD_FIXED);
      // Shade in the same drifting frame the cloud texture is sampled in.
      SUN_CLOUD_FIXED.set(
        frame.bodySunDirection.x,
        frame.bodySunDirection.y,
        frame.bodySunDirection.z,
      ).normalize().applyQuaternion(INVERSE_DRIFT_QUATERNION);
      (shell.mesh.material.uniforms.uSunCloudFixed.value as THREE.Vector3).copy(SUN_CLOUD_FIXED);
      shell.mesh.material.uniforms.uTime.value = frame.time;
      const distanceFromShell = Math.abs(frame.altitude - shell.altitude);
      const crossingFade = Math.max(0, Math.min(1, (distanceFromShell - 1_200) / 4_000));
      // The bounded High march is stable from within/above the weather deck,
      // but very long tangent rays from ground level expose discrete radial
      // slices. Fade that volume below its base and leave the outer parallax
      // wisps to carry distant cloud presence until a ground-space volume pass
      // exists.
      const groundVolumeFade = this.quality === 'high' && shell.name === 'weather'
        ? Math.max(0, Math.min(1, (frame.altitude - 1_000) / 4_000))
        : 1;
      shell.mesh.material.uniforms.uOpacity.value = shell.baseOpacity * crossingFade * groundVolumeFade;
      const desiredSide = frame.altitude >= shell.altitude ? THREE.FrontSide : THREE.BackSide;
      if (shell.mesh.material.side !== desiredSide) {
        shell.mesh.material.side = desiredSide;
        shell.mesh.material.needsUpdate = true;
      }
      if (diagnosticDue) {
        const signedDistance = frame.altitude - shell.altitude;
        const classification = Math.abs(signedDistance) <= 5_200
          ? 'crossing'
          : signedDistance >= 0 ? 'outside' : 'inside';
        const opacity = shell.mesh.material.uniforms.uOpacity.value as number;
        const texture = shell.mesh.material.uniforms.uCloudMap.value as THREE.Texture;
        this.diagnostics?.observeCloudShell?.({
          simulationTime: frame.time,
          bodyId: this.body.id,
          rendererIdentity: this.diagnosticSource,
          altitudeMeters: frame.altitude,
          shell: shell.name,
          classification,
          radius: this.body.radius + shell.altitude,
          shellAltitude: shell.altitude,
          signedDistance,
          opacity,
          baseOpacity: shell.baseOpacity,
          side: shell.mesh.material.side === THREE.FrontSide ? 'front'
            : shell.mesh.material.side === THREE.BackSide ? 'back'
              : shell.mesh.material.side === THREE.DoubleSide ? 'double' : 'unknown',
          materialVersion: shell.mesh.material.version,
          textureIdentity: texture.uuid,
          visible: shell.mesh.visible && this.group.visible,
          renderOrder: shell.mesh.renderOrder,
          driftAngle: frame.time * shell.driftRate,
        });
      }
    }
    if (diagnosticDue) this.lastDiagnosticObservationAt = diagnosticNow;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const shell of this.shells) {
      this.diagnostics?.record({
        subsystem: 'clouds', event: 'cloud-shell-disposed', severity: 'state',
        data: { body: this.body.id, quality: this.quality, shell: shell.name },
      }, { bodyId: this.body.id });
      shell.mesh.geometry.dispose();
      shell.mesh.material.dispose();
    }
    this.group.clear();
  }
}
