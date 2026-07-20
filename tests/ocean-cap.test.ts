import { createLegacyGameState } from './fixtures/legacyGameState';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GameState } from '../src/sim/state';
import { terrainPresentationBand } from '../src/render/terrainPresentation';
import {
  oceanCapAngle,
  oceanCapDirection,
  oceanCapSegments,
} from '../src/render/terrestrial/oceanMaterial';

const veyra = createLegacyGameState().universe.get('veyra');
const RADIUS = veyra.radius;
const ANCHOR = Object.freeze({ x: 0, y: 0, z: 1 });
const EAST = Object.freeze({ x: 1, y: 0, z: 0 });
const NORTH = Object.freeze({ x: 0, y: 1, z: 0 });

function directionVector(gridX: number, gridY: number, angle: number): THREE.Vector3 {
  const direction = oceanCapDirection(ANCHOR, EAST, NORTH, gridX, gridY, angle);
  return new THREE.Vector3(direction.x, direction.y, direction.z);
}

function maximumChordSagMeters(segments: number, altitudeMeters: number): number {
  const angle = oceanCapAngle(RADIUS, altitudeMeters);
  const vertices: THREE.Vector3[] = [];
  for (let y = 0; y <= segments; y++) {
    const gridY = -1 + (2 * y) / segments;
    for (let x = 0; x <= segments; x++) {
      vertices.push(directionVector(-1 + (2 * x) / segments, gridY, angle));
    }
  }
  const origin = new THREE.Vector3();
  const closest = new THREE.Vector3();
  const triangle = new THREE.Triangle();
  let maximumSag = 0;
  const at = (x: number, y: number) => vertices[y * (segments + 1) + x];
  for (let y = 0; y < segments; y++) {
    for (let x = 0; x < segments; x++) {
      const a = at(x, y);
      const b = at(x + 1, y);
      const c = at(x, y + 1);
      const d = at(x + 1, y + 1);
      triangle.set(a, b, c).closestPointToPoint(origin, closest);
      maximumSag = Math.max(maximumSag, RADIUS * (1 - closest.length()));
      triangle.set(b, d, c).closestPointToPoint(origin, closest);
      maximumSag = Math.max(maximumSag, RADIUS * (1 - closest.length()));
    }
  }
  return maximumSag;
}

describe('ocean cap geometry', () => {
  it('covers the complete horizon circle throughout the terrestrial presentation band', () => {
    const visibleAltitude = terrainPresentationBand(veyra).visibleAltitude;
    for (const altitude of [0, 3, 100, 1_000, 5_500, visibleAltitude]) {
      const horizon = Math.acos(RADIUS / (RADIUS + altitude));
      const capAngle = oceanCapAngle(RADIUS, altitude);
      expect(capAngle).toBeGreaterThan(horizon);
      const extent = Math.tan(capAngle);
      for (let bearing = 0; bearing < Math.PI * 2; bearing += Math.PI / 32) {
        // Gnomonic coordinates of a horizon point must remain inside the
        // square, including diagonal bearings and the presentation boundary.
        const radius = Math.tan(horizon) / extent;
        expect(Math.abs(Math.cos(bearing) * radius)).toBeLessThan(1);
        expect(Math.abs(Math.sin(bearing) * radius)).toBeLessThan(1);
      }
    }
  });

  it('produces unit directions at the center, sides, corners, and pole bases', () => {
    for (const anchor of [
      ANCHOR,
      { x: 0, y: 0, z: -1 },
      { x: 1, y: 0, z: 0 },
    ]) {
      const east = Math.abs(anchor.z) > 0.99 ? EAST : { x: 0, y: 1, z: 0 };
      const northVector = new THREE.Vector3(anchor.x, anchor.y, anchor.z)
        .cross(new THREE.Vector3(east.x, east.y, east.z)).normalize();
      const north = { x: northVector.x, y: northVector.y, z: northVector.z };
      for (const [x, y] of [[0, 0], [1, 0], [-1, 0], [1, 1], [-1, -1]]) {
        const direction = oceanCapDirection(anchor, east, north, x, y, 0.4);
        expect(Math.hypot(direction.x, direction.y, direction.z)).toBeCloseTo(1, 12);
      }
    }
  });

  it.each(['low', 'medium', 'high'] as const)(
    'keeps actual %s triangle-chord sag below one metre through low flight',
    (quality) => {
      expect(maximumChordSagMeters(oceanCapSegments(quality), 5_500)).toBeLessThan(1);
    },
  );

  it('uses increasing tessellation without changing the horizon contract', () => {
    expect(oceanCapSegments('low')).toBeLessThan(oceanCapSegments('medium'));
    expect(oceanCapSegments('medium')).toBeLessThan(oceanCapSegments('high'));
    expect(() => oceanCapAngle(0, 10)).toThrow(/radius/i);
  });
});
