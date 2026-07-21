import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import checkedParts from '../src/generated/checked-part-manifest.json';
import { PARTS } from '../src/content/parts';

const root = fileURLToPath(new URL('../', import.meta.url));
const readJson = <T>(path: string): T => JSON.parse(readFileSync(`${root}${path}`, 'utf8')) as T;

interface MissionModel {
  assetId: string;
  sourceId: string;
  sourcePath: string;
  publicPath: string;
  publicUrl: string;
  sha256: string;
  byteLength: number;
  contentPolicy: string;
  displayLabel: string;
  providerStatusLabel: string;
  isAccurateHlsModel: boolean;
  estimatedTextureGpuBytesWithMipmaps: number;
  runtimeTransform: { scale: number[]; position: number[]; rotationQuaternion: number[] };
}

interface MissionManifest {
  schemaVersion: number;
  missionId: string;
  releaseBudgets: {
    requiredQualityTier: string;
    missionCraftTransferBytes: number;
    combinedSceneGpuBytes: number;
  };
  models: MissionModel[];
}

interface SourceLock {
  schemaVersion: number;
  missionId: string;
  sources: Array<{
    sourceId: string;
    localPath: string;
    sha256: string;
    byteLength: number;
    license: string;
    attribution: string;
    modifications: unknown[];
    accuracyBoundary: string;
  }>;
}

interface PartRecipeManifest {
  models: Array<{ assetId: string; partId: string; sourceIds?: string[] }>;
}

interface PartSourceManifest {
  sources: Array<{ sourceId: string; author: string; assetPageUrl: string; sha256: string }>;
}

const manifest = readJson<MissionManifest>('assets/missions/artemis-iv/manifest.json');
const sourceLock = readJson<SourceLock>('assets/missions/artemis-iv/source-lock.json');
const partRecipes = readJson<PartRecipeManifest>('assets/parts/recipes.json');
const partSources = readJson<PartSourceManifest>('assets/parts/sources.json');

describe('Artemis IV source and visual lock', () => {
  it('keeps the selected Starship GLB byte-identical to both checked records', () => {
    expect(manifest).toMatchObject({ schemaVersion: 1, missionId: 'artemis-iv' });
    expect(sourceLock).toMatchObject({ schemaVersion: 1, missionId: 'artemis-iv' });
    expect(manifest.models).toHaveLength(1);
    expect(sourceLock.sources).toHaveLength(1);

    const model = manifest.models[0];
    const source = sourceLock.sources[0];
    const bytes = readFileSync(`${root}assets/missions/artemis-iv/${model.sourcePath}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    expect({ sha256, byteLength: bytes.byteLength }).toEqual({
      sha256: '287317f26516237ed154b9364914396d562552d330a3041000f6157f97c9304c',
      byteLength: 19_007_332,
    });
    expect(source).toMatchObject({
      sourceId: model.sourceId,
      localPath: model.sourcePath,
      sha256,
      byteLength: bytes.byteLength,
      license: 'CC-BY-4.0',
      modifications: [],
    });
    expect(source.attribution).toContain('MartianDays');
    expect(source.accuracyBoundary).toContain('not Starship HLS');
  });

  it('locks the unaltered truth labels, transform, URL, and high-tier envelope', () => {
    const model = manifest.models[0];
    expect(model).toMatchObject({
      assetId: 'martiandays-starship-2019-concept',
      contentPolicy: 'unaltered',
      displayLabel: 'UNCHANGED 2019 STARSHIP CONCEPT STAND-IN',
      providerStatusLabel: 'NASA PROVIDER TBD',
      isAccurateHlsModel: false,
      estimatedTextureGpuBytesWithMipmaps: 357_913_936,
      runtimeTransform: {
        scale: [0.01, 0.01, 0.01],
        rotationQuaternion: [0, 0, 0, 1],
      },
    });
    expect(model.runtimeTransform.position).toHaveLength(3);
    expect(model.publicUrl).toBe(`/missions/artemis-iv/${model.publicPath}?v=${model.sha256}`);
    expect(manifest.releaseBudgets).toEqual({
      requiredQualityTier: 'high',
      missionCraftTransferBytes: 25_165_824,
      combinedSceneGpuBytes: 805_306_368,
    });
  });

  it('proves Voyager is NASA-Orion-derived while leaving stock gameplay unchanged', () => {
    const recipe = partRecipes.models.find((candidate) => candidate.assetId === 'orion-voyager-pod');
    const source = partSources.sources.find((candidate) => candidate.sourceId === 'nasa-orion-capsule');
    const checked = checkedParts.manifest.models.find((candidate) => candidate.assetId === 'orion-voyager-pod');
    const stockPart = PARTS.find((candidate) => candidate.id === 'pod-voyager');

    expect(recipe).toMatchObject({ partId: 'pod-voyager', sourceIds: ['nasa-orion-capsule'] });
    expect(source).toMatchObject({
      author: 'NASA',
      assetPageUrl: 'https://science.nasa.gov/3d-resources/orion-capsule/',
    });
    expect(source?.sha256).toMatch(/^[a-f\d]{64}$/);
    expect(stockPart).toMatchObject({ massDry: 840, pod: { crew: 1 }, modelAssetId: 'orion-voyager-pod' });
    expect(checked).toBeDefined();

    const diameter = (checked!.boundsMax[0] - checked!.boundsMin[0]) * 4.164;
    const height = (checked!.boundsMax[1] - checked!.boundsMin[1]) * 4.164;
    expect(diameter).toBeCloseTo(5, 2);
    expect(height).toBeCloseTo(3.54, 2);
  });

  it('keeps required attribution and accuracy language visible in repository notices', () => {
    const legal = readFileSync(`${root}docs/LEGAL.md`, 'utf8');
    expect(legal).toContain('model by MartianDays');
    expect(legal).toContain('not an accurate');
    expect(legal).toContain('CC BY 4.0');
    expect(legal).toContain('martiandays-spacex-starship-2019.glb');
  });
});
