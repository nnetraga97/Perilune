import { describe, expect, it } from 'vitest';
import { GameState } from '../src/sim/state';
import { addPart, createCraft } from '../src/sim/vessel';
import { collectScience, encodeScienceKey } from '../src/sim/science';

/** Engine + decoupler + crewed pod: firing stage 0 hands control to the pod. */
function podOverEngine(name: string) {
  const craft = createCraft(name);
  const engine = addPart(craft, 'eng-pike', null, 'root', { x: 0, y: 0, z: 0 });
  const decoupler = addPart(craft, 'dec-s', engine.key, 'stack-top', { x: 0, y: 1, z: 0 });
  const pod = addPart(craft, 'pod-voyager', decoupler.key, 'stack-top', { x: 0, y: 2, z: 0 });
  const chute = addPart(craft, 'chute-main', pod.key, 'stack-top', { x: 0, y: 3, z: 0 });
  const survey = addPart(craft, 'sci-survey', pod.key, 'surface', { x: 0.4, y: 2, z: 0 });
  craft.stages = [{ partKeys: [decoupler.key] }, { partKeys: [engine.key, chute.key] }];
  return { craft, engine, decoupler, pod, chute, survey };
}

function bufferedTotal(game: GameState): number {
  return game.vessels.reduce((total, vessel) => total + vessel.runtime.scienceBuffer.size, 0);
}

describe('buffered science across a stage separation', () => {
  it('follows the crewed component when control transfers', () => {
    const { craft } = podOverEngine('science carrier');
    const game = new GameState();
    const gv = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    const collected = collectScience(game, gv);
    expect(collected.collected.length).toBeGreaterThan(0);
    const held = gv.runtime.scienceBuffer.size;

    expect(game.fireStage(gv)).toBe(true);

    const active = game.active!;
    expect(active).not.toBe(gv);
    expect(active.runtime.isDebris).toBe(false);
    expect(active.runtime.scienceBuffer.size).toBe(held);
  });

  it('does not strand science on the discarded debris', () => {
    const { craft } = podOverEngine('science carrier');
    const game = new GameState();
    const gv = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    collectScience(game, gv);

    expect(game.fireStage(gv)).toBe(true);

    const debris = game.vessels.filter((vessel) => vessel !== game.active);
    for (const wreck of debris) {
      expect(wreck.runtime.scienceBuffer.size).toBe(0);
    }
  });

  it('never duplicates buffered results across the split', () => {
    const { craft } = podOverEngine('science carrier');
    const game = new GameState();
    const gv = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    collectScience(game, gv);
    const held = gv.runtime.scienceBuffer.size;

    expect(game.fireStage(gv)).toBe(true);

    expect(bufferedTotal(game)).toBe(held);
  });

  it('preserves the stored result values, not just the entry count', () => {
    const { craft } = podOverEngine('science carrier');
    const game = new GameState();
    const gv = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    collectScience(game, gv);
    const before = [...gv.runtime.scienceBuffer].map(([keyId, result]) => [keyId, result.heldValue] as const);

    expect(game.fireStage(gv)).toBe(true);

    const after = game.active!.runtime.scienceBuffer;
    for (const [keyId, heldValue] of before) {
      expect(after.get(keyId)?.heldValue).toBe(heldValue);
    }
  });

  it('leaves science on the original vessel when it keeps control', () => {
    const craft = createCraft('drop tank below pod');
    const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    const decoupler = addPart(craft, 'dec-s', pod.key, 'stack-bottom', { x: 0, y: -1, z: 0 });
    const engine = addPart(craft, 'eng-pike', decoupler.key, 'stack-bottom', { x: 0, y: -2, z: 0 });
    addPart(craft, 'sci-survey', pod.key, 'surface', { x: 0.4, y: 0, z: 0 });
    craft.stages = [{ partKeys: [decoupler.key] }, { partKeys: [engine.key] }];

    const game = new GameState();
    const gv = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    collectScience(game, gv);
    const held = gv.runtime.scienceBuffer.size;
    expect(held).toBeGreaterThan(0);

    expect(game.fireStage(gv)).toBe(true);

    expect(gv.runtime.scienceBuffer.size).toBe(held);
    expect(encodeScienceKey).toBeTypeOf('function');
  });
});
