import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

const BODY_IDS = [
  'auren', 'ashen', 'vess', 'veyra', 'palla', 'wisp',
  'rusk', 'tyran', 'brimm', 'glacia', 'mote', 'farfall',
];

const CHANNELS = ['albedo', 'normal', 'material', 'clouds'] as const;
const TIER_DIMENSIONS = {
  low: [1024, 512],
  medium: [2048, 1024],
  high: [4096, 2048],
} as const;
const NATURAL_EARTH_SHA256 = '3506ed32f53020eb8822a8c694dc80df7327e21c9a4df0df8f4630756ed4c919';
const FIXTURE_HEIGHT = new Uint8Array([0, 0, 2, 0]);
const FIXTURE_HEIGHT_SHA256 = createHash('sha256').update(FIXTURE_HEIGHT).digest('hex');
const FIXTURE_RAW_HASHES = {
  albedo: 'a'.repeat(64),
  normal: 'b'.repeat(64),
  material: 'c'.repeat(64),
  clouds: 'd'.repeat(64),
};

const SCATTER_TERRAIN_HASH = '3'.padStart(32, '0');
const SCATTER_RECIPE_HASH = 'a'.repeat(32);
const SCATTER_FIXTURE = {
  formatVersion: 1,
  bodyId: 'veyra',
  terrainRecipeHash: SCATTER_TERRAIN_HASH,
  hash: SCATTER_RECIPE_HASH,
  cellResolution: 32,
  cellQuantum: 65536,
  sizeQuantumMeters: 0.01,
  recordCount: 1,
  cells: [{
    face: 0, cx: 0, cy: 0, seed: 1,
    records: [{ id: '0000000000000001', qu: 0, qv: 0, qRadius: 100, qHeight: 100, proxy: 'sphere', biome: 1, visual: 0 }],
  }],
};
const SCATTER_BYTES = Buffer.from(JSON.stringify(SCATTER_FIXTURE));
const SCATTER_CHECKSUM = createHash('sha256').update(SCATTER_BYTES).digest('hex');
const SCATTER_ARTIFACT = {
  bodyId: 'veyra', kind: 'physical-scatter',
  path: 'generated/veyra/canonical/scatter.json',
  runtimePath: 'src/generated/veyra-scatter.json',
  recordCount: 1, cellCount: 1, cellResolution: 32,
  scatterRecipeHash: SCATTER_RECIPE_HASH, terrainRecipeHash: SCATTER_TERRAIN_HASH,
  checksumSha256: SCATTER_CHECKSUM,
};
const SCATTER_OUTPUT = {
  path: 'generated/veyra/canonical/scatter.json',
  runtimePath: 'src/generated/veyra-scatter.json',
  scatterRecipeHash: SCATTER_RECIPE_HASH, terrainRecipeHash: SCATTER_TERRAIN_HASH,
  recordCount: 1, cellCount: 1, cellResolution: 32, checksumSha256: SCATTER_CHECKSUM,
};

function fullMipCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
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

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, normalize((entry as Record<string, unknown>)[key])]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function ktx2Fixture(
  width: number,
  height: number,
  levels = fullMipCount(width, height),
  encoding: 'basis-lz' | 'uastc-zstd' = 'basis-lz',
): Uint8Array {
  const levelIndexEnd = 80 + levels * 24;
  const dfdOffset = levelIndexEnd;
  const dfdLength = 44;
  const sgdLength = encoding === 'basis-lz' ? 1 : 0;
  const sgdOffset = sgdLength > 0 ? dfdOffset + dfdLength : 0;
  const levelDataOffset = dfdOffset + dfdLength + sgdLength;
  const bytes = new Uint8Array(levelDataOffset + levels);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1, true);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(36, 1, true);
  view.setUint32(40, levels, true);
  view.setUint32(44, encoding === 'basis-lz' ? 1 : 2, true);
  view.setUint32(48, dfdOffset, true);
  view.setUint32(52, dfdLength, true);
  view.setBigUint64(64, BigInt(sgdOffset), true);
  view.setBigUint64(72, BigInt(sgdLength), true);
  for (let level = 0; level < levels; level++) {
    const indexOffset = 80 + level * 24;
    view.setBigUint64(indexOffset, BigInt(levelDataOffset + level), true);
    view.setBigUint64(indexOffset + 8, 1n, true);
    view.setBigUint64(indexOffset + 16, encoding === 'basis-lz' ? 0n : 16n, true);
    bytes[levelDataOffset + level] = level + 1;
  }
  view.setUint32(dfdOffset, dfdLength, true);
  view.setUint16(dfdOffset + 8, 2, true);
  view.setUint16(dfdOffset + 10, dfdLength - 4, true);
  bytes[dfdOffset + 12] = encoding === 'basis-lz' ? 163 : 166;
  bytes[dfdOffset + 13] = 1;
  bytes[dfdOffset + 14] = encoding === 'basis-lz' ? 2 : 1;
  bytes[dfdOffset + 16] = 3;
  bytes[dfdOffset + 17] = 3;
  bytes[dfdOffset + 20] = encoding === 'basis-lz' ? 8 : 16;
  if (encoding === 'uastc-zstd') {
    for (let level = 0; level < levels; level++) {
      const mipWidth = Math.max(1, width >> level);
      const mipHeight = Math.max(1, height >> level);
      view.setBigUint64(
        80 + level * 24 + 16,
        BigInt(Math.ceil(mipWidth / 4) * Math.ceil(mipHeight / 4) * 16),
        true,
      );
    }
  }
  return bytes;
}

