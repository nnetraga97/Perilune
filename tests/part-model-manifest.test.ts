import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPartModelManifest, isCheckedPartModelManifest } from '../src/render/partModelManifest';
import { canonicalJson, sha256Utf8 } from '../src/render/checkedManifestDigest';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const artifact = () =>
  JSON.parse(readFileSync(resolve(root, 'src/generated/checked-part-manifest.json'), 'utf8'));

/** Re-seal a mutated manifest so it passes the digest gate and reaches field validation. */
function reseal(manifest: unknown) {
  return { schemaVersion: 1, manifestSha256: sha256Utf8(canonicalJson(manifest)), manifest };
}

describe('checkPartModelManifest', () => {
  it('accepts the committed checked artifact and brands it', () => {
    const manifest = checkPartModelManifest(artifact());
    expect(isCheckedPartModelManifest(manifest as unknown as object)).toBe(true);
    expect(manifest.models).toHaveLength(16);
    expect(manifest.model('shuttle-mule-engine')?.plumeAnchors).toHaveLength(3);
    expect(manifest.model('apollo-colt-engine')?.plumeAnchors).toHaveLength(1);
    expect(manifest.modelForPart('eng-colt')?.assetId).toBe('apollo-colt-engine');
    expect(manifest.modelForPart('dec-interstage-ms')?.assetId).toBe('procedural-separator');
    expect(manifest.model('procedural-srb-torch')?.plumeAnchors).toHaveLength(1);
    expect(manifest.model('does-not-exist')).toBeNull();
    expect(manifest.modelForPart('does-not-exist')).toBeNull();
  });

  it('rejects a changed manifest digest before any lookup', () => {
    const bad = artifact();
    bad.manifest.models[0].triangles += 1;
    expect(() => checkPartModelManifest(bad)).toThrow(/digest mismatch/);
  });

  it('rejects an unsafe output path', () => {
    const bad = artifact();
    bad.manifest.models[0].outputPath = '/etc/evil.glb';
    expect(() => checkPartModelManifest(reseal(bad.manifest))).toThrow(/not a validator-approved local/);
  });

  it('rejects non-increasing bounds', () => {
    const bad = artifact();
    bad.manifest.models[0].boundsMax = bad.manifest.models[0].boundsMin;
    expect(() => checkPartModelManifest(reseal(bad.manifest))).toThrow(/non-increasing bounds/);
  });

  it('rejects an invalid plume anchor', () => {
    const bad = artifact();
    const mule = bad.manifest.models.find((m: { assetId: string }) => m.assetId === 'shuttle-mule-engine');
    mule.plumeAnchors[0].scale = 0;
    expect(() => checkPartModelManifest(reseal(bad.manifest))).toThrow(/scale/);
  });

  it('rejects a total triangle-budget overrun', () => {
    const bad = artifact();
    bad.manifest.models[0].triangles = 40_000;
    expect(() => checkPartModelManifest(reseal(bad.manifest))).toThrow(/exceed totalTriangleLimit/);
  });

  it('rejects a duplicate part assignment', () => {
    const bad = artifact();
    bad.manifest.models[1].partId = bad.manifest.models[0].partId;
    expect(() => checkPartModelManifest(reseal(bad.manifest))).toThrow(/Duplicate checked partId/);
  });
});
