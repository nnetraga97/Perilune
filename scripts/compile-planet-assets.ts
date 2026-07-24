import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { LEGACY_AUREN_SYSTEM as AUREN_SYSTEM } from '../tests/fixtures/legacyAurenSystem';
import { SOL_SYSTEM } from '../src/content/system';
import { Vec3 } from '../src/core/vec3';
import { recipeForBody } from '../src/sim/terrainRecipe';
import { solidHeight } from '../src/sim/terrain';
import { Universe } from '../src/sim/universe';
import { generateVeyraCanonicalMaps, type VeyraCanonicalMaps } from './lib/veyra-global-maps';
import { generateAirlessGlobalMaps, type AirlessGlobalMaps } from './lib/airless-global-maps';
import { generateVeyraScatter } from './lib/veyra-scatter';
import { expandLogicalRgToRgb, resizeLogicalRg } from './lib/rg-image';
import {
  generateEarthGlobalMaps,
  generateMoonGlobalMaps,
  type ScientificGlobalMaps,
} from './lib/scientific-global-maps';
import {
  deriveScientificHeight,
  HEIGHT_SOURCE_DEFINITIONS,
} from './lib/scientific-height-derivation.mjs';
import {
  KSC_SURFACE_CLASS_BOUNDS,
  KSC_SURFACE_CLASS_DIMENSIONS,
  overlayNwiGeoJson,
  rasterizeGshhg,
} from './lib/surface-classification.mjs';

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
const compilerVersion = '2.4.0';
const sourceArchiveSha256 = '3506ed32f53020eb8822a8c694dc80df7327e21c9a4df0df8f4630756ed4c919';
const write = process.argv.includes('--write');
const fingerprintsOnly = process.argv.includes('--fingerprints-only');
const tierDimensions = {
  low: [1024, 512],
  medium: [2048, 1024],
  high: [4096, 2048],
} as const;
type CompiledTier = keyof typeof tierDimensions;
const compiledBodyIds = ['veyra', 'palla', 'wisp', 'mercury', 'earth', 'moon', 'mars', 'sun'] as const;
type CompiledBody = typeof compiledBodyIds[number];
const compiledBodies = new Set<string>(compiledBodyIds);

function optionValues(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(...value.split(',').map((entry) => entry.trim()).filter(Boolean));
  }
  return values;
}

const requestedBodies = optionValues('--body');
const targetBodies = new Set<CompiledBody>(
  (requestedBodies.length > 0 ? requestedBodies : ['veyra']).map((bodyId) => {
    if (!compiledBodies.has(bodyId)) throw new Error(`Unsupported compiled body: ${bodyId}`);
    return bodyId as CompiledBody;
  }),
);
const requestedTiers = optionValues('--tier');
const targetTiers = new Set<CompiledTier>(
  (requestedTiers.length > 0 ? requestedTiers : Object.keys(tierDimensions)).map((tier) => {
    if (!(tier in tierDimensions)) throw new Error(`Unsupported planet asset tier: ${tier}`);
    return tier as CompiledTier;
  }),
);
const writeGlobal = write && !fingerprintsOnly && targetBodies.has('veyra');

