import { describe, expect, it } from 'vitest';
import { restoreGame, serializeGame } from '../src/save/persistence';
import { GameState } from '../src/sim/state';
import { addPart, analyzeCraft, createCraft, defOf } from '../src/sim/vessel';

function stageKeys(gv: ReturnType<GameState['spawnInOrbit']>): number[][] {
  return gv.runtime.craft.stages.map((stage) => stage.partKeys);
}

describe('stage plans after vessel splits', () => {
  it('continues above a fired decoupler without an empty-stage press', () => {
    const craft = createCraft('control transfer');
    const retainedEngine = addPart(craft, 'eng-pike', null, 'root', { x: 0, y: 0, z: 0 });
    const decoupler = addPart(craft, 'dec-s', retainedEngine.key, 'stack-top', { x: 0, y: 1, z: 0 });
    const pod = addPart(craft, 'pod-voyager', decoupler.key, 'stack-top', { x: 0, y: 2, z: 0 });
    const chute = addPart(craft, 'chute-main', pod.key, 'stack-top', { x: 0, y: 3, z: 0 });
    craft.stages = [
      { partKeys: [decoupler.key] },
      { partKeys: [retainedEngine.key, chute.key] },
    ];

    const game = new GameState();
    const retained = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    expect(game.fireStage(retained)).toBe(true);

    const detached = game.active!;
    expect(detached).not.toBe(retained);
    expect(retained.runtime.currentStage).toBe(0);
    expect(detached.runtime.currentStage).toBe(0);
    expect(stageKeys(retained)).toEqual([[retainedEngine.key]]);
    expect(stageKeys(detached)).toEqual([[chute.key]]);

    expect(game.fireStage(detached)).toBe(true);
    expect(detached.runtime.craft.parts.find((part) => part.key === chute.key)?.activated).toBe(true);
  });

  it('does not replay a spent separator on the newly controlled top vessel', () => {
    const craft = createCraft('bottom-up stack');
    const lowerEngine = addPart(craft, 'eng-pike', null, 'root', { x: 0, y: 0, z: 0 });
    const lowerTank = addPart(craft, 'tank-s1', lowerEngine.key, 'stack-top', { x: 0, y: 1, z: 0 });
    const decoupler = addPart(craft, 'dec-s', lowerTank.key, 'stack-top', { x: 0, y: 2, z: 0 });
    const upperEngine = addPart(craft, 'eng-ember', decoupler.key, 'stack-top', { x: 0, y: 3, z: 0 });
    const upperTank = addPart(craft, 'tank-s1', upperEngine.key, 'stack-top', { x: 0, y: 4, z: 0 });
    addPart(craft, 'pod-voyager', upperTank.key, 'stack-top', { x: 0, y: 5, z: 0 });
    craft.stages = [
      { partKeys: [lowerEngine.key] },
      { partKeys: [decoupler.key] },
      { partKeys: [upperEngine.key] },
    ];

    const game = new GameState();
    const original = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    expect(game.fireStage(original)).toBe(true);
    expect(game.fireStage(original)).toBe(true);

    const upper = game.active!;
    expect(upper).not.toBe(original);
    expect(stageKeys(upper)).toEqual([[upperEngine.key]]);
    expect(upper.runtime.currentStage).toBe(0);
    expect(analyzeCraft(upper.runtime.craft, 9.42, 0).stages[0].deltaV).toBeGreaterThan(0);
    expect(game.fireStage(upper)).toBe(true);
    expect(upper.runtime.craft.parts.find((part) => part.key === upperEngine.key)?.activated).toBe(true);
  });

  it('keeps control and the next action below a fired decoupler', () => {
    const craft = createCraft('retained control');
    const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    const chute = addPart(craft, 'chute-main', pod.key, 'stack-bottom', { x: 0, y: -1, z: 0 });
    const decoupler = addPart(craft, 'dec-s', pod.key, 'stack-top', { x: 0, y: 1, z: 0 });
    const tank = addPart(craft, 'tank-s1', decoupler.key, 'stack-top', { x: 0, y: 2, z: 0 });
    const engine = addPart(craft, 'eng-pike', tank.key, 'stack-top', { x: 0, y: 3, z: 0 });
    craft.stages = [
      { partKeys: [decoupler.key] },
      { partKeys: [chute.key, engine.key] },
    ];

    const game = new GameState();
    const retained = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    expect(game.fireStage(retained)).toBe(true);

    expect(game.active).toBe(retained);
    expect(retained.runtime.currentStage).toBe(0);
    expect(stageKeys(retained)).toEqual([[chute.key]]);
    expect(game.fireStage(retained)).toBe(true);
    expect(retained.runtime.craft.parts.find((part) => part.key === chute.key)?.activated).toBe(true);
  });

  it('remaps both cursors through a three-stage serial split', () => {
    const craft = createCraft('serial stack');
    const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 6, z: 0 });
    const chute = addPart(craft, 'chute-main', pod.key, 'stack-top', { x: 0, y: 7, z: 0 });
    const upperEngine = addPart(craft, 'eng-ember', pod.key, 'stack-bottom', { x: 0, y: 5, z: 0 });
    const upperDec = addPart(craft, 'dec-s', upperEngine.key, 'stack-bottom', { x: 0, y: 4, z: 0 });
    const middleTank = addPart(craft, 'tank-s1', upperDec.key, 'stack-bottom', { x: 0, y: 3, z: 0 });
    const middleEngine = addPart(craft, 'eng-pike', middleTank.key, 'stack-bottom', { x: 0, y: 2, z: 0 });
    const lowerDec = addPart(craft, 'dec-s', middleEngine.key, 'stack-bottom', { x: 0, y: 1, z: 0 });
    const lowerEngine = addPart(craft, 'eng-pike', lowerDec.key, 'stack-bottom', { x: 0, y: 0, z: 0 });
    craft.stages = [
      { partKeys: [lowerEngine.key] },
      { partKeys: [lowerDec.key, middleEngine.key] },
      { partKeys: [upperDec.key, upperEngine.key] },
      { partKeys: [chute.key] },
    ];

    const game = new GameState();
    const retained = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    expect(game.fireStage(retained)).toBe(true);
    expect(game.fireStage(retained)).toBe(true);

    const lower = game.vessels.find((gv) => gv !== retained)!;
    expect(stageKeys(retained)).toEqual([
      [middleEngine.key],
      [upperDec.key, upperEngine.key],
      [chute.key],
    ]);
    expect(retained.runtime.currentStage).toBe(1);
    expect(stageKeys(lower)).toEqual([[lowerEngine.key]]);
    expect(lower.runtime.currentStage).toBe(1);
  });

  it('round-trips compacted plans after a mid-flight separation', () => {
    const craft = createCraft('save split');
    const engine = addPart(craft, 'eng-pike', null, 'root', { x: 0, y: 0, z: 0 });
    const decoupler = addPart(craft, 'dec-s', engine.key, 'stack-top', { x: 0, y: 1, z: 0 });
    const pod = addPart(craft, 'pod-voyager', decoupler.key, 'stack-top', { x: 0, y: 2, z: 0 });
    const chute = addPart(craft, 'chute-main', pod.key, 'stack-top', { x: 0, y: 3, z: 0 });
    craft.stages = [
      { partKeys: [decoupler.key] },
      { partKeys: [engine.key, chute.key] },
    ];
    const game = new GameState();
    const original = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    expect(game.fireStage(original)).toBe(true);

    const before = game.vessels
      .map((gv) => ({
        partKeys: gv.runtime.craft.parts.map((part) => part.key).sort((a, b) => a - b),
        stages: stageKeys(gv),
        currentStage: gv.runtime.currentStage,
      }))
      .sort((a, b) => a.partKeys[0] - b.partKeys[0]);
    const restored = restoreGame(serializeGame(game, 'mid-separation'));
    const after = restored.vessels
      .map((gv) => ({
        partKeys: gv.runtime.craft.parts.map((part) => part.key).sort((a, b) => a - b),
        stages: stageKeys(gv),
        currentStage: gv.runtime.currentStage,
      }))
      .sort((a, b) => a.partKeys[0] - b.partKeys[0]);

    expect(after).toEqual(before);
  });

  it('preserves the stage cursor and actions when a structural joint split uses the shared detach path', () => {
    const craft = createCraft('structural split');
    const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 2, z: 0 });
    const chute = addPart(craft, 'chute-main', pod.key, 'stack-top', { x: 0, y: 3, z: 0 });
    const tank = addPart(craft, 'tank-s1', pod.key, 'stack-bottom', { x: 0, y: 1, z: 0 });
    const engine = addPart(craft, 'eng-pike', tank.key, 'stack-bottom', { x: 0, y: 0, z: 0 });
    craft.stages = [
      { partKeys: [] },
      { partKeys: [chute.key, engine.key] },
    ];

    const game = new GameState();
    const retained = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    retained.runtime.currentStage = 1;
    game.detachSubtree(retained, tank, 0);
    const detached = game.vessels.find((gv) => gv !== retained)!;

    expect(retained.runtime.currentStage).toBe(0);
    expect(detached.runtime.currentStage).toBe(0);
    expect(stageKeys(retained)).toEqual([[chute.key]]);
    expect(stageKeys(detached)).toEqual([[engine.key]]);
  });

  it('preserves independent pending actions on both sides of an undock', () => {
    const craft = createCraft('docked stack');
    const podA = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    const engineA = addPart(craft, 'eng-pike', podA.key, 'stack-bottom', { x: 0, y: -1, z: 0 });
    const parentPort = addPart(craft, 'dock-port-s', podA.key, 'stack-top', { x: 0, y: 1, z: 0 });
    const childPort = addPart(craft, 'dock-port-s', parentPort.key, 'stack-top', { x: 0, y: 2, z: 0 });
    const podB = addPart(craft, 'pod-voyager', childPort.key, 'stack-top', { x: 0, y: 3, z: 0 });
    const chuteB = addPart(craft, 'chute-main', podB.key, 'stack-top', { x: 0, y: 4, z: 0 });
    craft.stages = [
      { partKeys: [] },
      { partKeys: [engineA.key, chuteB.key] },
    ];

    const game = new GameState();
    const retained = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    retained.runtime.currentStage = 1;
    expect(game.undock(retained, childPort.key)).toBe(true);
    const detached = game.vessels.find((gv) => gv !== retained)!;

    expect(retained.runtime.currentStage).toBe(0);
    expect(detached.runtime.currentStage).toBe(0);
    expect(stageKeys(retained)).toEqual([[engineA.key]]);
    expect(stageKeys(detached)).toEqual([[chuteB.key]]);
    expect(detached.runtime.craft.parts.some((part) => defOf(part).pod)).toBe(true);
  });
});
