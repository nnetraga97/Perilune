/**
 * Deterministic 3D gradient noise + fBm, written from scratch for Perilune.
 *
 * Used by terrain generation on both the sim side (ground height for
 * physics) and the render side (mesh building), so it must be fast and
 * fully deterministic from a seed.
 */

// 12 edge-of-cube gradient directions.
const GRAD = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/**
 * Conservative analytical bounds for this implementation, not observed
 * sample maxima. Corner dot products are bounded by 2; quintic interpolation
 * is convex, then the implementation's 1.9 normalization is applied.
 */
export const NOISE3_VALUE_BOUND = 3.8;

/**
 * Conservative Euclidean input-gradient bound. Per-axis derivative is at
 * most `1.9 * (1 + 2 * max(fade') * 2) = 16.15`; 28 bounds three axes.
 */
export const NOISE3_GRADIENT_BOUND = 28;

/** Cheap integer hash (xorshift-style avalanche). */
function hash(ix: number, iy: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 144665) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  return h >>> 0;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Single octave of gradient noise in [-1, 1]. */
export function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);

  let n000 = 0, n100 = 0, n010 = 0, n110 = 0, n001 = 0, n101 = 0, n011 = 0, n111 = 0;
  for (let corner = 0; corner < 8; corner++) {
    const cx = corner & 1;
    const cy = (corner >> 1) & 1;
    const cz = (corner >> 2) & 1;
    const gi = (hash(ix + cx, iy + cy, iz + cz, seed) % 12) * 3;
    const dx = fx - cx;
    const dy = fy - cy;
    const dz = fz - cz;
    const dot = GRAD[gi] * dx + GRAD[gi + 1] * dy + GRAD[gi + 2] * dz;
    switch (corner) {
      case 0: n000 = dot; break;
      case 1: n100 = dot; break;
      case 2: n010 = dot; break;
      case 3: n110 = dot; break;
      case 4: n001 = dot; break;
      case 5: n101 = dot; break;
      case 6: n011 = dot; break;
      case 7: n111 = dot; break;
    }
  }

  const nx00 = n000 + u * (n100 - n000);
  const nx10 = n010 + u * (n110 - n010);
  const nx01 = n001 + u * (n101 - n001);
  const nx11 = n011 + u * (n111 - n011);
  const nxy0 = nx00 + v * (nx10 - nx00);
  const nxy1 = nx01 + v * (nx11 - nx01);
  // Scale ~1.9 normalizes edge-gradient noise into roughly [-1, 1].
  return (nxy0 + w * (nxy1 - nxy0)) * 1.9;
}

/** Fractal Brownian motion: `octaves` layers of noise3. Output ~[-1, 1]. */
export function fbm3(
  x: number,
  y: number,
  z: number,
  seed: number,
  octaves: number,
  lacunarity = 2.0,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x, fy = y, fz = z;
  for (let o = 0; o < octaves; o++) {
    sum += noise3(fx, fy, fz, seed + o * 1013) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
    fz *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal — sharp mountain crests. Output ~[0, 1]. */
export function ridged3(
  x: number,
  y: number,
  z: number,
  seed: number,
  octaves: number,
): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x, fy = y, fz = z;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise3(fx, fy, fz, seed + o * 2029));
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.1;
    fy *= 2.1;
    fz *= 2.1;
  }
  return sum / norm;
}
