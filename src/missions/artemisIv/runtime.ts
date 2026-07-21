import { apoapsisOf, periapsisOf, stateToElements } from '../../core/orbit';
import { Vec3 } from '../../core/vec3';
import { bodyFixedDirectionToSpherical } from '../../sim/bodyReferenceFrame';
import { inertialToBodyFixed, surfaceVelocity } from '../../sim/bodyOrientation';
import type { GameState, GameVessel } from '../../sim/state';
import { surfaceSlopeDegrees } from '../../sim/terrain';
import { defOf } from '../../sim/vessel';
import type {
  ArtemisIvAssetResourceAccounting,
  ArtemisIvRendererResourceLedger,
} from './assets';
import {
  ARTEMIS_IV_PREPARED,
  ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE,
  artemisIvCheckpointForChapter,
} from './checkpoints';
import {
  vesselForArtemisIvRole,
  type ArtemisIvLandingTelemetry,
  type ArtemisIvMissionState,
  type ArtemisIvRole,
} from './mission';

export interface ArtemisIvRelativeMotion {
  readonly rangeMeters: number;
  /** Positive while closing, negative while opening. */
  readonly closingSpeedMetersPerSecond: number;
}

export interface ArtemisIvRecoveryTelemetry {
  readonly latitudeDegrees: number | null;
  readonly longitudeDegrees: number | null;
  /** The recovery stage has fired, but the canopy may still be waiting on altitude/pressure. */
  readonly parachutesArmed: boolean;
  readonly parachutesDeployed: boolean;
}

/** Structurally matches the guide UI without introducing a mission-to-UI dependency. */
export interface ArtemisIvGuideReadout {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'neutral' | 'caution' | 'good';
}

const positionA = new Vec3();
const velocityA = new Vec3();
const positionB = new Vec3();
const velocityB = new Vec3();
const deltaPosition = new Vec3();
const deltaVelocity = new Vec3();
const bodyFixed = new Vec3();
const radial = new Vec3();
const relativeVelocity = new Vec3();
const siteCenter = siteDirection();
const siteEast = new Vec3(-siteCenter.y, siteCenter.x, 0).normalize();
const siteNorth = Vec3.cross(siteCenter, siteEast, new Vec3()).normalize();

function liveState(game: GameState, vessel: GameVessel, position: Vec3, velocity: Vec3): boolean {
  if (vessel.regime === 'rails') game.railsPosition(vessel, position, velocity);
  else {
    position.copy(vessel.runtime.pos);
    velocity.copy(vessel.runtime.vel);
  }
  return position.isFinite() && velocity.isFinite();
}

/** Rails-aware relative motion for two live vessels around the same primary. */
export function computeArtemisIvRelativeMotion(
  game: GameState,
  chaser: GameVessel | null,
  target: GameVessel | null,
): ArtemisIvRelativeMotion | null {
  if (!chaser || !target || chaser.runtime.bodyId !== target.runtime.bodyId
    || !liveState(game, chaser, positionA, velocityA)
    || !liveState(game, target, positionB, velocityB)) return null;
  deltaPosition.copy(positionB).sub(positionA);
  deltaVelocity.copy(velocityB).sub(velocityA);
  const rangeMeters = deltaPosition.length();
  const closingSpeedMetersPerSecond = rangeMeters > 1e-6
    ? -deltaVelocity.dot(deltaPosition) / rangeMeters
    : 0;
  return Object.freeze({ rangeMeters, closingSpeedMetersPerSecond });
}

/** Sync the selected role target and the chapter's one-second rendezvous hold. */
export function syncArtemisIvRendezvousTelemetry(
  state: ArtemisIvMissionState,
  targetRole: ArtemisIvRole | null,
  elapsedMs: number,
): ArtemisIvRelativeMotion | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Artemis IV telemetry elapsed time must be non-negative');
  state.telemetry.selectedTargetRole = targetRole;
  const active = state.activeRole ? vesselForArtemisIvRole(state, state.activeRole) : null;
  const target = targetRole ? vesselForArtemisIvRole(state, targetRole) : null;
  const motion = computeArtemisIvRelativeMotion(state.game, active, target);
  state.telemetry.relativeRangeMeters = motion?.rangeMeters ?? null;
  state.telemetry.relativeClosingSpeedMetersPerSecond = motion?.closingSpeedMetersPerSecond ?? null;

  const envelope = artemisIvCheckpointForChapter(state.chapter).prepared.rendezvous;
  const holding = Boolean(motion && envelope && state.activeRole === envelope.chaserRole
    && targetRole === envelope.targetRole
    && motion.rangeMeters <= envelope.holdRangeMeters
    && Math.abs(motion.closingSpeedMetersPerSecond) <= envelope.maximumClosingSpeedMetersPerSecond);
  state.telemetry.holdStableForMs = holding
    ? Math.min(Number.MAX_SAFE_INTEGER, state.telemetry.holdStableForMs + elapsedMs)
    : 0;
  return motion;
}

