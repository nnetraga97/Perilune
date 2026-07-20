import { noise3 } from '../core/noise';
import {
  CHECKED_HEIGHT_AUTHORITY_VERSION,
  CHECKED_HEIGHT_GRIDS,
  type CheckedHeightGrid,
} from '../generated/checked-height-authority';

export { CHECKED_HEIGHT_AUTHORITY_VERSION };

interface DecodedHeightGrid extends CheckedHeightGrid {
  readonly samples: Int16Array;
}

const decoded = new Map<string, DecodedHeightGrid>();

function decode(grid: CheckedHeightGrid): DecodedHeightGrid {
  const cached = decoded.get(grid.bodyId);
  if (cached) return cached;
  const binary = atob(grid.encodedInt16Base64);
  if (binary.length !== grid.width * grid.height * 2) {
    throw new Error(`Invalid checked height grid length for ${grid.bodyId}`);
  }
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const view = new DataView(buffer);
  const samples = new Int16Array(grid.width * grid.height);
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true);
  const result = Object.freeze({ ...grid, samples });
  decoded.set(grid.bodyId, result);
  return result;
}

export function sourceHeightGrid(bodyId: string): DecodedHeightGrid | null {
  const grid = CHECKED_HEIGHT_GRIDS.find((candidate) => candidate.bodyId === bodyId);
  return grid ? decode(grid) : null;
}

/** Resident CPU allocation for the immutable render/contact macro authority. */
export function sourceHeightCacheBytes(bodyId: string): number {
  return sourceHeightGrid(bodyId)?.samples.byteLength ?? 0;
}

function fract(value: number): number { return value - Math.floor(value); }

/** Bilinear, seam-wrapped sample of the immutable source-derived global level. */
export function sampleSourceMacroHeight(
  bodyId: string,
  direction: Readonly<{ x: number; y: number; z: number }>,
): number | null {
  const grid = sourceHeightGrid(bodyId);
  if (!grid) return null;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0)) return 0;
  const u = fract(Math.atan2(direction.y, direction.x) / (Math.PI * 2) + 0.5);
  const v = Math.max(0, Math.min(1, 0.5 - Math.asin(Math.max(-1, Math.min(1, direction.z / length))) / Math.PI));
  const x = u * grid.width - 0.5;
  const y = Math.max(0, Math.min(grid.height - 1, v * grid.height - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = Math.max(0, Math.min(grid.height - 1, y0 + 1));
  const tx = x - x0;
  const ty = y - y0;
  const at = (px: number, py: number): number => (
    grid.samples[py * grid.width + ((px % grid.width) + grid.width) % grid.width] * 0.5
  );
  const a = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const b = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return a * (1 - ty) + b * ty;
}

/**
 * Source maps own long wavelengths; deterministic metric-space noise only
 * fills frequencies the global raster cannot contain. It is deliberately
 * weak enough not to move coastlines or lunar basin identity.
 */
export function sampleCanonicalLocalRelief(
  bodyId: string,
  radiusMeters: number,
  direction: Readonly<{ x: number; y: number; z: number }>,
): number {
  const macro = sampleSourceMacroHeight(bodyId, direction);
  if (macro === null) return 0;
  if (bodyId === 'earth' && macro < 0) return 0;
  const seed = bodyId === 'earth' ? 4_211 : 7_903;
  const amplitude = bodyId === 'earth' ? 38 : 72;
  let detail = 0;
  let weight = 1;
  let normalization = 0;
  for (const wavelength of [8_000, 2_000, 500, 125]) {
    const frequency = radiusMeters / wavelength;
    detail += noise3(
      direction.x * frequency,
      direction.y * frequency,
      direction.z * frequency,
      seed + wavelength,
    ) * weight;
    normalization += weight;
    weight *= 0.45;
  }
  return detail / normalization * amplitude;
}
