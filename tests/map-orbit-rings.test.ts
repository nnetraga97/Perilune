import { describe, expect, it } from 'vitest';
import { GameState } from '../src/sim/state';
import { mapOrbitRingBodies } from '../src/ui/mapView';

describe('which bodies get an orbit ring on the map', () => {
  it('includes the anchor body so you can see the orbit you are flying in', () => {
    const game = new GameState();
    const ids = mapOrbitRingBodies(game.universe).map((body) => body.id);

    expect(ids).toContain('veyra');
  });

  it('includes every orbiting body regardless of the anchor', () => {
    const game = new GameState();
    const ids = new Set(mapOrbitRingBodies(game.universe).map((body) => body.id));

    for (const body of game.universe.bodies.values()) {
      if (!body.orbit || !body.parent) continue;
      expect(ids.has(body.id), `${body.id} should have an orbit ring`).toBe(true);
    }
  });

  it('excludes the root star, which has no orbit to draw', () => {
    const game = new GameState();
    const ids = mapOrbitRingBodies(game.universe).map((body) => body.id);

    expect(ids).not.toContain(game.universe.root.id);
  });
});
