import type { Situation } from '../sim/flight';
import type { GameMode } from '../sim/campaign';
import type { SurfaceKind } from '../sim/universe';

export const FLIGHT_DIRECTOR_MODEL = 'gpt-5.6-luna';
export const FLIGHT_DIRECTOR_SCHEMA_VERSION = 2 as const;

export const FLIGHT_DIRECTOR_PHASES = [
  'prelaunch',
  'atmospheric-ascent',
  'space-ascent',
  'coast-to-apoapsis',
  'circularization',
  'stable-orbit',
  'maneuver-prep',
  'maneuver-burn',
  'atmospheric-entry',
  'landing',
  'surface',
  'escape',
  'lost',
] as const;

export type FlightDirectorPhase = typeof FLIGHT_DIRECTOR_PHASES[number];

export const FLIGHT_DIRECTOR_OBJECTIVE_KINDS = [
  'launch',
  'stable-orbit',
  'science-return',
  'landing',
  'docking',
  'safe-flight',
] as const;

export type FlightDirectorObjectiveKind = typeof FLIGHT_DIRECTOR_OBJECTIVE_KINDS[number];

export const FLIGHT_DIRECTOR_EVIDENCE_KEYS = [
  'mission.objective',
  'mission.objectiveAchieved',
  'phase.situation',
  'phase.flightPhase',
  'currentBody.surfaceGravityMps2',
  'currentBody.atmosphereTopMeters',
  'vessel.fuelFraction',
  'vessel.chargeFraction',
  'vessel.stageDeltaVMps',
  'vessel.totalDeltaVMps',
  'vessel.stageTwr',
  'flight.altitudeAslMeters',
  'flight.verticalSpeedMps',
  'flight.horizontalSpeedMps',
  'flight.dynamicPressurePa',
  'flight.properG',
  'orbit.apoapsisMeters',
  'orbit.periapsisMeters',
  'orbit.timeToApoapsisSeconds',
  'orbit.apoapsisMarginMeters',
  'orbit.periapsisMarginMeters',
  'orbit.stable',
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
  'prepare-launch',
  'ignite-and-liftoff',
  'begin-gravity-turn',
  'hold-ascent',
  'cut-throttle',
  'coast-to-apoapsis',
  'circularize',
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
    flightId: string;
    elapsedSeconds: number;
    mode: GameMode;
    objectiveId: string;
    objective: string;
    objectiveSource: 'contract' | 'default';
    objectiveKind: FlightDirectorObjectiveKind;
    objectiveAchieved: boolean;
    targetBodyId: string | null;
    activeObjectives: string[];
  };
  phase: {
    situation: Situation;
    regime: 'active' | 'rails';
    flightPhase: FlightDirectorPhase;
    priority: 'safety' | 'mission' | 'efficiency';
    allowedActions: FlightDirectorActionId[];
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
    stageTwr: number | null;
    currentStageHasThrust: boolean;
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
    stable: boolean;
    targetMinimumPeriapsisMeters: number;
    apoapsisMarginMeters: number | null;
    periapsisMarginMeters: number;
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
  continuity: {
    previousActionId: FlightDirectorActionId;
    previousFlightPhase: FlightDirectorPhase;
    ageSeconds: number;
  } | null;
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
  if (!record(value) || value.schemaVersion !== 2 || value.requestType !== 'flight-briefing') return false;
  const mission = value.mission;
  const phase = value.phase;
  const vessel = value.vessel;
  const flight = value.flight;
  const orbit = value.orbit;
  const maneuver = value.maneuver;
  const entry = value.entry;
  const comms = value.comms;
  const continuity = value.continuity;
  if (!record(mission) || !record(phase) || !record(vessel) || !record(flight)
    || !record(orbit) || !record(comms)) return false;
  if (!shortString(mission.flightId, 96) || !finite(mission.elapsedSeconds, 0, 1e12)
    || !['sandbox', 'exploration', 'program'].includes(String(mission.mode))
    || !shortString(mission.objectiveId, 96) || !shortString(mission.objective, 180)
    || !['contract', 'default'].includes(String(mission.objectiveSource))
    || !FLIGHT_DIRECTOR_OBJECTIVE_KINDS.includes(mission.objectiveKind as FlightDirectorObjectiveKind)
    || typeof mission.objectiveAchieved !== 'boolean'
    || !nullableShortString(mission.targetBodyId, 48)
    || !Array.isArray(mission.activeObjectives) || mission.activeObjectives.length > 3
    || !mission.activeObjectives.every((objective) => shortString(objective, 180))) return false;
  if (!['prelaunch', 'landed', 'splashed', 'flying', 'suborbital', 'orbit', 'escaping', 'destroyed'].includes(String(phase.situation))
    || !['active', 'rails'].includes(String(phase.regime))
    || !FLIGHT_DIRECTOR_PHASES.includes(phase.flightPhase as FlightDirectorPhase)
    || !['safety', 'mission', 'efficiency'].includes(String(phase.priority))
    || !Array.isArray(phase.allowedActions) || phase.allowedActions.length < 1
    || phase.allowedActions.length > 8
    || !phase.allowedActions.every((action) => FLIGHT_DIRECTOR_ACTION_IDS.includes(action as FlightDirectorActionId))
    || new Set(phase.allowedActions).size !== phase.allowedActions.length) return false;
  if (!bodySnapshot(value.currentBody) || !(value.targetBody === null || bodySnapshot(value.targetBody))) return false;
  if (!finite(vessel.crewCount, 0, 100) || typeof vessel.controllable !== 'boolean'
    || !finite(vessel.currentStage, 0, 100) || !finite(vessel.stagesRemaining, 0, 100)
    || !finite(vessel.throttle, 0, 1) || !shortString(vessel.sasMode, 32)
    || typeof vessel.rcsEnabled !== 'boolean' || !finite(vessel.massKg, 0, 1e10)
    || !nullableFinite(vessel.stageDeltaVMps, 0, 1e8) || !finite(vessel.totalDeltaVMps, 0, 1e8)
    || !nullableFinite(vessel.stageTwr, 0, 1e6) || typeof vessel.currentStageHasThrust !== 'boolean'
    || !nullableFinite(vessel.fuelFraction, 0, 1.01) || !nullableFinite(vessel.chargeFraction, 0, 1.01)
    || !nullableFinite(vessel.monopropFraction, 0, 1.01)) return false;
  if (!finite(flight.altitudeAslMeters, -1e9, 1e13) || !finite(flight.verticalSpeedMps, -1e9, 1e9)
    || !finite(flight.horizontalSpeedMps, 0, 1e9) || !finite(flight.properG, 0, 1e6)
    || !finite(flight.dynamicPressurePa, 0, 1e12) || typeof flight.insideAtmosphere !== 'boolean') return false;
  if (typeof orbit.bound !== 'boolean' || !nullableFinite(orbit.apoapsisMeters, -1e9, 1e14)
    || !finite(orbit.periapsisMeters, -1e9, 1e14) || !nullableFinite(orbit.timeToApoapsisSeconds, 0, 1e12)
    || !finite(orbit.eccentricity, 0, 1e6) || !finite(orbit.inclinationDegrees, 0, 180.0001)
    || typeof orbit.stable !== 'boolean' || !finite(orbit.targetMinimumPeriapsisMeters, 0, 1e9)
    || !nullableFinite(orbit.apoapsisMarginMeters, -1e14, 1e14)
    || !finite(orbit.periapsisMarginMeters, -1e14, 1e14)) return false;
  if (maneuver !== null && (!record(maneuver) || !finite(maneuver.secondsUntilNode, -1e9, 1e12)
    || !finite(maneuver.secondsUntilBurnStart, -1e9, 1e12) || !finite(maneuver.remainingDeltaVMps, 0, 1e8)
    || !finite(maneuver.estimatedBurnSeconds, 0, 1e9))) return false;
  if (entry !== null && (!record(entry) || typeof entry.willEnter !== 'boolean' || typeof entry.lands !== 'boolean'
    || !nullableFinite(entry.secondsUntilLanding, 0, 1e12)
    || !nullableFinite(entry.predictedImpactSpeedMps, 0, 1e9) || !nullableFinite(entry.peakG, 0, 1e6))) return false;
  if (typeof comms.connected !== 'boolean' || !finite(comms.strength, 0, 1.01)
    || typeof comms.controlBlocked !== 'boolean') return false;
  if (continuity !== null && (!record(continuity)
    || !FLIGHT_DIRECTOR_ACTION_IDS.includes(continuity.previousActionId as FlightDirectorActionId)
    || !FLIGHT_DIRECTOR_PHASES.includes(continuity.previousFlightPhase as FlightDirectorPhase)
    || !finite(continuity.ageSeconds, 0, 1e12))) return false;
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
    'mission.objective', 'mission.objectiveAchieved', 'phase.situation', 'phase.flightPhase',
    'currentBody.surfaceGravityMps2', 'vessel.totalDeltaVMps',
    'flight.altitudeAslMeters', 'flight.verticalSpeedMps', 'flight.horizontalSpeedMps',
    'flight.dynamicPressurePa', 'flight.properG', 'orbit.periapsisMeters',
    'orbit.periapsisMarginMeters', 'orbit.stable', 'comms.connected',
  ]);
  if (snapshot.currentBody.hasAtmosphere) keys.add('currentBody.atmosphereTopMeters');
  if (snapshot.vessel.fuelFraction !== null) keys.add('vessel.fuelFraction');
  if (snapshot.vessel.chargeFraction !== null) keys.add('vessel.chargeFraction');
  if (snapshot.vessel.stageDeltaVMps !== null) keys.add('vessel.stageDeltaVMps');
  if (snapshot.vessel.stageTwr !== null) keys.add('vessel.stageTwr');
  if (snapshot.orbit.apoapsisMeters !== null) keys.add('orbit.apoapsisMeters');
  if (snapshot.orbit.apoapsisMarginMeters !== null) keys.add('orbit.apoapsisMarginMeters');
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
