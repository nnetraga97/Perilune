import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { AeroLabSurface } from './aeroLabGeometry';

export type AeroLabQuality = 'low' | 'medium' | 'high';

export interface AeroLabFieldRequest {
  surface: AeroLabSurface;
  flowDirection: readonly [number, number, number];
  mach: number;
  quality: AeroLabQuality;
}

export interface AeroLabFieldResult extends AeroLabSurface {
  streamlinePositions: Float32Array;
  streamlineOffsets: Uint32Array;
  shielding: Float32Array;
  shockDistance: number | null;
  preparationMs: number;
}

const QUALITY = {
  low: { lines: 24, steps: 80, stations: 32 },
  medium: { lines: 48, steps: 120, stations: 48 },
  high: { lines: 72, steps: 160, stations: 64 },
} as const;

function geometryFrom(positions: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

function exteriorSurface(surface: AeroLabSurface): AeroLabSurface {
  if (surface.positions.length < 9) return surface;
  const geometry = geometryFrom(surface.positions);
  const bvh = new MeshBVH(geometry, { targetLeafSize: 12 });
  const direction = new THREE.Vector3(0.873, 0.419, 0.251).normalize();
  const origin = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const ray = new THREE.Ray();
  const positions: number[] = [];
  const normals: number[] = [];
  const partKeys: number[] = [];
  for (let i = 0; i < surface.positions.length; i += 9) {
    origin.set(
      (surface.positions[i] + surface.positions[i + 3] + surface.positions[i + 6]) / 3,
      (surface.positions[i + 1] + surface.positions[i + 4] + surface.positions[i + 7]) / 3,
      (surface.positions[i + 2] + surface.positions[i + 5] + surface.positions[i + 8]) / 3,
    );
    normal.set(
      surface.normals[i] + surface.normals[i + 3] + surface.normals[i + 6],
      surface.normals[i + 1] + surface.normals[i + 4] + surface.normals[i + 7],
      surface.normals[i + 2] + surface.normals[i + 5] + surface.normals[i + 8],
    ).normalize();
    origin.addScaledVector(normal, 0.002);
    ray.set(origin, direction);
    if (bvh.raycast(ray, THREE.DoubleSide, 0.002).length % 2 === 1) continue;
    for (let j = 0; j < 9; j++) {
      positions.push(surface.positions[i + j]);
      normals.push(surface.normals[i + j]);
    }
    partKeys.push(surface.partKeys[i / 3], surface.partKeys[i / 3 + 1], surface.partKeys[i / 3 + 2]);
  }
  geometry.dispose();
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    partKeys: new Float32Array(partKeys),
  };
}

interface Source {
  position: THREE.Vector3;
  strength: number;
}

function buildSources(
  positions: Float32Array,
  bounds: THREE.Box3,
  stationCount: number,
): Source[] {
  const span = Math.max(0.1, bounds.max.y - bounds.min.y);
  const step = span / Math.max(1, stationCount - 1);
  const areas = new Float32Array(stationCount);
  for (let station = 0; station < stationCount; station++) {
    const y = bounds.min.y + station * step;
    let radius = 0;
    for (let i = 0; i < positions.length; i += 3) {
      if (Math.abs(positions[i + 1] - y) > step) continue;
      radius = Math.max(radius, Math.hypot(positions[i], positions[i + 2]));
    }
    areas[station] = Math.PI * radius * radius;
  }
  const sources: Source[] = [];
  for (let station = 1; station < stationCount - 1; station++) {
    const derivative = (areas[station + 1] - areas[station - 1]) / (2 * step);
    if (Math.abs(derivative) < 1e-4) continue;
    sources.push({
      position: new THREE.Vector3(0, bounds.min.y + station * step, 0),
      strength: THREE.MathUtils.clamp(derivative * 0.8, -8, 8),
    });
  }
  return sources;
}

function fieldAt(
  point: THREE.Vector3,
  flow: THREE.Vector3,
  sources: readonly Source[],
  coreRadius: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  out.copy(flow);
  const delta = new THREE.Vector3();
  const coreSq = coreRadius * coreRadius;
  for (const source of sources) {
    delta.subVectors(point, source.position);
    const scale = source.strength / (4 * Math.PI * Math.pow(delta.lengthSq() + coreSq, 1.5));
    out.addScaledVector(delta, scale);
  }
  if (!Number.isFinite(out.lengthSq()) || out.lengthSq() < 1e-8) return out.copy(flow);
  return out.normalize();
}

function rk4(
  point: THREE.Vector3,
  step: number,
  flow: THREE.Vector3,
  sources: readonly Source[],
  core: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const k1 = fieldAt(point, flow, sources, core, new THREE.Vector3());
  const k2 = fieldAt(out.copy(point).addScaledVector(k1, step * 0.5), flow, sources, core, new THREE.Vector3());
  const k3 = fieldAt(out.copy(point).addScaledVector(k2, step * 0.5), flow, sources, core, new THREE.Vector3());
  const k4 = fieldAt(out.copy(point).addScaledVector(k3, step), flow, sources, core, new THREE.Vector3());
  return out.copy(point).addScaledVector(
    k1.addScaledVector(k2, 2).addScaledVector(k3, 2).add(k4).normalize(),
    step,
  );
}

