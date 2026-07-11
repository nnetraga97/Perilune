/** Shared body-fixed ↔ inertial transforms, including axial tilt and spin. */
import { Quat } from '../core/quat';
import { Vec3 } from '../core/vec3';
import type { Body } from './universe';

const _orientation = new Quat();
const _attitude = new Quat();

/**
 * Body-fixed to inertial orientation. Local +Z spin is applied first, then
 * axial tilt about inertial +X.
 */
export function bodyOrientation(body: Body, time: number, out: Quat): Quat {
  const halfTilt = body.def.axialTilt / 2;
  const halfSpin = body.rotationAngle(time) / 2;
  const sx = Math.sin(halfTilt);
  const cx = Math.cos(halfTilt);
  const sz = Math.sin(halfSpin);
  const cz = Math.cos(halfSpin);
  // qTiltX * qSpinZ
  return out.set(sx * cz, -sx * sz, cx * sz, cx * cz).normalize();
}

export function bodyFixedToInertial(
  body: Body,
  time: number,
  value: Readonly<Vec3>,
  out: Vec3,
): Vec3 {
  return bodyOrientation(body, time, _orientation).rotate(value, out);
}

export function inertialToBodyFixed(
  body: Body,
  time: number,
  value: Readonly<Vec3>,
  out: Vec3,
): Vec3 {
  return bodyOrientation(body, time, _orientation).conjugate().rotate(value, out);
}

export function bodyFixedAttitudeToInertial(
  body: Body,
  time: number,
  attitude: Readonly<Quat>,
  out: Quat,
): Quat {
  _attitude.copy(attitude);
  return out.copy(bodyOrientation(body, time, _orientation)).multiply(_attitude).normalize();
}

export function inertialAttitudeToBodyFixed(
  body: Body,
  time: number,
  attitude: Readonly<Quat>,
  out: Quat,
): Quat {
  _attitude.copy(attitude);
  return out
    .copy(bodyOrientation(body, time, _orientation))
    .conjugate()
    .multiply(_attitude)
    .normalize();
}

/** Angular velocity vector in the body's inertial frame. */
export function bodyAngularVelocity(body: Body, out: Vec3): Vec3 {
  if (body.def.rotationPeriod === 0) return out.set(0, 0, 0);
  const magnitude = (Math.PI * 2) / body.def.rotationPeriod;
  return out.set(
    0,
    -Math.sin(body.def.axialTilt) * magnitude,
    Math.cos(body.def.axialTilt) * magnitude,
  );
}

/** Velocity of a body-fixed point at `position` in the inertial frame. */
export function surfaceVelocity(
  body: Body,
  position: Readonly<Vec3>,
  out: Vec3,
): Vec3 {
  bodyAngularVelocity(body, out);
  const wx = out.x;
  const wy = out.y;
  const wz = out.z;
  return out.set(
    wy * position.z - wz * position.y,
    wz * position.x - wx * position.z,
    wx * position.y - wy * position.x,
  );
}
