import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import missionManifestJson from '../../../assets/missions/artemis-iv/manifest.json';
import type { QualityTier } from '../../render/bodyRenderer';
import type { RenderCaps } from '../../render/context';
import type { PartModelBackend } from '../../render/partModelLibrary';
import {
  DEFAULT_ACTIVE_BODY_BUDGET,
  fullMipChainBytes,
  geometryByteLength,
} from '../../render/resourceAccounting';

export const ARTEMIS_IV_STARSHIP_SHA256 =
  '287317f26516237ed154b9364914396d562552d330a3041000f6157f97c9304c';
export const ARTEMIS_IV_STARSHIP_PUBLIC_URL =
  `/missions/artemis-iv/models/martiandays-spacex-starship-2019.glb?v=${ARTEMIS_IV_STARSHIP_SHA256}`;
export const ARTEMIS_IV_STARSHIP_LABEL = 'UNCHANGED 2019 STARSHIP CONCEPT STAND-IN';
export const ARTEMIS_IV_PROVIDER_LABEL = 'NASA PROVIDER TBD';
export const ARTEMIS_IV_TRANSFER_CAP_BYTES = 25_165_824;
export const ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES = 805_306_368;
export const ARTEMIS_IV_STARSHIP_BYTE_LENGTH = 19_007_332;
export const ARTEMIS_IV_STARSHIP_TEXTURE_ESTIMATE_BYTES = 357_913_936;
const STARSHIP_TEXTURE_EDGE = 4096;
const MATERIAL_GPU_ESTIMATE_BYTES = 256;
type Vector3Tuple = readonly [number, number, number];
type QuaternionTuple = readonly [number, number, number, number];
export interface ArtemisIvVisualAnchor {
  readonly position: Vector3Tuple;
  readonly rotationQuaternion: QuaternionTuple;
  readonly accuracy: 'representative';
}
const anchor = (
  position: Vector3Tuple,
  rotationQuaternion: QuaternionTuple = [0, 0, 0, 1],
): ArtemisIvVisualAnchor => Object.freeze({
  position: Object.freeze([...position]) as Vector3Tuple,
  rotationQuaternion: Object.freeze([...rotationQuaternion]) as QuaternionTuple,
  accuracy: 'representative',
});
/** Mission-only visual metadata; it never mutates the stock one-seat Voyager part. */
export const ARTEMIS_IV_VOYAGER_VISUAL_BINDING = Object.freeze({
  assetId: 'orion-voyager-pod',
  sourcePartId: 'pod-voyager',
  displayLabel: 'Orion Crew Module · simplified exterior',
  uniformScale: 4.164,
  scale: Object.freeze([4.164, 4.164, 4.164]) as Vector3Tuple,
  stockGameplayDefinitionUnchanged: true,
  gameplayAuthority: 'artemis-iv-mission' as const,
  anchors: Object.freeze({
    dockingPort: anchor([0, 1.86, 0]),
    cmEsmSeparation: anchor([0, -1.77, 0]),
    esmBodyCenter: anchor([0, -3.77, 0]),
    esmMainEnginePlume: anchor([0, -5.82, 0]),
    esmSolarWingRoots: Object.freeze([
      anchor([2.15, -3.7, 0]), anchor([-2.15, -3.7, 0]),
      anchor([0, -3.7, 2.15]), anchor([0, -3.7, -2.15]),
    ]),
    recoveryHousing: anchor([0, 1.58, 0]),
    recoveryMainCanopies: Object.freeze([
      anchor([-0.62, 1.72, 0]), anchor([0.31, 1.72, 0.54]), anchor([0.31, 1.72, -0.54]),
    ]),
  }),
});
export interface ArtemisIvStarshipManifestModel {
  readonly assetId: 'martiandays-starship-2019-concept'; readonly missionRole: 'hls-visual-stand-in';
  readonly publicUrl: typeof ARTEMIS_IV_STARSHIP_PUBLIC_URL; readonly sha256: typeof ARTEMIS_IV_STARSHIP_SHA256;
  readonly byteLength: typeof ARTEMIS_IV_STARSHIP_BYTE_LENGTH; readonly contentPolicy: 'unaltered';
  readonly runtimeTransform: {
    readonly scale: Vector3Tuple;
    readonly position: Vector3Tuple;
    readonly rotationQuaternion: QuaternionTuple;
  };
  readonly textureDimensions: readonly [4096, 4096];
  readonly estimatedTextureGpuBytesWithMipmaps: typeof ARTEMIS_IV_STARSHIP_TEXTURE_ESTIMATE_BYTES;
  readonly requiresLazyLoading: true; readonly displayLabel: typeof ARTEMIS_IV_STARSHIP_LABEL;
  readonly providerStatusLabel: typeof ARTEMIS_IV_PROVIDER_LABEL; readonly isAccurateHlsModel: false;
}
export interface CheckedArtemisIvAssetManifest {
  readonly schemaVersion: 1;
  readonly missionId: 'artemis-iv';
  readonly releaseBudgets: {
    readonly requiredQualityTier: 'high';
    readonly missionCraftTransferBytes: typeof ARTEMIS_IV_TRANSFER_CAP_BYTES;
    readonly combinedSceneGpuBytes: typeof ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES;
  };
  readonly model: ArtemisIvStarshipManifestModel;
}
function invalidManifest(message: string): never {
  throw new Error(`Invalid Artemis IV asset manifest: ${message}`);
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) invalidManifest(`${label} must be ${String(expected)}`);
}

