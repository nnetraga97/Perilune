import { apoapsisOf, periapsisOf, stateToElements } from '../../core/orbit';
import {
  ARTEMIS_IV_STAND_IN_LABEL,
  acknowledgeArtemisIvBriefing,
  acknowledgeArtemisIvOutboundCrewTransfer,
  acknowledgeArtemisIvReturnTransfer,
  acknowledgeArtemisIvSurfaceExpedition,
  artemisIvRolesShareVessel,
  isActiveArtemisIvRole,
  validateArtemisIvOutboundCrew,
  validateArtemisIvReturnManifest,
  vesselForArtemisIvRole,
  type ArtemisIvMissionState,
  type ArtemisIvRole,
} from './mission';
import {
  ARTEMIS_IV_CHECKPOINTS,
  ARTEMIS_IV_PREPARED,
  ARTEMIS_IV_PREPARED_MANEUVER_IDS,
} from './checkpoints';
import type { ArtemisIvChapter } from './session';

export const ARTEMIS_IV_GUIDE_CONFIRMATION_MS = 400;
export type ArtemisIvGuideStepKind = 'read' | 'do' | 'watch';

export interface ArtemisIvGuideStep {
  id: string;
  chapter: ArtemisIvChapter;
  kind: ArtemisIvGuideStepKind;
  textStep: boolean;
  title: string;
  doNext: string;
  successMessage: string;
  complete(state: Readonly<ArtemisIvMissionState>): boolean;
  onContinue?: (state: ArtemisIvMissionState) => void;
}

export interface ArtemisIvGuideProgress {
  chapter: ArtemisIvChapter;
  stepId: string | null;
  satisfiedAtMs: number | null;
  complete: boolean;
}

export interface ArtemisIvGuideViewModel {
  missionLabel: 'ARTEMIS IV';
  accuracyLabel: typeof ARTEMIS_IV_STAND_IN_LABEL;
  chapter: ArtemisIvChapter;
  chapterTitle: string;
  kind: ArtemisIvGuideStepKind | null;
  title: string;
  doNext: string;
  successMessage: string | null;
  stepNumber: number;
  stepCount: number;
  confirmationRemainingMs: number;
  primaryAction: Readonly<{ id: 'continue'; label: 'CONTINUE' }> | null;
}

export type ArtemisIvGuideSignal = 'waiting' | 'confirming' | 'advanced' | 'chapter-complete';
export interface ArtemisIvGuideUpdate {
  progress: ArtemisIvGuideProgress;
  signal: ArtemisIvGuideSignal;
}

const P = ARTEMIS_IV_PREPARED;
const MID = ARTEMIS_IV_PREPARED_MANEUVER_IDS;

