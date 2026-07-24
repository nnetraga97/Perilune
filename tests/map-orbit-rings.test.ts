import { describe, expect, it } from 'vitest';
import { mapOrbitRingBodies } from '../src/ui/mapView';
import { createLegacyGameState } from './fixtures/legacyGameState';
import { GameState } from '../src/sim/state';

describe('which bodies get an orbit ring on the map', () => {
  it('includes the anchor body so you can see the orbit you are flying in', () => {
    const game = createLegacyGameState();
    const ids = mapOrbitRingBodies(game.universe).map((body) => body.id);

    expect(ids).toContain('veyra');
  });

  it('includes every orbiting body regardless of the anchor', () => {
    const game = createLegacyGameState();
    const ids = new Set(mapOrbitRingBodies(game.universe).map((body) => body.id));

    for (const body of game.universe.bodies.values()) {
      if (!body.orbit || !body.parent) continue;
      expect(ids.has(body.id), `${body.id} should have an orbit ring`).toBe(true);
    }
  });

  it('excludes the root star, which has no orbit to draw', () => {
    const game = createLegacyGameState();
    const ids = mapOrbitRingBodies(game.universe).map((body) => body.id);

    expect(ids).not.toContain(game.universe.root.id);
  });

  it('includes Mercury, Venus, and Mars as heliocentric orbit rings in the production system', () => {
    const ids = mapOrbitRingBodies(new GameState().universe).map((body) => body.id);
    expect(ids).toContain('mercury');
    expect(ids).toContain('venus');
    expect(ids).toContain('mars');
  });
});
