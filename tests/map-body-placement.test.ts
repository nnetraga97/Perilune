import { createLegacyGameState } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState } from '../src/sim/state';
import {
  mapBodyPresentationRadius,
  mapBodyScenePosition,
  mapCameraDistanceCeiling,
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

  it('places the non-Earth planets on their checked heliocentric orbits at multiple epochs', () => {
    const game = new GameState();
    const earth = game.universe.get('earth');
    const local = new Vec3();
    for (const bodyId of ['mercury', 'venus', 'mars', 'jupiter'] as const) {
      const body = game.universe.get(bodyId);
      for (const time of [0, 10_000_000, 50_000_000]) {
        const bodyScene = mapBodyScenePosition(game.universe, body, earth, time);
        const sunScene = mapBodyScenePosition(game.universe, game.universe.get('sun'), earth, time);
        game.universe.localPosition(body, time, local);
        expect(bodyScene.x - sunScene.x).toBeCloseTo(local.x * MAP_SCALE, 4);
        expect(bodyScene.y - sunScene.y).toBeCloseTo(local.y * MAP_SCALE, 4);
        expect(bodyScene.z - sunScene.z).toBeCloseTo(local.z * MAP_SCALE, 4);
      }
    }
  });

  it('places Callisto on its checked parent-relative orbit around Jupiter', () => {
    const game = new GameState();
    const callisto = game.universe.get('callisto');
    const jupiter = game.universe.get('jupiter');
    const local = new Vec3();
    for (const time of [0, 1_000_000, 5_000_000]) {
      const callistoScene = mapBodyScenePosition(game.universe, callisto, jupiter, time);
      game.universe.localPosition(callisto, time, local);
      expect(callistoScene.x).toBeCloseTo(local.x * MAP_SCALE, 4);
      expect(callistoScene.y).toBeCloseTo(local.y * MAP_SCALE, 4);
      expect(callistoScene.z).toBeCloseTo(local.z * MAP_SCALE, 4);
    }
  });

  it('allows the map camera to frame the Mercury-through-Jupiter system without clipping', () => {
    const game = new GameState();
    const earth = game.universe.get('earth');
    const bounds = mapFitBounds([...game.universe.bodies.values()].map((body) => ({
      position: mapBodyScenePosition(game.universe, body, earth, 0),
      radius: body.radius * MAP_SCALE,
    })));
    const fov = 50;
    const requiredFit = bounds.radius / Math.tan(fov * Math.PI / 360) * 1.18;
    const ceiling = mapCameraDistanceCeiling(bounds.radius, fov, 20_000_000);
    expect(ceiling).toBeGreaterThan(requiredFit);
    expect(ceiling).toBeLessThanOrEqual(16_000_000);
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
