import {
  apoapsisOf,
  elementsAtTime,
  elementsToState,
  periapsisOf,
  stateToElements,
  trueToMean,
  type OrbitalElements,
} from '../../core/orbit';
import { Quat } from '../../core/quat';
import { Vec3 } from '../../core/vec3';
import { bodyFixedToInertial, surfaceVelocity } from '../../sim/bodyOrientation';
import { createVesselRuntime, setExternalLandingFootprint } from '../../sim/flight';
import { orbitAfterNode, predictTrajectory, type ManeuverNode } from '../../sim/maneuver';
import { GameState, PHYSICS_DT, type GameVessel } from '../../sim/state';
import type { Body, Universe } from '../../sim/universe';
import { contactSurface } from '../../sim/terrain';
import type { Craft } from '../../sim/vessel';
import {
  ARTEMIS_IV_REPRESENTATIVE_CREW,
  ARTEMIS_IV_HLS_LANDING_FOOTPRINT,
  acknowledgeArtemisIvOutboundCrewTransfer,
  acknowledgeArtemisIvReturnTransfer,
  createArtemisIvLanderGrayboxCraft,
  createArtemisIvOrionGrayboxCraft,
  emptyArtemisIvAcknowledgements,
  emptyArtemisIvGuideTelemetry,
  recordArtemisIvDocking,
  setActiveArtemisIvRole,
  syncArtemisIvCrewToRuntime,
  type ArtemisIvMissionState,
  type ArtemisIvRole,
} from './mission';
import {
  ARTEMIS_IV_CHAPTERS,
  ARTEMIS_IV_MISSION_VERSION,
  type ArtemisIvChapter,
} from './session';

export const ARTEMIS_IV_CHECKPOINT_EPOCH_SECONDS = 1_000_000;

export const ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE = Object.freeze({
  id: 'south-pole-training-analogue',
  bodyId: 'moon' as const,
  label: 'South Pole training analogue',
  sourceTerrainLabel: 'NASA PGDA Site 01 terrain',
  truthStatus: 'representative-not-final-artemis-iv-site' as const,
  latitudeDegrees: -89.47,
  longitudeDegrees: -137.5,
  ellipse: Object.freeze({ semiMajorMeters: 450, semiMinorMeters: 300, headingDegrees: 25 }),
});

/** Fixed polar departure geometry tuned against the patched-conic Earth return. */
export const ARTEMIS_IV_TEI_DEPARTURE_ORBIT = Object.freeze({
  altitudeMeters: 100_000,
  eccentricity: 0.002,
  inclinationDegrees: 90,
  raanDegrees: 340,
  trueAnomalyDegreesAtCheckpoint: 180,
});

export const ARTEMIS_IV_PREPARED_MANEUVER_IDS = Object.freeze({
  postTliCorrection: 'post-tli-correction',
  lunarOrbitInsertion: 'lunar-orbit-insertion',
  descentSetup: 'descent-setup',
  transEarthInjection: 'trans-earth-injection',
} as const);

export const ARTEMIS_IV_LUNAR_ENCOUNTER_CORRIDOR = Object.freeze({
  bodyId: 'moon' as const,
  minimumPeriapsisAltitudeMeters: 60_000,
  maximumPeriapsisAltitudeMeters: 145_000,
  predictionLookaheadSeconds: 4 * 86_400,
});

/** Forgiving outcome corridors for the three prepared mission burns. */
export const ARTEMIS_IV_TRAJECTORY_CORRIDORS = Object.freeze({
  maximumNodeTimeErrorSeconds: 90,
  maximumNormalMetersPerSecond: 10,
  maximumRadialMetersPerSecond: 10,
  lunarOrbitInsertion: Object.freeze({
    minimumPeriapsisAltitudeMeters: 70_000,
    maximumPeriapsisAltitudeMeters: 140_000,
    minimumApoapsisAltitudeMeters: 70_000,
    maximumApoapsisAltitudeMeters: 140_000,
    minimumInclinationDegrees: 85,
  }),
  descentSetup: Object.freeze({
    minimumPeriapsisAltitudeMeters: -100_000,
    maximumPeriapsisAltitudeMeters: 20_000,
    minimumApoapsisAltitudeMeters: 70_000,
    maximumApoapsisAltitudeMeters: 140_000,
  }),
  transEarthInjection: Object.freeze({
    minimumEarthPeriapsisAltitudeMeters: 20_000,
    maximumEarthPeriapsisAltitudeMeters: 120_000,
    predictionLookaheadSeconds: 4 * 86_400,
  }),
});

export interface ArtemisIvPreparedManeuver {
  id: string;
  bodyId: 'earth' | 'moon';
  node: ManeuverNode;
  label: string;
}

export interface ArtemisIvPreparedRendezvous {
  chaserRole: ArtemisIvRole;
  targetRole: ArtemisIvRole;
  startRangeMeters: number;
  holdRangeMeters: number;
  maximumClosingSpeedMetersPerSecond: number;
}

export interface ArtemisIvPreparedDescent {
  startAltitudeMeters: number;
  maximumTouchdownVerticalSpeedMetersPerSecond: number;
  maximumTouchdownHorizontalSpeedMetersPerSecond: number;
  maximumSlopeDegrees: number;
  requiredContactCount: number;
  requiredStableMs: number;
}

export interface ArtemisIvPreparedAscent {
  targetPeriapsisAltitudeMeters: readonly [number, number];
  targetApoapsisAltitudeMeters: readonly [number, number];
  minimumInclinationDegrees: number;
}