/** Plain chapter data: text steps mutate through Continue; every other step polls a direct predicate. */
export const ARTEMIS_IV_GUIDE_STEPS: readonly ArtemisIvGuideStep[] = Object.freeze([
  {
    id: 'briefing', chapter: 0, kind: 'read', textStep: true,
    title: 'Current mission, representative simulation',
    doNext: 'Read the provider and visual-accuracy note, then continue.',
    successMessage: 'MISSION BRIEFING ACKNOWLEDGED',
    complete: (s) => s.acknowledgements['provider-stand-in-understood'],
    onContinue: acknowledgeArtemisIvBriefing,
  },
  {
    id: 'post-tli-correction', chapter: 1, kind: 'do', textStep: false,
    title: 'Refine the lunar encounter',
    doNext: 'Raise prograde to 21 m/s so the predicted Moon periapsis is 60–145 km, then arm and execute.',
    successMessage: 'TRANSFER SOLUTION ACCEPTED',
    complete: (s) => completedByRole(s, 'orion-cm', MID.postTliCorrection),
  },
  {
    id: 'lunar-orbit-insertion', chapter: 1, kind: 'do', textStep: false,
    title: 'Capture into lunar orbit', doNext: 'Inspect and execute the separate retrograde insertion burn.',
    successMessage: 'POLAR STAGING ORBIT CONFIRMED',
    complete: (s) => completedByRole(s, 'orion-cm', MID.lunarOrbitInsertion)
      && polarLunarOrbit(s, 'orion-cm', [70_000, 140_000], 85),
  },
  {
    id: 'outbound-rendezvous-hold', chapter: 2, kind: 'do', textStep: false,
    title: 'Find the lander and establish a hold',
    doNext: 'Target the lander, approach gently, and stop inside the marked hold envelope.',
    successMessage: 'SAFE HOLD ESTABLISHED',
    complete: (s) => rendezvousHold(s, 'orion-cm', 'hls', P.outboundRendezvous),
  },
  {
    id: 'dock', chapter: 3, kind: 'do', textStep: false,
    title: 'Complete docking', doNext: 'Align the collars and close below the docking speed limit.',
    successMessage: 'DOCKING CONFIRMED',
    complete: (s) => isActiveArtemisIvRole(s, 'orion-cm')
      && artemisIvRolesShareVessel(s, 'orion-cm', 'hls'),
  },
  {
    id: 'outbound-crew-transfer', chapter: 3, kind: 'read', textStep: true,
    title: 'Two crew transfer to the lander',
    doNext: 'Continue after the representative two-and-two transfer summary.',
    successMessage: 'TWO CREW ABOARD EACH VEHICLE',
    complete: (s) => s.acknowledgements['crew-transfer-to-lander'] && validateArtemisIvOutboundCrew(s),
    onContinue: acknowledgeArtemisIvOutboundCrewTransfer,
  },
  {
    id: 'commit-descent', chapter: 4, kind: 'do', textStep: false,
    title: 'Take control of the lander',
    doNext: 'Switch to the lander, undock, and execute the prepared descent setup.',
    successMessage: 'DESCENT CORRIDOR ENTERED',
    complete: (s) => isActiveArtemisIvRole(s, 'hls')
      && !artemisIvRolesShareVessel(s, 'orion-cm', 'hls')
      && s.telemetry.completedManeuverIds.includes(MID.descentSetup),
  },
  {
    id: 'descent-braking', chapter: 5, kind: 'do', textStep: false,
    title: 'Remove sideways speed first',
    doNext: 'Stage once, hold RETROGRADE, and burn until horizontal speed is below 10 m/s. Then cut throttle.',
    successMessage: 'HORIZONTAL SPEED ARRESTED', complete: descentBrakingComplete,
  },
  {
    id: 'descent-coast', chapter: 5, kind: 'watch', textStep: false,
    title: 'Coast into the terminal descent',
    doNext: 'Keep throttle at zero while downward speed builds. Prepare to turn RADIAL OUT when this step confirms.',
    successMessage: 'TERMINAL DESCENT CUE', complete: terminalDescentReached,
  },
  {
    id: 'lunar-landing', chapter: 5, kind: 'do', textStep: false,
    title: 'Brake vertically and settle',
    doNext: 'Hold RADIAL OUT and modulate throttle. Touch down below 2.5 m/s vertical and 1.5 m/s horizontal inside the ellipse.',
    successMessage: 'STABLE LUNAR LANDING', complete: safeLanding,
  },
  {
    id: 'surface-expedition', chapter: 6, kind: 'read', textStep: true,
    title: 'Surface expedition',
    doNext: 'Two crew spend approximately one week near the lunar South Pole conducting surface operations. This craft-focused tutorial summarizes that work and loads one representative sample cache aboard the lander. Continue to ascent.',
    successMessage: 'REPRESENTATIVE SAMPLE CACHE SECURED',
    complete: (s) => s.acknowledgements['surface-expedition-complete']
      && s.samples.ownerRole === 'hls' && s.samples.count === 1,
    onContinue: acknowledgeArtemisIvSurfaceExpedition,
  },
  {
    id: 'ascent-raise-apoapsis', chapter: 7, kind: 'do', textStep: false,
    title: 'Launch into a near-polar plane',
    doNext: 'Stage and climb RADIAL OUT, then pitch toward the horizon to build sideways speed. Cut throttle when apoapsis reaches 85–125 km.',
    successMessage: 'APOAPSIS RAISED', complete: ascentApoapsisRaised,
  },
  {
    id: 'lunar-ascent', chapter: 7, kind: 'do', textStep: false,
    title: 'Raise periapsis near apoapsis',
    doNext: 'Coast toward apoapsis, then burn PROGRADE until periapsis reaches 85–115 km. Keep inclination at or above 85°.',
    successMessage: 'ASCENT ORBIT CONFIRMED', complete: ascentOrbitAccepted,
  },
  {
    id: 'rejoin-orion', chapter: 8, kind: 'do', textStep: false,
    title: 'Find and redock with Orion',
    doNext: 'Target Orion, rendezvous, hold, align, and close for docking.',
    successMessage: 'CREW VEHICLES REJOINED',
    complete: (s) => isActiveArtemisIvRole(s, 'hls')
      && s.telemetry.selectedTargetRole === 'orion-cm'
      && artemisIvRolesShareVessel(s, 'orion-cm', 'hls'),
  },
  {
    id: 'return-transfer', chapter: 8, kind: 'read', textStep: true,
    title: 'Crew and samples return to Orion',
    doNext: 'Continue after the representative return-transfer summary.',
    successMessage: 'FOUR CREW AND SAMPLES ABOARD ORION',
    complete: (s) => s.acknowledgements['crew-and-samples-returned-to-orion']
      && validateArtemisIvReturnManifest(s),
    onContinue: acknowledgeArtemisIvReturnTransfer,
  },
  {
    id: 'separate-lander', chapter: 9, kind: 'do', textStep: false,
    title: 'Leave the lander in lunar orbit', doNext: 'Undock the lander and keep control of Orion.',
    successMessage: 'ORION CLEAR FOR DEPARTURE',
    complete: (s) => isActiveArtemisIvRole(s, 'orion-cm')
      && !artemisIvRolesShareVessel(s, 'orion-cm', 'hls')
      && validateArtemisIvReturnManifest(s),
  },
  {
    id: 'trans-earth-injection', chapter: 9, kind: 'watch', textStep: false,
    title: 'Depart the Moon and coast to Earth',
    doNext: 'Inspect and execute the prepared return burn, then warp to Earth approach.',
    successMessage: 'EARTH APPROACH CONFIRMED',
    complete: (s) => completedByRole(s, 'orion-cm', MID.transEarthInjection)
      && vesselForArtemisIvRole(s, 'orion-cm')?.runtime.bodyId === 'earth',
  },
  {
    id: 'separate-service-module', chapter: 10, kind: 'do', textStep: false,
    title: 'Prepare the crew module for entry',
    doNext: 'Jettison the service module and hold the entry attitude.',
    successMessage: 'CREW MODULE CONFIGURED FOR ENTRY',
    complete: (s) => isActiveArtemisIvRole(s, 'orion-cm')
      && !artemisIvRolesShareVessel(s, 'orion-cm', 'orion-esm'),
  },
  {
    id: 'splashdown', chapter: 10, kind: 'watch', textStep: false,
    title: 'Complete entry and splashdown',
    doNext: 'Survive entry, deploy parachutes, and splash down in the recovery area.',
    successMessage: 'ARTEMIS IV TRAINING MISSION COMPLETE', complete: recovered,
  },
]);

