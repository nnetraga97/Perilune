import { generateAirlessGlobalMaps } from './airless-global-maps';

export const MACRO_HEIGHT_MIN_METERS = -12_000;
export const MACRO_HEIGHT_MAX_METERS = 12_000;

export interface ScientificGlobalMaps {
  readonly albedo: Uint8Array;
  readonly normal: Uint8Array;
  readonly material: Uint8Array;
  readonly heightMacro: Uint8Array;
  readonly clouds?: Uint8Array;
  readonly emissive?: Uint8Array;
  /** Linear RGBA atlas: albedo luminance, OpenGL normal X/Y, roughness. */
  readonly localDetail?: Uint8Array;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Encode signed metre heights into exact high/low RG bytes. The KTX2 path is lossless RG8. */
export function encodeMacroHeight(heights: Float32Array): Uint8Array {
  const encoded = new Uint8Array(heights.length * 2);
  const span = MACRO_HEIGHT_MAX_METERS - MACRO_HEIGHT_MIN_METERS;
  for (let index = 0; index < heights.length; index++) {
    const height = Math.max(MACRO_HEIGHT_MIN_METERS, Math.min(MACRO_HEIGHT_MAX_METERS, heights[index]));
    const quantized = Math.round((height - MACRO_HEIGHT_MIN_METERS) / span * 65_535);
    encoded[index * 2] = quantized >> 8;
    encoded[index * 2 + 1] = quantized & 0xff;
  }
  return encoded;
}

export function decodeMacroHeight(red: number, green: number): number {
  const quantized = red * 256 + green;
  return MACRO_HEIGHT_MIN_METERS + quantized / 65_535 *
    (MACRO_HEIGHT_MAX_METERS - MACRO_HEIGHT_MIN_METERS);
}

export interface EarthGlobalMapOptions {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly albedo: Uint8Array;
  readonly surfaceHeights: Float32Array;
  readonly bedrockHeights: Float32Array;
  readonly cloudLuminance: Uint8Array;
  readonly nightColor?: Uint8Array;
}

/**
 * Derive Earth's render channels only from aligned scientific rasters. Blue
 * Marble supplies identity color, ETOPO supplies relief/ocean/ice masks, and
 * the separate cloud and Black Marble products remain separate light layers.
 */
export function generateEarthGlobalMaps(options: EarthGlobalMapOptions): ScientificGlobalMaps {
  const { width, height, radius, albedo, surfaceHeights, bedrockHeights, cloudLuminance, nightColor } = options;
  const pixelCount = width * height;
  if (albedo.length !== pixelCount * 3) throw new Error('Earth albedo must be aligned RGB8');
  if (surfaceHeights.length !== pixelCount || bedrockHeights.length !== pixelCount) {
    throw new Error('Earth ETOPO surface and bedrock rasters must be aligned');
  }
  if (cloudLuminance.length !== pixelCount) throw new Error('Earth cloud raster must be aligned grayscale');
  if (nightColor && nightColor.length !== pixelCount * 3) throw new Error('Earth night raster must be aligned RGB8');

  const derived = generateAirlessGlobalMaps({ width, height, radius, albedo, heights: surfaceHeights });
  const material = new Uint8Array(pixelCount * 4);
  const clouds = new Uint8Array(pixelCount * 2);
  const emissive = nightColor ? new Uint8Array(nightColor.length) : undefined;
  for (let index = 0; index < pixelCount; index++) {
    const surface = surfaceHeights[index];
    const bedrock = bedrockHeights[index];
    const ocean = surface < 0 ? 1 : 0;
    // ETOPO's ice-surface and bedrock products share the same grid. Their
    // positive land delta identifies grounded ice without reading albedo.
    const iceThickness = Math.max(0, surface - bedrock);
    const ice = surface >= 0 ? Math.min(1, Math.max(0, (iceThickness - 20) / 180)) : 0;
    const baseRoughness = ocean ? 0.16 : ice > 0.05 ? 0.48 : 0.82;
    material[index * 4] = clampByte(baseRoughness * 255);
    material[index * 4 + 1] = derived.material[index * 4 + 1];
    material[index * 4 + 2] = clampByte(ocean * 255);
    material[index * 4 + 3] = clampByte(ice * 255);

    const cloud = cloudLuminance[index] / 255;
    const coverage = Math.max(0, Math.min(1, (cloud - 0.035) / 0.88));
    clouds[index * 2] = clampByte(coverage * 255);
    clouds[index * 2 + 1] = clampByte(Math.pow(coverage, 0.72) * 255);

    if (emissive && nightColor) {
      const offset = index * 3;
      const brightness = Math.max(nightColor[offset], nightColor[offset + 1], nightColor[offset + 2]) / 255;
      // Bound the authored color while preserving the source's warm/cool city
      // light variation. The shader owns scene-referred luminance.
      const scale = brightness <= 0.012 ? 0 : Math.min(1, (brightness - 0.012) / 0.62);
      emissive[offset] = clampByte(nightColor[offset] * scale);
      emissive[offset + 1] = clampByte(nightColor[offset + 1] * scale);
      emissive[offset + 2] = clampByte(nightColor[offset + 2] * scale);
    }
  }

  return {
    albedo,
    normal: derived.normal,
    material,
    heightMacro: encodeMacroHeight(surfaceHeights),
    clouds,
    ...(emissive ? { emissive } : {}),
  };
}

export interface MoonGlobalMapOptions {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly albedo: Uint8Array;
  readonly heights: Float32Array;
}

export function generateMoonGlobalMaps(options: MoonGlobalMapOptions): ScientificGlobalMaps {
  const derived = generateAirlessGlobalMaps(options);
  return {
    ...derived,
    heightMacro: encodeMacroHeight(options.heights),
  };
}
