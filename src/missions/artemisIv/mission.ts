import type { GameVessel } from '../../sim/state';
import { addPart, createCraft, type Craft } from '../../sim/vessel';
import type { GameState } from '../../sim/state';
import type {
  ArtemisIvAcknowledgement,
  ArtemisIvChapter,
} from './session';
import { ARTEMIS_IV_MISSION_VERSION } from './session';

export const ARTEMIS_IV_MISSION_ID = 'artemis-iv';

export const ARTEMIS_IV_ROLES = ['orion-cm', 'orion-esm', 'hls'] as const;
export type ArtemisIvRole = (typeof ARTEMIS_IV_ROLES)[number];

export const ARTEMIS_IV_REPRESENTATIVE_CREW = [
  'representative-crew-1',
  'representative-crew-2',
  'representative-crew-3',
  'representative-crew-4',
] as const;
export type ArtemisIvCrewId = (typeof ARTEMIS_IV_REPRESENTATIVE_CREW)[number];

export const ARTEMIS_IV_PUBLIC_FACTS = Object.freeze([
  Object.freeze({
    status: 'confirmed-current-mission' as const,
    text: 'Artemis IV is NASA\'s planned first crewed lunar landing in the revised Artemis sequence, targeted for early 2028.',
  }),
  Object.freeze({
    status: 'confirmed-current-mission' as const,
    text: 'Four astronauts launch in Orion; two descend near the lunar South Pole, then all four return in Orion for splashdown.',
  }),
  Object.freeze({
    status: 'provider-tbd-visual-stand-in' as const,
    text: 'NASA has not assigned the Artemis IV lander provider. This scenario uses an unchanged artist-made 2019 generic Starship concept as a visual stand-in. It is not a Starship HLS model or an official flight configuration.',
  }),
]);

export const ARTEMIS_IV_STAND_IN_LABEL =
  'UNCHANGED 2019 STARSHIP CONCEPT STAND-IN · NASA PROVIDER TBD';

/** External physics pads matching the checked stand-in's tall visual bounds. */
export const ARTEMIS_IV_HLS_LANDING_FOOTPRINT = Object.freeze({
  halfWidth: 6.5,
  halfDepth: 4.5,
  footY: -26.5,
});

export interface ArtemisIvRoleBindings {
  'orion-cm': string | null;
  'orion-esm': string | null;
  hls: string | null;
}

export interface ArtemisIvCrewState {
  /** Mission compartments remain distinct while the physics craft is docked. */
  'orion-cm': ArtemisIvCrewId[];
  hls: ArtemisIvCrewId[];
}

export interface ArtemisIvSampleState {
  /** A representative returned cache, not a claim about NASA's final manifest. */
  count: number;
  ownerRole: 'orion-cm' | 'hls' | null;
  status: 'not-collected' | 'aboard-lander' | 'aboard-orion';
}

export interface ArtemisIvLandingTelemetry {
  contactCount: number;
  stableForMs: number;
  insideTrainingEllipse: boolean;
  verticalSpeedMetersPerSecond: number;
  horizontalSpeedMetersPerSecond: number;
  slopeDegrees: number;
}

/**
 * Measurements that existing simulation/UI seams can populate. They are not
 * mission-complete flags: guide predicates apply the chapter envelopes.
 */
export interface ArtemisIvGuideTelemetry {
  completedManeuverIds: string[];
  selectedTargetRole: ArtemisIvRole | null;
  relativeRangeMeters: number | null;
  relativeClosingSpeedMetersPerSecond: number | null;
  holdStableForMs: number;
  landing: ArtemisIvLandingTelemetry;
  parachutesDeployed: boolean;
  recoveryLatitudeDegrees: number | null;
  recoveryLongitudeDegrees: number | null;
}

export interface ArtemisIvMissionState {
  missionVersion: typeof ARTEMIS_IV_MISSION_VERSION;
  game: GameState;
  chapter: ArtemisIvChapter;
  checkpointId: string;
  roles: ArtemisIvRoleBindings;
  activeRole: ArtemisIvRole | null;
  crew: ArtemisIvCrewState;
  samples: ArtemisIvSampleState;
  acknowledgements: Record<ArtemisIvAcknowledgement, boolean>;
  telemetry: ArtemisIvGuideTelemetry;
}