export interface ArtemisIvPreparedEntry {
  interfaceAltitudeMeters: number;
  /** Uprange start chosen so the simulated ballistic drift reaches recovery. */
  aimLatitudeDegrees: number;
  aimLongitudeDegrees: number;
  recoveryRegion: Readonly<{
    label: string;
    centerLatitudeDegrees: number;
    centerLongitudeDegrees: number;
    radiusDegrees: number;
  }>;
}

const epochFor = (chapter: ArtemisIvChapter) => ARTEMIS_IV_CHECKPOINT_EPOCH_SECONDS + chapter * 100_000;
const maneuver = (
  id: string,
  bodyId: 'earth' | 'moon',
  time: number,
  prograde: number,
  label: string,
): ArtemisIvPreparedManeuver => ({ id, bodyId, node: { time, prograde, normal: 0, radial: 0 }, label });

/** All numbers below are forgiving training values, not published vehicle performance. */
export const ARTEMIS_IV_PREPARED = Object.freeze({
  truthStatus: 'representative-training-state' as const,
  maneuvers: Object.freeze({
    postTliCorrection: maneuver(
      ARTEMIS_IV_PREPARED_MANEUVER_IDS.postTliCorrection,
      'earth', epochFor(1) + 1_800, 21,
      'Prepared post-TLI prograde correction',
    ),
    lunarOrbitInsertion: maneuver(
      ARTEMIS_IV_PREPARED_MANEUVER_IDS.lunarOrbitInsertion,
      'moon', epochFor(1) + 3 * 86_400, -820,
      'Separate prepared retrograde lunar-orbit insertion',
    ),
    descentSetup: maneuver(
      ARTEMIS_IV_PREPARED_MANEUVER_IDS.descentSetup,
      'moon', epochFor(4) + 600, -35,
      'Prepared representative descent setup',
    ),
    transEarthInjection: maneuver(
      ARTEMIS_IV_PREPARED_MANEUVER_IDS.transEarthInjection,
      'moon', epochFor(9) + 900, 850,
      'Prepared representative trans-Earth injection',
    ),
  }),
  outboundRendezvous: Object.freeze<ArtemisIvPreparedRendezvous>({
    chaserRole: 'orion-cm' as const, targetRole: 'hls' as const,
    startRangeMeters: 12_000, holdRangeMeters: 60,
    maximumClosingSpeedMetersPerSecond: 0.2,
  }),
  returnRendezvous: Object.freeze<ArtemisIvPreparedRendezvous>({
    chaserRole: 'hls' as const, targetRole: 'orion-cm' as const,
    startRangeMeters: 8_000, holdRangeMeters: 60,
    maximumClosingSpeedMetersPerSecond: 0.2,
  }),
  descent: Object.freeze<ArtemisIvPreparedDescent>({
    startAltitudeMeters: 15_000,
    maximumTouchdownVerticalSpeedMetersPerSecond: 2.5,
    maximumTouchdownHorizontalSpeedMetersPerSecond: 1.5,
    maximumSlopeDegrees: 10, requiredContactCount: 3, requiredStableMs: 1_500,
  }),
  ascent: Object.freeze<ArtemisIvPreparedAscent>({
    targetPeriapsisAltitudeMeters: Object.freeze([85_000, 115_000] as const),
    targetApoapsisAltitudeMeters: Object.freeze([85_000, 125_000] as const),
    minimumInclinationDegrees: 85,
  }),
  entry: Object.freeze<ArtemisIvPreparedEntry>({
    interfaceAltitudeMeters: 120_000,
    aimLatitudeDegrees: 29,
    aimLongitudeDegrees: -172,
    recoveryRegion: Object.freeze({
      label: 'Representative Pacific recovery area',
      centerLatitudeDegrees: 20, centerLongitudeDegrees: -155, radiusDegrees: 15,
    }),
  }),
});

/** The editable Chapter 1 node begins close to, but below, the encounter corridor. */
export const ARTEMIS_IV_POST_TLI_START_NODE: Readonly<ManeuverNode> = Object.freeze({
  ...ARTEMIS_IV_PREPARED.maneuvers.postTliCorrection.node,
  prograde: ARTEMIS_IV_PREPARED.maneuvers.postTliCorrection.node.prograde - 6,
});

export interface ArtemisIvLunarEncounterAssessment {
  accepted: boolean;
  periapsisAltitudeMeters: number | null;
}

export interface ArtemisIvLunarOrbitAssessment {
  accepted: boolean;
  periapsisAltitudeMeters: number | null;
  apoapsisAltitudeMeters: number | null;
  inclinationDegrees: number | null;
}

export interface ArtemisIvTransEarthAssessment {
  accepted: boolean;
  moonEscapeTimeSeconds: number | null;
  earthPeriapsisAltitudeMeters: number | null;
}

