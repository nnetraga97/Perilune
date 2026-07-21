import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const locks = [
  'assets/planets/sources/nasa-lro-moon-2025/source.lock.json',
  'assets/planets/sources/nasa-pgda-moon-site01/source.lock.json',
  'assets/planets/sources/nasa-sdo-hmi-photosphere/source.lock.json',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

for (const lockPath of locks) {
  const lock = JSON.parse(await readFile(resolve(root, lockPath), 'utf8'));
  const entries = lock.files ?? [{
    name: lock.localPath.split('/').at(-1),
    sha256: lock.sha256,
    byteLength: lock.byteLength,
    dimensions: lock.dimensions,
    localPath: lock.localPath,
  }];
  for (const entry of entries) {
    const path = resolve(root, entry.localPath ?? `assets/planets/sources/nasa-pgda-moon-site01/${entry.name}`);
    const bytes = await readFile(path);
    if (bytes.byteLength !== entry.byteLength) throw new Error(`${path}: byte length changed`);
    if (sha256(bytes) !== entry.sha256) throw new Error(`${path}: checksum changed`);
    const metadata = await sharp(bytes).metadata();
    const expected = entry.dimensions ?? lock.projection?.dimensions;
    if (expected && (metadata.width !== expected[0] || metadata.height !== expected[1])) {
      throw new Error(`${path}: decoded dimensions changed`);
    }
    console.log(`${lock.id}/${entry.role ?? 'source'} ${metadata.width}x${metadata.height} ${entry.sha256}`);
  }
}
