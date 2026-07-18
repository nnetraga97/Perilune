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
import { periodOf, stateToElements } from '../core/orbit';
import { orbitAfterNode, predictTrajectory, type ManeuverNode } from './maneuver';
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
  /** Absolute burn time, phased to the vessel's parking orbit. */
  burnTime: number;
  /** Required parking-orbit position angle for an interplanetary ejection. */
  ejectionAngle?: number;
  /** Coast time on the transfer ellipse (s). */
  transferTime: number;
  /** Departure burn from the parking orbit (m/s). */
  departureDv: number;
  /** Capture burn into a low target orbit, when the target has gravity (m/s). */
  arrivalDv: number;
  /** Node produced for the active vessel. Refined transfers may differ from the textbook estimate. */
  suggestedNode: ManeuverNode;
  /** Predicted target periapsis for a numerically verified moon intercept. */
  approachAltitude?: number;
  accuracy: 'refined-intercept' | 'phase-estimate';
}

const _r = new Vec3();
const _v = new Vec3();

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
  /** Signed parking-orbit direction. Retrograde is -1. */
  parkingOrbitDirection?: 1 | -1;
  /** Live vessel state enables numerical intercept refinement. */
  vesselPosition?: Readonly<Vec3>;
  vesselVelocity?: Readonly<Vec3>;
}

function refineMoonIntercept(
  universe: Universe,
  time: number,
  from: Body,
  moon: Body,
  opts: TransferOptions,
  nominalNode: ManeuverNode,
  transferTime: number,
): { node: ManeuverNode; approachAltitude: number } | null {
  type InterceptCandidate = {
    node: ManeuverNode;
    approachAltitude: number;
    score: number;
  };
  if (!opts.vesselPosition || !opts.vesselVelocity) return null;
  const reference = stateToElements(from.mu, opts.vesselPosition, opts.vesselVelocity, time);
  const parkingPeriod = periodOf(reference);
  if (!Number.isFinite(parkingPeriod) || reference.e >= 1) return null;
  const targetAltitude = Math.max(20_000, moon.radius * 0.15);
  const halfSearch = parkingPeriod * 0.48;
  const earliest = Math.max(time + 5, nominalNode.time - halfSearch);
  const latest = nominalNode.time + halfSearch;
  const horizon = Math.max(transferTime * 1.45, moon.orbitalPeriod * 0.35);

  const evaluate = (burnTime: number): InterceptCandidate | null => {
    const node = { ...nominalNode, time: burnTime };
    const postBurn = orbitAfterNode(reference, node);
    const encounter = predictTrajectory(universe, from, postBurn, burnTime, horizon).encounter;
    if (!encounter || encounter.bodyId !== moon.id) return null;
    return {
      node,
      approachAltitude: encounter.periapsisAltitude,
      score: Math.abs(encounter.periapsisAltitude - targetAltitude),
    };
  };

  let best: InterceptCandidate | null = null;
  let bestIndex = 0;
  const coarseSteps = 24;
  for (let index = 0; index <= coarseSteps; index++) {
    const candidate = evaluate(earliest + (latest - earliest) * index / coarseSteps);
    if (candidate && (!best || candidate.score < best.score)) {
      best = candidate;
      bestIndex = index;
    }
  }
  if (!best) return null;

  let lo = earliest + (latest - earliest) * Math.max(0, bestIndex - 1) / coarseSteps;
  let hi = earliest + (latest - earliest) * Math.min(coarseSteps, bestIndex + 1) / coarseSteps;
  for (let pass = 0; pass < 5; pass++) {
    let passBest: InterceptCandidate | null = null;
    let passIndex = 0;
    for (let index = 0; index <= 6; index++) {
      const candidate = evaluate(lo + (hi - lo) * index / 6);
      if (candidate && (!passBest || candidate.score < passBest.score)) {
        passBest = candidate;
        passIndex = index;
      }
    }
    if (!passBest) break;
    if (passBest.score < best.score) best = passBest;
    const width = (hi - lo) / 6;
    const center = lo + width * passIndex;
    lo = Math.max(earliest, center - width);
    hi = Math.min(latest, center + width);
  }
  return best ? { node: best.node, approachAltitude: best.approachAltitude } : null;
}

