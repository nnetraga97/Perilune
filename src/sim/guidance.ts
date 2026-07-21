/**
 * Flight guidance helpers: gravity-turn ascent director.
 *
 * The ascent director produces a target attitude direction each tick:
 * vertical rise, then a shallow-AoA gravity turn that follows the
 * surface-relative velocity vector with a small eastward nudge, then
 * orbital prograde above the sensible atmosphere. Used by the (optional)
 * ascent assist and by the integration test suite.
 */
import { Vec3 } from '../core/vec3';
import type { Body } from './universe';
import type { VesselRuntime } from './flight';
import { surfaceVelocity } from './bodyOrientation';

const _up = new Vec3();
const _vSurf = new Vec3();
const _east = new Vec3();
const _horiz = new Vec3();
const _surfaceVelocity = new Vec3();

export interface AscentCommand {
  /** Target attitude direction, world frame (unit). */
  dir: Vec3;
  /** Phase label for UI. */
  phase: 'liftoff' | 'turn' | 'prograde';
}

const _cmd: AscentCommand = { dir: new Vec3(0, 1, 0), phase: 'liftoff' };

/**
 * Compute the gravity-turn attitude command.
 * @param nudge radians of extra tilt beyond the current flight-path angle
 *              (default 4.5° — keeps AoA small while steadily turning)
 * @param maxTilt cap on tilt from vertical during the turn (rad)
 */
export function ascentGuidance(
  v: VesselRuntime,
  body: Body,
  nudge = 0.08,
  maxTilt = 1.5,
): AscentCommand {
  const r = v.pos.length();
  const alt = r - body.radius;
  _up.copy(v.pos).scale(1 / r);

  // Surface-relative velocity.
  _vSurf.copy(v.vel).sub(surfaceVelocity(body, v.pos, _surfaceVelocity));
  const speed = _vSurf.length();

  const atmoTop = body.def.atmosphere?.height ?? 12_000;
  if (alt > atmoTop * 0.55 && speed > 400) {
    _cmd.dir.copy(v.vel).normalize();
    _cmd.phase = 'prograde';
    return _cmd;
  }

  if (speed < 70) {
    _cmd.dir.copy(_up);
    _cmd.phase = 'liftoff';
    return _cmd;
  }

  // Flight-path decomposition.
  const vVert = Vec3.dot(_vSurf, _up);
  _horiz.copy(_vSurf).addScaled(_up, -vVert);
  const vHoriz = _horiz.length();
  const theta = Math.atan2(vHoriz, Math.max(1, vVert)); // tilt of velocity from vertical

  // Turn plane: existing horizontal velocity if any, else due east.
  if (vHoriz > 8) {
    _east.copy(_horiz).scale(1 / vHoriz);
  } else {
    _east.set(-_up.y, _up.x, 0);
    const n = _east.length();
    if (n < 1e-6) _east.set(1, 0, 0);
    else _east.scale(1 / n);
  }

  const thetaCmd = Math.min(theta + nudge, maxTilt);
  _cmd.dir.set(
    _up.x * Math.cos(thetaCmd) + _east.x * Math.sin(thetaCmd),
    _up.y * Math.cos(thetaCmd) + _east.y * Math.sin(thetaCmd),
    _up.z * Math.cos(thetaCmd) + _east.z * Math.sin(thetaCmd),
  );
  _cmd.phase = 'turn';
  return _cmd;
}

/**
 * Player-facing launch guidance with an altitude-scheduled pitch program.
 * It deliberately makes the gravity turn legible: vertical off the pad,
 * progressively more easterly through the atmosphere, then prograde in space.
 */
export function launchGuidance(v: VesselRuntime, body: Body): AscentCommand {
  const r = v.pos.length();
  const altitude = r - body.radius;
  _up.copy(v.pos).scale(1 / r);
  _vSurf.copy(v.vel).sub(surfaceVelocity(body, v.pos, _surfaceVelocity));
  const speed = _vSurf.length();
  const atmosphereTop = body.def.atmosphere?.height ?? 100_000;

  _horiz.copy(_vSurf).addScaled(_up, -Vec3.dot(_vSurf, _up));
  if (_horiz.lengthSq() > 64) _east.copy(_horiz).normalize();
  else {
    _east.set(-_up.y, _up.x, 0);
    if (_east.lengthSq() < 1e-9) _east.set(1, 0, 0);
    else _east.normalize();
  }

  const progress = Math.max(0, Math.min(1, altitude / atmosphereTop));
  const smooth = progress * progress * (3 - 2 * progress);
  if (altitude >= atmosphereTop && speed > 100) {
    // Hold the local horizon after atmospheric exit. Merely following the
    // still-steep velocity vector wastes the upper stage raising apoapsis;
    // this deliberate pitch-over teaches that orbit comes from sideways speed.
    _cmd.dir.copy(_east);
    _cmd.phase = 'prograde';
    return _cmd;
  }

  const maxTilt = 1.2;
  const tilt = speed < 100 ? 0 : maxTilt * smooth;
  _cmd.dir.set(
    _up.x * Math.cos(tilt) + _east.x * Math.sin(tilt),
    _up.y * Math.cos(tilt) + _east.y * Math.sin(tilt),
    _up.z * Math.cos(tilt) + _east.z * Math.sin(tilt),
  );
  _cmd.phase = tilt < 0.02 ? 'liftoff' : 'turn';
  return _cmd;
}
