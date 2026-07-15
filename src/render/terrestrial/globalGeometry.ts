import * as THREE from 'three';
import type { QualityTier } from '../bodyRenderer';
import { installBodyFixedDirectionAttribute } from './globalCoordinates';

const GLOBAL_SPHERE_SEGMENTS: Readonly<Record<QualityTier, readonly [number, number]>> = Object.freeze({
  low: Object.freeze([64, 40] as const),
  medium: Object.freeze([96, 64] as const),
  high: Object.freeze([160, 96] as const),
});

export function globalSphereSegments(tier: QualityTier): readonly [number, number] {
  return GLOBAL_SPHERE_SEGMENTS[tier];
}

export function createGlobalSphereGeometry(tier: QualityTier): THREE.SphereGeometry {
  const [widthSegments, heightSegments] = globalSphereSegments(tier);
  const geometry = new THREE.SphereGeometry(1, widthSegments, heightSegments);
  installBodyFixedDirectionAttribute(geometry);
  return geometry;
}
