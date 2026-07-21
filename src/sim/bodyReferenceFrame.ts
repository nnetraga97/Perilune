import { Quat } from '../core/quat';
import { Vec3 } from '../core/vec3';

export const JULIAN_DAY_SECONDS = 86_400;
export const JULIAN_CENTURY_SECONDS = 36_525 * JULIAN_DAY_SECONDS;

export interface BodyReferenceFrameDef {
  readonly epoch: 'J2000';
  /** Coordinate system shared with the production orbit elements. */
  readonly inertialFrame: 'ecliptic-j2000';
  readonly poleRightAscensionDegrees: number;
  readonly poleRightAscensionRateDegreesPerCentury: number;
  readonly poleDeclinationDegrees: number;
  readonly poleDeclinationRateDegreesPerCentury: number;
  readonly primeMeridianDegrees: number;
  readonly primeMeridianRateDegreesPerDay: number;
  readonly primeMeridianQuadraticDegreesPerCentury2: number;
}

export interface SphericalCoordinates {
  readonly latitudeRadians: number;
  readonly longitudeRadians: number;
  readonly altitudeMeters: number;
}

const DEG = Math.PI / 180;
const _xAxis = new Vec3();
const _yAxis = new Vec3();
const _zAxis = new Vec3();

function quaternionFromBasis(
  xAxis: Readonly<Vec3>,
  yAxis: Readonly<Vec3>,
  zAxis: Readonly<Vec3>,
  out: Quat,
): Quat {
  const m00 = xAxis.x, m01 = yAxis.x, m02 = zAxis.x;
  const m10 = xAxis.y, m11 = yAxis.y, m12 = zAxis.y;
  const m20 = xAxis.z, m21 = yAxis.z, m22 = zAxis.z;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out.set((m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s);
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out.set(0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s);
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out.set((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s);
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out.set((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s);
  }
  return out.normalize();
}

export function referenceFrameAngles(
  frame: Readonly<BodyReferenceFrameDef>,
  secondsSinceJ2000: number,
): { rightAscension: number; declination: number; primeMeridian: number } {
  if (!Number.isFinite(secondsSinceJ2000)) throw new Error('Reference-frame time must be finite');
  const centuries = secondsSinceJ2000 / JULIAN_CENTURY_SECONDS;
  const days = secondsSinceJ2000 / JULIAN_DAY_SECONDS;
  return {
    rightAscension: (
      frame.poleRightAscensionDegrees
      + frame.poleRightAscensionRateDegreesPerCentury * centuries
    ) * DEG,
    declination: (
      frame.poleDeclinationDegrees
      + frame.poleDeclinationRateDegreesPerCentury * centuries
    ) * DEG,
    primeMeridian: (
      frame.primeMeridianDegrees
      + frame.primeMeridianRateDegreesPerDay * days
      + frame.primeMeridianQuadraticDegreesPerCentury2 * centuries * centuries
    ) * DEG,
  };
}

/** IAU body-fixed +X/+Y/+Z basis expressed in the ecliptic J2000 game frame. */
export function referenceFrameOrientation(
  frame: Readonly<BodyReferenceFrameDef>,
  secondsSinceJ2000: number,
  out: Quat,
): Quat {
  const { rightAscension: ra, declination: dec, primeMeridian: w } = referenceFrameAngles(
    frame,
    secondsSinceJ2000,
  );
  const sinRa = Math.sin(ra);
  const cosRa = Math.cos(ra);
  const sinDec = Math.sin(dec);
  const cosDec = Math.cos(dec);
  const sinW = Math.sin(w);
  const cosW = Math.cos(w);

  const x0x = -sinRa;
  const x0y = cosRa;
  const y0x = -cosRa * sinDec;
  const y0y = -sinRa * sinDec;
  const y0z = cosDec;
  _xAxis.set(
    x0x * cosW + y0x * sinW,
    x0y * cosW + y0y * sinW,
    y0z * sinW,
  );
  _yAxis.set(
    -x0x * sinW + y0x * cosW,
    -x0y * sinW + y0y * cosW,
    y0z * cosW,
  );
  _zAxis.set(cosRa * cosDec, sinRa * cosDec, sinDec);
  return quaternionFromBasis(_xAxis, _yAxis, _zAxis, out);
}

export function bodyFixedDirectionToSpherical(
  direction: Readonly<Vec3>,
  radiusMeters: number,
): SphericalCoordinates {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0) || !Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new Error('Spherical conversion requires a non-zero direction and positive radius');
  }
  return Object.freeze({
    latitudeRadians: Math.asin(Math.max(-1, Math.min(1, direction.z / length))),
    longitudeRadians: Math.atan2(direction.y, direction.x),
    altitudeMeters: length - radiusMeters,
  });
}

export function sphericalToBodyFixed(
  latitudeRadians: number,
  longitudeRadians: number,
  altitudeMeters: number,
  radiusMeters: number,
  out: Vec3,
): Vec3 {
  const radius = radiusMeters + altitudeMeters;
  if (!(radius > 0) || ![latitudeRadians, longitudeRadians, altitudeMeters, radiusMeters].every(Number.isFinite)) {
    throw new Error('Invalid spherical body-fixed coordinate');
  }
  const cosLatitude = Math.cos(latitudeRadians);
  return out.set(
    radius * cosLatitude * Math.cos(longitudeRadians),
    radius * cosLatitude * Math.sin(longitudeRadians),
    radius * Math.sin(latitudeRadians),
  );
}
