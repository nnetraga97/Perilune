import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const BODY_IDS = [
  'auren', 'ashen', 'vess', 'veyra', 'palla', 'wisp',
  'rusk', 'tyran', 'brimm', 'glacia', 'mote', 'farfall',
];

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

  it('matches checked recipe hashes and raw height fingerprints', () => {
    const result = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'compile:planet-assets'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
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
    const packageBytes = new Uint8Array(10);
    const fallbackBytes = new Uint8Array(12);
    const manifest = baseManifest();
    manifest.packs = [{
      bodyId: 'veyra',
      tier: 'medium',
      width: 2048,
      height: 1024,
      compressedBytes: 10,
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