/** Live landing measurements from the HLS proxy and its explicit four-pad footprint. */
export function computeArtemisIvLandingTelemetry(
  state: Readonly<ArtemisIvMissionState>,
): ArtemisIvLandingTelemetry {
  const lander = vesselForArtemisIvRole(state, 'hls');
  if (!lander || lander.runtime.bodyId !== 'moon'
    || !liveState(state.game, lander, positionA, velocityA)) return emptyLanding();
  const moon = state.game.universe.get('moon');
  inertialToBodyFixed(moon, state.game.time, positionA, bodyFixed).normalize();
  radial.copy(positionA).normalize();
  relativeVelocity.copy(velocityA).sub(surfaceVelocity(moon, positionA, velocityB));
  const verticalSpeedMetersPerSecond = relativeVelocity.dot(radial);
  const horizontalSpeedMetersPerSecond = deltaVelocity.copy(relativeVelocity)
    .addScaled(radial, -verticalSpeedMetersPerSecond).length();
  const footprint = lander.runtime.externalLandingFootprint;
  const slopeSpan = footprint ? Math.max(5, footprint.halfWidth * 2, footprint.halfDepth * 2) : 5;
  return Object.freeze({
    contactCount: footprint?.contactCount ?? 0,
    stableForMs: footprint?.stableForMs ?? 0,
    insideTrainingEllipse: insideTrainingEllipse(bodyFixed, moon.radius),
    verticalSpeedMetersPerSecond,
    horizontalSpeedMetersPerSecond,
    slopeDegrees: surfaceSlopeDegrees(moon, bodyFixed, slopeSpan),
  });
}

/** Body-fixed Earth recovery coordinates and actual (not merely armed) chute state. */
export function computeArtemisIvRecoveryTelemetry(
  state: Readonly<ArtemisIvMissionState>,
): ArtemisIvRecoveryTelemetry {
  const orion = vesselForArtemisIvRole(state, 'orion-cm');
  if (!orion || orion.runtime.bodyId !== 'earth'
    || !liveState(state.game, orion, positionA, velocityA)) return emptyRecovery();
  const earth = state.game.universe.get('earth');
  inertialToBodyFixed(earth, state.game.time, positionA, bodyFixed);
  const spherical = bodyFixedDirectionToSpherical(bodyFixed, earth.radius);
  const parachuteParts = orion.runtime.craft.parts.filter((part) => defOf(part).parachute);
  const parachutesArmed = parachuteParts.some((part) => part.activated === true);
  const parachutesDeployed = parachuteParts.some((part) => part.activated === true
    && (part.deployed === true || (part.parachuteDeployFraction ?? 0) > 0));
  return Object.freeze({
    latitudeDegrees: spherical.latitudeRadians * 180 / Math.PI,
    longitudeDegrees: spherical.longitudeRadians * 180 / Math.PI,
    parachutesArmed,
    parachutesDeployed,
  });
}

/** One frame-level synchronization point for the guide predicates. */
export function syncArtemisIvLiveTelemetry(
  state: ArtemisIvMissionState,
  targetRole: ArtemisIvRole | null,
  elapsedMs: number,
): void {
  syncArtemisIvRendezvousTelemetry(state, targetRole, elapsedMs);
  state.telemetry.landing = computeArtemisIvLandingTelemetry(state);
  const recovery = computeArtemisIvRecoveryTelemetry(state);
  state.telemetry.recoveryLatitudeDegrees = recovery.latitudeDegrees;
  state.telemetry.recoveryLongitudeDegrees = recovery.longitudeDegrees;
  state.telemetry.parachutesDeployed = recovery.parachutesDeployed;
}

/** Compact text-first readouts for the only chapters with live numeric gates. */
export function artemisIvGuideReadouts(
  state: Readonly<ArtemisIvMissionState>,
): readonly ArtemisIvGuideReadout[] {
  if (state.chapter === 2 || state.chapter === 3 || state.chapter === 8) return rendezvousReadouts(state);
  if (state.chapter === 5 || state.chapter === 6) return descentReadouts(state);
  if (state.chapter === 7) return ascentReadouts(state);
  if (state.chapter === 10) return entryReadouts(state);
  return [];
}

