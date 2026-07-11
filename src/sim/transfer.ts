/**
 * Transfer-window planner: Hohmann phase-angle windows for moon transfers
 * (target orbits the vessel's SOI body) and interplanetary transfers
 * (target is a sibling of the vessel's SOI body).
 *
 * Circular–coplanar approximation: windows are computed from the bodies'
 * actual analytic positions but assume near-circular transfer geometry.
 * That is accurate to a few percent for this system's orbits and is
 * plenty for planning; the maneuver planner refines the burn.
 */
import { Vec3 } from '../core/vec3';
import type { Body, Universe } from './universe';

export interface TransferPlan {
  fromId: string;
  targetId: string;
  targetName: string;
  kind: 'moon' | 'interplanetary';
  /** Current phase angle target−vessel (rad, 0..2π). */
  phaseNow: number;
  /** Phase angle at which the transfer should start (rad). */
  phaseNeeded: number;
  /** Seconds from `time` until the next window. */
  timeToWindow: number;
  /** Absolute sim time of the window. */
  windowTime: number;
  /** Coast time on the transfer ellipse (s). */
  transferTime: number;
  /** Departure burn from the parking orbit (m/s). */
  departureDv: number;
  /** Capture burn into a low target orbit, when the target has gravity (m/s). */
  arrivalDv: number;
}

const _r = new Vec3();

function angleOf(universe: Universe, body: Body, t: number): number {
  universe.localPosition(body, t, _r);
  return Math.atan2(_r.y, _r.x);
}

function norm2pi(a: number): number {
  a %= Math.PI * 2;
  return a < 0 ? a + Math.PI * 2 : a;
}

export interface TransferOptions {
  /** Parking-orbit radius around the vessel's SOI body (m). */
  parkRadius: number;
  /**
   * Vessel's current in-plane angle around its SOI body (rad). Needed for
   * moon transfers (the vessel IS the departing object); ignored for
   * interplanetary windows where the planets' phase dominates.
   */
  vesselAngle?: number;
}

/**
 * Plan the next transfer window from a parking orbit around `from` to
 * `target`. Supported: target orbits `from` (moon transfer), or target and
 * `from` share a parent (interplanetary). Returns null otherwise.
 */
export function planTransfer(
  universe: Universe,
  time: number,
  from: Body,
  target: Body,
  opts: TransferOptions,
): TransferPlan | null {
  if (target.parent === from) {
    return planMoonTransfer(universe, time, from, target, opts);
  }
  if (from.parent && target.parent === from.parent && target !== from) {
    return planInterplanetary(universe, time, from, target, opts);
  }
  return null;
}

/** Moon transfer: raise apoapsis from the parking orbit to the moon. */
function planMoonTransfer(
  universe: Universe,
  time: number,
  from: Body,
  moon: Body,
  opts: TransferOptions,
): TransferPlan | null {
  if (!moon.orbit) return null;
  const mu = from.mu;
  const r1 = opts.parkRadius;
  const r2 = moon.orbit.a;
  if (r2 <= r1) return null; // inward moon transfers unsupported (none in system)

  const aT = (r1 + r2) / 2;
  const tT = Math.PI * Math.sqrt((aT * aT * aT) / mu);
  const n1 = Math.sqrt(mu / (r1 * r1 * r1)); // vessel rate
  const n2 = Math.sqrt(mu / (r2 * r2 * r2)); // moon rate (circular approx)

  // Required lead angle of the moon at departure.
  const phaseNeeded = norm2pi(Math.PI - n2 * tT);

  const vesselAngle = opts.vesselAngle ?? 0;
  const moonAngle = angleOf(universe, moon, time);
  const phaseNow = norm2pi(moonAngle - vesselAngle);

  // Phase evolves at n2 − n1 (vessel is faster: phase shrinks).
  const rate = n2 - n1;
  let dPhase = phaseNeeded - phaseNow;
  // Move dPhase into the direction the phase actually evolves.
  if (rate < 0) {
    while (dPhase > 0) dPhase -= Math.PI * 2;
  } else {
    while (dPhase < 0) dPhase += Math.PI * 2;
  }
  const timeToWindow = rate !== 0 ? dPhase / rate : Infinity;

  const vPark = Math.sqrt(mu / r1);
  const vDep = Math.sqrt(mu * (2 / r1 - 1 / aT));
  const departureDv = vDep - vPark;

  // Arrival: capture into a low orbit around the moon.
  const vArrTransfer = Math.sqrt(mu * (2 / r2 - 1 / aT));
  const vMoon = Math.sqrt(mu / r2);
  const vInf = Math.abs(vMoon - vArrTransfer);
  const rCap = moon.radius + Math.max(20_000, moon.radius * 0.15);
  const arrivalDv =
    Math.sqrt(vInf * vInf + (2 * moon.mu) / rCap) - Math.sqrt(moon.mu / rCap);

  return {
    fromId: from.id,
    targetId: moon.id,
    targetName: moon.name,
    kind: 'moon',
    phaseNow,
    phaseNeeded,
    timeToWindow: Math.max(0, timeToWindow),
    windowTime: time + Math.max(0, timeToWindow),
    transferTime: tT,
    departureDv,
    arrivalDv,
  };
}

