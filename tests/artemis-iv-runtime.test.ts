import { describe, expect, it } from 'vitest';
import { elementsToState } from '../src/core/orbit';
import { Vec3 } from '../src/core/vec3';
import { bodyFixedToInertial, surfaceVelocity } from '../src/sim/bodyOrientation';
import { setExternalLandingFootprint } from '../src/sim/flight';
import type { GameVessel } from '../src/sim/state';
import type { ArtemisIvAssetResourceAccounting } from '../src/missions/artemisIv/assets';
import {
  ARTEMIS_IV_PREPARED,
  ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE,
  createArtemisIvSiteCrossingPolarOrbit,
  initializeArtemisIvCheckpoint,
} from '../src/missions/artemisIv/checkpoints';
import { vesselForArtemisIvRole } from '../src/missions/artemisIv/mission';
import {
  artemisIvGuideReadouts,
  computeArtemisIvLandingTelemetry,
  computeArtemisIvRecoveryTelemetry,
  computeArtemisIvRelativeMotion,
  createArtemisIvRendererResourceLedger,
  syncArtemisIvLiveTelemetry,
  syncArtemisIvRendezvousTelemetry,
} from '../src/missions/artemisIv/runtime';

function expectedRelative(
  leftPosition: Readonly<Vec3>,
  leftVelocity: Readonly<Vec3>,
  rightPosition: Readonly<Vec3>,
  rightVelocity: Readonly<Vec3>,
): { range: number; closing: number } {
  const deltaPosition = new Vec3().copy(rightPosition).sub(leftPosition);
  const deltaVelocity = new Vec3().copy(rightVelocity).sub(leftVelocity);
  const range = deltaPosition.length();
  return { range, closing: range > 0 ? -deltaVelocity.dot(deltaPosition) / range : 0 };
}

function railsState(vessel: GameVessel, state: ReturnType<typeof initializeArtemisIvCheckpoint>) {
  const position = new Vec3();
  const velocity = new Vec3();
  state.game.railsPosition(vessel, position, velocity);
  return { position, velocity };
}

function accounting(gpuBytes = 420): ArtemisIvAssetResourceAccounting {
  return {
    assetId: 'martiandays-starship-2019-concept',
    transferBytes: 200,
    geometryBytes: 100,
    materialBytes: 20,
    textureBytes: 300,
    gpuBytes,
    geometryCount: 1,
    materialCount: 1,
    textureCount: 1,
    drawCallCount: 1,
    triangleCount: 1,
  };
}

describe('Artemis IV live runtime telemetry', () => {
  it('computes signed relative motion from live and rails states', () => {
    const state = initializeArtemisIvCheckpoint(3);
    const orion = vesselForArtemisIvRole(state, 'orion-cm')!;
    const lander = vesselForArtemisIvRole(state, 'hls')!;

    const active = computeArtemisIvRelativeMotion(state.game, orion, lander)!;
    expect(active.rangeMeters).toBeCloseTo(40, 6);
    expect(active.closingSpeedMetersPerSecond).toBeCloseTo(0.1, 6);

    state.game.toRails(orion);
    state.game.toRails(lander);
    const orionRails = railsState(orion, state);
    const landerRails = railsState(lander, state);
    const expected = expectedRelative(
      orionRails.position,
      orionRails.velocity,
      landerRails.position,
      landerRails.velocity,
    );
    orion.runtime.pos.set(1, 2, 3);
    orion.runtime.vel.set(4, 5, 6);
    lander.runtime.pos.set(9, 9, 9);
    lander.runtime.vel.set(9, 9, 9);

    const rails = computeArtemisIvRelativeMotion(state.game, orion, lander)!;
    expect(rails.rangeMeters).toBeCloseTo(expected.range, 6);
    expect(rails.closingSpeedMetersPerSecond).toBeCloseTo(expected.closing, 6);
  });

  it('syncs only the chapter-scoped rendezvous target and continuous hold', () => {
    const state = initializeArtemisIvCheckpoint(3);
    syncArtemisIvRendezvousTelemetry(state, 'hls', 600);
    expect(state.telemetry.selectedTargetRole).toBe('hls');
    expect(state.telemetry.relativeRangeMeters).toBeCloseTo(40, 6);
    expect(state.telemetry.relativeClosingSpeedMetersPerSecond).toBeCloseTo(0.1, 6);
    expect(state.telemetry.holdStableForMs).toBe(600);

    syncArtemisIvRendezvousTelemetry(state, 'hls', 500);
    expect(state.telemetry.holdStableForMs).toBe(1_100);
    syncArtemisIvRendezvousTelemetry(state, null, 16);
    expect(state.telemetry.relativeRangeMeters).toBeNull();
    expect(state.telemetry.holdStableForMs).toBe(0);
  });

  it('derives lunar landing gates from the four-pad footprint and surface frame', () => {
    const state = initializeArtemisIvCheckpoint(6);
    const lander = vesselForArtemisIvRole(state, 'hls')!;
    const footprint = setExternalLandingFootprint(lander.runtime, {
      halfWidth: 5,
      halfDepth: 5,
      footY: lander.runtime.massProps.com.y - 10,
    });
    footprint.contactCount = 4;
    footprint.stableForMs = 1_800;
    const moon = state.game.universe.get('moon');
    const up = lander.runtime.pos.clone().normalize();
    const tangent = Vec3.cross(up, new Vec3(1, 0, 0), new Vec3()).normalize();
    surfaceVelocity(moon, lander.runtime.pos, lander.runtime.vel);
    lander.runtime.vel.addScaled(up, -1.25).addScaled(tangent, 0.5);

    const telemetry = computeArtemisIvLandingTelemetry(state);
    expect(telemetry.contactCount).toBe(4);
    expect(telemetry.stableForMs).toBe(1_800);
    expect(telemetry.insideTrainingEllipse).toBe(true);
    expect(telemetry.verticalSpeedMetersPerSecond).toBeCloseTo(-1.25, 6);
    expect(telemetry.horizontalSpeedMetersPerSecond).toBeCloseTo(0.5, 6);
    expect(telemetry.slopeDegrees).toBeGreaterThanOrEqual(0);
  });

  it('reports body-fixed Earth recovery coordinates and actual chute opening', () => {
    const state = initializeArtemisIvCheckpoint(10);
    const orion = vesselForArtemisIvRole(state, 'orion-cm')!;
    const chute = orion.runtime.craft.parts.find((part) => part.defId === 'chute-main')!;
    chute.activated = true;
    chute.parachuteDeployFraction = 0.15;

    const recovery = computeArtemisIvRecoveryTelemetry(state);
    expect(recovery.latitudeDegrees).toBeCloseTo(
      ARTEMIS_IV_PREPARED.entry.aimLatitudeDegrees,
      6,
    );
    expect(recovery.longitudeDegrees).toBeCloseTo(
      ARTEMIS_IV_PREPARED.entry.aimLongitudeDegrees,
      6,
    );
    expect(recovery.parachutesArmed).toBe(true);
    expect(recovery.parachutesDeployed).toBe(true);

    syncArtemisIvLiveTelemetry(state, null, 0);
    expect(state.telemetry.parachutesDeployed).toBe(true);
    expect(state.telemetry.recoveryLatitudeDegrees).toBeCloseTo(
      ARTEMIS_IV_PREPARED.entry.aimLatitudeDegrees,
      6,
    );
  });
});

