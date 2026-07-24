import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, sha256Bytes, sha256File } from './lib/canonical-json.mjs';
import { validateCheckedPartManifest, validatePartAssetInputs } from './lib/part-asset-schema.mjs';
import { validatePlanetSourceLock } from './lib/planet-source-registry.mjs';

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
const compilerOutputPath = resolve(
  process.env.PERILUNE_COMPILER_OUTPUT_PATH ?? resolve(root, 'assets/planets/compiler-output.json'),
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
const compilerOutput = loadJson(compilerOutputPath, 'Planet compiler output');
const detailSourceLock = loadJson(
  resolve(root, 'assets/planets/sol-detail-source-lock.json'),
  'Sol detail source lock',
);

if (detailSourceLock) {
  for (const error of validatePlanetSourceLock(detailSourceLock)) {
    errors.push(`Sol detail source lock: ${error}`);
  }
}

const expectedRecipeBodies = new Set([
  'auren', 'ashen', 'vess', 'veyra', 'palla', 'wisp',
  'rusk', 'tyran', 'brimm', 'glacia', 'mote', 'farfall',
]);
const solBodyIds = Object.freeze(['sun', 'mercury', 'venus', 'earth', 'moon', 'mars']);
const solBodies = new Set(solBodyIds);
const scientificSurfaceBodies = new Set(solBodyIds.filter((bodyId) => bodyId !== 'sun'));
const expectedBodies = new Set([...expectedRecipeBodies, ...solBodies]);

if (recipeFile) {
  if (recipeFile.schemaVersion !== 1) errors.push('Terrain recipes schemaVersion must be 1');
  if (!Array.isArray(recipeFile.recipes)) {
    errors.push('Terrain recipes must contain a recipes array');
  } else {
    const seen = new Set();
    for (const recipe of recipeFile.recipes) {
      requireString(recipe.bodyId, 'Recipe bodyId');
      if (!expectedRecipeBodies.has(recipe.bodyId)) errors.push(`Unknown recipe body ${recipe.bodyId}`);
      if (seen.has(recipe.bodyId)) errors.push(`Duplicate recipe body ${recipe.bodyId}`);
      seen.add(recipe.bodyId);
      if (!Number.isInteger(recipe.version) || recipe.version < 1) {
        errors.push(`Recipe ${recipe.bodyId} version must be a positive integer`);
      }
      if (!/^[a-f0-9]{32}$/.test(recipe.hash ?? '')) {
        errors.push(`Recipe ${recipe.bodyId} hash must be 32 lowercase hex characters`);
      }
    }
    for (const bodyId of expectedRecipeBodies) {
      if (!seen.has(bodyId)) errors.push(`Missing recipe for ${bodyId}`);
    }
  }
}

const allowedLicenses = new Set(['CC0-1.0', 'Public-Domain', 'CC-BY-4.0', 'NASA', 'JPL', 'LGPL-3.0']);
const allowedChannels = new Set(['albedo', 'normal', 'material', 'clouds', 'heightMacro', 'emissive', 'localDetail', 'surfaceClass', 'surfaceClassRegional', 'photosphereActivity']);
const channelContracts = {
  albedo: {
    colorSpace: 'sRGB', logicalFormat: 'RGB8', fallback: '.webp', fallbackLayout: 'rgb',
    transcodeTargets: ['etc2-rgb', 'bc1-rgb'],
  },
  normal: {
    colorSpace: 'linear', logicalFormat: 'RG8', fallback: '.png', fallbackLayout: 'rgb-rg',
    transcodeTargets: ['etc2-rgba', 'bc5-rg', 'astc-rgba'],
  },
  material: {
    colorSpace: 'linear', logicalFormat: 'RGBA8', fallback: '.png', fallbackLayout: 'rgba',
    transcodeTargets: ['etc2-rgba', 'bc3-rgba', 'astc-rgba'],
  },
  clouds: {
    colorSpace: 'linear', logicalFormat: 'RG8', fallback: '.png', fallbackLayout: 'rgb-rg',
    transcodeTargets: ['etc2-rgba', 'bc5-rg', 'astc-rgba'],
  },
  heightMacro: {
    colorSpace: 'linear', logicalFormat: 'RG8', fallback: '.png', fallbackLayout: 'rgb-rg',
    transcodeTargets: ['rg8'],
  },
  emissive: {
    colorSpace: 'sRGB', logicalFormat: 'RGB8', fallback: '.webp', fallbackLayout: 'rgb',
    transcodeTargets: ['etc2-rgb', 'bc1-rgb'],
  },
  localDetail: {
    colorSpace: 'linear', logicalFormat: 'RGBA8', fallback: '.png', fallbackLayout: 'rgba',
    transcodeTargets: ['etc2-rgba', 'bc3-rgba', 'astc-rgba'],
  },
  surfaceClass: {
    colorSpace: 'linear', logicalFormat: 'R8', fallback: '.png', fallbackLayout: 'r',
    transcodeTargets: ['r8'], mipmapped: false,
  },
  surfaceClassRegional: {
    colorSpace: 'linear', logicalFormat: 'R8', fallback: '.png', fallbackLayout: 'r',
    transcodeTargets: ['r8'], mipmapped: false,
  },
  photosphereActivity: {
    colorSpace: 'linear', logicalFormat: 'R8', fallback: '.png', fallbackLayout: 'r',
    transcodeTargets: ['r8'],
  },
};
const exactPackChannelContracts = Object.freeze({
  veyra: Object.freeze(['albedo', 'normal', 'material', 'clouds']),
  moon: Object.freeze(['albedo', 'normal', 'material', 'heightMacro', 'localDetail']),
  mars: Object.freeze(['albedo']),
  mercury: Object.freeze(['albedo']),
  venus: Object.freeze(['albedo']),
  sun: Object.freeze(['photosphereActivity']),
});

function exactPackChannels(pack) {
  if (pack.bodyId === 'earth') {
    return [
      'albedo', 'normal', 'material', 'clouds', 'heightMacro', 'localDetail',
      'surfaceClass', 'surfaceClassRegional',
      ...(pack.tier === 'low' ? [] : ['emissive']),
    ];
  }
  return exactPackChannelContracts[pack.bodyId] ?? null;
}
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
  r8: { blockWidth: 1, blockHeight: 1, blockBytes: 1 },
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

function fullMipRgbaBytes(width, height) {
  let total = 0;
  for (;;) {
    total += width * height * 4;
    if (width === 1 && height === 1) return total;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
}

function arraysEqual(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function safeManifestAssetPath(manifestDir, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes('..') || /^[a-z][a-z\d+.-]*:/i.test(relativePath)) {
    errors.push(`${label} path must be a safe manifest-relative path`);
    return null;
  }
  return resolve(manifestDir, relativePath);
}

function fullMipLevelCount(width, height) {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

function readUint64(file, offset) {
  if (offset < 0 || offset + 8 > file.byteLength) return null;
  const value = file.readBigUInt64LE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function rangeWithinFile(offset, length, fileLength) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length) &&
    offset >= 0 && length >= 0 && offset <= fileLength && length <= fileLength - offset;
}

function rangesOverlap(leftOffset, leftLength, rightOffset, rightLength) {
  return leftOffset < rightOffset + rightLength && rightOffset < leftOffset + leftLength;
}

function validateKtx2(packageFile, pack, channel) {
  const label = `Pack ${pack.bodyId}/${pack.tier} ${channel.name} KTX2`;
  if (packageFile.byteLength < 80) {
    errors.push(`${label} has a truncated header`);
    return;
  }

  const vkFormat = packageFile.readUInt32LE(12);
  const typeSize = packageFile.readUInt32LE(16);
  const pixelWidth = packageFile.readUInt32LE(20);
  const pixelHeight = packageFile.readUInt32LE(24);
  const pixelDepth = packageFile.readUInt32LE(28);
  const layerCount = packageFile.readUInt32LE(32);
  const faceCount = packageFile.readUInt32LE(36);
  const levelCount = packageFile.readUInt32LE(40);
  const supercompressionScheme = packageFile.readUInt32LE(44);
  const channelWidth = channel.width ?? pack.width;
  const channelHeight = channel.height ?? pack.height;
  const classChannel = channel.name === 'surfaceClass' || channel.name === 'surfaceClassRegional';
  const r8Channel = classChannel || channel.name === 'photosphereActivity';
  const expectedLevels = classChannel ? 1 : fullMipLevelCount(channelWidth, channelHeight);

  if (pixelWidth !== channelWidth || pixelHeight !== channelHeight) {
    errors.push(`${label} dimensions ${pixelWidth}x${pixelHeight} do not match ${channelWidth}x${channelHeight}`);
  }
  const directHeight = channel.name === 'heightMacro';
  const expectedVkFormat = r8Channel ? 9 : directHeight ? 16 : 0; // VK_FORMAT_R8_UNORM / R8G8_UNORM
  if (vkFormat !== expectedVkFormat || typeSize !== 1 || pixelDepth !== 0 || layerCount !== 0 || faceCount !== 1) {
    errors.push(`${label} must be a 2D ${r8Channel ? 'lossless R8' : directHeight ? 'lossless RG8' : 'transcodable'} texture ` +
      `with vkFormat ${expectedVkFormat}, typeSize 1, and one face`);
  }
  if (levelCount !== expectedLevels) {
    errors.push(`${label} must contain exactly ${expectedLevels} mip levels, got ${levelCount}`);
  }

  const indexedLevels = Math.max(1, levelCount);
  const levelIndexEnd = 80 + indexedLevels * 24;
  if (!Number.isSafeInteger(levelIndexEnd) || packageFile.byteLength < levelIndexEnd) {
    errors.push(`${label} has a truncated level index`);
    return;
  }

  const dfdOffset = packageFile.readUInt32LE(48);
  const dfdLength = packageFile.readUInt32LE(52);
  const kvdOffset = packageFile.readUInt32LE(56);
  const kvdLength = packageFile.readUInt32LE(60);
  const sgdOffset = readUint64(packageFile, 64);
  const sgdLength = readUint64(packageFile, 72);
  const metadataRanges = [];

  if (dfdLength < 44 || dfdOffset < levelIndexEnd || !rangeWithinFile(dfdOffset, dfdLength, packageFile.byteLength)) {
    errors.push(`${label} DFD is outside package bounds or too short`);
  } else {
    metadataRanges.push([dfdOffset, dfdLength]);
    const dfdTotalSize = packageFile.readUInt32LE(dfdOffset);
    const descriptorVersion = packageFile.readUInt16LE(dfdOffset + 8);
    const descriptorBlockSize = packageFile.readUInt16LE(dfdOffset + 10);
    const colorModel = packageFile[dfdOffset + 12];
    const transferFunction = packageFile[dfdOffset + 14];
    const blockWidth = packageFile[dfdOffset + 16];
    const blockHeight = packageFile[dfdOffset + 17];
    const bytesPlane0 = packageFile[dfdOffset + 20];
    if (dfdTotalSize !== dfdLength || descriptorVersion !== 2 ||
      descriptorBlockSize < 40 || descriptorBlockSize > dfdLength - 4) {
      errors.push(`${label} DFD descriptor is malformed`);
    }
    const expectedEncoding = r8Channel
      ? { scheme: 2, model: 1, transfer: 1, bytesPlane: 1, blockWidth: 0, blockHeight: 0,
        name: 'lossless R8 with Zstd' }
      : directHeight
      ? { scheme: 2, model: 1, transfer: 1, bytesPlane: 2, blockWidth: 0, blockHeight: 0,
        name: 'lossless RG8 with Zstd' }
      : channel.name === 'albedo' || channel.name === 'emissive'
      ? { scheme: 1, model: 163, transfer: 2, bytesPlane: 8, name: 'BasisLZ with ETC1S' }
      : { scheme: 2, model: 166, transfer: 1, bytesPlane: 16, blockWidth: 3, blockHeight: 3,
        name: 'UASTC with Zstd' };
    if (supercompressionScheme !== expectedEncoding.scheme || colorModel !== expectedEncoding.model ||
      transferFunction !== expectedEncoding.transfer ||
      blockWidth !== (expectedEncoding.blockWidth ?? 3) ||
      blockHeight !== (expectedEncoding.blockHeight ?? 3) ||
      bytesPlane0 !== expectedEncoding.bytesPlane) {
      errors.push(`${label} ${channel.name} must use ${expectedEncoding.name} and its matching DFD`);
    }
  }

  if (kvdLength === 0) {
    if (kvdOffset !== 0) errors.push(`${label} KVD offset must be zero when its length is zero`);
  } else if (kvdOffset < levelIndexEnd || !rangeWithinFile(kvdOffset, kvdLength, packageFile.byteLength)) {
    errors.push(`${label} KVD is outside package bounds`);
  } else {
    metadataRanges.push([kvdOffset, kvdLength]);
  }

  if (sgdOffset === null || sgdLength === null) {
    errors.push(`${label} SGD uses an unsupported 64-bit range`);
  } else if (supercompressionScheme === 1) {
    if (sgdLength === 0 || sgdOffset < levelIndexEnd ||
      !rangeWithinFile(sgdOffset, sgdLength, packageFile.byteLength)) {
      errors.push(`${label} BasisLZ package requires in-bounds supercompression global data`);
    } else {
      metadataRanges.push([sgdOffset, sgdLength]);
    }
  } else if (sgdOffset !== 0 || sgdLength !== 0) {
    errors.push(`${label} Zstd package must not declare supercompression global data`);
  }

  for (let left = 0; left < metadataRanges.length; left++) {
    for (let right = left + 1; right < metadataRanges.length; right++) {
      if (rangesOverlap(...metadataRanges[left], ...metadataRanges[right])) {
        errors.push(`${label} metadata sections overlap`);
      }
    }
  }

  const levelRanges = [];
  for (let level = 0; level < indexedLevels; level++) {
    const indexOffset = 80 + level * 24;
    const byteOffset = readUint64(packageFile, indexOffset);
    const byteLength = readUint64(packageFile, indexOffset + 8);
    const uncompressedByteLength = readUint64(packageFile, indexOffset + 16);
    if (byteOffset === null || byteLength === null || uncompressedByteLength === null ||
      byteLength === 0 || byteOffset < levelIndexEnd ||
      !rangeWithinFile(byteOffset, byteLength, packageFile.byteLength)) {
      errors.push(`${label} mip ${level} payload is outside package bounds or empty`);
      continue;
    }
    if (metadataRanges.some(([offset, length]) => rangesOverlap(byteOffset, byteLength, offset, length)) ||
      levelRanges.some(([offset, length]) => rangesOverlap(byteOffset, byteLength, offset, length))) {
      errors.push(`${label} mip ${level} payload overlaps another KTX2 section`);
    }
    if (supercompressionScheme === 1 && uncompressedByteLength !== 0) {
      errors.push(`${label} BasisLZ mip ${level} must use zero uncompressedByteLength`);
    }
    if (supercompressionScheme === 2) {
      const mipWidth = Math.max(1, channelWidth >> level);
      const mipHeight = Math.max(1, channelHeight >> level);
      const expectedUncompressedBytes = r8Channel
        ? mipWidth * mipHeight
        : directHeight
        ? mipWidth * mipHeight * 2
        : Math.ceil(mipWidth / 4) * Math.ceil(mipHeight / 4) * 16;
      if (uncompressedByteLength !== expectedUncompressedBytes) {
        errors.push(
          `${label} mip ${level} uncompressed size ${uncompressedByteLength} ` +
          `does not match ${expectedUncompressedBytes}`,
        );
      }
    }
    levelRanges.push([byteOffset, byteLength]);
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
      const scientificSource = Array.isArray(source.bodies) &&
        source.bodies.some((bodyId) => scientificSurfaceBodies.has(bodyId));
      if (scientificSource) {
        for (const field of [
          'datum', 'verticalDatum', 'projection', 'axisOrder', 'longitudeDirection',
          'uvOrigin', 'observation', 'productKind', 'derivedRecipe', 'bodyReferenceFrameVersion',
        ]) requireString(source[field], `Source ${source.id} ${field}`);
        if (!Number.isFinite(source.seamLongitudeDegrees) || source.seamLongitudeDegrees < -180 ||
          source.seamLongitudeDegrees > 180) {
          errors.push(`Source ${source.id} seamLongitudeDegrees must be within [-180, 180]`);
        }
        if (!Number.isFinite(source.valueScale) || !Number.isFinite(source.valueOffset)) {
          errors.push(`Source ${source.id} value scale and offset must be finite`);
        }
        if (source.noDataValue !== null && !Number.isFinite(source.noDataValue)) {
          errors.push(`Source ${source.id} noDataValue must be null or finite`);
        }
        if (!Array.isArray(source.validRange) || source.validRange.length !== 2 ||
          !source.validRange.every(Number.isFinite) || source.validRange[0] >= source.validRange[1]) {
          errors.push(`Source ${source.id} validRange must be increasing and finite`);
        }
        if (!['measured', 'modeled', 'composited'].includes(source.productKind)) {
          errors.push(`Source ${source.id} productKind is invalid`);
        }
        if (source.longitudeDirection !== 'east-positive' || source.axisOrder !== 'longitude,latitude') {
          errors.push(`Source ${source.id} must map explicitly into east-positive longitude/latitude order`);
        }
      }
    }
  }

  const canonicalHeights = Array.isArray(manifest.canonicalArtifacts)
    ? manifest.canonicalArtifacts.filter(
      (artifact) => artifact?.bodyId === 'veyra' && artifact?.kind === 'height-s16le',
    )
    : [];
  if (canonicalHeights.length !== 1) {
    errors.push(`Manifest must contain exactly one Veyra canonical height artifact, got ${canonicalHeights.length}`);
  } else {
    const artifact = canonicalHeights[0];
    const veyraRecipe = recipeFile?.recipes?.find((recipe) => recipe.bodyId === 'veyra');
    const source = Array.isArray(manifest.sources)
      ? manifest.sources.find((candidate) => candidate.checksumSha256 === artifact.sourceChecksumSha256)
      : undefined;
    const outputCanonical = compilerOutput?.veyraCanonical;
    const outputHeight = outputCanonical?.heightArtifact;
    const dimensionsValid = Number.isInteger(artifact.width) && artifact.width > 0 &&
      Number.isInteger(artifact.height) && artifact.height > 0;
    if (!dimensionsValid) errors.push('Veyra canonical height dimensions must be positive integers');
    if (artifact.quantizationMeters !== 0.5 || artifact.offsetMeters !== 0 || artifact.byteOrder !== 'little-endian') {
      errors.push('Veyra canonical height must use 0.5 meter signed-16 little-endian quantization with zero offset');
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.checksumSha256 ?? '')) {
      errors.push('Veyra canonical height checksum must be SHA-256');
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.identitySha256 ?? '')) {
      errors.push('Veyra canonical identity must be SHA-256');
    }
    if (!veyraRecipe || artifact.recipeHash !== veyraRecipe.hash) {
      errors.push('Veyra canonical height recipe identity does not match recipes.json');
    }
    if (!source) errors.push('Veyra canonical height source checksum is not declared in manifest sources');
    if (artifact.compilerVersion !== compilerOutput?.compilerVersion ||
      artifact.containerImage !== manifest.compiler?.containerImage) {
      errors.push('Veyra canonical height compiler identity does not match compiler output and manifest');
    }

    const artifactPath = safeManifestAssetPath(
      manifestDir,
      artifact.path,
      'Veyra canonical height',
    );
    if (artifactPath && !existsSync(artifactPath)) {
      errors.push(`Veyra canonical height is missing: ${artifactPath}`);
    } else if (artifactPath) {
      const expectedLength = dimensionsValid ? artifact.width * artifact.height * 2 : NaN;
      const actualLength = statSync(artifactPath).size;
      if (!Number.isSafeInteger(expectedLength) || actualLength !== expectedLength) {
        errors.push(
          `Veyra canonical height byte length mismatch: expected ${expectedLength}, got ${actualLength}`,
        );
      }
      if (/^[a-f0-9]{64}$/.test(artifact.checksumSha256 ?? '')) {
        const actualChecksum = sha256File(artifactPath);
        if (actualChecksum !== artifact.checksumSha256) {
          errors.push(
            `Veyra canonical height checksum mismatch: expected ${artifact.checksumSha256}, got ${actualChecksum}`,
          );
        }
      }
    }

    const rawHashes = outputCanonical?.rawHashes;
    const orderedRawHashes = rawHashes && {
      albedo: rawHashes.albedo,
      normal: rawHashes.normal,
      material: rawHashes.material,
      clouds: rawHashes.clouds,
    };
    if (!orderedRawHashes || Object.values(orderedRawHashes).some((hash) => !/^[a-f0-9]{64}$/.test(hash ?? ''))) {
      errors.push('Planet compiler output must contain four canonical Veyra raw channel hashes');
    }
    const expectedIdentity = orderedRawHashes && veyraRecipe
      ? sha256Bytes(JSON.stringify([
        compilerOutput.compilerVersion,
        manifest.compiler?.containerImage,
        manifest.compiler?.ktxSoftwareVersion,
        manifest.compiler?.ktxArchiveSha256,
        artifact.sourceChecksumSha256,
        veyraRecipe.version,
        veyraRecipe.hash,
        artifact.width,
        artifact.height,
        artifact.quantizationMeters,
        orderedRawHashes,
        artifact.checksumSha256,
      ]))
      : null;
    if (expectedIdentity !== artifact.identitySha256 || outputCanonical?.identitySha256 !== artifact.identitySha256) {
      errors.push('Veyra canonical identity mismatch between manifest, compiler inputs, and compiler output');
    }
    if (outputCanonical?.width !== artifact.width || outputCanonical?.height !== artifact.height ||
      outputHeight?.path !== artifact.path || outputHeight?.checksumSha256 !== artifact.checksumSha256 ||
      outputHeight?.quantizationMeters !== artifact.quantizationMeters ||
      outputHeight?.byteOrder !== artifact.byteOrder) {
      errors.push('Veyra canonical height metadata does not match compiler output');
    }
  }

  validateScatterArtifact(manifest, compilerOutput, recipeFile, manifestDir);
}