/** One active Artemis asset layered over a caller-owned current renderer total. */
export function createArtemisIvRendererResourceLedger(
  baseBytes: () => number,
): ArtemisIvRendererResourceLedger {
  let charged: Readonly<Pick<ArtemisIvAssetResourceAccounting, 'assetId' | 'gpuBytes'>> | null = null;
  const checkedBase = (): number => {
    const value = baseBytes();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Artemis IV renderer base ${value}`);
    return value;
  };
  return {
    totalRendererBytes(): number {
      const total = checkedBase() + (charged?.gpuBytes ?? 0);
      if (!Number.isSafeInteger(total)) throw new Error('Artemis IV renderer total exceeds safe integer range');
      return total;
    },
    charge(entry): void {
      if (charged) throw new Error('The Artemis IV renderer ledger already has an active asset charge');
      const components = [entry.geometryBytes, entry.materialBytes, entry.textureBytes];
      const componentBytes = components.reduce((total, value) => total + value, 0);
      if (entry.assetId !== 'martiandays-starship-2019-concept'
        || components.some((value) => !Number.isSafeInteger(value) || value < 0)
        || !Number.isSafeInteger(componentBytes)
        || !Number.isSafeInteger(entry.gpuBytes) || entry.gpuBytes < componentBytes) {
        throw new Error('Invalid Artemis IV asset resource charge');
      }
      const nextTotal = checkedBase() + entry.gpuBytes;
      if (!Number.isSafeInteger(nextTotal)) throw new Error('Artemis IV renderer total exceeds safe integer range');
      charged = Object.freeze({ assetId: entry.assetId, gpuBytes: entry.gpuBytes });
    },
    release(assetId): void {
      if (!charged || charged.assetId !== assetId) throw new Error(`No active Artemis IV asset charge for ${assetId}`);
      charged = null;
    },
  };
}

function insideTrainingEllipse(direction: Readonly<Vec3>, radiusMeters: number): boolean {
  const dot = Math.max(-1, Math.min(1, siteCenter.dot(direction)));
  const angularDistance = Math.acos(dot);
  if (angularDistance < 1e-12) return true;
  const tangent = deltaPosition.copy(direction).addScaled(siteCenter, -dot).normalize();
  const eastMeters = tangent.dot(siteEast) * angularDistance * radiusMeters;
  const northMeters = tangent.dot(siteNorth) * angularDistance * radiusMeters;
  const heading = ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE.ellipse.headingDegrees * Math.PI / 180;
  const major = northMeters * Math.cos(heading) + eastMeters * Math.sin(heading);
  const minor = -northMeters * Math.sin(heading) + eastMeters * Math.cos(heading);
  const ellipse = ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE.ellipse;
  return (major / ellipse.semiMajorMeters) ** 2 + (minor / ellipse.semiMinorMeters) ** 2 <= 1;
}

function rendezvousReadouts(state: Readonly<ArtemisIvMissionState>): ArtemisIvGuideReadout[] {
  const range = state.telemetry.relativeRangeMeters;
  const closing = state.telemetry.relativeClosingSpeedMetersPerSecond;
  const limit = artemisIvCheckpointForChapter(state.chapter).prepared.rendezvous;
  const gentle = closing !== null && limit !== undefined
    && Math.abs(closing) <= limit.maximumClosingSpeedMetersPerSecond;
  return [
    { label: 'Range', value: range === null ? '—' : formatRange(range), tone: range !== null && limit && range <= limit.holdRangeMeters ? 'good' : 'neutral' },
    { label: 'Closing rate', value: closing === null ? '—' : formatClosing(closing), tone: closing === null ? 'neutral' : gentle ? 'good' : 'caution' },
    { label: 'Stable hold', value: `${(state.telemetry.holdStableForMs / 1_000).toFixed(1)} / 1.0 s`, tone: state.telemetry.holdStableForMs >= 1_000 ? 'good' : 'neutral' },
  ];
}

function descentReadouts(state: Readonly<ArtemisIvMissionState>): ArtemisIvGuideReadout[] {
  const landing = state.telemetry.landing;
  const limit = ARTEMIS_IV_PREPARED.descent;
  return [
    { label: 'Landing zone', value: landing.insideTrainingEllipse ? 'INSIDE ELLIPSE' : 'OUTSIDE ELLIPSE', tone: landing.insideTrainingEllipse ? 'good' : 'caution' },
    { label: 'Vertical', value: formatVertical(landing.verticalSpeedMetersPerSecond), tone: Math.abs(landing.verticalSpeedMetersPerSecond) <= limit.maximumTouchdownVerticalSpeedMetersPerSecond ? 'good' : 'caution' },
    { label: 'Horizontal', value: `${landing.horizontalSpeedMetersPerSecond.toFixed(1)} m/s`, tone: landing.horizontalSpeedMetersPerSecond <= limit.maximumTouchdownHorizontalSpeedMetersPerSecond ? 'good' : 'caution' },
    { label: 'Contact', value: `${landing.contactCount} / 4 · ${landing.slopeDegrees.toFixed(1)}°`, tone: landing.contactCount >= limit.requiredContactCount && landing.stableForMs >= limit.requiredStableMs && landing.slopeDegrees <= limit.maximumSlopeDegrees ? 'good' : 'neutral' },
  ];
}

function ascentReadouts(state: Readonly<ArtemisIvMissionState>): ArtemisIvGuideReadout[] {
  const lander = vesselForArtemisIvRole(state, 'hls');
  const limit = ARTEMIS_IV_PREPARED.ascent;
  if (!lander || lander.runtime.bodyId !== 'moon' || lander.runtime.situation === 'landed'
    || !liveState(state.game, lander, positionA, velocityA)) {
    return [
      { label: 'Apoapsis', value: 'SURFACE' },
      { label: 'Periapsis', value: 'SURFACE' },
      { label: 'Inclination', value: 'SURFACE' },
    ];
  }
  const moon = state.game.universe.get('moon');
  const elements = stateToElements(moon.mu, positionA, velocityA, state.game.time);
  const periapsis = periapsisOf(elements) - moon.radius;
  const apoapsis = elements.e < 1 ? apoapsisOf(elements) - moon.radius : Infinity;
  const inclination = elements.i * 180 / Math.PI;
  return [
    {
      label: 'Apoapsis',
      value: Number.isFinite(apoapsis) ? formatAltitude(apoapsis) : 'ESCAPE',
      tone: orbitRangeTone(apoapsis, limit.targetApoapsisAltitudeMeters),
    },
    {
      label: 'Periapsis',
      value: Number.isFinite(periapsis) ? formatAltitude(periapsis) : '—',
      tone: orbitRangeTone(periapsis, limit.targetPeriapsisAltitudeMeters),
    },
    {
      label: 'Inclination',
      value: Number.isFinite(inclination) ? `${inclination.toFixed(1)}°` : '—',
      tone: Number.isFinite(inclination) && inclination >= limit.minimumInclinationDegrees
        ? 'good'
        : 'caution',
    },
  ];
}

function entryReadouts(state: Readonly<ArtemisIvMissionState>): ArtemisIvGuideReadout[] {
  const { recoveryLatitudeDegrees: latitude, recoveryLongitudeDegrees: longitude } = state.telemetry;
  const recovery = computeArtemisIvRecoveryTelemetry(state);
  const parachuteValue = recovery.parachutesDeployed
    ? 'DEPLOYED'
    : recovery.parachutesArmed ? 'ARMED' : 'STOWED';
  return [
    { label: 'Recovery', value: latitude === null || longitude === null ? '—' : `${coordinate(latitude, 'N', 'S')} · ${coordinate(longitude, 'E', 'W')}` },
    { label: 'Parachutes', value: parachuteValue, tone: recovery.parachutesDeployed ? 'good' : recovery.parachutesArmed ? 'neutral' : 'caution' },
  ];
}

function siteDirection(): Vec3 {
  const latitude = ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE.latitudeDegrees * Math.PI / 180;
  const longitude = ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE.longitudeDegrees * Math.PI / 180;
  return new Vec3(Math.cos(latitude) * Math.cos(longitude), Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude));
}

function emptyLanding(): ArtemisIvLandingTelemetry {
  return { contactCount: 0, stableForMs: 0, insideTrainingEllipse: false, verticalSpeedMetersPerSecond: 0, horizontalSpeedMetersPerSecond: 0, slopeDegrees: 0 };
}

function emptyRecovery(): ArtemisIvRecoveryTelemetry {
  return { latitudeDegrees: null, longitudeDegrees: null, parachutesArmed: false, parachutesDeployed: false };
}

function orbitRangeTone(
  value: number,
  range: readonly [number, number],
): ArtemisIvGuideReadout['tone'] {
  if (!Number.isFinite(value) || value > range[1]) return 'caution';
  return value >= range[0] ? 'good' : 'neutral';
}

function formatAltitude(meters: number): string {
  return Math.abs(meters) >= 1_000
    ? `${(meters / 1_000).toFixed(1)} km`
    : `${meters.toFixed(0)} m`;
}

function formatRange(meters: number): string {
  return meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} km` : `${meters.toFixed(meters < 100 ? 1 : 0)} m`;
}

function formatClosing(speed: number): string {
  return `${Math.abs(speed).toFixed(2)} m/s ${speed >= 0 ? 'CLOSING' : 'OPENING'}`;
}

function formatVertical(speed: number): string {
  return `${Math.abs(speed).toFixed(1)} m/s ${speed <= 0 ? 'DOWN' : 'UP'}`;
}

function coordinate(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(2)}° ${value >= 0 ? positive : negative}`;
}
