import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState } from '../src/sim/state';
import { biomeAt, decodeScienceKey, encodeScienceKey, globalBiome, resolveScienceSite } from '../src/sim/science';
import { addPart, createCraft } from '../src/sim/vessel';

describe('science biome authority', () => {
  it('classifies deterministically from body-fixed geometry and honors polar precedence', () => {
    const game = new GameState();
    const palla = game.universe.get('palla');
    const pole = new Vec3(0, 0, 1);
    expect(biomeAt(palla, pole).id).toBe('ice-cap');

    const direction = new Vec3(0.72, -0.41, 0.56).normalize();
    const first = biomeAt(palla, direction).id;
    for (let index = 0; index < 20; index++) expect(biomeAt(palla, direction).id).toBe(first);
  });

  it('uses global for orbital situations and upper-atmosphere for a gas body classifier', () => {
    const game = new GameState();
    const craft = createCraft('Orbital lab');
    addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
    const vessel = game.spawnInOrbit(craft, 'Orbital lab', 'palla', 30_000);
    expect(resolveScienceSite(game, vessel)?.biome.id).toBe('global');
    expect(biomeAt(game.universe.get('tyran'), new Vec3(1, 0, 0)).id).toBe('upper-atmosphere');
    expect(globalBiome(game.universe.get('ashen')).id).toBe('global');
  });

  it('round-trips canonical structured keys and rejects malformed values', () => {
    const key = {
      experimentId: 'spore-exposure', bodyId: 'veyra', biomeId: 'ice-cap', situation: 'flying-low' as const,
    };
    expect(decodeScienceKey(encodeScienceKey(key))).toEqual(key);
    expect(decodeScienceKey('spore-exposure@veyra-flying-low')).toBeNull();
    expect(decodeScienceKey(JSON.stringify(['x', 'veyra', 'global', 'invalid']))).toBeNull();
  });
});
