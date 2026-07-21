import type { MissionDefinition, MissionFidelity, MissionPlaybackRate } from './types';
import { MISSION_PLAYBACK_RATES } from './types';

export class MissionValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid mission definition:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'MissionValidationError';
    this.issues = issues;
  }
}

type AnyRecord = Record<string, unknown>;
type IndexedRecord = { readonly index: number; readonly value: AnyRecord };

const FIDELITIES = new Set<MissionFidelity>([
  'verified-source',
  'reference-trajectory',
  'representative',
  'proxy-visual',
]);
const RATES = new Set<number>(MISSION_PLAYBACK_RATES);
const ENTITY_KINDS = new Set(['station', 'spacecraft', 'module', 'marker']);
const EVENT_KINDS = new Set([
  'phase-marker',
  'lunar-arrival',
  'rendezvous',
  'hold-point-arrival',
  'corridor-entry',
  'soft-capture',
  'hard-dock',
  'activation',
]);
const TELEMETRY_KINDS = new Set(['elapsed-time', 'range', 'closing-rate', 'relative-speed']);

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecordArray(root: AnyRecord, key: string, issues: string[]): IndexedRecord[] {
  const value = root[key];
  if (!Array.isArray(value)) {
    issues.push(`${key} must be an array`);
    return [];
  }
  const result: IndexedRecord[] = [];
  value.forEach((entry, index) => {
    if (isRecord(entry)) result.push({ index, value: entry });
    else issues.push(`${key}[${index}] must be an object`);
  });
  return result;
}

function requireString(record: AnyRecord, key: string, path: string, issues: string[]): string | null {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${path}.${key} must be a non-empty string`);
    return null;
  }
  return value;
}

function optionalString(record: AnyRecord, key: string, path: string, issues: string[]): string | null {
  const value = record[key];
  if (value === undefined) return null;
  return requireString(record, key, path, issues);
}

function requireFinite(record: AnyRecord, key: string, path: string, issues: string[]): number | null {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${path}.${key} must be a finite number`);
    return null;
  }
  return value;
}

function optionalFinite(record: AnyRecord, key: string, path: string, issues: string[]): number | null {
  if (record[key] === undefined) return null;
  return requireFinite(record, key, path, issues);
}

function requireBoolean(record: AnyRecord, key: string, path: string, issues: string[]): boolean | null {
  const value = record[key];
  if (typeof value !== 'boolean') {
    issues.push(`${path}.${key} must be a boolean`);
    return null;
  }
  return value;
}

function requireStringArray(record: AnyRecord, key: string, path: string, issues: string[]): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    issues.push(`${path}.${key} must be an array of ids`);
    return [];
  }
  const result: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      issues.push(`${path}.${key}[${index}] must be a non-empty string`);
    } else {
      result.push(entry);
    }
  });
  return result;
}

function requireFidelity(record: AnyRecord, path: string, issues: string[]): MissionFidelity | null {
  const value = record.fidelity;
  if (typeof value !== 'string' || !FIDELITIES.has(value as MissionFidelity)) {
    issues.push(`${path}.fidelity must be one of ${[...FIDELITIES].join(', ')}`);
    return null;
  }
  return value as MissionFidelity;
}

function requireEnum(
  record: AnyRecord,
  key: string,
  path: string,
  allowed: ReadonlySet<string>,
  issues: string[],
): string | null {
  const value = record[key];
  if (typeof value !== 'string' || !allowed.has(value)) {
    issues.push(`${path}.${key} must be one of ${[...allowed].join(', ')}`);
    return null;
  }
  return value;
}

function requireDate(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    issues.push(`${path} must be an ISO calendar date (YYYY-MM-DD)`);
    return;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    issues.push(`${path} is not a valid calendar date`);
  }
}

function requireUrl(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'string') {
    issues.push(`${path} must be an HTTP(S) URL`);
    return;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
  } catch {
    issues.push(`${path} must be an HTTP(S) URL`);
  }
}

