import * as THREE from 'three';
import type { QualityTier } from './bodyRenderer';
import type { Craft, PartInstance } from '../sim/vessel';
import { defOf } from '../sim/vessel';
import type { PartDef } from '../content/parts';
import { deriveInterstageShroud, sanitizeInterstageShroudSpec } from '../sim/interstage';
import { interstageShroudGeometry } from './interstageShroud';

export interface ReentryGeometrySet {
  readonly envelope: THREE.BufferGeometry;
  readonly fins: THREE.BufferGeometry;
  readonly envelopeTriangles: number;
  readonly finSources: number;
  readonly bytes: number;
}

interface TriangleSource {
  readonly a: THREE.Vector3;
  readonly b: THREE.Vector3;
  readonly c: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly center: THREE.Vector3;
  readonly area: number;
  readonly exposure: number;
  readonly seed: number;
  readonly sourceKey: number;
}

const FIN_LIMITS: Readonly<Record<QualityTier, number>> = Object.freeze({
  low: 1_200,
  medium: 3_200,
  high: 7_500,
});

function geometryForEffect(def: PartDef): THREE.BufferGeometry {
  const shape = def.shape;
  switch (shape.kind) {
    case 'cylinder':
      return new THREE.CylinderGeometry(shape.radiusTop ?? 0.5, shape.radiusBottom ?? 0.5, shape.height, 12, 1);
    case 'cone':
      return new THREE.CylinderGeometry(
        Math.max(0.01, shape.radiusTop ?? 0.01),
        Math.max(0.01, shape.radiusBottom ?? 0.5),
        shape.height,
        12,
        1,
      );
    case 'capsule': {
      const radius = shape.radiusTop ?? 0.3;
      return new THREE.CapsuleGeometry(radius, Math.max(0.01, shape.height - radius * 2), 4, 10);
    }
    case 'dome': {
      const radius = Math.max(shape.radiusBottom ?? 0.5, 0.05);
      const geometry = new THREE.SphereGeometry(radius, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      geometry.scale(1, shape.height / radius, 1);
      return geometry;
    }
    case 'box':
      return new THREE.BoxGeometry(shape.width ?? 0.2, shape.height, shape.depth ?? 0.2);
    case 'panel':
      return new THREE.BoxGeometry(shape.width ?? 0.5, shape.height, shape.depth ?? 0.05);
  }
}

function partMatrix(part: PartInstance): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(part.position.x, part.position.y, part.position.z),
    new THREE.Quaternion(part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w),
    new THREE.Vector3(1, 1, 1),
  );
}

function appendGeometry(
  source: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  exposure: number,
  seedBase: number,
  positions: number[],
  normals: number[],
  exposures: number[],
  seeds: number[],
  triangles: TriangleSource[],
): void {
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const transformed: THREE.Vector3[] = [];
  const transformedNormals: THREE.Vector3[] = [];
  for (let index = 0; index < position.count; index++) {
    const p = new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(matrix);
    const n = new THREE.Vector3().fromBufferAttribute(normal, index).applyMatrix3(normalMatrix).normalize();
    // The small shell offset prevents z-fighting while remaining inside the
    // procedural proxy's visual silhouette at ordinary camera distances.
    p.addScaledVector(n, 0.035);
    transformed.push(p);
    transformedNormals.push(n);
    positions.push(p.x, p.y, p.z);
    normals.push(n.x, n.y, n.z);
    exposures.push(exposure);
    seeds.push((seedBase * 0.61803398875 + index * 0.037) % 1);
  }
  for (let index = 0; index + 2 < transformed.length; index += 3) {
    const a = transformed[index];
    const b = transformed[index + 1];
    const c = transformed[index + 2];
    const edgeA = new THREE.Vector3().subVectors(b, a);
    const edgeB = new THREE.Vector3().subVectors(c, a);
    const cross = new THREE.Vector3().crossVectors(edgeA, edgeB);
    const area = cross.length() * 0.5;
    if (area < 1e-6) continue;
    triangles.push({
      a: a.clone(),
      b: b.clone(),
      c: c.clone(),
      normal: cross.normalize(),
      center: new THREE.Vector3().addVectors(a, b).add(c).multiplyScalar(1 / 3),
      area,
      exposure,
      seed: (seedBase * 0.754877666 + index * 0.013) % 1,
      sourceKey: seedBase,
    });
  }
  geometry.dispose();
}

function longestEdge(triangle: TriangleSource): readonly [THREE.Vector3, THREE.Vector3] {
  const edges = [
    [triangle.a, triangle.b] as const,
    [triangle.b, triangle.c] as const,
    [triangle.c, triangle.a] as const,
  ];
  return edges.reduce((best, edge) => (
    edge[0].distanceToSquared(edge[1]) > best[0].distanceToSquared(best[1]) ? edge : best
  ));
}