function completeVeyraPackFixture() {
  const files: Record<string, Uint8Array> = {};
  const packs = Object.entries(TIER_DIMENSIONS).map(([tier, [width, height]]) => {
    const channels = CHANNELS.map((name) => {
      const packagePath = `generated/veyra/${tier}/${name}.ktx2`;
      const fallbackPath = `generated/veyra/${tier}/${name}.${name === 'albedo' ? 'webp' : 'png'}`;
      const packageBytes = ktx2Fixture(
        width,
        height,
        fullMipCount(width, height),
        name === 'albedo' ? 'basis-lz' : 'uastc-zstd',
      );
      const fallbackBytes = new Uint8Array([1, 2, 3, 4]);
      files[packagePath] = packageBytes;
      files[fallbackPath] = fallbackBytes;
      return {
        name,
        colorSpace: name === 'albedo' ? 'sRGB' : 'linear',
        logicalFormat: name === 'albedo' ? 'RGB8' : name === 'material' ? 'RGBA8' : 'RG8',
        packagePath,
        fallbackPath,
        packageChecksumSha256: createHash('sha256').update(packageBytes).digest('hex'),
        fallbackChecksumSha256: createHash('sha256').update(fallbackBytes).digest('hex'),
        gpuFormat: name === 'albedo' ? 'bc1-rgb' : name === 'material' ? 'bc3-rgba' : 'bc5-rg',
        gpuBytes: fullMipBytes(width, height, name === 'albedo' ? 8 : 16),
        fallbackGpuBytes: fullMipRgbaBytes(width, height),
        fallbackLayout: name === 'albedo' ? 'rgb' : name === 'material' ? 'rgba' : 'rgb-rg',
        transcodeTargets: name === 'albedo'
          ? ['etc2-rgb', 'bc1-rgb']
          : name === 'material'
            ? ['etc2-rgba', 'bc3-rgba', 'astc-rgba']
            : ['etc2-rgba', 'bc5-rg', 'astc-rgba'],
        mipmapped: true,
      };
    });
    return {
      bodyId: 'veyra', tier, width, height,
      compressedBytes: channels.reduce((sum, channel) => sum + files[channel.packagePath].byteLength, 0),
      transientBytes: 1024,
      bootCritical: tier === 'medium',
      channels,
    };
  });
  return { packs, files };
}

function canonicalFixture(compiler: ReturnType<typeof baseCompiler>) {
  const recipeHash = '3'.padStart(32, '0');
  const identitySha256 = createHash('sha256').update(JSON.stringify([
    '2.1.0',
    compiler.containerImage,
    compiler.ktxSoftwareVersion,
    compiler.ktxArchiveSha256,
    NATURAL_EARTH_SHA256,
    1,
    recipeHash,
    2,
    1,
    0.5,
    FIXTURE_RAW_HASHES,
    FIXTURE_HEIGHT_SHA256,
  ])).digest('hex');
  return {
    artifact: {
      bodyId: 'veyra', kind: 'height-s16le', path: 'generated/veyra/canonical/height.s16le',
      width: 2, height: 1, quantizationMeters: 0.5, offsetMeters: 0,
      byteOrder: 'little-endian', checksumSha256: FIXTURE_HEIGHT_SHA256,
      identitySha256, recipeHash, sourceChecksumSha256: NATURAL_EARTH_SHA256,
      compilerVersion: '2.1.0', containerImage: compiler.containerImage,
    },
    compilerOutput: {
      schemaVersion: 1,
      compilerVersion: '2.1.0',
      veyraCanonical: {
        width: 2, height: 1, rawHashes: FIXTURE_RAW_HASHES, identitySha256,
        heightArtifact: {
          path: 'generated/veyra/canonical/height.s16le',
          checksumSha256: FIXTURE_HEIGHT_SHA256,
          quantizationMeters: 0.5,
          byteOrder: 'little-endian',
        },
      },
      veyraScatter: SCATTER_OUTPUT,
    },
  };
}

function baseCompiler() {
  return {
    platform: 'linux/amd64',
    containerImage: 'node:22.23.1-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf',
    nodeVersion: '22.23.1',
    ktxSoftwareVersion: '4.4.2',
    ktxArchiveUrl: 'https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Linux-x86_64.tar.bz2',
    ktxArchiveSha256: 'a8781bad05f9624edbf910b7f258cd0a4ba7d3e63b49ecc0a0ab440bf6a0a245',
    compressionThreads: 1,
    imageLibraryVersion: 'sharp@0.35.3',
    resamplingKernel: 'lanczos3',
    albedoWorkingSpace: 'srgb',
    dataWorkingSpace: 'b-w',
  };
}

function recipes() {
  return {
    schemaVersion: 1,
    recipes: BODY_IDS.map((bodyId, index) => ({
      bodyId,
      version: 1,
      hash: index.toString(16).padStart(32, '0'),
    })),
  };
}

