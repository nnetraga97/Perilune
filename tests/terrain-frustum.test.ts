import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  bodyFixedFrustumPlanes,
  terrainFrustumPredicate,
  terrainFrustumSignature,
} from '../src/render/terrain/terrainFrustum';

function lookingPlusX(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.3, 1e7);
  camera.position.set(0, 0, 0);
  camera.up.set(0, 0, 1);
  camera.lookAt(1, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

const tile = (depth: number) => ({ id: { depth } }) as never;
const sphere = (x: number, y: number, z: number, radius = 10) => ({
  center: { x, y, z }, radius, angularRadius: 0,
}) as never;

describe('body-fixed terrain frustum', () => {
  it('keeps deep bounds ahead and rejects bounds behind the finalized camera', () => {
    const planes = bodyFixedFrustumPlanes(
      lookingPlusX(),
      { x: 0, y: 0, z: 0, w: 1 },
      { x: 0, y: 0, z: 0 },
    );
    const visible = terrainFrustumPredicate(planes, { x: 0, y: 0, z: 0 }, 0);
    expect(visible(tile(8), sphere(10_000, 0, 0))).toBe(true);
    expect(visible(tile(8), sphere(-10_000, 0, 0))).toBe(false);
  });

  it('retains an angular side margin without expanding near/far planes', () => {
    const camera = lookingPlusX();
    const planes = bodyFixedFrustumPlanes(
      camera, { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 },
    );
    const margin = terrainFrustumPredicate(
      planes, { x: 0, y: 0, z: 0 }, THREE.MathUtils.degToRad(15),
    );
    const noMargin = terrainFrustumPredicate(planes, { x: 0, y: 0, z: 0 }, 0);
    const y = 10_000 * Math.tan(THREE.MathUtils.degToRad(52));
    expect(noMargin(tile(8), sphere(10_000, y, 0))).toBe(false);
    expect(margin(tile(8), sphere(10_000, y, 0))).toBe(true);
    expect(margin(tile(8), sphere(0.1, 0, 0, 0.01))).toBe(false);
  });

  it('never frustum-culls coarse coverage', () => {
    const planes = bodyFixedFrustumPlanes(
      lookingPlusX(),
      { x: 0, y: 0, z: 0, w: 1 },
      { x: 0, y: 0, z: 0 },
    );
    expect(terrainFrustumPredicate(planes, { x: 0, y: 0, z: 0 }, 0)(
      tile(2), sphere(-10_000, 0, 0),
    )).toBe(true);
  });

  it('transforms translated and rotated bodies and produces stable signatures', () => {
    const orientation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1), Math.PI / 2,
    );
    const origin = { x: 100_000, y: 0, z: 0 };
    const planes = bodyFixedFrustumPlanes(lookingPlusX(), orientation, origin);
    const cameraBodyFixed = new THREE.Vector3(-100_000, 0, 0)
      .applyQuaternion(orientation.clone().invert());
    const visible = terrainFrustumPredicate(planes, cameraBodyFixed, 0);
    expect(visible(tile(8), sphere(0, -50_000, 0))).toBe(true);
    expect(visible(tile(8), sphere(0, 250_000, 0))).toBe(false);
    expect(terrainFrustumSignature(planes)).toBe(terrainFrustumSignature(planes.map((plane) => ({
      ...plane,
      normal: { ...plane.normal },
    }))));
    // Camera translation is invalidated by cameraBodyFixed; omitting plane
    // constants keeps body-rotation roundoff from defeating stationary reuse.
    expect(terrainFrustumSignature(planes)).toBe(terrainFrustumSignature(planes.map((plane) => ({
      ...plane,
      constant: plane.constant + 123,
    }))));
  });
});
