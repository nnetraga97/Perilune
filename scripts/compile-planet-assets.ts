import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { AUREN_SYSTEM } from '../src/content/system';
import { Vec3 } from '../src/core/vec3';
import { recipeForBody } from '../src/sim/terrainRecipe';
import { solidHeight } from '../src/sim/terrain';
import { Universe } from '../src/sim/universe';
import { generateVeyraCanonicalMaps, type VeyraCanonicalMaps } from './lib/veyra-global-maps';
import { generateVeyraScatter } from './lib/veyra-scatter';
import { expandLogicalRgToRgb, resizeLogicalRg } from './lib/rg-image';

const root = resolve(import.meta.dirname, '..');
const assetsRoot = resolve(root, 'assets/planets');
const recipesPath = resolve(assetsRoot, 'recipes.json');
const manifestPath = resolve(assetsRoot, 'manifest.json');
const outputPath = resolve(assetsRoot, 'compiler-output.json');
const sourcePath = resolve(assetsRoot, 'sources/natural-earth-ii-3.2.0/NE2_LR_LC.tif');
const generatedRoot = resolve(assetsRoot, 'generated/veyra');
const canonicalHeightPath = resolve(generatedRoot, 'canonical/height.s16le');
const canonicalScatterPath = resolve(generatedRoot, 'canonical/scatter.json');
const runtimeScatterPath = resolve(root, 'src/generated/veyra-scatter.json');
const canonicalWidth = 8192;
const canonicalHeight = 4096;
const fingerprintWidth = 64;
const fingerprintHeight = 32;
const quantizationMeters = 0.5;
const compilerVersion = '2.3.0';
const sourceArchiveSha256 = '3506ed32f53020eb8822a8c694dc80df7327e21c9a4df0df8f4630756ed4c919';
const write = process.argv.includes('--write');
const writeGlobal = write && !process.argv.includes('--fingerprints-only');

interface RecipeRecord { bodyId: string; version: number; hash: string }
interface ChannelOutput {
  name: 'albedo' | 'normal' | 'material' | 'clouds';
  colorSpace: 'sRGB' | 'linear';
  logicalFormat: 'RGB8' | 'RG8' | 'RGBA8';
  packagePath: string;
  fallbackPath: string;
  packageChecksumSha256: string;
  fallbackChecksumSha256: string;
  gpuFormat: 'etc2-rgb' | 'bc5-rg' | 'bc3-rgba';
  gpuBytes: number;
  fallbackGpuBytes: number;
  fallbackLayout: 'rgb' | 'rgb-rg' | 'rgba';
  transcodeTargets: readonly string[];
  mipmapped: true;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function rawHeightFingerprint(body: ReturnType<Universe['get']>): string | null {
  if (body.def.surfaceKind !== 'solid') return null;
  const bytes = new Uint8Array(fingerprintWidth * fingerprintHeight * 2);
  const view = new DataView(bytes.buffer);
  const direction = new Vec3();
  for (let y = 0; y < fingerprintHeight; y++) {
    const latitude = (0.5 - (y + 0.5) / fingerprintHeight) * Math.PI;
    for (let x = 0; x < fingerprintWidth; x++) {
      const longitude = ((x + 0.5) / fingerprintWidth) * Math.PI * 2 - Math.PI;
      direction.set(Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude));
      const surface = solidHeight(body, direction);
      if (surface.kind !== 'solid') throw new Error(`Missing solid height for ${body.id}`);
      const quantized = Math.round(surface.height / quantizationMeters);
      if (quantized < -32768 || quantized > 32767) throw new Error(`${body.id} height exceeds signed-16-bit fingerprint range`);
      view.setInt16((y * fingerprintWidth + x) * 2, quantized, true);
    }
  }
  return sha256(bytes);
}

function fullMipBytes(width: number, height: number, blockBytes: number): number {
  let total = 0;
  for (;;) {
    total += Math.ceil(width / 4) * Math.ceil(height / 4) * blockBytes;
    if (width === 1 && height === 1) return total;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }
}

function fullMipRgbaBytes(width: number, height: number): number {
  let total = 0;
  for (;;) {
    total += width * height * 4;
    if (width === 1 && height === 1) return total;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }
}

function relativeAssetPath(path: string): string {
  return relative(assetsRoot, path).split('\\').join('/');
}

