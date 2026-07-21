import { canonicalJson, sha256Utf8 } from './checkedManifestDigest';

/** Approved runtime ceilings; mirrors scripts/lib/part-asset-schema.mjs. */
const PART_ASSET_BUDGET_CEILINGS = Object.freeze({
  totalTriangleLimit: 65_000,
  totalTransferBytes: 6 * 1024 * 1024,
  totalGpuBytes: 32 * 1024 * 1024,
});

const REFERENCE_CRAFT_TRIANGLE_LIMIT = 70_000;

const REFERENCE_CRAFT_COPIES: Readonly<Record<string, number>> = Object.freeze({
  'pod-voyager': 1,
  'eng-colt': 1,
  'eng-mule': 1,
  'tank-m4': 2,
  'tank-s2': 1,
  'dec-interstage-ms': 1,
  'fin-rudder': 4,
  'fin-swift': 4,
  'dec-radial': 2,
  'srb-torch': 2,
  'nose-s': 2,
});

const SHA256 = /^[a-f0-9]{64}$/;

/** Engine plume mount described in authored model space. */
export interface PartEffectAnchor {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: number;
}

export interface CheckedPartModel {
  readonly assetId: string;
  readonly partId: string;
  readonly outputPath: string;
  readonly sha256: string;
  readonly triangles: number;
  readonly transferBytes: number;
  readonly gpuBytes: number;
  readonly boundsMin: readonly [number, number, number];
  readonly boundsMax: readonly [number, number, number];
  readonly plumeAnchors: readonly PartEffectAnchor[];
}

export interface CheckedPartManifestArtifact {
  readonly schemaVersion: number;
  readonly manifestSha256: string;
  readonly manifest: unknown;
}

const checkedPartManifestBrand: unique symbol = Symbol('checkedPartModelManifest');
export interface CheckedPartModelManifest {
  readonly [checkedPartManifestBrand]: true;
  readonly digest: string;
  readonly models: readonly CheckedPartModel[];
  model(assetId: string): CheckedPartModel | null;
  modelForPart(partId: string): CheckedPartModel | null;
}

const checkedPartManifests = new WeakSet<object>();

/** A manifest object is only accepted once it passed checkPartModelManifest. */
export function isCheckedPartModelManifest(value: object): value is CheckedPartModelManifest {
  return checkedPartManifests.has(value);
}

function requireLocal(path: string): void {
  if (
    !path ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.split(/[\\/]/).includes('..') ||
    /^[a-z][a-z\d+.-]*:/i.test(path)
  ) {
    throw new Error(`Part asset path is not a validator-approved local manifest entry: ${path}`);
  }
}

function readVector(value: unknown, length: number, label: string): number[] {
  if (!Array.isArray(value) || value.length !== length || value.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`Checked part manifest has an invalid ${label}`);
  }
  return value as number[];
}

function readAnchor(raw: unknown, label: string): PartEffectAnchor {
  const anchor = raw as Partial<PartEffectAnchor>;
  const position = readVector(anchor?.position, 3, `${label} position`);
  const rotation = readVector(anchor?.rotation, 4, `${label} rotation`);
  if (!Number.isFinite(anchor?.scale) || (anchor!.scale as number) <= 0) {
    throw new Error(`Checked part manifest has an invalid ${label} scale`);
  }
  return Object.freeze({
    position: Object.freeze([position[0], position[1], position[2]]) as PartEffectAnchor['position'],
    rotation: Object.freeze([rotation[0], rotation[1], rotation[2], rotation[3]]) as PartEffectAnchor['rotation'],
    scale: anchor!.scale as number,
  });
}

