import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const HEIGHT_SOURCE_DEFINITIONS = Object.freeze({
  earthSurface: Object.freeze({
    bodyId: 'earth',
    sourceId: 'noaa-etopo-2022-earth-surface-60s',
    relativePath: 'assets/planets/sources/noaa-etopo-2022/ETOPO_2022_v1_60s_N90W180_surface.tif',
    sourceDimensions: Object.freeze([21600, 10800]),
    storage: 'float32-metres',
    valueScale: 1,
    valueOffset: 0,
    verticalDatum: 'EGM2008 geoid',
    validRange: Object.freeze([-12_000, 12_000]),
  }),
  earthBedrock: Object.freeze({
    bodyId: 'earth',
    sourceId: 'noaa-etopo-2022-earth-bedrock-60s',
    relativePath: 'assets/planets/sources/noaa-etopo-2022/ETOPO_2022_v1_60s_N90W180_bed.tif',
    sourceDimensions: Object.freeze([21600, 10800]),
    storage: 'float32-metres',
    valueScale: 1,
    valueOffset: 0,
    verticalDatum: 'EGM2008 geoid',
    validRange: Object.freeze([-12_000, 12_000]),
  }),
  moon: Object.freeze({
    bodyId: 'moon',
    sourceId: 'nasa-lola-moon-height',
    relativePath: 'assets/planets/sources/nasa-lro-palla/ldem_16_uint.tif',
    sourceDimensions: Object.freeze([5760, 2880]),
    storage: 'uint16-scaled-metres',
    valueScale: 0.5,
    valueOffset: -10_000,
    verticalDatum: '1737400 m LOLA reference sphere',
    validRange: Object.freeze([-12_000, 12_000]),
  }),
});

export const NUMERIC_HEIGHT_KERNEL = 'lanczos3';

export async function sourceSha256(root, definition) {
  return createHash('sha256')
    .update(await readFile(path.join(root, definition.relativePath)))
    .digest('hex');
}

export async function deriveScientificHeight(root, definition, width, height) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`Invalid height derivative dimensions ${width}x${height}`);
  }
  const sourcePath = path.join(root, definition.relativePath);
  let result;
  if (definition.storage === 'float32-metres') {
    result = await sharp(sourcePath, { limitInputPixels: false, sequentialRead: true })
      .resize(width, height, { kernel: NUMERIC_HEIGHT_KERNEL })
      .toColourspace('b-w')
      .raw({ depth: 'float' })
      .toBuffer({ resolveWithObject: true });
  } else if (definition.storage === 'uint16-scaled-metres') {
    result = await sharp(sourcePath, { limitInputPixels: false, sequentialRead: true })
      .toColourspace('grey16')
      .resize(width, height, { kernel: NUMERIC_HEIGHT_KERNEL })
      .raw({ depth: 'ushort' })
      .toBuffer({ resolveWithObject: true });
  } else {
    throw new Error(`Unsupported numeric height storage ${definition.storage}`);
  }
  if (result.info.channels !== 1 || result.info.width !== width || result.info.height !== height) {
    throw new Error(`${definition.sourceId} must decode to ${width}x${height} one-channel numeric height`);
  }
  const input = definition.storage === 'float32-metres'
    ? new Float32Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 4)
    : new Uint16Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 2);
  const heights = new Float32Array(width * height);
  let minimum = Infinity;
  let maximum = -Infinity;
  let noDataCount = 0;
  for (let index = 0; index < input.length; index++) {
    const value = input[index] * definition.valueScale + definition.valueOffset;
    if (!Number.isFinite(value)) {
      heights[index] = 0;
      noDataCount++;
      continue;
    }
    if (value < definition.validRange[0] || value > definition.validRange[1]) {
      throw new Error(`${definition.sourceId} produced out-of-contract height ${value}`);
    }
    heights[index] = value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (noDataCount > 0) throw new Error(`${definition.sourceId} produced ${noDataCount} nodata samples`);
  return Object.freeze({
    heights,
    width,
    height,
    minimum,
    maximum,
    noDataCount,
    sourceId: definition.sourceId,
    sourcePath: definition.relativePath,
    verticalDatum: definition.verticalDatum,
    kernel: NUMERIC_HEIGHT_KERNEL,
  });
}

export function encodeHalfMetreInt16(heights) {
  const encoded = Buffer.allocUnsafe(heights.length * 2);
  let worstQuantizationErrorMeters = 0;
  let sumSquaredError = 0;
  for (let index = 0; index < heights.length; index++) {
    const quantized = Math.max(-32768, Math.min(32767, Math.round(heights[index] * 2)));
    encoded.writeInt16LE(quantized, index * 2);
    const error = quantized * 0.5 - heights[index];
    worstQuantizationErrorMeters = Math.max(worstQuantizationErrorMeters, Math.abs(error));
    sumSquaredError += error * error;
  }
  return Object.freeze({
    encoded,
    scaleMeters: 0.5,
    offsetMeters: 0,
    worstQuantizationErrorMeters,
    rmsQuantizationErrorMeters: Math.sqrt(sumSquaredError / heights.length),
  });
}
