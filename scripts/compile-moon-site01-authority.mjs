import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'assets/planets/sources/nasa-pgda-moon-site01/Site01_final_adj_5mpp_surf.tif');
const outputPath = resolve(root, 'assets/planets/generated/moon/site01/height-u16.bin');
const lockPath = resolve(root, 'assets/planets/moon-site01-authority.json');
const sourceSha256 = '3ba7b97cb00a2bcf21189c3aeb535f65afc21207154ab9f0d43c5bdc1f7e747e';
const quantizationMinimumMeters = -600;
const quantizationMaximumMeters = 2000;

const source = await readFile(sourcePath);
if (createHash('sha256').update(source).digest('hex') !== sourceSha256) throw new Error('Site 01 source checksum changed');
const decoded = await sharp(source).raw({ depth: 'float' }).toBuffer({ resolveWithObject: true });
if (decoded.info.width !== 3200 || decoded.info.height !== 3200 || decoded.info.channels < 1) {
  throw new Error('Site 01 source dimensions changed');
}
const floats = new Float32Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength / 4);
const width = 1600;
const height = 1600;
const output = new Uint8Array(width * height * 2);
const view = new DataView(output.buffer);
let minimumHeightMeters = Number.POSITIVE_INFINITY;
let maximumHeightMeters = Number.NEGATIVE_INFINITY;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let count = 0;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const sourceIndex = ((y * 2 + dy) * 3200 + x * 2 + dx) * decoded.info.channels;
        const value = floats[sourceIndex];
        if (Number.isFinite(value)) { sum += value; count++; }
      }
    }
    if (count === 0) throw new Error(`Site 01 has no finite support at ${x},${y}`);
    const value = sum / count;
    minimumHeightMeters = Math.min(minimumHeightMeters, value);
    maximumHeightMeters = Math.max(maximumHeightMeters, value);
    const quantized = Math.max(0, Math.min(65535, Math.round(
      (value - quantizationMinimumMeters) /
      (quantizationMaximumMeters - quantizationMinimumMeters) * 65535,
    )));
    view.setUint16((y * width + x) * 2, quantized, true);
  }
}
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, output);
const digest = createHash('sha256').update(output).digest('hex');
const lock = {
  schemaVersion: 1,
  datasetId: 'nasa-pgda-lola-site01-5m',
  version: 'site01-surface-5m-derived-10m-u16-v1',
  sourceSha256,
  path: 'generated/moon/site01/height-u16.bin',
  sha256: digest,
  byteLength: output.byteLength,
  width,
  height,
  sourcePixelSizeMeters: 5,
  pixelSizeMeters: 10,
  projectedExtentMeters: [-19000, -20000, -3000, -4000],
  sampleOriginMeters: [-18995, -4005],
  projection: 'south-polar-stereographic',
  sphereRadiusMeters: 1737400,
  referenceFrame: 'MOON_ME DE421',
  verticalDatum: '1737400 m Moon reference sphere',
  quantizationMinimumMeters,
  quantizationMaximumMeters,
  observedMinimumHeightMeters: minimumHeightMeters,
  observedMaximumHeightMeters: maximumHeightMeters,
  blendBandMeters: 1000,
};
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`wrote ${outputPath} ${digest}`);
