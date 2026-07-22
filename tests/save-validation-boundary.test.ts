import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SAVE_VERSION as schemaVersion, validateSave as schemaValidate } from '../src/save/schema';
import { SAVE_VERSION, validateSave } from '../src/save/validation';
import { serializeGame } from '../src/save/persistence';
import { createLegacyGameState } from './fixtures/legacyGameState';
import { addPart, createCraft } from '../src/sim/vessel';

describe('save validation boundary', () => {
  it('keeps browser and server imports on one validator and version', () => {
    expect(schemaValidate).toBe(validateSave);
    expect(schemaVersion).toBe(SAVE_VERSION);
  });

  it('has no runtime dependency on the game, content, rendering, or telemetry graphs', () => {
    const source = readFileSync(new URL('../src/save/validation.ts', import.meta.url), 'utf8');
    const runtimeImports = [...source.matchAll(/^import(?!\s+type\b)[^'\"]*['\"]([^'\"]+)['\"]/gm)]
      .map((match) => match[1]);
    expect(runtimeImports).toEqual(['../core/interstageShroud.js']);
    expect(source).not.toMatch(/from ['\"]\.\.\/(?:sim|content|render|telemetry)\//);
  });

  it('makes the server handler import only the pure runtime validator', () => {
    const source = readFileSync(new URL('../server/saveHandlers.ts', import.meta.url), 'utf8');
    expect(source).toContain("import { SAVE_VERSION, validateSave } from '../src/save/validation.js';");
    expect(source).toContain("import type { SaveGame } from '../src/save/schema.js';");
  });

  it('keeps simulation modules free of logging and telemetry imports', () => {
    const simDirectory = fileURLToPath(new URL('../src/sim/', import.meta.url));
    const files = readdirSync(simDirectory).filter((name) => name.endsWith('.ts'));
    for (const file of files) {
      const source = readFileSync(join(simDirectory, file), 'utf8');
      expect(source, file).not.toMatch(/from ['\"][^'\"]*(?:telemetry|server\/log)/);
    }
  });

  it('rejects malformed values before restore or cloud persistence', () => {
    const game = createLegacyGameState();
    const craft = createCraft('Boundary craft');
    addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    game.spawnOnPad(craft, craft.name);
    const valid = serializeGame(game, 'Boundary');
    expect(validateSave(valid)).toBe(true);
    expect(validateSave({ ...valid, saveVersion: 8.5 })).toBe(false);
    expect(validateSave({ ...valid, label: '' })).toBe(false);
    expect(validateSave({ ...valid, activeVesselId: 'missing' })).toBe(false);
    expect(validateSave({ ...valid, vessels: valid.vessels.map((vessel, index) => (
      index === 0 ? { ...vessel, vel: { ...vessel.vel, y: Number.NaN } } : vessel
    )) })).toBe(false);
    expect(validateSave({ ...valid, vessels: valid.vessels.map((vessel, index) => (
      index === 0 ? { ...vessel, att: { ...vessel.att, w: Number.POSITIVE_INFINITY } } : vessel
    )) })).toBe(false);
  });
});