/** Evaluate the actual patched-conic Moon encounter, not a raw delta-v range. */
export function assessArtemisIvPostTliCorrection(
  universe: Universe,
  preburnReference: Readonly<OrbitalElements>,
  node: Readonly<ManeuverNode>,
): ArtemisIvLunarEncounterAssessment {
  const earth = universe.get('earth');
  if (preburnReference.mu !== earth.mu) {
    return { accepted: false, periapsisAltitudeMeters: null };
  }
  const encounter = predictTrajectory(
    universe,
    earth,
    orbitAfterNode({ ...preburnReference }, { ...node }),
    node.time,
    ARTEMIS_IV_LUNAR_ENCOUNTER_CORRIDOR.predictionLookaheadSeconds,
  ).encounter;
  const periapsisAltitudeMeters = encounter?.bodyId === ARTEMIS_IV_LUNAR_ENCOUNTER_CORRIDOR.bodyId
    ? encounter.periapsisAltitude
    : null;
  return {
    accepted: periapsisAltitudeMeters !== null
      && periapsisAltitudeMeters >= ARTEMIS_IV_LUNAR_ENCOUNTER_CORRIDOR.minimumPeriapsisAltitudeMeters
      && periapsisAltitudeMeters <= ARTEMIS_IV_LUNAR_ENCOUNTER_CORRIDOR.maximumPeriapsisAltitudeMeters,
    periapsisAltitudeMeters,
  };
}

/** Assess the plan's captured preburn snapshot; never reuse the postburn live state. */
export function assessArtemisIvLunarOrbitInsertion(
  universe: Universe,
  preburnReference: Readonly<OrbitalElements>,
  node: Readonly<ManeuverNode>,
): ArtemisIvLunarOrbitAssessment {
  return assessBoundLunarOrbit(
    universe,
    preburnReference,
    node,
    ARTEMIS_IV_PREPARED.maneuvers.lunarOrbitInsertion.node,
    ARTEMIS_IV_TRAJECTORY_CORRIDORS.lunarOrbitInsertion,
  );
}

/** A descent setup is accepted only when its predicted lunar orbit intersects the descent corridor. */
export function assessArtemisIvDescentSetup(
  universe: Universe,
  preburnReference: Readonly<OrbitalElements>,
  node: Readonly<ManeuverNode>,
): ArtemisIvLunarOrbitAssessment {
  return assessBoundLunarOrbit(
    universe,
    preburnReference,
    node,
    ARTEMIS_IV_PREPARED.maneuvers.descentSetup.node,
    ARTEMIS_IV_TRAJECTORY_CORRIDORS.descentSetup,
  );
}

/**
 * Follow the post-node Moon conic through SOI escape, then assess the resulting
 * Earth-relative periapsis. A raw delta-v match is not sufficient.
 */
export function assessArtemisIvTransEarthInjection(
  universe: Universe,
  preburnReference: Readonly<OrbitalElements>,
  node: Readonly<ManeuverNode>,
): ArtemisIvTransEarthAssessment {
  const moon = universe.get('moon');
  const earth = universe.get('earth');
  const rejected = (): ArtemisIvTransEarthAssessment => ({
    accepted: false,
    moonEscapeTimeSeconds: null,
    earthPeriapsisAltitudeMeters: null,
  });
  if (moon.parent !== earth
    || preburnReference.mu !== moon.mu
    || !validElements(preburnReference)
    || !insidePreparedNodeEnvelope(
      node,
      ARTEMIS_IV_PREPARED.maneuvers.transEarthInjection.node,
    )) return rejected();

  try {
    const prediction = predictTrajectory(
      universe,
      moon,
      orbitAfterNode({ ...preburnReference }, { ...node }),
      node.time,
      ARTEMIS_IV_TRAJECTORY_CORRIDORS.transEarthInjection.predictionLookaheadSeconds,
    );
    const escape = prediction.escape;
    if (!escape || escape.elements.mu !== earth.mu || !validElements(escape.elements)) return rejected();
    const earthPeriapsisAltitudeMeters = periapsisOf(escape.elements) - earth.radius;
    const corridor = ARTEMIS_IV_TRAJECTORY_CORRIDORS.transEarthInjection;
    return {
      accepted: escape.elements.e < 1
        && insideRange(
          earthPeriapsisAltitudeMeters,
          corridor.minimumEarthPeriapsisAltitudeMeters,
          corridor.maximumEarthPeriapsisAltitudeMeters,
        ),
      moonEscapeTimeSeconds: escape.exitTime,
      earthPeriapsisAltitudeMeters: Number.isFinite(earthPeriapsisAltitudeMeters)
        ? earthPeriapsisAltitudeMeters
        : null,
    };
  } catch {
    return rejected();
  }
}

function assessBoundLunarOrbit(
  universe: Universe,
  preburnReference: Readonly<OrbitalElements>,
  node: Readonly<ManeuverNode>,
  preparedNode: Readonly<ManeuverNode>,
  corridor: Readonly<{
    minimumPeriapsisAltitudeMeters: number;
    maximumPeriapsisAltitudeMeters: number;
    minimumApoapsisAltitudeMeters: number;
    maximumApoapsisAltitudeMeters: number;
    minimumInclinationDegrees?: number;
  }>,
): ArtemisIvLunarOrbitAssessment {
  const rejected = (): ArtemisIvLunarOrbitAssessment => ({
    accepted: false,
    periapsisAltitudeMeters: null,
    apoapsisAltitudeMeters: null,
    inclinationDegrees: null,
  });
  const moon = universe.get('moon');
  if (preburnReference.mu !== moon.mu
    || !validElements(preburnReference)
    || !insidePreparedNodeEnvelope(node, preparedNode)) return rejected();

  try {
    const after = orbitAfterNode({ ...preburnReference }, { ...node });
    if (!validElements(after) || after.e >= 1) return rejected();
    const periapsisAltitudeMeters = periapsisOf(after) - moon.radius;
    const apoapsisAltitudeMeters = apoapsisOf(after) - moon.radius;
    const inclinationDegrees = after.i * 180 / Math.PI;
    return {
      accepted: insideRange(
        periapsisAltitudeMeters,
        corridor.minimumPeriapsisAltitudeMeters,
        corridor.maximumPeriapsisAltitudeMeters,
      ) && insideRange(
        apoapsisAltitudeMeters,
        corridor.minimumApoapsisAltitudeMeters,
        corridor.maximumApoapsisAltitudeMeters,
      ) && (
        corridor.minimumInclinationDegrees === undefined
        || inclinationDegrees >= corridor.minimumInclinationDegrees
      ),
      periapsisAltitudeMeters,
      apoapsisAltitudeMeters,
      inclinationDegrees,
    };
  } catch {
    return rejected();
  }
}