describe('Artemis IV guide readouts', () => {
  it('keeps rendezvous, descent, ascent, and entry readouts compact and explicit', () => {
    const rendezvous = initializeArtemisIvCheckpoint(3);
    syncArtemisIvRendezvousTelemetry(rendezvous, 'hls', 1_000);
    expect(artemisIvGuideReadouts(rendezvous)).toEqual([
      { label: 'Range', value: '40.0 m', tone: 'good' },
      { label: 'Closing rate', value: '0.10 m/s CLOSING', tone: 'good' },
      { label: 'Stable hold', value: '1.0 / 1.0 s', tone: 'good' },
    ]);

    const descent = initializeArtemisIvCheckpoint(6);
    descent.telemetry.landing = {
      contactCount: 4,
      stableForMs: 1_500,
      insideTrainingEllipse: true,
      verticalSpeedMetersPerSecond: -1.2,
      horizontalSpeedMetersPerSecond: 0.4,
      slopeDegrees: 3.2,
    };
    const descentReadouts = artemisIvGuideReadouts(descent);
    expect(descentReadouts).toHaveLength(4);
    expect(descentReadouts.map(({ value }) => value)).toEqual([
      'INSIDE ELLIPSE', '1.2 m/s DOWN', '0.4 m/s', '4 / 4 · 3.2°',
    ]);

    const ascent = initializeArtemisIvCheckpoint(7);
    expect(artemisIvGuideReadouts(ascent).map(({ value }) => value)).toEqual([
      'SURFACE', 'SURFACE', 'SURFACE',
    ]);
    const lander = vesselForArtemisIvRole(ascent, 'hls')!;
    const authored = createArtemisIvSiteCrossingPolarOrbit(
      ascent.game,
      ascent.game.time,
      100_000,
    );
    elementsToState(authored.elements, authored.trueAnomaly, lander.runtime.pos, lander.runtime.vel);
    lander.runtime.situation = 'orbit';
    expect(artemisIvGuideReadouts(ascent)).toEqual([
      { label: 'Apoapsis', value: '103.7 km', tone: 'good' },
      { label: 'Periapsis', value: '96.3 km', tone: 'good' },
      { label: 'Inclination', value: '90.0°', tone: 'good' },
    ]);

    const entry = initializeArtemisIvCheckpoint(10);
    entry.telemetry.recoveryLatitudeDegrees = 20;
    entry.telemetry.recoveryLongitudeDegrees = -155;
    const chute = vesselForArtemisIvRole(entry, 'orion-cm')!.runtime.craft.parts
      .find((part) => part.defId === 'chute-main')!;
    expect(artemisIvGuideReadouts(entry)[1]).toEqual(
      { label: 'Parachutes', value: 'STOWED', tone: 'caution' },
    );
    chute.activated = true;
    expect(artemisIvGuideReadouts(entry)[1]).toEqual(
      { label: 'Parachutes', value: 'ARMED', tone: 'neutral' },
    );
    chute.parachuteDeployFraction = 0.15;
    expect(artemisIvGuideReadouts(entry)).toEqual([
      { label: 'Recovery', value: '20.00° N · 155.00° W' },
      { label: 'Parachutes', value: 'DEPLOYED', tone: 'good' },
    ]);
  });
});

describe('Artemis IV renderer resource ledger', () => {
  it('tracks one active measured asset over a live conservative base', () => {
    let base = 1_000;
    const ledger = createArtemisIvRendererResourceLedger(() => base);
    expect(ledger.totalRendererBytes()).toBe(1_000);

    ledger.charge(accounting());
    expect(ledger.totalRendererBytes()).toBe(1_420);
    expect(() => ledger.charge(accounting())).toThrow(/already has an active asset charge/i);
    base = 1_100;
    expect(ledger.totalRendererBytes()).toBe(1_520);

    ledger.release('martiandays-starship-2019-concept');
    expect(ledger.totalRendererBytes()).toBe(1_100);
    expect(() => ledger.release('martiandays-starship-2019-concept')).toThrow(/no active/i);
    expect(() => ledger.charge(accounting(419))).toThrow(/invalid.*charge/i);
  });
});
