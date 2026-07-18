import { describe, expect, it } from 'vitest';
import { BUILT_IN_CRAFTS, createWayfarerDemonstrator } from '../src/content/crafts';
import { partById } from '../src/content/parts';
import { validateCraftFile } from '../src/save/persistence';
import { deriveInterstageShroud } from '../src/sim/interstage';
import { buildAutoStages } from '../src/sim/vessel';
import { evaluateStructure } from '../src/sim/structure';
import { Vec3 } from '../src/core/vec3';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { ascentGuidance } from '../src/sim/guidance';

describe('built-in craft library', () => {
  it('exposes the Wayfarer as a fresh, structurally valid 21-part craft', () => {
    expect(BUILT_IN_CRAFTS.map((craft) => craft.id)).toContain('wayfarer-heavy-demonstrator');
    const first = createWayfarerDemonstrator();
    const second = createWayfarerDemonstrator();
    expect(first).not.toBe(second);
    expect(first.parts).not.toBe(second.parts);
    expect(first.parts).toHaveLength(21);
    expect(validateCraftFile(JSON.parse(JSON.stringify(first)))).not.toBeNull();

    first.parts[0].position.y = -999;
    expect(second.parts[0].position.y).not.toBe(-999);
  });

  it('uses every integrated authored part with the intended counts', () => {
    const craft = createWayfarerDemonstrator();
    const counts = new Map<string, number>();
    for (const part of craft.parts) counts.set(part.defId, (counts.get(part.defId) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toMatchObject({
      'pod-voyager': 1,
      'tank-s2': 1,
      'eng-colt': 1,
      'dec-interstage-ms': 1,
      'tank-m4': 2,
      'eng-mule': 1,
      'fin-rudder': 4,
      'fin-swift': 4,
      'dec-radial': 2,
      'srb-torch': 2,
      'nose-s': 2,
    });
    expect(counts.get('srb-flare') ?? 0).toBe(0);
    for (const part of craft.parts) expect(partById(part.defId)).toBeDefined();
  });

  it('has an acyclic attachment graph and an explicit, non-duplicated stage plan', () => {
    const craft = createWayfarerDemonstrator();
    const byKey = new Map(craft.parts.map((part) => [part.key, part]));
    expect(craft.parts.filter((part) => part.parentKey === null)).toHaveLength(1);
    for (const part of craft.parts) {
      const visited = new Set<number>();
      let current = part;
      while (current.parentKey !== null) {
        expect(visited.has(current.key)).toBe(false);
        visited.add(current.key);
        current = byKey.get(current.parentKey)!;
        expect(current).toBeDefined();
      }
    }
    const staged = craft.stages.flatMap((stage) => stage.partKeys);
    expect(new Set(staged).size).toBe(staged.length);
    expect(staged.every((key) => byKey.has(key))).toBe(true);
    expect(craft.stages.map((stage) => stage.partKeys.length)).toEqual([3, 2, 2]);
  });

  it('auto-stages propulsion and releases from the bottom assembly upward', () => {
    const craft = createWayfarerDemonstrator();
    const defIds = buildAutoStages(craft).map((stage) => stage.partKeys.map((key) => (
      craft.parts.find((part) => part.key === key)!.defId
    )));
    expect(defIds).toEqual([
      ['eng-mule', 'srb-torch', 'srb-torch'],
      ['dec-radial', 'dec-radial'],
      ['dec-interstage-ms', 'eng-colt'],
    ]);
  });

  it('keeps both Torch boosters latched through launch loads and releases them on command', () => {
    const craft = createWayfarerDemonstrator();
    const launchLoad = evaluateStructure(craft, new Vec3(0, 40, 0), 0, 0);
    expect(launchLoad.failures).toEqual([]);
    expect(launchLoad.maxUtilization).toBeLessThan(0.8);

    const game = new GameState();
    const vessel = game.spawnOnPad(craft, craft.name);
    vessel.runtime.controls.throttle = 1;
    expect(game.fireStage(vessel)).toBe(true);
    for (let frame = 0; frame < 60; frame++) game.update(PHYSICS_DT);

    expect(vessel.runtime.craft.parts.filter((part) => part.defId === 'srb-torch')).toHaveLength(2);
    expect(vessel.runtime.events.some((event) => event.text.includes('Structural failure'))).toBe(false);

    expect(game.fireStage(vessel)).toBe(true);
    expect(vessel.runtime.craft.parts.some((part) => part.defId === 'srb-torch')).toBe(false);
    expect(game.vessels.filter((candidate) => (
      candidate.runtime.craft.parts.some((part) => part.defId === 'srb-torch')
    ))).toHaveLength(2);
  });

  it('keeps fins and radial couplings attached through the normal max-Q envelope', () => {
    const craft = createWayfarerDemonstrator();
    const game = new GameState();
    const vessel = game.spawnOnPad(craft, craft.name);
    const runtime = vessel.runtime;
    const body = game.bodyOf(vessel);

    // Let the vehicle settle before following the same full-throttle guidance
    // path that previously shed its fins and boosters at about 45 kPa.
    for (let frame = 0; frame < 250; frame++) game.update(PHYSICS_DT);
    runtime.controls.throttle = 1;
    expect(game.fireStage(vessel)).toBe(true);

    let peakDynamicPressure = 0;
    for (let frame = 0; frame < 1_000 && peakDynamicPressure < 45_000; frame++) {
      game.update(PHYSICS_DT);
      const command = ascentGuidance(runtime, body);
      runtime.sas = 'custom';
      runtime.sasCustomDir.copy(command.dir);
      peakDynamicPressure = Math.max(peakDynamicPressure, runtime.aero.dynamicPressure);
    }

    expect(peakDynamicPressure).toBeGreaterThanOrEqual(45_000);
    expect(runtime.craft.parts.filter((part) => part.defId === 'fin-rudder')).toHaveLength(4);
    expect(runtime.craft.parts.filter((part) => part.defId === 'fin-swift')).toHaveLength(4);
    expect(runtime.craft.parts.filter((part) => part.defId === 'dec-radial')).toHaveLength(2);
    expect(runtime.events.some((event) => event.text.includes('Structural failure'))).toBe(false);

    const normalTurn = evaluateStructure(
      runtime.craft,
      new Vec3(0, runtime.properAccel, 0),
      runtime.aero.dynamicPressure,
      Math.sin(runtime.aero.aoa),
    );
    expect(normalTurn.failures).toEqual([]);
    expect(normalTurn.maxUtilization).toBeLessThan(0.46);

    const aggressiveTurn = evaluateStructure(
      runtime.craft,
      new Vec3(0, 45, 0),
      60_000,
      Math.sin(Math.PI / 6),
    );
    expect(aggressiveTurn.failures.length).toBeGreaterThan(0);
  });

  it('derives the fitted M-to-S envelope through the upper-stage Colt engine', () => {
    const craft = createWayfarerDemonstrator();
    const separator = craft.parts.find((part) => part.defId === 'dec-interstage-ms')!;
    expect(partById(separator.defId)?.shape).toMatchObject({ radiusTop: 1.25, radiusBottom: 1.25 });
    expect(deriveInterstageShroud(craft, separator)).toEqual({
      lowerRadius: 1.25,
      upperRadius: 0.6,
      lowerY: expect.closeTo(-0.08, 8),
      upperY: expect.closeTo(0.53, 8),
    });
  });
});
