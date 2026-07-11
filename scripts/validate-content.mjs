import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Bytes, sha256File } from './lib/canonical-json.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(
  process.env.PERILUNE_MANIFEST_PATH ?? resolve(root, 'assets/planets/manifest.json'),
);
const recipesPath = resolve(
  process.env.PERILUNE_RECIPES_PATH ?? resolve(root, 'assets/planets/recipes.json'),
);
const checkedManifestPath = resolve(
  process.env.PERILUNE_CHECKED_MANIFEST_PATH ?? resolve(root, 'src/generated/checked-planet-manifest.json'),
);
const compilerLockPath = resolve(root, 'tools/planet-assets/compiler-lock.json');
const packagePath = resolve(root, 'package.json');
const errors = [];
const ktx2Identifier = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

function loadJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    errors.push(`${label} could not be read: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${label} is required`);
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) errors.push(`${label} must be a non-negative integer`);
}

const manifest = loadJson(manifestPath, 'Planet manifest');
const recipeFile = loadJson(recipesPath, 'Terrain recipes');
const compilerLock = loadJson(compilerLockPath, 'Planet compiler lock');
const packageJson = loadJson(packagePath, 'package.json');

const expectedBodies = new Set([
  'auren', 'ashen', 'vess', 'veyra', 'palla', 'wisp',
  'rusk', 'tyran', 'brimm', 'glacia', 'mote', 'farfall',
]);

if (recipeFile) {
  if (recipeFile.schemaVersion !== 1) errors.push('Terrain recipes schemaVersion must be 1');
  if (!Array.isArray(recipeFile.recipes)) {
    errors.push('Terrain recipes must contain a recipes array');
  } else {
    const seen = new Set();
    for (const recipe of recipeFile.recipes) {
      requireString(recipe.bodyId, 'Recipe bodyId');
      if (!expectedBodies.has(recipe.bodyId)) errors.push(`Unknown recipe body ${recipe.bodyId}`);
      if (seen.has(recipe.bodyId)) errors.push(`Duplicate recipe body ${recipe.bodyId}`);
      seen.add(recipe.bodyId);
      if (!Number.isInteger(recipe.version) || recipe.version < 1) {
        errors.push(`Recipe ${recipe.bodyId} version must be a positive integer`);
      }
      if (!/^[a-f0-9]{32}$/.test(recipe.hash ?? '')) {
        errors.push(`Recipe ${recipe.bodyId} hash must be 32 lowercase hex characters`);
      }
    }
    for (const bodyId of expectedBodies) {
      if (!seen.has(bodyId)) errors.push(`Missing recipe for ${bodyId}`);
    }
  }
}

