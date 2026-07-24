import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(root, 'assets/planets/sources/jpl-venus-clouds/source.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const outputPath = resolve(root, lock.localPath);
const temporaryPath = `${outputPath}.partial`;

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

if (
  lock.schemaVersion !== 1 ||
  lock.sourceDimensions?.[0] !== 1440 ||
  lock.sourceDimensions?.[1] !== 720 ||
  lock.canonicalSeamLongitudeDegrees !== -180
) {
  throw new Error('Unsupported Venus cloud source lock');
}
for (const field of ['sourceSha256', 'derivedSourceSha256']) {
  if (!/^[a-f0-9]{64}$/.test(lock[field] ?? '')) {
    throw new Error(`Venus cloud source lock is missing ${field}`);
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
if (!existsSync(outputPath) || process.argv.includes('--refresh')) {
  const response = await fetch(lock.sourceUrl);
  if (!response.ok) throw new Error(`Venus cloud download failed: HTTP ${response.status}`);
  const sourceBytes = Buffer.from(await response.arrayBuffer());
  const sourceChecksum = checksum(sourceBytes);
  if (sourceChecksum !== lock.sourceSha256) {
    throw new Error(`Venus cloud checksum mismatch: expected ${lock.sourceSha256}, got ${sourceChecksum}`);
  }
  const metadata = await sharp(sourceBytes).metadata();
  if (metadata.width !== lock.sourceDimensions[0] || metadata.height !== lock.sourceDimensions[1]) {
    throw new Error(`Venus cloud source must decode as ${lock.sourceDimensions.join('x')}`);
  }
  rmSync(temporaryPath, { force: true });
  writeFileSync(temporaryPath, sourceBytes);
  const derivedChecksum = checksum(readFileSync(temporaryPath));
  if (derivedChecksum !== lock.derivedSourceSha256) {
    rmSync(temporaryPath, { force: true });
    throw new Error(`Venus canonical source checksum mismatch: expected ${lock.derivedSourceSha256}, got ${derivedChecksum}`);
  }
  renameSync(temporaryPath, outputPath);
}

const actualChecksum = checksum(readFileSync(outputPath));
if (actualChecksum !== lock.derivedSourceSha256) {
  throw new Error(`Cached Venus cloud checksum mismatch: expected ${lock.derivedSourceSha256}, got ${actualChecksum}`);
}
console.log(`verified JPL Venus cloud source: ${outputPath}`);