function runKtx(inputPath: string, outputPath: string, channel: ChannelOutput['name']): void {
  const executable = process.env.KTX_CLI ?? 'ktx';
  const format = channel === 'albedo' ? 'R8G8B8_SRGB' :
    channel === 'material' ? 'R8G8B8A8_UNORM' : 'R8G8_UNORM';
  const encoding = channel === 'albedo'
    ? ['--encode', 'basis-lz', '--qlevel', '180']
    : ['--encode', 'uastc', '--uastc-quality', '2', '--zstd', '9'];
  const result = spawnSync(executable, [
    'create', '--format', format, '--generate-mipmap', '--mipmap-filter', 'lanczos3',
    '--threads', '1', '--testrun', '--assign-texcoord-origin', 'top-left',
    ...encoding, inputPath, outputPath,
  ], { encoding: 'utf8', env: process.env });
  if (result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout ||
      `exit=${String(result.status)} signal=${String(result.signal)}`;
    throw new Error(`KTX encoding failed for ${channel}: ${detail}`);
  }
}

async function writeTier(
  tier: 'low' | 'medium' | 'high',
  width: number,
  height: number,
  canonical: VeyraCanonicalMaps,
): Promise<{ pack: Record<string, unknown>; channels: ChannelOutput[] }> {
  const tierDir = resolve(generatedRoot, tier);
  mkdirSync(tierDir, { recursive: true });
  const definitions = [
    { name: 'albedo' as const, data: canonical.albedo, channels: 3 as const, fallback: 'webp' as const },
    { name: 'normal' as const, data: canonical.normal, channels: 2 as const, fallback: 'png' as const },
    { name: 'material' as const, data: canonical.material, channels: 4 as const, fallback: 'png' as const },
    { name: 'clouds' as const, data: canonical.clouds, channels: 2 as const, fallback: 'png' as const },
  ];
  const channels: ChannelOutput[] = [];
  for (const definition of definitions) {
    const resized = definition.channels === 2
      ? await resizeLogicalRg(definition.data, canonicalWidth, canonicalHeight, width, height)
      : await sharp(Buffer.from(definition.data), {
        raw: { width: canonicalWidth, height: canonicalHeight, channels: definition.channels },
        sequentialRead: true,
      }).resize(width, height, { kernel: sharp.kernel.lanczos3 }).raw().toBuffer();
    const image = sharp(resized, { raw: { width, height, channels: definition.channels } });
    const fallbackPath = resolve(tierDir, `${definition.name}.${definition.fallback}`);
    const encoderInput = resolve(tierDir, `${definition.name}.encoder.png`);
    if (definition.fallback === 'webp') {
      await image.clone().webp({ quality: 92, effort: 6, smartSubsample: true }).toFile(fallbackPath);
      await image.clone().png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(encoderInput);
    } else if (definition.channels === 2) {
      const rgb = expandLogicalRgToRgb(resized, width, height);
      await sharp(rgb, { raw: { width, height, channels: 3 } })
        .png({ palette: false, compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(fallbackPath);
      await image.clone().png({ palette: false, compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(encoderInput);
    } else {
      await image.clone().png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(fallbackPath);
      await image.clone().png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(encoderInput);
    }
    const packagePath = resolve(tierDir, `${definition.name}.ktx2`);
    runKtx(encoderInput, packagePath, definition.name);
    rmSync(encoderInput, { force: true });
    const blockBytes = definition.name === 'albedo' ? 8 : 16;
    channels.push({
      name: definition.name,
      colorSpace: definition.name === 'albedo' ? 'sRGB' : 'linear',
      logicalFormat: definition.name === 'albedo' ? 'RGB8' : definition.name === 'material' ? 'RGBA8' : 'RG8',
      packagePath: relativeAssetPath(packagePath),
      fallbackPath: relativeAssetPath(fallbackPath),
      packageChecksumSha256: sha256(readFileSync(packagePath)),
      fallbackChecksumSha256: sha256(readFileSync(fallbackPath)),
      gpuFormat: definition.name === 'albedo' ? 'etc2-rgb' : definition.name === 'normal' || definition.name === 'clouds' ? 'bc5-rg' : 'bc3-rgba',
      gpuBytes: fullMipBytes(width, height, blockBytes),
      fallbackGpuBytes: fullMipRgbaBytes(width, height),
      fallbackLayout: definition.name === 'albedo' ? 'rgb' : definition.name === 'material' ? 'rgba' : 'rgb-rg',
      transcodeTargets: definition.name === 'albedo'
        ? ['etc2-rgb', 'bc1-rgb']
        : definition.name === 'material'
          ? ['etc2-rgba', 'bc3-rgba', 'astc-rgba']
          : ['etc2-rgba', 'bc5-rg', 'astc-rgba'],
      mipmapped: true,
    });
  }
  const compressedBytes = channels.reduce((sum, channel) => sum + statSync(resolve(assetsRoot, channel.packagePath)).size, 0);
  return {
    channels,
    pack: {
      bodyId: 'veyra', tier, width, height, compressedBytes,
      transientBytes: width * height * 22,
      bootCritical: tier === 'medium',
      channels,
    },
  };
}

async function compileVeyraGlobal(universe: Universe): Promise<{
  rawHashes: VeyraCanonicalMaps['rawHashes'];
  heightChecksumSha256: string;
  packs: unknown[];
}> {
  const metadata = await sharp(sourcePath).metadata();
  if (metadata.width !== 16200 || metadata.height !== 8100 || metadata.space !== 'srgb') {
    throw new Error(`Natural Earth source must be 16200x8100 sRGB; got ${metadata.width}x${metadata.height} ${metadata.space}`);
  }
  const source = await sharp(sourcePath)
    .resize(canonicalWidth, canonicalHeight, { kernel: sharp.kernel.lanczos3 })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (source.info.channels !== 3) throw new Error(`Natural Earth decode must produce RGB, got ${source.info.channels} channels`);
  const veyra = universe.get('veyra');
  const canonical = generateVeyraCanonicalMaps({
    width: canonicalWidth,
    height: canonicalHeight,
    source: { data: source.data, width: source.info.width, height: source.info.height, channels: 3 },
    radius: veyra.radius,
    heightAt: (direction) => {
      const surface = solidHeight(veyra, direction);
      if (surface.kind !== 'solid') throw new Error('Veyra must retain a solid terrain authority');
      return surface.height;
    },
    seed: veyra.def.terrain.seed,
  });
  mkdirSync(dirname(canonicalHeightPath), { recursive: true });
  writeFileSync(canonicalHeightPath, canonical.heightS16le);
  const heightChecksumSha256 = sha256(canonical.heightS16le);
  const tiers = [];
  tiers.push(await writeTier('low', 1024, 512, canonical));
  tiers.push(await writeTier('medium', 2048, 1024, canonical));
  tiers.push(await writeTier('high', 4096, 2048, canonical));
  return { rawHashes: canonical.rawHashes, heightChecksumSha256, packs: tiers.map((tier) => tier.pack) };
}

const recipeFile = JSON.parse(readFileSync(recipesPath, 'utf8')) as { schemaVersion: number; recipes: RecipeRecord[] };
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>;
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
if (manifest.compiler.imageLibraryVersion !== `sharp@${packageJson.devDependencies.sharp}`) throw new Error('Manifest image library does not match the pinned sharp dependency');
if (manifest.compiler.compressionThreads !== 1) throw new Error('Planet compiler packaging must remain single-threaded');
const declared = new Map(recipeFile.recipes.map((recipe) => [recipe.bodyId, recipe]));
const universe = new Universe(AUREN_SYSTEM);
const bodies = [...universe.bodies.values()].map((body) => {
  const runtimeRecipe = recipeForBody(body);
  const record = declared.get(body.id);
  if (!record || record.version !== runtimeRecipe.version || record.hash !== runtimeRecipe.hash) throw new Error(`Recipe metadata drift for ${body.id}`);
  return { bodyId: body.id, surfaceKind: body.def.surfaceKind, recipeVersion: runtimeRecipe.version, recipeHash: runtimeRecipe.hash, rawHeightSha256: rawHeightFingerprint(body) };
}).sort((a, b) => a.bodyId.localeCompare(b.bodyId));

let veyraCanonical = (JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, any>).veyraCanonical;

// Physical scatter compiles from the canonical quantized height buffer with an
// integer PRNG; it is platform-deterministic and never touches GPU textures.
const veyraBody = universe.get('veyra');
const veyraTerrainHash = recipeForBody(veyraBody).hash;
const heightBuffer = readFileSync(canonicalHeightPath);
const heightTexels = new Int16Array(heightBuffer.buffer, heightBuffer.byteOffset, heightBuffer.length / 2);
const scatterRecipe = generateVeyraScatter({
  bodyId: 'veyra',
  terrainRecipeHash: veyraTerrainHash,
  radius: veyraBody.radius,
  height: { width: canonicalWidth, height: canonicalHeight, texels: heightTexels },
});
const scatterJson = `${JSON.stringify(scatterRecipe, null, 2)}\n`;
const scatterChecksum = sha256(Buffer.from(scatterJson));
const scatterArtifact = {
  bodyId: 'veyra',
  kind: 'physical-scatter',
  path: relativeAssetPath(canonicalScatterPath),
  runtimePath: relative(root, runtimeScatterPath).split('\\').join('/'),
  recordCount: scatterRecipe.recordCount,
  cellCount: scatterRecipe.cells.length,
  cellResolution: scatterRecipe.cellResolution,
  scatterRecipeHash: scatterRecipe.hash,
  terrainRecipeHash: veyraTerrainHash,
  checksumSha256: scatterChecksum,
};
if (write) {
  mkdirSync(dirname(canonicalScatterPath), { recursive: true });
  writeFileSync(canonicalScatterPath, scatterJson);
  mkdirSync(dirname(runtimeScatterPath), { recursive: true });
  writeFileSync(runtimeScatterPath, scatterJson);
}

if (writeGlobal) {
  const global = await compileVeyraGlobal(universe);
  const veyraRecipe = recipeForBody(universe.get('veyra'));
  const identitySha256 = sha256(Buffer.from(JSON.stringify([
    compilerVersion,
    manifest.compiler.containerImage,
    manifest.compiler.ktxSoftwareVersion,
    manifest.compiler.ktxArchiveSha256,
    sourceArchiveSha256,
    veyraRecipe.version,
    veyraRecipe.hash,
    canonicalWidth,
    canonicalHeight,
    quantizationMeters,
    global.rawHashes,
    global.heightChecksumSha256,
  ])));
  const heightArtifact = {
    bodyId: 'veyra',
    kind: 'height-s16le',
    path: relativeAssetPath(canonicalHeightPath),
    width: canonicalWidth,
    height: canonicalHeight,
    quantizationMeters,
    offsetMeters: 0,
    byteOrder: 'little-endian',
    checksumSha256: global.heightChecksumSha256,
    identitySha256,
    recipeHash: veyraRecipe.hash,
    sourceChecksumSha256: sourceArchiveSha256,
    compilerVersion,
    containerImage: manifest.compiler.containerImage,
  };
  veyraCanonical = {
    width: canonicalWidth,
    height: canonicalHeight,
    rawHashes: global.rawHashes,
    identitySha256,
    heightArtifact: {
      path: heightArtifact.path,
      checksumSha256: heightArtifact.checksumSha256,
      quantizationMeters,
      byteOrder: 'little-endian',
    },
  };
  manifest.sources = [{
    id: 'natural-earth-ii-3.2.0',
    url: 'https://naturalearth.s3.amazonaws.com/10m_raster/NE2_LR_LC.zip',
    author: 'Natural Earth',
    license: 'Public-Domain',
    licenseUrl: 'https://www.naturalearthdata.com/about/terms-of-use/',
    attribution: 'Made with Natural Earth; modified by Perilune',
    checksumSha256: sourceArchiveSha256,
    localPath: 'sources/natural-earth-ii-3.2.0/NE2_LR_LC.zip',
    authoringOnly: true,
    sourceDimensions: [16200, 8100],
    transformations: ['body-fixed color reprojection and biome-aware recolor', 'solidHeight-derived ocean/material masks and oct normals', 'deterministic cloud synthesis', 'independent logical RG Lanczos3 tier resampling', 'truecolor fallback encoding', 'BasisLZ and UASTC KTX2 encoding'],
    bodies: ['veyra'], channels: ['albedo'],
  }];
  manifest.canonicalArtifacts = [heightArtifact, scatterArtifact];
  manifest.budgets.rendererBaseGpuBytes = {
    low: 64 * 1024 * 1024,
    medium: 96 * 1024 * 1024,
    high: 128 * 1024 * 1024,
  };
  manifest.packs = global.packs;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
const output = `${JSON.stringify({
  schemaVersion: 1,
  compilerVersion,
  fingerprint: { width: fingerprintWidth, height: fingerprintHeight, quantizationMeters, byteOrder: 'little-endian' },
  bodies,
  ...(veyraCanonical ? { veyraCanonical } : {}),
  veyraScatter: {
    path: scatterArtifact.path,
    runtimePath: scatterArtifact.runtimePath,
    scatterRecipeHash: scatterArtifact.scatterRecipeHash,
    terrainRecipeHash: scatterArtifact.terrainRecipeHash,
    recordCount: scatterArtifact.recordCount,
    cellCount: scatterArtifact.cellCount,
    cellResolution: scatterArtifact.cellResolution,
    checksumSha256: scatterArtifact.checksumSha256,
  },
}, null, 2)}\n`;
if (write) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output);
  console.log(`wrote ${outputPath}`);
} else {
  const existing = readFileSync(outputPath, 'utf8');
  if (existing !== output) throw new Error('Planet compiler output is stale; run compile:planet-assets -- --write');
  console.log(`planet compiler check passed: ${bodies.length} bodies`);
}
