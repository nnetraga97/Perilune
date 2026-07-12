import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadPartAssetInputs,
  validatePartAssetDocuments,
  PART_ASSET_BUDGET_CEILINGS,
} from '../scripts/lib/part-asset-schema.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const inputs = () => loadPartAssetInputs(root);

describe('validatePartAssetDocuments', () => {
  it('accepts the committed eight-source / eight-recipe documents without branding metadata', () => {
    const { sources, recipes } = inputs();
    expect(validatePartAssetDocuments(sources, recipes)).toEqual([]);
    expect(sources.sources).toHaveLength(8);
    expect(recipes.models).toHaveLength(8);
    // No license classification or branding-review object is required to pass.
    for (const source of sources.sources) {
      expect(source).not.toHaveProperty('license');
      expect(source).not.toHaveProperty('brandingReview');
    }
  });

  it('rejects duplicate source IDs', () => {
    const { sources, recipes } = inputs();
    const bad = clone(sources);
    bad.sources.push(clone(bad.sources[0]));
    expect(validatePartAssetDocuments(bad, recipes).some((e: string) => /Duplicate part sourceId/.test(e))).toBe(true);
  });

  it('rejects duplicate asset and partId assignments', () => {
    const { sources, recipes } = inputs();
    const bad = clone(recipes);
    bad.models.push(clone(bad.models[0]));
    const errors = validatePartAssetDocuments(sources, bad);
    expect(errors.some((e: string) => /Duplicate part assetId/.test(e))).toBe(true);
    expect(errors.some((e: string) => /Duplicate partId assignment/.test(e))).toBe(true);
  });

  it('rejects unsafe output paths', () => {
    const { sources, recipes } = inputs();
    const bad = clone(recipes);
    bad.models[0].outputPath = '../escape.glb';
    expect(validatePartAssetDocuments(sources, bad).some((e: string) => /must be a safe relative path/.test(e))).toBe(true);
  });

  it('rejects malformed SHA-256 source values', () => {
    const { sources, recipes } = inputs();
    const bad = clone(sources);
    bad.sources[0].sha256 = 'NOTAHASH';
    expect(validatePartAssetDocuments(bad, recipes).some((e: string) => /64 lowercase hexadecimal/.test(e))).toBe(true);
  });

  it('rejects invalid visual bounds', () => {
    const { sources, recipes } = inputs();
    const bad = clone(recipes);
    bad.models[0].visualBounds.min = clone(bad.models[0].visualBounds.max);
    expect(validatePartAssetDocuments(sources, bad).some((e: string) => /min must be less than max/.test(e))).toBe(true);
  });

  it('rejects every global-budget overrun', () => {
    const { sources, recipes } = inputs();
    for (const name of Object.keys(PART_ASSET_BUDGET_CEILINGS) as (keyof typeof PART_ASSET_BUDGET_CEILINGS)[]) {
      const bad = clone(recipes);
      bad.budgets[name] = PART_ASSET_BUDGET_CEILINGS[name] + 1;
      expect(validatePartAssetDocuments(sources, bad).some((e: string) => new RegExp(`budgets\\.${name} exceeds`).test(e))).toBe(true);
    }
  });

  it('rejects a reference-craft triangle overrun', () => {
    const { sources, recipes } = inputs();
    const bad = clone(recipes);
    // Six wheels; inflating the wheel limit blows the 60k reference-craft ceiling.
    const wheel = bad.models.find((m: { partId: string }) => m.partId === 'wheel-mesa');
    wheel.triangleLimit = 11_000;
    expect(validatePartAssetDocuments(sources, bad).some((e: string) => /reference craft ceiling/.test(e))).toBe(true);
  });
});