function insidePreparedNodeEnvelope(
  node: Readonly<ManeuverNode>,
  preparedNode: Readonly<ManeuverNode>,
): boolean {
  return [node.time, node.prograde, node.normal, node.radial].every(Number.isFinite)
    && Math.abs(node.time - preparedNode.time)
      <= ARTEMIS_IV_TRAJECTORY_CORRIDORS.maximumNodeTimeErrorSeconds
    && Math.abs(node.normal) <= ARTEMIS_IV_TRAJECTORY_CORRIDORS.maximumNormalMetersPerSecond
    && Math.abs(node.radial) <= ARTEMIS_IV_TRAJECTORY_CORRIDORS.maximumRadialMetersPerSecond;
}

function validElements(elements: Readonly<OrbitalElements>): boolean {
  return [
    elements.a,
    elements.e,
    elements.i,
    elements.raan,
    elements.argPe,
    elements.meanAnomaly0,
    elements.epoch,
    elements.mu,
  ].every(Number.isFinite) && elements.mu > 0 && elements.e >= 0;
}

function insideRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

export type ArtemisIvPreparedData = Partial<{
  maneuvers: readonly ArtemisIvPreparedManeuver[];
  rendezvous: ArtemisIvPreparedRendezvous;
  descent: ArtemisIvPreparedDescent;
  ascent: ArtemisIvPreparedAscent;
  entry: ArtemisIvPreparedEntry;
}>;

export interface ArtemisIvCheckpointDescriptor {
  chapter: ArtemisIvChapter;
  id: string;
  title: string;
  epochSeconds: number;
  bodyId: 'earth' | 'moon' | null;
  activeRole: ArtemisIvRole | null;
  topology: 'briefing' | 'orion-only' | 'separate' | 'docked';
  terrainAuthorityRequest: 'parent' | 'moon-site01';
  truthStatus: 'confirmed-mission-summary' | 'representative-training-state';
  prepared: ArtemisIvPreparedData;
}

function checkpoint(
  chapter: ArtemisIvChapter,
  id: string,
  title: string,
  bodyId: ArtemisIvCheckpointDescriptor['bodyId'],
  activeRole: ArtemisIvRole | null,
  topology: ArtemisIvCheckpointDescriptor['topology'],
  prepared: ArtemisIvPreparedData = {},
): ArtemisIvCheckpointDescriptor {
  return {
    chapter, id, title, bodyId, activeRole, topology, prepared,
    epochSeconds: epochFor(chapter),
    terrainAuthorityRequest: bodyId === 'moon' ? 'moon-site01' : 'parent',
    truthStatus: chapter === 0 ? 'confirmed-mission-summary' : 'representative-training-state',
  };
}

const M = ARTEMIS_IV_PREPARED.maneuvers;
export const ARTEMIS_IV_CHECKPOINTS: readonly ArtemisIvCheckpointDescriptor[] = Object.freeze([
  checkpoint(0, 'mission-briefing', 'Mission briefing', null, null, 'briefing'),
  checkpoint(1, 'lunar-approach', 'Lunar approach', 'earth', 'orion-cm', 'orion-only', {
    maneuvers: [M.postTliCorrection, M.lunarOrbitInsertion],
  }),
  checkpoint(2, 'find-the-lander', 'Find the lander', 'moon', 'orion-cm', 'separate', {
    rendezvous: ARTEMIS_IV_PREPARED.outboundRendezvous,
  }),
  checkpoint(3, 'dock-and-transfer', 'Dock and transfer', 'moon', 'orion-cm', 'separate', {
    rendezvous: { ...ARTEMIS_IV_PREPARED.outboundRendezvous, startRangeMeters: 40 },
  }),
  checkpoint(4, 'commit-to-descent', 'Commit to descent', 'moon', 'orion-cm', 'docked', {
    maneuvers: [M.descentSetup], descent: ARTEMIS_IV_PREPARED.descent,
  }),
  checkpoint(5, 'powered-descent', 'Powered descent and landing', 'moon', 'hls', 'separate', {
    descent: ARTEMIS_IV_PREPARED.descent,
  }),
  checkpoint(6, 'surface-expedition', 'Surface expedition', 'moon', 'hls', 'separate', {
    descent: ARTEMIS_IV_PREPARED.descent,
  }),
  checkpoint(7, 'lunar-ascent', 'Near-polar lunar ascent', 'moon', 'hls', 'separate', {
    ascent: ARTEMIS_IV_PREPARED.ascent,
  }),
  checkpoint(8, 'rejoin-orion', 'Rejoin Orion', 'moon', 'hls', 'separate', {
    rendezvous: ARTEMIS_IV_PREPARED.returnRendezvous,
  }),
  checkpoint(9, 'return-to-earth', 'Return to Earth', 'moon', 'orion-cm', 'docked', {
    maneuvers: [M.transEarthInjection],
  }),
  checkpoint(10, 'entry-and-splashdown', 'Entry and splashdown', 'earth', 'orion-cm', 'orion-only', {
    entry: ARTEMIS_IV_PREPARED.entry,
  }),
]);

