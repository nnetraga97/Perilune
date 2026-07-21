import { Vec3 } from '../core/vec3';
import { apoapsisOf, periapsisOf, stateToElements, timeToTrueAnomaly } from '../core/orbit';
import type {
  FlightDirectorActionId,
  FlightDirectorObjectiveKind,
  FlightDirectorPhase,
  FlightDirectorSnapshot,
} from '../ai/flightDirector';
import { FLIGHT_DIRECTOR_SCHEMA_VERSION } from '../ai/flightDirector';
import { CONTRACTS, type ContractDef } from '../sim/campaign';
import type { CommsStatus } from '../sim/comms';
import type { EntryPrediction } from '../sim/entry';
import type { ManeuverNode } from '../sim/maneuver';
import { estimateBurnTime, nodeDeltaV } from '../sim/maneuver';
import { surfaceVelocity } from '../sim/bodyOrientation';
import type { GameState } from '../sim/state';
import type { Body } from '../sim/universe';
import { G0, analyzeCraft, defOf } from '../sim/vessel';

export interface FlightDirectorTelemetryInput {
  nodeRemainingDv: number;
  entryPrediction: EntryPrediction | null;
}

export interface PreviousFlightDirectorDecision {
  vesselId: string;
  issuedAt: number;
  actionId: FlightDirectorActionId;
  flightPhase: FlightDirectorPhase;
}

interface ResolvedMissionObjective {
  id: string;
  text: string;
  source: 'contract' | 'default';
  kind: FlightDirectorObjectiveKind;
  targetBodyId: string | null;
  achievement: string | null;
}

const CONTRACT_CONTEXT: Readonly<Record<string, {
  kind: FlightDirectorObjectiveKind;
  targetBodyId: string | null;
}>> = {
  'first-launch': { kind: 'launch', targetBodyId: 'veyra' },
  'veyra-orbit': { kind: 'stable-orbit', targetBodyId: 'veyra' },
  'science-return': { kind: 'science-return', targetBodyId: 'veyra' },
  'palla-landing': { kind: 'landing', targetBodyId: 'palla' },
  'first-docking': { kind: 'docking', targetBodyId: null },
  'outer-moon-landing': { kind: 'landing', targetBodyId: null },
};

function contractRelevance(
  contract: ContractDef,
  currentBodyId: string,
  selectedTargetId: string | null,
  situation: FlightDirectorSnapshot['phase']['situation'],
): number {
  const context = CONTRACT_CONTEXT[contract.id];
  let score = 0;
  if (context?.targetBodyId === currentBodyId) score += 4;
  if (context?.targetBodyId === selectedTargetId) score += 3;
  if (contract.id === 'veyra-orbit' && ['prelaunch', 'flying', 'suborbital', 'orbit'].includes(situation)) score += 5;
  if (contract.id === 'science-return' && ['landed', 'splashed'].includes(situation)) score += 5;
  if (contract.id === 'first-launch' && situation === 'prelaunch') score += 6;
  if (contract.id === 'outer-moon-landing' && ['brimm', 'glacia', 'mote'].includes(currentBodyId)) score += 4;
  return score;
}

