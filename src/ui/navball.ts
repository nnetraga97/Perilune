import { Vec3 } from '../core/vec3';

export interface NavProjection {
  /** Normalized screen coordinates: +x right, +y down. */
  x: number;
  y: number;
  behind: boolean;
}

export function navHeading(
  nose: Readonly<Vec3>,
  forwardReference: Readonly<Vec3>,
  up: Readonly<Vec3>,
  east: Readonly<Vec3>,
  north: Readonly<Vec3>,
): number {
  const horizontal = new Vec3().copy(nose).addScaled(up, -Vec3.dot(nose, up));
  if (horizontal.lengthSq() < 1e-8) {
    horizontal.copy(forwardReference).addScaled(up, -Vec3.dot(forwardReference, up));
  }
  if (horizontal.lengthSq() < 1e-12) return 0;
  horizontal.normalize();
  let heading = Math.atan2(Vec3.dot(horizontal, east), Vec3.dot(horizontal, north));
  if (heading < 0) heading += Math.PI * 2;
  return heading;
}

export function projectNavDirection(
  direction: Readonly<Vec3>,
  nose: Readonly<Vec3>,
  right: Readonly<Vec3>,
  screenUp: Readonly<Vec3>,
): NavProjection {
  const forward = Math.max(-1, Math.min(1, Vec3.dot(direction, nose)));
  const horizontal = Vec3.dot(direction, right);
  const vertical = Vec3.dot(direction, screenUp);
  const radius = Math.min(1, Math.acos(forward) / (Math.PI / 2));
  const planeLength = Math.hypot(horizontal, vertical);
  if (planeLength < 1e-12) return { x: 0, y: 0, behind: forward < 0 };
  return {
    x: (horizontal / planeLength) * radius,
    y: (-vertical / planeLength) * radius,
    behind: forward < 0,
  };
}