export function artemisIvCheckpointForChapter(chapter: ArtemisIvChapter): ArtemisIvCheckpointDescriptor {
  const descriptor = ARTEMIS_IV_CHECKPOINTS[chapter];
  if (!descriptor || descriptor.chapter !== chapter) throw new Error(`Unknown Artemis IV chapter ${chapter}`);
  return descriptor;
}

/** Polar elements whose plane contains the training target at the chosen epoch. */
export function createArtemisIvSiteCrossingPolarOrbit(
  game: GameState,
  epoch: number,
  altitudeMeters = 100_000,
  trueAnomalyOffset = 0,
): { elements: OrbitalElements; trueAnomaly: number } {
  const moon = game.universe.get('moon');
  const target = trainingTargetDirectionInertial(moon, epoch);
  const raan = normalizedAngle(Math.atan2(target.y, target.x));
  const trueAnomaly = Math.atan2(target.z, Math.hypot(target.x, target.y)) + trueAnomalyOffset;
  const e = 0.002;
  return {
    elements: {
      a: moon.radius + altitudeMeters, e, i: Math.PI / 2, raan, argPe: 0,
      meanAnomaly0: trueToMean(trueAnomaly, e), epoch, mu: moon.mu,
    },
    trueAnomaly,
  };
}

export function createArtemisIvTeiDepartureOrbit(
  game: GameState,
  epoch: number,
): { elements: OrbitalElements; trueAnomaly: number } {
  const moon = game.universe.get('moon');
  const trueAnomaly = ARTEMIS_IV_TEI_DEPARTURE_ORBIT.trueAnomalyDegreesAtCheckpoint
    * Math.PI / 180;
  const e = ARTEMIS_IV_TEI_DEPARTURE_ORBIT.eccentricity;
  return {
    elements: {
      a: moon.radius + ARTEMIS_IV_TEI_DEPARTURE_ORBIT.altitudeMeters,
      e,
      i: ARTEMIS_IV_TEI_DEPARTURE_ORBIT.inclinationDegrees * Math.PI / 180,
      raan: ARTEMIS_IV_TEI_DEPARTURE_ORBIT.raanDegrees * Math.PI / 180,
      argPe: 0,
      meanAnomaly0: trueToMean(trueAnomaly, e),
      epoch,
      mu: moon.mu,
    },
    trueAnomaly,
  };
}

/**
 * Build a fresh, session-only chapter start. Callers install the descriptor's
 * terrainAuthorityRequest before exposing a lunar checkpoint to live terrain.
 */
export function initializeArtemisIvCheckpoint(
  chapter: ArtemisIvChapter,
  preparedGame?: GameState,
): ArtemisIvMissionState {
  const descriptor = artemisIvCheckpointForChapter(chapter);
  const game = preparedGame ?? new GameState('sandbox', { persistence: 'session-only' });
  if (game.vessels.length > 0) {
    throw new Error('Artemis IV checkpoint initialization requires an empty prepared game');
  }
  game.time = descriptor.epochSeconds;
  const state: ArtemisIvMissionState = {
    missionVersion: ARTEMIS_IV_MISSION_VERSION,
    game, chapter, checkpointId: descriptor.id,
    roles: { 'orion-cm': null, 'orion-esm': null, hls: null },
    activeRole: null,
    crew: { 'orion-cm': [...ARTEMIS_IV_REPRESENTATIVE_CREW], hls: [] },
    samples: { count: 0, ownerRole: null, status: 'not-collected' },
    acknowledgements: emptyArtemisIvAcknowledgements(),
    telemetry: emptyArtemisIvGuideTelemetry(),
  };

  if (chapter >= 4 && chapter <= 8) applyOutboundState(state);
  if (chapter >= 7 && chapter <= 9) applySurfaceState(state);
  if (chapter === 10) applyReturnState(state);

  switch (chapter) {
    case 0: return state;
    case 1: spawnPostTliOrion(state); break;
    case 2: spawnRendezvousPair(state, 12_000, 0, false); break;
    case 3: spawnRendezvousPair(state, 40, 0.1, true); break;
    case 4:
      spawnDockedStack(state);
      // Chapter 4 starts after the Chapter 3 text acknowledgement.
      if (!state.acknowledgements['crew-transfer-to-lander']) {
        acknowledgeArtemisIvOutboundCrewTransfer(state);
      }
      break;
    case 5: spawnDescent(state); break;
    case 6:
    case 7: spawnLanded(state); break;
    case 8: spawnRendezvousPair(state, 8_000, 0, false); break;
    case 9:
      // Build the actual docked topology with the pre-return 2+2 manifest.
      applyOutboundState(state);
      spawnDockedStack(state);
      acknowledgeArtemisIvReturnTransfer(state);
      break;
    case 10: spawnEarthEntry(state); break;
  }
  if (descriptor.activeRole) setActiveArtemisIvRole(state, descriptor.activeRole);
  syncArtemisIvCrewToRuntime(state);
  return state;
}

export const ARTEMIS_IV_CHECKPOINT_INITIALIZERS = Object.freeze(Object.fromEntries(
  ARTEMIS_IV_CHAPTERS.map((chapter) => [chapter, () => initializeArtemisIvCheckpoint(chapter)]),
) as unknown as Readonly<Record<ArtemisIvChapter, () => ArtemisIvMissionState>>);

