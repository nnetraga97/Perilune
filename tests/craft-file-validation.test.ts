import { describe, expect, it } from 'vitest';
import { validateCraftFile } from '../src/save/persistence';
import { buildTwoStageRocket } from './vessel.test';

function serialized(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(buildTwoStageRocket())) as Record<string, unknown>;
}

describe('craft file validation', () => {
  it('accepts a well-formed craft and rebuilds it structurally intact', () => {
    const craft = buildTwoStageRocket();
    const validated = validateCraftFile(JSON.parse(JSON.stringify(craft)));
    expect(validated).not.toBeNull();
    expect(validated!.name).toBe(craft.name);
    expect(validated!.parts).toHaveLength(craft.parts.length);
    expect(validated!.stages).toEqual(craft.stages);
    expect(validated!.nextKey).toBeGreaterThan(Math.max(...craft.parts.map((p) => p.key)));
  });

  it('rejects non-objects and structurally missing fields', () => {
    expect(validateCraftFile(null)).toBeNull();
    expect(validateCraftFile('craft')).toBeNull();
    expect(validateCraftFile({})).toBeNull();
    const noParts = serialized();
    delete noParts.parts;
    expect(validateCraftFile(noParts)).toBeNull();
  });

  it('rejects unknown part definitions', () => {
    const craft = serialized();
    (craft.parts as Array<{ defId: string }>)[0].defId = 'not-a-real-part';
    expect(validateCraftFile(craft)).toBeNull();
  });

  it('rejects non-finite numeric fields and negative resources', () => {
    const badPosition = serialized();
    (badPosition.parts as Array<{ position: { y: unknown } }>)[0].position.y = 'NaN-string';
    expect(validateCraftFile(badPosition)).toBeNull();

    const badResource = serialized();
    (badResource.parts as Array<{ resources: Record<string, number> }>)[2].resources['liquid-fuel'] = -5;
    expect(validateCraftFile(badResource)).toBeNull();
  });

  it('rejects duplicate keys, dangling parents, and dangling stage keys', () => {
    const duplicate = serialized();
    const duplicateParts = duplicate.parts as Array<{ key: number }>;
    duplicateParts[1].key = duplicateParts[0].key;
    expect(validateCraftFile(duplicate)).toBeNull();

    const danglingParent = serialized();
    (danglingParent.parts as Array<{ parentKey: number | null }>)[1].parentKey = 9999;
    expect(validateCraftFile(danglingParent)).toBeNull();

    const danglingStage = serialized();
    (danglingStage.stages as Array<{ partKeys: number[] }>)[0].partKeys.push(9999);
    expect(validateCraftFile(danglingStage)).toBeNull();
  });

  it('clamps oversized names and repairs a stale nextKey', () => {
    const craft = serialized();
    craft.name = 'x'.repeat(500);
    craft.nextKey = 0;
    const validated = validateCraftFile(craft);
    expect(validated).not.toBeNull();
    expect(validated!.name).toHaveLength(80);
    const maxKey = Math.max(...validated!.parts.map((p) => p.key));
    expect(validated!.nextKey).toBe(maxKey + 1);
  });
});
