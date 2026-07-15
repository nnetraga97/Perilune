import { describe, expect, it } from 'vitest';
import { copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePartAssets, type OptimizeArgs } from '../scripts/compile-part-assets.mjs';
import { canonicalJson } from '../scripts/lib/part-asset-schema.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const generated = (asset: string) => resolve(root, 'assets/parts/generated', `${asset}.glb`);

/** Deterministic optimize stand-in: publish the committed checked GLB for each recipe. */
async function copyGenerated({ outputPath, recipe }: OptimizeArgs): Promise<void> {
  await copyFile(generated(recipe.assetId as string), outputPath);
}

/** Swap one recipe's output for a different (oversized) committed GLB to trip a limit. */
function substitute(map: Record<string, string>) {
  return async ({ outputPath, recipe }: OptimizeArgs): Promise<void> => {
    const asset = map[recipe.assetId as string] ?? (recipe.assetId as string);
    await copyFile(generated(asset), outputPath);
  };
}

describe('compilePartAssets', () => {
  it('emits a byte-identical canonical checked manifest across two dry runs', async () => {
    const first = await compilePartAssets({ root, write: false, optimize: copyGenerated });
    const second = await compilePartAssets({ root, write: false, optimize: copyGenerated });
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.manifest.models).toHaveLength(16);
  });

  it('reproduces the committed checked-part-manifest exactly', async () => {
    const artifact = await compilePartAssets({ root, write: false, optimize: copyGenerated });
    const committed = JSON.parse(readFileSync(resolve(root, 'src/generated/checked-part-manifest.json'), 'utf8'));
    expect(artifact.manifestSha256).toBe(committed.manifestSha256);
    expect(canonicalJson(artifact.manifest)).toBe(canonicalJson(committed.manifest));
  });

  it('rejects a triangle-limit overrun', async () => {
    // Feed the Mule's mesh (5283 tris) into the Colt recipe (limit 2000).
    const optimize = substitute({ 'apollo-colt-engine': 'shuttle-mule-engine' });
    await expect(compilePartAssets({ root, write: false, optimize })).rejects.toThrow(/triangles; limit is/);
  });

  it('rejects a visual-bounds overrun', async () => {
    // Feed the Tank's mesh (±1.8 m tall) into the Pod recipe (±0.434 m tall).
    const optimize = substitute({ 'orion-voyager-pod': 'shuttle-pl400-tank' });
    await expect(compilePartAssets({ root, write: false, optimize })).rejects.toThrow(/exceeds visual bounds/);
  });
});