function resolveMissionObjective(
  game: GameState,
  currentBodyId: string,
  selectedTargetId: string | null,
  situation: FlightDirectorSnapshot['phase']['situation'],
): { primary: ResolvedMissionObjective; activeObjectives: string[] } {
  const active = game.campaign.activeContracts
    .map((id) => CONTRACTS.find((contract) => contract.id === id))
    .filter((contract): contract is ContractDef => Boolean(contract))
    .filter((contract) => !game.flags[contract.achievement]);
  const primaryContract = active
    .map((contract, index) => ({
      contract,
      index,
      score: contractRelevance(contract, currentBodyId, selectedTargetId, situation),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.contract;
  if (primaryContract) {
    const context = CONTRACT_CONTEXT[primaryContract.id] ?? { kind: 'safe-flight' as const, targetBodyId: selectedTargetId };
    return {
      primary: {
        id: primaryContract.id,
        text: primaryContract.brief,
        source: 'contract',
        kind: context.kind,
        targetBodyId: context.targetBodyId,
        achievement: primaryContract.achievement,
      },
      activeObjectives: active.slice(0, 3).map((contract) => contract.brief),
    };
  }
  if (currentBodyId === 'veyra') {
    return {
      primary: {
        id: 'default-veyra-orbit',
        text: 'Place the active vessel into a stable orbit around Veyra.',
        source: 'default',
        kind: 'stable-orbit',
        targetBodyId: 'veyra',
        achievement: null,
      },
      activeObjectives: [],
    };
  }
  if (selectedTargetId) {
    return {
      primary: {
        id: 'default-targeted-flight',
        text: `Navigate safely toward ${game.universe.get(selectedTargetId).name}.`,
        source: 'default',
        kind: 'safe-flight',
        targetBodyId: selectedTargetId,
        achievement: null,
      },
      activeObjectives: [],
    };
  }
  return {
    primary: {
      id: 'default-safe-flight',
      text: `Maintain a safe, controllable flight around ${game.universe.get(currentBodyId).name}.`,
      source: 'default',
      kind: 'safe-flight',
      targetBodyId: currentBodyId,
      achievement: null,
    },
    activeObjectives: [],
  };
}

function objectiveAchieved(
  objective: ResolvedMissionObjective,
  game: GameState,
  currentBodyId: string,
  stableOrbit: boolean,
  situation: FlightDirectorSnapshot['phase']['situation'],
): boolean {
  if (objective.achievement && game.flags[objective.achievement]) return true;
  if (objective.kind === 'stable-orbit') return currentBodyId === objective.targetBodyId && stableOrbit;
  if (objective.kind === 'launch') return situation !== 'prelaunch';
  if (objective.kind === 'landing') {
    return objective.targetBodyId !== null && objective.targetBodyId === currentBodyId
      && (situation === 'landed' || situation === 'splashed');
  }
  return false;
}

function flightPhase(
  snapshot: {
    situation: FlightDirectorSnapshot['phase']['situation'];
    insideAtmosphere: boolean;
    stableOrbit: boolean;
    apoapsisMarginMeters: number | null;
    timeToApoapsisSeconds: number | null;
    maneuver: FlightDirectorSnapshot['maneuver'];
    entry: FlightDirectorSnapshot['entry'];
  },
): FlightDirectorPhase {
  if (snapshot.situation === 'destroyed') return 'lost';
  if (snapshot.situation === 'escaping') return 'escape';
  if (snapshot.entry?.willEnter) {
    if (snapshot.entry.lands && snapshot.entry.secondsUntilLanding !== null && snapshot.entry.secondsUntilLanding <= 45) return 'landing';
    return 'atmospheric-entry';
  }
  if (snapshot.situation === 'landed' || snapshot.situation === 'splashed') return 'surface';
  if (snapshot.situation === 'prelaunch') return 'prelaunch';
  if (snapshot.maneuver) {
    return snapshot.maneuver.secondsUntilBurnStart <= 10
      && snapshot.maneuver.secondsUntilBurnStart >= -snapshot.maneuver.estimatedBurnSeconds
      ? 'maneuver-burn'
      : 'maneuver-prep';
  }
  if (snapshot.stableOrbit) return 'stable-orbit';
  if (snapshot.situation === 'orbit') return 'circularization';
  if (snapshot.situation === 'suborbital') {
    if (snapshot.apoapsisMarginMeters !== null && snapshot.apoapsisMarginMeters >= 0) {
      return snapshot.timeToApoapsisSeconds !== null && snapshot.timeToApoapsisSeconds <= 25
        ? 'circularization'
        : 'coast-to-apoapsis';
    }
    return 'space-ascent';
  }
  return snapshot.insideAtmosphere ? 'atmospheric-ascent' : 'space-ascent';
}

function allowedActionsFor(
  phase: FlightDirectorPhase,
  priority: FlightDirectorSnapshot['phase']['priority'],
  controlBlocked: boolean,
): FlightDirectorActionId[] {
  if (phase === 'lost') return ['none'];
  if (controlBlocked) return ['restore-comms', 'hold'];
  if (priority === 'safety') {
    if (phase === 'atmospheric-entry') return ['prepare-entry', 'throttle-down', 'hold'];
    if (phase === 'landing') return ['prepare-landing', 'throttle-down', 'hold'];
    return ['throttle-down', 'hold'];
  }
  switch (phase) {
    case 'prelaunch': return ['prepare-launch', 'ignite-and-liftoff', 'hold'];
    case 'atmospheric-ascent': return ['begin-gravity-turn', 'hold-ascent', 'throttle-up', 'throttle-down', 'stage-when-ready'];
    case 'space-ascent': return ['hold-ascent', 'cut-throttle', 'throttle-up', 'stage-when-ready'];
    case 'coast-to-apoapsis': return ['coast-to-apoapsis', 'hold', 'review-map'];
    case 'circularization': return ['circularize', 'raise-periapsis', 'stage-when-ready', 'hold'];
    case 'stable-orbit': return ['none', 'hold', 'review-map'];
    case 'maneuver-prep': return ['orient-to-node', 'hold', 'review-map'];
    case 'maneuver-burn': return ['begin-burn', 'stage-when-ready', 'hold'];
    case 'atmospheric-entry': return ['prepare-entry', 'hold'];
    case 'landing': return ['prepare-landing', 'throttle-down', 'hold'];
    case 'surface': return ['none', 'hold', 'review-map'];
    case 'escape': return ['review-map', 'hold', 'lower-periapsis'];
  }
}

function fraction(amount: number, capacity: number): number | null {
  if (!(capacity > 0)) return null;
  return Math.max(0, Math.min(1, amount / capacity));
}

function bodySnapshot(body: Body) {
  return {
    id: body.id,
    name: body.name,
    parentId: body.parent?.id ?? null,
    surfaceKind: body.def.surfaceKind,
    surfaceGravityMps2: body.surfaceGravity,
    hasAtmosphere: body.hasAtmosphere(),
    atmosphereTopMeters: body.def.atmosphere?.height ?? 0,
  };
}

export function buildFlightDirectorSnapshot(
  game: GameState,
  missionStart: number,
  node: ManeuverNode | null,
  telemetry: FlightDirectorTelemetryInput,
  comms: CommsStatus,
  controlBlocked: boolean,
  previousDecision: PreviousFlightDirectorDecision | null = null,
): FlightDirectorSnapshot | null {
  const gv = game.active;
  if (!gv) return null;
  const vessel = gv.runtime;
  const body = game.bodyOf(gv);
  const altitude = vessel.pos.length() - body.radius;
  const relativeVelocity = vessel.vel.clone().sub(surfaceVelocity(body, vessel.pos, new Vec3()));
  const verticalSpeed = relativeVelocity.dot(vessel.pos.clone().normalize());
  const horizontalSpeed = Math.sqrt(Math.max(0, relativeVelocity.lengthSq() - verticalSpeed * verticalSpeed));
  const elements = stateToElements(body.mu, vessel.pos, vessel.vel, game.time);
  const bound = elements.e < 1;
  const analysis = analyzeCraft(
    vessel.craft,
    body.surfaceGravity,
    body.pressureAt(altitude),
    game.flightTuning,
    body.def.atmosphere?.seaLevelPressure,
  );
  const stage = analysis.stages[vessel.currentStage] ?? null;
  const totalDeltaV = analysis.stages
    .filter((candidate) => candidate.stageIndex >= vessel.currentStage)
    .reduce((sum, candidate) => sum + candidate.deltaV, 0);
  let fuel = 0;
  let fuelCapacity = 0;
  let monoprop = 0;
  let monopropCapacity = 0;
  for (const part of vessel.craft.parts) {
    fuel += part.resources.propellant ?? 0;
    monoprop += part.resources.monoprop ?? 0;
    const definition = defOf(part);
    fuelCapacity += definition.resources?.propellant ?? 0;
    monopropCapacity += definition.resources?.monoprop ?? 0;
  }
  const targetBody = gv.target ? game.universe.get(gv.target) : null;
  const remainingNodeDv = node ? Math.max(0, telemetry.nodeRemainingDv || nodeDeltaV(node)) : 0;
  let burnSeconds = 0;
  if (node) {
    const candidates = analysis.stages.filter((candidate) => candidate.thrust > 0);
    const burnStage = candidates.find((candidate) => candidate.stageIndex >= vessel.currentStage)
      ?? [...candidates].reverse().find((candidate) => candidate.stageIndex < vessel.currentStage);
    if (burnStage) burnSeconds = estimateBurnTime(remainingNodeDv, burnStage.thrust, vessel.massProps.mass, burnStage.isp);
  }
  const prediction = telemetry.entryPrediction?.willEnter ? telemetry.entryPrediction : null;
  const apoapsisMeters = bound ? apoapsisOf(elements) - body.radius : null;
  const periapsisMeters = periapsisOf(elements) - body.radius;
  const targetMinimumPeriapsisMeters = body.def.atmosphere?.height ?? 0;
  const apoapsisMarginMeters = apoapsisMeters === null ? null : apoapsisMeters - targetMinimumPeriapsisMeters;
  const periapsisMarginMeters = periapsisMeters - targetMinimumPeriapsisMeters;
  const stableOrbit = bound && vessel.situation === 'orbit' && periapsisMarginMeters >= 0;
  const resolvedMission = resolveMissionObjective(game, body.id, targetBody?.id ?? null, vessel.situation);
  const maneuverSnapshot: FlightDirectorSnapshot['maneuver'] = node ? {
    secondsUntilNode: node.time - game.time,
    secondsUntilBurnStart: node.time - game.time - burnSeconds / 2,
    remainingDeltaVMps: remainingNodeDv,
    estimatedBurnSeconds: Math.max(0, burnSeconds),
  } : null;
  const entrySnapshot: FlightDirectorSnapshot['entry'] = prediction ? {
    willEnter: prediction.willEnter,
    lands: prediction.lands,
    secondsUntilLanding: prediction.lands ? Math.max(0, prediction.landingTime - game.time) : null,
    predictedImpactSpeedMps: prediction.lands ? Math.max(0, prediction.impactSpeed) : null,
    peakG: Number.isFinite(prediction.peakG) ? Math.max(0, prediction.peakG) : null,
  } : null;
  const resolvedFlightPhase = flightPhase({
    situation: vessel.situation,
    insideAtmosphere: body.hasAtmosphere() && altitude < targetMinimumPeriapsisMeters,
    stableOrbit,
    apoapsisMarginMeters,
    timeToApoapsisSeconds: bound ? Math.max(0, timeToTrueAnomaly(elements, game.time, Math.PI)) : null,
    maneuver: maneuverSnapshot,
    entry: entrySnapshot,
  });
  const missionAchieved = objectiveAchieved(
    resolvedMission.primary,
    game,
    body.id,
    stableOrbit,
    vessel.situation,
  );
  const stageTwr = stage && stage.thrust > 0 ? stage.thrust / (Math.max(1, vessel.massProps.mass) * body.surfaceGravity) : null;
  const hardArrival = entrySnapshot?.predictedImpactSpeedMps !== null
    && entrySnapshot?.predictedImpactSpeedMps !== undefined
    && entrySnapshot.predictedImpactSpeedMps >= 20;
  const fuelFraction = fraction(fuel, fuelCapacity);
  const chargeFraction = fraction(vessel.charge.amount, vessel.charge.capacity);
  const monopropFraction = fraction(monoprop, monopropCapacity);
  const priority = resolvedFlightPhase === 'lost' || controlBlocked
    || vessel.aero.dynamicPressure >= game.flightTuning.nominalMaxQPa * 0.85
    || vessel.properAccel / G0 >= 4 || hardArrival
    ? 'safety'
    : missionAchieved ? 'efficiency' : 'mission';
  const allowedActions = allowedActionsFor(resolvedFlightPhase, priority, controlBlocked);

  return {
    schemaVersion: FLIGHT_DIRECTOR_SCHEMA_VERSION,
    requestType: 'flight-briefing',
    mission: {
      flightId: vessel.id,
      elapsedSeconds: Math.max(0, game.time - missionStart),
      mode: game.campaign.mode,
      objectiveId: resolvedMission.primary.id,
      objective: resolvedMission.primary.text,
      objectiveSource: resolvedMission.primary.source,
      objectiveKind: resolvedMission.primary.kind,
      objectiveAchieved: missionAchieved,
      targetBodyId: resolvedMission.primary.targetBodyId,
      activeObjectives: resolvedMission.activeObjectives,
    },
    phase: {
      situation: vessel.situation,
      regime: gv.regime,
      flightPhase: resolvedFlightPhase,
      priority,
      allowedActions,
    },
    currentBody: bodySnapshot(body),
    targetBody: targetBody ? bodySnapshot(targetBody) : null,
    vessel: {
      crewCount: vessel.crew.length,
      controllable: !controlBlocked,
      currentStage: vessel.currentStage,
      stagesRemaining: Math.max(0, vessel.craft.stages.length - vessel.currentStage),
      throttle: Math.max(0, Math.min(1, vessel.controls.throttle)),
      sasMode: vessel.sas,
      rcsEnabled: vessel.controls.rcs,
      massKg: Math.max(0, vessel.massProps.mass),
      stageDeltaVMps: stage?.deltaV ?? null,
      totalDeltaVMps: Math.max(0, totalDeltaV),
      stageTwr,
      currentStageHasThrust: Boolean(stage && stage.thrust > 0),
      fuelFraction,
      chargeFraction,
      monopropFraction,
    },
    flight: {
      altitudeAslMeters: altitude,
      verticalSpeedMps: verticalSpeed,
      horizontalSpeedMps: horizontalSpeed,
      properG: Math.max(0, vessel.properAccel / G0),
      dynamicPressurePa: Math.max(0, vessel.aero.dynamicPressure),
      insideAtmosphere: body.hasAtmosphere() && altitude < (body.def.atmosphere?.height ?? 0),
    },
    orbit: {
      bound,
      apoapsisMeters,
      periapsisMeters,
      timeToApoapsisSeconds: bound ? Math.max(0, timeToTrueAnomaly(elements, game.time, Math.PI)) : null,
      eccentricity: Math.max(0, elements.e),
      inclinationDegrees: Math.max(0, Math.min(180, elements.i * 180 / Math.PI)),
      stable: stableOrbit,
      targetMinimumPeriapsisMeters,
      apoapsisMarginMeters,
      periapsisMarginMeters,
    },
    maneuver: maneuverSnapshot,
    entry: entrySnapshot,
    comms: {
      connected: comms.connected,
      strength: Math.max(0, Math.min(1, comms.strength)),
      controlBlocked,
    },
    continuity: previousDecision?.vesselId === vessel.id ? {
      previousActionId: previousDecision.actionId,
      previousFlightPhase: previousDecision.flightPhase,
      ageSeconds: Math.max(0, game.time - previousDecision.issuedAt),
    } : null,
    recentEvents: vessel.events.slice(-3).map((event) => ({
      ageSeconds: Math.max(0, game.time - event.time),
      severity: event.severity,
      text: event.text.slice(0, 180),
    })),
  };
}
