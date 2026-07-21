import { describe, expect, it } from 'vitest';
import { elementsToState, stateToElements } from '../src/core/orbit';
import { Vec3 } from '../src/core/vec3';
import { bodyFixedToInertial } from '../src/sim/bodyOrientation';
import { PARTS } from '../src/content/parts';
import { GameState } from '../src/sim/state';
import {
  ARTEMIS_IV_CHECKPOINT_INITIALIZERS,
  ARTEMIS_IV_CHECKPOINTS,
  ARTEMIS_IV_LUNAR_ENCOUNTER_CORRIDOR,
  ARTEMIS_IV_POST_TLI_START_NODE,
  ARTEMIS_IV_PREPARED,
  ARTEMIS_IV_PREPARED_MANEUVER_IDS,
  ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE,
  assessArtemisIvPostTliCorrection,
  createArtemisIvSiteCrossingPolarOrbit,
  initializeArtemisIvCheckpoint,
  prepareArtemisIvEarthApproach,
  prepareArtemisIvLunarInsertion,
} from '../src/missions/artemisIv/checkpoints';
import {
  ARTEMIS_IV_PUBLIC_FACTS,
  ARTEMIS_IV_REPRESENTATIVE_CREW,
  ARTEMIS_IV_ROLES,
  ARTEMIS_IV_STAND_IN_LABEL,
  acknowledgeArtemisIvOutboundCrewTransfer,
  acknowledgeArtemisIvReturnTransfer,
  acknowledgeArtemisIvSurfaceExpedition,
  bindArtemisIvRole,
  createArtemisIvLanderGrayboxCraft,
  createArtemisIvOrionGrayboxCraft,
  isActiveArtemisIvRole,
  recordArtemisIvDocking,
  recordArtemisIvUndocking,
  setActiveArtemisIvRole,
  validateArtemisIvOutboundCrew,
  validateArtemisIvReturnManifest,
  vesselForArtemisIvRole,
} from '../src/missions/artemisIv/mission';
import {
  ARTEMIS_IV_GUIDE_CONFIRMATION_MS,
  ARTEMIS_IV_GUIDE_STEPS,
  artemisIvGuideViewModel,
  continueArtemisIvGuide,
  createArtemisIvGuideProgress,
  updateArtemisIvGuide,
} from '../src/missions/artemisIv/guide';
import { ARTEMIS_IV_CHAPTERS } from '../src/missions/artemisIv/session';

function checkpointFingerprint(chapter: (typeof ARTEMIS_IV_CHAPTERS)[number]) {
  const state = initializeArtemisIvCheckpoint(chapter);
  return {
    missionVersion: state.missionVersion,
    chapter: state.chapter,
    checkpointId: state.checkpointId,
    time: state.game.time,
    persistence: state.game.persistence,
    roles: { ...state.roles },
    activeRole: state.activeRole,
    activeVesselId: state.game.activeVesselId,
    crew: { orion: [...state.crew['orion-cm']], lander: [...state.crew.hls] },
    samples: { ...state.samples },
    acknowledgements: { ...state.acknowledgements },
    vessels: state.game.vessels.map((vessel) => ({
      id: vessel.runtime.id,
      bodyId: vessel.runtime.bodyId,
      situation: vessel.runtime.situation,
      crew: [...vessel.runtime.crew],
      position: [vessel.runtime.pos.x, vessel.runtime.pos.y, vessel.runtime.pos.z],
      velocity: [vessel.runtime.vel.x, vessel.runtime.vel.y, vessel.runtime.vel.z],
      parts: vessel.runtime.craft.parts.map((part) => part.defId),
    })),
  };
}