function checkedTuple<T extends readonly number[]>(value: unknown, expected: T, label: string): T {
  if (!Array.isArray(value) || value.length !== expected.length
    || value.some((entry, index) => !Number.isFinite(entry) || entry !== expected[index])) {
    invalidManifest(`${label} does not match the checked runtime contract`);
  }
  return Object.freeze([...value]) as unknown as T;
}

/** Runtime-critical subset; provenance and exhaustive stats stay owned by source-lock validation. */
export function checkArtemisIvAssetManifest(raw: unknown): CheckedArtemisIvAssetManifest {
  const manifest = raw as Record<string, unknown> | null;
  if (!manifest) invalidManifest('document is required');
  exact(manifest.schemaVersion, 1, 'schemaVersion');
  exact(manifest.missionId, 'artemis-iv', 'missionId');
  const budgets = manifest.releaseBudgets as Record<string, unknown> | null;
  if (!budgets) invalidManifest('releaseBudgets are required');
  exact(budgets.requiredQualityTier, 'high', 'required quality tier');
  exact(budgets.missionCraftTransferBytes, ARTEMIS_IV_TRANSFER_CAP_BYTES, 'transfer cap');
  exact(budgets.combinedSceneGpuBytes, ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES, 'combined GPU cap');

  const rawModels = Array.isArray(manifest.models) ? manifest.models : [];
  if (rawModels.length !== 1) invalidManifest('exactly one model is required');
  const model = rawModels[0] as Record<string, unknown>;
  exact(model.assetId, 'martiandays-starship-2019-concept', 'assetId');
  exact(model.missionRole, 'hls-visual-stand-in', 'missionRole');
  exact(model.publicUrl, ARTEMIS_IV_STARSHIP_PUBLIC_URL, 'content-addressed publicUrl');
  exact(model.sha256, ARTEMIS_IV_STARSHIP_SHA256, 'sha256');
  exact(model.byteLength, ARTEMIS_IV_STARSHIP_BYTE_LENGTH, 'byteLength');
  exact(model.contentPolicy, 'unaltered', 'contentPolicy');
  exact(model.estimatedTextureGpuBytesWithMipmaps, ARTEMIS_IV_STARSHIP_TEXTURE_ESTIMATE_BYTES, 'texture estimate');
  exact(model.requiresLazyLoading, true, 'requiresLazyLoading');
  exact(model.displayLabel, ARTEMIS_IV_STARSHIP_LABEL, 'displayLabel');
  exact(model.providerStatusLabel, ARTEMIS_IV_PROVIDER_LABEL, 'providerStatusLabel');
  exact(model.isAccurateHlsModel, false, 'isAccurateHlsModel');
  const transform = model.runtimeTransform as Record<string, unknown> | null;
  if (!transform) invalidManifest('runtimeTransform is required');

  const checkedModel: ArtemisIvStarshipManifestModel = Object.freeze({
    assetId: 'martiandays-starship-2019-concept',
    missionRole: 'hls-visual-stand-in',
    publicUrl: ARTEMIS_IV_STARSHIP_PUBLIC_URL,
    sha256: ARTEMIS_IV_STARSHIP_SHA256,
    byteLength: ARTEMIS_IV_STARSHIP_BYTE_LENGTH,
    contentPolicy: 'unaltered',
    runtimeTransform: Object.freeze({
      scale: checkedTuple(transform.scale, [0.01, 0.01, 0.01] as const, 'runtimeTransform.scale'),
      position: checkedTuple(
        transform.position,
        [-2.9751872432370874e-7, 26.465836469188208, 0.19693045634239867] as const,
        'runtimeTransform.position',
      ),
      rotationQuaternion: checkedTuple(
        transform.rotationQuaternion, [0, 0, 0, 1] as const, 'runtimeTransform.rotationQuaternion',
      ),
    }),
    textureDimensions: checkedTuple(model.textureDimensions, [4096, 4096] as const, 'textureDimensions'),
    estimatedTextureGpuBytesWithMipmaps: ARTEMIS_IV_STARSHIP_TEXTURE_ESTIMATE_BYTES,
    requiresLazyLoading: true,
    displayLabel: ARTEMIS_IV_STARSHIP_LABEL,
    providerStatusLabel: ARTEMIS_IV_PROVIDER_LABEL,
    isAccurateHlsModel: false,
  });
  return Object.freeze({
    schemaVersion: 1,
    missionId: 'artemis-iv',
    releaseBudgets: Object.freeze({
      requiredQualityTier: 'high',
      missionCraftTransferBytes: ARTEMIS_IV_TRANSFER_CAP_BYTES,
      combinedSceneGpuBytes: ARTEMIS_IV_COMBINED_SCENE_GPU_CAP_BYTES,
    }),
    model: checkedModel,
  });
}

