import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

const BODY_IDS = [
  'auren', 'ashen', 'vess', 'veyra', 'palla', 'wisp',
  'rusk', 'tyran', 'brimm', 'glacia', 'mote', 'farfall',
];

function ktx2Fixture(width: number, height: number, levels: number): Uint8Array {
  const bytes = new Uint8Array(80);
  bytes.set([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(40, levels, true);
  return bytes;
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
  return {
    schemaVersion: 1,
    compiler: {
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
    },
    budgets: {
      mediumBootTransferBytes: 12 * 1024 * 1024,
      mediumPackTransferBytes: 32 * 1024 * 1024,
      activeBodyGpuBytes: { low: 64 * 1024 * 1024, medium: 128 * 1024 * 1024, high: 256 * 1024 * 1024 },
      totalRendererGpuBytes: { low: 256 * 1024 * 1024, medium: 384 * 1024 * 1024, high: 768 * 1024 * 1024 },
      transientPeakBytes: { low: 96 * 1024 * 1024, medium: 192 * 1024 * 1024, high: 384 * 1024 * 1024 },
      rendererBaseGpuBytes: { low: 0, medium: 0, high: 0 },
    },
    sources: [] as unknown[],
    packs: [] as unknown[],
  };
}

function runValidator(
  manifest: unknown,
  asset?: Uint8Array,
  extraFiles: Record<string, Uint8Array> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'perilune-content-'));
  const manifestPath = join(dir, 'manifest.json');
  const recipesPath = join(dir, 'recipes.json');
  const checkedManifestPath = join(dir, 'checked-planet-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(recipesPath, JSON.stringify(recipes()));
  if (asset) writeFileSync(join(dir, 'source.bin'), asset);
  for (const [path, bytes] of Object.entries(extraFiles)) writeFileSync(join(dir, path), bytes);
  const result = spawnSync(process.execPath, ['scripts/validate-content.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PERILUNE_MANIFEST_PATH: manifestPath,
      PERILUNE_RECIPES_PATH: recipesPath,
      PERILUNE_CHECKED_MANIFEST_PATH: checkedManifestPath,
    },
  });
  return Object.assign(result, { checkedManifestPath });
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

  it('keeps build ordering current and rejects checked-artifact paths outside public planets', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: { prebuild: string } };
    expect(packageJson.scripts.prebuild).toMatch(/^npm run validate:content && npm run sync:renderer-assets/);

    const dir = mkdtempSync(join(tmpdir(), 'perilune-sync-'));
    const artifactPath = join(dir, 'checked.json');
    writeFileSync(artifactPath, JSON.stringify({
      schemaVersion: 1,
      manifestSha256: 'a'.repeat(64),
      manifest: { packs: [{ channels: [{ packagePath: '../escape.ktx2', fallbackPath: 'safe.webp' }] }] },
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
    manifest.sources = [{
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
    }];
    expect(runValidator(manifest, asset).status).toBe(0);
    (manifest.sources[0] as { checksumSha256: string }).checksumSha256 = '0'.repeat(64);
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
    const packageBytes = ktx2Fixture(2048, 1024, 12);
    const fallbackBytes = new Uint8Array(12);
    const manifest = baseManifest();
    manifest.packs = [{
      bodyId: 'veyra',
      tier: 'medium',
      width: 2048,
      height: 1024,
      compressedBytes: packageBytes.byteLength,
      transientBytes: 1024,
      bootCritical: true,
      channels: [{
        name: 'albedo',
        colorSpace: 'sRGB',
        logicalFormat: 'RGB8',
        packagePath: 'veyra-albedo.ktx2',
        fallbackPath: 'veyra-albedo.webp',
        packageChecksumSha256: createHash('sha256').update(packageBytes).digest('hex'),
        fallbackChecksumSha256: createHash('sha256').update(fallbackBytes).digest('hex'),
        gpuFormat: 'bc1-rgb',
        gpuBytes: expectedGpuBytes,
        mipmapped: true,
      }],
    }];
    const files = {
      'veyra-albedo.ktx2': packageBytes,
      'veyra-albedo.webp': fallbackBytes,
    };
    expect(runValidator(manifest, undefined, files).status).toBe(0);

    const missing = runValidator(manifest);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/missing/i);

    (manifest.packs[0] as { channels: Array<{ gpuBytes: number }> }).channels[0].gpuBytes++;
    const wrongMemory = runValidator(manifest, undefined, files);
    expect(wrongMemory.status).not.toBe(0);
    expect(wrongMemory.stderr).toMatch(/memory/i);
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
    manifest.sources = [{
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
    }];
    expect(runValidator(manifest, asset).status).not.toBe(0);
    (manifest.sources[0] as { review?: unknown }).review = {
      thirdPartyContent: false,
      commercialUseReviewed: true,
      modificationReviewed: true,
      endorsementSafe: true,
      termsSnapshot: 'NASA media terms reviewed 2026-07-10',
    };
    expect(runValidator(manifest, asset).status).toBe(0);
  });
});