function baseManifest() {
  const { packs } = completeVeyraPackFixture();
  const compiler = baseCompiler();
  const canonical = canonicalFixture(compiler);
  return {
    schemaVersion: 1,
    compiler,
    budgets: {
      mediumBootTransferBytes: 12 * 1024 * 1024,
      mediumPackTransferBytes: 32 * 1024 * 1024,
      activeBodyGpuBytes: { low: 64 * 1024 * 1024, medium: 128 * 1024 * 1024, high: 256 * 1024 * 1024 },
      totalRendererGpuBytes: { low: 256 * 1024 * 1024, medium: 384 * 1024 * 1024, high: 768 * 1024 * 1024 },
      transientPeakBytes: { low: 96 * 1024 * 1024, medium: 192 * 1024 * 1024, high: 384 * 1024 * 1024 },
      rendererBaseGpuBytes: { low: 64 * 1024 * 1024, medium: 96 * 1024 * 1024, high: 128 * 1024 * 1024 },
    },
    sources: [{
      id: 'natural-earth-ii-3.2.0',
      url: 'https://naturalearth.s3.amazonaws.com/10m_raster/NE2_LR_LC.zip',
      author: 'Natural Earth', license: 'Public-Domain',
      licenseUrl: 'https://www.naturalearthdata.com/about/terms-of-use/',
      attribution: 'Made with Natural Earth; modified by Perilune',
      checksumSha256: NATURAL_EARTH_SHA256,
      localPath: 'sources/natural-earth-ii-3.2.0/NE2_LR_LC.zip',
      authoringOnly: true, sourceDimensions: [16200, 8100],
      transformations: ['body-fixed reprojection'], bodies: ['veyra'], channels: ['albedo'],
    }] as unknown[],
    canonicalArtifacts: [canonical.artifact, structuredClone(SCATTER_ARTIFACT)] as unknown[],
    packs: packs as unknown[],
  };
}

function runValidator(
  manifest: unknown,
  asset?: Uint8Array,
  extraFiles: Record<string, Uint8Array> = {},
) {
  const fixtureFiles = completeVeyraPackFixture().files;
  const dir = mkdtempSync(join(tmpdir(), 'perilune-content-'));
  const manifestPath = join(dir, 'manifest.json');
  const recipesPath = join(dir, 'recipes.json');
  const checkedManifestPath = join(dir, 'checked-planet-manifest.json');
  const compilerOutputPath = join(dir, 'compiler-output.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(recipesPath, JSON.stringify(recipes()));
  writeFileSync(compilerOutputPath, JSON.stringify(canonicalFixture(baseCompiler()).compilerOutput));
  mkdirSync(join(dir, 'generated/veyra/canonical'), { recursive: true });
  writeFileSync(join(dir, 'generated/veyra/canonical/height.s16le'), FIXTURE_HEIGHT);
  writeFileSync(join(dir, 'generated/veyra/canonical/scatter.json'), SCATTER_BYTES);
  mkdirSync(join(dir, 'src/generated'), { recursive: true });
  writeFileSync(join(dir, 'src/generated/veyra-scatter.json'), SCATTER_BYTES);
  if (asset) writeFileSync(join(dir, 'source.bin'), asset);
  for (const [path, bytes] of Object.entries({ ...fixtureFiles, ...extraFiles })) {
    const target = join(dir, path);
    const targetDir = target.slice(0, target.lastIndexOf('/'));
    if (targetDir !== target) mkdirSync(targetDir, { recursive: true });
    writeFileSync(target, bytes);
  }
  const result = spawnSync(process.execPath, ['scripts/validate-content.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PERILUNE_MANIFEST_PATH: manifestPath,
      PERILUNE_RECIPES_PATH: recipesPath,
      PERILUNE_CHECKED_MANIFEST_PATH: checkedManifestPath,
      PERILUNE_COMPILER_OUTPUT_PATH: compilerOutputPath,
      PERILUNE_ROOT: dir,
    },
  });
  return Object.assign(result, { checkedManifestPath });
}

function runRepositoryValidator(manifest: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'perilune-repository-content-'));
  // Asset paths are relative to the manifest directory, so keep this probe
  // beside the production manifest while directing generated output to /tmp.
  const manifestPath = join(process.cwd(), 'assets/planets', `.manifest-mars-test-${randomUUID()}.json`);
  const checkedManifestPath = join(dir, 'checked-planet-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  try {
    return spawnSync(process.execPath, ['scripts/validate-content.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PERILUNE_MANIFEST_PATH: manifestPath,
        PERILUNE_CHECKED_MANIFEST_PATH: checkedManifestPath,
        PERILUNE_ROOT: process.cwd(),
      },
    });
  } finally {
    unlinkSync(manifestPath);
  }
}

function replacePackage(
  manifest: ReturnType<typeof baseManifest>,
  tier: string,
  channelName: string,
  bytes: Uint8Array,
) {
  const pack = (manifest.packs as Array<any>).find((candidate) => candidate.tier === tier);
  const channel = pack.channels.find((candidate: any) => candidate.name === channelName);
  pack.compressedBytes += bytes.byteLength - completeVeyraPackFixture().files[channel.packagePath].byteLength;
  channel.packageChecksumSha256 = createHash('sha256').update(bytes).digest('hex');
  return { [channel.packagePath]: bytes };
}