function buildFinGeometry(sources: readonly TriangleSource[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const centers: number[] = [];
  const trailT: number[] = [];
  const sides: number[] = [];
  const layers: number[] = [];
  const exposures: number[] = [];
  const seeds: number[] = [];
  const indices: number[] = [];
  for (const source of sources) {
    const [edgeA, edgeB] = longestEdge(source);
    for (let layer = 0; layer < 2; layer++) {
      const start = positions.length / 3;
      for (let station = 0; station < 3; station++) {
        const t = station / 2;
        for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
          const anchor = sideIndex === 0 ? edgeA : edgeB;
          positions.push(anchor.x, anchor.y, anchor.z);
          normals.push(source.normal.x, source.normal.y, source.normal.z);
          centers.push(source.center.x, source.center.y, source.center.z);
          trailT.push(t);
          sides.push(sideIndex === 0 ? -1 : 1);
          layers.push(layer);
          exposures.push(source.exposure);
          seeds.push(source.seed);
        }
      }
      indices.push(
        start, start + 2, start + 1,
        start + 2, start + 3, start + 1,
        start + 2, start + 4, start + 3,
        start + 4, start + 5, start + 3,
      );
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('aCenter', new THREE.Float32BufferAttribute(centers, 3));
  geometry.setAttribute('aTrailT', new THREE.Float32BufferAttribute(trailT, 1));
  geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
  geometry.setAttribute('aLayer', new THREE.Float32BufferAttribute(layers, 1));
  geometry.setAttribute('aExposure', new THREE.Float32BufferAttribute(exposures, 1));
  geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export function craftReentryFingerprint(craft: Craft): string {
  return craft.parts.map((part) => {
    const shroud = sanitizeInterstageShroudSpec(part.interstageShroud);
    const shroudKey = shroud
      ? `${shroud.lowerRadius}:${shroud.upperRadius}:${shroud.lowerY}:${shroud.upperY}`
      : '-';
    return `${part.key}:${part.defId}:${part.activated ? 1 : 0}:${shroudKey}`;
  }).join('|');
}

export function buildReentryGeometry(
  craft: Craft,
  axialFrac: ReadonlyMap<number, number>,
  quality: QualityTier,
): ReentryGeometrySet {
  const positions: number[] = [];
  const normals: number[] = [];
  const exposures: number[] = [];
  const seeds: number[] = [];
  const triangles: TriangleSource[] = [];
  for (const part of craft.parts) {
    const fraction = axialFrac.get(part.key) ?? 0.5;
    const matrix = partMatrix(part);
    const primitive = geometryForEffect(defOf(part));
    appendGeometry(
      primitive,
      matrix,
      fraction,
      part.key,
      positions,
      normals,
      exposures,
      seeds,
      triangles,
    );
    primitive.dispose();
    const latched = sanitizeInterstageShroudSpec(part.interstageShroud);
    const live = part.activated ? null : deriveInterstageShroud(craft, part);
    const shroud = live ?? latched;
    if (shroud) {
      appendGeometry(
        interstageShroudGeometry(shroud),
        matrix,
        fraction,
        part.key + 0.5,
        positions,
        normals,
        exposures,
        seeds,
        triangles,
      );
    }
  }
  const envelope = new THREE.BufferGeometry();
  envelope.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  envelope.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  envelope.setAttribute('aExposure', new THREE.Float32BufferAttribute(exposures, 1));
  envelope.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
  envelope.computeBoundingBox();
  envelope.computeBoundingSphere();

  const limit = FIN_LIMITS[quality];
  const bySource = new Map<number, TriangleSource[]>();
  for (const triangle of triangles) {
    const group = bySource.get(triangle.sourceKey) ?? [];
    group.push(triangle);
    bySource.set(triangle.sourceKey, group);
  }
  for (const group of bySource.values()) group.sort((left, right) => right.area - left.area);
  // Give every part/shroud proxy a fair source allocation before filling the
  // remainder by area. A global-only sort makes large tanks consume the whole
  // budget and leaves pods, fins, and exposed instruments with no trails.
  const fairShare = Math.max(1, Math.floor(limit / Math.max(1, bySource.size)));
  const selected: TriangleSource[] = [];
  const remainder: TriangleSource[] = [];
  for (const group of bySource.values()) {
    selected.push(...group.slice(0, fairShare));
    remainder.push(...group.slice(fairShare));
  }
  if (selected.length < limit) {
    remainder.sort((left, right) => right.area - left.area);
    selected.push(...remainder.slice(0, limit - selected.length));
  }
  if (selected.length > limit) selected.length = limit;
  const fins = buildFinGeometry(selected);
  const bytes = [envelope, fins].reduce((sum, geometry) => {
    let size = geometry.index?.array.byteLength ?? 0;
    for (const attribute of Object.values(geometry.attributes)) size += attribute.array.byteLength;
    return sum + size;
  }, 0);
  return {
    envelope,
    fins,
    envelopeTriangles: Math.floor(positions.length / 9),
    finSources: selected.length,
    bytes,
  };
}