describe('Artemis IV checkpoint foundation', () => {
  it('declares and deterministically initializes all eleven session-only chapters', () => {
    expect(ARTEMIS_IV_CHECKPOINTS.map(({ chapter }) => chapter)).toEqual(ARTEMIS_IV_CHAPTERS);
    expect(Object.keys(ARTEMIS_IV_CHECKPOINT_INITIALIZERS)).toHaveLength(11);
    for (const chapter of ARTEMIS_IV_CHAPTERS) {
      expect(checkpointFingerprint(chapter)).toEqual(checkpointFingerprint(chapter));
      expect(ARTEMIS_IV_CHECKPOINT_INITIALIZERS[chapter]().game.persistence).toBe('session-only');
    }
    expect(ARTEMIS_IV_CHECKPOINTS[0].truthStatus).toBe('confirmed-mission-summary');
    expect(ARTEMIS_IV_CHECKPOINTS.slice(1).every(
      ({ truthStatus }) => truthStatus === 'representative-training-state',
    )).toBe(true);
    expect(ARTEMIS_IV_CHECKPOINTS.filter(({ bodyId }) => bodyId === 'moon').every(
      ({ terrainAuthorityRequest }) => terrainAuthorityRequest === 'moon-site01',
    )).toBe(true);
  });

  it('can populate the same empty GameState after terrain authority is prepared', () => {
    const prepared = new GameState('sandbox', { persistence: 'session-only' });
    const state = initializeArtemisIvCheckpoint(6, prepared);
    expect(state.game).toBe(prepared);
    expect(state.game.vessels).toHaveLength(2);
    expect(() => initializeArtemisIvCheckpoint(6, prepared)).toThrow(/empty prepared game/i);
  });

  it('uses only existing stock part definitions for the graybox physics craft', () => {
    const stockIds = new Set(PARTS.map(({ id }) => id));
    const orion = createArtemisIvOrionGrayboxCraft();
    const lander = createArtemisIvLanderGrayboxCraft();
    expect([...orion.parts, ...lander.parts].every((part) => stockIds.has(part.defId))).toBe(true);
    expect(orion.parts.some(({ defId }) => defId === 'pod-voyager')).toBe(true);
    expect(lander.parts.some(({ defId }) => defId === 'dock-port-s')).toBe(true);
  });

  it('builds a true polar orbit whose plane crosses the training analogue', () => {
    const state = initializeArtemisIvCheckpoint(2);
    const authored = createArtemisIvSiteCrossingPolarOrbit(state.game, state.game.time);
    const moon = state.game.universe.get('moon');
    const position = new Vec3();
    const velocity = new Vec3();
    elementsToState(authored.elements, authored.trueAnomaly, position, velocity);
    const elements = stateToElements(moon.mu, position, velocity, state.game.time);
    expect(elements.i * 180 / Math.PI).toBeCloseTo(90, 8);

    const site = ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE;
    const lat = site.latitudeDegrees * Math.PI / 180;
    const lon = site.longitudeDegrees * Math.PI / 180;
    const fixed = new Vec3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    const target = bodyFixedToInertial(moon, state.game.time, fixed, new Vec3()).normalize();
    expect(position.normalize().dot(target)).toBeCloseTo(1, 10);
  });

  it('keeps mission roles stable across separate and shared vessel ids', () => {
    const separate = initializeArtemisIvCheckpoint(2);
    expect(ARTEMIS_IV_ROLES).toEqual(['orion-cm', 'orion-esm', 'hls']);
    expect(separate.roles['orion-cm']).not.toBe(separate.roles.hls);

    const lander = vesselForArtemisIvRole(separate, 'hls')!;
    lander.runtime.id = 'runtime-id-after-topology-change';
    bindArtemisIvRole(separate, 'hls', lander.runtime.id);
    setActiveArtemisIvRole(separate, 'hls');
    expect(isActiveArtemisIvRole(separate, 'hls')).toBe(true);
    expect(isActiveArtemisIvRole(separate, 'orion-cm')).toBe(false);

    const docked = initializeArtemisIvCheckpoint(4);
    expect(new Set(Object.values(docked.roles))).toEqual(new Set(['vessel-1']));
    expect(docked.game.dockedJoints(docked.game.vessels[0])).toHaveLength(1);
    setActiveArtemisIvRole(docked, 'hls');
    expect(isActiveArtemisIvRole(docked, 'hls')).toBe(true);
    expect(isActiveArtemisIvRole(docked, 'orion-cm')).toBe(false);

    const merged = docked.game.vessels[0];
    const joint = docked.game.dockedJoints(merged)[0];
    expect(docked.game.undock(merged, joint.childKey)).toBe(true);
    recordArtemisIvUndocking(
      docked,
      docked.game.vessels[0].runtime.id,
      docked.game.vessels[1].runtime.id,
    );
    expect(docked.roles['orion-cm']).not.toBe(docked.roles.hls);
    expect(docked.game.vessels.map(({ runtime }) => runtime.crew.length)).toEqual([2, 2]);
  });

  it('mutates and validates outbound crew, surface samples, and the return manifest', () => {
    const outbound = initializeArtemisIvCheckpoint(3);
    expect(() => acknowledgeArtemisIvOutboundCrewTransfer(outbound)).toThrow(/docked/i);
    recordArtemisIvDocking(outbound, outbound.roles['orion-cm']!);
    acknowledgeArtemisIvOutboundCrewTransfer(outbound);
    expect(validateArtemisIvOutboundCrew(outbound)).toBe(true);
    expect(outbound.crew['orion-cm']).toHaveLength(2);
    expect(outbound.crew.hls).toHaveLength(2);

    const surface = initializeArtemisIvCheckpoint(6);
    acknowledgeArtemisIvSurfaceExpedition(surface);
    expect(surface.samples).toEqual({ count: 1, ownerRole: 'hls', status: 'aboard-lander' });

    const returning = initializeArtemisIvCheckpoint(8);
    recordArtemisIvDocking(returning, returning.roles['orion-cm']!);
    acknowledgeArtemisIvReturnTransfer(returning);
    expect(validateArtemisIvReturnManifest(returning)).toBe(true);
    expect(returning.crew['orion-cm']).toEqual(ARTEMIS_IV_REPRESENTATIVE_CREW);
    expect(returning.crew.hls).toEqual([]);
    expect(returning.samples).toEqual({ count: 1, ownerRole: 'orion-cm', status: 'aboard-orion' });
  });

  it('keeps correction, insertion, rendezvous, descent, ascent, and return preparations distinct', () => {
    const maneuvers = ARTEMIS_IV_PREPARED.maneuvers;
    expect(maneuvers.postTliCorrection.node.prograde).toBeGreaterThan(0);
    expect(maneuvers.lunarOrbitInsertion.node.prograde).toBeLessThan(0);
    expect(maneuvers.postTliCorrection.id).not.toBe(maneuvers.lunarOrbitInsertion.id);
    expect(ARTEMIS_IV_CHECKPOINTS[1].prepared.maneuvers?.map(({ id }) => id)).toEqual([
      ARTEMIS_IV_PREPARED_MANEUVER_IDS.postTliCorrection,
      ARTEMIS_IV_PREPARED_MANEUVER_IDS.lunarOrbitInsertion,
    ]);
    expect(ARTEMIS_IV_CHECKPOINTS[2].prepared.rendezvous).toBeDefined();
    expect(ARTEMIS_IV_CHECKPOINTS[4].prepared.descent).toBeDefined();
    expect(ARTEMIS_IV_CHECKPOINTS[7].prepared.ascent).toBeDefined();
    expect(ARTEMIS_IV_CHECKPOINTS[8].prepared.rendezvous).toBeDefined();
    expect(ARTEMIS_IV_CHECKPOINTS[9].prepared.maneuvers?.[0].id)
      .toBe(ARTEMIS_IV_PREPARED_MANEUVER_IDS.transEarthInjection);
  });

  it('starts just outside a real Moon-encounter corridor and adjusts inside it', () => {
    const approach = initializeArtemisIvCheckpoint(1);
    const vessel = approach.game.active!.runtime;
    const earth = approach.game.universe.get('earth');
    const preburnReference = stateToElements(
      earth.mu,
      vessel.pos,
      vessel.vel,
      approach.game.time,
    );
    const starting = assessArtemisIvPostTliCorrection(
      approach.game.universe,
      preburnReference,
      ARTEMIS_IV_POST_TLI_START_NODE,
    );
    const adjusted = assessArtemisIvPostTliCorrection(
      approach.game.universe,
      preburnReference,
      ARTEMIS_IV_PREPARED.maneuvers.postTliCorrection.node,
    );

    expect(starting.periapsisAltitudeMeters).not.toBeNull();
    expect(starting.periapsisAltitudeMeters).toBeLessThan(
      ARTEMIS_IV_LUNAR_ENCOUNTER_CORRIDOR.minimumPeriapsisAltitudeMeters,
    );
    expect(starting.periapsisAltitudeMeters).toBeGreaterThan(40_000);
    expect(starting.accepted).toBe(false);
    expect(adjusted.periapsisAltitudeMeters).toBeGreaterThanOrEqual(
      ARTEMIS_IV_LUNAR_ENCOUNTER_CORRIDOR.minimumPeriapsisAltitudeMeters,
    );
    expect(adjusted.periapsisAltitudeMeters).toBeLessThanOrEqual(
      ARTEMIS_IV_LUNAR_ENCOUNTER_CORRIDOR.maximumPeriapsisAltitudeMeters,
    );
    expect(adjusted.accepted).toBe(true);

    // Completion validation reuses the plan's preburn reference after the
    // live vessel has changed, so it cannot accidentally apply the burn twice.
    vessel.vel.set(0, 0, 0);
    expect(assessArtemisIvPostTliCorrection(
      approach.game.universe,
      preburnReference,
      ARTEMIS_IV_PREPARED.maneuvers.postTliCorrection.node,
    )).toEqual(adjusted);
  });

  it('keeps the Earth correction and the later Moon LOI as separate burns', () => {
    const correction = ARTEMIS_IV_PREPARED.maneuvers.postTliCorrection;
    const insertion = ARTEMIS_IV_PREPARED.maneuvers.lunarOrbitInsertion;
    expect(correction.bodyId).toBe('earth');
    expect(insertion.bodyId).toBe('moon');
    expect(insertion.node.time).toBeGreaterThan(correction.node.time);
    expect(insertion.id).not.toBe(correction.id);
  });

  it('compresses only the coast between the two Chapter 1 burns and after TEI', () => {
    const outbound = initializeArtemisIvCheckpoint(1);
    outbound.telemetry.completedManeuverIds.push(ARTEMIS_IV_PREPARED_MANEUVER_IDS.postTliCorrection);
    outbound.game.clearFlightVessels();
    prepareArtemisIvLunarInsertion(outbound);
    expect(outbound.chapter).toBe(1);
    expect(vesselForArtemisIvRole(outbound, 'orion-cm')?.runtime.bodyId).toBe('moon');
    expect(vesselForArtemisIvRole(outbound, 'orion-cm')?.runtime.situation).toBe('suborbital');

    const returning = initializeArtemisIvCheckpoint(9);
    returning.game.clearFlightVessels();
    prepareArtemisIvEarthApproach(returning);
    expect(returning.chapter).toBe(9);
    expect(vesselForArtemisIvRole(returning, 'orion-cm')?.runtime.bodyId).toBe('earth');
    expect(vesselForArtemisIvRole(returning, 'orion-cm')?.runtime.currentStage).toBe(1);
  });
});

