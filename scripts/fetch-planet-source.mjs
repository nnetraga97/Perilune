import { createHash } from 'node:crypto';
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const URL = 'https://naturalearth.s3.amazonaws.com/10m_raster/NE2_LR_LC.zip';
const SHA256 = '3506ed32f53020eb8822a8c694dc80df7327e21c9a4df0df8f4630756ed4c919';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(root, 'assets/planets/sources/natural-earth-ii-3.2.0');
const archivePath = resolve(sourceDir, 'NE2_LR_LC.zip');
const imagePath = resolve(sourceDir, 'NE2_LR_LC.tif');

function checksum(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

mkdirSync(sourceDir, { recursive: true });
if (!existsSync(archivePath)) {
  const temporaryPath = `${archivePath}.partial`;
  rmSync(temporaryPath, { force: true });
  const response = await fetch(URL);
  if (!response.ok || !response.body) throw new Error(`Natural Earth download failed: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(temporaryPath));
  if (checksum(temporaryPath) !== SHA256) {
    rmSync(temporaryPath, { force: true });
    throw new Error('Natural Earth archive checksum mismatch; refusing extraction');
  }
  renameSync(temporaryPath, archivePath);
}
const actual = checksum(archivePath);
if (actual !== SHA256) throw new Error(`Natural Earth archive checksum mismatch: expected ${SHA256}, got ${actual}`);

// The TIFF is derived from the checksum-pinned archive on every invocation.
// Extracting to a sibling and renaming only after success prevents a stale or
// partially written TIFF from bypassing the archive authority.
const temporaryImagePath = `${imagePath}.partial`;
rmSync(temporaryImagePath, { force: true });
const output = openSync(temporaryImagePath, 'wx');
let extraction;
try {
  extraction = spawnSync('unzip', ['-p', archivePath, 'NE2_LR_LC.tif'], {
    stdio: ['ignore', output, 'pipe'],
    encoding: 'utf8',
  });
} finally {
  closeSync(output);
}
if (extraction.error || extraction.status !== 0) {
  rmSync(temporaryImagePath, { force: true });
  const detail = extraction.error?.message ?? extraction.stderr?.trim() ?? `exit ${extraction.status}`;
  throw new Error(`Natural Earth extraction failed: ${detail}`);
}
renameSync(temporaryImagePath, imagePath);
console.log(`verified Natural Earth II 3.2.0 source: ${archivePath}`);
