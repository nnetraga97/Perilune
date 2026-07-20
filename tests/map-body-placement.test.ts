import { createLegacyGameState } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState } from '../src/sim/state';
import { mapBodyScenePosition } from '../src/ui/mapView';

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
});
