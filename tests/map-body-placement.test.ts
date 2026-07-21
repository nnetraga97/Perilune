import { createLegacyGameState } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState } from '../src/sim/state';
import {
  mapBodyPresentationRadius,
  mapBodyScenePosition,
  mapFitBounds,
} from '../src/ui/mapView';

const MAP_SCALE = 1e-5;

describe('map body placement', () => {
  it('keeps every planet and moon on its analytic parent-relative orbit', () => {
    const game = createLegacyGameState();
    const anchor = game.universe.get('veyra');
    const local = new Vec3();

    for (const time of [0, 123_456, 9_876_543]) {
      for (const body of game.universe.bodies.values()) {
        if (!body.parent || !body.orbit) continue;
        const bodyScene = mapBodyScenePosition(game.universe, body, anchor, time);
        const parentScene = mapBodyScenePosition(game.universe, body.parent, anchor, time);
        game.universe.localPosition(body, time, local);

        expect(bodyScene.x - parentScene.x, `${body.id} map x at ${time}`).toBeCloseTo(local.x * MAP_SCALE, 4);
        expect(bodyScene.y - parentScene.y, `${body.id} map y at ${time}`).toBeCloseTo(local.y * MAP_SCALE, 4);
        expect(bodyScene.z - parentScene.z, `${body.id} map z at ${time}`).toBeCloseTo(local.z * MAP_SCALE, 4);

        const radius = local.length();
        expect(radius).toBeGreaterThanOrEqual(body.orbit.a * (1 - body.orbit.e) * 0.999999);
        expect(radius).toBeLessThanOrEqual(body.orbit.a * (1 + body.orbit.e) * 1.000001);
      }
    }
  });

  it('centers the physical Earth-Moon envelope instead of framing it from Earth', () => {
    const game = new GameState();
    const earth = game.universe.get('earth');
    const moon = game.universe.get('moon');
    const moonPosition = mapBodyScenePosition(game.universe, moon, earth, 0);
    const bounds = mapFitBounds([
      { position: { x: 0, y: 0, z: 0 }, radius: earth.radius * MAP_SCALE },
      { position: moonPosition, radius: moon.radius * MAP_SCALE },
    ]);

    const earthDistance = bounds.center.length();
    const moonDistance = bounds.center.distanceTo(moonPosition);
    expect(earthDistance).toBeGreaterThan(0);
    expect(moonDistance).toBeGreaterThan(0);
    expect(bounds.radius).toBeGreaterThanOrEqual(earthDistance + earth.radius * MAP_SCALE);
    expect(bounds.radius).toBeGreaterThanOrEqual(moonDistance + moon.radius * MAP_SCALE);
    expect(Math.abs(earthDistance - moonDistance)).toBeLessThan(earth.radius * MAP_SCALE * 1.1);
    expect(bounds.radius).toBeLessThan(moonPosition.length() * 0.55);
  });

  it('keeps Earth physically larger than the Moon at a local-system fit distance', () => {
    const game = new GameState();
    const earth = game.universe.get('earth');
    const moon = game.universe.get('moon');
    const cameraDistance = 4_500;

    const earthRadius = mapBodyPresentationRadius(earth.radius, cameraDistance);
    const moonRadius = mapBodyPresentationRadius(moon.radius, cameraDistance);
    expect(earthRadius).toBeCloseTo(earth.radius * MAP_SCALE, 6);
    expect(moonRadius).toBeCloseTo(cameraDistance * 0.0045, 6);
    expect(earthRadius / moonRadius).toBeGreaterThan(3);
  });
});
