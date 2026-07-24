import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(root, 'assets/planets/sources/usgs-callisto-galileo-voyager/source.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const sourcePath = resolve(root, lock.sourceLocalPath);
const colorReferencePath = resolve(root, lock.colorReferenceLocalPath);
const outputPath = resolve(root, lock.localPath);
const temporaryPath = `${outputPath}.partial`;

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function downloadPinned(url, path, expectedChecksum, label) {
  if (existsSync(path) && checksum(readFileSync(path)) === expectedChecksum && !process.argv.includes('--refresh')) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = checksum(bytes);
  if (actual !== expectedChecksum) throw new Error(`${label} checksum mismatch: expected ${expectedChecksum}, got ${actual}`);
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  writeFileSync(partial, bytes);
  renameSync(partial, path);
}

function reprojectWestPositiveToCanonical(source, width, height) {
  const output = Buffer.alloc(source.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceX = (Math.floor(width / 2) - x + width) % width;
      output[y * width + x] = source[y * width + sourceX];
    }
  }
  return output;
}

function fillNoDataByObservedScanline(source, sourceValidity, width, height) {
  const filled = Buffer.from(source);
  const validity = Buffer.alloc(source.length);
  const rowsWithData = [];
  for (let y = 0; y < height; y++) {
    const validX = [];
    for (let x = 0; x < width; x++) {
      if (sourceValidity[y * width + x] > 0) {
        validity[y * width + x] = 255;
        validX.push(x);
      }
    }
    if (validX.length === 0) continue;
    rowsWithData.push(y);
    for (let x = 0; x < width; x++) {
      if (validity[y * width + x] !== 0) continue;
      let low = 0;
      let high = validX.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (validX[middle] < x) low = middle + 1;
        else high = middle;
      }
      const right = validX[low % validX.length];
      const left = validX[(low + validX.length - 1) % validX.length];
      const leftDistance = (x - left + width) % width;
      const rightDistance = (right - x + width) % width;
      const nearestX = leftDistance <= rightDistance ? left : right;
      filled[y * width + x] = source[y * width + nearestX];
    }
  }
  if (rowsWithData.length === 0) throw new Error('Callisto source contains no observed pixels');
  const rowsWithDataSet = new Set(rowsWithData);
  for (let y = 0; y < height; y++) {
    if (rowsWithDataSet.has(y)) continue;
    let nearestRow = rowsWithData[0];
    for (const candidate of rowsWithData) {
      if (Math.abs(candidate - y) < Math.abs(nearestRow - y)) nearestRow = candidate;
    }
    filled.copy(filled, y * width, nearestRow * width, (nearestRow + 1) * width);
  }
  return { filled, validity };
}

if (
  lock.schemaVersion !== 1 ||
  lock.sourceDimensions?.[0] !== 15138 ||
  lock.sourceDimensions?.[1] !== 7569 ||
  lock.canonicalDimensions?.[0] !== 4096 ||
  lock.canonicalDimensions?.[1] !== 2048 ||
  lock.sourceLongitudeDirection !== 'west-positive' ||
  lock.canonicalLongitudeDirection !== 'east-positive' ||
  lock.canonicalSeamLongitudeDegrees !== -180
) {
  throw new Error('Unsupported Callisto albedo source lock');
}
for (const field of ['sourceSha256', 'colorReferenceSha256', 'derivedSourceSha256']) {
  if (!/^[a-f0-9]{64}$/.test(lock[field] ?? '')) throw new Error(`Callisto source lock is missing ${field}`);
}

await downloadPinned(lock.sourceUrl, sourcePath, lock.sourceSha256, 'USGS Callisto mosaic');
await downloadPinned(lock.colorReferenceUrl, colorReferencePath, lock.colorReferenceSha256, 'JPL Callisto color reference');
mkdirSync(dirname(outputPath), { recursive: true });

const colorReference = await sharp(colorReferencePath).removeAlpha().toColourspace('srgb')
  .raw().toBuffer({ resolveWithObject: true });
const colorSums = [0, 0, 0];
let colorSamples = 0;
for (let offset = 0; offset < colorReference.data.length; offset += colorReference.info.channels) {
  const red = colorReference.data[offset];
  const green = colorReference.data[offset + 1];
  const blue = colorReference.data[offset + 2];
  if (Math.max(red, green, blue) < 16) continue;
  colorSums[0] += red;
  colorSums[1] += green;
  colorSums[2] += blue;
  colorSamples++;
}
const colorAverages = colorSums.map((sum) => sum / colorSamples);
const colorLuminance = 0.2126 * colorAverages[0] + 0.7152 * colorAverages[1] + 0.0722 * colorAverages[2];
const measuredMultipliers = colorAverages.map((value) => value / colorLuminance);
if (measuredMultipliers.some((value, channel) => Math.abs(value - lock.colorMultipliers[channel]) > 0.001)) {
  throw new Error('Callisto color multipliers no longer match the pinned PIA03456 reference');
}

if (!existsSync(outputPath) || process.argv.includes('--refresh')) {
  const metadata = await sharp(sourcePath).metadata();
  if (metadata.width !== lock.sourceDimensions[0] || metadata.height !== lock.sourceDimensions[1]) {
    throw new Error(`Callisto mosaic must decode as ${lock.sourceDimensions.join('x')}`);
  }
  const [width, height] = lock.canonicalDimensions;
  const resized = await sharp(sourcePath)
    .greyscale()
    .resize(width, height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer();
  const resizedValidity = await sharp(sourcePath)
    .greyscale()
    .threshold(1)
    .resize(width, height, { fit: 'fill', kernel: sharp.kernel.nearest })
    .raw()
    .toBuffer();
  const canonical = reprojectWestPositiveToCanonical(resized, width, height);
  const canonicalValidity = reprojectWestPositiveToCanonical(resizedValidity, width, height);
  const { filled, validity } = fillNoDataByObservedScanline(canonical, canonicalValidity, width, height);
  const blurred = await sharp(filled, { raw: { width, height, channels: 1 } }).blur(6).raw().toBuffer();
  const feather = await sharp(validity, { raw: { width, height, channels: 1 } }).blur(4).raw().toBuffer();
  const rgb = Buffer.alloc(width * height * 3);
  for (let index = 0; index < filled.length; index++) {
    const observedWeight = feather[index] / 255;
    const luminance = filled[index] * observedWeight + blurred[index] * (1 - observedWeight);
    for (let channel = 0; channel < 3; channel++) {
      rgb[index * 3 + channel] = Math.max(0, Math.min(255, Math.round(luminance * lock.colorMultipliers[channel])));
    }
  }
  rmSync(temporaryPath, { force: true });
  await sharp(rgb, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 })
    .toFile(temporaryPath);
  const actual = checksum(readFileSync(temporaryPath));
  if (actual !== lock.derivedSourceSha256) {
    rmSync(temporaryPath, { force: true });
    throw new Error(`Callisto canonical checksum mismatch: expected ${lock.derivedSourceSha256}, got ${actual}`);
  }
  renameSync(temporaryPath, outputPath);
}

const actualChecksum = checksum(readFileSync(outputPath));
if (actualChecksum !== lock.derivedSourceSha256) {
  throw new Error(`Cached Callisto source checksum mismatch: expected ${lock.derivedSourceSha256}, got ${actualChecksum}`);
}
console.log(`verified USGS/NASA Callisto source: ${outputPath}`);
