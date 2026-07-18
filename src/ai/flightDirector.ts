import type { Situation } from '../sim/flight';
import type { GameMode } from '../sim/campaign';
import type { SurfaceKind } from '../sim/universe';

export const FLIGHT_DIRECTOR_MODEL = 'gpt-5.6-luna';
export const FLIGHT_DIRECTOR_SCHEMA_VERSION = 1 as const;

export const FLIGHT_DIRECTOR_EVIDENCE_KEYS = [
  'mission.objective',
  'phase.situation',
  'currentBody.surfaceGravityMps2',
  'currentBody.atmosphereTopMeters',
  'vessel.fuelFraction',
  'vessel.chargeFraction',
  'vessel.stageDeltaVMps',
  'vessel.totalDeltaVMps',
  'flight.altitudeAslMeters',
  'flight.verticalSpeedMps',
  'flight.horizontalSpeedMps',
  'flight.dynamicPressurePa',
  'flight.properG',
  'orbit.apoapsisMeters',
  'orbit.periapsisMeters',
  'orbit.timeToApoapsisSeconds',
  'maneuver.secondsUntilBurnStart',
  'maneuver.remainingDeltaVMps',
  'entry.predictedImpactSpeedMps',
  'entry.peakG',
  'comms.connected',
] as const;

export type FlightDirectorEvidenceKey = typeof FLIGHT_DIRECTOR_EVIDENCE_KEYS[number];

export const FLIGHT_DIRECTOR_ACTION_IDS = [
  'none',
  'hold',
  'throttle-down',
  'throttle-up',
  'stage-when-ready',
  'orient-to-node',
  'begin-burn',
  'raise-periapsis',
  'lower-periapsis',
  'prepare-entry',
  'prepare-landing',
  'restore-comms',
  'conserve-power',
  'review-map',
] as const;

export type FlightDirectorActionId = typeof FLIGHT_DIRECTOR_ACTION_IDS[number];
export type FlightDirectorTone = 'info' | 'warning' | 'success' | 'danger';

interface BodySnapshot {
  id: string;
  name: string;
  parentId: string | null;
  surfaceKind: SurfaceKind;
  surfaceGravityMps2: number;
  hasAtmosphere: boolean;
  atmosphereTopMeters: number;
}

export interface FlightDirectorSnapshot {
  schemaVersion: typeof FLIGHT_DIRECTOR_SCHEMA_VERSION;
  requestType: 'flight-briefing';
  mission: {
    elapsedSeconds: number;
    mode: GameMode;
    objective: string | null;
  };
  phase: {
    situation: Situation;
    regime: 'active' | 'rails';
  };
  currentBody: BodySnapshot;
  targetBody: BodySnapshot | null;
  vessel: {
    crewCount: number;
    controllable: boolean;
    currentStage: number;
    stagesRemaining: number;
    throttle: number;
    sasMode: string;
    rcsEnabled: boolean;
    massKg: number;
    stageDeltaVMps: number | null;
    totalDeltaVMps: number;
    fuelFraction: number | null;
    chargeFraction: number | null;
    monopropFraction: number | null;
  };
  flight: {
    altitudeAslMeters: number;
    verticalSpeedMps: number;
    horizontalSpeedMps: number;
    properG: number;
    dynamicPressurePa: number;
    insideAtmosphere: boolean;
  };
  orbit: {
    bound: boolean;
    apoapsisMeters: number | null;
    periapsisMeters: number;
    timeToApoapsisSeconds: number | null;
    eccentricity: number;
    inclinationDegrees: number;
  };
  maneuver: {
    secondsUntilNode: number;
    secondsUntilBurnStart: number;
    remainingDeltaVMps: number;
    estimatedBurnSeconds: number;
  } | null;
  entry: {
    willEnter: boolean;
    lands: boolean;
    secondsUntilLanding: number | null;
    predictedImpactSpeedMps: number | null;
    peakG: number | null;
  } | null;
  comms: {
    connected: boolean;
    strength: number;
    controlBlocked: boolean;
  };
  recentEvents: Array<{
    ageSeconds: number;
    severity: 'info' | 'warning' | 'danger';
    text: string;
  }>;
}

export interface FlightDirectorAdvisory {
  tone: FlightDirectorTone;
  headline: string;
  summary: string;
  evidenceKeys: FlightDirectorEvidenceKey[];
  nextAction: {
    actionId: FlightDirectorActionId;
    instruction: string;
    timing: string;
  };
  warnings: string[];
  unknowns: string[];
}