export function createArtemisIvGuideProgress(chapter: ArtemisIvChapter): ArtemisIvGuideProgress {
  const first = stepsFor(chapter)[0];
  return { chapter, stepId: first?.id ?? null, satisfiedAtMs: null, complete: !first };
}

export function currentArtemisIvGuideStep(
  progress: Readonly<ArtemisIvGuideProgress>,
): ArtemisIvGuideStep | null {
  return progress.complete || !progress.stepId
    ? null
    : ARTEMIS_IV_GUIDE_STEPS.find((step) => step.chapter === progress.chapter && step.id === progress.stepId) ?? null;
}

/** False predicates reset the dwell; continuously true predicates advance after 400 ms. */
export function updateArtemisIvGuide(
  progress: Readonly<ArtemisIvGuideProgress>,
  state: Readonly<ArtemisIvMissionState>,
  nowMs: number,
): ArtemisIvGuideUpdate {
  assertChapter(progress, state);
  const step = currentArtemisIvGuideStep(progress);
  if (!step) return { progress: { ...progress, complete: true }, signal: 'chapter-complete' };
  if (!step.complete(state)) return { progress: { ...progress, satisfiedAtMs: null }, signal: 'waiting' };
  if (progress.satisfiedAtMs === null) {
    return { progress: { ...progress, satisfiedAtMs: nowMs }, signal: 'confirming' };
  }
  if (nowMs - progress.satisfiedAtMs < ARTEMIS_IV_GUIDE_CONFIRMATION_MS) {
    return { progress: { ...progress }, signal: 'confirming' };
  }
  const chapterSteps = stepsFor(progress.chapter);
  const next = chapterSteps[chapterSteps.findIndex((candidate) => candidate.id === step.id) + 1];
  return next
    ? { progress: { ...progress, stepId: next.id, satisfiedAtMs: null }, signal: 'advanced' }
    : { progress: { ...progress, stepId: null, satisfiedAtMs: null, complete: true }, signal: 'chapter-complete' };
}

