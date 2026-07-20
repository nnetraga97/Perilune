import { createLegacyGameState } from './fixtures/legacyGameState';
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { addPart, createCraft, removeSubtree } from '../src/sim/vessel';

describe('craft action groups', () => {
  it('executes activate, deactivate, and toggle while ignoring missing parts', () => {
    const craft = createCraft('action authority');
    const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    const engine = addPart(craft, 'eng-pike', pod.key, 'stack-bottom', { x: 0, y: -1, z: 0 });
    const solar = addPart(craft, 'solar-flat', pod.key, 'surface', { x: 1, y: 0, z: 0 });
    engine.activated = false;
    solar.activated = true;
    craft.actionGroups = {
      1: [
        { partKey: engine.key, action: 'toggle' },
        { partKey: solar.key, action: 'deactivate' },
        { partKey: 9999, action: 'activate' },
      ],
      2: [{ partKey: solar.key, action: 'activate' }],
    };

    const game = createLegacyGameState();
    const gv = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    expect(game.executeActionGroup(gv, 1)).toBe(2);
    expect(engine.activated).toBe(true);
    expect(solar.activated).toBe(false);
    expect(game.executeActionGroup(gv, 2)).toBe(1);
    expect(solar.activated).toBe(true);
  });

  it('removes and partitions assignments with their parts', () => {
    const craft = createCraft('group partition');
    const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 2, z: 0 });
    const solar = addPart(craft, 'solar-flat', pod.key, 'surface', { x: 1, y: 2, z: 0 });
    const decoupler = addPart(craft, 'dec-s', pod.key, 'stack-bottom', { x: 0, y: 1, z: 0 });
    const engine = addPart(craft, 'eng-pike', decoupler.key, 'stack-bottom', { x: 0, y: 0, z: 0 });
    craft.stages = [{ partKeys: [decoupler.key] }];
    craft.actionGroups = {
      1: [
        { partKey: solar.key, action: 'toggle' },
        { partKey: engine.key, action: 'toggle' },
      ],
    };

    const game = createLegacyGameState();
    const retained = game.spawnInOrbit(craft, craft.name, 'veyra', 120_000);
    expect(game.fireStage(retained)).toBe(true);
    const detached = game.vessels.find((candidate) => (
      candidate !== retained && candidate.runtime.craft.parts.some((part) => part.key === engine.key)
    ))!;
    expect(retained.runtime.craft.actionGroups[1]).toEqual([
      { partKey: solar.key, action: 'toggle' },
    ]);
    expect(detached.runtime.craft.actionGroups[1]).toEqual([
      { partKey: engine.key, action: 'toggle' },
    ]);

    removeSubtree(retained.runtime.craft, solar.key);
    expect(retained.runtime.craft.actionGroups).toEqual({});
  });

  it('remaps incoming assignments when vessels dock', () => {
    const game = createLegacyGameState();
    const aCraft = createCraft('A');
    const aPod = addPart(aCraft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    addPart(aCraft, 'dock-port-s', aPod.key, 'stack-top', { x: 0, y: 0.55, z: 0 });
    const aSolar = addPart(aCraft, 'solar-flat', aPod.key, 'surface', { x: 1, y: 0, z: 0 });
    aCraft.actionGroups = { 1: [{ partKey: aSolar.key, action: 'toggle' }] };

    const bCraft = createCraft('B');
    const bPod = addPart(bCraft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
    addPart(bCraft, 'dock-port-s', bPod.key, 'stack-top', { x: 0, y: 0.25, z: 0 });
    const bSolar = addPart(bCraft, 'solar-flat', bPod.key, 'surface', { x: 1, y: 0, z: 0 });
    bCraft.actionGroups = { 1: [{ partKey: bSolar.key, action: 'activate' }] };

    const a = game.spawnInOrbit(aCraft, 'A', 'veyra', 120_000);
    const b = game.spawnInOrbit(bCraft, 'B', 'veyra', 120_000);
    const keyOffset = a.runtime.craft.nextKey;
    b.runtime.pos.copy(a.runtime.pos).add(new Vec3(0, 6, 0));
    b.runtime.vel.copy(a.runtime.vel).add(new Vec3(0, -0.5, 0));
    b.runtime.att.set(1, 0, 0, 0);
    a.runtime.sas = 'off';
    b.runtime.sas = 'off';
    game.activeVesselId = a.runtime.id;

    for (let i = 0; i < 3000 && game.vessels.length > 1; i++) game.update(PHYSICS_DT);
    expect(game.vessels).toHaveLength(1);
    expect(game.vessels[0].runtime.craft.actionGroups[1]).toEqual([
      { partKey: aSolar.key, action: 'toggle' },
      { partKey: bSolar.key + keyOffset, action: 'activate' },
    ]);
  });
});
