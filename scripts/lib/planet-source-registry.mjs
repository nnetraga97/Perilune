import { createHash } from 'node:crypto';

export const PLANET_SOURCE_ROLES = Object.freeze([
  'height', 'surface-class', 'albedo', 'material', 'shading-normal',
]);

const DELIVERY_MODES = new Set(['direct-cors', 'same-origin-proxy', 'offline-build']);
const BODY_IDS = new Set(['earth', 'moon']);
const SOURCE_ROLES = new Set(PLANET_SOURCE_ROLES);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCoverage(value) {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
    && value[0] >= -180 && value[2] <= 180 && value[0] < value[2]
    && value[1] >= -90 && value[3] <= 90 && value[1] < value[3];
}

export function buildProbeUrl(operation) {
  const url = new URL(operation.url);
  for (const [key, value] of Object.entries(operation.params ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

export function validatePlanetSourceLock(lock) {
  const errors = [];
  if (!isRecord(lock) || lock.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(lock?.allowedHosts) || lock.allowedHosts.length === 0) {
    errors.push('allowedHosts must be a non-empty array');
  }
  const allowedHosts = new Set(lock?.allowedHosts ?? []);
  const seen = new Set();
  if (!Array.isArray(lock?.sources) || lock.sources.length === 0) {
    errors.push('sources must be a non-empty array');
    return errors;
  }
  for (const [index, source] of lock.sources.entries()) {
    const label = `sources[${index}]`;
    if (!isRecord(source)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof source.id !== 'string' || !/^[a-z0-9][a-z0-9-]+$/.test(source.id)) {
      errors.push(`${label}.id must be a stable kebab-case identifier`);
    } else if (seen.has(source.id)) {
      errors.push(`${label}.id duplicates ${source.id}`);
    } else {
      seen.add(source.id);
    }
    if (!BODY_IDS.has(source.body)) errors.push(`${label}.body must be earth or moon`);
    if (!SOURCE_ROLES.has(source.role)) errors.push(`${label}.role is not a recognized data role`);
    if (!validCoverage(source.coverage)) errors.push(`${label}.coverage must be a valid lon/lat bbox`);
    for (const key of ['version', 'projection', 'verticalDatum', 'license', 'licenseUrl']) {
      if (typeof source[key] !== 'string' || !source[key]) errors.push(`${label}.${key} is required`);
    }
    if (!DELIVERY_MODES.has(source.delivery)) errors.push(`${label}.delivery is invalid`);
    if (!Array.isArray(source.operations)) errors.push(`${label}.operations must be an array`);
    for (const [operationIndex, operation] of (source.operations ?? []).entries()) {
      const operationLabel = `${label}.operations[${operationIndex}]`;
      if (!isRecord(operation) || typeof operation.id !== 'string' || !operation.id) {
        errors.push(`${operationLabel}.id is required`);
        continue;
      }
      let url;
      try {
        url = buildProbeUrl(operation);
      } catch {
        errors.push(`${operationLabel}.url is invalid`);
        continue;
      }
      if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
        errors.push(`${operationLabel}.url is outside the HTTPS allowlist`);
      }
      if (!Number.isInteger(operation.maximumBytes) || operation.maximumBytes <= 0 || operation.maximumBytes > 2_097_152) {
        errors.push(`${operationLabel}.maximumBytes must be between 1 and 2097152`);
      }
      if (typeof operation.expectedMime !== 'string' || !operation.expectedMime) {
        errors.push(`${operationLabel}.expectedMime is required`);
      }
      if (operation.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(operation.sha256)) {
        errors.push(`${operationLabel}.sha256 must be lowercase SHA-256`);
      }
      if (source.delivery === 'direct-cors' && operation.expectedCors !== '*') {
        errors.push(`${operationLabel} must assert wildcard CORS for direct delivery`);
      }
    }
  }
  return errors;
}

export function assertPlanetSourceLock(lock) {
  const errors = validatePlanetSourceLock(lock);
  if (errors.length) throw new Error(`Invalid Sol detail source lock:\n- ${errors.join('\n- ')}`);
  return lock;
}

export function sourceById(lock, sourceId) {
  const source = lock.sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error(`Unknown planet source dataset: ${sourceId}`);
  return source;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertJsonFingerprint(actual, expected, label = 'JSON response') {
  for (const [key, value] of Object.entries(expected ?? {})) {
    if (actual?.[key] !== value) {
      throw new Error(`${label} field ${key} changed: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual?.[key])}`);
    }
  }
}