/** Interplanetary: eject from `from`'s SOI onto a heliocentric Hohmann leg. */
function planInterplanetary(
  universe: Universe,
  time: number,
  from: Body,
  target: Body,
  opts: TransferOptions,
): TransferPlan | null {
  if (!from.orbit || !target.orbit || !from.parent) return null;
  const muSun = from.parent.mu;
  const r1 = from.orbit.a;
  const r2 = target.orbit.a;

  const aT = (r1 + r2) / 2;
  const tT = Math.PI * Math.sqrt((aT * aT * aT) / muSun);
  const n1 = Math.sqrt(muSun / (r1 * r1 * r1));
  const n2 = Math.sqrt(muSun / (r2 * r2 * r2));

  const phaseNeeded = norm2pi(Math.PI - n2 * tT);
  const a1 = angleOf(universe, from, time);
  const a2 = angleOf(universe, target, time);
  const phaseNow = norm2pi(a2 - a1);

  const rate = n2 - n1;
  let dPhase = phaseNeeded - phaseNow;
  if (rate < 0) {
    while (dPhase > 0) dPhase -= Math.PI * 2;
  } else {
    while (dPhase < 0) dPhase += Math.PI * 2;
  }
  const timeToWindow = rate !== 0 ? dPhase / rate : Infinity;

  // Hyperbolic excess for the heliocentric leg.
  const vPlanet = Math.sqrt(muSun / r1);
  const vDepHelio = Math.sqrt(muSun * (2 / r1 - 1 / aT));
  const vInfDep = Math.abs(vDepHelio - vPlanet);
  // Ejection burn from the parking orbit.
  const rp = opts.parkRadius;
  const departureDv =
    Math.sqrt(vInfDep * vInfDep + (2 * from.mu) / rp) - Math.sqrt(from.mu / rp);

  // Arrival capture (skip for airless-info: still estimate a low-orbit capture).
  const vArrHelio = Math.sqrt(muSun * (2 / r2 - 1 / aT));
  const vTarget = Math.sqrt(muSun / r2);
  const vInfArr = Math.abs(vTarget - vArrHelio);
  const rCap = target.radius + Math.max(30_000, target.radius * 0.15);
  const arrivalDv =
    Math.sqrt(vInfArr * vInfArr + (2 * target.mu) / rCap) - Math.sqrt(target.mu / rCap);

  return {
    fromId: from.id,
    targetId: target.id,
    targetName: target.name,
    kind: 'interplanetary',
    phaseNow,
    phaseNeeded,
    timeToWindow: Math.max(0, timeToWindow),
    windowTime: time + Math.max(0, timeToWindow),
    transferTime: tT,
    departureDv,
    arrivalDv,
  };
}

/** All transfer plans available from a parking orbit around `from`. */
export function allTransferPlans(
  universe: Universe,
  time: number,
  from: Body,
  opts: TransferOptions,
): TransferPlan[] {
  const out: TransferPlan[] = [];
  for (const moon of from.children) {
    const p = planTransfer(universe, time, from, moon, opts);
    if (p) out.push(p);
  }
  if (from.parent) {
    for (const sib of from.parent.children) {
      if (sib === from) continue;
      const p = planTransfer(universe, time, from, sib, opts);
      if (p) out.push(p);
    }
  }
  return out;
}
