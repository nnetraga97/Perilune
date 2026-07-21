import { describe, expect, it } from 'vitest';
import { stateToElements, type OrbitalElements } from '../src/core/orbit';
import type { ManeuverNode } from '../src/sim/maneuver';
import type { Universe } from '../src/sim/universe';
import {
  ARTEMIS_IV_PREPARED,
  ARTEMIS_IV_TRAJECTORY_CORRIDORS,
  assessArtemisIvDescentSetup,
  assessArtemisIvLunarOrbitInsertion,
  assessArtemisIvTransEarthInjection,
  initializeArtemisIvCheckpoint,
  prepareArtemisIvLunarInsertion,
} from '../src/missions/artemisIv/checkpoints';

describe('Artemis IV snapshot trajectory gates', () => {
  it('accepts the authored LOI capture and rejects wrong time, cross-axis, and trajectory', () => {
    const { universe, reference } = lunarInsertionSnapshot();
    const node = ARTEMIS_IV_PREPARED.maneuvers.lunarOrbitInsertion.node;
    const result = assessArtemisIvLunarOrbitInsertion(universe, reference, node);

    expect(result).toMatchObject({ accepted: true });
    expect(result.periapsisAltitudeMeters).toBeCloseTo(100_000, 3);
    expect(result.apoapsisAltitudeMeters).toBeCloseTo(100_000, 3);
    expect(result.inclinationDegrees).toBeGreaterThanOrEqual(85);
    expectRejectedEdits(
      (candidate) => assessArtemisIvLunarOrbitInsertion(universe, reference, candidate).accepted,
      node,
    );
    expect(assessArtemisIvLunarOrbitInsertion(
      universe,
      reference,
      { ...node, prograde: 0 },
    ).accepted).toBe(false);
  });

  it('accepts only a timed, in-plane descent setup that intersects the descent corridor', () => {
    const { universe, reference } = checkpointSnapshot(4);
    const node = ARTEMIS_IV_PREPARED.maneuvers.descentSetup.node;
    const result = assessArtemisIvDescentSetup(universe, reference, node);

    expect(result.accepted).toBe(true);
    expect(result.periapsisAltitudeMeters).toBeLessThan(0);
    expect(result.apoapsisAltitudeMeters).toBeGreaterThan(70_000);
    expectRejectedEdits(
      (candidate) => assessArtemisIvDescentSetup(universe, reference, candidate).accepted,
      node,
    );
    expect(assessArtemisIvDescentSetup(
      universe,
      reference,
      { ...node, prograde: 0 },
    ).accepted).toBe(false);
  });

  it('requires patched-conic Moon escape into an actual Earth reentry approach', () => {
    const state = initializeArtemisIvCheckpoint(9);
    const vessel = state.game.active!.runtime;
    const moon = state.game.universe.get('moon');
    const reference = stateToElements(
      moon.mu,
      vessel.pos,
      vessel.vel,
      state.game.time,
    );
    const node = ARTEMIS_IV_PREPARED.maneuvers.transEarthInjection.node;
    const result = assessArtemisIvTransEarthInjection(state.game.universe, reference, node);
    const corridor = ARTEMIS_IV_TRAJECTORY_CORRIDORS.transEarthInjection;

    expect(result.accepted).toBe(true);
    expect(result.moonEscapeTimeSeconds).toBeGreaterThan(node.time);
    expect(result.earthPeriapsisAltitudeMeters).toBeGreaterThanOrEqual(
      corridor.minimumEarthPeriapsisAltitudeMeters,
    );
    expect(result.earthPeriapsisAltitudeMeters).toBeLessThanOrEqual(
      corridor.maximumEarthPeriapsisAltitudeMeters,
    );
    expectRejectedEdits(
      (candidate) => assessArtemisIvTransEarthInjection(
        state.game.universe,
        reference,
        candidate,
      ).accepted,
      node,
    );
    expect(assessArtemisIvTransEarthInjection(
      state.game.universe,
      reference,
      { ...node, prograde: 0 },
    )).toEqual({
      accepted: false,
      moonEscapeTimeSeconds: null,
      earthPeriapsisAltitudeMeters: null,
    });

    // The captured plan reference remains authoritative after the live vessel changes.
    vessel.vel.set(0, 0, 0);
    expect(assessArtemisIvTransEarthInjection(
      state.game.universe,
      reference,
      node,
    )).toEqual(result);
  });
});

function lunarInsertionSnapshot(): { universe: Universe; reference: OrbitalElements } {
  const state = initializeArtemisIvCheckpoint(1);
  state.game.clearFlightVessels();
  prepareArtemisIvLunarInsertion(state);
  return snapshot(state.game.universe, state.game.active!.runtime.bodyId, state.game.active!.runtime.pos,
    state.game.active!.runtime.vel, state.game.time);
}

function checkpointSnapshot(chapter: 4): { universe: Universe; reference: OrbitalElements } {
  const state = initializeArtemisIvCheckpoint(chapter);
  const vessel = state.game.active!.runtime;
  return snapshot(state.game.universe, vessel.bodyId, vessel.pos, vessel.vel, state.game.time);
}

function snapshot(
  universe: Universe,
  bodyId: string,
  position: Parameters<typeof stateToElements>[1],
  velocity: Parameters<typeof stateToElements>[2],
  time: number,
): { universe: Universe; reference: OrbitalElements } {
  return {
    universe,
    reference: stateToElements(universe.get(bodyId).mu, position, velocity, time),
  };
}

function expectRejectedEdits(
  accepted: (node: ManeuverNode) => boolean,
  prepared: Readonly<ManeuverNode>,
): void {
  const corridor = ARTEMIS_IV_TRAJECTORY_CORRIDORS;
  expect(accepted({
    ...prepared,
    time: prepared.time + corridor.maximumNodeTimeErrorSeconds + 1,
  })).toBe(false);
  expect(accepted({
    ...prepared,
    normal: corridor.maximumNormalMetersPerSecond + 1,
  })).toBe(false);
  expect(accepted({
    ...prepared,
    radial: -(corridor.maximumRadialMetersPerSecond + 1),
  })).toBe(false);
}
