export interface DetailColorTransform {
  readonly scale: readonly [number, number, number];
  readonly bias: readonly [number, number, number];
}

const IDENTITY: DetailColorTransform = Object.freeze({
  scale: Object.freeze([1, 1, 1] as const),
  bias: Object.freeze([0, 0, 0] as const),
});

function srgbByteToLinear(value: number): number {
  const encoded = Math.max(0, Math.min(255, value)) / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

/** Sources whose image service fills no-data areas with opaque black. */
const BLACK_NODATA_DATASETS = new Set(['usda-naip-ksc-2025-29992']);

export function sourceHasBlackNoData(datasetId: string): boolean {
  return BLACK_NODATA_DATASETS.has(datasetId);
}

/**
 * Mark black no-data fill as transparent so the resident parent shows through
 * instead of an opaque black page. Returns the number of masked texels.
 */
export function maskSourceNoData(datasetId: string, pixels: Uint8ClampedArray): number {
  if (!BLACK_NODATA_DATASETS.has(datasetId)) return 0;
  let masked = 0;
  for (let offset = 0; offset + 3 < pixels.length; offset += 4) {
    // JPEG ringing keeps no-data fill a few counts above zero; real imagery
    // (water, asphalt, shadow) stays well above this floor.
    if (pixels[offset] + pixels[offset + 1] + pixels[offset + 2] > 9) continue;
    pixels[offset + 3] = 0;
    masked++;
  }
  return masked;
}

/**
 * Match a visual source's low-frequency exposure to its checked resident
 * parent while preserving the newly resolved spatial frequency. This is an
 * albedo-only transform: numeric height and categorical class never enter it.
 */
export function detailColorTransform(
  datasetId: string,
  pixels: Uint8ClampedArray,
): DetailColorTransform {
  if (datasetId !== 'nasa-moontrek-wac-303ppd-v02' || pixels.length < 4) return IDENTITY;
  let luminance = 0;
  let samples = 0;
  // A bounded stratified scan avoids making upload cost proportional to the
  // full decoded atlas while remaining deterministic across workers/browsers.
  const pixelCount = Math.floor(pixels.length / 4);
  const stride = Math.max(1, Math.floor(pixelCount / 16_384));
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const offset = pixel * 4;
    luminance += srgbByteToLinear(
      pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722,
    );
    samples++;
  }
  const sourceMean = samples > 0 ? luminance / samples : 0;
  const contrast = 1.35;
  // The checked Moon parent is the locked LROC color mosaic. Its deliberately
  // warm, high-key presentation is retained; WAC supplies geography/detail.
  const target: readonly [number, number, number] = [0.515, 0.497, 0.474];
  return Object.freeze({
    scale: Object.freeze([contrast, contrast, contrast] as const),
    bias: Object.freeze(target.map((channel) => channel - sourceMean * contrast) as [number, number, number]),
  });
}
