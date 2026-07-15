import { describe, expect, it } from 'vitest';
import { BUILT_IN_CRAFTS, createWayfarerDemonstrator } from '../src/content/crafts';
import { partById } from '../src/content/parts';
import { validateCraftFile } from '../src/save/persistence';
import { deriveInterstageShroud } from '../src/sim/interstage';
import { buildAutoStages } from '../src/sim/vessel';

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