describe('Artemis IV direct guide', () => {
  it('offers Continue only on text steps and holds success for 400 ms', () => {
    expect(ARTEMIS_IV_GUIDE_STEPS.every((step) => step.textStep === Boolean(step.onContinue)))
      .toBe(true);
    const briefing = initializeArtemisIvCheckpoint(0);
    let progress = createArtemisIvGuideProgress(0);
    expect(artemisIvGuideViewModel(progress, 100).primaryAction).toEqual({ id: 'continue', label: 'CONTINUE' });
    let update = continueArtemisIvGuide(progress, briefing, 100);
    expect(update.signal).toBe('confirming');
    progress = update.progress;
    expect(updateArtemisIvGuide(progress, briefing, 100 + ARTEMIS_IV_GUIDE_CONFIRMATION_MS - 1).signal)
      .toBe('confirming');
    expect(updateArtemisIvGuide(progress, briefing, 100 + ARTEMIS_IV_GUIDE_CONFIRMATION_MS).signal)
      .toBe('chapter-complete');

    const approach = initializeArtemisIvCheckpoint(1);
    progress = createArtemisIvGuideProgress(1);
    expect(artemisIvGuideViewModel(progress, 0).primaryAction).toBeNull();
    expect(() => continueArtemisIvGuide(progress, approach, 0)).toThrow(/text steps/i);
    approach.telemetry.completedManeuverIds.push(ARTEMIS_IV_PREPARED_MANEUVER_IDS.postTliCorrection);
    approach.activeRole = 'hls';
    expect(updateArtemisIvGuide(progress, approach, 0).signal).toBe('waiting');
    approach.activeRole = 'orion-cm';
    expect(updateArtemisIvGuide(progress, approach, 0).signal).toBe('confirming');
  });

  it('teaches powered descent as brake, coast, then radial-out landing', () => {
    const descent = initializeArtemisIvCheckpoint(5);
    let progress = createArtemisIvGuideProgress(5);
    expect(artemisIvGuideViewModel(progress, 0)).toMatchObject({
      title: 'Remove sideways speed first',
      doNext: expect.stringContaining('RETROGRADE'),
    });
    expect(updateArtemisIvGuide(progress, descent, 0).signal).toBe('waiting');

    descent.telemetry.landing.horizontalSpeedMetersPerSecond = 9;
    progress = updateArtemisIvGuide(progress, descent, 0).progress;
    progress = updateArtemisIvGuide(
      progress,
      descent,
      ARTEMIS_IV_GUIDE_CONFIRMATION_MS,
    ).progress;
    expect(artemisIvGuideViewModel(progress, 0)).toMatchObject({
      title: 'Coast into the terminal descent',
      doNext: expect.stringContaining('throttle at zero'),
    });

    descent.telemetry.landing.verticalSpeedMetersPerSecond = -25;
    progress = updateArtemisIvGuide(progress, descent, 1_000).progress;
    progress = updateArtemisIvGuide(
      progress,
      descent,
      1_000 + ARTEMIS_IV_GUIDE_CONFIRMATION_MS,
    ).progress;
    expect(artemisIvGuideViewModel(progress, 0)).toMatchObject({
      title: 'Brake vertically and settle',
      doNext: expect.stringContaining('RADIAL OUT'),
    });
  });

  it('teaches a near-polar ascent before the apoapsis circularization burn', () => {
    const ascent = initializeArtemisIvCheckpoint(7);
    let progress = createArtemisIvGuideProgress(7);
    expect(artemisIvGuideViewModel(progress, 0)).toMatchObject({
      title: 'Launch into a near-polar plane',
      doNext: expect.stringContaining('apoapsis reaches 85–125 km'),
    });

    const lander = vesselForArtemisIvRole(ascent, 'hls')!;
    const authored = createArtemisIvSiteCrossingPolarOrbit(
      ascent.game,
      ascent.game.time,
      100_000,
    );
    elementsToState(authored.elements, authored.trueAnomaly, lander.runtime.pos, lander.runtime.vel);
    lander.runtime.situation = 'orbit';
    progress = updateArtemisIvGuide(progress, ascent, 0).progress;
    progress = updateArtemisIvGuide(
      progress,
      ascent,
      ARTEMIS_IV_GUIDE_CONFIRMATION_MS,
    ).progress;
    expect(artemisIvGuideViewModel(progress, 0)).toMatchObject({
      title: 'Raise periapsis near apoapsis',
      doNext: expect.stringContaining('inclination at or above 85°'),
    });
  });
});

describe('Artemis IV release-copy boundary', () => {
  it('contains the provider/stand-in warning without superseded or positive provider claims', () => {
    const copy = [
      ...ARTEMIS_IV_PUBLIC_FACTS.map(({ text }) => text),
      ARTEMIS_IV_STAND_IN_LABEL,
      ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE.label,
      ...ARTEMIS_IV_CHECKPOINTS.flatMap(({ title, prepared }) => [
        title,
        ...(prepared.maneuvers?.map(({ label }) => label) ?? []),
      ]),
      ...ARTEMIS_IV_GUIDE_STEPS.flatMap(({ title, doNext, successMessage }) => [title, doNext, successMessage]),
    ].join('\n');
    expect(copy).toContain('NASA has not assigned the Artemis IV lander provider');
    expect(copy).toContain('It is not a Starship HLS model');
    expect(copy).not.toMatch(/\bGateway\b|I-Hab|NRHO|Block 1B|\bEUS\b/i);
    expect(copy).not.toMatch(/NASA (?:selected|chose|assigned) SpaceX/i);
    expect(copy).not.toMatch(/uses (?:an? |the )?Starship HLS/i);
  });
});
