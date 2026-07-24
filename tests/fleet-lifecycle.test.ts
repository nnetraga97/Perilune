import { describe, expect, it } from 'vitest';
import { createStarshipConceptDisplayCraft } from '../src/content/crafts';
import { restoreGame, serializeGame } from '../src/save/persistence';
import { SAVE_VERSION, validateSave } from '../src/save/schema';
import { GameState } from '../src/sim/state';
import { addPart, createCraft } from '../src/sim/vessel';

function probe(name: string) {
  const craft = createCraft(name);
  addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  return craft;
}

describe('multi-craft flight lifecycle', () => {
  it('reverts only the selected launch family and preserves other flights', () => {
    const game = new GameState();
    const first = game.spawnOnPad(probe('First flight'), 'First flight');
    expect(game.placeActiveInOrbit('earth')).toBe(true);
    const lander = game.spawnInOrbit(
      createStarshipConceptDisplayCraft(),
      'Artemis IV lander concept',
      'moon',
      100_000,
    );
    const second = game.spawnOnPad(probe('Second flight'), 'Second flight');

    const reverted = game.revertLaunch(second);

    expect(reverted).not.toBeNull();
    expect(reverted?.removedVesselIds).toEqual([second.runtime.id]);
    expect(reverted?.vessel.runtime.name).toBe('Second flight');
    expect(reverted?.vessel.runtime.situation).toBe('prelaunch');
    expect(game.vessels).toContain(first);
    expect(game.vessels).toContain(lander);
    expect(game.vessels).not.toContain(second);
    expect(game.vessels).toHaveLength(3);
    expect(game.active).toBe(reverted?.vessel);
  });

  it('round-trips the original launch blueprint for Revert', () => {
    const game = new GameState();
    const launched = game.spawnOnPad(probe('Persistent launch'), 'Persistent launch');
    const saved = serializeGame(game, 'fleet');

    expect(saved.saveVersion).toBe(SAVE_VERSION);
    expect(validateSave(saved)).toBe(true);
    expect(saved.vessels[0]).toMatchObject({
      launchId: launched.runtime.id,
      launchCraft: { name: 'Persistent launch' },
    });

    const restored = restoreGame(saved);
    const result = restored.revertLaunch(restored.active!);
    expect(result?.vessel.runtime.name).toBe('Persistent launch');
    expect(result?.vessel.launchCraft?.name).toBe('Persistent launch');
  });
});
