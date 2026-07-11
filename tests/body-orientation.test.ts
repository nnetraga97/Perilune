import { describe, expect, it } from 'vitest';
import { Quat } from '../src/core/quat';
import { Vec3 } from '../src/core/vec3';
import {
  bodyFixedAttitudeToInertial,
  bodyFixedToInertial,
  inertialAttitudeToBodyFixed,
  inertialToBodyFixed,
  surfaceVelocity,
} from '../src/sim/bodyOrientation';
import { GameState } from '../src/sim/state';
import { addPart, createCraft } from '../src/sim/vessel';

function buildLander() {
  const craft = createCraft('Rails lander');
  addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  return craft;
}

function quaternionDistance(a: Readonly<Quat>, b: Readonly<Quat>): number {
  const direct = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w);
  const negated = Math.hypot(a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w);
  return Math.min(direct, negated);
}

describe('body orientation', () => {
  it('round-trips vectors and attitudes through tilt and spin', () => {
    const body = new GameState().universe.get('veyra');
    const bf = new Vec3(0.2, -0.7, 0.68).normalize();
    const inertial = bodyFixedToInertial(body, 12_345, bf, new Vec3());

    expect(inertialToBodyFixed(body, 12_345, inertial, new Vec3()).distanceTo(bf)).toBeLessThan(
      1e-12,
    );

    const attitude = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), 0.4);
    const world = bodyFixedAttitudeToInertial(body, 12_345, attitude, new Quat());
    const roundTrip = inertialAttitudeToBodyFixed(body, 12_345, world, new Quat());
    expect(quaternionDistance(roundTrip, attitude)).toBeLessThan(1e-12);

    const aliased = attitude.clone();
    bodyFixedAttitudeToInertial(body, 12_345, aliased, aliased);
    expect(quaternionDistance(aliased, world)).toBeLessThan(1e-12);
    inertialAttitudeToBodyFixed(body, 12_345, aliased, aliased);
    expect(quaternionDistance(aliased, attitude)).toBeLessThan(1e-12);
  });

  it('tilts the local north pole and computes tangent surface velocity', () => {
    const body = new GameState().universe.get('veyra');
    const north = bodyFixedToInertial(body, 0, new Vec3(0, 0, 1), new Vec3());

    expect(north.x).toBeCloseTo(0, 12);
    expect(north.y).toBeCloseTo(-Math.sin(body.def.axialTilt), 12);
    expect(north.z).toBeCloseTo(Math.cos(body.def.axialTilt), 12);

    const position = bodyFixedToInertial(body, 50, new Vec3(body.radius, 0, 0), new Vec3());
    const velocity = surfaceVelocity(body, position, new Vec3());
    expect(Vec3.dot(position, velocity)).toBeCloseTo(0, 6);
    expect(velocity.length()).toBeGreaterThan(0);
  });

  it('keeps a landed rails pose fixed in body coordinates as the tilted body spins', () => {
    const game = new GameState();
    const gv = game.spawnOnPad(buildLander(), 'Rails lander');
    const body = game.bodyOf(gv);
    const directionBF = inertialToBodyFixed(body, game.time, gv.runtime.pos, new Vec3()).normalize();
    const attitudeBF = inertialAttitudeToBodyFixed(body, game.time, gv.runtime.att, new Quat());

    game.toRails(gv);
    game.time += body.def.rotationPeriod / 4;
    game.toActive(gv);

    const restoredDirection = inertialToBodyFixed(
      body,
      game.time,
      gv.runtime.pos,
      new Vec3(),
    ).normalize();
    const restoredAttitude = inertialAttitudeToBodyFixed(
      body,
      game.time,
      gv.runtime.att,
      new Quat(),
    );
    expect(restoredDirection.distanceTo(directionBF)).toBeLessThan(1e-12);
    expect(quaternionDistance(restoredAttitude, attitudeBF)).toBeLessThan(1e-12);
  });
});