function requireVector(value: unknown, path: string, issues: string[], nonZero = false): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be a vector object`);
    return;
  }
  const components = ['x', 'y', 'z'].map((key) => value[key]);
  if (components.some((component) => typeof component !== 'number' || !Number.isFinite(component))) {
    issues.push(`${path} must contain finite x, y, and z components`);
    return;
  }
  if (nonZero && components.every((component) => component === 0)) issues.push(`${path} must be non-zero`);
}

function requireUnitQuaternion(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be a quaternion object`);
    return;
  }
  const components = ['x', 'y', 'z', 'w'].map((key) => value[key]);
  if (components.some((component) => typeof component !== 'number' || !Number.isFinite(component))) {
    issues.push(`${path} must contain finite x, y, z, and w components`);
    return;
  }
  const [x, y, z, w] = components as number[];
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (norm <= 1e-12) issues.push(`${path} must be non-zero`);
  else if (Math.abs(norm - 1) > 1e-3) issues.push(`${path} must be normalized (length is ${norm})`);
}

function collectUniqueIds(records: readonly IndexedRecord[], path: string, issues: string[]): Set<string> {
  const ids = new Set<string>();
  for (const { index, value } of records) {
    const id = requireString(value, 'id', `${path}[${index}]`, issues);
    if (id === null) continue;
    if (ids.has(id)) issues.push(`${path}[${index}].id duplicates '${id}'`);
    ids.add(id);
  }
  return ids;
}

function validateReferences(
  ids: readonly string[],
  known: ReadonlySet<string>,
  path: string,
  label: string,
  issues: string[],
): void {
  for (const id of ids) if (!known.has(id)) issues.push(`${path} references unknown ${label} '${id}'`);
}

