import type * as THREE from 'three';
import type { QualityTier } from './bodyRenderer';

export const DEFAULT_ACTIVE_BODY_BUDGET: Readonly<Record<QualityTier, number>> = Object.freeze({
  low: 64 * 1024 * 1024,
  medium: 128 * 1024 * 1024,
  high: 320 * 1024 * 1024,
});

/** Proven streamed-terrain geometry reservation used before fixed auxiliaries. */
export const DEFAULT_TERRAIN_GEOMETRY_BUDGET = 128 * 1024 * 1024;

export interface MipResourceSpec {
  readonly width: number;
  readonly height: number;
  readonly bytesPerPixel: number;
  readonly faces?: number;
  readonly layers?: number;
  readonly samples?: number;
}

export function geometryByteLength(geometry: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array.byteLength;
  const index = geometry.getIndex();
  if (index) bytes += index.array.byteLength;
  return bytes;
}

/** Unique geometry storage reachable from a fixed set of render objects. */
export function objectGeometryBytes(objects: readonly THREE.Object3D[]): number {
  const geometries = new Set<THREE.BufferGeometry>();
  for (const root of objects) {
    root.traverse((object) => {
      const geometry = (object as Partial<THREE.Mesh>).geometry;
      if (geometry) geometries.add(geometry);
    });
  }
  let bytes = 0;
  for (const geometry of geometries) bytes += geometryByteLength(geometry);
  return bytes;
}

/**
 * Bytes an InstancedMesh keeps resident: shared geometry plus the per-instance
 * matrix and optional color buffers. Used for surface-scatter and decal pools.
 */
export function instancedResourceBytes(mesh: THREE.InstancedMesh): number {
  let bytes = geometryByteLength(mesh.geometry as THREE.BufferGeometry);
  bytes += mesh.instanceMatrix.array.byteLength;
  if (mesh.instanceColor) bytes += mesh.instanceColor.array.byteLength;
  return bytes;
}

export function fullMipChainBytes(spec: MipResourceSpec): number {
  const faces = spec.faces ?? 1;
  const layers = spec.layers ?? 1;
  const samples = spec.samples ?? 1;
  for (const [name, value] of Object.entries({ ...spec, faces, layers, samples })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name} ${value}`);
  }
  let pixels = 0;
  for (let width = spec.width, height = spec.height; ;) {
    pixels += width * height;
    if (width === 1 && height === 1) break;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
  return pixels * spec.bytesPerPixel * faces * layers * samples;
}

export function drawingBufferResourceBytes(width: number, height: number, samples: number) {
  const effectiveSamples = Math.max(1, samples);
  const colorBytes = width * height * 4 * effectiveSamples;
  const depthBytes = width * height * 4 * effectiveSamples;
  return Object.freeze({
    width, height, samples, colorBytes, depthBytes, totalBytes: colorBytes + depthBytes,
  });
}

export function categorizeResources(input: {
  readonly activeBody: Readonly<Record<string, number>>;
  readonly rendererOnly: Readonly<Record<string, number>>;
  readonly transientBytes: number;
}) {
  const sum = (values: Readonly<Record<string, number>>) => Object.values(values)
    .reduce((total, value) => total + value, 0);
  const activeBodyBytes = sum(input.activeBody);
  const totalRendererBytes = activeBodyBytes + sum(input.rendererOnly);
  return Object.freeze({
    categories: Object.freeze({ ...input.activeBody, ...input.rendererOnly }),
    activeBodyBytes,
    totalRendererBytes,
    transientBytes: input.transientBytes,
    uncompressedWorstCaseBytes: totalRendererBytes + input.transientBytes,
  });
}

export interface TerrainGeometryAllocationInput {
  readonly activeBodyBudgetBytes: number;
  readonly committedTextureBytes: number;
  readonly fixedPassBytes: number;
  readonly scatterBytes: number;
  readonly effectBytes: number;
}

export interface TerrainGeometryAllocation {
  readonly allocationBytes: number;
  readonly chargedBytes: number;
  readonly overBudgetBytes: number;
}

/** Remaining active-body allocation available to streamed terrain geometry. */
export function terrainGeometryAllocation(
  input: Readonly<TerrainGeometryAllocationInput>,
): TerrainGeometryAllocation {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${name} ${value}`);
  }
  const chargedBytes = input.committedTextureBytes
    + input.fixedPassBytes
    + input.scatterBytes
    + input.effectBytes;
  const remaining = input.activeBodyBudgetBytes - chargedBytes;
  return Object.freeze({
    allocationBytes: Math.max(0, remaining),
    chargedBytes,
    overBudgetBytes: Math.max(0, -remaining),
  });
}
