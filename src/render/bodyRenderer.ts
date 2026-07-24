import * as THREE from 'three';
import type { BodyRendererKind } from '../content/bodyVisuals';
import type { BodyFixedFrustumPlane } from './terrain/terrainFrustum';
import type { CelestialProjection } from './celestialProjection';

export type QualityTier = 'low' | 'medium' | 'high';

export interface RuntimeBodyAssetPack {
  readonly bodyId: string;
  readonly tier: QualityTier;
  readonly width: number;
  readonly height: number;
  readonly manifestDigest: string;
  readonly gpuBytes: number;
  /** Borrowed textures; the transaction asset owner, not the renderer, disposes them. */
  readonly textures: ReadonlyMap<string, THREE.Texture>;
}

export interface VectorCoordinates { readonly x: number; readonly y: number; readonly z: number }
export interface QuaternionCoordinates extends VectorCoordinates { readonly w: number }

export interface BodyRenderFrame {
  readonly cameraRelativeOrigin: VectorCoordinates;
  readonly cameraBodyFixed: VectorCoordinates;
  /** Camera forward direction in rotating body-fixed coordinates. */
  readonly cameraViewDirectionBodyFixed?: VectorCoordinates;
  /** Finalized camera frustum expressed in rotating body-fixed coordinates. */
  readonly bodyFixedFrustum?: readonly BodyFixedFrustumPlane[];
  /**
   * Active surface focus in rotating body-fixed coordinates. Near-surface
   * fallbacks use this authority instead of assuming the reference radius is
   * the visible ground. Absent for bodies that are not the flight focus.
   */
  readonly surfaceAnchorBodyFixed?: VectorCoordinates;
  /** Camera velocity in rotating body-fixed meters per wall-clock second. */
  readonly cameraBodyFixedVelocity: VectorCoordinates;
  /** Perspective camera vertical field of view in radians. */
  readonly verticalFovRadians: number;
  /** Physical drawing-buffer height in pixels, including device pixel ratio. */
  readonly drawingBufferHeight: number;
  /** Physical drawing-buffer width; optional for synthetic frames that assume 16:9. */
  readonly drawingBufferWidth?: number;
  /** Analytic f64 projection authority, independent of any proxy mesh placement. */
  readonly projection: Readonly<CelestialProjection>;
  readonly orientation: QuaternionCoordinates;
  readonly cameraSunDirection: VectorCoordinates;
  readonly bodySunDirection: VectorCoordinates;
  /** Fraction of the finite solar disk visible after analytic body occultation. */
  readonly solarVisibleFraction: number;
  /** Strongest finite-disk occulter, in camera-centered inertial coordinates. */
  readonly solarOccluder?: {
    readonly direction: VectorCoordinates;
    readonly angularRadius: number;
  };
  readonly time: number;
  /** Wall-clock frame delta; never simulation-warp time. */
  readonly deltaSeconds: number;
  /** True when recent frame time calls for the shortened visual transition. */
  readonly framePressure: boolean;
  readonly altitude: number;
  /** WorldScene grants this only to the current sphere-of-influence body. */
  readonly allowFlightTerrain: boolean;
}

