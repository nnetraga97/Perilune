import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(root, 'assets/planets/sources/nasa-marstrek-viking/source.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const outputPath = resolve(root, lock.localPath);
const temporaryPath = `${outputPath}.partial`;

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function mapWithConcurrency(values, concurrency, operation) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      await operation(values[index], index);
    }
  }));
}

if (lock.schemaVersion !== 1 || lock.tileMatrix !== 3 || lock.columns !== 16 || lock.rows !== 8) {
  throw new Error('Unsupported Mars albedo source lock');
}
if (!/^[a-f0-9]{64}$/.test(lock.derivedSourceSha256 ?? '')) {
  throw new Error('Mars albedo source lock is missing its derived source checksum');
}

mkdirSync(dirname(outputPath), { recursive: true });
if (!existsSync(outputPath) || process.argv.includes('--refresh')) {
  const requests = [];
  for (let row = 0; row < lock.rows; row++) {
    for (let column = 0; column < lock.columns; column++) requests.push({ row, column });
  }
  const tiles = new Array(requests.length);
  await mapWithConcurrency(requests, 8, async ({ row, column }, index) => {
    const url = lock.urlTemplate
      .replace('{TileMatrix}', String(lock.tileMatrix))
      .replace('{TileRow}', String(row))
      .replace('{TileCol}', String(column));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Mars Trek tile ${row}/${column} failed: HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/jpeg')) throw new Error(`Mars Trek tile ${row}/${column} is not JPEG`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    if (metadata.width !== 256 || metadata.height !== 256) {
      throw new Error(`Mars Trek tile ${row}/${column} has unexpected dimensions`);
    }
    tiles[index] = {
      input: bytes,
      left: column * 256,
      top: row * 256,
    };
  });
  rmSync(temporaryPath, { force: true });
  await sharp({
    create: {
      width: lock.sourceDimensions[0],
      height: lock.sourceDimensions[1],
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  }).composite(tiles).png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(temporaryPath);
  const derivedChecksum = checksum(readFileSync(temporaryPath));
  if (derivedChecksum !== lock.derivedSourceSha256) {
    rmSync(temporaryPath, { force: true });
    throw new Error(`Mars albedo source checksum mismatch: expected ${lock.derivedSourceSha256}, got ${derivedChecksum}`);
  }
  renameSync(temporaryPath, outputPath);
  console.log(`assembled Mars Trek Viking source sha256=${derivedChecksum}`);
}

const actualChecksum = checksum(readFileSync(outputPath));
if (actualChecksum !== lock.derivedSourceSha256) {
  throw new Error(`Cached Mars albedo source checksum mismatch: expected ${lock.derivedSourceSha256}, got ${actualChecksum}`);
}
console.log(`verified Mars Trek Viking source: ${outputPath}`);
