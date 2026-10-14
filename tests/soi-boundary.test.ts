import { expect, it } from 'vitest';
import { GameState } from '../src/sim/state';
import { GAMEPLAY_PROFILES } from '../src/content/gameplayProfiles';
import { createOdysseyOrbiter } from '../src/content/crafts';
import { Vec3 } from '../src/core/vec3';

it.each(['entry', 'exit'] as const)('continues the clock across Moon SOI %s without reversing at the boundary', (direction) => {
  const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
  const gv = game.spawnInOrbit(createOdysseyOrbiter(), 'Boundary probe', direction === 'entry' ? 'earth' : 'moon', 200_000);
  const moon = game.universe.get('moon');
  const r = new Vec3();
  const v = new Vec3();
  game.universe.localPosition(moon, game.time, r, v);
  gv.runtime.pos.set(moon.soiRadius + (direction === 'entry' ? 100 : -100), 0, 0);
  gv.runtime.vel.set(direction === 'entry' ? -1000 : 1000, 100, 0);
  if (direction === 'entry') {
    gv.runtime.pos.add(r);
    gv.runtime.vel.add(v);
  }
  game.setWarp(4, true);
  game.update(0.1);
  expect(gv.runtime.bodyId).toBe(direction === 'entry' ? 'moon' : 'earth');
  const crossingTime = game.time;
  for (let i = 0; i < 5; i++) game.update(0.01);
  expect(game.time).toBeGreaterThan(crossingTime + 1);
  expect(gv.runtime.bodyId).toBe(direction === 'entry' ? 'moon' : 'earth');
  expect(Number.isFinite(gv.runtime.pos.length())).toBe(true);
});