const allowedLicenses = new Set(['CC0-1.0', 'Public-Domain', 'CC-BY-4.0', 'NASA', 'JPL']);
const allowedChannels = new Set(['albedo', 'normal', 'material', 'clouds']);
const channelContracts = {
  albedo: { colorSpace: 'sRGB', logicalFormat: 'RGB8', fallback: '.webp' },
  normal: { colorSpace: 'linear', logicalFormat: 'RG8', fallback: '.png' },
  material: { colorSpace: 'linear', logicalFormat: 'RGBA8', fallback: '.png' },
  clouds: { colorSpace: 'linear', logicalFormat: 'RG8', fallback: '.png' },
};
const tierDimensions = {
  low: [1024, 512],
  medium: [2048, 1024],
  high: [4096, 2048],
  ultra: [8192, 4096],
};
const gpuFormats = {
  'bc1-rgb': { blockWidth: 4, blockHeight: 4, blockBytes: 8 },
  'bc3-rgba': { blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  'bc5-rg': { blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  'etc2-rgb': { blockWidth: 4, blockHeight: 4, blockBytes: 8 },
  'etc2-rgba': { blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  rgba8: { blockWidth: 1, blockHeight: 1, blockBytes: 4 },
  rgb8: { blockWidth: 1, blockHeight: 1, blockBytes: 3 },
  rg8: { blockWidth: 1, blockHeight: 1, blockBytes: 2 },
};

function fullMipChainBytes(width, height, format) {
  let total = 0;
  let mipWidth = width;
  let mipHeight = height;
  for (;;) {
    total += Math.ceil(mipWidth / format.blockWidth) *
      Math.ceil(mipHeight / format.blockHeight) * format.blockBytes;
    if (mipWidth === 1 && mipHeight === 1) return total;
    mipWidth = Math.max(1, Math.floor(mipWidth / 2));
    mipHeight = Math.max(1, Math.floor(mipHeight / 2));
  }
}

if (manifest) {
  if (manifest.schemaVersion !== 1) errors.push('Planet manifest schemaVersion must be 1');
  if (manifest.compiler?.platform !== 'linux/amd64') {
    errors.push('Compiler platform must be linux/amd64');
  }
  if (!/^node:\d+\.\d+\.\d+-bookworm-slim@sha256:[a-f0-9]{64}$/.test(
    manifest.compiler?.containerImage ?? '',
  )) {
    errors.push('Compiler containerImage must be an immutable Node bookworm-slim digest');
  }
  if (manifest.compiler?.compressionThreads !== 1) {
    errors.push('Compiler compressionThreads must be 1');
  }
  requireString(manifest.compiler?.nodeVersion, 'Compiler nodeVersion');
  requireString(manifest.compiler?.ktxSoftwareVersion, 'Compiler ktxSoftwareVersion');
  requireString(manifest.compiler?.ktxArchiveUrl, 'Compiler ktxArchiveUrl');
  if (!/^[a-f0-9]{64}$/.test(manifest.compiler?.ktxArchiveSha256 ?? '')) {
    errors.push('Compiler ktxArchiveSha256 must be SHA-256');
  }
  if (manifest.compiler?.imageLibraryVersion !== 'sharp@0.35.3') {
    errors.push('Compiler imageLibraryVersion must be sharp@0.35.3');
  }
  if (manifest.compiler?.resamplingKernel !== 'lanczos3') {
    errors.push('Compiler resamplingKernel must be lanczos3');
  }
  if (manifest.compiler?.albedoWorkingSpace !== 'srgb') {
    errors.push('Compiler albedoWorkingSpace must be srgb');
  }
  if (manifest.compiler?.dataWorkingSpace !== 'b-w') {
    errors.push('Compiler dataWorkingSpace must be b-w');
  }
  if (compilerLock) {
    for (const key of [
      'platform',
      'containerImage',
      'nodeVersion',
      'ktxSoftwareVersion',
      'ktxArchiveUrl',
      'ktxArchiveSha256',
      'compressionThreads',
      'imageLibraryVersion',
      'resamplingKernel',
      'albedoWorkingSpace',
      'dataWorkingSpace',
    ]) {
      const lockKey = key === 'imageLibraryVersion' ? 'sharpVersion' : key;
      const lockValue = key === 'imageLibraryVersion'
        ? `sharp@${compilerLock[lockKey]}`
        : compilerLock[lockKey];
      if (manifest.compiler?.[key] !== lockValue) {
        errors.push(`Compiler ${key} does not match compiler-lock.json`);
      }
    }
  }
  if (packageJson) {
    if (packageJson.devDependencies?.tsx !== compilerLock?.tsxVersion) {
      errors.push('Pinned tsx dependency does not match compiler-lock.json');
    }
    if (packageJson.devDependencies?.sharp !== compilerLock?.sharpVersion) {
      errors.push('Pinned sharp dependency does not match compiler-lock.json');
    }
  }

  const manifestDir = dirname(manifestPath);
  if (!Array.isArray(manifest.sources)) {
    errors.push('Manifest sources must be an array');
  } else {
    const ids = new Set();
    for (const source of manifest.sources) {
      requireString(source.id, 'Source id');
      if (ids.has(source.id)) errors.push(`Duplicate source id ${source.id}`);
      ids.add(source.id);
      requireString(source.url, `Source ${source.id} url`);
      requireString(source.author, `Source ${source.id} author`);
      requireString(source.license, `Source ${source.id} license`);
      if (!allowedLicenses.has(source.license)) {
        errors.push(`Source ${source.id} has rejected license ${source.license}`);
      }
      requireString(source.licenseUrl, `Source ${source.id} licenseUrl`);
      requireString(source.attribution, `Source ${source.id} attribution`);
      if (!/^[a-f0-9]{64}$/.test(source.checksumSha256 ?? '')) {
        errors.push(`Source ${source.id} checksum must be SHA-256`);
      }
      requireString(source.localPath, `Source ${source.id} localPath`);
      if (!Array.isArray(source.transformations) || source.transformations.length === 0) {
        errors.push(`Source ${source.id} transformations are required`);
      }
      if (!Array.isArray(source.bodies) || source.bodies.some((id) => !expectedBodies.has(id))) {
        errors.push(`Source ${source.id} bodies contain an unknown body`);
      }
      if (!Array.isArray(source.channels) || source.channels.some((name) => !allowedChannels.has(name))) {
        errors.push(`Source ${source.id} channels are invalid`);
      }
      if (source.license === 'NASA' || source.license === 'JPL') {
        const review = source.review;
        if (
          !review ||
          review.thirdPartyContent !== false ||
          review.commercialUseReviewed !== true ||
          review.modificationReviewed !== true ||
          review.endorsementSafe !== true ||
          typeof review.termsSnapshot !== 'string'
        ) {
          errors.push(`Source ${source.id} requires complete NASA/JPL case review`);
        }
      }
      const localPath = isAbsolute(source.localPath)
        ? source.localPath
        : resolve(manifestDir, source.localPath);
      if (!existsSync(localPath) && source.authoringOnly !== true) {
        errors.push(`Source ${source.id} local file is missing: ${localPath}`);
      } else if (existsSync(localPath) && /^[a-f0-9]{64}$/.test(source.checksumSha256 ?? '')) {
        const actual = sha256File(localPath);
        if (actual !== source.checksumSha256) {
          errors.push(`Source ${source.id} checksum mismatch: expected ${source.checksumSha256}, got ${actual}`);
        }
      }
      if (source.authoringOnly === true) {
        if (!Array.isArray(source.sourceDimensions) || source.sourceDimensions.length !== 2 ||
          source.sourceDimensions.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)) {
          errors.push(`Source ${source.id} authoring-only dimensions are required`);
        }
      }
    }
  }

  const budgets = manifest.budgets;
  requirePositiveInteger(budgets?.mediumBootTransferBytes, 'Medium boot transfer budget');
  requirePositiveInteger(budgets?.mediumPackTransferBytes, 'Medium pack transfer budget');
  for (const tier of ['low', 'medium', 'high']) {
    requirePositiveInteger(budgets?.activeBodyGpuBytes?.[tier], `${tier} active-body GPU budget`);
    requirePositiveInteger(budgets?.totalRendererGpuBytes?.[tier], `${tier} total renderer GPU budget`);
    requirePositiveInteger(budgets?.transientPeakBytes?.[tier], `${tier} transient peak budget`);
    requirePositiveInteger(budgets?.rendererBaseGpuBytes?.[tier], `${tier} renderer base GPU bytes`);
  }

  if (!Array.isArray(manifest.packs)) {
    errors.push('Manifest packs must be an array');
  } else {
    let mediumBootBytes = 0;
    for (const pack of manifest.packs) {
      if (!expectedBodies.has(pack.bodyId)) errors.push(`Pack has unknown body ${pack.bodyId}`);
      const dimensions = tierDimensions[pack.tier];
      if (!dimensions || pack.width !== dimensions[0] || pack.height !== dimensions[1]) {
        errors.push(`Pack ${pack.bodyId}/${pack.tier} has incorrect dimensions`);
      }
      requirePositiveInteger(pack.compressedBytes, `Pack ${pack.bodyId}/${pack.tier} compressedBytes`);
      requirePositiveInteger(pack.transientBytes, `Pack ${pack.bodyId}/${pack.tier} transientBytes`);
      if (pack.tier === 'medium') {
        if (pack.compressedBytes > budgets.mediumPackTransferBytes) {
          errors.push(`Pack ${pack.bodyId}/medium exceeds transfer budget`);
        }
        if (pack.bootCritical) mediumBootBytes += pack.compressedBytes;
      }
      if (!Array.isArray(pack.channels) || pack.channels.length === 0) {
        errors.push(`Pack ${pack.bodyId}/${pack.tier} has no channels`);
        continue;
      }
      let gpuBytes = 0;
      let packageBytes = 0;
      const names = new Set();
      for (const channel of pack.channels) {
        if (names.has(channel.name)) errors.push(`Pack ${pack.bodyId}/${pack.tier} duplicates ${channel.name}`);
        names.add(channel.name);
        const contract = channelContracts[channel.name];
        if (!contract) {
          errors.push(`Pack ${pack.bodyId}/${pack.tier} has unknown channel ${channel.name}`);
          continue;
        }
        if (channel.colorSpace !== contract.colorSpace || channel.logicalFormat !== contract.logicalFormat) {
          errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} violates channel format`);
        }
        if (!channel.packagePath?.endsWith('.ktx2')) {
          errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} package must be KTX2`);
        }
        if (!channel.fallbackPath?.endsWith(contract.fallback)) {
          errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} fallback has wrong format`);
        }
        if (channel.mipmapped !== true) {
          errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} requires mipmaps`);
        }
        requirePositiveInteger(channel.gpuBytes, `Pack ${pack.bodyId}/${pack.tier} ${channel.name} gpuBytes`);
        const gpuFormat = gpuFormats[channel.gpuFormat];
        if (!gpuFormat) {
          errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} has unknown GPU format`);
        } else if (dimensions) {
          const derivedGpuBytes = fullMipChainBytes(pack.width, pack.height, gpuFormat);
          if (channel.gpuBytes !== derivedGpuBytes) {
            errors.push(
              `Pack ${pack.bodyId}/${pack.tier} ${channel.name} memory mismatch: ` +
              `declared ${channel.gpuBytes}, derived ${derivedGpuBytes}`,
            );
          }
          gpuBytes += derivedGpuBytes;
        }
        for (const [kind, relativePath, checksum] of [
          ['package', channel.packagePath, channel.packageChecksumSha256],
          ['fallback', channel.fallbackPath, channel.fallbackChecksumSha256],
        ]) {
          if (!/^[a-f0-9]{64}$/.test(checksum ?? '')) {
            errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} ${kind} checksum must be SHA-256`);
          }
          if (typeof relativePath !== 'string' || !relativePath) continue;
          const assetPath = isAbsolute(relativePath) ? relativePath : resolve(manifestDir, relativePath);
          if (!existsSync(assetPath)) {
            errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} ${kind} is missing: ${assetPath}`);
          } else {
            if (kind === 'package') packageBytes += statSync(assetPath).size;
            if (kind === 'package') {
              const packageFile = readFileSync(assetPath);
              const identifier = packageFile.subarray(0, ktx2Identifier.length);
              if (!identifier.equals(ktx2Identifier)) {
                errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} package has no KTX2 identifier`);
              } else if (packageFile.byteLength < 48) {
                errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} package has a truncated KTX2 header`);
              } else {
                const pixelWidth = packageFile.readUInt32LE(20);
                const pixelHeight = packageFile.readUInt32LE(24);
                const levelCount = packageFile.readUInt32LE(40);
                if (pixelWidth !== pack.width || pixelHeight !== pack.height) {
                  errors.push(
                    `Pack ${pack.bodyId}/${pack.tier} ${channel.name} KTX2 dimensions ` +
                    `${pixelWidth}x${pixelHeight} do not match ${pack.width}x${pack.height}`,
                  );
                }
                if (levelCount <= 1) {
                  errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} KTX2 requires mip levels`);
                }
              }
            }
            if (/^[a-f0-9]{64}$/.test(checksum ?? '')) {
              const actualChecksum = sha256File(assetPath);
              if (actualChecksum !== checksum) {
                errors.push(
                  `Pack ${pack.bodyId}/${pack.tier} ${channel.name} ${kind} checksum mismatch: ` +
                  `expected ${checksum}, got ${actualChecksum}`,
                );
              }
            }
          }
        }
      }
      const gpuBudget = budgets?.activeBodyGpuBytes?.[pack.tier];
      if (Number.isInteger(gpuBudget) && gpuBytes > gpuBudget) {
        errors.push(`Pack ${pack.bodyId}/${pack.tier} exceeds active-body GPU budget`);
      }
      const transientBudget = budgets?.transientPeakBytes?.[pack.tier];
      if (Number.isInteger(transientBudget) && pack.transientBytes > transientBudget) {
        errors.push(`Pack ${pack.bodyId}/${pack.tier} exceeds transient memory budget`);
      }
      const totalRendererBudget = budgets?.totalRendererGpuBytes?.[pack.tier];
      const rendererBaseBytes = budgets?.rendererBaseGpuBytes?.[pack.tier];
      if (
        Number.isInteger(totalRendererBudget) &&
        Number.isInteger(rendererBaseBytes) &&
        rendererBaseBytes + gpuBytes > totalRendererBudget
      ) {
        errors.push(`Pack ${pack.bodyId}/${pack.tier} exceeds total renderer GPU budget`);
      }
      if (packageBytes !== pack.compressedBytes) {
        errors.push(
          `Pack ${pack.bodyId}/${pack.tier} compressed size mismatch: ` +
          `declared ${pack.compressedBytes}, packaged ${packageBytes}`,
        );
      }
    }
    if (mediumBootBytes > budgets.mediumBootTransferBytes) {
      errors.push('Medium boot-critical packs exceed transfer budget');
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`content validation: ${error}`);
  process.exitCode = 1;
} else {
  const artifact = {
    schemaVersion: 1,
    manifestSha256: sha256Bytes(canonicalJson(manifest)),
    manifest,
  };
  mkdirSync(dirname(checkedManifestPath), { recursive: true });
  writeFileSync(checkedManifestPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(
    `content validation passed: ${recipeFile.recipes.length} recipes, ` +
      `${manifest.sources.length} sources, ${manifest.packs.length} packs`,
  );
}