export function checkPartModelManifest(artifact: CheckedPartManifestArtifact): CheckedPartModelManifest {
  if (artifact?.schemaVersion !== 1 || !SHA256.test(artifact.manifestSha256 ?? '')) {
    throw new Error('Invalid checked part manifest artifact');
  }
  const actualDigest = sha256Utf8(canonicalJson(artifact.manifest));
  if (actualDigest !== artifact.manifestSha256) {
    throw new Error(`Checked part manifest digest mismatch: expected ${artifact.manifestSha256}, got ${actualDigest}`);
  }
  const source = artifact.manifest as { readonly schemaVersion?: number; readonly models?: readonly unknown[] };
  if (!source || source.schemaVersion !== 1 || !Array.isArray(source.models)) {
    throw new Error('Checked part manifest does not match schema version 1');
  }

  const assetIds = new Set<string>();
  const partIds = new Set<string>();
  let triangles = 0;
  let transferBytes = 0;
  let gpuBytes = 0;
  let referenceCraftTriangles = 0;

  const models = source.models.map((raw) => {
    const model = raw as Partial<CheckedPartModel>;
    if (typeof model.assetId !== 'string' || typeof model.partId !== 'string') {
      throw new Error('Checked part manifest contains a model without string identifiers');
    }
    if (assetIds.has(model.assetId)) throw new Error(`Duplicate checked part assetId ${model.assetId}`);
    if (partIds.has(model.partId)) throw new Error(`Duplicate checked partId assignment ${model.partId}`);
    assetIds.add(model.assetId);
    partIds.add(model.partId);
    if (typeof model.outputPath !== 'string') {
      throw new Error(`Checked part manifest model ${model.assetId} has no outputPath`);
    }
    requireLocal(model.outputPath);
    if (typeof model.sha256 !== 'string' || !SHA256.test(model.sha256)) {
      throw new Error(`Checked part manifest model ${model.assetId} has an invalid sha256`);
    }
    for (const [field, value] of Object.entries({
      triangles: model.triangles,
      transferBytes: model.transferBytes,
      gpuBytes: model.gpuBytes,
    })) {
      if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error(`Checked part manifest model ${model.assetId} has an invalid ${field}`);
      }
    }
    const boundsMin = readVector(model.boundsMin, 3, `${model.assetId} boundsMin`);
    const boundsMax = readVector(model.boundsMax, 3, `${model.assetId} boundsMax`);
    if (boundsMin.some((min, index) => min >= boundsMax[index])) {
      throw new Error(`Checked part manifest model ${model.assetId} has non-increasing bounds`);
    }
    if (!Array.isArray(model.plumeAnchors)) {
      throw new Error(`Checked part manifest model ${model.assetId} has no plumeAnchors array`);
    }
    const plumeAnchors = model.plumeAnchors.map((anchor, index) =>
      readAnchor(anchor, `${model.assetId} plumeAnchors[${index}]`),
    );

    triangles += model.triangles as number;
    transferBytes += model.transferBytes as number;
    gpuBytes += model.gpuBytes as number;
    referenceCraftTriangles += (model.triangles as number) * (REFERENCE_CRAFT_COPIES[model.partId] ?? 0);

    return Object.freeze({
      assetId: model.assetId,
      partId: model.partId,
      outputPath: model.outputPath,
      sha256: model.sha256,
      triangles: model.triangles as number,
      transferBytes: model.transferBytes as number,
      gpuBytes: model.gpuBytes as number,
      boundsMin: Object.freeze([boundsMin[0], boundsMin[1], boundsMin[2]]) as CheckedPartModel['boundsMin'],
      boundsMax: Object.freeze([boundsMax[0], boundsMax[1], boundsMax[2]]) as CheckedPartModel['boundsMax'],
      plumeAnchors: Object.freeze(plumeAnchors),
    });
  });

  for (const [name, total] of Object.entries({
    totalTriangleLimit: triangles,
    totalTransferBytes: transferBytes,
    totalGpuBytes: gpuBytes,
  })) {
    if (total > PART_ASSET_BUDGET_CEILINGS[name as keyof typeof PART_ASSET_BUDGET_CEILINGS]) {
      throw new Error(`Checked part models exceed ${name}`);
    }
  }
  if (referenceCraftTriangles > REFERENCE_CRAFT_TRIANGLE_LIMIT) {
    throw new Error('Checked part models exceed referenceCraftTriangleLimit');
  }

  const byAssetId = new Map(models.map((model) => [model.assetId, model]));
  const byPartId = new Map(models.map((model) => [model.partId, model]));
  const checked: CheckedPartModelManifest = Object.freeze({
    [checkedPartManifestBrand]: true,
    digest: artifact.manifestSha256,
    models: Object.freeze(models),
    model: (assetId: string) => byAssetId.get(assetId) ?? null,
    modelForPart: (partId: string) => byPartId.get(partId) ?? null,
  }) as unknown as CheckedPartModelManifest;
  checkedPartManifests.add(checked);
  return checked;
}
