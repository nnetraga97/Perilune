export interface AirlessGlobalMaps {
  readonly albedo: Uint8Array;
  readonly normal: Uint8Array;
  readonly material: Uint8Array;
}

export interface AirlessGlobalMapOptions {
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly albedo: Uint8Array;
  readonly heights: Float32Array;
}

const TAU = Math.PI * 2;

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

const MAX_TANGENT_SLOPE = 2;
const POLAR_CONVERGENCE_RADIANS = 4 * Math.PI / 180;

function writeTangentSlope(
  eastSlope: number,
  northSlope: number,
  output: Uint8Array,
  offset: number,
): void {
  const encode = (slope: number) => clampByte(128 + Math.max(-1, Math.min(1, slope / MAX_TANGENT_SLOPE)) * 127);
  output[offset] = encode(eastSlope);
  output[offset + 1] = encode(northSlope);
}

/** Equirectangular pole rows represent one point and therefore must own one height. */
export function stabilizeAirlessPoleRows(heights: Float32Array, width: number, height: number): Float32Array {
  const stable = new Float32Array(heights);
  for (const y of [0, height - 1]) {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += heights[y * width + x];
    const mean = sum / width;
    for (let x = 0; x < width; x++) stable[y * width + x] = mean;
  }
  return stable;
}

/**
 * Collapse unresolved longitude identity as circumference approaches zero.
 * This is a topology correction for the equirectangular singularity, not a
 * cosmetic blur: every longitude is the same physical point at the pole.
 */
export function stabilizeAirlessPolarAlbedo(
  albedo: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const stable = new Uint8Array(albedo);
  for (let y = 0; y < height; y++) {
    const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
    const poleDistance = Math.PI / 2 - Math.abs(latitude);
    const linear = y === 0 || y === height - 1
      ? 1
      : Math.max(0, Math.min(1, 1 - poleDistance / POLAR_CONVERGENCE_RADIANS));
    const weight = linear * linear * (3 - 2 * linear);
    if (weight <= 0) continue;
    const mean = [0, 0, 0];
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++) mean[channel] += Math.pow(albedo[offset + channel] / 255, 2.2);
    }
    for (let channel = 0; channel < 3; channel++) mean[channel] /= width;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        const source = Math.pow(albedo[offset + channel] / 255, 2.2);
        stable[offset + channel] = clampByte(Math.pow(source * (1 - weight) + mean[channel] * weight, 1 / 2.2) * 255);
      }
    }
  }
  return stable;
}

/**
 * Builds fold-free east/north tangent slopes and a conservative airless material
 * map without changing the source albedo. The datum basis is reconstructed from
 * body direction in the shader, avoiding octahedral folds at the lunar poles.
 */
export function generateAirlessGlobalMaps(options: AirlessGlobalMapOptions): AirlessGlobalMaps {
  const { width, height, radius, albedo, heights } = options;
  if (albedo.length !== width * height * 3) throw new Error('Airless albedo must be RGB8 at the target dimensions');
  if (heights.length !== width * height) throw new Error('Airless height raster dimensions do not match the albedo');

  const stableHeights = stabilizeAirlessPoleRows(heights, width, height);
  const stableAlbedo = stabilizeAirlessPolarAlbedo(albedo, width, height);
  const latitudeCos = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
    latitudeCos[y] = Math.cos(latitude);
  }

  const normal = new Uint8Array(width * height * 2);
  const material = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const eastIndex = y * width + ((x + 1) % width);
      const westIndex = y * width + ((x + width - 1) % width);
      const northIndex = Math.max(0, y - 1) * width + x;
      const southIndex = Math.min(height - 1, y + 1) * width + x;
      const eastArcMeters = Math.max(1, radius * latitudeCos[y] * TAU / width);
      const northArcMeters = Math.max(1, radius * Math.PI / height);
      const poleDistance = Math.PI / 2 - Math.abs((0.5 - (y + 0.5) / height) * Math.PI);
      const polarSlopeWeight = Math.max(0, Math.min(1, poleDistance / POLAR_CONVERGENCE_RADIANS));
      const eastSlope = -(stableHeights[eastIndex] - stableHeights[westIndex]) / (eastArcMeters * 2) * polarSlopeWeight;
      const northSlope = (stableHeights[southIndex] - stableHeights[northIndex]) / (northArcMeters * 2) * polarSlopeWeight;
      writeTangentSlope(eastSlope, northSlope, normal, index * 2);

      const radialWeight = 1 / Math.sqrt(1 + eastSlope * eastSlope + northSlope * northSlope);
      const slope = 1 - radialWeight;
      material[index * 4] = clampByte((0.9 - Math.min(0.18, slope * 1.5)) * 255); // roughness
      material[index * 4 + 1] = clampByte((0.96 - Math.min(0.16, slope * 0.8)) * 255); // ambient occlusion
      material[index * 4 + 2] = 0;
      // Keep the unused channel opaque. PNG palette optimizers are allowed to
      // discard RGB values hidden behind zero alpha, but these RGB channels are
      // shader data rather than display color.
      material[index * 4 + 3] = 255;
    }
  }

  return { albedo: stableAlbedo, normal, material };
}