/** Apply a text acknowledgement. Action and watch steps intentionally reject Continue. */
export function continueArtemisIvGuide(
  progress: Readonly<ArtemisIvGuideProgress>,
  state: ArtemisIvMissionState,
  nowMs: number,
): ArtemisIvGuideUpdate {
  assertChapter(progress, state);
  const step = currentArtemisIvGuideStep(progress);
  if (!step?.textStep || !step.onContinue) throw new Error('Continue is available only on Artemis IV text steps');
  step.onContinue(state);
  return updateArtemisIvGuide(progress, state, nowMs);
}

export function artemisIvGuideViewModel(
  progress: Readonly<ArtemisIvGuideProgress>,
  nowMs: number,
): ArtemisIvGuideViewModel {
  const step = currentArtemisIvGuideStep(progress);
  const steps = stepsFor(progress.chapter);
  const index = step ? steps.findIndex((candidate) => candidate.id === step.id) : steps.length;
  const elapsed = progress.satisfiedAtMs === null ? 0 : Math.max(0, nowMs - progress.satisfiedAtMs);
  return {
    missionLabel: 'ARTEMIS IV', accuracyLabel: ARTEMIS_IV_STAND_IN_LABEL,
    chapter: progress.chapter, chapterTitle: ARTEMIS_IV_CHECKPOINTS[progress.chapter]?.title ?? '',
    kind: step?.kind ?? null, title: step?.title ?? 'Chapter complete', doNext: step?.doNext ?? '',
    successMessage: progress.satisfiedAtMs === null ? null : step?.successMessage ?? null,
    stepNumber: Math.min(index + 1, steps.length), stepCount: steps.length,
    confirmationRemainingMs: progress.satisfiedAtMs === null
      ? 0 : Math.max(0, ARTEMIS_IV_GUIDE_CONFIRMATION_MS - elapsed),
    primaryAction: step?.textStep ? { id: 'continue', label: 'CONTINUE' } : null,
  };
}

function stepsFor(chapter: ArtemisIvChapter): readonly ArtemisIvGuideStep[] {
  return ARTEMIS_IV_GUIDE_STEPS.filter((step) => step.chapter === chapter);
}

function assertChapter(progress: Readonly<ArtemisIvGuideProgress>, state: Readonly<ArtemisIvMissionState>): void {
  if (progress.chapter !== state.chapter) throw new Error('Artemis IV guide/checkpoint chapter mismatch');
}

function completedByRole(state: Readonly<ArtemisIvMissionState>, role: ArtemisIvRole, id: string): boolean {
  return isActiveArtemisIvRole(state, role) && state.telemetry.completedManeuverIds.includes(id);
}

function rendezvousHold(
  state: Readonly<ArtemisIvMissionState>,
  activeRole: ArtemisIvRole,
  targetRole: ArtemisIvRole,
  envelope: typeof P.outboundRendezvous,
): boolean {
  const { relativeRangeMeters: range, relativeClosingSpeedMetersPerSecond: closing } = state.telemetry;
  return isActiveArtemisIvRole(state, activeRole)
    && state.telemetry.selectedTargetRole === targetRole
    && range !== null && range <= envelope.holdRangeMeters
    && closing !== null && Math.abs(closing) <= envelope.maximumClosingSpeedMetersPerSecond
    && state.telemetry.holdStableForMs >= 1_000;
}

function safeLanding(state: Readonly<ArtemisIvMissionState>): boolean {
  const vessel = vesselForArtemisIvRole(state, 'hls');
  const landing = state.telemetry.landing;
  const limit = P.descent;
  return isActiveArtemisIvRole(state, 'hls')
    && vessel?.runtime.bodyId === 'moon' && vessel.runtime.situation === 'landed'
    && landing.insideTrainingEllipse && landing.contactCount >= limit.requiredContactCount
    && landing.stableForMs >= limit.requiredStableMs
    && Math.abs(landing.verticalSpeedMetersPerSecond) <= limit.maximumTouchdownVerticalSpeedMetersPerSecond
    && Math.abs(landing.horizontalSpeedMetersPerSecond) <= limit.maximumTouchdownHorizontalSpeedMetersPerSecond
    && landing.slopeDegrees <= limit.maximumSlopeDegrees;
}

