import type { VectorCoordinates } from './bodyRenderer';

export type CelestialVisibility = 'inside' | 'physical' | 'far-field' | 'subpixel';

export interface CelestialProjection {
  readonly trueObserverDistance: number;
  readonly angularRadius: number;
  readonly projectedPixelRadius: number;
  readonly proxyDepth: number;
  readonly proxyRadius: number;
  /** Opacity weights for the far-plane-safe physical-to-proxy handoff. */
  readonly physicalOpacity?: number;
  readonly proxyOpacity?: number;
  readonly visibility: CelestialVisibility;
}

export interface CelestialProjectionInput {
  readonly centerRelative: Readonly<VectorCoordinates>;
  readonly bodyRadius: number;
  readonly verticalFovRadians: number;
  readonly drawingBufferHeight: number;
  readonly physicalFarMeters: number;
  readonly farField: boolean;
  readonly preferredProxyDepth?: number;
  readonly subpixelRadius?: number;
}

export function angularRadius(bodyRadius: number, observerDistance: number): number {
  if (!Number.isFinite(bodyRadius) || bodyRadius <= 0) throw new Error('Body radius must be finite and positive');
  if (!Number.isFinite(observerDistance) || observerDistance < 0) {
    throw new Error('Observer distance must be finite and non-negative');
  }
  if (observerDistance <= bodyRadius) return Math.PI / 2;
  return Math.asin(Math.min(1, bodyRadius / observerDistance));
}

export function projectedPixelRadius(
  angularRadiusRadians: number,
  verticalFovRadians: number,
  drawingBufferHeight: number,
): number {
  if (!(verticalFovRadians > 0 && verticalFovRadians < Math.PI)) {
    throw new Error('Vertical field of view must be within (0, pi)');
  }
  if (!Number.isFinite(drawingBufferHeight) || drawingBufferHeight <= 0) {
    throw new Error('Drawing-buffer height must be finite and positive');
  }
  if (angularRadiusRadians >= Math.PI / 2) return Infinity;
  return drawingBufferHeight * Math.tan(angularRadiusRadians) / (2 * Math.tan(verticalFovRadians / 2));
}

function smoothstep(minimum: number, maximum: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  return t * t * (3 - 2 * t);
}

export function computeCelestialProjection(
  input: Readonly<CelestialProjectionInput>,
): CelestialProjection {
  const distance = Math.hypot(input.centerRelative.x, input.centerRelative.y, input.centerRelative.z);
  const theta = angularRadius(input.bodyRadius, distance);
  const pixelRadius = projectedPixelRadius(theta, input.verticalFovRadians, input.drawingBufferHeight);
  const maximumProxyDepth = Math.max(1, input.physicalFarMeters * 0.75);
  const requestedProxyDepth = input.preferredProxyDepth ?? input.physicalFarMeters * 0.5;
  const proxyDepth = Math.min(maximumProxyDepth, Math.max(1, requestedProxyDepth));
  const proxyRadius = theta >= Math.PI / 2 ? Infinity : proxyDepth * Math.tan(theta);
  const subpixelRadius = input.subpixelRadius ?? 0.25;
  const visibility: CelestialVisibility = distance <= input.bodyRadius
    ? 'inside'
    : pixelRadius < subpixelRadius
      ? 'subpixel'
      : input.farField || distance - input.bodyRadius > input.physicalFarMeters
        ? 'far-field'
        : 'physical';
  const surfaceDistance = Math.max(0, distance - input.bodyRadius);
  const proxyOpacity = visibility === 'inside'
    ? 0
    : input.farField || visibility === 'subpixel'
      ? 1
      : smoothstep(input.physicalFarMeters * 0.85, input.physicalFarMeters, surfaceDistance);
  const physicalOpacity = visibility === 'inside' ? 0 : 1 - proxyOpacity;
  return Object.freeze({
    trueObserverDistance: distance,
    angularRadius: theta,
    projectedPixelRadius: pixelRadius,
    proxyDepth,
    proxyRadius,
    physicalOpacity,
    proxyOpacity,
    visibility,
  });
}