export interface BodyRendererStats {
  readonly chunks: number;
  readonly visible: number;
  readonly terrainActive: boolean;
  readonly exposure: number;
  readonly coverageProgress?: number;
  /** Visual-only instanced scatter, decal, and dust counts (never simulation objects). */
  readonly visualScatter?: number;
  readonly decals?: number;
  readonly dust?: number;
  /** Active canonical physical obstacle proxies and resolved collisions (Phases 6-7). */
  readonly physicalProxies?: number;
  readonly collisions?: number;
  /** Terrain worker scheduling and chunk-install cost (ms) for the perf overlay. */
  readonly terrainScheduleMs?: number;
  readonly terrainInstallMs?: number;
  readonly terrainSelectionMs?: number;
  readonly terrainBalanceMs?: number;
  readonly terrainSelectionReused?: boolean;
  readonly terrainPending?: number;
  readonly terrainTransitions?: number;
  /** Renderer-owned surface resource bytes by category. */
  readonly scatterBytes?: number;
  readonly effectBytes?: number;
  /** Hard byte reservation left for streamed terrain after fixed allocations. */
  readonly terrainAllocationBytes?: number;
  readonly presentationMode?: 'physical' | 'transition' | 'proxy' | 'point';
  readonly angularRadius?: number;
  /** Committed authored pack and renderer-owned auxiliary allocations. */
  readonly assetTier?: QualityTier | 'procedural';
  readonly assetBytes?: number;
  readonly lutBytes?: number;
  readonly cloudHistoryBytes?: number;
  readonly heightCacheBytes?: number;
  readonly shadowBytes?: number;
  /** Scene-linear diagnostic values before tone mapping; solar renderer only. */
  readonly solarRegionLuminance?: Readonly<{ disk: number; corona: number; glare: number }>;
  readonly detailGpuBytes?: number;
  readonly detailPages?: number;
  readonly detailLevel?: number;
  readonly detailState?: 'disabled' | 'resident-parent' | 'requesting' | 'crossfading' | 'ready' | 'failed';
  readonly detailDatasetId?: string;
  readonly detailRequestBytes?: number;
  readonly detailGeneration?: number;
  readonly detailFallbackReason?: string;
  readonly terrainDetailGpuBytes?: number;
  readonly terrainDetailPages?: number;
  readonly terrainDetailLevel?: number;
  readonly terrainDetailState?: 'disabled' | 'resident-parent' | 'requesting' | 'reprojecting' | 'crossfading' | 'ready' | 'failed';
  readonly terrainDetailDatasetId?: string;
  readonly terrainDetailRequestBytes?: number;
  readonly terrainDetailGeneration?: number;
  readonly terrainDetailFallbackReason?: string;
  readonly terrainDetailTileKeys?: readonly string[];
  readonly terrainDetailNormalPages?: number;
  readonly terrainDetailNumericDatasetId?: string;
  readonly terrainDetailNumericDatum?: string;
  readonly terrainDetailHeightMode?: 'resident' | 'shading-only';
  readonly terrainDetailDecodedCpuBytes?: number;
  readonly terrainDetailPersistentBytes?: number;
  readonly terrainDetailRequestCount?: number;
  readonly terrainDetailCacheHits?: Readonly<{ memory: number; persistent: number; network: number }>;
  readonly terrainDetailTimingsMs?: Readonly<{ fetch: number; decode: number; reproject: number; upload: number }>;
  readonly terrainDetailSourceCellMeters?: number;
  readonly terrainDetailHeightRangeMeters?: readonly [number, number];
  readonly detailProxyRequests?: number;
  readonly detailProxyBytes?: number;
  readonly surfaceClassCode?: number;
  readonly surfaceClassSource?: 'regional-or-global-exact' | 'not-applicable';
  /** Stable names of material paths updated by the terrestrial aerial state. */
  readonly aerialConsumers?: readonly string[];
  readonly terrainAuthorityGeneration?: string;
  readonly terrainAuthorityDatasetId?: string;
  readonly terrainAuthorityVersion?: string;
  readonly terrainAuthorityCoverage?: readonly [number, number, number, number];
  readonly terrainAuthorityDatum?: string;
  readonly terrainAuthorityMode?: 'resident-parent' | 'promoted-region';
  readonly terrainAuthorityFallbackReason?: string;
}

export interface BodyRenderer {
  readonly bodyId: string;
  readonly kind: BodyRendererKind;
  readonly quality: QualityTier;
  readonly root: THREE.Object3D;
  readonly ready: boolean;
  /** Frozen numeric authority used by every terrain recipe owned by this renderer. */
  readonly terrainAuthorityGeneration?: string;
  readonly terrainGeneration?: number;
  /** Optional direct-light handle used by the camera-relative shadow policy. */
  readonly shadowLight?: THREE.DirectionalLight;
  /** Stage borrowed runtime assets before preparation and shader compilation. */
  stageAssets(pack: Readonly<RuntimeBodyAssetPack> | null): void;
  update(frame: Readonly<BodyRenderFrame>): void;
  stats(): Readonly<BodyRendererStats>;
  dispose(): void;
}
