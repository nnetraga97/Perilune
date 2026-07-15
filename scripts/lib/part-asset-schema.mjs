import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { canonicalJson, sha256Bytes } from './canonical-json.mjs';

export { canonicalJson } from './canonical-json.mjs';

export const PART_ASSET_BUDGET_CEILINGS = Object.freeze({
  totalTriangleLimit: 64_000,
  totalTransferBytes: 6 * 1024 * 1024,
  totalGpuBytes: 32 * 1024 * 1024,
});

export const REFERENCE_CRAFT_TRIANGLE_LIMIT = 70_000;

const PART_TEXTURE_LIMITS = Object.freeze({
  'pod-voyager': 1024,
  'leg-lander': 512,
  'eng-colt': 512,
  'ant-dish': 512,
  'wheel-mesa': 512,
  'eng-mule': 512,
  'tank-s4': 1024,
  'chute-main': 512,
  'tank-m4': 512,
  'tank-s2': 512,
  'dec-interstage-ms': 512,
  'fin-rudder': 512,
  'fin-swift': 512,
  'dec-radial': 512,
  'srb-torch': 512,
  'nose-s': 512,
});

const SCOPED_PART_IDS = new Set(Object.keys(PART_TEXTURE_LIMITS));

const REFERENCE_CRAFT_COPIES = Object.freeze({
  'pod-voyager': 1,
  'eng-colt': 1,
  'eng-mule': 1,
  'tank-m4': 2,
  'tank-s2': 1,
  'dec-interstage-ms': 1,
  'fin-rudder': 4,
  'fin-swift': 4,
  'dec-radial': 2,
  'srb-torch': 2,
  'nose-s': 2,
});

