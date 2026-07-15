import * as THREE from 'three';
import type { QuaternionCoordinates, VectorCoordinates } from '../bodyRenderer';
import type { TerrainVisibilityPredicate } from './terrainSelection';

export type BodyFixedFrustumPlaneKind = 'side' | 'near' | 'far';

export interface BodyFixedFrustumPlane {
  readonly normal: VectorCoordinates;
  readonly constant: number;
  readonly kind: BodyFixedFrustumPlaneKind;
}

const _projectionView = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _inverseOrientation = new THREE.Quaternion();
const _normal = new THREE.Vector3();

/** Convert the finalized camera frustum into a rotating body's fixed frame. */
export function bodyFixedFrustumPlanes(
  camera: THREE.Camera,
  orientation: Readonly<QuaternionCoordinates>,
  cameraRelativeOrigin: Readonly<VectorCoordinates>,
  out: BodyFixedFrustumPlane[] = [],
): readonly BodyFixedFrustumPlane[] {
  camera.updateMatrixWorld(true);
  _projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_projectionView);
  _inverseOrientation.set(
    orientation.x, orientation.y, orientation.z, orientation.w,
  ).invert();
  out.length = 0;
  for (let index = 0; index < _frustum.planes.length; index++) {
    const plane = _frustum.planes[index];
    _normal.copy(plane.normal).applyQuaternion(_inverseOrientation);
    out.push({
      normal: { x: _normal.x, y: _normal.y, z: _normal.z },
      constant: plane.constant
        + plane.normal.x * cameraRelativeOrigin.x
        + plane.normal.y * cameraRelativeOrigin.y
        + plane.normal.z * cameraRelativeOrigin.z,
      kind: index < 4 ? 'side' : index === 4 ? 'far' : 'near',
    });
  }
  return out;
}

/** Stable quantized signature used to reuse selection without retaining scratch planes. */
export function terrainFrustumSignature(planes: readonly BodyFixedFrustumPlane[]): string {
  const quantize = (value: number, scale: number): number => Math.round(value * scale);
  return planes.map((plane) => [
    plane.kind,
    quantize(plane.normal.x, 10_000),
    quantize(plane.normal.y, 10_000),
    quantize(plane.normal.z, 10_000),
  ].join(':')).join('|');
}

/**
 * Conservative selection-time frustum. The pan margin is angular and applies
 * only to side planes; near/far planes receive only the tile's sphere radius.
 */
export function terrainFrustumPredicate(
  planes: readonly BodyFixedFrustumPlane[],
  cameraBodyFixed: Readonly<VectorCoordinates>,
  sideMarginRadians = THREE.MathUtils.degToRad(15),
): TerrainVisibilityPredicate {
  const sideScale = Math.sin(Math.max(0, Math.min(Math.PI / 2, sideMarginRadians)));
  return (tile, bounds) => {
    if (tile.id.depth < 3) return true;
    const distance = Math.hypot(
      bounds.center.x - cameraBodyFixed.x,
      bounds.center.y - cameraBodyFixed.y,
      bounds.center.z - cameraBodyFixed.z,
    );
    for (const plane of planes) {
      const signedDistance = plane.normal.x * bounds.center.x
        + plane.normal.y * bounds.center.y
        + plane.normal.z * bounds.center.z
        + plane.constant;
      const margin = bounds.radius + (plane.kind === 'side' ? distance * sideScale : 0);
      if (signedDistance < -margin) return false;
    }
    return true;
  };
}
