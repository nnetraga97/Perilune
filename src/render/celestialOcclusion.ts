import type { VectorCoordinates } from './bodyRenderer';

export interface AngularDisk {
  readonly direction: Readonly<VectorCoordinates>;
  readonly angularRadius: number;
}

export interface CelestialOcclusion {
  readonly angularSeparation: number;
  readonly overlapAreaRadians2: number;
  readonly sourceVisibleFraction: number;
  readonly intersects: boolean;
  readonly total: boolean;
}

function normalizedDot(a: Readonly<VectorCoordinates>, b: Readonly<VectorCoordinates>): number {
  const aLength = Math.hypot(a.x, a.y, a.z);
  const bLength = Math.hypot(b.x, b.y, b.z);
  if (!(aLength > 0 && bLength > 0)) throw new Error('Angular-disk directions must be non-zero');
  return Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (aLength * bLength)));
}

function circleOverlapArea(r0: number, r1: number, separation: number): number {
  if (separation >= r0 + r1) return 0;
  if (separation <= Math.abs(r0 - r1)) {
    const smaller = Math.min(r0, r1);
    return Math.PI * smaller * smaller;
  }
  const d2 = separation * separation;
  const r02 = r0 * r0;
  const r12 = r1 * r1;
  const alpha = Math.acos(Math.max(-1, Math.min(1, (d2 + r02 - r12) / (2 * separation * r0))));
  const beta = Math.acos(Math.max(-1, Math.min(1, (d2 + r12 - r02) / (2 * separation * r1))));
  const lens = 0.5 * Math.sqrt(Math.max(0,
    (-separation + r0 + r1)
    * (separation + r0 - r1)
    * (separation - r0 + r1)
    * (separation + r0 + r1),
  ));
  return r02 * alpha + r12 * beta - lens;
}

export function celestialOcclusion(
  source: Readonly<AngularDisk>,
  occluder: Readonly<AngularDisk>,
): CelestialOcclusion {
  if (!(source.angularRadius > 0 && source.angularRadius <= Math.PI / 2)) {
    throw new Error('Source angular radius must be within (0, pi/2]');
  }
  if (!(occluder.angularRadius > 0 && occluder.angularRadius <= Math.PI / 2)) {
    throw new Error('Occluder angular radius must be within (0, pi/2]');
  }
  const separation = Math.acos(normalizedDot(source.direction, occluder.direction));
  const overlap = circleOverlapArea(source.angularRadius, occluder.angularRadius, separation);
  const sourceArea = Math.PI * source.angularRadius * source.angularRadius;
  const visible = Math.max(0, Math.min(1, 1 - overlap / sourceArea));
  return Object.freeze({
    angularSeparation: separation,
    overlapAreaRadians2: overlap,
    sourceVisibleFraction: visible,
    intersects: overlap > 0,
    total: overlap >= sourceArea * (1 - 1e-12),
  });
}
