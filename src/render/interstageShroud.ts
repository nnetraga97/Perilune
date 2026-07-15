import * as THREE from 'three';
import type { InterstageShroudSpec } from '../sim/vessel';

const RADIAL_SEGMENTS = 32;
const PROFILE_SEGMENTS = 8;
const WALL_THICKNESS = 0.035;
const geometryCache = new Map<string, THREE.BufferGeometry>();

const shroudMaterial = new THREE.MeshStandardMaterial({
  color: '#c8cdd2',
  metalness: 0.48,
  roughness: 0.38,
});

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function keyFor(spec: InterstageShroudSpec): string {
  return [spec.lowerRadius, spec.upperRadius, spec.lowerY, spec.upperY]
    .map((value) => value.toFixed(3))
    .join(':');
}

/** Closed, double-sided-by-geometry annular shell with smooth tangent collars. */
export function interstageShroudGeometry(spec: InterstageShroudSpec): THREE.BufferGeometry {
  const key = keyFor(spec);
  const cached = geometryCache.get(key);
  if (cached) return cached;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringVertexCount = RADIAL_SEGMENTS + 1;
  const outerStart = 0;

  const radiusAt = (t: number) => THREE.MathUtils.lerp(
    spec.lowerRadius,
    spec.upperRadius,
    smoothstep(t),
  );

  const appendProfile = (inner: boolean): number => {
    const start = positions.length / 3;
    for (let ring = 0; ring <= PROFILE_SEGMENTS; ring++) {
      const t = ring / PROFILE_SEGMENTS;
      const y = THREE.MathUtils.lerp(spec.lowerY, spec.upperY, t);
      const outerRadius = radiusAt(t);
      const radius = inner ? Math.max(MIN_INNER_RADIUS, outerRadius - WALL_THICKNESS) : outerRadius;
      for (let segment = 0; segment <= RADIAL_SEGMENTS; segment++) {
        const u = segment / RADIAL_SEGMENTS;
        const angle = u * Math.PI * 2;
        positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        uvs.push(inner ? 1 - u : u, t);
      }
    }
    return start;
  };

  const MIN_INNER_RADIUS = 0.015;
  appendProfile(false);
  const innerStart = appendProfile(true);

  for (let ring = 0; ring < PROFILE_SEGMENTS; ring++) {
    for (let segment = 0; segment < RADIAL_SEGMENTS; segment++) {
      const a = outerStart + ring * ringVertexCount + segment;
      const b = a + 1;
      const c = a + ringVertexCount;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);

      const ia = innerStart + ring * ringVertexCount + segment;
      const ib = ia + 1;
      const ic = ia + ringVertexCount;
      const id = ic + 1;
      indices.push(ia, ib, ic, ib, id, ic);
    }
  }

  const appendCap = (top: boolean): void => {
    const t = top ? 1 : 0;
    const y = top ? spec.upperY : spec.lowerY;
    const outerRadius = radiusAt(t);
    const innerRadius = Math.max(MIN_INNER_RADIUS, outerRadius - WALL_THICKNESS);
    const start = positions.length / 3;
    for (let ring = 0; ring < 2; ring++) {
      const radius = ring === 0 ? outerRadius : innerRadius;
      for (let segment = 0; segment <= RADIAL_SEGMENTS; segment++) {
        const u = segment / RADIAL_SEGMENTS;
        const angle = u * Math.PI * 2;
        positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        uvs.push(0.5 + Math.cos(angle) * radius / (outerRadius * 2), 0.5 + Math.sin(angle) * radius / (outerRadius * 2));
      }
    }
    const inner = start + ringVertexCount;
    for (let segment = 0; segment < RADIAL_SEGMENTS; segment++) {
      const a = start + segment;
      const b = a + 1;
      const c = inner + segment;
      const d = c + 1;
      if (top) indices.push(a, b, c, b, d, c);
      else indices.push(a, c, b, b, c, d);
    }
  };

  appendCap(false);
  appendCap(true);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.interstageShroud = true;
  geometryCache.set(key, geometry);
  return geometry;
}

export function buildInterstageShroud(spec: InterstageShroudSpec): THREE.Mesh {
  const mesh = new THREE.Mesh(interstageShroudGeometry(spec), shroudMaterial);
  mesh.name = 'SM_Runtime_InterstageShroud';
  mesh.userData.interstageShroud = true;
  mesh.userData.spec = { ...spec };
  return mesh;
}
