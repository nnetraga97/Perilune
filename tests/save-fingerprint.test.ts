import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, SAVE_FINGERPRINT_VERSION } from '../src/save/canonicalJson';
import { hashSave } from '../src/cloud/saveSync';
import { serializeGame } from '../src/save/persistence';
import { createLegacyGameState } from './fixtures/legacyGameState';

describe('canonical save fingerprints', () => {
  it('is stable across recursively reordered jsonb-shaped objects', async () => {
    const save = serializeGame(createLegacyGameState(), 'Canonical');
    const reorder = (value: unknown): unknown => Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)]))
        : value;
    const reordered = JSON.parse(JSON.stringify(reorder(save)));
    expect(canonicalJson(reordered)).toBe(canonicalJson(save));
    expect(await hashSave(reordered)).toBe(await hashSave(save));
    expect(createHash('sha256').update(canonicalJson(save)).digest('hex')).toBe(await hashSave(save));
    expect(SAVE_FINGERPRINT_VERSION).toBe(2);
  });

  it('preserves array order and rejects values JSON would silently lose', () => {
    expect(canonicalJson({ values: [1, 2] })).not.toBe(canonicalJson({ values: [2, 1] }));
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ value: undefined })).toThrow(/undefined/);
  });
});
