import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KSC_3DEP_HEIGHT } from '../src/render/planetDetail/heightSourceAdapter';
import { kscNavd88ToEgm2008Correction } from '../src/render/planetDetail/heightDatum';
import { decodeFloat32Tiff } from '../src/render/planetDetail/numericTiff';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(
  process.env.PERILUNE_KSC_AUTHORITY_SOURCE
    ?? resolve(root, 'assets/planets/sources/usgs-3dep-ksc/ksc-3dep-512-f32.tif'),
);
const outputPath = resolve(root, 'assets/planets/generated/earth/ksc/height-u16.bin');
const lockPath = resolve(root, 'assets/planets/ksc-launch-authority.json');
const expectedSourceSha256 = '972773ae1d0bd8c32cafcda4a8002d99eb9c76d78181e89970f918de05f69dd9';
const quantizationMinimumMeters = -128;
const quantizationMaximumMeters = 256;

const source = await readFile(sourcePath);
const sourceSha256 = createHash('sha256').update(source).digest('hex');
if (sourceSha256 !== expectedSourceSha256) {
  throw new Error(`KSC source checksum changed: expected ${expectedSourceSha256}, got ${sourceSha256}`);
}
const sourceBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
const decoded = decodeFloat32Tiff(sourceBuffer, 512 * 512, { allowSparseTiles: true });
if (decoded.width !== 512 || decoded.height !== 512) throw new Error('KSC source dimensions changed');

let minimumX = decoded.width;
let minimumY = decoded.height;
let maximumX = -1;
let maximumY = -1;
for (let y = 0; y < decoded.height; y++) {
  for (let x = 0; x < decoded.width; x++) {
    if (!Number.isFinite(decoded.values[y * decoded.width + x])) continue;
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
  }
}
if (minimumX > maximumX || minimumY > maximumY) throw new Error('KSC source has no finite raster support');

const width = maximumX - minimumX + 1;
const height = maximumY - minimumY + 1;
const output = new Uint8Array(width * height * 2);
const outputView = new DataView(output.buffer);
const [requestWest, requestSouth, requestEast, requestNorth] = KSC_3DEP_HEIGHT.coverage;
const longitudeAt = (x: number): number => (
  requestWest + x / (decoded.width - 1) * (requestEast - requestWest)
);
const latitudeAt = (y: number): number => (
  requestNorth - y / (decoded.height - 1) * (requestNorth - requestSouth)
);
const coverage = Object.freeze([
  longitudeAt(minimumX),
  latitudeAt(maximumY),
  longitudeAt(maximumX),
  latitudeAt(minimumY),
] as const);
let observedMinimumHeightMeters = Number.POSITIVE_INFINITY;
let observedMaximumHeightMeters = Number.NEGATIVE_INFINITY;
for (let y = minimumY; y <= maximumY; y++) {
  for (let x = minimumX; x <= maximumX; x++) {
    const sourceHeight = decoded.values[y * decoded.width + x];
    if (!Number.isFinite(sourceHeight)) {
      throw new Error(`KSC finite support is not rectangular at ${x},${y}`);
    }
    if (sourceHeight < -100 || sourceHeight > 250) {
      throw new Error(`KSC source height is outside the checked range at ${x},${y}: ${sourceHeight}`);
    }
    const correctedHeight = sourceHeight + kscNavd88ToEgm2008Correction(longitudeAt(x), latitudeAt(y));
    observedMinimumHeightMeters = Math.min(observedMinimumHeightMeters, correctedHeight);
    observedMaximumHeightMeters = Math.max(observedMaximumHeightMeters, correctedHeight);
    const quantized = Math.max(0, Math.min(65535, Math.round(
      (correctedHeight - quantizationMinimumMeters)
      / (quantizationMaximumMeters - quantizationMinimumMeters) * 65535,
    )));
    outputView.setUint16(((y - minimumY) * width + x - minimumX) * 2, quantized, true);
  }
}
if (
  observedMinimumHeightMeters <= quantizationMinimumMeters
  || observedMaximumHeightMeters >= quantizationMaximumMeters
) {
  throw new Error('KSC corrected height exceeds its quantization range');
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, output);
const sha256 = createHash('sha256').update(output).digest('hex');
const lock = {
  schemaVersion: 1,
  bodyId: 'earth',
  datasetId: KSC_3DEP_HEIGHT.datasetId,
  version: `${KSC_3DEP_HEIGHT.generation}-bundled-u16-v1`,
  sourceUrl: KSC_3DEP_HEIGHT.request(KSC_3DEP_HEIGHT.coverage, 512, 512).url,
  sourceSha256,
  path: 'generated/earth/ksc/height-u16.bin',
  sha256,
  byteLength: output.byteLength,
  width,
  height,
  requestCoverage: KSC_3DEP_HEIGHT.coverage,
  coverage,
  verticalDatum: KSC_3DEP_HEIGHT.verticalDatum,
  engineDatum: KSC_3DEP_HEIGHT.engineDatum,
  quantizationMinimumMeters,
  quantizationMaximumMeters,
  observedMinimumHeightMeters,
  observedMaximumHeightMeters,
  blendBandDegrees: 0.01,
};
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`wrote ${outputPath} ${width}x${height} ${sha256}`);