/**
 * Validate the canonical physical-scatter artifact: byte-identical asset/runtime
 * copies, checksums, recipe linkage, sorted-unique cells and record ids, cell
 * ownership, and ocean exclusion. Content-hash equality is proven separately by
 * the scatter-recipe unit test through the shared parser.
 */
function validateScatterArtifact(manifest, compilerOutput, recipeFile, manifestDir) {
  const scatters = Array.isArray(manifest.canonicalArtifacts)
    ? manifest.canonicalArtifacts.filter(
      (artifact) => artifact?.bodyId === 'veyra' && artifact?.kind === 'physical-scatter',
    )
    : [];
  if (scatters.length !== 1) {
    errors.push(`Manifest must contain exactly one Veyra physical-scatter artifact, got ${scatters.length}`);
    return;
  }
  const artifact = scatters[0];
  const veyraRecipe = recipeFile?.recipes?.find((recipe) => recipe.bodyId === 'veyra');
  const output = compilerOutput?.veyraScatter;
  if (artifact.cellResolution !== 32) errors.push('Veyra scatter cell resolution must be 32');
  requirePositiveInteger(artifact.recordCount, 'Veyra scatter record count');
  requirePositiveInteger(artifact.cellCount, 'Veyra scatter cell count');
  if (!/^[a-f0-9]{32}$/.test(artifact.scatterRecipeHash ?? '')) {
    errors.push('Veyra scatter recipe hash must be 32 hex');
  }
  if (!veyraRecipe || artifact.terrainRecipeHash !== veyraRecipe.hash) {
    errors.push('Veyra scatter terrain-recipe linkage does not match recipes.json');
  }
  if (artifact.scatterRecipeHash === artifact.terrainRecipeHash) {
    errors.push('Veyra scatter recipe hash must be distinct from the terrain recipe hash');
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.checksumSha256 ?? '')) {
    errors.push('Veyra scatter checksum must be SHA-256');
  }
  if (!output || output.scatterRecipeHash !== artifact.scatterRecipeHash ||
    output.terrainRecipeHash !== artifact.terrainRecipeHash ||
    output.recordCount !== artifact.recordCount || output.cellCount !== artifact.cellCount ||
    output.cellResolution !== artifact.cellResolution || output.checksumSha256 !== artifact.checksumSha256 ||
    output.path !== artifact.path || output.runtimePath !== artifact.runtimePath) {
    errors.push('Veyra scatter metadata does not match compiler output');
  }

  const runtimeRoot = process.env.PERILUNE_ROOT ? resolve(process.env.PERILUNE_ROOT) : root;
  const assetPath = safeManifestAssetPath(manifestDir, artifact.path, 'Veyra scatter');
  const runtimePath = typeof artifact.runtimePath === 'string' && !isAbsolute(artifact.runtimePath)
    ? resolve(runtimeRoot, artifact.runtimePath)
    : null;
  if (!runtimePath) errors.push('Veyra scatter runtime path must be a repo-relative path');
  if (!assetPath || !existsSync(assetPath)) {
    errors.push('Veyra scatter canonical artifact is missing');
    return;
  }
  if (!runtimePath || !existsSync(runtimePath)) {
    errors.push('Veyra scatter runtime artifact is missing');
    return;
  }
  const assetBytes = readFileSync(assetPath);
  const runtimeBytes = readFileSync(runtimePath);
  if (!assetBytes.equals(runtimeBytes)) {
    errors.push('Veyra scatter asset and runtime copies are not byte-identical');
  }
  if (/^[a-f0-9]{64}$/.test(artifact.checksumSha256 ?? '')) {
    const actual = sha256File(assetPath);
    if (actual !== artifact.checksumSha256) {
      errors.push(`Veyra scatter checksum mismatch: expected ${artifact.checksumSha256}, got ${actual}`);
    }
  }

  let recipe;
  try {
    recipe = JSON.parse(assetBytes.toString('utf8'));
  } catch (error) {
    errors.push(`Veyra scatter JSON could not be parsed: ${error instanceof Error ? error.message : error}`);
    return;
  }
  if (recipe.formatVersion !== 1 || recipe.bodyId !== 'veyra') {
    errors.push('Veyra scatter artifact header is invalid');
  }
  if (recipe.terrainRecipeHash !== artifact.terrainRecipeHash || recipe.hash !== artifact.scatterRecipeHash) {
    errors.push('Veyra scatter artifact hashes do not match the manifest');
  }
  if (!Array.isArray(recipe.cells)) {
    errors.push('Veyra scatter cells must be an array');
    return;
  }
  const seenIds = new Set();
  let previousCellKey = -1;
  let totalRecords = 0;
  for (const cell of recipe.cells) {
    if (![cell.face, cell.cx, cell.cy].every((value) => Number.isInteger(value)) ||
      cell.face < 0 || cell.face > 5 || cell.cx < 0 || cell.cx >= 32 || cell.cy < 0 || cell.cy >= 32) {
      errors.push('Veyra scatter cell coordinates are out of range');
      break;
    }
    const cellKey = (cell.face * 32 + cell.cx) * 32 + cell.cy;
    if (cellKey <= previousCellKey) {
      errors.push('Veyra scatter cells must be sorted and unique');
      break;
    }
    previousCellKey = cellKey;
    if (!Array.isArray(cell.records) || cell.records.length === 0) {
      errors.push('Veyra scatter cells must hold at least one record');
      break;
    }
    let previousId = '';
    for (const record of cell.records) {
      totalRecords++;
      if (!/^[a-f0-9]{16}$/.test(record.id ?? '')) { errors.push('Veyra scatter record id must be 16 hex'); break; }
      if (seenIds.has(record.id)) { errors.push(`Duplicate Veyra scatter record id ${record.id}`); break; }
      if (record.id <= previousId) { errors.push('Veyra scatter records must be sorted by id'); break; }
      seenIds.add(record.id);
      previousId = record.id;
      if (!Number.isInteger(record.biome) || record.biome < 1) {
        errors.push('Veyra scatter must never place obstacles in the ocean');
        break;
      }
      if (!['sphere', 'capsule', 'compound-sphere'].includes(record.proxy)) {
        errors.push('Veyra scatter proxy kind is invalid');
        break;
      }
    }
  }
  if (totalRecords !== recipe.recordCount || recipe.recordCount !== artifact.recordCount) {
    errors.push('Veyra scatter record count does not match the artifact');
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
    const hasSolContent = manifest.packs.some((pack) => solBodies.has(pack.bodyId)) ||
      (Array.isArray(manifest.sources) && manifest.sources.some((source) =>
        Array.isArray(source.bodies) && source.bodies.some((bodyId) => solBodies.has(bodyId))));
    for (const tier of ['low', 'medium', 'high']) {
      for (const bodyId of ['veyra', ...(hasSolContent ? solBodyIds : [])]) {
        const count = manifest.packs.filter((pack) => pack.bodyId === bodyId && pack.tier === tier).length;
        if (count !== 1) errors.push(`Manifest must contain exactly one ${bodyId} ${tier} pack, got ${count}`);
      }
    }
    let mediumBootBytes = 0;
    const worstCaseByTierAndBody = new Map();
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
      const exactChannels = exactPackChannels(pack);
      if (exactChannels) {
        const presentChannels = Array.isArray(pack.channels) ? pack.channels.map((channel) => channel.name) : [];
        if (presentChannels.length !== exactChannels.length ||
          exactChannels.some((channelName) => !presentChannels.includes(channelName))) {
          errors.push(`Pack ${pack.bodyId}/${pack.tier} must have exact channels ${exactChannels.join(', ')}`);
        }
      }
      if (!Array.isArray(pack.channels) || pack.channels.length === 0) {
        errors.push(`Pack ${pack.bodyId}/${pack.tier} has no channels`);
        continue;
      }
      let gpuBytes = 0;
      let fallbackGpuBytes = 0;
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
        const channelWidth = channel.width ?? pack.width;
        const channelHeight = channel.height ?? pack.height;
        const classChannel = channel.name === 'surfaceClass' || channel.name === 'surfaceClassRegional';
        const r8Channel = classChannel || channel.name === 'photosphereActivity';
        const derivedFallbackGpuBytes = dimensions
          ? classChannel ? channelWidth * channelHeight : fullMipRgbaBytes(channelWidth, channelHeight)
          : null;
        if (channel.fallbackGpuBytes !== derivedFallbackGpuBytes) {
          errors.push(
            `Pack ${pack.bodyId}/${pack.tier} ${channel.name} fallback memory mismatch: ` +
            `declared ${channel.fallbackGpuBytes}, derived ${derivedFallbackGpuBytes}`,
          );
        } else {
          fallbackGpuBytes += derivedFallbackGpuBytes;
        }
        if (channel.fallbackLayout !== contract.fallbackLayout) {
          errors.push(
            `Pack ${pack.bodyId}/${pack.tier} ${channel.name} fallback layout must be ` +
            contract.fallbackLayout,
          );
        }
        if (!arraysEqual(channel.transcodeTargets, contract.transcodeTargets)) {
          errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} has incorrect transcode targets`);
        }
        if (channel.mipmapped !== (contract.mipmapped ?? true)) {
          errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} has incorrect mip policy`);
        }
        requirePositiveInteger(channel.gpuBytes, `Pack ${pack.bodyId}/${pack.tier} ${channel.name} gpuBytes`);
        const gpuFormat = gpuFormats[channel.gpuFormat];
        if (!gpuFormat) {
          errors.push(`Pack ${pack.bodyId}/${pack.tier} ${channel.name} has unknown GPU format`);
        } else if (dimensions) {
          const derivedGpuBytes = r8Channel
            ? (classChannel ? channelWidth * channelHeight : fullMipChainBytes(channelWidth, channelHeight, gpuFormat))
            : fullMipChainBytes(channelWidth, channelHeight, gpuFormat);
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
              } else {
                validateKtx2(packageFile, pack, channel);
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
      const worstCaseGpuBytes = Math.max(gpuBytes, fallbackGpuBytes);
      worstCaseByTierAndBody.set(`${pack.tier}/${pack.bodyId}`, worstCaseGpuBytes);
      if (Number.isInteger(gpuBudget) && worstCaseGpuBytes > gpuBudget) {
        errors.push(`Pack ${pack.bodyId}/${pack.tier} fallback/compressed path exceeds active-body GPU budget`);
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
        rendererBaseBytes + worstCaseGpuBytes > totalRendererBudget
      ) {
        errors.push(`Pack ${pack.bodyId}/${pack.tier} fallback/compressed path exceeds total renderer GPU budget`);
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
    for (const tier of hasSolContent ? ['low', 'medium', 'high'] : []) {
      const combinedSolPackBytes = solBodyIds.reduce(
        (sum, bodyId) => sum + (worstCaseByTierAndBody.get(`${tier}/${bodyId}`) ?? 0),
        0,
      );
      const combinedSolBytes = combinedSolPackBytes + (budgets.rendererBaseGpuBytes?.[tier] ?? 0);
      if (Number.isInteger(budgets.totalRendererGpuBytes?.[tier]) &&
        combinedSolBytes > budgets.totalRendererGpuBytes[tier]) {
        errors.push(`Combined Sol ${tier} renderer assets exceed total renderer GPU budget`);
      }
    }
  }
  if (manifest.numericAuthorities !== undefined && !Array.isArray(manifest.numericAuthorities)) {
    errors.push('Planet manifest numericAuthorities must be an array when present');
  } else {
    for (const authority of manifest.numericAuthorities ?? []) {
      requireString(authority.bodyId, 'Numeric authority bodyId');
      requireString(authority.datasetId, 'Numeric authority datasetId');
      requireString(authority.version, 'Numeric authority version');
      requirePositiveInteger(authority.byteLength, 'Numeric authority byteLength');
      const authorityPath = safeManifestAssetPath(dirname(manifestPath), authority.path, 'Numeric authority');
      if (authorityPath && !existsSync(authorityPath)) errors.push(`Numeric authority is missing: ${authorityPath}`);
      if (authorityPath && existsSync(authorityPath)) {
        if (statSync(authorityPath).size !== authority.byteLength) errors.push(`Numeric authority byte length changed: ${authority.path}`);
        if (sha256File(authorityPath) !== authority.sha256) errors.push(`Numeric authority checksum changed: ${authority.path}`);
      }
    }
  }
}

errors.push(...validatePartAssetInputs(root));
errors.push(...validateCheckedPartManifest(root));

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