const identity = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

function yaw(angle: number) {
  return { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
}

/**
 * Stock-part physics proxy for Orion/ESM. The single-seat Voyager definition
 * is deliberately not edited; the mission state owns the representative
 * four-person manifest, while later visual binding owns the scaled exterior.
 */
export function createArtemisIvOrionGrayboxCraft(): Craft {
  const craft = createCraft('Artemis IV Orion/ESM graybox');
  const dockingPort = addPart(craft, 'dock-port-s', null, 'root', { x: 0, y: 0, z: 0 }, identity);
  const pod = addPart(craft, 'pod-voyager', dockingPort.key, 'stack-bottom', { x: 0, y: -0.545, z: 0 }, identity);
  addPart(craft, 'chute-main', pod.key, 'surface', { x: 0.38, y: -0.45, z: 0 }, identity);
  addPart(craft, 'chute-drogue', pod.key, 'surface', { x: -0.38, y: -0.45, z: 0 }, identity);
  const shield = addPart(craft, 'shield-s', pod.key, 'stack-bottom', { x: 0, y: -1.095, z: 0 }, identity);
  const separator = addPart(craft, 'dec-s', shield.key, 'stack-bottom', { x: 0, y: -1.3, z: 0 }, identity);
  const battery = addPart(craft, 'batt-m', separator.key, 'stack-bottom', { x: 0, y: -1.52, z: 0 }, identity);
  const tank = addPart(craft, 'tank-s4', battery.key, 'stack-bottom', { x: 0, y: -3.46, z: 0 }, identity);
  const engine = addPart(craft, 'eng-ember', tank.key, 'stack-bottom', { x: 0, y: -5.71, z: 0 }, identity);

  for (let index = 0; index < 4; index++) {
    const angle = index * Math.PI / 2;
    addPart(craft, 'rcs-quad', tank.key, 'surface', {
      x: Math.sin(angle) * 0.66,
      y: -2.15,
      z: Math.cos(angle) * 0.66,
    }, yaw(angle), 1);
    addPart(craft, 'solar-flat', tank.key, 'surface', {
      x: Math.sin(angle) * 0.78,
      y: -3.7,
      z: Math.cos(angle) * 0.78,
    }, yaw(angle), 2);
  }

  craft.stages = [
    { partKeys: [engine.key] },
    { partKeys: [separator.key] },
    {
      partKeys: craft.parts
        .filter((part) => part.defId === 'chute-drogue' || part.defId === 'chute-main')
        .map((part) => part.key),
    },
  ];
  return craft;
}

/**
 * Stock-part physics proxy for the provider-neutral landing system. It does
 * not encode or claim manufacturer performance or unpublished flight design.
 */
export function createArtemisIvLanderGrayboxCraft(): Craft {
  const craft = createCraft('Artemis IV commercial lander graybox');
  const dockingPort = addPart(craft, 'dock-port-s', null, 'root', { x: 0, y: 0, z: 0 }, identity);
  const pod = addPart(craft, 'pod-tandem', dockingPort.key, 'stack-bottom', { x: 0, y: -0.67, z: 0 }, identity);
  const battery = addPart(craft, 'batt-m', pod.key, 'stack-bottom', { x: 0, y: -1.36, z: 0 }, identity);
  const upperTank = addPart(craft, 'tank-m4', battery.key, 'stack-bottom', { x: 0, y: -2.45, z: 0 }, identity);
  const lowerTank = addPart(craft, 'tank-m4', upperTank.key, 'stack-bottom', { x: 0, y: -4.35, z: 0 }, identity);
  const engine = addPart(craft, 'eng-aspen', lowerTank.key, 'stack-bottom', { x: 0, y: -6.05, z: 0 }, identity);
  addPart(craft, 'sci-fieldkit', upperTank.key, 'surface', { x: 1.3, y: -2.45, z: 0 }, identity);

  for (let index = 0; index < 4; index++) {
    const angle = Math.PI / 4 + index * Math.PI / 2;
    addPart(craft, 'leg-lander', lowerTank.key, 'surface', {
      x: Math.sin(angle) * 1.52,
      y: -4.75,
      z: Math.cos(angle) * 1.52,
    }, yaw(angle), 1);
    addPart(craft, 'rcs-quad', upperTank.key, 'surface', {
      x: Math.sin(angle) * 1.3,
      y: -1.9,
      z: Math.cos(angle) * 1.3,
    }, yaw(angle), 2);
  }

  craft.stages = [{ partKeys: [engine.key] }];
  return craft;
}

export function emptyArtemisIvAcknowledgements(): Record<ArtemisIvAcknowledgement, boolean> {
  return {
    'provider-stand-in-understood': false,
    'crew-transfer-to-lander': false,
    'surface-expedition-complete': false,
    'crew-and-samples-returned-to-orion': false,
  };
}

export function emptyArtemisIvGuideTelemetry(): ArtemisIvGuideTelemetry {
  return {
    completedManeuverIds: [],
    selectedTargetRole: null,
    relativeRangeMeters: null,
    relativeClosingSpeedMetersPerSecond: null,
    holdStableForMs: 0,
    landing: {
      contactCount: 0,
      stableForMs: 0,
      insideTrainingEllipse: false,
      verticalSpeedMetersPerSecond: 0,
      horizontalSpeedMetersPerSecond: 0,
      slopeDegrees: 0,
    },
    parachutesDeployed: false,
    recoveryLatitudeDegrees: null,
    recoveryLongitudeDegrees: null,
  };
}

export function vesselForArtemisIvRole(
  state: Readonly<ArtemisIvMissionState>,
  role: ArtemisIvRole,
): GameVessel | null {
  const vesselId = state.roles[role];
  if (!vesselId) return null;
  return state.game.vessels.find((vessel) => vessel.runtime.id === vesselId) ?? null;
}

export function artemisIvRolesShareVessel(
  state: Readonly<ArtemisIvMissionState>,
  ...roles: readonly ArtemisIvRole[]
): boolean {
  if (roles.length < 2) return false;
  const vesselId = state.roles[roles[0]];
  return vesselId !== null && roles.every((role) => state.roles[role] === vesselId);
}

/** Scope guide predicates by mission role even when several roles share a docked vessel id. */
export function isActiveArtemisIvRole(
  state: Readonly<ArtemisIvMissionState>,
  role: ArtemisIvRole,
): boolean {
  const vesselId = state.roles[role];
  return state.activeRole === role
    && vesselId !== null
    && state.game.activeVesselId === vesselId;
}

export function setActiveArtemisIvRole(state: ArtemisIvMissionState, role: ArtemisIvRole): void {
  const vessel = vesselForArtemisIvRole(state, role);
  if (!vessel) throw new Error(`Artemis IV role ${role} has no live vessel`);
  state.activeRole = role;
  state.game.activeVesselId = vessel.runtime.id;
}

export function bindArtemisIvRole(
  state: ArtemisIvMissionState,
  role: ArtemisIvRole,
  vesselId: string | null,
): void {
  if (vesselId !== null && !state.game.vessels.some((vessel) => vessel.runtime.id === vesselId)) {
    throw new Error(`Cannot bind Artemis IV role ${role} to unknown vessel ${vesselId}`);
  }
  state.roles[role] = vesselId;
}

/** Record the result of authoritative GameState docking without depending on retained vessel ids. */
export function recordArtemisIvDocking(
  state: ArtemisIvMissionState,
  retainedVesselId: string,
): void {
  for (const role of ARTEMIS_IV_ROLES) bindArtemisIvRole(state, role, retainedVesselId);
  syncArtemisIvCrewToRuntime(state);
}

/** Rebind role identity immediately after GameState undocking/splitting. */
export function recordArtemisIvUndocking(
  state: ArtemisIvMissionState,
  orionVesselId: string,
  landerVesselId: string,
): void {
  bindArtemisIvRole(state, 'orion-cm', orionVesselId);
  bindArtemisIvRole(state, 'orion-esm', orionVesselId);
  bindArtemisIvRole(state, 'hls', landerVesselId);
  syncArtemisIvCrewToRuntime(state);
}

export function acknowledgeArtemisIvBriefing(state: ArtemisIvMissionState): void {
  if (state.chapter !== 0) throw new Error('The Artemis IV briefing belongs to Chapter 0');
  state.acknowledgements['provider-stand-in-understood'] = true;
}

export function validateArtemisIvOutboundCrew(state: Readonly<ArtemisIvMissionState>): boolean {
  const orion = state.crew['orion-cm'];
  const lander = state.crew.hls;
  return arraysEqual(orion, ARTEMIS_IV_REPRESENTATIVE_CREW.slice(0, 2))
    && arraysEqual(lander, ARTEMIS_IV_REPRESENTATIVE_CREW.slice(2));
}

export function acknowledgeArtemisIvOutboundCrewTransfer(state: ArtemisIvMissionState): void {
  if (!artemisIvRolesShareVessel(state, 'orion-cm', 'hls')) {
    throw new Error('Crew transfer requires docked Orion and lander roles');
  }
  if (!arraysEqual(state.crew['orion-cm'], ARTEMIS_IV_REPRESENTATIVE_CREW) || state.crew.hls.length) {
    throw new Error('Outbound crew transfer requires all four representative crew in Orion');
  }
  state.crew['orion-cm'] = [...ARTEMIS_IV_REPRESENTATIVE_CREW.slice(0, 2)];
  state.crew.hls = [...ARTEMIS_IV_REPRESENTATIVE_CREW.slice(2)];
  state.acknowledgements['crew-transfer-to-lander'] = true;
  syncArtemisIvCrewToRuntime(state);
  if (!validateArtemisIvOutboundCrew(state)) throw new Error('Outbound crew allocation failed');
}

export function acknowledgeArtemisIvSurfaceExpedition(state: ArtemisIvMissionState): void {
  const lander = vesselForArtemisIvRole(state, 'hls');
  if (!lander || lander.runtime.situation !== 'landed' || !validateArtemisIvOutboundCrew(state)) {
    throw new Error('Surface acknowledgement requires the landed two-person lander state');
  }
  state.samples = { count: 1, ownerRole: 'hls', status: 'aboard-lander' };
  state.acknowledgements['surface-expedition-complete'] = true;
}

export function validateArtemisIvReturnManifest(state: Readonly<ArtemisIvMissionState>): boolean {
  return arraysEqual(state.crew['orion-cm'], ARTEMIS_IV_REPRESENTATIVE_CREW)
    && state.crew.hls.length === 0
    && state.samples.count === 1
    && state.samples.ownerRole === 'orion-cm'
    && state.samples.status === 'aboard-orion';
}

export function acknowledgeArtemisIvReturnTransfer(state: ArtemisIvMissionState): void {
  if (!artemisIvRolesShareVessel(state, 'orion-cm', 'hls')) {
    throw new Error('Return transfer requires docked Orion and lander roles');
  }
  if (!validateArtemisIvOutboundCrew(state)) {
    throw new Error('Return transfer requires the two-and-two crew allocation');
  }
  if (state.samples.count !== 1 || state.samples.ownerRole !== 'hls') {
    throw new Error('Return transfer requires the representative sample cache aboard the lander');
  }
  state.crew['orion-cm'] = [...ARTEMIS_IV_REPRESENTATIVE_CREW];
  state.crew.hls = [];
  state.samples = { count: 1, ownerRole: 'orion-cm', status: 'aboard-orion' };
  state.acknowledgements['crew-and-samples-returned-to-orion'] = true;
  syncArtemisIvCrewToRuntime(state);
  if (!validateArtemisIvReturnManifest(state)) throw new Error('Return manifest validation failed');
}

export function syncArtemisIvCrewToRuntime(state: ArtemisIvMissionState): void {
  const orion = vesselForArtemisIvRole(state, 'orion-cm');
  const lander = vesselForArtemisIvRole(state, 'hls');
  if (orion && lander && orion.runtime.id === lander.runtime.id) {
    orion.runtime.crew = [...state.crew['orion-cm'], ...state.crew.hls];
    return;
  }
  if (orion) orion.runtime.crew = [...state.crew['orion-cm']];
  if (lander) lander.runtime.crew = [...state.crew.hls];
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