/**
 * Chapter 1 compresses the uneventful coast, but keeps LOI as a separate
 * player-executed burn. The caller prepares Moon terrain authority first.
 */
export function prepareArtemisIvLunarInsertion(state: ArtemisIvMissionState): void {
  if (state.chapter !== 1 || state.game.vessels.length !== 0) {
    throw new Error('Lunar insertion transition requires an empty Chapter 1 game');
  }
  const nodeTime = ARTEMIS_IV_PREPARED.maneuvers.lunarOrbitInsertion.node.time;
  state.game.time = nodeTime - 600;
  const moon = state.game.universe.get('moon');
  const radialAtNode = trainingTargetDirectionInertial(moon, nodeTime);
  const tangentAtNode = tangentTo(radialAtNode);
  const radius = moon.radius + 100_000;
  const circularSpeed = Math.sqrt(moon.mu / radius);
  const orion = spawnCartesian(
    state.game,
    createArtemisIvOrionGrayboxCraft(),
    'Orion/ESM',
    'moon',
    state.crew['orion-cm'],
  );
  const positionAtNode = radialAtNode.clone().scale(radius);
  const velocityAtNode = tangentAtNode.clone().scale(
    circularSpeed + Math.abs(ARTEMIS_IV_PREPARED.maneuvers.lunarOrbitInsertion.node.prograde),
  );
  const inboundReference = stateToElements(
    moon.mu,
    positionAtNode,
    velocityAtNode,
    nodeTime,
  );
  elementsAtTime(inboundReference, state.game.time, orion.runtime.pos, orion.runtime.vel);
  const normal = Vec3.cross(orion.runtime.pos, orion.runtime.vel, new Vec3()).normalize();
  orion.runtime.att.setLookRotation(normal, orion.runtime.vel.clone().normalize());
  orion.runtime.situation = 'suborbital';
  state.roles = { 'orion-cm': orion.runtime.id, 'orion-esm': orion.runtime.id, hls: null };
  setActiveArtemisIvRole(state, 'orion-cm');
  syncArtemisIvCrewToRuntime(state);
}

/** Compress the post-TEI coast to a checked Earth approach in Chapter 9. */
export function prepareArtemisIvEarthApproach(state: ArtemisIvMissionState): void {
  if (state.chapter !== 9 || state.game.vessels.length !== 0) {
    throw new Error('Earth approach transition requires an empty Chapter 9 game');
  }
  state.game.time += 3 * 86_400;
  const orion = spawnEarthEntryVehicle(state);
  state.roles = { 'orion-cm': orion.runtime.id, 'orion-esm': orion.runtime.id, hls: null };
  setActiveArtemisIvRole(state, 'orion-cm');
  syncArtemisIvCrewToRuntime(state);
}

function applyOutboundState(state: ArtemisIvMissionState): void {
  state.crew = {
    'orion-cm': [...ARTEMIS_IV_REPRESENTATIVE_CREW.slice(0, 2)],
    hls: [...ARTEMIS_IV_REPRESENTATIVE_CREW.slice(2)],
  };
  state.acknowledgements['crew-transfer-to-lander'] = true;
}

function applySurfaceState(state: ArtemisIvMissionState): void {
  state.samples = { count: 1, ownerRole: 'hls', status: 'aboard-lander' };
  state.acknowledgements['surface-expedition-complete'] = true;
}

function applyReturnState(state: ArtemisIvMissionState): void {
  state.crew = { 'orion-cm': [...ARTEMIS_IV_REPRESENTATIVE_CREW], hls: [] };
  state.samples = { count: 1, ownerRole: 'orion-cm', status: 'aboard-orion' };
  state.acknowledgements['crew-transfer-to-lander'] = true;
  state.acknowledgements['surface-expedition-complete'] = true;
  state.acknowledgements['crew-and-samples-returned-to-orion'] = true;
}

function spawnPostTliOrion(state: ArtemisIvMissionState): void {
  const orion = spawnCartesian(
    state.game,
    createArtemisIvOrionGrayboxCraft(),
    'Orion/ESM',
    'earth',
    state.crew['orion-cm'],
  );
  // Checked representative state, 30 minutes before the correction. The
  // editable starting node predicts a low flyby; the prepared adjustment
  // moves the predicted Moon periapsis into the authored training corridor.
  orion.runtime.pos.set(208_714_881.2701737, -316_668_444.3000199, -335_995.6354216264);
  orion.runtime.vel.set(394.10087479802485, -286.1301639739215, 1.7404220366461662);
  const normal = Vec3.cross(orion.runtime.pos, orion.runtime.vel, new Vec3()).normalize();
  orion.runtime.att.setLookRotation(normal, orion.runtime.vel.clone().normalize());
  orion.runtime.situation = 'suborbital';
  bindOrion(state, orion);
}