export const CHECKED_ARTEMIS_IV_ASSET_MANIFEST = checkArtemisIvAssetManifest(missionManifestJson);

export const ARTEMIS_IV_PREFLIGHT_ACTIONS = Object.freeze([
  Object.freeze({ id: 'open-first-light' as const, label: 'OPEN FIRST LIGHT' as const }),
  Object.freeze({ id: 'retry' as const, label: 'RETRY' as const }),
  Object.freeze({ id: 'exit' as const, label: 'EXIT' as const }),
]);

export interface ArtemisIvRendererResourceLedger {
  /** Must include the active body and all renderer-only scene resources. */
  totalRendererBytes(): number;
  charge(entry: Readonly<ArtemisIvAssetResourceAccounting>): void;
  release(assetId: ArtemisIvStarshipManifestModel['assetId']): void;
}

/** Conservative live renderer base used before and after mission body preparation. */
export function artemisIvHighTierRendererBaseBytes(input: Readonly<{
  residentPackGpuBytes: number;
  drawingBufferBytes: number;
}>): number {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Artemis IV ${name} ${value}`);
  }
  const requiredTier = CHECKED_ARTEMIS_IV_ASSET_MANIFEST.releaseBudgets.requiredQualityTier;
  // The tier budget already includes the resident flight pack and the
  // renderer's terrain/effect allocations. Count the larger authority once.
  const activeBodyBytes = Math.max(
    input.residentPackGpuBytes,
    DEFAULT_ACTIVE_BODY_BUDGET[requiredTier],
  );
  const total = activeBodyBytes + input.drawingBufferBytes;
  if (!Number.isSafeInteger(total)) throw new Error('Artemis IV renderer base exceeds safe integer range');
  return total;
}

export type ArtemisIvPreparedSceneBudgetDecision = Readonly<{
  ok: true;
  currentRendererBytes: number;
  combinedSceneGpuCapBytes: number;
  headroomBytes: number;
}> | Readonly<{
  ok: false;
  code: 'combined-scene-budget';
  reason: string;
  currentRendererBytes: number;
  combinedSceneGpuCapBytes: number;
  overBudgetBytes: number;
  actions: typeof ARTEMIS_IV_PREFLIGHT_ACTIONS;
}>;

/** Re-check after terrain/body preparation, when the ledger's live base may have changed. */
export function recheckArtemisIvPreparedSceneBudget(
  ledger: Pick<ArtemisIvRendererResourceLedger, 'totalRendererBytes'>,
): ArtemisIvPreparedSceneBudgetDecision {
  const currentRendererBytes = ledger.totalRendererBytes();
  if (!Number.isSafeInteger(currentRendererBytes) || currentRendererBytes < 0) {
    throw new Error(`Invalid renderer-ledger total ${currentRendererBytes}`);
  }
  const combinedSceneGpuCapBytes = CHECKED_ARTEMIS_IV_ASSET_MANIFEST.releaseBudgets.combinedSceneGpuBytes;
  if (currentRendererBytes > combinedSceneGpuCapBytes) {
    return Object.freeze({
      ok: false,
      code: 'combined-scene-budget',
      reason: 'The prepared Artemis IV craft, terrain, and renderer exceed the certified High-quality scene budget.',
      currentRendererBytes,
      combinedSceneGpuCapBytes,
      overBudgetBytes: currentRendererBytes - combinedSceneGpuCapBytes,
      actions: ARTEMIS_IV_PREFLIGHT_ACTIONS,
    });
  }
  return Object.freeze({
    ok: true,
    currentRendererBytes,
    combinedSceneGpuCapBytes,
    headroomBytes: combinedSceneGpuCapBytes - currentRendererBytes,
  });
}

export type ArtemisIvPreflightDecision = Readonly<{
  ok: true; requiredTier: 'high'; switchToTier: 'high'; switchRequired: boolean;
  restoreTierOnExit: QualityTier; combinedSceneGpuCapBytes: number;
  currentRendererBytes: number; estimatedStarshipBytes: number; estimatedCombinedRendererBytes: number;
}> | Readonly<{
  ok: false; code: 'high-tier-unavailable' | 'texture-size-unsupported' | 'combined-scene-budget';
  reason: string; requiredTier: 'high'; restoreTierOnExit: QualityTier;
  actions: typeof ARTEMIS_IV_PREFLIGHT_ACTIONS;
}>;

export function preflightArtemisIvAssets(input: Readonly<{
  currentTier: QualityTier;
  supportsHighTier: boolean;
  caps: Pick<RenderCaps, 'backend' | 'maxTextureSize'>;
  ledger: Pick<ArtemisIvRendererResourceLedger, 'totalRendererBytes'>;
}>): ArtemisIvPreflightDecision {
  const manifest = CHECKED_ARTEMIS_IV_ASSET_MANIFEST;
  const failure = (
    code: 'high-tier-unavailable' | 'texture-size-unsupported' | 'combined-scene-budget',
    reason: string,
  ): ArtemisIvPreflightDecision => Object.freeze({
    ok: false, code, reason, requiredTier: 'high', restoreTierOnExit: input.currentTier,
    actions: ARTEMIS_IV_PREFLIGHT_ACTIONS,
  });
  if (!input.supportsHighTier) {
    return failure('high-tier-unavailable',
      'The unchanged 2019 Starship concept requires High quality, which is unavailable on this device.');
  }
  if (input.caps.backend !== 'webgl2' || input.caps.maxTextureSize < STARSHIP_TEXTURE_EDGE) {
    return failure('texture-size-unsupported',
      'The unchanged 2019 Starship concept requires support for its original 4096 px textures.');
  }
  const currentRendererBytes = input.ledger.totalRendererBytes();
  if (!Number.isSafeInteger(currentRendererBytes) || currentRendererBytes < 0) {
    throw new Error(`Invalid renderer-ledger total ${currentRendererBytes}`);
  }
  const estimatedStarshipBytes = manifest.model.estimatedTextureGpuBytesWithMipmaps;
  const estimatedCombinedRendererBytes = currentRendererBytes + estimatedStarshipBytes;
  if (estimatedCombinedRendererBytes > manifest.releaseBudgets.combinedSceneGpuBytes) {
    return failure('combined-scene-budget',
      'Loading the unchanged 2019 Starship concept would exceed the certified High-quality scene budget.');
  }
  return Object.freeze({
    ok: true, requiredTier: 'high', switchToTier: 'high',
    switchRequired: input.currentTier !== 'high', restoreTierOnExit: input.currentTier,
    combinedSceneGpuCapBytes: manifest.releaseBudgets.combinedSceneGpuBytes,
    currentRendererBytes, estimatedStarshipBytes, estimatedCombinedRendererBytes,
  });
}

export interface ArtemisIvAssetResourceAccounting {
  readonly assetId: ArtemisIvStarshipManifestModel['assetId']; readonly transferBytes: number;
  readonly geometryBytes: number; readonly materialBytes: number; readonly textureBytes: number;
  readonly gpuBytes: number; readonly geometryCount: number; readonly materialCount: number;
  readonly textureCount: number; readonly drawCallCount: number; readonly triangleCount: number;
}

interface MeasuredResources {
  readonly accounting: Readonly<ArtemisIvAssetResourceAccounting>;
  readonly geometries: ReadonlySet<THREE.BufferGeometry>;
  readonly materials: ReadonlySet<THREE.Material>;
  readonly textures: ReadonlySet<THREE.Texture>;
}

function bytesPerTexel(texture: THREE.Texture): number {
  if (texture.type === THREE.UnsignedShort4444Type || texture.type === THREE.UnsignedShort5551Type) return 2;
  if (texture.type === THREE.UnsignedInt248Type) return 4;
  const componentBytes = texture.type === THREE.FloatType || texture.type === THREE.IntType
    || texture.type === THREE.UnsignedIntType ? 4
    : texture.type === THREE.HalfFloatType || texture.type === THREE.ShortType
      || texture.type === THREE.UnsignedShortType ? 2 : 1;
  const channels = texture.format === THREE.RedFormat || texture.format === THREE.AlphaFormat
    || texture.format === THREE.DepthFormat ? 1
    : texture.format === THREE.RGFormat || texture.format === THREE.DepthStencilFormat ? 2 : 4;
  return componentBytes * channels;
}

function textureByteLength(texture: THREE.Texture): number {
  const image = texture.image as { width?: unknown; height?: unknown } | undefined;
  const width = Number(image?.width);
  const height = Number(image?.height);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error(`Cannot measure texture ${texture.name || texture.uuid}: missing dimensions`);
  }
  return fullMipChainBytes({ width, height, bytesPerPixel: bytesPerTexel(texture) });
}

function materialTextures(material: THREE.Material): THREE.Texture[] {
  const textures = new Set<THREE.Texture>();
  for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
  return [...textures];
}

export function measureArtemisIvModelResources(scene: THREE.Object3D, transferBytes: number): MeasuredResources {
  if (!Number.isSafeInteger(transferBytes) || transferBytes < 0) {
    throw new Error(`Invalid Artemis IV transfer byte count ${transferBytes}`);
  }
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  let drawCallCount = 0;
  let triangleCount = 0;
  scene.traverse((object) => {
    const mesh = object as Partial<THREE.Mesh>;
    if (!(mesh.geometry instanceof THREE.BufferGeometry)) return;
    geometries.add(mesh.geometry);
    triangleCount += Math.floor((mesh.geometry.getIndex()?.count
      ?? mesh.geometry.getAttribute('position')?.count ?? 0) / 3);
    const entries = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    drawCallCount += Math.max(1, mesh.geometry.groups.length || entries.length);
    for (const material of entries) {
      materials.add(material);
      for (const texture of materialTextures(material)) textures.add(texture);
    }
  });
  let geometryBytes = 0;
  for (const geometry of geometries) geometryBytes += geometryByteLength(geometry);
  let textureBytes = 0;
  for (const texture of textures) textureBytes += textureByteLength(texture);
  const materialBytes = materials.size * MATERIAL_GPU_ESTIMATE_BYTES;
  return {
    geometries, materials, textures,
    accounting: Object.freeze({
      assetId: 'martiandays-starship-2019-concept', transferBytes, geometryBytes, materialBytes, textureBytes,
      gpuBytes: geometryBytes + materialBytes + textureBytes,
      geometryCount: geometries.size, materialCount: materials.size, textureCount: textures.size,
      drawCallCount, triangleCount,
    }),
  };
}

function releaseResources(resources: MeasuredResources): void {
  for (const geometry of resources.geometries) geometry.dispose();
  for (const material of resources.materials) material.dispose();
  for (const texture of resources.textures) texture.dispose();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class ArtemisIvAssetLoadError extends Error {
  readonly actions = ARTEMIS_IV_PREFLIGHT_ACTIONS;

  constructor(
    readonly code: 'request-failed' | 'byte-length-mismatch' | 'checksum-mismatch' | 'parse-failed'
      | 'combined-scene-budget' | 'ledger-charge-failed' | 'loader-disposed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ArtemisIvAssetLoadError';
  }
}

export interface LoadedArtemisIvStarship {
  /** External transform root; the parsed GLB scene itself is not rewritten. */
  readonly object: THREE.Group; readonly accounting: Readonly<ArtemisIvAssetResourceAccounting>;
  readonly displayLabel: typeof ARTEMIS_IV_STARSHIP_LABEL;
  readonly providerStatusLabel: typeof ARTEMIS_IV_PROVIDER_LABEL; readonly isAccurateHlsModel: false;
}

export interface ArtemisIvAssetLoader {
  loadStarship(): Promise<Readonly<LoadedArtemisIvStarship>>;
  dispose(): void;
}

export interface ArtemisIvAssetLoaderOptions {
  readonly backend: PartModelBackend;
  readonly ledger: ArtemisIvRendererResourceLedger;
}

class LazyArtemisIvAssetLoader implements ArtemisIvAssetLoader {
  private readonly manifest = CHECKED_ARTEMIS_IV_ASSET_MANIFEST;
  private pending: Promise<Readonly<LoadedArtemisIvStarship>> | null = null;
  private loaded: Readonly<LoadedArtemisIvStarship> | null = null;
  private resources: MeasuredResources | null = null;
  private charged = false;
  private disposed = false;

  constructor(private readonly options: ArtemisIvAssetLoaderOptions) {}

  loadStarship(): Promise<Readonly<LoadedArtemisIvStarship>> {
    if (this.disposed) return Promise.reject(new ArtemisIvAssetLoadError(
      'loader-disposed', 'The Artemis IV visual loader is closed. Exit or retry from the mission menu.',
    ));
    if (this.loaded) return Promise.resolve(this.loaded);
    if (this.pending) return this.pending;
    const request = this.load();
    this.pending = request;
    void request.catch(() => { if (this.pending === request) this.pending = null; });
    return request;
  }

  private async load(): Promise<Readonly<LoadedArtemisIvStarship>> {
    const model = this.manifest.model;
    let bytes: Uint8Array;
    try {
      bytes = await this.options.backend.fetchBytes(model.publicUrl);
    } catch (cause) {
      throw new ArtemisIvAssetLoadError(
        'request-failed', 'The unchanged 2019 Starship concept could not be loaded. Retry or open First Light.', { cause },
      );
    }
    if (bytes.byteLength !== model.byteLength
      || bytes.byteLength > this.manifest.releaseBudgets.missionCraftTransferBytes) {
      throw new ArtemisIvAssetLoadError(
        'byte-length-mismatch', `The Starship stand-in failed its exact byte-length check (${bytes.byteLength}).`,
      );
    }
    if (await sha256Hex(bytes) !== model.sha256) throw new ArtemisIvAssetLoadError(
      'checksum-mismatch', 'The Starship stand-in failed its exact checksum check and was not displayed.',
    );
    let scene: THREE.Object3D;
    try {
      scene = await this.options.backend.parse(bytes);
    } catch (cause) {
      throw new ArtemisIvAssetLoadError(
        'parse-failed', 'The unchanged 2019 Starship concept could not be prepared for display.', { cause },
      );
    }

    let resources: MeasuredResources | null = null;
    try {
      resources = measureArtemisIvModelResources(scene, bytes.byteLength);
      if (this.disposed) throw new ArtemisIvAssetLoadError(
        'loader-disposed', 'The Artemis IV visual loader was closed while the stand-in was loading.',
      );
      const currentBytes = this.options.ledger.totalRendererBytes();
      if (!Number.isSafeInteger(currentBytes) || currentBytes < 0) throw new ArtemisIvAssetLoadError(
        'ledger-charge-failed', `The renderer reported an invalid resource total (${currentBytes}).`,
      );
      if (currentBytes + resources.accounting.gpuBytes > this.manifest.releaseBudgets.combinedSceneGpuBytes) {
        throw new ArtemisIvAssetLoadError(
          'combined-scene-budget', 'The measured Starship visual would exceed the certified High-quality scene budget.',
        );
      }
      try {
        this.options.ledger.charge(resources.accounting);
        this.charged = true;
        if (this.options.ledger.totalRendererBytes() > this.manifest.releaseBudgets.combinedSceneGpuBytes) {
          throw new Error('renderer total crossed the combined-scene ceiling');
        }
      } catch (cause) {
        if (this.charged) this.options.ledger.release(model.assetId);
        this.charged = false;
        throw new ArtemisIvAssetLoadError(
          'ledger-charge-failed', 'The measured Starship visual could not be reserved in the renderer resource ledger.',
          { cause },
        );
      }

      const object = new THREE.Group();
      object.name = 'artemis-iv:starship-2019-stand-in';
      object.scale.fromArray(model.runtimeTransform.scale);
      object.position.fromArray(model.runtimeTransform.position);
      object.quaternion.fromArray(model.runtimeTransform.rotationQuaternion);
      object.add(scene);
      this.resources = resources;
      this.loaded = Object.freeze({
        object, accounting: resources.accounting,
        displayLabel: model.displayLabel, providerStatusLabel: model.providerStatusLabel,
        isAccurateHlsModel: false,
      });
      return this.loaded;
    } catch (error) {
      if (resources) releaseResources(resources);
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loaded?.object.clear();
    if (this.resources) releaseResources(this.resources);
    this.resources = null;
    this.loaded = null;
    if (this.charged) this.options.ledger.release(this.manifest.model.assetId);
    this.charged = false;
    this.options.backend.dispose();
  }
}

export function createArtemisIvAssetLoader(options: ArtemisIvAssetLoaderOptions): ArtemisIvAssetLoader {
  return new LazyArtemisIvAssetLoader(options);
}

export function createBrowserArtemisIvAssetLoader(
  renderer: THREE.WebGLRenderer,
  options: Readonly<{
    ledger: ArtemisIvRendererResourceLedger;
    transcoderPath: string;
    ktx2?: KTX2Loader;
  }>,
): ArtemisIvAssetLoader {
  if (!options.transcoderPath.endsWith('/')) throw new Error('KTX2 transcoder path must end with /');
  const ownsKtx2 = options.ktx2 === undefined;
  const ktx2 = (options.ktx2 ?? new KTX2Loader())
    .setTranscoderPath(options.transcoderPath).detectSupport(renderer);
  const gltf = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  const backend: PartModelBackend = {
    async fetchBytes(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Mission model request failed (${response.status}) for ${url}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async parse(bytes) {
      const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer as ArrayBuffer : bytes.slice().buffer;
      return (await gltf.parseAsync(buffer, '')).scene;
    },
    dispose() { if (ownsKtx2) ktx2.dispose(); },
  };
  return createArtemisIvAssetLoader({ backend, ledger: options.ledger });
}
