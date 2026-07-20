import { describe, expect, it } from 'vitest';
import { Quat } from '../src/core/quat';
import { Vec3 } from '../src/core/vec3';
import { CHECKED_SOL_CONSTANTS } from '../src/generated/checked-sol-constants';
import {
  bodyFixedDirectionToSpherical,
  referenceFrameAngles,
  referenceFrameOrientation,
  sphericalToBodyFixed,
  type BodyReferenceFrameDef,
} from '../src/sim/bodyReferenceFrame';

function checkedFrame(id: 'sun' | 'earth' | 'moon'): BodyReferenceFrameDef {
  return { epoch: 'J2000', ...CHECKED_SOL_CONSTANTS.bodies[id].referenceFrame };
}

describe('checked body reference frames', () => {
  it('places the Earth north pole on the J2000 pole', () => {
    const orientation = referenceFrameOrientation(checkedFrame('earth'), 0, new Quat());
    const north = orientation.rotate(new Vec3(0, 0, 1), new Vec3());
    expect(north.x).toBeCloseTo(0, 12);
    expect(north.y).toBeCloseTo(0, 12);
    expect(north.z).toBeCloseTo(1, 12);
  });

  it('advances the Earth prime meridian at the checked sidereal rate', () => {
    const frame = checkedFrame('earth');
    const start = referenceFrameAngles(frame, 0).primeMeridian;
    const oneDay = referenceFrameAngles(frame, 86_400).primeMeridian;
    expect((oneDay - start) * 180 / Math.PI).toBeCloseTo(360.9856235, 9);
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
