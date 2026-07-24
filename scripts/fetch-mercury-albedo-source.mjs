import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(root, 'assets/planets/sources/nasa-messenger-mercury/source.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const outputPath = resolve(root, lock.localPath);
const temporaryPath = `${outputPath}.partial`;

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fillPolarObservationVoids(data, width, height) {
  let firstObservedRow = -1;
  let lastObservedRow = -1;
  const observed = (offset) => Math.max(data[offset], data[offset + 1], data[offset + 2]) >= 20;
  for (let y = 0; y < height; y++) {
    const validX = [];
    for (let x = 0; x < width; x++) {
      if (observed((y * width + x) * 3)) validX.push(x);
    }
    if (validX.length === 0) continue;
    if (firstObservedRow < 0) firstObservedRow = y;
    lastObservedRow = y;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      if (observed(offset)) continue;
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
      const blend = leftDistance / Math.max(1, leftDistance + rightDistance);
      for (let channel = 0; channel < 3; channel++) {
        const leftValue = data[(y * width + left) * 3 + channel];
        const rightValue = data[(y * width + right) * 3 + channel];
        data[offset + channel] = Math.round(leftValue + (rightValue - leftValue) * blend);
      }
    }
  }
  if (firstObservedRow < 0 || lastObservedRow < 0) throw new Error('Mercury source has no observed pixels');
  for (const [start, end, sourceRow] of [
    [0, firstObservedRow, firstObservedRow],
    [lastObservedRow + 1, height, lastObservedRow],
  ]) {
    const average = [0, 0, 0];
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        average[channel] += data[(sourceRow * width + x) * 3 + channel];
      }
    }
    for (let channel = 0; channel < 3; channel++) average[channel] = Math.round(average[channel] / width);
    for (let y = start; y < end; y++) {
      for (let x = 0; x < width; x++) {
        for (let channel = 0; channel < 3; channel++) {
          data[(y * width + x) * 3 + channel] = average[channel];
        }
      }
    }
  }
}

function restrainEnhancedColor(data) {
  for (let offset = 0; offset < data.length; offset += 3) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    data[offset] = Math.round(Math.min(255, luminance * 1.07) * 0.9 + red * 0.1);
    data[offset + 1] = Math.round(luminance * 0.9 + green * 0.1);
    data[offset + 2] = Math.round(luminance * 0.92 * 0.9 + blue * 0.1);
  }
}

if (
  lock.schemaVersion !== 1 ||
  lock.sourceDimensions?.[0] !== 4096 ||
  lock.sourceDimensions?.[1] !== 2048 ||
  lock.sourceSeamLongitudeDegrees !== 0 ||
  lock.canonicalSeamLongitudeDegrees !== -180
) {
  throw new Error('Unsupported Mercury albedo source lock');
}
for (const field of ['sourceSha256', 'derivedSourceSha256']) {
  if (!/^[a-f0-9]{64}$/.test(lock[field] ?? '')) {
    throw new Error(`Mercury albedo source lock is missing ${field}`);
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
if (!existsSync(outputPath) || process.argv.includes('--refresh')) {
  const response = await fetch(lock.sourceUrl);
  if (!response.ok) throw new Error(`Mercury PIA17386 download failed: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/jpeg')) throw new Error('Mercury PIA17386 source is not JPEG');
  const sourceBytes = Buffer.from(await response.arrayBuffer());
  const sourceChecksum = checksum(sourceBytes);
  if (sourceChecksum !== lock.sourceSha256) {
    throw new Error(`Mercury source checksum mismatch: expected ${lock.sourceSha256}, got ${sourceChecksum}`);
  }

  const decoded = await sharp(sourceBytes).removeAlpha().toColourspace('srgb')
    .raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = decoded.info;
  if (width !== lock.sourceDimensions[0] || height !== lock.sourceDimensions[1] || channels !== 3) {
    throw new Error(`Mercury source must decode as ${lock.sourceDimensions.join('x')} RGB`);
  }

  // PIA17386 is centered on 180 E with its seam at 0 E. The runtime's
  // canonical body-fixed UV convention centers 0 E and places the seam at
  // -180/180, so rotate each scanline by exactly half its width.
  const rowBytes = width * channels;
  const halfRowBytes = rowBytes / 2;
  const canonical = Buffer.alloc(decoded.data.length);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    decoded.data.copy(canonical, rowStart, rowStart + halfRowBytes, rowStart + rowBytes);
    decoded.data.copy(canonical, rowStart + halfRowBytes, rowStart, rowStart + halfRowBytes);
  }
  fillPolarObservationVoids(canonical, width, height);
  // PIA17386 deliberately exaggerates compositional color. Retain ten percent
  // of that chroma over a warm Rec.709 luminance base so the runtime globe
  // reads like Mercury while preserving source-backed surface structure.
  restrainEnhancedColor(canonical);

  rmSync(temporaryPath, { force: true });
  await sharp(canonical, { raw: { width, height, channels } })
    .png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 })
    .toFile(temporaryPath);
  const derivedChecksum = checksum(readFileSync(temporaryPath));
  if (derivedChecksum !== lock.derivedSourceSha256) {
    rmSync(temporaryPath, { force: true });
    throw new Error(`Mercury canonical source checksum mismatch: expected ${lock.derivedSourceSha256}, got ${derivedChecksum}`);
  }
  renameSync(temporaryPath, outputPath);
  console.log(`assembled canonical Mercury source sha256=${derivedChecksum}`);
}

const actualChecksum = checksum(readFileSync(outputPath));
if (actualChecksum !== lock.derivedSourceSha256) {
  throw new Error(`Cached Mercury albedo source checksum mismatch: expected ${lock.derivedSourceSha256}, got ${actualChecksum}`);
}
console.log(`verified MESSENGER Mercury source: ${outputPath}`);
