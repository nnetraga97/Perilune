import * as THREE from 'three';
import type { QualityTier } from './bodyRenderer';

export {
  adaptExposure,
  createEnvironmentLightingState,
  environmentLighting,
  landingVisibilityAid,
} from './exposurePolicy';
export type {
  EnvironmentLighting,
  LandingVisibilityAid,
  MutableEnvironmentLighting,
} from './exposurePolicy';

const _shadowForward = new THREE.Vector3();
const _shadowReferenceUp = new THREE.Vector3();
const _shadowRight = new THREE.Vector3();
const _shadowUp = new THREE.Vector3();

export interface ShadowPolicy {
  readonly enabled: boolean;
  readonly mapSize: number;
  readonly extent: number;
  readonly lightDistance: number;
  readonly near: number;
  readonly far: number;
  readonly bias: number;
  readonly normalBias: number;
}

export function localShadowPolicy(
  quality: QualityTier,
  cameraDistance: number,
  altitude: number,
): ShadowPolicy {
  const enabled = quality !== 'low';
  const extent = THREE.MathUtils.clamp(
    Math.max(96, cameraDistance * 4, Math.max(0, altitude) * 0.35),
    96,
    quality === 'high' ? 18_000 : 12_000,
  );
  const lightDistance = Math.max(24_000, extent * 1.5);
  return Object.freeze({
    enabled,
    mapSize: quality === 'high' ? 2048 : quality === 'medium' ? 1024 : 0,
    extent,
    lightDistance,
    near: Math.max(10, lightDistance - extent * 2),
    far: lightDistance + extent * 2,
    bias: -Math.max(0.00002, 0.00012 * extent / 12_000),
    normalBias: Math.max(0.015, 0.12 * extent / 12_000),
  });
}

/**
 * Stabilize the local shadow footprint in light space. The scene is camera
 * relative, so the active craft is already close to the origin; only the
 * sub-texel craft offset needs snapping.
 */
export function snapShadowCenter(
  center: Readonly<THREE.Vector3>,
  lightDirection: Readonly<THREE.Vector3>,
  extent: number,
  mapSize: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  if (!(mapSize > 0)) return out.copy(center);
  const forward = _shadowForward.copy(lightDirection).normalize();
  const referenceUp = Math.abs(forward.z) < 0.9
    ? _shadowReferenceUp.set(0, 0, 1)
    : _shadowReferenceUp.set(0, 1, 0);
  const right = _shadowRight.crossVectors(referenceUp, forward).normalize();
  const up = _shadowUp.crossVectors(forward, right).normalize();
  const texel = (extent * 2) / mapSize;
  const rightOffset = Math.round(right.dot(center) / texel) * texel;
  const upOffset = Math.round(up.dot(center) / texel) * texel;
  const forwardOffset = forward.dot(center);
  return out.copy(right).multiplyScalar(rightOffset)
    .addScaledVector(up, upOffset)
    .addScaledVector(forward, forwardOffset);
}
