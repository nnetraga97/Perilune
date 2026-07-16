import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SAVE_VERSION as schemaVersion, validateSave as schemaValidate } from '../src/save/schema';
import { SAVE_VERSION, validateSave } from '../src/save/validation';

describe('save validation boundary', () => {
  it('keeps browser and server imports on one validator and version', () => {
    expect(schemaValidate).toBe(validateSave);
    expect(schemaVersion).toBe(SAVE_VERSION);
  });

  it('has no runtime dependency on the game, content, rendering, or telemetry graphs', () => {
    const source = readFileSync(new URL('../src/save/validation.ts', import.meta.url), 'utf8');
    const runtimeImports = [...source.matchAll(/^import(?!\s+type\b)[^'\"]*['\"]([^'\"]+)['\"]/gm)]
      .map((match) => match[1]);
    expect(runtimeImports).toEqual(['../core/interstageShroud']);
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
});