function nearestFuturePhaseTime(
  time: number,
  preferredTime: number,
  currentAngle: number,
  targetAngle: number,
  angularRate: number,
): number {
  const delta = targetAngle - currentAngle;
  const turnsAtPreferred = ((preferredTime - time) * angularRate - delta) / (Math.PI * 2);
  const turn = Math.round(turnsAtPreferred);
  let candidate = time + (delta + turn * Math.PI * 2) / angularRate;
  const period = Math.PI * 2 / Math.abs(angularRate);
  if (candidate <= time) candidate += Math.ceil((time - candidate + 1) / period) * period;
  return candidate;
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
  if ((opts.parkingOrbitDirection ?? 1) < 0) return null;
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

  const windowTime = time + Math.max(0, timeToWindow);
  const nominalNode: ManeuverNode = {
    time: windowTime,
    prograde: departureDv,
    normal: 0,
    radial: 0,
  };
  const refined = refineMoonIntercept(universe, time, from, moon, opts, nominalNode, tT);
  const suggestedNode = refined?.node ?? nominalNode;
  return {
    fromId: from.id,
    targetId: moon.id,
    targetName: moon.name,
    kind: 'moon',
    phaseNow,
    phaseNeeded,
    timeToWindow: Math.max(0, timeToWindow),
    windowTime,
    burnTime: suggestedNode.time,
    transferTime: tT,
    departureDv,
    arrivalDv,
    suggestedNode,
    approachAltitude: refined?.approachAltitude,
    accuracy: refined ? 'refined-intercept' : 'phase-estimate',
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

  const windowTime = time + Math.max(0, timeToWindow);
  const direction = opts.parkingOrbitDirection ?? 1;
  universe.localPosition(from, windowTime, _r, _v);
  const planetVelocityAngle = Math.atan2(_v.y, _v.x);
  const desiredAsymptoteAngle = planetVelocityAngle + (r2 > r1 ? 0 : Math.PI);
  const hyperbolicEccentricity = 1 + (rp * vInfDep * vInfDep) / from.mu;
  const asymptoteTrueAnomaly = Math.acos(-1 / hyperbolicEccentricity);
  const ejectionAngle = norm2pi(desiredAsymptoteAngle - direction * asymptoteTrueAnomaly);
  const parkingRate = direction * Math.sqrt(from.mu / (rp * rp * rp));
  const burnTime = opts.vesselAngle === undefined
    ? windowTime
    : nearestFuturePhaseTime(time, windowTime, opts.vesselAngle, ejectionAngle, parkingRate);

  // Arrival capture (skip for airless-info: still estimate a low-orbit capture).
  const vArrHelio = Math.sqrt(muSun * (2 / r2 - 1 / aT));
  const vTarget = Math.sqrt(muSun / r2);
  const vInfArr = Math.abs(vTarget - vArrHelio);
  const rCap = target.radius + Math.max(30_000, target.radius * 0.15);
  const arrivalDv =
    Math.sqrt(vInfArr * vInfArr + (2 * target.mu) / rCap) - Math.sqrt(target.mu / rCap);

  const suggestedNode: ManeuverNode = {
    time: burnTime,
    // The parking-orbit burn always raises local orbital energy. Inward vs.
    // outward heliocentric motion is selected by the ejection point/asymptote,
    // not by reversing the local escape burn.
    prograde: departureDv,
    normal: 0,
    radial: 0,
  };
  return {
    fromId: from.id,
    targetId: target.id,
    targetName: target.name,
    kind: 'interplanetary',
    phaseNow,
    phaseNeeded,
    timeToWindow: Math.max(0, timeToWindow),
    windowTime,
    burnTime,
    ejectionAngle,
    transferTime: tT,
    departureDv,
    arrivalDv,
    suggestedNode,
    accuracy: 'phase-estimate',
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