const SHA256 = /^[a-f0-9]{64}$/;
const HTTPS = /^https:\/\//;
const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} could not be read: ${error instanceof Error ? error.message : error}`);
  }
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value) || value.includes('\\')) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function requireIdentifier(value, label, errors) {
  if (typeof value !== 'string' || !identifier.test(value)) errors.push(`${label} must be a kebab-case identifier`);
}

function requireString(value, label, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) errors.push(`${label} is required`);
}

function requireHttps(value, label, errors) {
  if (typeof value !== 'string' || !HTTPS.test(value)) errors.push(`${label} must use HTTPS`);
  else {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') errors.push(`${label} must use HTTPS`);
    } catch {
      errors.push(`${label} must be a valid URL`);
    }
  }
}

function requireSha256(value, label, errors) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    errors.push(`${label} must be 64 lowercase hexadecimal characters`);
  }
}

function requirePositiveInteger(value, label, errors) {
  if (!Number.isSafeInteger(value) || value <= 0) errors.push(`${label} must be a positive integer`);
}

function requireNonNegativeInteger(value, label, errors) {
  if (!Number.isSafeInteger(value) || value < 0) errors.push(`${label} must be a non-negative integer`);
}

function validateVector(value, size, label, errors) {
  if (!Array.isArray(value) || value.length !== size || value.some((number) => !Number.isFinite(number))) {
    errors.push(`${label} must contain ${size} finite numbers`);
    return false;
  }
  return true;
}

function validateBounds(min, max, label, errors) {
  const validMin = validateVector(min, 3, `${label} min`, errors);
  const validMax = validateVector(max, 3, `${label} max`, errors);
  if (validMin && validMax && min.some((number, index) => number >= max[index])) {
    errors.push(`${label} min must be less than max on every axis`);
  }
}

function validateAnchors(anchors, label, errors) {
  if (!Array.isArray(anchors)) {
    errors.push(`${label} must be an array`);
    return;
  }
  anchors.forEach((anchor, index) => {
    const anchorLabel = `${label}[${index}]`;
    validateVector(anchor?.position, 3, `${anchorLabel} position`, errors);
    validateVector(anchor?.rotation, 4, `${anchorLabel} rotation`, errors);
    if (!Number.isFinite(anchor?.scale) || anchor.scale <= 0) errors.push(`${anchorLabel} scale must be positive`);
  });
}

function validateBudgets(budgets, errors) {
  if (!budgets || typeof budgets !== 'object' || Array.isArray(budgets)) {
    errors.push('Part recipes budgets are required');
    return;
  }
  for (const [name, ceiling] of Object.entries(PART_ASSET_BUDGET_CEILINGS)) {
    requirePositiveInteger(budgets[name], `Part recipes budgets.${name}`, errors);
    if (Number.isSafeInteger(budgets[name]) && budgets[name] > ceiling) {
      errors.push(`Part recipes budgets.${name} exceeds the approved ceiling ${ceiling}`);
    }
  }
}

function validateRecipe(recipe, sourceIds, errors) {
  const label = `Part recipe ${recipe?.assetId ?? '<unknown>'}`;
  requireIdentifier(recipe?.assetId, `${label} assetId`, errors);
  requireIdentifier(recipe?.partId, `${label} partId`, errors);
  if (typeof recipe?.partId === 'string' && !SCOPED_PART_IDS.has(recipe.partId)) {
    errors.push(`${label} partId ${recipe.partId} is not one of the eight scoped part IDs`);
  }

  const recipeSourceIds = Array.isArray(recipe?.sourceIds)
    ? recipe.sourceIds
    : typeof recipe?.sourceId === 'string' ? [recipe.sourceId] : [];
  const authoredInProject = recipe?.authoredInProject === true;
  if (recipeSourceIds.length === 0 && !authoredInProject) {
    errors.push(`${label} must reference at least one sourceId or declare authoredInProject`);
  }
  if (recipeSourceIds.length > 0 && authoredInProject) {
    errors.push(`${label} cannot combine sourceIds with authoredInProject`);
  }
  for (const sourceId of recipeSourceIds) {
    requireIdentifier(sourceId, `${label} sourceId`, errors);
    if (!sourceIds.has(sourceId)) errors.push(`${label} references unknown sourceId ${sourceId}`);
  }

  for (const [key, value] of Object.entries(recipe ?? {})) {
    if (key.endsWith('Path') && !isSafeRelativePath(value)) errors.push(`${label} ${key} must be a safe relative path`);
  }
  requirePositiveInteger(recipe?.triangleLimit, `${label} triangleLimit`, errors);
  requirePositiveInteger(recipe?.textureMaxDimension, `${label} textureMaxDimension`, errors);
  const textureLimit = PART_TEXTURE_LIMITS[recipe?.partId];
  if (textureLimit !== undefined && Number.isSafeInteger(recipe?.textureMaxDimension) &&
    recipe.textureMaxDimension > textureLimit) {
    errors.push(`${label} textureMaxDimension exceeds the ${textureLimit} limit for ${recipe.partId}`);
  }
  validateBounds(recipe?.visualBounds?.min, recipe?.visualBounds?.max, `${label} visualBounds`, errors);
  validateAnchors(recipe?.plumeAnchors, `${label} plumeAnchors`, errors);
  if (recipe?.animationPolicy !== undefined && recipe.animationPolicy !== 'none') {
    errors.push(`${label} animationPolicy must be "none" when provided`);
  }
}

export function validatePartAssetDocuments(sources, recipes) {
  const errors = [];
  if (sources?.schemaVersion !== 1) errors.push('Part sources schemaVersion must be 1');
  if (recipes?.schemaVersion !== 1) errors.push('Part recipes schemaVersion must be 1');

  const sourceIds = new Set();
  if (!Array.isArray(sources?.sources)) {
    errors.push('Part sources must contain a sources array');
  } else {
    for (const source of sources.sources) {
      const label = `Part source ${source?.sourceId ?? '<unknown>'}`;
      requireIdentifier(source?.sourceId, `${label} sourceId`, errors);
      if (sourceIds.has(source?.sourceId)) errors.push(`Duplicate part sourceId ${source.sourceId}`);
      sourceIds.add(source?.sourceId);
      requireHttps(source?.url, `${label} url`, errors);
      requireSha256(source?.sha256, `${label} sha256`, errors);
      if (!isSafeRelativePath(source?.localPath)) errors.push(`${label} localPath must be a safe relative path`);
      requireString(source?.author, `${label} author`, errors);
      requireHttps(source?.assetPageUrl, `${label} assetPageUrl`, errors);
      requireHttps(source?.usageUrl, `${label} usageUrl`, errors);
    }
  }

  validateBudgets(recipes?.budgets, errors);
  if (!Array.isArray(recipes?.models)) {
    errors.push('Part recipes must contain a models array');
  } else {
    const assetIds = new Set();
    const partIds = new Set();
    let triangleLimit = 0;
    let referenceCraftTriangleLimit = 0;
    for (const recipe of recipes.models) {
      validateRecipe(recipe, sourceIds, errors);
      if (assetIds.has(recipe?.assetId)) errors.push(`Duplicate part assetId ${recipe.assetId}`);
      assetIds.add(recipe?.assetId);
      if (partIds.has(recipe?.partId)) errors.push(`Duplicate partId assignment ${recipe.partId}`);
      partIds.add(recipe?.partId);
      if (Number.isSafeInteger(recipe?.triangleLimit) && recipe.triangleLimit > 0) {
        triangleLimit += recipe.triangleLimit;
        referenceCraftTriangleLimit += recipe.triangleLimit * (REFERENCE_CRAFT_COPIES[recipe?.partId] ?? 0);
      }
    }
    if (triangleLimit > PART_ASSET_BUDGET_CEILINGS.totalTriangleLimit) {
      errors.push(`Part recipe triangle limits exceed the approved total ceiling ${PART_ASSET_BUDGET_CEILINGS.totalTriangleLimit}`);
    }
    if (referenceCraftTriangleLimit > REFERENCE_CRAFT_TRIANGLE_LIMIT) {
      errors.push(
        `Part recipe triangle limits exceed the approved reference craft ceiling ` +
        `${REFERENCE_CRAFT_TRIANGLE_LIMIT}`,
      );
    }
  }
  return errors;
}

export function loadPartAssetInputs(root) {
  return {
    sources: readJson(resolve(root, 'assets/parts/sources.json'), 'Part sources'),
    recipes: readJson(resolve(root, 'assets/parts/recipes.json'), 'Part recipes'),
  };
}

export function validatePartAssetInputs(root) {
  try {
    const { sources, recipes } = loadPartAssetInputs(root);
    return validatePartAssetDocuments(sources, recipes);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function validateCheckedModel(model, recipeByAssetId, errors) {
  const label = `Checked part model ${model?.assetId ?? '<unknown>'}`;
  requireIdentifier(model?.assetId, `${label} assetId`, errors);
  requireIdentifier(model?.partId, `${label} partId`, errors);
  if (typeof model?.partId === 'string' && !SCOPED_PART_IDS.has(model.partId)) {
    errors.push(`${label} partId ${model.partId} is not one of the eight scoped part IDs`);
  }
  const recipe = recipeByAssetId.get(model?.assetId);
  if (!recipe) errors.push(`${label} has no matching recipe`);
  else if (model.partId !== recipe.partId) errors.push(`${label} partId does not match its recipe`);
  if (!isSafeRelativePath(model?.outputPath)) errors.push(`${label} outputPath must be a safe relative path`);
  requireSha256(model?.sha256, `${label} sha256`, errors);
  requireNonNegativeInteger(model?.triangles, `${label} triangles`, errors);
  requireNonNegativeInteger(model?.transferBytes, `${label} transferBytes`, errors);
  requireNonNegativeInteger(model?.gpuBytes, `${label} gpuBytes`, errors);
  validateBounds(model?.boundsMin, model?.boundsMax, `${label} bounds`, errors);
  validateAnchors(model?.plumeAnchors, `${label} plumeAnchors`, errors);
  if (recipe && Number.isSafeInteger(model?.triangles) && model.triangles > recipe.triangleLimit) {
    errors.push(`${label} exceeds its triangleLimit`);
  }
}

export function validateCheckedPartManifest(root) {
  let recipes;
  try {
    ({ recipes } = loadPartAssetInputs(root));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const errors = [];
  const recipeModels = Array.isArray(recipes?.models) ? recipes.models : [];
  if (!Array.isArray(recipes?.models)) errors.push('Part recipes must contain a models array');
  const path = resolve(root, 'src/generated/checked-part-manifest.json');
  if (!existsSync(path)) {
    if (Array.isArray(recipes?.models) && recipes.models.length === 0) return errors;
    errors.push('Checked part manifest is missing after part recipes were added');
    return errors;
  }

  let artifact;
  try {
    artifact = readJson(path, 'Checked part manifest');
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (artifact?.schemaVersion !== 1) errors.push('Checked part manifest schemaVersion must be 1');
  if (artifact?.manifest?.schemaVersion !== 1) errors.push('Embedded part manifest schemaVersion must be 1');
  requireSha256(artifact?.manifestSha256, 'Checked part manifest manifestSha256', errors);
  if (!artifact?.manifest || typeof artifact.manifest !== 'object' || Array.isArray(artifact.manifest)) {
    errors.push('Checked part manifest must contain a manifest object');
    return errors;
  }
  const actualSha256 = sha256Bytes(canonicalJson(artifact.manifest));
  if (artifact.manifestSha256 !== actualSha256) errors.push('Checked part manifest digest does not match its canonical manifest');
  if (!Array.isArray(artifact.manifest.models)) {
    errors.push('Checked part manifest must contain a models array');
    return errors;
  }

  const recipeByAssetId = new Map(
    recipeModels
      .filter((recipe) => recipe && typeof recipe === 'object' && !Array.isArray(recipe))
      .map((recipe) => [recipe.assetId, recipe]),
  );
  const assetIds = new Set();
  const partIds = new Set();
  let triangles = 0;
  let referenceCraftTriangles = 0;
  let transferBytes = 0;
  let gpuBytes = 0;
  for (const model of artifact.manifest.models) {
    validateCheckedModel(model, recipeByAssetId, errors);
    if (assetIds.has(model?.assetId)) errors.push(`Duplicate checked part assetId ${model.assetId}`);
    assetIds.add(model?.assetId);
    if (partIds.has(model?.partId)) errors.push(`Duplicate checked partId assignment ${model.partId}`);
    partIds.add(model?.partId);
    if (Number.isSafeInteger(model?.triangles) && model.triangles >= 0) {
      triangles += model.triangles;
      referenceCraftTriangles += model.triangles * (REFERENCE_CRAFT_COPIES[model?.partId] ?? 0);
    }
    if (Number.isSafeInteger(model?.transferBytes) && model.transferBytes >= 0) transferBytes += model.transferBytes;
    if (Number.isSafeInteger(model?.gpuBytes) && model.gpuBytes >= 0) gpuBytes += model.gpuBytes;
  }
  if (artifact.manifest.models.length !== recipeModels.length) {
    errors.push('Checked part manifest model count does not match part recipes');
  }
  for (const recipe of recipeModels) {
    if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
      errors.push('Part recipes models entries must be objects');
    } else if (!assetIds.has(recipe.assetId)) {
      errors.push(`Checked part manifest is missing ${recipe.assetId}`);
    }
  }
  for (const [name, total] of Object.entries({ totalTriangleLimit: triangles, totalTransferBytes: transferBytes, totalGpuBytes: gpuBytes })) {
    if (total > PART_ASSET_BUDGET_CEILINGS[name]) errors.push(`Checked part models exceed ${name}`);
  }
  if (referenceCraftTriangles > REFERENCE_CRAFT_TRIANGLE_LIMIT) {
    errors.push('Checked part models exceed referenceCraftTriangleLimit');
  }
  return errors;
}
