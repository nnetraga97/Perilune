import type * as THREE from 'three';

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
