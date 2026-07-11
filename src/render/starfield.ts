/**
 * Procedural starfield: deterministic points on a far sphere.
 * Rendered without size attenuation so it reads as infinitely distant.
 */
import * as THREE from 'three';

export function makeStarfield(count = 4000, seed = 12345): THREE.Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  let s = seed;
  const rand = () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
  const R = 5e8;
  for (let i = 0; i < count; i++) {
    // Uniform on sphere
    const z = rand() * 2 - 1;
    const phi = rand() * Math.PI * 2;
    const rxy = Math.sqrt(1 - z * z);
    positions[i * 3] = Math.cos(phi) * rxy * R;
    positions[i * 3 + 1] = Math.sin(phi) * rxy * R;
    positions[i * 3 + 2] = z * R;
    // Temperature tint
    const temp = rand();
    const brightness = 0.35 + 0.65 * Math.pow(rand(), 3);
    colors[i * 3] = brightness * (0.8 + temp * 0.2);
    colors[i * 3 + 1] = brightness * (0.85 + temp * 0.1);
    colors[i * 3 + 2] = brightness * (1.0 - temp * 0.25 + 0.25);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -10;
  return points;
}