describe('planet content validator', () => {
  it('accepts the checked-in manifest and recipe metadata', () => {
    const result = spawnSync(process.execPath, ['scripts/validate-content.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('emits a deterministic checked artifact only after successful validation', () => {
    const valid = runValidator(baseManifest());
    expect(valid.status, valid.stderr || valid.stdout).toBe(0);
    const artifact = JSON.parse(readFileSync(valid.checkedManifestPath, 'utf8')) as {
      schemaVersion: number; manifestSha256: string; manifest: { schemaVersion: number };
    };
    expect(artifact).toMatchObject({ schemaVersion: 1, manifest: { schemaVersion: 1 } });
    expect(artifact.manifestSha256).toMatch(/^[a-f0-9]{64}$/);

    const invalidManifest = baseManifest();
    invalidManifest.schemaVersion = 2;
    const invalid = runValidator(invalidManifest);
    expect(invalid.status).not.toBe(0);
    expect(existsSync(invalid.checkedManifestPath)).toBe(false);
  });

  it('validates content before syncing renderer assets in the production build entry', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: { prebuild: string } };
    expect(packageJson.scripts.prebuild)
      .toBe('npm run validate:content && npm run sync:renderer-assets && npm run check:launch-site');

    const dir = mkdtempSync(join(tmpdir(), 'perilune-invalid-build-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 999 }));
    const result = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'build'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, PERILUNE_MANIFEST_PATH: manifestPath },
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/manifest schemaVersion must be 1/i);
    expect(result.stdout).not.toMatch(/vite v\d/i);
  }, 30_000);

  it('rejects checked-artifact paths outside public planets', () => {

    const dir = mkdtempSync(join(tmpdir(), 'perilune-sync-'));
    const artifactPath = join(dir, 'checked.json');
    const manifest = { packs: [{ channels: [{ packagePath: '../escape.ktx2', fallbackPath: 'safe.webp' }] }] };
    writeFileSync(artifactPath, JSON.stringify({
      schemaVersion: 1,
      manifestSha256: createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
      manifest,
    }));
    const result = spawnSync(process.execPath, ['scripts/sync-renderer-assets.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PERILUNE_CHECKED_MANIFEST_PATH: artifactPath },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsafe validated planet asset path/i);
  });

  it('keeps source fetching explicit and outside prebuild', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['fetch:planet-source']).toBe('node scripts/fetch-planet-source.mjs');
    expect(packageJson.scripts.prebuild).not.toMatch(/fetch|curl|download/i);
    const fetchScript = readFileSync('scripts/fetch-planet-source.mjs', 'utf8');
    expect(fetchScript).toContain('3506ed32f53020eb8822a8c694dc80df7327e21c9a4df0df8f4630756ed4c919');
    expect(fetchScript).toContain('NE2_LR_LC.zip');
  });

  it('atomically re-extracts the TIFF from the verified archive on every fetch', () => {
    const fetchScript = readFileSync('scripts/fetch-planet-source.mjs', 'utf8');
    expect(fetchScript).toContain('const temporaryImagePath = `${imagePath}.partial`;');
    expect(fetchScript).toContain("spawnSync('unzip', ['-p', archivePath, 'NE2_LR_LC.tif']");
    expect(fetchScript).toContain('renameSync(temporaryImagePath, imagePath)');
    expect(fetchScript).not.toContain('if (!existsSync(imagePath))');
  });

  it('provides native authoring with an explicit authoritative linux/amd64 release mode', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['compile:planet-assets:container'])
      .toBe('node scripts/compile-planet-assets-container.mjs');
    const runner = readFileSync('scripts/compile-planet-assets-container.mjs', 'utf8');
    expect(runner).toContain("const release = process.argv.includes('--release')");
    expect(runner).toContain("const architecture = release ? 'amd64' : dockerArchitecture()");
    expect(runner).toContain("const platform = `linux/${architecture}`");
    expect(runner).toContain("'--platform', platform");
    expect(runner).toMatch(/type=bind/);
    expect(runner).toMatch(/assets\/planets/);
    expect(runner).toContain('compile:planet-assets');
    expect(runner).toContain('--write');
    expect(runner).toContain('native authoring');
    expect(runner).toContain('release');
  });

  it('pins the Linux KTX encoder archive at the manifest and container boundary', () => {
    const manifest = JSON.parse(readFileSync('assets/planets/manifest.json', 'utf8')) as {
      compiler: { ktxArchiveUrl?: string; ktxArchiveSha256?: string };
    };
    expect(manifest.compiler.ktxArchiveUrl)
      .toBe('https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Linux-x86_64.tar.bz2');
    expect(manifest.compiler.ktxArchiveSha256)
      .toBe('a8781bad05f9624edbf910b7f258cd0a4ba7d3e63b49ecc0a0ab440bf6a0a245');
  });

  it('accepts an absent authoring-only public-domain source with a pinned archive checksum', () => {
    const manifest = baseManifest();
    manifest.sources = [{
      id: 'natural-earth-ii-3.2.0',
      url: 'https://naturalearth.s3.amazonaws.com/10m_raster/NE2_LR_LC.zip',
      author: 'Natural Earth',
      license: 'Public-Domain',
      licenseUrl: 'https://www.naturalearthdata.com/about/terms-of-use/',
      attribution: 'Made with Natural Earth; modified by Perilune',
      checksumSha256: '3506ed32f53020eb8822a8c694dc80df7327e21c9a4df0df8f4630756ed4c919',
      localPath: 'sources/natural-earth-ii-3.2.0/NE2_LR_LC.zip',
      authoringOnly: true,
      sourceDimensions: [16200, 8100],
      transformations: ['body-fixed reprojection', 'deterministic recolor', 'terrain-derived masks'],
      bodies: ['veyra'],
      channels: ['albedo'],
    }];
    const result = runValidator(manifest);
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('matches checked recipe hashes and raw height fingerprints', () => {
    const result = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'compile:planet-assets'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('ships three complete Veyra tiers with genuine KTX2 packages and exact fallbacks', async () => {
    const manifest = JSON.parse(readFileSync('assets/planets/manifest.json', 'utf8')) as {
      packs: Array<{ bodyId: string; tier: string; width: number; height: number; channels: Array<{
        name: string; packagePath: string; fallbackPath: string;
      }> }>;
    };
    const packs = manifest.packs.filter((pack) => pack.bodyId === 'veyra');
    expect(packs.map((pack) => pack.tier).sort()).toEqual(['high', 'low', 'medium']);
    for (const pack of packs) {
      expect(pack.channels.map((channel) => channel.name).sort())
        .toEqual(['albedo', 'clouds', 'material', 'normal']);
      for (const channel of pack.channels) {
        const packageBytes = readFileSync(join('assets/planets', channel.packagePath));
        expect([...packageBytes.subarray(0, 12)]).toEqual([
          0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        const metadata = await sharp(join('assets/planets', channel.fallbackPath)).metadata();
        expect([metadata.width, metadata.height]).toEqual([pack.width, pack.height]);
        expect(metadata.format).toBe(channel.name === 'albedo' ? 'webp' : 'png');
      }
    }
    const compilerOutput = JSON.parse(readFileSync('assets/planets/compiler-output.json', 'utf8')) as {
      veyraCanonical?: { width: number; height: number; rawHashes: Record<string, string> };
    };
    expect(compilerOutput.veyraCanonical).toMatchObject({ width: 8192, height: 4096 });
    expect(Object.values(compilerOutput.veyraCanonical?.rawHashes ?? {})).toHaveLength(4);
    for (const hash of Object.values(compilerOutput.veyraCanonical?.rawHashes ?? {})) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('rejects unknown and share-alike licenses', () => {
    for (const license of ['UNKNOWN', 'CC-BY-SA-4.0']) {
      const manifest = baseManifest();
      manifest.sources = [{
        id: 'source',
        url: 'https://example.com/source',
        author: 'Example Author',
        license,
        licenseUrl: 'https://example.com/license',
        attribution: 'Example Author',
        checksumSha256: '0'.repeat(64),
        localPath: 'source.bin',
        transformations: ['reprojection'],
        bodies: ['veyra'],
        channels: ['albedo'],
      }];
      const result = runValidator(manifest, new Uint8Array([1, 2, 3]));
      expect(result.status, result.stderr || result.stdout).not.toBe(0);
      expect(result.stderr).toMatch(/license/i);
    }
  });

  it('validates source checksums and required attribution', () => {
    const asset = new Uint8Array([1, 2, 3]);
    const checksum = createHash('sha256').update(asset).digest('hex');
    const manifest = baseManifest();
    const source = {
      id: 'source',
      url: 'https://example.com/source',
      author: 'Example Author',
      license: 'CC-BY-4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      attribution: 'Example Author; modified by Perilune',
      checksumSha256: checksum,
      localPath: 'source.bin',
      transformations: ['reprojection'],
      bodies: ['veyra'],
      channels: ['albedo'],
    };
    (manifest.sources as unknown[]).push(source);
    expect(runValidator(manifest, asset).status).toBe(0);
    source.checksumSha256 = '0'.repeat(64);
    const invalid = runValidator(manifest, asset);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toMatch(/checksum/i);
  });

  it('rejects incorrect tier dimensions and pack budgets', () => {
    const manifest = baseManifest();
    manifest.packs = [{
      bodyId: 'veyra',
      tier: 'medium',
      width: 1024,
      height: 512,
      compressedBytes: 40 * 1024 * 1024,
      transientBytes: 200 * 1024 * 1024,
      bootCritical: true,
      channels: [{
        name: 'albedo',
        colorSpace: 'sRGB',
        logicalFormat: 'RGB8',
        packagePath: 'veyra-albedo.ktx2',
        fallbackPath: 'veyra-albedo.webp',
        gpuBytes: 140 * 1024 * 1024,
        gpuFormat: 'bc1-rgb',
        mipmapped: true,
      }],
    }];
    const result = runValidator(manifest);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/dimension|budget/i);
  });

  it('derives mip memory and requires package and fallback files', () => {
    let expectedGpuBytes = 0;
    for (let width = 2048, height = 1024; ; width = Math.max(1, width >> 1), height = Math.max(1, height >> 1)) {
      expectedGpuBytes += Math.ceil(width / 4) * Math.ceil(height / 4) * 8;
      if (width === 1 && height === 1) break;
    }
    const manifest = baseManifest();
    const mediumPack = (manifest.packs as Array<any>).find((pack) => pack.tier === 'medium');
    const albedo = mediumPack.channels.find((channel: any) => channel.name === 'albedo');
    expect(albedo.gpuBytes).toBe(expectedGpuBytes);
    expect(runValidator(manifest).status).toBe(0);

    const missingManifest = structuredClone(manifest);
    const missingPack = (missingManifest.packs as Array<any>).find((pack) => pack.tier === 'medium');
    missingPack.channels.find((channel: any) => channel.name === 'albedo').packagePath = 'missing.ktx2';
    const missing = runValidator(missingManifest);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/missing/i);

    albedo.gpuBytes++;
    const wrongMemory = runValidator(manifest);
    expect(wrongMemory.status).not.toBe(0);
    expect(wrongMemory.stderr).toMatch(/memory/i);
  });

  it('derives fallback upload memory and enforces each channel fallback contract', () => {
    const wrongBytesManifest = baseManifest();
    const lowPack = (wrongBytesManifest.packs as Array<any>).find((pack) => pack.tier === 'low');
    lowPack.channels[0].fallbackGpuBytes--;
    const wrongBytes = runValidator(wrongBytesManifest);
    expect(wrongBytes.status).not.toBe(0);
    expect(wrongBytes.stderr).toMatch(/fallback memory mismatch/i);

    const wrongLayoutManifest = baseManifest();
    const normal = (wrongLayoutManifest.packs as Array<any>)
      .find((pack) => pack.tier === 'low').channels.find((channel: any) => channel.name === 'normal');
    normal.fallbackLayout = 'rgba';
    const wrongLayout = runValidator(wrongLayoutManifest);
    expect(wrongLayout.status).not.toBe(0);
    expect(wrongLayout.stderr).toMatch(/fallback layout/i);

    const wrongTargetsManifest = baseManifest();
    const material = (wrongTargetsManifest.packs as Array<any>)
      .find((pack) => pack.tier === 'low').channels.find((channel: any) => channel.name === 'material');
    material.transcodeTargets = ['bc3-rgba'];
    const wrongTargets = runValidator(wrongTargetsManifest);
    expect(wrongTargets.status).not.toBe(0);
    expect(wrongTargets.stderr).toMatch(/transcode targets/i);
  });

  it('budgets for the larger compressed or conventional-fallback upload path', () => {
    const activeManifest = baseManifest();
    activeManifest.budgets.activeBodyGpuBytes.low = 5 * 1024 * 1024;
    const active = runValidator(activeManifest);
    expect(active.status).not.toBe(0);
    expect(active.stderr).toMatch(/fallback.*active-body GPU budget/i);

    const totalManifest = baseManifest();
    totalManifest.budgets.totalRendererGpuBytes.low = 70 * 1024 * 1024;
    const total = runValidator(totalManifest);
    expect(total.status).not.toBe(0);
    expect(total.stderr).toMatch(/fallback.*total renderer GPU budget/i);
  });

  it('validates the canonical Veyra height artifact length, checksum, and identity chain', () => {
    const missingManifest = baseManifest();
    missingManifest.canonicalArtifacts = [];
    const missing = runValidator(missingManifest);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/exactly one Veyra canonical height/i);

    const lengthManifest = baseManifest();
    (lengthManifest.canonicalArtifacts[0] as any).width = 3;
    const length = runValidator(lengthManifest);
    expect(length.status).not.toBe(0);
    expect(length.stderr).toMatch(/byte length/i);

    const checksumManifest = baseManifest();
    (checksumManifest.canonicalArtifacts[0] as any).checksumSha256 = '0'.repeat(64);
    const checksum = runValidator(checksumManifest);
    expect(checksum.status).not.toBe(0);
    expect(checksum.stderr).toMatch(/canonical height checksum mismatch/i);

    const identityManifest = baseManifest();
    (identityManifest.canonicalArtifacts[0] as any).identitySha256 = '0'.repeat(64);
    const identity = runValidator(identityManifest);
    expect(identity.status).not.toBe(0);
    expect(identity.stderr).toMatch(/canonical identity mismatch/i);
  });

  it('rejects an identifier-only KTX2 with no level index or payload', () => {
    const manifest = baseManifest();
    const packageBytes = new Uint8Array(80);
    packageBytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(packageBytes.buffer);
    view.setUint32(16, 1, true);
    view.setUint32(20, 1024, true);
    view.setUint32(24, 512, true);
    view.setUint32(36, 1, true);
    view.setUint32(40, 11, true);
    view.setUint32(44, 1, true);
    const result = runValidator(manifest, undefined, replacePackage(manifest, 'low', 'albedo', packageBytes));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/level index|truncated/i);
  });

  it('requires the exact full mip chain for every KTX2 package', () => {
    const manifest = baseManifest();
    const packageBytes = ktx2Fixture(1024, 512, 10, 'basis-lz');
    const result = runValidator(manifest, undefined, replacePackage(manifest, 'low', 'albedo', packageBytes));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exactly 11 mip levels/i);
  });

  it('enforces BasisLZ for albedo and UASTC plus Zstd for data channels', () => {
    const manifest = baseManifest();
    const wrongAlbedo = ktx2Fixture(1024, 512, 11, 'uastc-zstd');
    const albedoResult = runValidator(
      manifest,
      undefined,
      replacePackage(manifest, 'low', 'albedo', wrongAlbedo),
    );
    expect(albedoResult.status).not.toBe(0);
    expect(albedoResult.stderr).toMatch(/BasisLZ.*ETC1S/i);

    const dataManifest = baseManifest();
    const wrongNormal = ktx2Fixture(1024, 512, 11, 'basis-lz');
    const normalResult = runValidator(
      dataManifest,
      undefined,
      replacePackage(dataManifest, 'low', 'normal', wrongNormal),
    );
    expect(normalResult.status).not.toBe(0);
    expect(normalResult.stderr).toMatch(/UASTC.*Zstd/i);
  });

  it('rejects KTX2 indexes and DFD sections that point outside the package', () => {
    const manifest = baseManifest();
    const packageBytes = ktx2Fixture(1024, 512);
    new DataView(packageBytes.buffer).setUint32(48, packageBytes.byteLength + 8, true);
    const result = runValidator(manifest, undefined, replacePackage(manifest, 'low', 'albedo', packageBytes));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/DFD.*bounds/i);
  });

  it('rejects overlapping KTX2 metadata sections', () => {
    const manifest = baseManifest();
    const packageBytes = ktx2Fixture(1024, 512);
    const view = new DataView(packageBytes.buffer);
    view.setUint32(56, view.getUint32(48, true), true);
    view.setUint32(60, 4, true);
    const result = runValidator(manifest, undefined, replacePackage(manifest, 'low', 'albedo', packageBytes));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/metadata sections overlap/i);
  });

  it('requires exactly one Veyra pack for each runtime tier', () => {
    const missingManifest = baseManifest();
    missingManifest.packs = (missingManifest.packs as Array<any>).filter((pack) => pack.tier !== 'high');
    const missing = runValidator(missingManifest);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/exactly one Veyra high pack/i);

    const duplicateManifest = baseManifest();
    const low = (duplicateManifest.packs as Array<any>).find((pack) => pack.tier === 'low');
    (duplicateManifest.packs as Array<any>).push(structuredClone(low));
    const duplicate = runValidator(duplicateManifest);
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stderr).toMatch(/exactly one Veyra low pack/i);
  });

  it('requires the exact four-channel set in every Veyra pack', () => {
    const manifest = baseManifest();
    const pack = (manifest.packs as Array<any>).find((candidate) => candidate.tier === 'low');
    pack.channels = pack.channels.filter((channel: any) => channel.name !== 'clouds');
    pack.compressedBytes = pack.channels.reduce(
      (sum: number, channel: any) => sum + completeVeyraPackFixture().files[channel.packagePath].byteLength,
      0,
    );
    const result = runValidator(manifest);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exact channels.*albedo.*normal.*material.*clouds/i);
  });

  it('enforces albedo-only compact-planet packs and rejects terrain-oriented channels', () => {
    for (const bodyId of ['mercury', 'venus', 'mars', 'jupiter', 'callisto']) {
      const manifest = JSON.parse(readFileSync('assets/planets/manifest.json', 'utf8')) as any;
      const compact = manifest.packs.find((pack: any) => pack.bodyId === bodyId && pack.tier === 'low');
      const moon = manifest.packs.find((pack: any) => pack.bodyId === 'moon' && pack.tier === 'low');
      const normal = structuredClone(moon.channels.find((channel: any) => channel.name === 'normal'));
      compact.channels.push(normal);
      compact.compressedBytes += readFileSync(join('assets/planets', normal.packagePath)).byteLength;
      const result = runRepositoryValidator(manifest);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(new RegExp(`Pack ${bodyId}/low must have exact channels albedo`, 'i'));
    }
  });

  it('applies scientific provenance fields to every non-stellar Sol surface source', () => {
    const manifest = JSON.parse(readFileSync('assets/planets/manifest.json', 'utf8')) as any;
    const mercurySource = manifest.sources.find((source: any) => source.bodies?.includes('mercury'));
    delete mercurySource.datum;
    const result = runRepositoryValidator(manifest);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Mercury.*datum is required/i);
  });

  it('rejects packaged-file checksum drift', () => {
    const packageBytes = new Uint8Array(8);
    const fallbackBytes = new Uint8Array(8);
    const manifest = baseManifest();
    manifest.packs = [{
      bodyId: 'veyra',
      tier: 'low',
      width: 1024,
      height: 512,
      compressedBytes: packageBytes.byteLength,
      transientBytes: 1024,
      bootCritical: false,
      channels: [{
        name: 'albedo',
        colorSpace: 'sRGB',
        logicalFormat: 'RGB8',
        packagePath: 'veyra-albedo.ktx2',
        fallbackPath: 'veyra-albedo.webp',
        packageChecksumSha256: '0'.repeat(64),
        fallbackChecksumSha256: createHash('sha256').update(fallbackBytes).digest('hex'),
        gpuFormat: 'bc1-rgb',
        gpuBytes: 349544,
        mipmapped: true,
      }],
    }];
    const result = runValidator(manifest, undefined, {
      'veyra-albedo.ktx2': packageBytes,
      'veyra-albedo.webp': fallbackBytes,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checksum/i);
  });

  it('rejects a package that has a .ktx2 name without a KTX2 identifier', () => {
    const packageBytes = new Uint8Array(16);
    const fallbackBytes = new Uint8Array(8);
    const manifest = baseManifest();
    manifest.packs = [{
      bodyId: 'veyra', tier: 'low', width: 1024, height: 512,
      compressedBytes: packageBytes.byteLength, transientBytes: 1024, bootCritical: false,
      channels: [{
        name: 'albedo', colorSpace: 'sRGB', logicalFormat: 'RGB8',
        packagePath: 'veyra-albedo.ktx2', fallbackPath: 'veyra-albedo.webp',
        packageChecksumSha256: createHash('sha256').update(packageBytes).digest('hex'),
        fallbackChecksumSha256: createHash('sha256').update(fallbackBytes).digest('hex'),
        gpuFormat: 'bc1-rgb', gpuBytes: 349544, mipmapped: true,
      }],
    }];
    const result = runValidator(manifest, undefined, {
      'veyra-albedo.ktx2': packageBytes,
      'veyra-albedo.webp': fallbackBytes,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/KTX2 identifier/i);
  });

  it('rejects KTX2 dimensions and mip counts that disagree with the pack', () => {
    const packageBytes = ktx2Fixture(512, 512, 1);
    const fallbackBytes = new Uint8Array(8);
    const manifest = baseManifest();
    manifest.packs = [{
      bodyId: 'veyra', tier: 'low', width: 1024, height: 512,
      compressedBytes: packageBytes.byteLength, transientBytes: 1024, bootCritical: false,
      channels: [{
        name: 'albedo', colorSpace: 'sRGB', logicalFormat: 'RGB8',
        packagePath: 'veyra-albedo.ktx2', fallbackPath: 'veyra-albedo.webp',
        packageChecksumSha256: createHash('sha256').update(packageBytes).digest('hex'),
        fallbackChecksumSha256: createHash('sha256').update(fallbackBytes).digest('hex'),
        gpuFormat: 'bc1-rgb', gpuBytes: 349544, mipmapped: true,
      }],
    }];
    const result = runValidator(manifest, undefined, {
      'veyra-albedo.ktx2': packageBytes,
      'veyra-albedo.webp': fallbackBytes,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/KTX2 dimensions|mip levels/i);
  });

  it('requires complete case review for NASA and JPL sources', () => {
    const asset = new Uint8Array([4, 5, 6]);
    const checksum = createHash('sha256').update(asset).digest('hex');
    const manifest = baseManifest();
    const source: any = {
      id: 'nasa-source',
      url: 'https://www.nasa.gov/example',
      author: 'NASA',
      license: 'NASA',
      licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
      attribution: 'Source: NASA; modified by Perilune',
      checksumSha256: checksum,
      localPath: 'source.bin',
      transformations: ['reprojection'],
      bodies: ['veyra'],
      channels: ['albedo'],
    };
    (manifest.sources as unknown[]).push(source);
    expect(runValidator(manifest, asset).status).not.toBe(0);
    source.review = {
      thirdPartyContent: false,
      commercialUseReviewed: true,
      modificationReviewed: true,
      endorsementSafe: true,
      termsSnapshot: 'NASA media terms reviewed 2026-07-10',
    };
    expect(runValidator(manifest, asset).status).toBe(0);
  });
});

describe('physical scatter artifact validation', () => {
  it('passes with a well-formed scatter artifact and byte-identical copies', () => {
    expect(runValidator(baseManifest()).status).toBe(0);
  });

  it('fails when the scatter artifact is missing', () => {
    const manifest = baseManifest();
    manifest.canonicalArtifacts = (manifest.canonicalArtifacts as Array<{ kind: string }>)
      .filter((artifact) => artifact.kind !== 'physical-scatter');
    const result = runValidator(manifest);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/physical-scatter/i);
  });

  it('fails when the scatter hash aliases the terrain hash', () => {
    const manifest = baseManifest();
    const scatter = (manifest.canonicalArtifacts as Array<Record<string, unknown>>)
      .find((artifact) => artifact.kind === 'physical-scatter')!;
    scatter.scatterRecipeHash = SCATTER_TERRAIN_HASH;
    const result = runValidator(manifest);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/distinct/i);
  });

  it('fails when the asset and runtime copies diverge', () => {
    const manifest = baseManifest();
    const divergent = Buffer.from(JSON.stringify({ ...SCATTER_FIXTURE, recordCount: 1, cells: SCATTER_FIXTURE.cells }) + ' ');
    const result = runValidator(manifest, undefined, {
      'src/generated/veyra-scatter.json': new Uint8Array(divergent),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/byte-identical/i);
  });

  it('fails when scatter metadata disagrees with the compiler output', () => {
    const manifest = baseManifest();
    const scatter = (manifest.canonicalArtifacts as Array<Record<string, unknown>>)
      .find((artifact) => artifact.kind === 'physical-scatter')!;
    scatter.recordCount = 2;
    const result = runValidator(manifest);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/compiler output/i);
  });

  it('fails when a scatter record is placed in the ocean', () => {
    const oceanFixture = {
      ...SCATTER_FIXTURE,
      cells: [{
        ...SCATTER_FIXTURE.cells[0],
        records: [{ ...SCATTER_FIXTURE.cells[0].records[0], biome: 0 }],
      }],
    };
    const oceanBytes = Buffer.from(JSON.stringify(oceanFixture));
    const oceanChecksum = createHash('sha256').update(oceanBytes).digest('hex');
    const manifest = baseManifest();
    const scatter = (manifest.canonicalArtifacts as Array<Record<string, unknown>>)
      .find((artifact) => artifact.kind === 'physical-scatter')!;
    scatter.checksumSha256 = oceanChecksum;
    const result = runValidator(manifest, undefined, {
      'generated/veyra/canonical/scatter.json': new Uint8Array(oceanBytes),
      'src/generated/veyra-scatter.json': new Uint8Array(oceanBytes),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ocean/i);
  });
});
