import { describe, expect, it } from 'vitest';
import { elementsToState } from '../src/core/orbit';
import { GameState } from '../src/sim/state';
import { addPart, createCraft } from '../src/sim/vessel';
import {
  buildFlightDirectorSnapshot,
  type PreviousFlightDirectorDecision,
} from '../src/ui/flightDirectorSnapshot';
import { createLegacyGameState } from './fixtures/legacyGameState';

function capsule() {
  const craft = createCraft('Context capsule');
  addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
  return craft;
}

function snapshot(game: GameState, previous: PreviousFlightDirectorDecision | null = null) {
  const result = buildFlightDirectorSnapshot(
    game,
    0,
    null,
    { nodeRemainingDv: 0, entryPrediction: null },
    { connected: true, path: ['vessel', 'veyra'], strength: 1 },
    false,
    previous,
  );
  if (!result) throw new Error('Expected an active vessel snapshot');
  return result;
}

function placeOrbitAttempt(game: GameState, trueAnomaly: number): void {
  const vessel = game.spawnInOrbit(capsule(), 'Orbit attempt', 'veyra', 100_000);
  const body = game.bodyOf(vessel);
  const periapsisRadius = body.radius + 30_000;
  const apoapsisRadius = body.radius + 100_000;
  const semiMajorAxis = (periapsisRadius + apoapsisRadius) / 2;
  const eccentricity = (apoapsisRadius - periapsisRadius) / (apoapsisRadius + periapsisRadius);
  elementsToState({
    a: semiMajorAxis,
    e: eccentricity,
    i: 0,
    raan: 0,
    argPe: 0,
    meanAnomaly0: 0,
    epoch: game.time,
    mu: body.mu,
  }, trueAnomaly, vessel.runtime.pos, vessel.runtime.vel);
  vessel.runtime.situation = 'suborbital';
}

describe('flight director mission context', () => {
  it('gives a fresh Veyra launch an explicit stable-orbit objective without a contract', () => {
    const game = createLegacyGameState('sandbox');
    const vessel = game.spawnOnPad(capsule(), 'First Light');

    const result = snapshot(game);

    expect(result.schemaVersion).toBe(2);
    expect(result.mission).toMatchObject({
      flightId: vessel.runtime.id,
      objectiveId: 'default-veyra-orbit',
      objectiveKind: 'stable-orbit',
      objectiveSource: 'default',
      objectiveAchieved: false,
      targetBodyId: 'veyra',
    });
    expect(result.mission.objective).toContain('stable orbit around Veyra');
    expect(result.phase).toMatchObject({ flightPhase: 'prelaunch', priority: 'mission' });
    expect(result.phase.allowedActions).toEqual(['prepare-launch', 'ignite-and-liftoff', 'hold']);
    expect(result.orbit.targetMinimumPeriapsisMeters).toBe(85_000);
  });

  it('selects the phase-relevant orbit contract instead of blindly taking the first active contract', () => {
    const game = createLegacyGameState('program');
    game.campaign.activeContracts.push('science-return', 'veyra-orbit');
    game.spawnOnPad(capsule(), 'Contract flight');

    const result = snapshot(game);

    expect(result.mission.objectiveId).toBe('veyra-orbit');
    expect(result.mission.objective).toBe('Place a controlled vessel into stable orbit around Veyra.');
    expect(result.mission.activeObjectives).toEqual([
      'Recover a vessel carrying new scientific results.',
      'Place a controlled vessel into stable orbit around Veyra.',
    ]);
  });

  it('marks the simulator-defined 85 km Veyra orbit as achieved and changes to efficiency priority', () => {
    const game = createLegacyGameState('sandbox');
    game.spawnInOrbit(capsule(), 'Orbiter', 'veyra', 100_000);

    const result = snapshot(game);

    expect(result.orbit).toMatchObject({
      stable: true,
      targetMinimumPeriapsisMeters: 85_000,
    });
    expect(result.orbit.periapsisMarginMeters).toBeCloseTo(15_000, 3);
    expect(result.mission.objectiveAchieved).toBe(true);
    expect(result.phase).toMatchObject({ flightPhase: 'stable-orbit', priority: 'efficiency' });
  });

  it('distinguishes ascent, coast, and circularization using simulator-derived orbit margins', () => {
    const ascent = createLegacyGameState('sandbox');
    const ascendingVessel = ascent.spawnOnPad(capsule(), 'Ascent');
    ascendingVessel.runtime.situation = 'flying';
    expect(snapshot(ascent).phase).toMatchObject({
      flightPhase: 'atmospheric-ascent',
      allowedActions: ['begin-gravity-turn', 'hold-ascent', 'throttle-up', 'throttle-down', 'stage-when-ready'],
    });

    const coast = createLegacyGameState('sandbox');
    placeOrbitAttempt(coast, 0);
    expect(snapshot(coast).phase).toMatchObject({
      flightPhase: 'coast-to-apoapsis',
      allowedActions: ['coast-to-apoapsis', 'hold', 'review-map'],
    });

    const circularize = createLegacyGameState('sandbox');
    placeOrbitAttempt(circularize, Math.PI - 0.01);
    expect(snapshot(circularize).phase).toMatchObject({
      flightPhase: 'circularization',
      allowedActions: ['circularize', 'raise-periapsis', 'stage-when-ready', 'hold'],
    });
  });

  it('lets immediate flight risk override mission progress', () => {
    const game = createLegacyGameState('sandbox');
    const vessel = game.spawnOnPad(capsule(), 'High Q');
    vessel.runtime.aero.dynamicPressure = 40_000;

    expect(snapshot(game).phase).toMatchObject({
      priority: 'safety',
      allowedActions: ['throttle-down', 'hold'],
    });
  });

  it('carries only the previous decision for the same vessel', () => {
    const game = createLegacyGameState('sandbox');
    const vessel = game.spawnOnPad(capsule(), 'Continuity');
    game.time = 20;
    const previous: PreviousFlightDirectorDecision = {
      vesselId: vessel.runtime.id,
      issuedAt: 12,
      actionId: 'prepare-launch',
      flightPhase: 'prelaunch',
    };

    expect(snapshot(game, previous).continuity).toEqual({
      previousActionId: 'prepare-launch',
      previousFlightPhase: 'prelaunch',
      ageSeconds: 8,
    });
    expect(snapshot(game, { ...previous, vesselId: 'another-vessel' }).continuity).toBeNull();
  });
});