function validateAnchor(
  value: unknown,
  path: string,
  frameIds: ReadonlySet<string>,
  entityIds: ReadonlySet<string>,
  issues: string[],
): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be a camera anchor object`);
    return;
  }
  const kind = value.kind;
  if (kind === 'body') {
    requireString(value, 'bodyId', path, issues);
  } else if (kind === 'entity') {
    const id = requireString(value, 'entityId', path, issues);
    if (id !== null && !entityIds.has(id)) issues.push(`${path}.entityId references unknown entity '${id}'`);
  } else if (kind === 'frame') {
    const id = requireString(value, 'frameId', path, issues);
    if (id !== null && !frameIds.has(id)) issues.push(`${path}.frameId references unknown frame '${id}'`);
  } else {
    issues.push(`${path}.kind must be body, entity, or frame`);
  }
}

function validateDirectedCycles(
  nodes: ReadonlySet<string>,
  dependency: (id: string) => string | null,
  label: string,
  issues: string[],
): void {
  const done = new Set<string>();
  for (const start of nodes) {
    if (done.has(start)) continue;
    const path: string[] = [];
    const seenAt = new Map<string, number>();
    let current: string | null = start;
    while (current !== null && nodes.has(current) && !done.has(current)) {
      const cycleStart = seenAt.get(current);
      if (cycleStart !== undefined) {
        issues.push(`${label} dependency cycle: ${[...path.slice(cycleStart), current].join(' -> ')}`);
        break;
      }
      seenAt.set(current, path.length);
      path.push(current);
      current = dependency(current);
    }
    path.forEach((id) => done.add(id));
  }
}

export function collectMissionValidationErrors(input: unknown): readonly string[] {
  const issues: string[] = [];
  if (!isRecord(input)) return ['mission definition must be an object'];
  const root = input;

  requireString(root, 'id', 'mission', issues);
  requireString(root, 'title', 'mission', issues);
  requireString(root, 'revision', 'mission', issues);
  requireDate(root.retrievedAt, 'mission.retrievedAt', issues);
  requireString(root, 'summary', 'mission', issues);
  requireString(root, 'objective', 'mission', issues);
  requireString(root, 'disclaimer', 'mission', issues);
  const focusBodyId = requireString(root, 'focusBodyId', 'mission', issues);
  requireFinite(root, 'referenceEpochJ2000Seconds', 'mission', issues);
  const startTime = requireFinite(root, 'startTimeSeconds', 'mission', issues);
  const endTime = requireFinite(root, 'endTimeSeconds', 'mission', issues);
  if (startTime !== null && endTime !== null && endTime <= startTime) {
    issues.push('mission.endTimeSeconds must be after mission.startTimeSeconds');
  }

  const sources = requireRecordArray(root, 'sources', issues);
  const claims = requireRecordArray(root, 'claims', issues);
  const frames = requireRecordArray(root, 'frames', issues);
  const entities = requireRecordArray(root, 'entities', issues);
  const phases = requireRecordArray(root, 'phases', issues);
  const tracks = requireRecordArray(root, 'tracks', issues);
  const events = requireRecordArray(root, 'events', issues);
  const dockings = requireRecordArray(root, 'dockings', issues);
  const cameraCues = requireRecordArray(root, 'cameraCues', issues);
  const layers = requireRecordArray(root, 'layers', issues);
  const telemetryChannels = requireRecordArray(root, 'telemetryChannels', issues);

  const sourceIds = collectUniqueIds(sources, 'sources', issues);
  const claimIds = collectUniqueIds(claims, 'claims', issues);
  const frameIds = collectUniqueIds(frames, 'frames', issues);
  const entityIds = collectUniqueIds(entities, 'entities', issues);
  const phaseIds = collectUniqueIds(phases, 'phases', issues);
  const trackIds = collectUniqueIds(tracks, 'tracks', issues);
  const eventIds = collectUniqueIds(events, 'events', issues);
  collectUniqueIds(dockings, 'dockings', issues);
  const cameraCueIds = collectUniqueIds(cameraCues, 'cameraCues', issues);
  collectUniqueIds(layers, 'layers', issues);
  collectUniqueIds(telemetryChannels, 'telemetryChannels', issues);

  for (const { index, value } of sources) {
    const path = `sources[${index}]`;
    requireString(value, 'title', path, issues);
    requireString(value, 'publisher', path, issues);
    requireUrl(value.url, `${path}.url`, issues);
    requireDate(value.retrievedAt, `${path}.retrievedAt`, issues);
    requireString(value, 'supportedClaim', path, issues);
    requireFidelity(value, path, issues);
  }

  for (const { index, value } of claims) {
    const path = `claims[${index}]`;
    requireString(value, 'text', path, issues);
    requireFidelity(value, path, issues);
    const refs = requireStringArray(value, 'sourceIds', path, issues);
    if (refs.length === 0) issues.push(`${path}.sourceIds must cite at least one source`);
    validateReferences(refs, sourceIds, `${path}.sourceIds`, 'source', issues);
  }

  const frameById = new Map<string, AnyRecord>();
  for (const { index, value } of frames) {
    const path = `frames[${index}]`;
    const id = typeof value.id === 'string' ? value.id : null;
    if (id !== null) frameById.set(id, value);
    if (value.kind === 'body-centered-inertial') {
      const bodyId = requireString(value, 'bodyId', path, issues);
      if (bodyId !== null && focusBodyId !== null && bodyId !== focusBodyId) {
        issues.push(`${path}.bodyId must match mission focus body '${focusBodyId}'`);
      }
    } else if (value.kind === 'lvlh' || value.kind === 'entity-local') {
      const entityId = requireString(value, 'entityId', path, issues);
      const parentFrameId = requireString(value, 'parentFrameId', path, issues);
      if (entityId !== null && !entityIds.has(entityId)) issues.push(`${path}.entityId references unknown entity '${entityId}'`);
      if (parentFrameId !== null && !frameIds.has(parentFrameId)) {
        issues.push(`${path}.parentFrameId references unknown frame '${parentFrameId}'`);
      }
    } else {
      issues.push(`${path}.kind must be body-centered-inertial, lvlh, or entity-local`);
    }
  }
  validateDirectedCycles(
    frameIds,
    (id) => {
      const frame = frameById.get(id);
      return frame?.kind === 'body-centered-inertial' || typeof frame?.parentFrameId !== 'string'
        ? null
        : frame.parentFrameId;
    },
    'frame',
    issues,
  );

  const trackById = new Map<string, AnyRecord>();
  for (const { index, value } of tracks) {
    const path = `tracks[${index}]`;
    if (typeof value.id === 'string') trackById.set(value.id, value);
    const frameId = requireString(value, 'frameId', path, issues);
    if (frameId !== null && !frameIds.has(frameId)) issues.push(`${path}.frameId references unknown frame '${frameId}'`);
    requireFidelity(value, path, issues);
    validateReferences(requireStringArray(value, 'sourceIds', path, issues), sourceIds, `${path}.sourceIds`, 'source', issues);
    if (value.extrapolation !== 'clamp' && value.extrapolation !== 'loop') {
      issues.push(`${path}.extrapolation must be clamp or loop`);
    }
    if (value.timeUnit !== 's') issues.push(`${path}.timeUnit must be 's'`);
    if (!Array.isArray(value.samples)) {
      issues.push(`${path}.samples must be an array`);
      continue;
    }
    const minimumSamples = value.kind === 'attitude' ? 1 : 2;
    if (value.samples.length < minimumSamples) issues.push(`${path}.samples must contain at least ${minimumSamples} sample(s)`);
    let previousTime = -Infinity;
    value.samples.forEach((sample, sampleIndex) => {
      const samplePath = `${path}.samples[${sampleIndex}]`;
      if (!isRecord(sample)) {
        issues.push(`${samplePath} must be an object`);
        return;
      }
      const time = requireFinite(sample, 'timeSeconds', samplePath, issues);
      if (time !== null && time <= previousTime) issues.push(`${samplePath}.timeSeconds must be strictly increasing`);
      if (time !== null) previousTime = time;
      if (value.kind === 'position-velocity') {
        requireVector(sample.position, `${samplePath}.position`, issues);
        requireVector(sample.velocity, `${samplePath}.velocity`, issues);
      } else if (value.kind === 'attitude') {
        requireUnitQuaternion(sample.attitude, `${samplePath}.attitude`, issues);
      }
    });
    if (value.kind === 'position-velocity') {
      if (value.interpolation !== 'cubic-hermite') issues.push(`${path}.interpolation must be cubic-hermite`);
      if (value.positionUnit !== 'm') issues.push(`${path}.positionUnit must be 'm'`);
      if (value.velocityUnit !== 'm/s') issues.push(`${path}.velocityUnit must be 'm/s'`);
    } else if (value.kind === 'attitude') {
      if (value.interpolation !== 'shortest-path-slerp') {
        issues.push(`${path}.interpolation must be shortest-path-slerp`);
      }
    } else {
      issues.push(`${path}.kind must be position-velocity or attitude`);
    }
  }

  const entityById = new Map<string, AnyRecord>();
  for (const { index, value } of entities) {
    const path = `entities[${index}]`;
    if (typeof value.id === 'string') entityById.set(value.id, value);
    requireEnum(value, 'kind', path, ENTITY_KINDS, issues);
    requireString(value, 'label', path, issues);
    const bodyId = requireString(value, 'bodyId', path, issues);
    if (bodyId !== null && focusBodyId !== null && bodyId !== focusBodyId) {
      issues.push(`${path}.bodyId must match mission focus body '${focusBodyId}'`);
    }
    requireFidelity(value, path, issues);
    validateReferences(requireStringArray(value, 'sourceIds', path, issues), sourceIds, `${path}.sourceIds`, 'source', issues);
    const positionTrackId = requireString(value, 'positionTrackId', path, issues);
    const positionTrack = positionTrackId === null ? null : trackById.get(positionTrackId);
    if (positionTrackId !== null && positionTrack === undefined) {
      issues.push(`${path}.positionTrackId references unknown track '${positionTrackId}'`);
    } else if (positionTrack !== null && positionTrack !== undefined && positionTrack.kind !== 'position-velocity') {
      issues.push(`${path}.positionTrackId must reference a position-velocity track`);
    }
    const attitudeTrackId = optionalString(value, 'attitudeTrackId', path, issues);
    const attitudeTrack = attitudeTrackId === null ? null : trackById.get(attitudeTrackId);
    if (attitudeTrackId !== null && attitudeTrack === undefined) {
      issues.push(`${path}.attitudeTrackId references unknown track '${attitudeTrackId}'`);
    } else if (attitudeTrack !== null && attitudeTrack !== undefined && attitudeTrack.kind !== 'attitude') {
      issues.push(`${path}.attitudeTrackId must reference an attitude track`);
    }
    if (!isRecord(value.visual)) {
      issues.push(`${path}.visual must be an object`);
    } else {
      requireString(value.visual, 'providerId', `${path}.visual`, issues);
      requireFidelity(value.visual, `${path}.visual`, issues);
      if (value.visual.scalePolicy !== 'physical' && value.visual.scalePolicy !== 'minimum-pixel-size') {
        issues.push(`${path}.visual.scalePolicy must be physical or minimum-pixel-size`);
      }
      const minimumPixels = optionalFinite(value.visual, 'minimumPixels', `${path}.visual`, issues);
      if (value.visual.scalePolicy === 'minimum-pixel-size' && (minimumPixels === null || minimumPixels <= 0)) {
        issues.push(`${path}.visual.minimumPixels must be positive for minimum-pixel-size`);
      }
    }
  }

  const entityDependency = new Map<string, string | null>();
  for (const id of entityIds) {
    const entity = entityById.get(id);
    const track = typeof entity?.positionTrackId === 'string' ? trackById.get(entity.positionTrackId) : undefined;
    const frame = typeof track?.frameId === 'string' ? frameById.get(track.frameId) : undefined;
    entityDependency.set(id, frame?.kind === 'lvlh' || frame?.kind === 'entity-local'
      ? typeof frame.entityId === 'string' ? frame.entityId : null
      : null);
  }
  validateDirectedCycles(entityIds, (id) => entityDependency.get(id) ?? null, 'entity', issues);

  if (phases.length === 0) issues.push('phases must contain at least one phase');
  for (const { index, value } of phases) {
    const path = `phases[${index}]`;
    requireString(value, 'title', path, issues);
    requireString(value, 'narrative', path, issues);
    requireBoolean(value, 'contextOnly', path, issues);
    const phaseStart = requireFinite(value, 'startTimeSeconds', path, issues);
    const phaseEnd = requireFinite(value, 'endTimeSeconds', path, issues);
    if (phaseStart !== null && phaseEnd !== null && phaseEnd <= phaseStart) {
      issues.push(`${path}.endTimeSeconds must be after its start`);
    }
    const cueId = requireString(value, 'defaultCameraCueId', path, issues);
    if (cueId !== null && !cameraCueIds.has(cueId)) issues.push(`${path}.defaultCameraCueId references unknown cue '${cueId}'`);
    const rate = requireFinite(value, 'suggestedRate', path, issues);
    if (rate !== null && !RATES.has(rate)) issues.push(`${path}.suggestedRate is not a supported playback rate`);
    validateReferences(requireStringArray(value, 'claimIds', path, issues), claimIds, `${path}.claimIds`, 'claim', issues);
    if (index > 0) {
      const previous = phases[index - 1].value;
      const previousEnd = previous.endTimeSeconds;
      if (typeof previousEnd === 'number' && phaseStart !== null && phaseStart !== previousEnd) {
        const relation = phaseStart > previousEnd ? 'gap after' : 'overlaps';
        issues.push(`${path} ${relation} phases[${phases[index - 1].index}] at ${phaseStart}s`);
      }
    }
  }
  const firstPhase = phases[0]?.value;
  const lastPhase = phases[phases.length - 1]?.value;
  if (startTime !== null && typeof firstPhase?.startTimeSeconds === 'number' && firstPhase.startTimeSeconds !== startTime) {
    issues.push('first phase must start at mission.startTimeSeconds');
  }
  if (endTime !== null && typeof lastPhase?.endTimeSeconds === 'number' && lastPhase.endTimeSeconds !== endTime) {
    issues.push('final phase must end at mission.endTimeSeconds');
  }

  const eventById = new Map<string, AnyRecord>();
  let previousEventTime = -Infinity;
  for (const { index, value } of events) {
    const path = `events[${index}]`;
    if (typeof value.id === 'string') eventById.set(value.id, value);
    requireEnum(value, 'kind', path, EVENT_KINDS, issues);
    requireString(value, 'title', path, issues);
    optionalString(value, 'narrative', path, issues);
    requireFidelity(value, path, issues);
    const time = requireFinite(value, 'timeSeconds', path, issues);
    if (time !== null) {
      if (time < previousEventTime) issues.push(`${path}.timeSeconds must be in non-decreasing order`);
      previousEventTime = time;
      if (startTime !== null && endTime !== null && (time < startTime || time > endTime)) {
        issues.push(`${path}.timeSeconds must be within the mission timeline`);
      }
    }
    validateReferences(requireStringArray(value, 'entityIds', path, issues), entityIds, `${path}.entityIds`, 'entity', issues);
    validateReferences(requireStringArray(value, 'sourceIds', path, issues), sourceIds, `${path}.sourceIds`, 'source', issues);
  }

  const dockingChildIds = new Set<string>();
  const dockingParentByChild = new Map<string, string>();
  for (const { index, value } of dockings) {
    const path = `dockings[${index}]`;
    const childId = requireString(value, 'childEntityId', path, issues);
    const targetId = requireString(value, 'targetEntityId', path, issues);
    if (childId !== null && !entityIds.has(childId)) issues.push(`${path}.childEntityId references unknown entity '${childId}'`);
    if (targetId !== null && !entityIds.has(targetId)) issues.push(`${path}.targetEntityId references unknown entity '${targetId}'`);
    if (childId !== null && targetId !== null && childId === targetId) issues.push(`${path} cannot dock an entity to itself`);
    if (childId !== null) {
      if (dockingChildIds.has(childId)) issues.push(`${path}.childEntityId '${childId}' already has a docking definition`);
      dockingChildIds.add(childId);
      if (targetId !== null) dockingParentByChild.set(childId, targetId);
    }
    const softId = requireString(value, 'softCaptureEventId', path, issues);
    const hardId = requireString(value, 'hardDockEventId', path, issues);
    const soft = softId === null ? undefined : eventById.get(softId);
    const hard = hardId === null ? undefined : eventById.get(hardId);
    if (softId !== null && soft === undefined) issues.push(`${path}.softCaptureEventId references unknown event '${softId}'`);
    else if (soft?.kind !== 'soft-capture') issues.push(`${path}.softCaptureEventId must reference a soft-capture event`);
    if (hardId !== null && hard === undefined) issues.push(`${path}.hardDockEventId references unknown event '${hardId}'`);
    else if (hard?.kind !== 'hard-dock') issues.push(`${path}.hardDockEventId must reference a hard-dock event`);
    if (typeof soft?.timeSeconds === 'number' && typeof hard?.timeSeconds === 'number' && hard.timeSeconds < soft.timeSeconds) {
      issues.push(`${path} hard-dock event cannot precede soft capture`);
    }
    for (const [label, event] of [['soft-capture', soft], ['hard-dock', hard]] as const) {
      if (!Array.isArray(event?.entityIds) || childId === null || targetId === null) continue;
      if (!event.entityIds.includes(childId) || !event.entityIds.includes(targetId)) {
        issues.push(`${path} ${label} event must reference both '${childId}' and '${targetId}'`);
      }
    }
    requireVector(value.dockedPosition, `${path}.dockedPosition`, issues);
    requireUnitQuaternion(value.dockedAttitude, `${path}.dockedAttitude`, issues);
  }
  validateDirectedCycles(entityIds, (id) => dockingParentByChild.get(id) ?? null, 'docking', issues);

  for (const { index, value } of cameraCues) {
    const path = `cameraCues[${index}]`;
    requireString(value, 'label', path, issues);
    requireFidelity(value, path, issues);
    validateReferences(requireStringArray(value, 'sourceIds', path, issues), sourceIds, `${path}.sourceIds`, 'source', issues);
    const cueStart = optionalFinite(value, 'startTimeSeconds', path, issues);
    const cueEnd = optionalFinite(value, 'endTimeSeconds', path, issues);
    if ((cueStart === null) !== (cueEnd === null)) issues.push(`${path} must provide both time bounds or neither`);
    if (cueStart !== null && cueEnd !== null) {
      if (cueEnd <= cueStart) issues.push(`${path}.endTimeSeconds must be after its start`);
      if (startTime !== null && endTime !== null && (cueStart < startTime || cueEnd > endTime)) {
        issues.push(`${path} time range must stay within the mission timeline`);
      }
    }
    validateAnchor(value.anchor, `${path}.anchor`, frameIds, entityIds, issues);
    validateAnchor(value.lookAt, `${path}.lookAt`, frameIds, entityIds, issues);
    requireVector(value.offset, `${path}.offset`, issues);
    if (value.lookAtOffset !== undefined) requireVector(value.lookAtOffset, `${path}.lookAtOffset`, issues);
    if (value.up !== undefined) requireVector(value.up, `${path}.up`, issues, true);
    const fov = requireFinite(value, 'fieldOfViewRadians', path, issues);
    if (fov !== null && (fov <= 0 || fov >= Math.PI)) issues.push(`${path}.fieldOfViewRadians must be between 0 and pi`);
    if (value.transition !== 'cut' && value.transition !== 'ease') issues.push(`${path}.transition must be cut or ease`);
    const transitionDuration = optionalFinite(value, 'transitionDurationSeconds', path, issues);
    if (value.transition === 'ease' && (transitionDuration === null || transitionDuration <= 0)) {
      issues.push(`${path}.transitionDurationSeconds must be positive for an ease transition`);
    }
  }

  for (const { index, value } of layers) {
    const path = `layers[${index}]`;
    requireString(value, 'label', path, issues);
    requireBoolean(value, 'defaultVisible', path, issues);
    requireFidelity(value, path, issues);
    validateReferences(requireStringArray(value, 'sourceIds', path, issues), sourceIds, `${path}.sourceIds`, 'source', issues);
  }

  for (const { index, value } of telemetryChannels) {
    const path = `telemetryChannels[${index}]`;
    requireString(value, 'label', path, issues);
    const kind = requireEnum(value, 'kind', path, TELEMETRY_KINDS, issues);
    requireFidelity(value, path, issues);
    validateReferences(requireStringArray(value, 'sourceIds', path, issues), sourceIds, `${path}.sourceIds`, 'source', issues);
    const unit = value.unit;
    const expectedUnit = kind === 'elapsed-time' ? 's' : kind === 'range' ? 'm' : 'm/s';
    if (unit !== expectedUnit) issues.push(`${path}.unit must be '${expectedUnit}' for ${kind ?? 'this channel'}`);
    const entityId = optionalString(value, 'entityId', path, issues);
    const targetId = optionalString(value, 'relativeToEntityId', path, issues);
    if (kind === 'elapsed-time') {
      if (entityId !== null || targetId !== null) issues.push(`${path} elapsed-time must not reference entities`);
    } else if (kind !== null) {
      if (entityId === null || targetId === null) issues.push(`${path} requires entityId and relativeToEntityId`);
      if (entityId !== null && !entityIds.has(entityId)) issues.push(`${path}.entityId references unknown entity '${entityId}'`);
      if (targetId !== null && !entityIds.has(targetId)) issues.push(`${path}.relativeToEntityId references unknown entity '${targetId}'`);
      if (entityId !== null && entityId === targetId) issues.push(`${path} must compare two different entities`);
    }
  }

  // Silence an otherwise-unhelpful unused signal while retaining duplicate phase validation.
  void phaseIds;
  void trackIds;
  void eventIds;
  return issues;
}

export function assertValidMissionDefinition(input: unknown): asserts input is MissionDefinition {
  const issues = collectMissionValidationErrors(input);
  if (issues.length > 0) throw new MissionValidationError(issues);
}

export function validateMissionDefinition(input: unknown): MissionDefinition {
  assertValidMissionDefinition(input);
  return input;
}

export function isMissionPlaybackRate(value: number): value is MissionPlaybackRate {
  return RATES.has(value);
}