function spawnRendezvousPair(
  state: ArtemisIvMissionState,
  rangeMeters: number,
  closingMetersPerSecond: number,
  dockingAligned: boolean,
): void {
  const polar = createArtemisIvSiteCrossingPolarOrbit(state.game, state.game.time, 100_000, 0.65);
  const orion = spawnOrbital(state.game, createArtemisIvOrionGrayboxCraft(), 'Orion/ESM', 'moon', polar.elements, polar.trueAnomaly, state.crew['orion-cm']);
  const lander = spawnOrbital(state.game, createArtemisIvLanderGrayboxCraft(), 'Commercial lander training vehicle', 'moon', polar.elements, polar.trueAnomaly, state.crew.hls);
  installHlsLandingFootprint(lander);
  const axis = orion.runtime.att.rotate(new Vec3(0, 1, 0), new Vec3()).normalize();
  lander.runtime.pos.copy(orion.runtime.pos).addScaled(axis, rangeMeters);
  lander.runtime.vel.copy(orion.runtime.vel).addScaled(axis, -closingMetersPerSecond);
  if (dockingAligned) lander.runtime.att.copy(orion.runtime.att).multiply(new Quat(1, 0, 0, 0));
  bindOrion(state, orion);
  state.roles.hls = lander.runtime.id;
  state.telemetry.relativeRangeMeters = rangeMeters;
  state.telemetry.relativeClosingSpeedMetersPerSecond = closingMetersPerSecond;
}

function spawnDockedStack(state: ArtemisIvMissionState): void {
  const polar = state.chapter === 9
    ? createArtemisIvTeiDepartureOrbit(state.game, state.game.time)
    : createArtemisIvSiteCrossingPolarOrbit(state.game, state.game.time, 100_000, 0.8);
  const orion = spawnOrbital(state.game, createArtemisIvOrionGrayboxCraft(), 'Orion/ESM', 'moon', polar.elements, polar.trueAnomaly, state.crew['orion-cm']);
  const lander = spawnOrbital(state.game, createArtemisIvLanderGrayboxCraft(), 'Commercial lander training vehicle', 'moon', polar.elements, polar.trueAnomaly, state.crew.hls);
  installHlsLandingFootprint(lander);
  lander.runtime.vel.copy(orion.runtime.vel);
  lander.runtime.att.copy(orion.runtime.att).multiply(new Quat(1, 0, 0, 0));
  const orionFace = dockingFaceOffset(orion);
  const landerFace = dockingFaceOffset(lander);
  lander.runtime.pos.copy(orion.runtime.pos).add(orionFace).sub(landerFace);
  state.game.activeVesselId = orion.runtime.id;
  state.game.update(PHYSICS_DT);
  const merged = state.game.vessels[0];
  if (state.game.vessels.length !== 1 || !merged || state.game.dockedJoints(merged).length !== 1) {
    throw new Error('Artemis IV docked checkpoint failed to capture');
  }
  recordArtemisIvDocking(state, merged.runtime.id);
}

function spawnDescent(state: ArtemisIvMissionState): void {
  const polar = createArtemisIvSiteCrossingPolarOrbit(state.game, state.game.time, 100_000, 1.2);
  const orion = spawnOrbital(state.game, createArtemisIvOrionGrayboxCraft(), 'Orion/ESM', 'moon', polar.elements, polar.trueAnomaly, state.crew['orion-cm']);
  const moon = state.game.universe.get('moon');
  const lander = spawnCartesian(state.game, createArtemisIvLanderGrayboxCraft(), 'Commercial lander training vehicle', 'moon', state.crew.hls);
  installHlsLandingFootprint(lander);
  const radial = trainingTargetDirectionInertial(moon, state.game.time);
  const tangent = tangentTo(radial);
  lander.runtime.pos.copy(radial).scale(moon.radius + ARTEMIS_IV_PREPARED.descent.startAltitudeMeters);
  surfaceVelocity(moon, lander.runtime.pos, lander.runtime.vel);
  lander.runtime.vel.addScaled(tangent, 70).addScaled(radial, -18);
  const descentRetrograde = tangent.clone().scale(-70).addScaled(radial, 18).normalize();
  const orbitNormal = Vec3.cross(radial, tangent, new Vec3()).normalize();
  lander.runtime.att.setLookRotation(orbitNormal, descentRetrograde);
  lander.runtime.situation = 'suborbital';
  bindSeparated(state, orion, lander);
  state.telemetry.landing = {
    contactCount: 0, stableForMs: 0, insideTrainingEllipse: true,
    verticalSpeedMetersPerSecond: -18, horizontalSpeedMetersPerSecond: 70,
    slopeDegrees: 0,
  };
}

function spawnLanded(state: ArtemisIvMissionState): void {
  const polar = createArtemisIvSiteCrossingPolarOrbit(state.game, state.game.time, 100_000, 1.4);
  const orion = spawnOrbital(state.game, createArtemisIvOrionGrayboxCraft(), 'Orion/ESM', 'moon', polar.elements, polar.trueAnomaly, state.crew['orion-cm']);
  const moon = state.game.universe.get('moon');
  const lander = spawnCartesian(state.game, createArtemisIvLanderGrayboxCraft(), 'Commercial lander training vehicle', 'moon', state.crew.hls);
  installHlsLandingFootprint(lander);
  const siteDirection = trainingTargetDirectionBodyFixed();
  const surface = contactSurface(moon, siteDirection);
  const surfaceHeight = surface.kind === 'none' ? 0 : surface.height;
  const footToCom = lander.runtime.massProps.com.y - ARTEMIS_IV_HLS_LANDING_FOOTPRINT.footY;
  lander.runtime.landedBodyFixed = siteDirection.scale(moon.radius + surfaceHeight + footToCom);
  bodyFixedToInertial(moon, state.game.time, lander.runtime.landedBodyFixed, lander.runtime.pos);
  surfaceVelocity(moon, lander.runtime.pos, lander.runtime.vel);
  const up = lander.runtime.pos.clone().normalize();
  lander.runtime.att.setLookRotation(tangentTo(up), up);
  lander.runtime.situation = 'landed';
  bindSeparated(state, orion, lander);
  state.telemetry.landing = {
    contactCount: 4, stableForMs: ARTEMIS_IV_PREPARED.descent.requiredStableMs,
    insideTrainingEllipse: true, verticalSpeedMetersPerSecond: 0,
    horizontalSpeedMetersPerSecond: 0, slopeDegrees: 0,
  };
}

