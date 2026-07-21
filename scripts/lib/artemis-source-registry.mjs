import { createHash } from 'node:crypto';
import { sha256Bytes } from './canonical-json.mjs';

export const ARTEMIS_FIDELITY_LABELS = Object.freeze([
  'verified-source',
  'reference-trajectory',
  'representative',
  'proxy-visual',
]);

const FIDELITY_LABELS = new Set(ARTEMIS_FIDELITY_LABELS);
const SOURCE_KINDS = new Set(['web-page', 'technical-report', 'metadata', 'kernel']);
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]+$/;
const EXPECTED_ARTIFACT_PATH = 'src/generated/artemis-iv-reference-track.json';
const EXPECTED_MISSION_ID = 'artemis-iv';
const EXPECTED_TRACK_ID = 'gateway-nrho-reference-revolution-2028-11';
const EXPECTED_FRAME = 'MOON_J2000';
const EXPECTED_SPICEYPY_VERSION = '8.1.2';
const EXPECTED_NUMPY_VERSION = '2.5.1';
const EXPECTED_KERNEL_SOURCE_IDS = Object.freeze([
  'naif-dsg-nrho-spk-2018',
  'jpl-de440s-spk-2020',
  'naif-leapseconds-0012',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function isSafeRepositoryPath(value) {
  return typeof value === 'string' && value.length > 0 &&
    !value.startsWith('/') && !value.split(/[\\/]/).includes('..') &&
    !/^[a-z][a-z\d+.-]*:/i.test(value);
}

function validIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function arraysEqual(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function closeEnough(actual, expected, tolerance) {
  return Number.isFinite(actual) && Number.isFinite(expected) &&
    Math.abs(actual - expected) <= tolerance;
}

export function sha256ArtemisBytes(bytes) {
  return sha256Bytes(bytes);
}

export function artemisSamplesSha256(samples) {
  const digest = createHash('sha256');
  const bytes = Buffer.allocUnsafe(7 * 8);
  for (const sample of samples) {
    let offset = 0;
    for (const value of [sample.tSeconds, ...sample.positionM, ...sample.velocityMps]) {
      bytes.writeDoubleBE(value, offset);
      offset += 8;
    }
    digest.update(bytes);
  }
  return digest.digest('hex');
}

export function validateArtemisSourceLock(lock) {
  const errors = [];
  if (!isRecord(lock) || lock.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (lock?.missionId !== EXPECTED_MISSION_ID) errors.push(`missionId must be ${EXPECTED_MISSION_ID}`);
  if (!validIsoDate(lock?.retrievedOn)) errors.push('retrievedOn must be an ISO calendar date');
  if (!Array.isArray(lock?.allowedHosts) || lock.allowedHosts.length === 0 ||
    lock.allowedHosts.some((host) => typeof host !== 'string' || !host)) {
    errors.push('allowedHosts must be a non-empty string array');
  }
  const allowedHosts = new Set(lock?.allowedHosts ?? []);
  if (!Array.isArray(lock?.sources) || lock.sources.length === 0) {
    errors.push('sources must be a non-empty array');
    return errors;
  }

  const sourceIds = new Set();
  for (const [index, source] of lock.sources.entries()) {
    const label = `sources[${index}]`;
    if (!isRecord(source)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    if (typeof source.id !== 'string' || !SAFE_ID.test(source.id)) {
      errors.push(`${label}.id must be a stable kebab-case identifier`);
    } else if (sourceIds.has(source.id)) {
      errors.push(`${label}.id duplicates ${source.id}`);
    } else {
      sourceIds.add(source.id);
    }
    if (!SOURCE_KINDS.has(source.kind)) errors.push(`${label}.kind is invalid`);
    if (!FIDELITY_LABELS.has(source.fidelity)) errors.push(`${label}.fidelity is invalid`);
    for (const key of ['publisher', 'title']) {
      if (typeof source[key] !== 'string' || !source[key].trim()) errors.push(`${label}.${key} is required`);
    }
    if (!validIsoDate(source.retrievedOn)) errors.push(`${label}.retrievedOn must be an ISO calendar date`);
    if (!Array.isArray(source.supportedClaims) || source.supportedClaims.length === 0 ||
      source.supportedClaims.some((claim) => typeof claim !== 'string' || !claim.trim())) {
      errors.push(`${label}.supportedClaims must be a non-empty string array`);
    }
    let sourceUrl;
    try {
      sourceUrl = new URL(source.url);
    } catch {
      errors.push(`${label}.url is invalid`);
    }
    if (sourceUrl && (sourceUrl.protocol !== 'https:' || !allowedHosts.has(sourceUrl.hostname))) {
      errors.push(`${label}.url is outside the HTTPS allowlist`);
    }
    if (source.kind === 'kernel') {
      if (!isRecord(source.artifact)) {
        errors.push(`${label}.artifact is required for a kernel`);
      } else {
        if (typeof source.artifact.filename !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(source.artifact.filename)) {
          errors.push(`${label}.artifact.filename must be a plain filename`);
        }
        if (!Number.isSafeInteger(source.artifact.byteLength) || source.artifact.byteLength <= 0) {
          errors.push(`${label}.artifact.byteLength must be a positive safe integer`);
        }
        if (!SHA256.test(source.artifact.sha256 ?? '')) {
          errors.push(`${label}.artifact.sha256 must be lowercase SHA-256`);
        }
      }
    } else if (source.artifact !== undefined) {
      errors.push(`${label}.artifact is only valid for locked kernel bytes`);
    }
  }

  const trajectory = lock.referenceTrajectory;
  if (!isRecord(trajectory)) {
    errors.push('referenceTrajectory is required');
    return errors;
  }
  if (trajectory.id !== EXPECTED_TRACK_ID) errors.push(`referenceTrajectory.id must be ${EXPECTED_TRACK_ID}`);
  if (trajectory.fidelity !== 'reference-trajectory') {
    errors.push('referenceTrajectory.fidelity must be reference-trajectory');
  }
  if (trajectory.coordinateFrame !== EXPECTED_FRAME) {
    errors.push(`referenceTrajectory.coordinateFrame must be ${EXPECTED_FRAME}`);
  }
  if (trajectory.positionUnits !== 'm' || trajectory.velocityUnits !== 'm/s' ||
    trajectory.timeUnits !== 's') {
    errors.push('referenceTrajectory units must be seconds and SI position/velocity');
  }
  if (!Array.isArray(trajectory.sourceIds) || trajectory.sourceIds.length === 0) {
    errors.push('referenceTrajectory.sourceIds must be a non-empty array');
  } else {
    for (const sourceId of trajectory.sourceIds) {
      if (!sourceIds.has(sourceId)) errors.push(`referenceTrajectory references unknown source ${sourceId}`);
    }
  }
  if (!arraysEqual(trajectory.kernelSourceIds, EXPECTED_KERNEL_SOURCE_IDS)) {
    errors.push(`referenceTrajectory.kernelSourceIds must be ${EXPECTED_KERNEL_SOURCE_IDS.join(', ')}`);
  }
  if (!isRecord(trajectory.selection) ||
    !Number.isFinite(trajectory.selection.startEtSeconds) ||
    !Number.isFinite(trajectory.selection.stopEtSeconds) ||
    trajectory.selection.stopEtSeconds <= trajectory.selection.startEtSeconds ||
    !Number.isFinite(trajectory.selection.sampleStepSeconds) ||
    trajectory.selection.sampleStepSeconds <= 0 ||
    typeof trajectory.selection.method !== 'string' || !trajectory.selection.method.trim()) {
    errors.push('referenceTrajectory.selection must define fixed ET bounds, sample step, and method');
  }
  const artifact = trajectory.generatedArtifact;
  if (!isRecord(artifact)) {
    errors.push('referenceTrajectory.generatedArtifact is required');
  } else {
    if (artifact.path !== EXPECTED_ARTIFACT_PATH || !isSafeRepositoryPath(artifact.path)) {
      errors.push(`referenceTrajectory.generatedArtifact.path must be ${EXPECTED_ARTIFACT_PATH}`);
    }
    if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength <= 0) {
      errors.push('referenceTrajectory.generatedArtifact.byteLength must be a positive safe integer');
    }
    if (!SHA256.test(artifact.sha256 ?? '')) {
      errors.push('referenceTrajectory.generatedArtifact.sha256 must be lowercase SHA-256');
    }
    for (const key of ['script', 'requirements', 'command']) {
      if (typeof artifact[key] !== 'string' || !artifact[key].trim()) {
        errors.push(`referenceTrajectory.generatedArtifact.${key} is required`);
      }
    }
    if (!isSafeRepositoryPath(artifact.script) || !isSafeRepositoryPath(artifact.requirements)) {
      errors.push('referenceTrajectory generator paths must be repository-relative');
    }
    for (const key of ['scriptSha256', 'requirementsSha256']) {
      if (!SHA256.test(artifact[key] ?? '')) {
        errors.push(`referenceTrajectory.generatedArtifact.${key} must be lowercase SHA-256`);
      }
    }
    for (const key of ['scriptByteLength', 'requirementsByteLength']) {
      if (!Number.isSafeInteger(artifact[key]) || artifact[key] <= 0) {
        errors.push(`referenceTrajectory.generatedArtifact.${key} must be a positive safe integer`);
      }
    }
  }
  if (typeof trajectory.disclaimer !== 'string' ||
    !/not (?:an |the )?artemis iv flight/i.test(trajectory.disclaimer)) {
    errors.push('referenceTrajectory.disclaimer must explicitly reject Artemis IV flight-trajectory fidelity');
  }
  return errors;
}

export function assertArtemisSourceLock(lock) {
  const errors = validateArtemisSourceLock(lock);
  if (errors.length) throw new Error(`Invalid Artemis IV source lock:\n- ${errors.join('\n- ')}`);
  return lock;
}

export function sourceByArtemisId(lock, sourceId) {
  const source = lock.sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error(`Unknown Artemis IV source: ${sourceId}`);
  return source;
}

export function validateArtemisReferenceArtifact(lock, artifact, artifactBytes) {
  const errors = [];
  const sourceLockErrors = validateArtemisSourceLock(lock);
  if (sourceLockErrors.length) {
    return sourceLockErrors.map((error) => `source lock: ${error}`);
  }
  const expected = lock.referenceTrajectory;
  if (!isRecord(artifact) || artifact.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (artifact?.id !== expected.id) errors.push(`id must be ${expected.id}`);
  if (artifact?.missionId !== EXPECTED_MISSION_ID) errors.push(`missionId must be ${EXPECTED_MISSION_ID}`);
  if (artifact?.fidelity !== 'reference-trajectory') errors.push('fidelity must be reference-trajectory');
  if (artifact?.interpolation !== 'cubic-hermite') errors.push('interpolation must be cubic-hermite');
  if (artifact?.loopMode !== 'open-reference-revolution') {
    errors.push('loopMode must be open-reference-revolution');
  }
  if (typeof artifact?.disclaimer !== 'string' ||
    !/not (?:an |the )?artemis iv flight/i.test(artifact.disclaimer)) {
    errors.push('disclaimer must explicitly reject Artemis IV flight-trajectory fidelity');
  }
  const frame = artifact?.coordinateFrame;
  if (!isRecord(frame) || frame.id !== EXPECTED_FRAME || frame.originNaifId !== 301 ||
    frame.axes !== 'J2000' || frame.aberrationCorrection !== 'NONE' ||
    frame.positionUnits !== 'm' || frame.velocityUnits !== 'm/s') {
    errors.push('coordinateFrame must be Moon-centered J2000 with uncorrected SI states');
  }
  if (!closeEnough(artifact?.referenceEpochJ2000Seconds, expected.selection.startEtSeconds, 1e-6)) {
    errors.push('referenceEpochJ2000Seconds must match the locked SPICE ET start');
  }
  const expectedDuration = expected.selection.stopEtSeconds - expected.selection.startEtSeconds;
  if (!closeEnough(artifact?.durationSeconds, expectedDuration, 1e-6)) {
    errors.push('durationSeconds must match the locked ET interval');
  }
  if (artifact?.sampleStepSeconds !== expected.selection.sampleStepSeconds) {
    errors.push('sampleStepSeconds must match the source lock');
  }
  if (!arraysEqual(artifact?.generatedFrom?.kernelSourceIds, expected.kernelSourceIds)) {
    errors.push('generatedFrom.kernelSourceIds must match the source lock');
  }
  const generatedKernels = artifact?.generatedFrom?.kernelArtifacts;
  if (!Array.isArray(generatedKernels) || generatedKernels.length !== expected.kernelSourceIds.length) {
    errors.push('generatedFrom.kernelArtifacts must describe every locked kernel');
  } else {
    for (const [index, sourceId] of expected.kernelSourceIds.entries()) {
      const source = lock.sources.find((candidate) => candidate.id === sourceId);
      const generated = generatedKernels[index];
      if (!source || !isRecord(generated) || generated.sourceId !== sourceId ||
        generated.filename !== source.artifact?.filename ||
        generated.byteLength !== source.artifact?.byteLength ||
        generated.sha256 !== source.artifact?.sha256) {
        errors.push(`generatedFrom.kernelArtifacts[${index}] does not match locked source ${sourceId}`);
      }
    }
  }
  if (artifact?.generatedFrom?.generatorScript !== expected.generatedArtifact.script ||
    artifact?.generatedFrom?.requirements !== expected.generatedArtifact.requirements) {
    errors.push('generatedFrom generator paths must match the source lock');
  }
  if (artifact?.generatedFrom?.spiceTargetNaifId !== -60000 ||
    artifact?.generatedFrom?.spiceObserverNaifId !== 301) {
    errors.push('generatedFrom must identify DSG -60000 relative to Moon 301');
  }
  if (artifact?.generatedFrom?.spiceypyVersion !== EXPECTED_SPICEYPY_VERSION ||
    artifact?.generatedFrom?.numpyVersion !== EXPECTED_NUMPY_VERSION) {
    errors.push(
      `generatedFrom must identify SpiceyPy ${EXPECTED_SPICEYPY_VERSION} and NumPy ${EXPECTED_NUMPY_VERSION}`,
    );
  }

  const samples = artifact?.samples;
  if (!Array.isArray(samples) || samples.length < 3) {
    errors.push('samples must contain at least three states');
    return errors;
  }
  let previousTime = -Infinity;
  let minimumRadius = Infinity;
  let maximumRadius = -Infinity;
  let samplesAreValid = true;
  for (const [index, sample] of samples.entries()) {
    const label = `samples[${index}]`;
    if (!isRecord(sample) || !Number.isFinite(sample.tSeconds) ||
      !isFiniteVector(sample.positionM, 3) || !isFiniteVector(sample.velocityMps, 3)) {
      errors.push(`${label} must contain finite time, position, and velocity`);
      samplesAreValid = false;
      continue;
    }
    if (sample.tSeconds <= previousTime) errors.push(`${label}.tSeconds must increase monotonically`);
    const interval = sample.tSeconds - previousTime;
    if (index > 0 && interval > expected.selection.sampleStepSeconds + 1e-6) {
      errors.push(`${label} exceeds the locked sample step`);
    }
    if (index > 0 && index < samples.length - 1 &&
      !closeEnough(interval, expected.selection.sampleStepSeconds, 1e-6)) {
      errors.push(`${label} must use the locked sample step before the terminal state`);
    }
    previousTime = sample.tSeconds;
    const radius = Math.hypot(...sample.positionM);
    minimumRadius = Math.min(minimumRadius, radius);
    maximumRadius = Math.max(maximumRadius, radius);
  }
  if (!samplesAreValid) return errors;
  if (!closeEnough(samples[0]?.tSeconds, 0, 1e-9) ||
    !closeEnough(samples.at(-1)?.tSeconds, expectedDuration, 1e-6)) {
    errors.push('sample bounds must cover the complete locked interval');
  }
  if (!SHA256.test(artifact?.samplesSha256 ?? '') ||
    artifact.samplesSha256 !== artemisSamplesSha256(samples)) {
    errors.push('samplesSha256 does not match the binary-encoded sample states');
  }

  const metrics = artifact?.metrics;
  if (!isRecord(metrics)) {
    errors.push('metrics are required');
  } else {
    const periodDays = expectedDuration / 86_400;
    const endpointSeparation = Math.hypot(
      ...samples[0].positionM.map((value, index) => value - samples.at(-1).positionM[index]),
    );
    const endpointVelocityDelta = Math.hypot(
      ...samples[0].velocityMps.map((value, index) => value - samples.at(-1).velocityMps[index]),
    );
    for (const [label, actual, value, tolerance] of [
      ['sampleCount', metrics.sampleCount, samples.length, 0],
      ['periodDays', metrics.periodDays, periodDays, 1e-10],
      ['minimumRadiusMeters', metrics.minimumRadiusMeters, minimumRadius, 1e-4],
      ['maximumRadiusMeters', metrics.maximumRadiusMeters, maximumRadius, 1e-4],
      ['endpointSeparationMeters', metrics.endpointSeparationMeters, endpointSeparation, 1e-4],
      ['endpointVelocityDeltaMetersPerSecond', metrics.endpointVelocityDeltaMetersPerSecond,
        endpointVelocityDelta, 1e-8],
    ]) {
      if (!closeEnough(actual, value, tolerance)) errors.push(`metrics.${label} does not match samples`);
    }
    if (Math.abs(periodDays - 6.562) > 0.35) {
      errors.push('reference revolution period is outside the published 6.562-day envelope');
    }
    if (minimumRadius < 3_150_000 || minimumRadius > 3_600_000) {
      errors.push('minimum radius is outside the published perilune-radius envelope');
    }
    if (maximumRadius < 65_000_000 || maximumRadius > 75_000_000) {
      errors.push('maximum radius is outside the published approximately 70,000 km apolune envelope');
    }
  }

  if (artifactBytes !== undefined) {
    if (artifactBytes.byteLength !== expected.generatedArtifact.byteLength) {
      errors.push('checked artifact byte length does not match the source lock');
    }
    if (sha256ArtemisBytes(artifactBytes) !== expected.generatedArtifact.sha256) {
      errors.push('checked artifact SHA-256 does not match the source lock');
    }
  }
  return errors;
}

export function assertArtemisReferenceArtifact(lock, artifact, artifactBytes) {
  const errors = validateArtemisReferenceArtifact(lock, artifact, artifactBytes);
  if (errors.length) throw new Error(`Invalid Artemis IV reference artifact:\n- ${errors.join('\n- ')}`);
  return artifact;
}
