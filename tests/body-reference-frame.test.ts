import { describe, expect, it } from 'vitest';
import { Quat } from '../src/core/quat';
import { Vec3 } from '../src/core/vec3';
import { CHECKED_SOL_CONSTANTS } from '../src/generated/checked-sol-constants';
import { SOL_SYSTEM } from '../src/content/system';
import {
  bodyFixedDirectionToSpherical,
  referenceFrameAngles,
  referenceFrameOrientation,
  sphericalToBodyFixed,
  type BodyReferenceFrameDef,
} from '../src/sim/bodyReferenceFrame';

function checkedFrame(id: 'sun' | 'mercury' | 'earth' | 'moon' | 'mars'): BodyReferenceFrameDef {
  return { epoch: 'J2000', ...CHECKED_SOL_CONSTANTS.bodies[id].referenceFrame };
}

describe('checked body reference frames', () => {
  it('expresses checked poles in the same ecliptic J2000 frame as the orbits', () => {
    const orientation = referenceFrameOrientation(checkedFrame('earth'), 0, new Quat());
    const north = orientation.rotate(new Vec3(0, 0, 1), new Vec3());
    expect(north.x).toBeCloseTo(0, 12);
    expect(north.y).toBeCloseTo(Math.sin(23.439291111 * Math.PI / 180), 8);
    expect(north.z).toBeCloseTo(Math.cos(23.439291111 * Math.PI / 180), 8);
    expect(checkedFrame('earth').inertialFrame).toBe('ecliptic-j2000');
  });

  it('rotates the complete Earth body-fixed basis, including prime-meridian phase', () => {
    const rawEquatorial: BodyReferenceFrameDef = {
      epoch: 'J2000', inertialFrame: 'ecliptic-j2000',
      poleRightAscensionDegrees: 0, poleRightAscensionRateDegreesPerCentury: -0.641,
      poleDeclinationDegrees: 90, poleDeclinationRateDegreesPerCentury: -0.557,
      primeMeridianDegrees: 190.147, primeMeridianRateDegreesPerDay: 360.9856235,
      primeMeridianQuadraticDegreesPerCentury2: 0,
    };
    const obliquity = 23.439291111 * Math.PI / 180;
    for (const time of [0, 86_400]) {
      const rawOrientation = referenceFrameOrientation(rawEquatorial, time, new Quat());
      const compiledOrientation = referenceFrameOrientation(checkedFrame('earth'), time, new Quat());
      for (const axis of [new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1)]) {
        const equatorial = rawOrientation.rotate(axis, new Vec3());
        const expected = new Vec3(
          equatorial.x,
          Math.cos(obliquity) * equatorial.y + Math.sin(obliquity) * equatorial.z,
          -Math.sin(obliquity) * equatorial.y + Math.cos(obliquity) * equatorial.z,
        );
        const actual = compiledOrientation.rotate(axis, new Vec3());
        expect(actual.distanceTo(expected)).toBeLessThan(1e-9);
      }
    }
  });

  it('preserves the physical pole-to-orbit-normal obliquity', () => {
    for (const [id, expectedDegrees] of [['mercury', 0.034], ['earth', 23.4393], ['moon', 6.68], ['mars', 23.9162]] as const) {
      const def = SOL_SYSTEM.find((body) => body.id === id)!;
      const north = referenceFrameOrientation(def.referenceFrame!, 0, new Quat())
        .rotate(new Vec3(0, 0, 1), new Vec3());
      const orbit = def.orbit!;
      const normal = new Vec3(
        Math.sin(orbit.i) * Math.sin(orbit.raan),
        -Math.sin(orbit.i) * Math.cos(orbit.raan),
        Math.cos(orbit.i),
      );
      const angle = Math.acos(Math.max(-1, Math.min(1, north.dot(normal)))) * 180 / Math.PI;
      expect(angle).toBeCloseTo(expectedDegrees, 1);
      expect(def.axialTilt * 180 / Math.PI).toBeCloseTo(angle, 10);
    }
  });

  it('advances the Earth prime meridian at the checked sidereal rate', () => {
    const frame = checkedFrame('earth');
    const start = referenceFrameAngles(frame, 0).primeMeridian;
    const oneDay = referenceFrameAngles(frame, 86_400).primeMeridian;
    const eclipticRate = (oneDay - start) * 180 / Math.PI;
    expect(eclipticRate).toBeCloseTo(frame.primeMeridianRateDegreesPerDay, 10);
    expect(eclipticRate).toBeCloseTo(360.9856235, 3);
  });

  it('advances the Mars prime meridian at the checked IAU rate', () => {
    const frame = checkedFrame('mars');
    const start = referenceFrameAngles(frame, 0).primeMeridian;
    const oneDay = referenceFrameAngles(frame, 86_400).primeMeridian;
    expect((oneDay - start) * 180 / Math.PI).toBeCloseTo(frame.primeMeridianRateDegreesPerDay, 10);
    // Conversion into the engine's ecliptic frame includes the pole-rate term.
    expect(frame.primeMeridianRateDegreesPerDay).toBeCloseTo(350.891985, 5);
  });

  it('advances the Mercury prime meridian at the pinned IAU rate', () => {
    const frame = checkedFrame('mercury');
    const start = referenceFrameAngles(frame, 0).primeMeridian;
    const oneDay = referenceFrameAngles(frame, 86_400).primeMeridian;
    expect((oneDay - start) * 180 / Math.PI).toBeCloseTo(frame.primeMeridianRateDegreesPerDay, 10);
    expect(frame.primeMeridianRateDegreesPerDay).toBeCloseTo(6.1385134, 6);
  });

  it('round-trips spherical body-fixed coordinates', () => {
    const radius = CHECKED_SOL_CONSTANTS.bodies.earth.meanRadiusMeters;
    const point = sphericalToBodyFixed(0.7, -2.1, 1234, radius, new Vec3());
    const spherical = bodyFixedDirectionToSpherical(point, radius);
    expect(spherical.latitudeRadians).toBeCloseTo(0.7, 12);
    expect(spherical.longitudeRadians).toBeCloseTo(-2.1, 12);
    expect(spherical.altitudeMeters).toBeCloseTo(1234, 6);
  });
});
