import * as THREE from 'three';

export type BodyFixedDirection = Readonly<{ x: number; y: number; z: number }>;

/**
 * Canonical authored-map coordinates: +Z is north, -X is the antimeridian
 * seam, +X is Greenwich at the texture center, east longitude increases with
 * U, and image row zero is the north pole.
 */
export function bodyFixedUv(direction: BodyFixedDirection): { u: number; v: number } {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  const normalizedZ = length === 0 ? 0 : Math.max(-1, Math.min(1, direction.z / length));
  const longitude = Math.atan2(direction.y, direction.x) / (Math.PI * 2) + 0.5;
  return {
    u: longitude >= 1 ? longitude - 1 : longitude < 0 ? longitude + 1 : longitude,
    v: 0.5 - Math.asin(normalizedZ) / Math.PI,
  };
}

/** Copy normalized local positions into a seam-safe body-direction attribute. */
export function installBodyFixedDirectionAttribute(
  geometry: THREE.BufferGeometry,
  attributeName = 'bodyDirection',
): THREE.BufferAttribute {
  const position = geometry.getAttribute('position');
  if (!position) throw new Error('Body-fixed direction requires a position attribute');
  const directions = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const inverseLength = 1 / (Math.hypot(x, y, z) || 1);
    directions[index * 3] = x * inverseLength;
    directions[index * 3 + 1] = y * inverseLength;
    directions[index * 3 + 2] = z * inverseLength;
  }
  const attribute = new THREE.BufferAttribute(directions, 3);
  geometry.setAttribute(attributeName, attribute);
  return attribute;
}

/** GLSL expression shared by authored terrain and compact materials. */
export const BODY_FIXED_UV_GLSL = /* glsl */ `
vec2 bodyFixedUv(vec3 rawDirection) {
  vec3 direction = normalize(rawDirection);
  float longitude = atan(direction.y, direction.x) / 6.283185307179586 + 0.5;
  return vec2(fract(longitude),
    0.5 - asin(clamp(direction.z, -1.0, 1.0)) / 3.141592653589793);
}
`;
