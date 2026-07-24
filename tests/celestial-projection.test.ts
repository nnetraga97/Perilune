import { describe, expect, it } from 'vitest';
import { CHECKED_SOL_CONSTANTS } from '../src/generated/checked-sol-constants';
import {
  angularRadius,
  computeCelestialProjection,
  projectedPixelRadius,
} from '../src/render/celestialProjection';

describe('celestial projection', () => {
  it('computes the physical solar angular diameter from one AU', () => {
    const theta = angularRadius(
      CHECKED_SOL_CONSTANTS.bodies.sun.meanRadiusMeters,
      CHECKED_SOL_CONSTANTS.astronomicalUnitMeters,
    );
    expect(theta * 2 * 180 / Math.PI).toBeCloseTo(0.5329, 3);
  });

  it('uses drawing-buffer pixels and preserves angular size at proxy depth', () => {
    const projection = computeCelestialProjection({
      centerRelative: { x: CHECKED_SOL_CONSTANTS.astronomicalUnitMeters, y: 0, z: 0 },
      bodyRadius: CHECKED_SOL_CONSTANTS.bodies.sun.meanRadiusMeters,
      verticalFovRadians: Math.PI / 3,
      drawingBufferHeight: 2160,
      physicalFarMeters: 6e8,
      preferredProxyDepth: 3e8,
      farField: true,
    });
    expect(projection.visibility).toBe('far-field');
    expect(projection.projectedPixelRadius).toBeCloseTo(
      projectedPixelRadius(projection.angularRadius, Math.PI / 3, 2160),
      10,
    );
    expect(Math.atan(projection.proxyRadius / projection.proxyDepth)).toBeCloseTo(
      projection.angularRadius,
      12,
    );
  });

  it('handles surface and inside-body observers without invalid asin inputs', () => {
    expect(angularRadius(10, 10)).toBe(Math.PI / 2);
    expect(computeCelestialProjection({
      centerRelative: { x: 0, y: 0, z: 0 },
      bodyRadius: 10,
      verticalFovRadians: 1,
      drawingBufferHeight: 100,
      physicalFarMeters: 1000,
      farField: false,
    })).toMatchObject({ visibility: 'inside', projectedPixelRadius: Infinity });
  });

  it('crossfades a physical body to its angular proxy before the far plane', () => {
    const common = {
      bodyRadius: 10,
      verticalFovRadians: 1,
      drawingBufferHeight: 1080,
      physicalFarMeters: 1_000,
      farField: false,
    };
    expect(computeCelestialProjection({ ...common, centerRelative: { x: 810, y: 0, z: 0 } }))
      .toMatchObject({ physicalOpacity: 1, proxyOpacity: 0 });
    const handoff = computeCelestialProjection({ ...common, centerRelative: { x: 935, y: 0, z: 0 } });
    expect(handoff.visibility).toBe('physical');
    expect(handoff.physicalOpacity).toBeGreaterThan(0);
    expect(handoff.physicalOpacity).toBeLessThan(1);
    expect(handoff.proxyOpacity).toBeCloseTo(1 - handoff.physicalOpacity!, 12);
    expect(computeCelestialProjection({ ...common, centerRelative: { x: 1_020, y: 0, z: 0 } }))
      .toMatchObject({ visibility: 'far-field', physicalOpacity: 0, proxyOpacity: 1 });
  });
});
