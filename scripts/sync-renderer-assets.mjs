import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './lib/canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(root, 'node_modules/three/examples/jsm/libs/basis');
const destinationDir = resolve(root, 'public/basis');
const files = ['basis_transcoder.js', 'basis_transcoder.wasm'];

await mkdir(destinationDir, { recursive: true });
for (const file of files) {
  const source = resolve(sourceDir, file);
  const destination = resolve(destinationDir, file);
  let expected;
  try {
    expected = await readFile(source);
  } catch (error) {
    throw new Error(`Missing pinned Three.js Basis asset: ${source}`, { cause: error });
  }
  await copyFile(source, destination);
  const actual = await readFile(destination);
  if (!actual.equals(expected)) throw new Error(`Basis asset verification failed: ${destination}`);
}

console.log(`renderer assets: verified ${files.length} pinned Three.js Basis files`);

const checkedArtifactPath = resolve(
  process.env.PERILUNE_CHECKED_MANIFEST_PATH ?? resolve(root, 'src/generated/checked-planet-manifest.json'),
);
const checkedArtifact = JSON.parse(await readFile(checkedArtifactPath, 'utf8'));
const manifestDigest = createHash('sha256')
  .update(canonicalJson(checkedArtifact.manifest))
  .digest('hex');
if (manifestDigest !== checkedArtifact.manifestSha256) {
  throw new Error(`Checked planet manifest digest mismatch: expected ${checkedArtifact.manifestSha256}, got ${manifestDigest}`);
}
const planetSourceDir = resolve(root, 'assets/planets');
const planetDestinationDir = resolve(root, 'public/planets');
await rm(planetDestinationDir, { recursive: true, force: true });
let planetFiles = 0;
function checkedAssetPath(base, relativePath) {
  if (
    typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) ||
    /^[a-z][a-z\d+.-]*:/i.test(relativePath) || relativePath.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`Unsafe validated planet asset path: ${relativePath}`);
  }
  const target = resolve(base, relativePath);
  const fromBase = relative(base, target);
  if (!fromBase || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase)) {
    throw new Error(`Unsafe validated planet asset path: ${relativePath}`);
  }
  return target;
}
for (const pack of checkedArtifact.manifest.packs) {
  for (const channel of pack.channels) {
    for (const [relativePath, checksum] of [
      [channel.packagePath, channel.packageChecksumSha256],
      [channel.fallbackPath, channel.fallbackChecksumSha256],
    ]) {
      const source = checkedAssetPath(planetSourceDir, relativePath);
      const destination = checkedAssetPath(planetDestinationDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      const expected = await readFile(source);
      const actualChecksum = createHash('sha256').update(expected).digest('hex');
      if (actualChecksum !== checksum) {
        throw new Error(`Validated planet asset checksum mismatch for ${relativePath}`);
      }
      await copyFile(source, destination);
      const actual = await readFile(destination);
      if (!actual.equals(expected)) throw new Error(`Planet asset verification failed: ${destination}`);
      planetFiles++;
    }
  }
}
console.log(`renderer assets: verified ${planetFiles} validated planet pack files`);

const checkedPartArtifactPath = resolve(
  process.env.PERILUNE_CHECKED_PART_MANIFEST_PATH ?? resolve(root, 'src/generated/checked-part-manifest.json'),
);
const checkedPartArtifact = JSON.parse(await readFile(checkedPartArtifactPath, 'utf8'));
const partManifestDigest = createHash('sha256')
  .update(canonicalJson(checkedPartArtifact.manifest))
  .digest('hex');
if (partManifestDigest !== checkedPartArtifact.manifestSha256) {
  throw new Error(
    `Checked part manifest digest mismatch: expected ${checkedPartArtifact.manifestSha256}, got ${partManifestDigest}`,
  );
}
if (!Array.isArray(checkedPartArtifact.manifest?.models)) {
  throw new Error('Checked part manifest must contain a models array');
}
const partSourceDir = resolve(root, 'assets/parts');
const partDestinationDir = resolve(root, 'public/parts');
const checkedPartFiles = [];
for (const model of checkedPartArtifact.manifest.models) {
  const source = checkedAssetPath(partSourceDir, model.outputPath);
  const expected = await readFile(source);
  const actualChecksum = createHash('sha256').update(expected).digest('hex');
  if (actualChecksum !== model.sha256) {
    throw new Error(`Checked part asset checksum mismatch for ${model.outputPath}`);
  }
  checkedPartFiles.push({ model, source, expected });
}
await rm(partDestinationDir, { recursive: true, force: true });
await mkdir(partDestinationDir, { recursive: true });
let partFiles = 0;
for (const { model, source, expected } of checkedPartFiles) {
  const destination = checkedAssetPath(partDestinationDir, model.outputPath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const actual = await readFile(destination);
  if (!actual.equals(expected)) throw new Error(`Part asset verification failed: ${destination}`);
  partFiles++;
}
console.log(`renderer assets: verified ${partFiles} checked part model files`);
