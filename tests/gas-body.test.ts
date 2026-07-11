import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { restoreGame, serializeGame } from '../src/save/persistence';
import { buildAeroModel } from '../src/sim/aero';
import { predictEntry } from '../src/sim/entry';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { addPart, computeMassProperties, createCraft } from '../src/sim/vessel';

function buildProbe() {
  const craft = createCraft('Gas probe');
  addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  return craft;
}

describe('gas-body physics', () => {
  it('continues Tyran pressure and density below the reference radius', () => {
    const tyran = new GameState().universe.get('tyran');
    expect(tyran.pressureAt(-10_000)).toBeGreaterThan(tyran.pressureAt(0));
    expect(tyran.densityAt(-10_000)).toBeGreaterThan(tyran.densityAt(0));
  });

  it('does not create solid contact below Tyran reference radius', () => {
    const game = new GameState();
    const tyran = game.universe.get('tyran');
    const gv = game.spawnInOrbit(buildProbe(), 'Dive', 'tyran', 10_000);
    gv.runtime.pos.set(tyran.radius - 100, 0, 0);
    gv.runtime.vel.set(0, 0, 0);

    game.update(PHYSICS_DT);

    expect(game.vessels).toContain(gv);
    expect(gv.runtime.situation).toBe('flying');
  });

  it('destroys a vessel at Tyran terminal pressure before any landed state', () => {
    const game = new GameState();
    const tyran = game.universe.get('tyran');
    const gv = game.spawnInOrbit(buildProbe(), 'Deep dive', 'tyran', 10_000);
    gv.runtime.pos.set(tyran.radius - 40_000, 0, 0);
    gv.runtime.vel.set(-10, 0, 0);

    game.update(PHYSICS_DT);

    expect(game.vessels).not.toContain(gv);
    expect(game.lastDestruction?.reason).toMatch(/pressure|depth/i);
    expect(gv.runtime.situation).toBe('destroyed');
  });

  it('predicts a terminal gas descent without reporting terrain landing', () => {
    const game = new GameState();
    const tyran = game.universe.get('tyran');
    const craft = buildProbe();
    const prediction = predictEntry(
      tyran,
      buildAeroModel(craft),
      computeMassProperties(craft).mass,
      new Vec3(tyran.radius + 10_000, 0, 0),
      new Vec3(-100, 0, 0),
      game.time,
    );

    expect(prediction.willEnter).toBe(true);
    expect(prediction.lands).toBe(false);
    expect(prediction.landingDirBF).toBeNull();
    expect(prediction.landingTime).toBeGreaterThan(game.time);
  });

  it('rejects a save that claims a vessel landed on Tyran', () => {
    const game = new GameState();
    const tyran = game.universe.get('tyran');
    const gv = game.spawnInOrbit(buildProbe(), 'Impossible lander', 'tyran', 1_000);
    gv.runtime.pos.set(tyran.radius, 0, 0);
    gv.runtime.situation = 'landed';
    const save = serializeGame(game, 'invalid gas landing');

    expect(() => restoreGame(save)).toThrow(/gas|solid surface/i);
  });
});