function descentBrakingComplete(state: Readonly<ArtemisIvMissionState>): boolean {
  const lander = vesselForArtemisIvRole(state, 'hls');
  return isActiveArtemisIvRole(state, 'hls')
    && lander?.runtime.bodyId === 'moon' && lander.runtime.situation !== 'landed'
    && state.telemetry.landing.horizontalSpeedMetersPerSecond <= 10;
}

function terminalDescentReached(state: Readonly<ArtemisIvMissionState>): boolean {
  const lander = vesselForArtemisIvRole(state, 'hls');
  return isActiveArtemisIvRole(state, 'hls')
    && (lander?.runtime.controls.throttle ?? 1) <= 0.01
    && state.telemetry.landing.verticalSpeedMetersPerSecond <= -25;
}

function ascentApoapsisRaised(state: Readonly<ArtemisIvMissionState>): boolean {
  const vessel = vesselForArtemisIvRole(state, 'hls');
  if (!isActiveArtemisIvRole(state, 'hls') || vessel?.runtime.bodyId !== 'moon'
    || vessel.runtime.situation === 'landed') return false;
  const moon = state.game.universe.get('moon');
  const elements = stateToElements(moon.mu, vessel.runtime.pos, vessel.runtime.vel, state.game.time);
  return elements.e < 1
    && apoapsisOf(elements) - moon.radius >= P.ascent.targetApoapsisAltitudeMeters[0]
    && elements.i * 180 / Math.PI >= P.ascent.minimumInclinationDegrees;
}

function ascentOrbitAccepted(state: Readonly<ArtemisIvMissionState>): boolean {
  const vessel = vesselForArtemisIvRole(state, 'hls');
  if (!isActiveArtemisIvRole(state, 'hls') || vessel?.runtime.bodyId !== 'moon' || vessel.runtime.situation !== 'orbit') return false;
  const moon = state.game.universe.get('moon');
  const elements = stateToElements(moon.mu, vessel.runtime.pos, vessel.runtime.vel, state.game.time);
  return inside(periapsisOf(elements) - moon.radius, P.ascent.targetPeriapsisAltitudeMeters)
    && inside(apoapsisOf(elements) - moon.radius, P.ascent.targetApoapsisAltitudeMeters)
    && elements.i * 180 / Math.PI >= P.ascent.minimumInclinationDegrees;
}

function polarLunarOrbit(
  state: Readonly<ArtemisIvMissionState>,
  role: ArtemisIvRole,
  altitude: readonly [number, number],
  minimumInclinationDegrees: number,
): boolean {
  const vessel = vesselForArtemisIvRole(state, role);
  if (vessel?.runtime.bodyId !== 'moon' || vessel.runtime.situation !== 'orbit') return false;
  const moon = state.game.universe.get('moon');
  const elements = stateToElements(moon.mu, vessel.runtime.pos, vessel.runtime.vel, state.game.time);
  return periapsisOf(elements) - moon.radius >= altitude[0]
    && apoapsisOf(elements) - moon.radius <= altitude[1]
    && elements.i * 180 / Math.PI >= minimumInclinationDegrees;
}

function recovered(state: Readonly<ArtemisIvMissionState>): boolean {
  const orion = vesselForArtemisIvRole(state, 'orion-cm');
  const latitude = state.telemetry.recoveryLatitudeDegrees;
  const longitude = state.telemetry.recoveryLongitudeDegrees;
  if (!isActiveArtemisIvRole(state, 'orion-cm') || orion?.runtime.situation !== 'splashed'
    || !state.telemetry.parachutesDeployed || latitude === null || longitude === null) return false;
  const region = P.entry.recoveryRegion;
  const latDelta = latitude - region.centerLatitudeDegrees;
  const lonDelta = wrappedLongitudeDelta(longitude, region.centerLongitudeDegrees)
    * Math.cos(region.centerLatitudeDegrees * Math.PI / 180);
  return Math.hypot(latDelta, lonDelta) <= region.radiusDegrees;
}

function wrappedLongitudeDelta(left: number, right: number): number {
  let delta = left - right;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function inside(value: number, range: readonly [number, number]): boolean {
  return value >= range[0] && value <= range[1];
}