interface FlightDirectorApiEnvelope {
  ok: boolean;
  data?: { advisory?: unknown; model?: unknown; cached?: unknown };
  error?: { code?: unknown; message?: unknown; requestId?: unknown };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function nullableFinite(value: unknown, min: number, max: number): boolean {
  return value === null || finite(value, min, max);
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function nullableShortString(value: unknown, max: number): boolean {
  return value === null || shortString(value, max);
}

function bodySnapshot(value: unknown): value is BodySnapshot {
  if (!record(value)) return false;
  return shortString(value.id, 48)
    && shortString(value.name, 64)
    && nullableShortString(value.parentId, 48)
    && ['solid', 'gas', 'star'].includes(String(value.surfaceKind))
    && finite(value.surfaceGravityMps2, 0, 1_000)
    && typeof value.hasAtmosphere === 'boolean'
    && finite(value.atmosphereTopMeters, 0, 10_000_000);
}

export function isFlightDirectorSnapshot(value: unknown): value is FlightDirectorSnapshot {
  if (!record(value) || value.schemaVersion !== 1 || value.requestType !== 'flight-briefing') return false;
  const mission = value.mission;
  const phase = value.phase;
  const vessel = value.vessel;
  const flight = value.flight;
  const orbit = value.orbit;
  const maneuver = value.maneuver;
  const entry = value.entry;
  const comms = value.comms;
  if (!record(mission) || !record(phase) || !record(vessel) || !record(flight)
    || !record(orbit) || !record(comms)) return false;
  if (!finite(mission.elapsedSeconds, 0, 1e12)
    || !['sandbox', 'exploration', 'program'].includes(String(mission.mode))
    || !nullableShortString(mission.objective, 180)) return false;
  if (!['prelaunch', 'landed', 'splashed', 'flying', 'suborbital', 'orbit', 'escaping', 'destroyed'].includes(String(phase.situation))
    || !['active', 'rails'].includes(String(phase.regime))) return false;
  if (!bodySnapshot(value.currentBody) || !(value.targetBody === null || bodySnapshot(value.targetBody))) return false;
  if (!finite(vessel.crewCount, 0, 100) || typeof vessel.controllable !== 'boolean'
    || !finite(vessel.currentStage, 0, 100) || !finite(vessel.stagesRemaining, 0, 100)
    || !finite(vessel.throttle, 0, 1) || !shortString(vessel.sasMode, 32)
    || typeof vessel.rcsEnabled !== 'boolean' || !finite(vessel.massKg, 0, 1e10)
    || !nullableFinite(vessel.stageDeltaVMps, 0, 1e8) || !finite(vessel.totalDeltaVMps, 0, 1e8)
    || !nullableFinite(vessel.fuelFraction, 0, 1.01) || !nullableFinite(vessel.chargeFraction, 0, 1.01)
    || !nullableFinite(vessel.monopropFraction, 0, 1.01)) return false;
  if (!finite(flight.altitudeAslMeters, -1e9, 1e13) || !finite(flight.verticalSpeedMps, -1e9, 1e9)
    || !finite(flight.horizontalSpeedMps, 0, 1e9) || !finite(flight.properG, 0, 1e6)
    || !finite(flight.dynamicPressurePa, 0, 1e12) || typeof flight.insideAtmosphere !== 'boolean') return false;
  if (typeof orbit.bound !== 'boolean' || !nullableFinite(orbit.apoapsisMeters, -1e9, 1e14)
    || !finite(orbit.periapsisMeters, -1e9, 1e14) || !nullableFinite(orbit.timeToApoapsisSeconds, 0, 1e12)
    || !finite(orbit.eccentricity, 0, 1e6) || !finite(orbit.inclinationDegrees, 0, 180.0001)) return false;
  if (maneuver !== null && (!record(maneuver) || !finite(maneuver.secondsUntilNode, -1e9, 1e12)
    || !finite(maneuver.secondsUntilBurnStart, -1e9, 1e12) || !finite(maneuver.remainingDeltaVMps, 0, 1e8)
    || !finite(maneuver.estimatedBurnSeconds, 0, 1e9))) return false;
  if (entry !== null && (!record(entry) || typeof entry.willEnter !== 'boolean' || typeof entry.lands !== 'boolean'
    || !nullableFinite(entry.secondsUntilLanding, 0, 1e12)
    || !nullableFinite(entry.predictedImpactSpeedMps, 0, 1e9) || !nullableFinite(entry.peakG, 0, 1e6))) return false;
  if (typeof comms.connected !== 'boolean' || !finite(comms.strength, 0, 1.01)
    || typeof comms.controlBlocked !== 'boolean') return false;
  if (!Array.isArray(value.recentEvents) || value.recentEvents.length > 3) return false;
  return value.recentEvents.every((event) => record(event)
    && finite(event.ageSeconds, 0, 1e12)
    && ['info', 'warning', 'danger'].includes(String(event.severity))
    && shortString(event.text, 180));
}

export function isFlightDirectorAdvisory(value: unknown): value is FlightDirectorAdvisory {
  if (!record(value) || !['info', 'warning', 'success', 'danger'].includes(String(value.tone))
    || !shortString(value.headline, 72) || !shortString(value.summary, 320)
    || !Array.isArray(value.evidenceKeys) || value.evidenceKeys.length < 1 || value.evidenceKeys.length > 4
    || !value.evidenceKeys.every((key) => FLIGHT_DIRECTOR_EVIDENCE_KEYS.includes(key as FlightDirectorEvidenceKey))
    || new Set(value.evidenceKeys).size !== value.evidenceKeys.length
    || !record(value.nextAction) || !FLIGHT_DIRECTOR_ACTION_IDS.includes(value.nextAction.actionId as FlightDirectorActionId)
    || !shortString(value.nextAction.instruction, 180) || !shortString(value.nextAction.timing, 80)
    || !Array.isArray(value.warnings) || value.warnings.length > 3
    || !value.warnings.every((warning) => shortString(warning, 140))
    || !Array.isArray(value.unknowns) || value.unknowns.length > 3
    || !value.unknowns.every((unknown) => shortString(unknown, 140))) return false;
  return true;
}

export function availableFlightDirectorEvidence(snapshot: FlightDirectorSnapshot): Set<FlightDirectorEvidenceKey> {
  const keys = new Set<FlightDirectorEvidenceKey>([
    'phase.situation', 'currentBody.surfaceGravityMps2', 'vessel.totalDeltaVMps',
    'flight.altitudeAslMeters', 'flight.verticalSpeedMps', 'flight.horizontalSpeedMps',
    'flight.dynamicPressurePa', 'flight.properG', 'orbit.periapsisMeters', 'comms.connected',
  ]);
  if (snapshot.mission.objective !== null) keys.add('mission.objective');
  if (snapshot.currentBody.hasAtmosphere) keys.add('currentBody.atmosphereTopMeters');
  if (snapshot.vessel.fuelFraction !== null) keys.add('vessel.fuelFraction');
  if (snapshot.vessel.chargeFraction !== null) keys.add('vessel.chargeFraction');
  if (snapshot.vessel.stageDeltaVMps !== null) keys.add('vessel.stageDeltaVMps');
  if (snapshot.orbit.apoapsisMeters !== null) keys.add('orbit.apoapsisMeters');
  if (snapshot.orbit.timeToApoapsisSeconds !== null) keys.add('orbit.timeToApoapsisSeconds');
  if (snapshot.maneuver) {
    keys.add('maneuver.secondsUntilBurnStart');
    keys.add('maneuver.remainingDeltaVMps');
  }
  if (snapshot.entry?.predictedImpactSpeedMps !== null && snapshot.entry?.predictedImpactSpeedMps !== undefined) {
    keys.add('entry.predictedImpactSpeedMps');
  }
  if (snapshot.entry?.peakG !== null && snapshot.entry?.peakG !== undefined) keys.add('entry.peakG');
  return keys;
}

export class FlightDirectorRequestError extends Error {
  constructor(readonly userMessage: string, readonly code = 'AI_UNAVAILABLE') {
    super(userMessage);
  }
}

export async function requestFlightDirector(
  snapshot: FlightDirectorSnapshot,
  fetchImpl: typeof fetch = fetch,
): Promise<FlightDirectorAdvisory> {
  const response = await fetchImpl('/api/flight-director', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  });
  let envelope: FlightDirectorApiEnvelope | null = null;
  try {
    envelope = await response.json() as FlightDirectorApiEnvelope;
  } catch {
    // The public error below stays stable even when an upstream proxy emits HTML.
  }
  if (!response.ok || !envelope?.ok) {
    const message = typeof envelope?.error?.message === 'string'
      ? envelope.error.message
      : 'Pip could not reach flight control. Local guidance is still active.';
    const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : 'AI_UNAVAILABLE';
    throw new FlightDirectorRequestError(message, code);
  }
  if (!isFlightDirectorAdvisory(envelope.data?.advisory)) {
    throw new FlightDirectorRequestError('Pip received an unreadable briefing. Local guidance is still active.');
  }
  return envelope.data.advisory;
}