interface RecipeRecord { bodyId: string; version: number; hash: string }
interface ChannelOutput {
  name: 'albedo' | 'normal' | 'material' | 'clouds' | 'heightMacro' | 'emissive' | 'localDetail' | 'surfaceClass' | 'surfaceClassRegional' | 'photosphereActivity';
  colorSpace: 'sRGB' | 'linear';
  logicalFormat: 'R8' | 'RGB8' | 'RG8' | 'RGBA8';
  packagePath: string;
  fallbackPath: string;
  packageChecksumSha256: string;
  fallbackChecksumSha256: string;
  gpuFormat: 'etc2-rgb' | 'bc5-rg' | 'bc3-rgba' | 'r8' | 'rg8';
  gpuBytes: number;
  fallbackGpuBytes: number;
  fallbackLayout: 'r' | 'rgb' | 'rgb-rg' | 'rgba';
  transcodeTargets: readonly string[];
  mipmapped: boolean;
  width?: number;
  height?: number;
  bounds?: readonly [number, number, number, number];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
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

function fullMipRgBytes(width: number, height: number): number {
  let total = 0;
  for (;;) {
    total += width * height * 2;
    if (width === 1 && height === 1) return total;
    width = Math.max(1, width >> 1);
    height = Math.max(1, height >> 1);
  }
}

function relativeAssetPath(path: string): string {
  return relative(assetsRoot, path).split('\\').join('/');
}

function runKtx(inputPath: string, outputPath: string, channel: ChannelOutput['name'], mipmapped: boolean): Promise<void> {
  const executable = process.env.KTX_CLI ?? 'ktx';
  const colorChannel = channel === 'albedo' || channel === 'emissive';
  const classChannel = channel === 'surfaceClass' || channel === 'surfaceClassRegional' || channel === 'photosphereActivity';
  const format = colorChannel ? 'R8G8B8_SRGB' :
    classChannel ? 'R8_UNORM' : channel === 'material' || channel === 'localDetail' ? 'R8G8B8A8_UNORM' : 'R8G8_UNORM';
  const encoding = channel === 'heightMacro' || classChannel
    ? ['--zstd', '9']
    : colorChannel
    ? ['--encode', 'basis-lz', '--qlevel', '180']
    : ['--encode', 'uastc', '--uastc-quality', '2', '--zstd', '9'];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [
      'create', '--format', format,
      ...(mipmapped ? ['--generate-mipmap', '--mipmap-filter', 'lanczos3'] : []),
      '--threads', '1', '--testrun', '--assign-texcoord-origin', 'top-left',
      ...encoding, inputPath, outputPath,
    ], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (bytes) => { output += String(bytes); });
    child.stderr.on('data', (bytes) => { output += String(bytes); });
    child.on('error', (error) => reject(new Error(`KTX encoding failed for ${channel}: ${error.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`KTX encoding failed for ${channel}: ${output || `exit=${code} signal=${signal}`}`));
    });
  });
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      await operation(values[index]);
    }
  }));
}

async function writeTier(
  bodyId: CompiledBody,
  tier: CompiledTier,
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  maps: AirlessGlobalMaps | VeyraCanonicalMaps | ScientificGlobalMaps,
): Promise<{ pack: Record<string, unknown>; channels: ChannelOutput[] }> {
  const bodyGeneratedRoot = resolve(assetsRoot, `generated/${bodyId}`);
  const tierDir = resolve(bodyGeneratedRoot, tier);
  mkdirSync(tierDir, { recursive: true });
  const definitions = [
    { name: 'albedo' as const, data: maps.albedo, channels: 3 as const, fallback: 'webp' as const, width, height, mipmapped: true },
    { name: 'normal' as const, data: maps.normal, channels: 2 as const, fallback: 'png' as const, width, height, mipmapped: true },
    { name: 'material' as const, data: maps.material, channels: 4 as const, fallback: 'png' as const, width, height, mipmapped: true },
    ...('clouds' in maps && maps.clouds
      ? [{ name: 'clouds' as const, data: maps.clouds, channels: 2 as const, fallback: 'png' as const, width, height, mipmapped: true }]
      : []),
    ...('heightMacro' in maps
      ? [{ name: 'heightMacro' as const, data: maps.heightMacro, channels: 2 as const, fallback: 'png' as const, width, height, mipmapped: true }]
      : []),
    ...('emissive' in maps && maps.emissive
      ? [{ name: 'emissive' as const, data: maps.emissive, channels: 3 as const, fallback: 'webp' as const, width, height, mipmapped: true }]
      : []),
    ...('localDetail' in maps && maps.localDetail
      ? [{ name: 'localDetail' as const, data: maps.localDetail, channels: 4 as const, fallback: 'png' as const, width, height, mipmapped: true }]
      : []),
    ...('surfaceClass' in maps && maps.surfaceClass
      ? [{ name: 'surfaceClass' as const, data: maps.surfaceClass, channels: 1 as const, fallback: 'png' as const, width, height, mipmapped: false }]
      : []),
    ...('surfaceClassRegional' in maps && maps.surfaceClassRegional
      ? [{
        name: 'surfaceClassRegional' as const,
        data: maps.surfaceClassRegional.data,
        channels: 1 as const,
        fallback: 'png' as const,
        width: maps.surfaceClassRegional.width,
        height: maps.surfaceClassRegional.height,
        bounds: maps.surfaceClassRegional.bounds,
        mipmapped: false,
      }]
      : []),
  ];
  const channels: ChannelOutput[] = [];
  const prepared: Array<{ definition: (typeof definitions)[number]; fallbackPath: string; encoderInput: string; packagePath: string }> = [];
  for (const definition of definitions) {
    const classChannel = definition.name === 'surfaceClass' || definition.name === 'surfaceClassRegional';
    const definitionWidth = definition.width;
    const definitionHeight = definition.height;
    const resized = classChannel
      ? Buffer.from(definition.data)
      : sourceWidth === definitionWidth && sourceHeight === definitionHeight
      ? Buffer.from(definition.data)
      : definition.channels === 2
      ? await resizeLogicalRg(definition.data, sourceWidth, sourceHeight, definitionWidth, definitionHeight)
      : await sharp(Buffer.from(definition.data), {
        raw: { width: sourceWidth, height: sourceHeight, channels: definition.channels },
        sequentialRead: true,
      }).resize(definitionWidth, definitionHeight, { kernel: sharp.kernel.lanczos3 }).raw().toBuffer();
    if (resized.length !== definitionWidth * definitionHeight * definition.channels) {
      throw new Error(`${definition.name} byte length does not match its declared exact raster dimensions`);
    }
    const image = sharp(resized, { raw: { width: definitionWidth, height: definitionHeight, channels: definition.channels } });
    const fallbackPath = resolve(tierDir, `${definition.name}.${definition.fallback}`);
    const encoderInput = resolve(tierDir, `${definition.name}.encoder.png`);
    if (definition.fallback === 'webp') {
      await image.clone().webp({ quality: 92, effort: 6, smartSubsample: true }).toFile(fallbackPath);
      await image.clone().png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(encoderInput);
    } else if (definition.channels === 2) {
      const rgb = expandLogicalRgToRgb(resized, definitionWidth, definitionHeight);
      await sharp(rgb, { raw: { width: definitionWidth, height: definitionHeight, channels: 3 } })
        .png({ palette: false, compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(fallbackPath);
      await image.clone().png({ palette: false, compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(encoderInput);
    } else {
      // Packed RGBA textures carry shader data in RGB. Disable palette
      // quantization so libvips cannot rewrite channels that happen to sit
      // behind an unused alpha value.
      await image.clone().png({ palette: false, compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(fallbackPath);
      await image.clone().png({ palette: false, compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(encoderInput);
    }
    const packagePath = resolve(tierDir, `${definition.name}.ktx2`);
    prepared.push({ definition, fallbackPath, encoderInput, packagePath });
  }
  // Two single-threaded encoders use the two cores Docker Desktop is commonly
  // granted without changing the deterministic per-texture KTX settings.
  await mapWithConcurrency(prepared, 2, async ({ definition, encoderInput, packagePath }) => {
    try {
      await runKtx(encoderInput, packagePath, definition.name, definition.mipmapped);
    } finally {
      rmSync(encoderInput, { force: true });
    }
  });
  for (const { definition, fallbackPath, packagePath } of prepared) {
    const definitionWidth = definition.width;
    const definitionHeight = definition.height;
    const colorChannel = definition.name === 'albedo' || definition.name === 'emissive';
    const directHeight = definition.name === 'heightMacro';
    const classChannel = definition.name === 'surfaceClass' || definition.name === 'surfaceClassRegional';
    const blockBytes = colorChannel ? 8 : 16;
    channels.push({
      name: definition.name,
      colorSpace: colorChannel ? 'sRGB' : 'linear',
      logicalFormat: classChannel ? 'R8' : colorChannel ? 'RGB8'
        : definition.name === 'material' || definition.name === 'localDetail' ? 'RGBA8' : 'RG8',
      packagePath: relativeAssetPath(packagePath),
      fallbackPath: relativeAssetPath(fallbackPath),
      packageChecksumSha256: sha256(readFileSync(packagePath)),
      fallbackChecksumSha256: sha256(readFileSync(fallbackPath)),
      gpuFormat: classChannel ? 'r8' : directHeight ? 'rg8' : colorChannel ? 'etc2-rgb'
        : definition.name === 'material' || definition.name === 'localDetail' ? 'bc3-rgba' : 'bc5-rg',
      gpuBytes: classChannel ? definitionWidth * definitionHeight
        : directHeight ? fullMipRgBytes(definitionWidth, definitionHeight) : fullMipBytes(definitionWidth, definitionHeight, blockBytes),
      fallbackGpuBytes: classChannel ? definitionWidth * definitionHeight : fullMipRgbaBytes(definitionWidth, definitionHeight),
      fallbackLayout: classChannel ? 'r' : colorChannel ? 'rgb'
        : definition.name === 'material' || definition.name === 'localDetail' ? 'rgba' : 'rgb-rg',
      transcodeTargets: classChannel ? ['r8'] : directHeight
        ? ['rg8']
        : colorChannel
        ? ['etc2-rgb', 'bc1-rgb']
        : definition.name === 'material' || definition.name === 'localDetail'
          ? ['etc2-rgba', 'bc3-rgba', 'astc-rgba']
          : ['etc2-rgba', 'bc5-rg', 'astc-rgba'],
      mipmapped: definition.mipmapped,
      ...(definitionWidth !== width ? { width: definitionWidth } : {}),
      ...(definitionHeight !== height ? { height: definitionHeight } : {}),
      ...('bounds' in definition && definition.bounds ? { bounds: definition.bounds } : {}),
    });
  }
  const compressedBytes = channels.reduce((sum, channel) => sum + statSync(resolve(assetsRoot, channel.packagePath)).size, 0);
  return {
    channels,
    pack: {
      bodyId, tier, width, height, compressedBytes,
      transientBytes: width * height * channels.reduce((sum, channel) => (
        sum + (channel.logicalFormat === 'RGBA8' ? 4 : channel.logicalFormat === 'RGB8' ? 3 : channel.logicalFormat === 'RG8' ? 2 : 1)
      ), 0),
      bootCritical: (bodyId === 'veyra' || bodyId === 'earth') && tier === 'medium',
      channels,
    },
  };
}

async function writeAlbedoOnlyTier(
  bodyId: CompiledBody,
  tier: CompiledTier,
  width: number,
  height: number,
  albedo: Uint8Array,
): Promise<Record<string, unknown>> {
  if (albedo.length !== width * height * 3) throw new Error(`${bodyId}/${tier} albedo must be aligned RGB8`);
  const tierDir = resolve(assetsRoot, `generated/${bodyId}/${tier}`);
  mkdirSync(tierDir, { recursive: true });
  const image = sharp(Buffer.from(albedo), { raw: { width, height, channels: 3 } });
  const fallbackPath = resolve(tierDir, 'albedo.webp');
  const encoderInput = resolve(tierDir, 'albedo.encoder.png');
  await image.clone().webp({ quality: 92, effort: 6, smartSubsample: true }).toFile(fallbackPath);
  await image.clone().png({ compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(encoderInput);
  const packagePath = resolve(tierDir, 'albedo.ktx2');
  try {
    await runKtx(encoderInput, packagePath, 'albedo', true);
  } finally {
    rmSync(encoderInput, { force: true });
  }
  const channel: ChannelOutput = {
    name: 'albedo',
    colorSpace: 'sRGB',
    logicalFormat: 'RGB8',
    packagePath: relativeAssetPath(packagePath),
    fallbackPath: relativeAssetPath(fallbackPath),
    packageChecksumSha256: sha256(readFileSync(packagePath)),
    fallbackChecksumSha256: sha256(readFileSync(fallbackPath)),
    gpuFormat: 'etc2-rgb',
    gpuBytes: fullMipBytes(width, height, 8),
    fallbackGpuBytes: fullMipRgbaBytes(width, height),
    fallbackLayout: 'rgb',
    transcodeTargets: ['etc2-rgb', 'bc1-rgb'],
    mipmapped: true,
  };
  return {
    bodyId,
    tier,
    width,
    height,
    compressedBytes: statSync(packagePath).size,
    transientBytes: width * height * 3,
    bootCritical: false,
    channels: [channel],
  };
}

async function compileVeyraGlobal(universe: Universe, tiersToWrite: ReadonlySet<CompiledTier>): Promise<{
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
  for (const tier of Object.keys(tierDimensions) as CompiledTier[]) {
    if (!tiersToWrite.has(tier)) continue;
    const [width, height] = tierDimensions[tier];
    tiers.push(await writeTier('veyra', tier, width, height, canonicalWidth, canonicalHeight, canonical));
  }
  return { rawHashes: canonical.rawHashes, heightChecksumSha256, packs: tiers.map((tier) => tier.pack) };
}

const nasaReview = Object.freeze({
  thirdPartyContent: false,
  commercialUseReviewed: true,
  modificationReviewed: true,
  endorsementSafe: true,
  termsSnapshot: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
});

const airlessSources = {
  palla: {
    albedoPath: resolve(assetsRoot, 'sources/nasa-lro-palla/lroc_color_16bit_srgb_8k.tif'),
    heightPath: resolve(assetsRoot, 'sources/nasa-lro-palla/ldem_16_uint.tif'),
    sources: [
      {
        id: 'nasa-lro-palla-color-8k',
        url: 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_8k.tif',
        author: 'NASA Scientific Visualization Studio and LRO',
        license: 'NASA', licenseUrl: nasaReview.termsSnapshot,
        attribution: 'NASA LRO/LOLA; used for fictional moon Palla without recoloring',
        checksumSha256: 'db7808e878b6a55eb409bb231eab8deb477f84b5c9d7396d76ff73e5d54992d9',
        localPath: 'sources/nasa-lro-palla/lroc_color_16bit_srgb_8k.tif', authoringOnly: true,
        sourceDimensions: [8192, 4096], transformations: ['Lanczos3 tier resampling', 'RGB8 fallback and BasisLZ KTX2 encoding'],
        bodies: ['palla'], channels: ['albedo'], review: nasaReview,
      },
      {
        id: 'nasa-lola-palla-height',
        url: 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16_uint.tif',
        author: 'NASA Scientific Visualization Studio and LOLA',
        license: 'NASA', licenseUrl: nasaReview.termsSnapshot,
        attribution: 'NASA LOLA; used to derive fictional moon Palla normals and material response',
        checksumSha256: '45a2b32d56e81ed30db07fead8abc842b249b6511219d9ca2c53f81bc2dc5d62',
        localPath: 'sources/nasa-lro-palla/ldem_16_uint.tif', authoringOnly: true,
        sourceDimensions: [5760, 2880], transformations: ['0.5 meter unsigned LOLA elevation decode', 'body-space oct normal derivation', 'UASTC KTX2 encoding'],
        bodies: ['palla'], channels: ['normal', 'material'], review: nasaReview,
      },
    ],
  },
  wisp: {
    albedoPath: resolve(assetsRoot, 'sources/nasa-osiris-rex-wisp/Bennu_global_ShapeV20_GndControl_ROLOphase_ALBEDO_8bit_v6.tif'),
    sources: [
      {
        id: 'nasa-osiris-rex-wisp-albedo',
        url: 'https://svs.gsfc.nasa.gov/vis/a000000/a005000/a005069/Bennu_global_ShapeV20_GndControl_ROLOphase_ALBEDO_8bit_v6.tif',
        author: 'NASA Scientific Visualization Studio and OSIRIS-REx',
        license: 'NASA', licenseUrl: nasaReview.termsSnapshot,
        attribution: 'NASA OSIRIS-REx Bennu albedo; used for fictional moon Wisp without recoloring',
        checksumSha256: '71bfeecce5615a5602d16d176c4cc17cc2550b2dc8c7cdac1332dea8d9f3da36',
        localPath: 'sources/nasa-osiris-rex-wisp/Bennu_global_ShapeV20_GndControl_ROLOphase_ALBEDO_8bit_v6.tif', authoringOnly: true,
        sourceDimensions: [25134, 12568], transformations: ['Lanczos3 tier resampling', 'grayscale-to-RGB channel expansion', 'polar no-observation fill from adjacent source pixels', 'procedural-authority oct normal derivation', 'BasisLZ and UASTC KTX2 encoding'],
        bodies: ['wisp'], channels: ['albedo', 'normal', 'material'], review: nasaReview,
      },
    ],
  },
} as const;

const moonColor2025Path = resolve(assetsRoot, 'sources/nasa-lro-moon-2025/lroc_color_16bit_srgb_4k.tif');

function fillPolarObservationVoids(albedo: Uint8Array, width: number, height: number): Uint8Array {
  const pixelCount = width * height;
  const missing = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let queueStart = 0;
  let queueEnd = 0;
  // Resampling produces a dark anti-aliased fringe around the source mask;
  // keep that fringe connected to the no-observation region as well.
  const isObserved = (index: number) => albedo[index] + albedo[index + 1] + albedo[index + 2] > 120;
  const enqueue = (pixel: number) => {
    if (missing[pixel] || isObserved(pixel * 3)) return;
    missing[pixel] = 1;
    queue[queueEnd++] = pixel;
  };
  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  while (queueStart < queueEnd) {
    const pixel = queue[queueStart++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    enqueue(y * width + ((x + width - 1) % width));
    enqueue(y * width + ((x + 1) % width));
    if (y > 0) enqueue(pixel - width);
    if (y + 1 < height) enqueue(pixel + width);
  }

  let firstFilledRow = -1;
  let lastFilledRow = -1;
  for (let y = 0; y < height; y++) {
    const validXs: number[] = [];
    for (let x = 0; x < width; x++) if (!missing[y * width + x]) validXs.push(x);
    if (validXs.length === 0) continue;
    if (firstFilledRow < 0) firstFilledRow = y;
    lastFilledRow = y;
    for (let x = 0; x < width; x++) {
      if (!missing[y * width + x]) continue;
      let low = 0;
      let high = validXs.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (validXs[middle] < x) low = middle + 1;
        else high = middle;
      }
      const right = validXs[low % validXs.length];
      const left = validXs[(low + validXs.length - 1) % validXs.length];
      const leftDistance = (x - left + width) % width;
      const rightDistance = (right - x + width) % width;
      const blend = leftDistance / Math.max(1, leftDistance + rightDistance);
      for (let channel = 0; channel < 3; channel++) {
        const leftValue = albedo[(y * width + left) * 3 + channel];
        const rightValue = albedo[(y * width + right) * 3 + channel];
        albedo[(y * width + x) * 3 + channel] = Math.round(leftValue + (rightValue - leftValue) * blend);
      }
    }
  }

  if (firstFilledRow < 0 || lastFilledRow < 0) throw new Error('Wisp albedo contains no observed pixels');
  const fillEmptyPolarRows = (edgeRow: number, start: number, end: number, step: number) => {
    const average = [0, 0, 0];
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 3; channel++) average[channel] += albedo[(edgeRow * width + x) * 3 + channel];
    }
    for (let channel = 0; channel < 3; channel++) average[channel] /= width;
    for (let y = start; y !== end; y += step) {
      const distance = Math.abs(edgeRow - y);
      const span = step > 0 ? edgeRow : height - 1 - edgeRow;
      const blend = Math.pow(distance / Math.max(1, span), 0.7);
      for (let x = 0; x < width; x++) {
        const edgeOffset = (edgeRow * width + x) * 3;
        const targetOffset = (y * width + x) * 3;
        for (let channel = 0; channel < 3; channel++) {
          const edgeValue = albedo[edgeOffset + channel];
          albedo[targetOffset + channel] = Math.round(edgeValue + (average[channel] - edgeValue) * blend);
        }
      }
    }
  };
  if (firstFilledRow > 0) fillEmptyPolarRows(firstFilledRow, firstFilledRow - 1, -1, -1);
  if (lastFilledRow < height - 1) fillEmptyPolarRows(lastFilledRow, lastFilledRow + 1, height, 1);
  return missing;
}

async function decodeAirlessAlbedo(
  path: string,
  width: number,
  height: number,
  fillPolarVoids = false,
): Promise<Uint8Array> {
  const result = await sharp(path, { limitInputPixels: false, sequentialRead: true })
    .resize(width, height, { kernel: sharp.kernel.lanczos3 })
    .toColourspace('srgb')
    .removeAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (result.info.channels !== 3 || result.info.width !== width || result.info.height !== height) {
    throw new Error(`Airless albedo decode must produce ${width}x${height} RGB8`);
  }
  const albedo = new Uint8Array(result.data);
  if (fillPolarVoids) {
    const missing = fillPolarObservationVoids(albedo, width, height);
    const softened = await sharp(Buffer.from(albedo), { raw: { width, height, channels: 3 } })
      .blur(18)
      .raw()
      .toBuffer();
    for (let pixel = 0; pixel < missing.length; pixel++) {
      if (!missing[pixel]) continue;
      const offset = pixel * 3;
      albedo[offset] = softened[offset];
      albedo[offset + 1] = softened[offset + 1];
      albedo[offset + 2] = softened[offset + 2];
    }
  }
  return albedo;
}

async function pallaHeights(width: number, height: number): Promise<Float32Array> {
  return (await deriveScientificHeight(root, HEIGHT_SOURCE_DEFINITIONS.moon, width, height)).heights;
}

function proceduralHeights(body: ReturnType<Universe['get']>, width: number, height: number): Float32Array {
  const heights = new Float32Array(width * height);
  const direction = new Vec3();
  for (let y = 0; y < height; y++) {
    const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
    const cosLatitude = Math.cos(latitude);
    for (let x = 0; x < width; x++) {
      const longitude = ((x + 0.5) / width) * Math.PI * 2 - Math.PI;
      direction.set(cosLatitude * Math.cos(longitude), cosLatitude * Math.sin(longitude), Math.sin(latitude));
      const surface = solidHeight(body, direction);
      if (surface.kind !== 'solid') throw new Error(`${body.id} must retain solid terrain authority`);
      heights[y * width + x] = surface.height;
    }
  }
  return heights;
}

async function compileAirlessBody(
  bodyId: 'palla' | 'wisp',
  universe: Universe,
  tiersToWrite: ReadonlySet<CompiledTier>,
): Promise<unknown[]> {
  const body = universe.get(bodyId);
  const source = airlessSources[bodyId];
  const packs: unknown[] = [];
  for (const tier of Object.keys(tierDimensions) as CompiledTier[]) {
    if (!tiersToWrite.has(tier)) continue;
    const [width, height] = tierDimensions[tier];
    console.log(`compiling ${bodyId}/${tier} at ${width}x${height}`);
    const [albedo, heights] = await Promise.all([
      decodeAirlessAlbedo(source.albedoPath, width, height, bodyId === 'wisp'),
      bodyId === 'palla' ? pallaHeights(width, height) : Promise.resolve(proceduralHeights(body, width, height)),
    ]);
    const maps = generateAirlessGlobalMaps({ width, height, radius: body.radius, albedo, heights });
    const compiled = await writeTier(bodyId, tier, width, height, width, height, maps);
    packs.push(compiled.pack);
  }
  return packs;
}

const scientificGrid = Object.freeze({
  datum: 'WGS84 spherical presentation; source datum retained during authoring',
  projection: 'EPSG:4326 plate-carree',
  axisOrder: 'longitude,latitude',
  longitudeDirection: 'east-positive',
  seamLongitudeDegrees: -180,
  uvOrigin: 'north-west',
  bodyReferenceFrameVersion: 'iau-naif-j2000-v1',
});

const earthSourcePaths = Object.freeze({
  albedo: resolve(assetsRoot, 'sources/nasa-bmng-earth/world.200407.3x21600x10800.jpg'),
  clouds: resolve(assetsRoot, 'sources/nasa-blue-marble-clouds/cloud_combined_8192.tif'),
  emissive: resolve(assetsRoot, 'sources/nasa-black-marble-2016/BlackMarble_2016_3km_geo.tif'),
  surface: resolve(assetsRoot, 'sources/noaa-etopo-2022/ETOPO_2022_v1_60s_N90W180_surface.tif'),
  bedrock: resolve(assetsRoot, 'sources/noaa-etopo-2022/ETOPO_2022_v1_60s_N90W180_bed.tif'),
});

const localMaterialRoot = resolve(assetsRoot, 'sources/polyhaven-local');
const earthLocalMaterials = ['dirt', 'rock_ground', 'sand_01', 'snow_02'] as const;

async function decodeLocalMaterialTile(assetId: string, size: number): Promise<Uint8Array> {
  const [diffuseResult, normalResult, roughnessResult] = await Promise.all([
    sharp(resolve(localMaterialRoot, `${assetId}_diff_1k.jpg`))
      .resize(size, size, { kernel: sharp.kernel.lanczos3 }).removeAlpha().toColourspace('srgb')
      .raw().toBuffer({ resolveWithObject: true }),
    sharp(resolve(localMaterialRoot, `${assetId}_nor_gl_1k.jpg`))
      .resize(size, size, { kernel: sharp.kernel.lanczos3 }).removeAlpha().toColourspace('srgb')
      .raw().toBuffer({ resolveWithObject: true }),
    sharp(resolve(localMaterialRoot, `${assetId}_rough_1k.jpg`))
      .resize(size, size, { kernel: sharp.kernel.lanczos3 }).toColourspace('b-w')
      .raw().toBuffer({ resolveWithObject: true }),
  ]);
  const diffuse = diffuseResult.data;
  const normal = normalResult.data;
  const roughness = roughnessResult.data;
  if (diffuseResult.info.channels !== 3 || normalResult.info.channels !== 3 || roughnessResult.info.channels !== 1) {
    throw new Error(`Poly Haven ${assetId} channels did not decode as RGB/RGB/R`);
  }
  const tile = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index++) {
    const red = diffuse[index * 3];
    const green = diffuse[index * 3 + 1];
    const blue = diffuse[index * 3 + 2];
    tile[index * 4] = Math.round(red * 0.2126 + green * 0.7152 + blue * 0.0722);
    tile[index * 4 + 1] = normal[index * 3];
    tile[index * 4 + 2] = normal[index * 3 + 1];
    tile[index * 4 + 3] = roughness[index];
  }
  return tile;
}

async function earthLocalDetailAtlas(width: number, height: number): Promise<Uint8Array> {
  const tileSize = height / 2;
  if (!Number.isInteger(tileSize) || width !== height * 2) throw new Error('Earth local atlas requires 2:1 dimensions');
  const tiles = await Promise.all(earthLocalMaterials.map((assetId) => decodeLocalMaterialTile(assetId, tileSize)));
  const atlas = new Uint8Array(width * height * 4);
  for (let tileIndex = 0; tileIndex < tiles.length; tileIndex++) {
    const offsetX = (tileIndex % 2) * tileSize;
    const offsetY = Math.floor(tileIndex / 2) * tileSize;
    for (let y = 0; y < tileSize; y++) {
      atlas.set(
        tiles[tileIndex].subarray(y * tileSize * 4, (y + 1) * tileSize * 4),
        ((offsetY + y) * width + offsetX) * 4,
      );
    }
  }
  return atlas;
}

async function moonLocalDetailAtlas(width: number, height: number): Promise<Uint8Array> {
  if (width !== height * 2) throw new Error('Moon local atlas requires 2:1 dimensions');
  const tile = await decodeLocalMaterialTile('moon_meteor_02', height);
  const atlas = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = tile.subarray(y * height * 4, (y + 1) * height * 4);
    atlas.set(row, y * width * 4);
    atlas.set(row, (y * width + height) * 4);
  }
  return atlas;
}

async function decodeRgb(path: string, width: number, height: number): Promise<Uint8Array> {
  const result = await sharp(path, { limitInputPixels: false, sequentialRead: true })
    .resize(width, height, { kernel: sharp.kernel.lanczos3 })
    .removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (result.info.channels !== 3 || result.data.length !== width * height * 3) {
    throw new Error(`${path} must decode to aligned RGB8`);
  }
  return new Uint8Array(result.data);
}

async function decodeLuminance(path: string, width: number, height: number): Promise<Uint8Array> {
  const result = await sharp(path, { limitInputPixels: false, sequentialRead: true })
    .resize(width, height, { kernel: sharp.kernel.lanczos3 })
    .toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
  if (result.info.channels !== 1 || result.data.length !== width * height) {
    throw new Error(`${path} must decode to aligned luminance`);
  }
  return new Uint8Array(result.data);
}

async function compileEarth(
  universe: Universe,
  tiersToWrite: ReadonlySet<CompiledTier>,
): Promise<unknown[]> {
  const earth = universe.get('earth');
  const packs: unknown[] = [];
  const tiers = (Object.keys(tierDimensions) as CompiledTier[]).filter((tier) => tiersToWrite.has(tier));
  const gshhgLock = JSON.parse(readFileSync(resolve(assetsRoot, 'classification/gshhg-2.3.7.lock.json'), 'utf8')) as {
    levels: Array<{ path: string }>;
  };
  const nwiLock = JSON.parse(readFileSync(resolve(assetsRoot, 'classification/nwi-ksc.lock.json'), 'utf8')) as {
    snapshotPath: string;
  };
  const classRasters = await rasterizeGshhg({
    levelPaths: gshhgLock.levels.map((level) => resolve(root, level.path)),
    targets: [
      ...tiers.map((tier) => ({ width: tierDimensions[tier][0], height: tierDimensions[tier][1] })),
      { width: KSC_SURFACE_CLASS_DIMENSIONS[0], height: KSC_SURFACE_CLASS_DIMENSIONS[1], bounds: KSC_SURFACE_CLASS_BOUNDS },
    ],
  });
  const regionalClass = classRasters.at(-1)!;
  overlayNwiGeoJson(regionalClass, JSON.parse(readFileSync(resolve(root, nwiLock.snapshotPath), 'utf8')));
  const globalClasses = new Map(tiers.map((tier, index) => [tier, classRasters[index].pixels]));
  for (const tier of Object.keys(tierDimensions) as CompiledTier[]) {
    if (!tiersToWrite.has(tier)) continue;
    const [width, height] = tierDimensions[tier];
    console.log(`compiling earth/${tier} at ${width}x${height}`);
    const [albedo, surfaceHeights, bedrockHeights, clouds, emissive, localDetail] = await Promise.all([
      decodeRgb(earthSourcePaths.albedo, width, height),
      deriveScientificHeight(root, HEIGHT_SOURCE_DEFINITIONS.earthSurface, width, height)
        .then((result) => result.heights),
      deriveScientificHeight(root, HEIGHT_SOURCE_DEFINITIONS.earthBedrock, width, height)
        .then((result) => result.heights),
      decodeLuminance(earthSourcePaths.clouds, width, height),
      tier === 'low' ? Promise.resolve(undefined) : decodeRgb(earthSourcePaths.emissive, width, height),
      earthLocalDetailAtlas(width, height),
    ]);
    const maps = { ...generateEarthGlobalMaps({
      width,
      height,
      radius: earth.radius,
      albedo,
      surfaceHeights,
      bedrockHeights,
      cloudLuminance: clouds,
      ...(emissive ? { nightColor: emissive } : {}),
    }),
      localDetail,
      surfaceClass: globalClasses.get(tier)!,
      surfaceClassRegional: {
        data: regionalClass.pixels,
        width: regionalClass.width,
        height: regionalClass.height,
        bounds: KSC_SURFACE_CLASS_BOUNDS,
      },
    };
    packs.push((await writeTier('earth', tier, width, height, width, height, maps)).pack);
  }
  return packs;
}

async function compileMoon(
  universe: Universe,
  tiersToWrite: ReadonlySet<CompiledTier>,
): Promise<unknown[]> {
  const moon = universe.get('moon');
  const packs: unknown[] = [];
  for (const tier of Object.keys(tierDimensions) as CompiledTier[]) {
    if (!tiersToWrite.has(tier)) continue;
    const [width, height] = tierDimensions[tier];
    console.log(`compiling moon/${tier} at ${width}x${height}`);
    const [albedo, heights, localDetail] = await Promise.all([
      decodeAirlessAlbedo(moonColor2025Path, width, height, false),
      pallaHeights(width, height),
      moonLocalDetailAtlas(width, height),
    ]);
    const maps = { ...generateMoonGlobalMaps({ width, height, radius: moon.radius, albedo, heights }), localDetail };
    packs.push((await writeTier('moon', tier, width, height, width, height, maps)).pack);
  }
  return packs;
}

const marsSourceLock = JSON.parse(
  readFileSync(resolve(assetsRoot, 'sources/nasa-marstrek-viking/source.lock.json'), 'utf8'),
) as {
  id: string;
  productPage: string;
  urlTemplate: string;
  localPath: string;
  derivedSourceSha256: string;
  sourceDimensions: readonly [number, number];
};
const marsSourcePath = resolve(root, marsSourceLock.localPath);

const mercurySourceLock = JSON.parse(
  readFileSync(resolve(assetsRoot, 'sources/nasa-messenger-mercury/source.lock.json'), 'utf8'),
) as {
  id: string;
  productPage: string;
  sourceUrl: string;
  localPath: string;
  sourceSha256: string;
  derivedSourceSha256: string;
  sourceDimensions: readonly [number, number];
  sourceSeamLongitudeDegrees: number;
  canonicalSeamLongitudeDegrees: number;
};
const mercurySourcePath = resolve(root, mercurySourceLock.localPath);

async function compileAlbedoOnlyBody(
  bodyId: 'mercury' | 'mars',
  sourcePath: string,
  sourceDimensions: readonly [number, number],
  tiersToWrite: ReadonlySet<CompiledTier>,
): Promise<unknown[]> {
  const metadata = await sharp(sourcePath).metadata();
  if (metadata.width !== sourceDimensions[0] || metadata.height !== sourceDimensions[1]) {
    throw new Error(`${bodyId} source must be ${sourceDimensions.join('x')}`);
  }
  const packs: unknown[] = [];
  for (const tier of Object.keys(tierDimensions) as CompiledTier[]) {
    if (!tiersToWrite.has(tier)) continue;
    const [width, height] = tierDimensions[tier];
    console.log(`compiling ${bodyId}/${tier} albedo at ${width}x${height}`);
    const albedo = await decodeRgb(sourcePath, width, height);
    packs.push(await writeAlbedoOnlyTier(bodyId, tier, width, height, albedo));
  }
  return packs;
}

const sunSourcePath = resolve(assetsRoot, 'sources/nasa-sdo-hmi-photosphere/sun-hmii-large.png');

async function derivePhotosphereActivity(size: number): Promise<Uint8Array> {
  const decoded = await sharp(sunSourcePath).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 3) throw new Error('HMI photosphere source must decode as RGB');
  const { width, height } = decoded.info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      if (Math.max(decoded.data[offset], decoded.data[offset + 1], decoded.data[offset + 2]) < 10) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) throw new Error('HMI photosphere disk was not detected');
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const radius = Math.min(maxX - minX + 1, maxY - minY + 1) / 2;
  const cropSize = Math.max(2, Math.floor(radius * 2));
  const left = Math.max(0, Math.min(width - cropSize, Math.round(centerX - cropSize / 2)));
  const top = Math.max(0, Math.min(height - cropSize, Math.round(centerY - cropSize / 2)));
  const disk = await sharp(decoded.data, { raw: { width, height, channels: 3 } })
    .extract({ left, top, width: cropSize, height: cropSize })
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .raw().toBuffer();
  const linear = new Float32Array(size * size);
  const radialSum = new Float64Array(256);
  const radialCount = new Uint32Array(256);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = ((x + 0.5) / size) * 2 - 1;
      const ny = ((y + 0.5) / size) * 2 - 1;
      const radius01 = Math.hypot(nx, ny);
      const offset = (y * size + x) * 3;
      const luminance = (disk[offset] * 0.2126 + disk[offset + 1] * 0.7152 + disk[offset + 2] * 0.0722) / 255;
      const value = Math.pow(Math.max(0, luminance), 2.2);
      linear[y * size + x] = value;
      if (radius01 <= 0.985) {
        const bin = Math.min(255, Math.floor(radius01 * 255));
        radialSum[bin] += value;
        radialCount[bin]++;
      }
    }
  }
  const baseline = new Float64Array(256);
  for (let bin = 0; bin < baseline.length; bin++) {
    baseline[bin] = radialCount[bin] ? radialSum[bin] / radialCount[bin] : (bin > 0 ? baseline[bin - 1] : 1);
  }
  const activity = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const radius01 = Math.hypot(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1);
      if (radius01 > 0.985) {
        activity[y * size + x] = 128;
        continue;
      }
      const bin = Math.min(255, Math.floor(radius01 * 255));
      const residual = Math.log2(Math.max(1e-5, linear[y * size + x]) / Math.max(1e-5, baseline[bin]));
      activity[y * size + x] = clampByte(128 + Math.max(-1, Math.min(1, residual / 1.5)) * 112);
    }
  }
  return activity;
}

async function compileSun(tiersToWrite: ReadonlySet<CompiledTier>): Promise<unknown[]> {
  const packs: unknown[] = [];
  for (const tier of Object.keys(tierDimensions) as CompiledTier[]) {
    if (!tiersToWrite.has(tier)) continue;
    const [width, height] = tierDimensions[tier];
    const size = tier === 'low' ? 512 : tier === 'medium' ? 1024 : 2048;
    console.log(`compiling sun/${tier} activity at ${size}x${size}`);
    const data = await derivePhotosphereActivity(size);
    const tierDir = resolve(assetsRoot, `generated/sun/${tier}`);
    mkdirSync(tierDir, { recursive: true });
    const fallbackPath = resolve(tierDir, 'photosphereActivity.png');
    const encoderInput = resolve(tierDir, 'photosphereActivity.encoder.png');
    await sharp(data, { raw: { width: size, height: size, channels: 1 } })
      .png({ palette: false, compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(fallbackPath);
    await sharp(data, { raw: { width: size, height: size, channels: 1 } })
      .png({ palette: false, compressionLevel: 9, adaptiveFiltering: false, effort: 10 }).toFile(encoderInput);
    const packagePath = resolve(tierDir, 'photosphereActivity.ktx2');
    try {
      await runKtx(encoderInput, packagePath, 'photosphereActivity', true);
    } finally {
      rmSync(encoderInput, { force: true });
    }
    const channel: ChannelOutput = {
      name: 'photosphereActivity', colorSpace: 'linear', logicalFormat: 'R8',
      packagePath: relativeAssetPath(packagePath), fallbackPath: relativeAssetPath(fallbackPath),
      packageChecksumSha256: sha256(readFileSync(packagePath)), fallbackChecksumSha256: sha256(readFileSync(fallbackPath)),
      gpuFormat: 'r8', gpuBytes: fullMipRgbaBytes(size, size) / 4,
      fallbackGpuBytes: fullMipRgbaBytes(size, size), fallbackLayout: 'r',
      transcodeTargets: ['r8'], mipmapped: true, width: size, height: size,
    };
    packs.push({
      bodyId: 'sun', tier, width, height, compressedBytes: statSync(packagePath).size,
      transientBytes: size * size, bootCritical: false, channels: [channel],
    });
  }
  return packs;
}

const sunSources = [{
  id: 'nasa-sdo-hmi-visible-photosphere-2010-12-06',
  url: 'https://svs.gsfc.nasa.gov/vis/a000000/a004200/a004269/sun-hmii-large.png',
  author: 'NASA Scientific Visualization Studio and SDO/HMI',
  license: 'NASA', licenseUrl: nasaReview.termsSnapshot,
  attribution: 'NASA SDO/HMI visible photosphere, 2010-12-06',
  checksumSha256: 'e3f4f8c030e1fe9e4171ae34bd9690b0cd2d7d23a1b48d766a98323a643ff5d0',
  localPath: 'sources/nasa-sdo-hmi-photosphere/sun-hmii-large.png', authoringOnly: true,
  sourceDimensions: [4104, 3840],
  transformations: ['disk detection and centered crop', 'linear luminance conversion', 'radial limb baseline removal', 'bounded signed R8 activity residual', 'lossless mipmapped R8 packaging'],
  bodies: ['sun'], channels: ['photosphereActivity'], review: nasaReview,
  datum: 'observer image plane', verticalDatum: 'not-applicable', projection: 'orthographic full disk',
  axisOrder: 'image-x,image-y', longitudeDirection: 'not-applicable', seamLongitudeDegrees: 0,
  uvOrigin: 'north-west', valueScale: 1 / 112, valueOffset: -128 / 112,
  noDataValue: null, validRange: [16, 240], observation: '2010-12-06 HMI continuum intensity',
  productKind: 'measured', derivedRecipe: 'sun-photosphere-activity-v1', bodyReferenceFrameVersion: 'observer-image-2010-12-06',
}] as const;

const mercurySources = [{
  id: mercurySourceLock.id,
  url: mercurySourceLock.productPage,
  author: 'NASA MESSENGER MDIS; Johns Hopkins University APL; Carnegie Institution of Washington',
  license: 'NASA',
  licenseUrl: nasaReview.termsSnapshot,
  attribution: 'NASA/JHUAPL/Carnegie MESSENGER enhanced-color Mercury map PIA17386',
  checksumSha256: mercurySourceLock.derivedSourceSha256,
  localPath: mercurySourceLock.localPath.replace(/^assets\/planets\//, ''),
  authoringOnly: true,
  sourceDimensions: [...mercurySourceLock.sourceDimensions],
  transformations: [
    'verified NASA-hosted PIA17386 JPEG decode',
    'exact half-width scanline rotation from 0-degree to -180-degree longitude seam',
    'bounded polar no-observation fill from adjacent observed pixels',
    '90-percent warm Rec.709 luminance with 10-percent enhanced-source chroma',
    'deterministic canonical RGB PNG encoding',
    'Lanczos3 tier resampling in the compiler image pipeline',
    'BasisLZ KTX2 and WebP fallback encoding',
  ],
  bodies: ['mercury'],
  channels: ['albedo'],
  review: nasaReview,
  datum: 'IAU Mercury 2000 reference sphere',
  verticalDatum: 'not-applicable',
  projection: 'simple cylindrical planetocentric latitude',
  axisOrder: 'longitude,latitude',
  longitudeDirection: 'east-positive',
  seamLongitudeDegrees: mercurySourceLock.canonicalSeamLongitudeDegrees,
  uvOrigin: 'north-west',
  valueScale: 1,
  valueOffset: 0,
  noDataValue: null,
  validRange: [0, 255],
  observation: 'restrained visual albedo derived from MESSENGER MDIS enhanced-color global map PIA17386',
  productKind: 'composited',
  derivedRecipe: 'mercury-compact-albedo-v1',
  bodyReferenceFrameVersion: 'iau-naif-j2000-v1',
}] as const;

const marsSources = [{
  id: marsSourceLock.id,
  url: marsSourceLock.productPage,
  author: 'NASA Solar System Treks; USGS Astrogeology Science Center; Viking Orbiter teams',
  license: 'Public-Domain',
  licenseUrl: 'https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m',
  attribution: 'NASA Mars Trek and USGS Viking MDIM 2.1 global color mosaic',
  checksumSha256: marsSourceLock.derivedSourceSha256,
  localPath: marsSourceLock.localPath.replace(/^assets\/planets\//, ''),
  authoringOnly: true,
  sourceDimensions: [...marsSourceLock.sourceDimensions],
  transformations: [
    'deterministic NASA Mars Trek WMTS matrix-3 tile assembly',
    'Lanczos3 tier resampling in the compiler image pipeline',
    'BasisLZ KTX2 and WebP fallback encoding',
  ],
  bodies: ['mars'],
  channels: ['albedo'],
  datum: 'IAU Mars 2000 reference sphere',
  verticalDatum: 'not-applicable',
  projection: 'equirectangular planetocentric latitude',
  axisOrder: 'longitude,latitude',
  longitudeDirection: 'east-positive',
  seamLongitudeDegrees: -180,
  uvOrigin: 'north-west',
  valueScale: 1,
  valueOffset: 0,
  noDataValue: null,
  validRange: [0, 255],
  observation: 'Viking MDIM 2.1 global color mosaic',
  productKind: 'composited',
  derivedRecipe: 'mars-compact-albedo-v1',
  bodyReferenceFrameVersion: 'iau-naif-j2000-v1',
}] as const;

const earthSources = [
  {
    id: 'nasa-bmng-earth-2004-07',
    url: 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/july/world.200407.3x21600x10800.jpg',
    author: 'NASA Earth Observatory; Reto Stockli, Robert Simmon, and MODIS teams',
    license: 'NASA', licenseUrl: nasaReview.termsSnapshot,
    attribution: 'NASA Blue Marble Next Generation, July 2004 natural-color composite',
    checksumSha256: 'dea8b4dc8a4f93f5f8bce0c8c85a508a178e7901e9ed8e6bf86e6ce7ef6d61e2',
    localPath: 'sources/nasa-bmng-earth/world.200407.3x21600x10800.jpg', authoringOnly: true,
    sourceDimensions: [21600, 10800], transformations: ['linear-light Lanczos3 tier resampling', 'BasisLZ KTX2 and WebP fallback encoding'],
    bodies: ['earth'], channels: ['albedo'], review: nasaReview,
    ...scientificGrid, verticalDatum: 'not-applicable', valueScale: 1, valueOffset: 0,
    noDataValue: null, validRange: [0, 255], observation: '2004-07 monthly composite', productKind: 'composited',
    derivedRecipe: 'earth-source-pack-v1',
  },
  {
    id: 'nasa-blue-marble-clouds-2002',
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif',
    author: 'NASA Goddard Space Flight Center; Reto Stockli',
    license: 'NASA', licenseUrl: nasaReview.termsSnapshot,
    attribution: 'NASA Blue Marble separate cloud composite',
    checksumSha256: 'd137775d8966ab8d443fd5126dc6e7ad72072bc1ed50555c5818d221735daf0f',
    localPath: 'sources/nasa-blue-marble-clouds/cloud_combined_8192.tif', authoringOnly: true,
    sourceDimensions: [8192, 4096], transformations: ['luminance extraction', 'coverage and optical-density derivation', 'area-aware tier resampling'],
    bodies: ['earth'], channels: ['clouds'], review: nasaReview,
    ...scientificGrid, verticalDatum: 'not-applicable', valueScale: 1, valueOffset: 0,
    noDataValue: null, validRange: [0, 255], observation: '2001 multi-day visible and thermal composite', productKind: 'composited',
    derivedRecipe: 'earth-source-pack-v1',
  },
  {
    id: 'nasa-black-marble-earth-2016',
    url: 'https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144898/BlackMarble_2016_3km_geo.tif',
    author: 'NASA Earth Observatory; Joshua Stevens; Suomi NPP VIIRS and Miguel Roman',
    license: 'NASA', licenseUrl: nasaReview.termsSnapshot,
    attribution: 'NASA Earth at Night Black Marble 2016 color map',
    checksumSha256: 'e915ef2a20d84e2a59e1547d3ad564463ad4bcf22bfa02e0e0b8ed1cd722e9c0',
    localPath: 'sources/nasa-black-marble-2016/BlackMarble_2016_3km_geo.tif', authoringOnly: true,
    sourceDimensions: [13500, 6750], transformations: ['bounded dark-floor removal', 'linear-light tier resampling', 'night-side emissive packaging'],
    bodies: ['earth'], channels: ['emissive'], review: nasaReview,
    ...scientificGrid, verticalDatum: 'not-applicable', valueScale: 1, valueOffset: 0,
    noDataValue: null, validRange: [0, 255], observation: '2016 cloud-free annual composite', productKind: 'composited',
    derivedRecipe: 'earth-source-pack-v1',
  },
  {
    id: 'noaa-etopo-2022-earth-surface-60s',
    url: 'https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif',
    author: 'NOAA National Centers for Environmental Information',
    license: 'Public-Domain', licenseUrl: 'https://www.ncei.noaa.gov/products/etopo-global-relief-model',
    attribution: 'NOAA NCEI ETOPO 2022 ice-surface global relief model',
    checksumSha256: '9d27d4b8ea8e76977e2988bca667d7c8fa68b927355feffcddd6b4875a7fd08e',
    localPath: 'sources/noaa-etopo-2022/ETOPO_2022_v1_60s_N90W180_surface.tif', authoringOnly: true,
    sourceDimensions: [21600, 10800], transformations: ['Float32 metre decode', 'spherical macro-normal derivation', 'ocean mask derivation', 'signed height RG encoding'],
    bodies: ['earth'], channels: ['normal', 'material', 'heightMacro'],
    ...scientificGrid, verticalDatum: 'EGM2008 geoid', valueScale: 1, valueOffset: 0,
    noDataValue: null, validRange: [-11_000, 9_000], observation: 'ETOPO 2022 v1', productKind: 'modeled',
    derivedRecipe: 'earth-source-pack-v1',
  },
  {
    id: 'noaa-etopo-2022-earth-bedrock-60s',
    url: 'https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_bed_elev_gtif/ETOPO_2022_v1_60s_N90W180_bed.tif',
    author: 'NOAA National Centers for Environmental Information',
    license: 'Public-Domain', licenseUrl: 'https://www.ncei.noaa.gov/products/etopo-global-relief-model',
    attribution: 'NOAA NCEI ETOPO 2022 bedrock global relief model',
    checksumSha256: 'a2cc72f8a4292dee928f439069457cdefc1fba319876807c626edce40258ba7a',
    localPath: 'sources/noaa-etopo-2022/ETOPO_2022_v1_60s_N90W180_bed.tif', authoringOnly: true,
    sourceDimensions: [21600, 10800], transformations: ['Float32 metre decode', 'grounded-ice thickness and mask derivation'],
    bodies: ['earth'], channels: ['material'],
    ...scientificGrid, verticalDatum: 'EGM2008 geoid', valueScale: 1, valueOffset: 0,
    noDataValue: null, validRange: [-11_000, 9_000], observation: 'ETOPO 2022 v1', productKind: 'modeled',
    derivedRecipe: 'earth-source-pack-v1',
  },
] as const;

const gshhgClassLock = JSON.parse(
  readFileSync(resolve(assetsRoot, 'classification/gshhg-2.3.7.lock.json'), 'utf8'),
) as { artifactUrl: string; artifactSha256: string };
const nwiClassLock = JSON.parse(
  readFileSync(resolve(assetsRoot, 'classification/nwi-ksc.lock.json'), 'utf8'),
) as { sourceUrl: string; snapshotPath: string; snapshotSha256: string; observedAt: string };
const earthClassificationSources = [
  {
    id: 'noaa-gshhg-2-3-7-full', url: gshhgClassLock.artifactUrl,
    author: 'Paul Wessel and Walter H. F. Smith; NOAA distribution',
    license: 'LGPL-3.0', licenseUrl: 'https://www.soest.hawaii.edu/pwessel/gshhg/',
    attribution: 'GSHHG 2.3.7 full-resolution shoreline hierarchy',
    checksumSha256: gshhgClassLock.artifactSha256,
    localPath: 'sources/noaa-gshhg-2.3.7/gshhg-shp-2.3.7.zip', authoringOnly: true,
    sourceDimensions: [360, 180],
    transformations: ['ESRI polygon decode', 'sample-center categorical rasterization', 'exact-code R8 packaging without mipmaps'],
    bodies: ['earth'], channels: ['surfaceClass', 'surfaceClassRegional'],
    ...scientificGrid, verticalDatum: 'not-applicable', valueScale: 1, valueOffset: 0,
    noDataValue: null, validRange: [0, 6], observation: 'GSHHG release 2.3.7 (2017)', productKind: 'measured',
    derivedRecipe: 'earth-surface-class-v1',
  },
  {
    id: 'usfws-nwi-ksc-snapshot-2026-07-20', url: nwiClassLock.sourceUrl,
    author: 'U.S. Fish and Wildlife Service National Wetlands Inventory',
    license: 'Public-Domain', licenseUrl: 'https://www.fws.gov/program/national-wetlands-inventory/data-download',
    attribution: 'USFWS NWI Cowardin classification, bounded KSC snapshot',
    checksumSha256: nwiClassLock.snapshotSha256,
    localPath: nwiClassLock.snapshotPath.replace(/^assets\/planets\//, ''), authoringOnly: true,
    sourceDimensions: [...KSC_SURFACE_CLASS_DIMENSIONS],
    transformations: ['bounded EPSG:4326 FeatureServer snapshot', 'Cowardin system class mapping', 'sample-center categorical rasterization', 'GSHHG parent fallback'],
    bodies: ['earth'], channels: ['surfaceClassRegional'],
    ...scientificGrid, verticalDatum: 'not-applicable', valueScale: 1, valueOffset: 0,
    noDataValue: 0, validRange: [0, 6], observation: nwiClassLock.observedAt, productKind: 'measured',
    derivedRecipe: 'earth-surface-class-v1',
  },
] as const;

const moonSources = airlessSources.palla.sources.map((source) => ({
  ...source,
  ...(source.id.includes('color') ? {
    id: 'nasa-lro-moon-color-2025-4k',
    url: 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_4k.tif',
    attribution: 'NASA SVS CGI Moon Kit 2025 LROC color map',
    checksumSha256: '9731fa8af425b6c2f88f277ecca82bf8c603f3743894f64ed7b25c5bfefa22ff',
    localPath: 'sources/nasa-lro-moon-2025/lroc_color_16bit_srgb_4k.tif',
    sourceDimensions: [4096, 2048],
    transformations: ['16-bit sRGB decode', 'Lanczos3 tier resampling', 'RGB8 fallback and BasisLZ KTX2 encoding'],
  } : {
    id: source.id.replace('palla', 'moon'),
    attribution: source.attribution.replace('fictional moon Palla', 'Earth\'s Moon'),
    transformations: ['0.5 metre unsigned LOLA elevation decode', 'single-valued pole stabilization', 'east/north tangent-slope derivation', 'lossless RG packaging'],
  }),
  bodies: ['moon'],
  channels: source.channels.map((channel) => channel === 'material' ? 'heightMacro' : channel),
  datum: 'Moon mean-Earth/polar-axis body-fixed sphere',
  verticalDatum: source.id.includes('height') ? 'LOLA reference sphere; 0.5 metre unsigned encoding with 10 km offset' : 'not-applicable',
  projection: 'simple cylindrical equirectangular',
  axisOrder: 'longitude,latitude',
  longitudeDirection: 'east-positive',
  seamLongitudeDegrees: -180,
  uvOrigin: 'north-west',
  valueScale: source.id.includes('height') ? 0.5 : 1,
  valueOffset: source.id.includes('height') ? -10_000 : 0,
  noDataValue: null,
  validRange: source.id.includes('height') ? [-10_000, 10_000] : [0, 65_535],
  observation: source.id.includes('color') ? 'NASA SVS CGI Moon Kit 2025 color product' : 'NASA SVS CGI Moon Kit release 4720 LOLA height',
  productKind: source.id.includes('height') ? 'modeled' : 'composited',
  derivedRecipe: 'moon-source-pack-v1',
  bodyReferenceFrameVersion: 'iau-naif-j2000-v1',
}));

const localMaterialLock = JSON.parse(
  readFileSync(resolve(assetsRoot, 'local-material-source-lock.json'), 'utf8'),
) as {
  license: string;
  licenseSnapshot: string;
  assets: Array<{
    id: string; body: 'earth' | 'moon'; role: string; author: string; page: string;
    files: Record<string, [string, string]>;
  }>;
};
const localMaterialSources = localMaterialLock.assets.flatMap((asset) => (
  Object.entries(asset.files).map(([map, [checksumSha256, filename]]) => ({
    id: `polyhaven-${asset.id}-${map}-1k`,
    url: `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${asset.id}/${filename}`,
    author: asset.author,
    license: localMaterialLock.license,
    licenseUrl: localMaterialLock.licenseSnapshot,
    attribution: `Poly Haven ${asset.id} ${map}; ${asset.role} local PBR response`,
    checksumSha256,
    localPath: `sources/polyhaven-local/${filename}`,
    authoringOnly: true,
    sourceDimensions: [1024, 1024],
    transformations: [
      '1K source pin',
      'diffuse luminance normalization without biome recoloring',
      'OpenGL tangent normal preservation',
      'roughness packing',
      '2 metre body-fixed triplanar atlas sampling',
      'displacement channel explicitly excluded',
    ],
    bodies: [asset.body],
    channels: ['localDetail'],
    datum: 'local photoscan tangent plane',
    verticalDatum: 'not-applicable; displacement excluded',
    projection: 'local tangent-plane tile',
    axisOrder: 'longitude,latitude',
    longitudeDirection: 'east-positive',
    seamLongitudeDegrees: -180,
    uvOrigin: 'north-west',
    valueScale: 1,
    valueOffset: 0,
    noDataValue: null,
    validRange: [0, 255],
    observation: 'Poly Haven 1K photographic material release',
    productKind: 'measured',
    derivedRecipe: 'local-pbr-atlas-v1',
    bodyReferenceFrameVersion: 'iau-naif-j2000-v1',
  }))
));

const recipeFile = JSON.parse(readFileSync(recipesPath, 'utf8')) as { schemaVersion: number; recipes: RecipeRecord[] };
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, any>;
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
if (manifest.compiler.imageLibraryVersion !== `sharp@${packageJson.devDependencies.sharp}`) throw new Error('Manifest image library does not match the pinned sharp dependency');
if (manifest.compiler.compressionThreads !== 1) throw new Error('Planet compiler packaging must remain single-threaded');
const declared = new Map(recipeFile.recipes.map((recipe) => [recipe.bodyId, recipe]));
const universe = new Universe(AUREN_SYSTEM);
const solUniverse = new Universe([...SOL_SYSTEM], 'earth');
const bodies = [...universe.bodies.values()].map((body) => {
  const runtimeRecipe = recipeForBody(body);
  const record = declared.get(body.id);
  if (!record || record.version !== runtimeRecipe.version || record.hash !== runtimeRecipe.hash) throw new Error(`Recipe metadata drift for ${body.id}`);
  return { bodyId: body.id, surfaceKind: body.def.surfaceKind, recipeVersion: runtimeRecipe.version, recipeHash: runtimeRecipe.hash, rawHeightSha256: rawHeightFingerprint(body) };
}).sort((a, b) => a.bodyId.localeCompare(b.bodyId));

let veyraCanonical = (JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, any>).veyraCanonical;
const generatedPacks: Record<string, any>[] = [];
const generatedSources: Record<string, any>[] = [];

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
  const global = await compileVeyraGlobal(universe, targetTiers);
  generatedPacks.push(...global.packs as Record<string, any>[]);
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
  generatedSources.push({
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
  });
  manifest.canonicalArtifacts = [heightArtifact, scatterArtifact];
  manifest.budgets.rendererBaseGpuBytes = {
    low: 64 * 1024 * 1024,
    medium: 96 * 1024 * 1024,
    high: 128 * 1024 * 1024,
  };
}

if (write && !fingerprintsOnly) {
  for (const bodyId of ['palla', 'wisp'] as const) {
    if (!targetBodies.has(bodyId)) continue;
    generatedPacks.push(...await compileAirlessBody(bodyId, universe, targetTiers) as Record<string, any>[]);
    generatedSources.push(...airlessSources[bodyId].sources as unknown as Record<string, any>[]);
  }
  if (targetBodies.has('earth')) {
    generatedPacks.push(...await compileEarth(solUniverse, targetTiers) as Record<string, any>[]);
    generatedSources.push(...earthSources as unknown as Record<string, any>[]);
    generatedSources.push(...earthClassificationSources as unknown as Record<string, any>[]);
    generatedSources.push(...localMaterialSources.filter((source) => source.bodies.includes('earth')));
  }
  if (targetBodies.has('mercury')) {
    generatedPacks.push(...await compileAlbedoOnlyBody(
      'mercury', mercurySourcePath, mercurySourceLock.sourceDimensions, targetTiers,
    ) as Record<string, any>[]);
    generatedSources.push(...mercurySources as unknown as Record<string, any>[]);
  }
  if (targetBodies.has('moon')) {
    generatedPacks.push(...await compileMoon(solUniverse, targetTiers) as Record<string, any>[]);
    generatedSources.push(...moonSources as unknown as Record<string, any>[]);
    generatedSources.push(...localMaterialSources.filter((source) => source.bodies.includes('moon')));
  }
  if (targetBodies.has('mars')) {
    generatedPacks.push(...await compileAlbedoOnlyBody(
      'mars', marsSourcePath, marsSourceLock.sourceDimensions, targetTiers,
    ) as Record<string, any>[]);
    generatedSources.push(...marsSources as unknown as Record<string, any>[]);
  }
  if (targetBodies.has('sun')) {
    generatedPacks.push(...await compileSun(targetTiers) as Record<string, any>[]);
    generatedSources.push(...sunSources as unknown as Record<string, any>[]);
  }
}

if (write && generatedPacks.length > 0) {
  const replacedPacks = new Set(generatedPacks.map((pack) => `${pack.bodyId}/${pack.tier}`));
  manifest.packs = [
    ...manifest.packs.filter((pack: Record<string, any>) => !replacedPacks.has(`${pack.bodyId}/${pack.tier}`)),
    ...generatedPacks,
  ].sort((left: Record<string, any>, right: Record<string, any>) =>
    left.bodyId.localeCompare(right.bodyId) ||
    Object.keys(tierDimensions).indexOf(left.tier) - Object.keys(tierDimensions).indexOf(right.tier));
  for (const pack of manifest.packs) {
    pack.bootCritical = pack.bodyId === 'earth' && pack.tier === 'medium';
  }
  const sourceIds = new Set(generatedSources.map((source) => source.id));
  manifest.sources = [
    ...manifest.sources.filter((source: Record<string, any>) => (
      !sourceIds.has(source.id)
      && !(targetBodies.has('moon') && source.id === 'nasa-lro-moon-color-8k')
    )),
    ...generatedSources,
  ].sort((left: Record<string, any>, right: Record<string, any>) => left.id.localeCompare(right.id));
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
