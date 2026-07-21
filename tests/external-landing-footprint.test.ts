import { describe, expect, it } from 'vitest';
import { Quat } from '../src/core/quat';
import { Vec3 } from '../src/core/vec3';
import { surfaceVelocity } from '../src/sim/bodyOrientation';
import {
  setExternalLandingFootprint,
  type ExternalLandingFootprint,
} from '../src/sim/flight';
import { GameState, PHYSICS_DT, launchSiteDirection, type GameVessel } from '../src/sim/state';
import { groundRadiusInertial } from '../src/sim/terrain';
import { addPart, createCraft, type Craft } from '../src/sim/vessel';
import { createLegacyGameState } from './fixtures/legacyGameState';

const FOOT_Y = -4;
const HALF_SPAN = 2.5;

function tallLander(): Craft {
  const craft = createCraft('Tall external-footprint test lander');
  const pod = addPart(craft, 'pod-tandem', null, 'root', { x: 0, y: 6, z: 0 });
  const upper = addPart(craft, 'tank-m4', pod.key, 'stack-bottom', { x: 0, y: 3.5, z: 0 });
  const lower = addPart(craft, 'tank-m4', upper.key, 'stack-bottom', { x: 0, y: 0.5, z: 0 });
  addPart(craft, 'eng-aspen', lower.key, 'stack-bottom', { x: 0, y: -2.1, z: 0 });
  return craft;
}

function placeFootprintOnPad(
  game: GameState,
  attitude = new Quat(),
): { vessel: GameVessel; footprint: ExternalLandingFootprint } {
  const vessel = game.spawnOnPad(tallLander(), 'Tall lander');
  const runtime = vessel.runtime;
  const body = game.bodyOf(vessel);
  const up = launchSiteDirection(body, game.time, new Vec3());
  const upright = new Quat().setLookRotation(new Vec3(-up.y, up.x, 0).normalize(), up);
  runtime.att.copy(upright).multiply(attitude);
  runtime.sas = 'off';
  runtime.situation = 'landed';
  runtime.landedBodyFixed = null;

  const footprint = setExternalLandingFootprint(runtime, {
    halfWidth: HALF_SPAN,
    halfDepth: HALF_SPAN,
    footY: FOOT_Y,
  });

  let lowestRadialOffset = Infinity;
  for (const x of [-HALF_SPAN, HALF_SPAN]) {
    for (const z of [-HALF_SPAN, HALF_SPAN]) {
      const local = new Vec3(
        x - runtime.massProps.com.x,
        FOOT_Y - runtime.massProps.com.y,
        z - runtime.massProps.com.z,
      );
      runtime.att.rotate(local, local);
      lowestRadialOffset = Math.min(lowestRadialOffset, local.dot(up));
    }
  }
  const ground = groundRadiusInertial(body, up, game.time);
  runtime.pos.copy(up).scale(ground - lowestRadialOffset - 0.02);
  surfaceVelocity(body, runtime.pos, runtime.vel);
  runtime.angVel.set(0, 0, 0);
  return { vessel, footprint };
}

describe('external landing footprint', () => {
  it('holds a tall upright lander on four pads and accumulates stable contact', () => {
    const game = createLegacyGameState();
    const { vessel, footprint } = placeFootprintOnPad(game);

    for (let index = 0; index < 250; index++) game.update(PHYSICS_DT);

    expect(game.vessels).toContain(vessel);
    expect(footprint.contactCount).toBeGreaterThanOrEqual(3);
    const body = game.bodyOf(vessel);
    const relative = vessel.runtime.vel.clone().sub(surfaceVelocity(body, vessel.runtime.pos, new Vec3()));
    expect(
      footprint.stableForMs,
      `relative=${relative.length()} angular=${vessel.runtime.angVel.x},${vessel.runtime.angVel.y},${vessel.runtime.angVel.z} contacts=${footprint.contactCount}`,
    ).toBeGreaterThanOrEqual(1_500);
    expect(footprint.tipped).toBe(false);
    expect(vessel.runtime.situation).toBe('landed');
    expect(vessel.runtime.pos.isFinite()).toBe(true);
  });

  it('marks the lander tipped when gravity projects its center of mass outside the pads', () => {
    const game = createLegacyGameState();
    const tilt = new Quat().setFromAxisAngle(new Vec3(0, 0, 1), Math.PI / 4);
    const { footprint } = placeFootprintOnPad(game, tilt);

    game.update(PHYSICS_DT);

    expect(footprint.contactCount).toBeGreaterThan(0);
    expect(footprint.tipped).toBe(true);
    expect(footprint.stableForMs).toBe(0);
  });

  it('leaves the stock contact path opt-in and untouched by default', () => {
    const game = createLegacyGameState();
    const vessel = game.spawnOnPad(tallLander(), 'Stock-contact lander');
    vessel.runtime.situation = 'landed';

    game.update(PHYSICS_DT);

    expect(vessel.runtime.externalLandingFootprint).toBeUndefined();
  });
});
