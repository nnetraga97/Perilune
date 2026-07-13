import * as THREE from 'three';
import type { BodyRendererKind } from '../content/bodyVisuals';

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
  /** Camera velocity in rotating body-fixed meters per wall-clock second. */
  readonly cameraBodyFixedVelocity: VectorCoordinates;
  /** Perspective camera vertical field of view in radians. */
  readonly verticalFovRadians: number;
  /** Physical drawing-buffer height in pixels, including device pixel ratio. */
  readonly drawingBufferHeight: number;
  readonly orientation: QuaternionCoordinates;
  readonly cameraSunDirection: VectorCoordinates;
  readonly bodySunDirection: VectorCoordinates;
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
  /** Renderer-owned surface resource bytes by category. */
  readonly scatterBytes?: number;
  readonly effectBytes?: number;
}

export interface BodyRenderer {
  readonly bodyId: string;
  readonly kind: BodyRendererKind;
  readonly quality: QualityTier;
  readonly root: THREE.Object3D;
  readonly ready: boolean;
  /** Stage borrowed runtime assets before preparation and shader compilation. */
  stageAssets(pack: Readonly<RuntimeBodyAssetPack> | null): void;
  update(frame: Readonly<BodyRenderFrame>): void;
  stats(): Readonly<BodyRendererStats>;
  dispose(): void;
}
