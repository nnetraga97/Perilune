import * as THREE from 'three';
import type { Body } from '../../sim/universe';
import type { BodyRenderFrame, QualityTier } from '../bodyRenderer';
import { createCloudMaterial, createCloudShadowMaterial } from './cloudMaterial';
import type { RenderDiagnosticsPort } from '../renderDiagnostics';

const DRIFT_AXIS = new THREE.Vector3(0, 0, 1);
const DRIFT_QUATERNION = new THREE.Quaternion();

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
  private shadowRequested = true;

  constructor(
    readonly body: Body,
    readonly quality: QualityTier,
    cloudTexture: THREE.Texture,
    private readonly diagnostics?: RenderDiagnosticsPort,
    private readonly diagnosticSource: string = `clouds:${body.id}`,
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
      // Outside the deck, render the outer transparent shell before the inner.
      mesh.renderOrder = name === 'wisps' ? 30 : 31;
      if (name === 'weather' && quality !== 'low') {
        mesh.customDepthMaterial = createCloudShadowMaterial(cloudTexture, textureScale);
      }
      this.diagnostics?.record({
        subsystem: 'clouds',
        event: 'cloud-shell-created',
        severity: 'state',
        data: {
          body: body.id,
          quality,
          shell: name,
          radius: body.radius + altitude,
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
          shadowMaterial: mesh.customDepthMaterial !== undefined,
        },
      }, { bodyId: body.id });
      return Object.freeze({ name, mesh, altitude, driftRate, baseOpacity: opacity });
    };
    const segments: readonly [number, number] = quality === 'low' ? [48, 30] : quality === 'medium' ? [72, 44] : [96, 60];
    this.shells = Object.freeze([
      makeShell('weather', 0.11, 9e-6, 1, 0.46, segments),
      makeShell('wisps', 0.22, -3.5e-6, 3, 0.2, segments),
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

  update(frame: Pick<BodyRenderFrame, 'cameraRelativeOrigin' | 'orientation' | 'bodySunDirection' | 'time' | 'altitude'>): void {
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
      const distanceFromShell = Math.abs(frame.altitude - shell.altitude);
      const crossingFade = Math.max(0, Math.min(1, (distanceFromShell - 1_200) / 4_000));
      shell.mesh.material.uniforms.uOpacity.value = shell.baseOpacity * crossingFade;
      const desiredSide = frame.altitude >= shell.altitude ? THREE.FrontSide : THREE.BackSide;
      if (shell.mesh.material.side !== desiredSide) {
        shell.mesh.material.side = desiredSide;
        shell.mesh.material.needsUpdate = true;
      }
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
      shell.mesh.customDepthMaterial?.dispose();
    }
    this.group.clear();
  }
}