function spawnEarthEntry(state: ArtemisIvMissionState): void {
  const orion = spawnEarthEntryVehicle(state);
  bindOrion(state, orion);
}

function spawnEarthEntryVehicle(state: ArtemisIvMissionState): GameVessel {
  const earth = state.game.universe.get('earth');
  const orion = spawnCartesian(state.game, createArtemisIvOrionGrayboxCraft(), 'Orion/ESM', 'earth', state.crew['orion-cm']);
  // Aim uprange of the recovery center. The rotating-atmosphere entry then
  // carries the capsule into the authored Pacific recovery area.
  const entry = ARTEMIS_IV_PREPARED.entry;
  const latitude = entry.aimLatitudeDegrees * Math.PI / 180;
  const longitude = entry.aimLongitudeDegrees * Math.PI / 180;
  const directionBF = new Vec3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  );
  const radial = bodyFixedToInertial(earth, state.game.time, directionBF, new Vec3()).normalize();
  const tangent = tangentTo(radial);
  orion.runtime.pos.copy(radial).scale(
    earth.radius + entry.interfaceAltitudeMeters,
  );
  surfaceVelocity(earth, orion.runtime.pos, orion.runtime.vel);
  orion.runtime.vel.addScaled(radial, -1_100).addScaled(tangent, 10_750);
  const orbitNormal = Vec3.cross(orion.runtime.pos, orion.runtime.vel, new Vec3()).normalize();
  orion.runtime.att.setLookRotation(orbitNormal, orion.runtime.vel.clone().normalize().scale(-1));
  orion.runtime.situation = 'suborbital';
  // The ESM engine burn is complete. The next player stage is CM/ESM
  // separation, followed by the recovery-system stage.
  orion.runtime.currentStage = 1;
  return orion;
}

function spawnOrbital(
  game: GameState,
  craft: Craft,
  name: string,
  bodyId: 'earth' | 'moon',
  elements: OrbitalElements,
  trueAnomaly: number,
  crew: readonly string[],
): GameVessel {
  const vessel = spawnCartesian(game, craft, name, bodyId, crew);
  elementsToState(elements, trueAnomaly, vessel.runtime.pos, vessel.runtime.vel);
  const normal = Vec3.cross(vessel.runtime.pos, vessel.runtime.vel, new Vec3()).normalize();
  vessel.runtime.att.setLookRotation(normal, vessel.runtime.vel.clone().normalize());
  vessel.runtime.situation = 'orbit';
  return vessel;
}

function spawnCartesian(
  game: GameState,
  craft: Craft,
  name: string,
  bodyId: 'earth' | 'moon',
  crew: readonly string[],
): GameVessel {
  const runtime = createVesselRuntime(game.newVesselId(), name, craft, bodyId);
  runtime.crew = [...crew];
  const vessel: GameVessel = { runtime, regime: 'active', rails: { elements: null, landedPos: null, landedAtt: null }, target: null };
  game.vessels.push(vessel);
  return vessel;
}

function bindOrion(state: ArtemisIvMissionState, orion: GameVessel): void {
  state.roles['orion-cm'] = orion.runtime.id;
  state.roles['orion-esm'] = orion.runtime.id;
}

function bindSeparated(state: ArtemisIvMissionState, orion: GameVessel, lander: GameVessel): void {
  bindOrion(state, orion);
  state.roles.hls = lander.runtime.id;
}

function installHlsLandingFootprint(lander: GameVessel): void {
  setExternalLandingFootprint(lander.runtime, ARTEMIS_IV_HLS_LANDING_FOOTPRINT);
}

function dockingFaceOffset(vessel: GameVessel): Vec3 {
  const port = vessel.runtime.craft.parts.find((part) => part.defId === 'dock-port-s' && part.parentKey === null);
  if (!port) throw new Error('Artemis IV graybox craft is missing its root docking port');
  const com = vessel.runtime.massProps.com;
  const local = new Vec3(port.position.x - com.x, port.position.y - com.y + 0.12, port.position.z - com.z);
  return vessel.runtime.att.rotate(local, new Vec3());
}

function trainingTargetDirectionBodyFixed(): Vec3 {
  const latitude = ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE.latitudeDegrees * Math.PI / 180;
  const longitude = ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE.longitudeDegrees * Math.PI / 180;
  const cosLatitude = Math.cos(latitude);
  return new Vec3(cosLatitude * Math.cos(longitude), cosLatitude * Math.sin(longitude), Math.sin(latitude));
}

function trainingTargetDirectionInertial(body: Body, time: number): Vec3 {
  return bodyFixedToInertial(body, time, trainingTargetDirectionBodyFixed(), new Vec3()).normalize();
}

function tangentTo(radial: Readonly<Vec3>): Vec3 {
  const reference = Math.abs(radial.z) < 0.9 ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
  return Vec3.cross(reference, radial, new Vec3()).normalize();
}

function normalizedAngle(angle: number): number {
  return angle < 0 ? angle + Math.PI * 2 : angle;
}
