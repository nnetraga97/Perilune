import { Quat } from '../core/quat';
import { Vec3 } from '../core/vec3';
import type {
  AttitudeSample,
  AttitudeTrackDefinition,
  MissionQuaternion,
  PositionVelocitySample,
  PositionVelocityTrackDefinition,
} from './types';

export interface InterpolatedPositionVelocity {
  readonly position: Vec3;
  readonly velocity: Vec3;
  /** Analytic second derivative of the same Hermite curve. */
  readonly acceleration: Vec3;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function checkedQuaternion(source: MissionQuaternion, label: string): Quat {
  const lengthSquared = source.x * source.x + source.y * source.y + source.z * source.z + source.w * source.w;
  if (!Number.isFinite(lengthSquared) || lengthSquared <= 1e-24) {
    throw new RangeError(`${label} must be a finite, non-zero quaternion`);
  }
  return new Quat(source.x, source.y, source.z, source.w).normalize();
}

/** Shortest-path spherical interpolation without mutating either input. */
export function shortestPathSlerp(
  from: MissionQuaternion,
  to: MissionQuaternion,
  fraction: number,
  out = new Quat(),
): Quat {
  if (!Number.isFinite(fraction)) throw new RangeError('SLERP fraction must be finite');
  const start = checkedQuaternion(from, 'SLERP start');
  const end = checkedQuaternion(to, 'SLERP end');
  out.copy(start);
  return out.slerp(end, clamp01(fraction)).normalize();
}

/**
 * Cubic Hermite interpolation using position and its derivative at each end.
 * The returned velocity is the analytic time derivative of the same curve.
 */
export function interpolateHermite(
  from: PositionVelocitySample,
  to: PositionVelocitySample,
  timeSeconds: number,
  positionOut = new Vec3(),
  velocityOut = new Vec3(),
  accelerationOut = new Vec3(),
): InterpolatedPositionVelocity {
  if (!Number.isFinite(timeSeconds)) throw new RangeError('Hermite evaluation time must be finite');
  const duration = to.timeSeconds - from.timeSeconds;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new RangeError('Hermite sample times must be finite and strictly increasing');
  }

  const u = clamp01((timeSeconds - from.timeSeconds) / duration);
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  const dh00 = (6 * u2 - 6 * u) / duration;
  const dh10 = 3 * u2 - 4 * u + 1;
  const dh01 = (-6 * u2 + 6 * u) / duration;
  const dh11 = 3 * u2 - 2 * u;
  const ddh00 = (12 * u - 6) / (duration * duration);
  const ddh10 = (6 * u - 4) / duration;
  const ddh01 = (-12 * u + 6) / (duration * duration);
  const ddh11 = (6 * u - 2) / duration;

  positionOut.set(
    h00 * from.position.x + h10 * duration * from.velocity.x + h01 * to.position.x + h11 * duration * to.velocity.x,
    h00 * from.position.y + h10 * duration * from.velocity.y + h01 * to.position.y + h11 * duration * to.velocity.y,
    h00 * from.position.z + h10 * duration * from.velocity.z + h01 * to.position.z + h11 * duration * to.velocity.z,
  );
  velocityOut.set(
    dh00 * from.position.x + dh10 * from.velocity.x + dh01 * to.position.x + dh11 * to.velocity.x,
    dh00 * from.position.y + dh10 * from.velocity.y + dh01 * to.position.y + dh11 * to.velocity.y,
    dh00 * from.position.z + dh10 * from.velocity.z + dh01 * to.position.z + dh11 * to.velocity.z,
  );
  accelerationOut.set(
    ddh00 * from.position.x + ddh10 * from.velocity.x + ddh01 * to.position.x + ddh11 * to.velocity.x,
    ddh00 * from.position.y + ddh10 * from.velocity.y + ddh01 * to.position.y + ddh11 * to.velocity.y,
    ddh00 * from.position.z + ddh10 * from.velocity.z + ddh01 * to.position.z + ddh11 * to.velocity.z,
  );
  return { position: positionOut, velocity: velocityOut, acceleration: accelerationOut };
}

function resolvedSampleTime(
  timeSeconds: number,
  firstTime: number,
  lastTime: number,
  extrapolation: 'clamp' | 'loop',
): number {
  if (!Number.isFinite(timeSeconds)) throw new RangeError('Track evaluation time must be finite');
  if (extrapolation === 'clamp') return Math.max(firstTime, Math.min(lastTime, timeSeconds));
  if (timeSeconds >= firstTime && timeSeconds <= lastTime) return timeSeconds;
  const duration = lastTime - firstTime;
  if (!(duration > 0)) throw new RangeError('A looping track needs a positive time span');
  return firstTime + (((timeSeconds - firstTime) % duration) + duration) % duration;
}

function segmentIndex<T extends { readonly timeSeconds: number }>(samples: readonly T[], timeSeconds: number): number {
  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle].timeSeconds <= timeSeconds) low = middle;
    else high = middle;
  }
  return low;
}

export function evaluatePositionVelocityTrack(
  track: PositionVelocityTrackDefinition,
  timeSeconds: number,
  positionOut = new Vec3(),
  velocityOut = new Vec3(),
  accelerationOut = new Vec3(),
): InterpolatedPositionVelocity {
  if (track.samples.length === 0) throw new RangeError(`Track ${track.id} has no samples`);
  if (track.samples.length === 1) {
    const sample = track.samples[0];
    positionOut.set(sample.position.x, sample.position.y, sample.position.z);
    velocityOut.set(sample.velocity.x, sample.velocity.y, sample.velocity.z);
    accelerationOut.set(0, 0, 0);
    return { position: positionOut, velocity: velocityOut, acceleration: accelerationOut };
  }

  const first = track.samples[0];
  const last = track.samples[track.samples.length - 1];
  const resolved = resolvedSampleTime(timeSeconds, first.timeSeconds, last.timeSeconds, track.extrapolation);
  if (resolved === first.timeSeconds) {
    return interpolateHermite(first, track.samples[1], resolved, positionOut, velocityOut, accelerationOut);
  }
  if (resolved === last.timeSeconds) {
    return interpolateHermite(
      track.samples[track.samples.length - 2],
      last,
      resolved,
      positionOut,
      velocityOut,
      accelerationOut,
    );
  }
  const index = segmentIndex(track.samples, resolved);
  return interpolateHermite(
    track.samples[index],
    track.samples[index + 1],
    resolved,
    positionOut,
    velocityOut,
    accelerationOut,
  );
}

export function evaluateAttitudeTrack(
  track: AttitudeTrackDefinition,
  timeSeconds: number,
  out = new Quat(),
): Quat {
  if (track.samples.length === 0) throw new RangeError(`Track ${track.id} has no samples`);
  const first = track.samples[0];
  const last = track.samples[track.samples.length - 1];
  if (track.samples.length === 1) return out.copy(checkedQuaternion(first.attitude, `Track ${track.id}`));

  const resolved = resolvedSampleTime(timeSeconds, first.timeSeconds, last.timeSeconds, track.extrapolation);
  if (resolved === first.timeSeconds) return out.copy(checkedQuaternion(first.attitude, `Track ${track.id}`));
  if (resolved === last.timeSeconds) return out.copy(checkedQuaternion(last.attitude, `Track ${track.id}`));
  const index = segmentIndex(track.samples, resolved);
  const from: AttitudeSample = track.samples[index];
  const to: AttitudeSample = track.samples[index + 1];
  const fraction = (resolved - from.timeSeconds) / (to.timeSeconds - from.timeSeconds);
  return shortestPathSlerp(from.attitude, to.attitude, fraction, out);
}