function traceStreamlines(
  bvh: MeshBVH,
  bounds: THREE.Box3,
  flow: THREE.Vector3,
  sources: readonly Source[],
  quality: AeroLabQuality,
  mach: number,
): { positions: Float32Array; offsets: Uint32Array; shockDistance: number | null } {
  const config = QUALITY[quality];
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.z, 0.5);
  const flowExtent = (Math.abs(flow.x) * size.x + Math.abs(flow.y) * size.y + Math.abs(flow.z) * size.z) * 0.5;
  const shockDistance = mach > 1.2 ? Math.max(flowExtent, 0.5) * 1.35 : null;
  const extent = Math.max(size.length() * 0.9, radius * 4);
  const step = extent * 2 / config.steps;
  const upstream = center.clone().addScaledVector(flow, -extent);
  const basisA = new THREE.Vector3(0, 0, 1);
  if (Math.abs(flow.z) > 0.9) basisA.set(1, 0, 0);
  basisA.cross(flow).normalize();
  const basisB = new THREE.Vector3().crossVectors(flow, basisA).normalize();
  const domain = bounds.clone().expandByScalar(extent * 1.1);
  const positions: number[] = [];
  const offsets: number[] = [0];
  const next = new THREE.Vector3();
  const delta = new THREE.Vector3();
  const ray = new THREE.Ray();
  for (let line = 0; line < config.lines; line++) {
    const angle = line * 2.399963229728653;
    const laneRadius = radius * (0.25 + 1.8 * Math.sqrt((line + 0.5) / config.lines));
    const point = upstream.clone()
      .addScaledVector(basisA, Math.cos(angle) * laneRadius)
      .addScaledVector(basisB, Math.sin(angle) * laneRadius);
    positions.push(point.x, point.y, point.z);
    for (let iteration = 0; iteration < config.steps; iteration++) {
      rk4(point, step, flow, sources, radius * 0.35, next);
      if (
        shockDistance !== null
        && (next.x - center.x) * flow.x + (next.y - center.y) * flow.y + (next.z - center.z) * flow.z
          >= -shockDistance
      ) break;
      delta.subVectors(next, point);
      const distance = delta.length();
      if (distance <= 1e-6) break;
      ray.set(point, delta.multiplyScalar(1 / distance));
      if (bvh.raycastFirst(ray, THREE.DoubleSide, 0.002, distance)) break;
      point.copy(next);
      positions.push(point.x, point.y, point.z);
      if (!domain.containsPoint(point)) break;
    }
    offsets.push(positions.length / 3);
  }
  if (mach > 1.2) {
    for (let line = 0; line < config.lines; line++) {
      const angle = line * 2.399963229728653;
      const laneRadius = radius * (0.18 + 1.1 * Math.sqrt((line + 0.5) / config.lines));
      const point = center.clone().addScaledVector(flow, shockDistance!)
        .addScaledVector(basisA, Math.cos(angle) * laneRadius)
        .addScaledVector(basisB, Math.sin(angle) * laneRadius);
      for (let iteration = 0; iteration < Math.floor(config.steps * 0.4); iteration++) {
        positions.push(point.x, point.y, point.z);
        next.copy(point).addScaledVector(flow, step);
        delta.subVectors(next, point);
        const distance = delta.length();
        ray.set(point, delta.multiplyScalar(1 / distance));
        if (bvh.raycastFirst(ray, THREE.DoubleSide, 0.002, distance)) break;
        if (!domain.containsPoint(next)) break;
        point.copy(next);
      }
      offsets.push(positions.length / 3);
    }
  }
  return {
    positions: new Float32Array(positions),
    offsets: new Uint32Array(offsets),
    shockDistance,
  };
}

function surfaceShielding(
  surface: AeroLabSurface,
  bvh: MeshBVH,
  flow: THREE.Vector3,
): Float32Array {
  const shielding = new Float32Array(surface.positions.length / 3);
  const origin = new THREE.Vector3();
  const upstream = flow.clone().negate();
  const ray = new THREE.Ray();
  for (let i = 0; i < surface.positions.length; i += 9) {
    origin.set(
      (surface.positions[i] + surface.positions[i + 3] + surface.positions[i + 6]) / 3,
      (surface.positions[i + 1] + surface.positions[i + 4] + surface.positions[i + 7]) / 3,
      (surface.positions[i + 2] + surface.positions[i + 5] + surface.positions[i + 8]) / 3,
    ).addScaledVector(upstream, 0.003);
    ray.set(origin, upstream);
    const shadowed = bvh.raycastFirst(ray, THREE.DoubleSide, 0.004) !== null ? 1 : 0;
    shielding[i / 3] = shielding[i / 3 + 1] = shielding[i / 3 + 2] = shadowed;
  }
  return shielding;
}

export function analyzeAeroLabField(request: AeroLabFieldRequest): AeroLabFieldResult {
  const started = performance.now();
  const surface = exteriorSurface(request.surface);
  const geometry = geometryFrom(surface.positions);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox ?? new THREE.Box3();
  const bvh = new MeshBVH(geometry, { targetLeafSize: 12 });
  const flow = new THREE.Vector3(...request.flowDirection).normalize();
  const sources = buildSources(surface.positions, bounds, QUALITY[request.quality].stations);
  const streamlines = traceStreamlines(bvh, bounds, flow, sources, request.quality, request.mach);
  const shielding = surfaceShielding(surface, bvh, flow);
  geometry.dispose();
  return {
    ...surface,
    streamlinePositions: streamlines.positions,
    streamlineOffsets: streamlines.offsets,
    shielding,
    shockDistance: streamlines.shockDistance,
    preparationMs: performance.now() - started,
  };
}
