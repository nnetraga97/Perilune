import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { AUREN_SYSTEM } from '../src/content/system';
import { Vec3 } from '../src/core/vec3';
import { recipeForBody } from '../src/sim/terrainRecipe';
import { solidHeight } from '../src/sim/terrain';
import { Universe } from '../src/sim/universe';
import { generateVeyraCanonicalMaps, type VeyraCanonicalMaps } from './lib/veyra-global-maps';
import { generateAirlessGlobalMaps, type AirlessGlobalMaps } from './lib/airless-global-maps';
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
const fingerprintsOnly = process.argv.includes('--fingerprints-only');
const tierDimensions = {
  low: [1024, 512],
  medium: [2048, 1024],
  high: [4096, 2048],
} as const;
type CompiledTier = keyof typeof tierDimensions;
type CompiledBody = 'veyra' | 'palla' | 'wisp';

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
    if (!['veyra', 'palla', 'wisp'].includes(bodyId)) throw new Error(`Unsupported compiled body: ${bodyId}`);
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

function runKtx(inputPath: string, outputPath: string, channel: ChannelOutput['name']): Promise<void> {
  const executable = process.env.KTX_CLI ?? 'ktx';
  const format = channel === 'albedo' ? 'R8G8B8_SRGB' :
    channel === 'material' ? 'R8G8B8A8_UNORM' : 'R8G8_UNORM';
  const encoding = channel === 'albedo'
    ? ['--encode', 'basis-lz', '--qlevel', '180']
    : ['--encode', 'uastc', '--uastc-quality', '2', '--zstd', '9'];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [
      'create', '--format', format, '--generate-mipmap', '--mipmap-filter', 'lanczos3',
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
  maps: AirlessGlobalMaps | VeyraCanonicalMaps,
): Promise<{ pack: Record<string, unknown>; channels: ChannelOutput[] }> {
  const bodyGeneratedRoot = resolve(assetsRoot, `generated/${bodyId}`);
  const tierDir = resolve(bodyGeneratedRoot, tier);
  mkdirSync(tierDir, { recursive: true });
  const definitions = [
    { name: 'albedo' as const, data: maps.albedo, channels: 3 as const, fallback: 'webp' as const },
    { name: 'normal' as const, data: maps.normal, channels: 2 as const, fallback: 'png' as const },
    { name: 'material' as const, data: maps.material, channels: 4 as const, fallback: 'png' as const },
    ...('clouds' in maps
      ? [{ name: 'clouds' as const, data: maps.clouds, channels: 2 as const, fallback: 'png' as const }]
      : []),
  ];
  const channels: ChannelOutput[] = [];
  const prepared: Array<{ definition: (typeof definitions)[number]; fallbackPath: string; encoderInput: string; packagePath: string }> = [];
  for (const definition of definitions) {
    const resized = sourceWidth === width && sourceHeight === height
      ? Buffer.from(definition.data)
      : definition.channels === 2
      ? await resizeLogicalRg(definition.data, sourceWidth, sourceHeight, width, height)
      : await sharp(Buffer.from(definition.data), {
        raw: { width: sourceWidth, height: sourceHeight, channels: definition.channels },
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
      await runKtx(encoderInput, packagePath, definition.name);
    } finally {
      rmSync(encoderInput, { force: true });
    }
  });
  for (const { definition, fallbackPath, packagePath } of prepared) {
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
      bodyId, tier, width, height, compressedBytes,
      transientBytes: width * height * ('clouds' in maps ? 22 : 18),
      bootCritical: bodyId === 'veyra' && tier === 'medium',
      channels,
    },
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
  const result = await sharp(airlessSources.palla.heightPath, { limitInputPixels: false, sequentialRead: true })
    .toColourspace('grey16')
    .resize(width, height, { kernel: sharp.kernel.lanczos3 })
    .raw({ depth: 'ushort' })
    .toBuffer({ resolveWithObject: true });
  if (result.info.channels !== 1 || result.data.length !== width * height * 2) {
    throw new Error(`Palla LOLA decode must produce ${width}x${height} unsigned-16 elevations`);
  }
  const encoded = new Uint16Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 2);
  const heights = new Float32Array(encoded.length);
  for (let index = 0; index < encoded.length; index++) heights[index] = (encoded[index] - 20_000) * 0.5;
  return heights;
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
}

if (write && generatedPacks.length > 0) {
  const replacedPacks = new Set(generatedPacks.map((pack) => `${pack.bodyId}/${pack.tier}`));
  manifest.packs = [
    ...manifest.packs.filter((pack: Record<string, any>) => !replacedPacks.has(`${pack.bodyId}/${pack.tier}`)),
    ...generatedPacks,
  ].sort((left: Record<string, any>, right: Record<string, any>) =>
    left.bodyId.localeCompare(right.bodyId) ||
    Object.keys(tierDimensions).indexOf(left.tier) - Object.keys(tierDimensions).indexOf(right.tier));
  const sourceIds = new Set(generatedSources.map((source) => source.id));
  manifest.sources = [
    ...manifest.sources.filter((source: Record<string, any>) => !sourceIds.has(source.id)),
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
