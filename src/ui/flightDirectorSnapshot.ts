import { Vec3 } from '../core/vec3';
import { apoapsisOf, periapsisOf, stateToElements, timeToTrueAnomaly } from '../core/orbit';
import type { FlightDirectorSnapshot } from '../ai/flightDirector';
import { FLIGHT_DIRECTOR_SCHEMA_VERSION } from '../ai/flightDirector';
import { CONTRACTS } from '../sim/campaign';
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
  const analysis = analyzeCraft(vessel.craft, body.surfaceGravity, body.pressureAt(altitude));
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
  const objectiveId = game.campaign.activeContracts[0] ?? null;
  const objective = objectiveId ? CONTRACTS.find((contract) => contract.id === objectiveId)?.brief ?? null : null;
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

  return {
    schemaVersion: FLIGHT_DIRECTOR_SCHEMA_VERSION,
    requestType: 'flight-briefing',
    mission: {
      elapsedSeconds: Math.max(0, game.time - missionStart),
      mode: game.campaign.mode,
      objective,
    },
    phase: { situation: vessel.situation, regime: gv.regime },
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
      fuelFraction: fraction(fuel, fuelCapacity),
      chargeFraction: fraction(vessel.charge.amount, vessel.charge.capacity),
      monopropFraction: fraction(monoprop, monopropCapacity),
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
      apoapsisMeters: bound ? apoapsisOf(elements) - body.radius : null,
      periapsisMeters: periapsisOf(elements) - body.radius,
      timeToApoapsisSeconds: bound ? Math.max(0, timeToTrueAnomaly(elements, game.time, Math.PI)) : null,
      eccentricity: Math.max(0, elements.e),
      inclinationDegrees: Math.max(0, Math.min(180, elements.i * 180 / Math.PI)),
    },
    maneuver: node ? {
      secondsUntilNode: node.time - game.time,
      secondsUntilBurnStart: node.time - game.time - burnSeconds / 2,
      remainingDeltaVMps: remainingNodeDv,
      estimatedBurnSeconds: Math.max(0, burnSeconds),
    } : null,
    entry: prediction ? {
      willEnter: prediction.willEnter,
      lands: prediction.lands,
      secondsUntilLanding: prediction.lands ? Math.max(0, prediction.landingTime - game.time) : null,
      predictedImpactSpeedMps: prediction.lands ? Math.max(0, prediction.impactSpeed) : null,
      peakG: Number.isFinite(prediction.peakG) ? Math.max(0, prediction.peakG) : null,
    } : null,
    comms: {
      connected: comms.connected,
      strength: Math.max(0, Math.min(1, comms.strength)),
      controlBlocked,
    },
    recentEvents: vessel.events.slice(-3).map((event) => ({
      ageSeconds: Math.max(0, game.time - event.time),
      severity: event.severity,
      text: event.text.slice(0, 180),
    })),
  };
}
