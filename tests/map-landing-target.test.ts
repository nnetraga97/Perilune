import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE } from '../src/missions/artemisIv/checkpoints';
import {
  MapView,
  mapLandingTargetDirection,
  mapLandingTargetEllipseDirections,
  type MapLandingTarget,
} from '../src/ui/mapView';

const target: MapLandingTarget = ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE;
const moonRadiusMeters = 1_737_400;

function localOffsetMeters(direction: THREE.Vector3, center: THREE.Vector3): THREE.Vector3 {
  const dot = THREE.MathUtils.clamp(center.dot(direction), -1, 1);
  const arcLength = Math.acos(dot) * moonRadiusMeters;
  return direction.clone().addScaledVector(center, -dot).normalize().multiplyScalar(arcLength);
}

describe('map landing target presentation', () => {
  it('preserves the authored ellipse axes and clockwise-from-north heading', () => {
    const directions = mapLandingTargetEllipseDirections(target, moonRadiusMeters);
    const centerDirection = mapLandingTargetDirection(target);
    const center = new THREE.Vector3(centerDirection.x, centerDirection.y, centerDirection.z);
    const longitude = target.longitudeDegrees * Math.PI / 180;
    const east = new THREE.Vector3(-Math.sin(longitude), Math.cos(longitude), 0);
    const north = center.clone().cross(east).normalize();
    const heading = target.ellipse.headingDegrees * Math.PI / 180;
    const major = north.clone().multiplyScalar(Math.cos(heading)).addScaledVector(east, Math.sin(heading));
    const minor = north.clone().multiplyScalar(-Math.sin(heading)).addScaledVector(east, Math.cos(heading));

    expect(directions).toHaveLength(65);
    for (const direction of directions) expect(direction.length()).toBeCloseTo(1, 12);
    expect(directions[0].distanceTo(directions.at(-1)!)).toBeLessThan(1e-12);

    const majorPoint = new THREE.Vector3(directions[0].x, directions[0].y, directions[0].z);
    const minorPoint = new THREE.Vector3(directions[16].x, directions[16].y, directions[16].z);
    const majorOffset = localOffsetMeters(majorPoint, center);
    const minorOffset = localOffsetMeters(minorPoint, center);
    expect(majorOffset.dot(major)).toBeCloseTo(target.ellipse.semiMajorMeters, 5);
    expect(majorOffset.dot(minor)).toBeCloseTo(0, 5);
    expect(minorOffset.dot(major)).toBeCloseTo(0, 5);
    expect(minorOffset.dot(minor)).toBeCloseTo(target.ellipse.semiMinorMeters, 5);
  });

  it('sets and clears one labeled center marker and safe ellipse together', () => {
    const map = Object.create(MapView.prototype) as MapView;
    const marker = new THREE.Object3D();
    const ellipse = new THREE.Object3D();
    marker.visible = false;
    ellipse.visible = false;
    Object.assign(map as unknown as Record<string, unknown>, {
      landingTarget: null,
      landingTargetDirBF: null,
      landingTargetEllipseDirectionsBF: [],
      landingTargetEllipseRadius: NaN,
      landingTargetMarker: marker,
      landingTargetEllipse: ellipse,
    });

    map.setLandingTarget(target);

    expect(map.landingTargetDirBF?.length()).toBeCloseTo(1, 12);
    expect(marker.userData.label).toBe(target.label);
    expect(ellipse.userData.label).toBe(`${target.label} safe ellipse`);

    marker.visible = true;
    ellipse.visible = true;
    map.setLandingTarget(null);

    expect(map.landingTargetDirBF).toBeNull();
    expect(marker.visible).toBe(false);
    expect(ellipse.visible).toBe(false);
    expect(marker.userData.label).toBeUndefined();
    expect(ellipse.userData.label).toBeUndefined();
  });
});
