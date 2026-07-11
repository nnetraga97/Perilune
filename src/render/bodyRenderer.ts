import * as THREE from 'three';
import type { BodyRendererKind } from '../content/bodyVisuals';

export type QualityTier = 'low' | 'medium' | 'high';

export interface VectorCoordinates { readonly x: number; readonly y: number; readonly z: number }
export interface QuaternionCoordinates extends VectorCoordinates { readonly w: number }

export interface BodyRenderFrame {
  readonly cameraRelativeOrigin: VectorCoordinates;
  readonly cameraBodyFixed: VectorCoordinates;
  readonly orientation: QuaternionCoordinates;
  readonly cameraSunDirection: VectorCoordinates;
  readonly bodySunDirection: VectorCoordinates;
  readonly time: number;
  readonly altitude: number;
  /** WorldScene grants this only to the current sphere-of-influence body. */
  readonly allowFlightTerrain: boolean;
}

export interface BodyRendererStats {
  readonly chunks: number;
  readonly visible: number;
  readonly terrainActive: boolean;
  readonly exposure: number;
}

export interface BodyRenderer {
  readonly bodyId: string;
  readonly kind: BodyRendererKind;
  readonly quality: QualityTier;
  readonly root: THREE.Object3D;
  readonly ready: boolean;
  update(frame: Readonly<BodyRenderFrame>): void;
  stats(): Readonly<BodyRendererStats>;
  dispose(): void;
}
