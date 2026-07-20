import { createLegacyGameState } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { stateToElements } from '../src/core/orbit';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { addPart, createCraft } from '../src/sim/vessel';

function buildProbe(name: string) {
  const craft = createCraft(name);
  addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  return craft;
}

describe('Fleet orbit action', () => {
  it('places only the active craft into a safe circular orbit around its target', () => {
    const game = createLegacyGameState();
    const parked = game.spawnInOrbit(buildProbe('Parked'), 'Parked', 'veyra', 120_000);
    const parkedPosition = parked.runtime.pos.clone();
    const active = game.spawnOnPad(buildProbe('Active'), 'Active');
    active.target = 'palla';
    active.runtime.controls.throttle = 1;
    active.runtime.controls.translate.set(1, -1, 0.5);
    active.runtime.angVel.set(0.2, 0.3, 0.4);
    game.setWarp(2, true);
    expect(active.regime).toBe('rails');

    expect(game.placeActiveInOrbit('palla')).toBe(true);

    const body = game.universe.get('palla');
    const radius = active.runtime.pos.length();
    const altitude = radius - body.radius;
    const expectedSpeed = Math.sqrt(body.mu / radius);
    const elements = stateToElements(body.mu, active.runtime.pos, active.runtime.vel, game.time);

    expect(active.runtime.bodyId).toBe('palla');
    expect(active.runtime.situation).toBe('orbit');
    expect(active.target).toBeNull();
    expect(active.regime).toBe('active');
    expect(active.rails).toEqual({ elements: null, landedPos: null, landedAtt: null });
    expect(game.warpIndex).toBe(0);
    expect(game.railsWarp).toBe(false);
    expect(altitude).toBeGreaterThan(body.def.terrain.amplitude + 10_000);
    expect(radius).toBeLessThan(body.soiRadius);
    expect(active.runtime.vel.length()).toBeCloseTo(expectedSpeed, 8);
    expect(Vec3.dot(active.runtime.pos, active.runtime.vel)).toBeCloseTo(0, 6);
    expect(elements.e).toBeCloseTo(0, 10);
    expect(active.runtime.controls.throttle).toBe(0);
    expect(active.runtime.controls.translate.length()).toBe(0);
    expect(active.runtime.angVel.length()).toBe(0);
    expect(active.runtime.landedBodyFixed).toBeNull();
    expect(active.runtime.events.at(-1)?.text).toBe('Placed in orbit around Palla');

    expect(parked.runtime.bodyId).toBe('veyra');
    expect(parked.runtime.pos).toEqual(parkedPosition);

    game.update(PHYSICS_DT);
    expect(game.vessels).toContain(active);
    expect(active.runtime.situation).toBe('orbit');
    expect(active.runtime.pos.isFinite()).toBe(true);
  });

  it('does nothing without an active craft or when the target is the star', () => {
    const game = createLegacyGameState();
    expect(game.placeActiveInOrbit('palla')).toBe(false);

    const active = game.spawnOnPad(buildProbe('Active'), 'Active');
    const before = active.runtime.pos.clone();
    expect(game.placeActiveInOrbit('auren')).toBe(false);
    expect(active.runtime.bodyId).toBe('veyra');
    expect(active.runtime.pos).toEqual(before);
  });
});
