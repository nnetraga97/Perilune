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
import { elementsAtTime, periodOf, stateToElements } from '../core/orbit';
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

export interface MoonCourseCorrection {
  /** Small follow-up node that corrects finite-burn departure error. */
  node: ManeuverNode;
  /** Numerically predicted lunar periapsis after the correction. */
  approachAltitude: number;
}

const _r = new Vec3();
const _v = new Vec3();
const _targetR = new Vec3();
const _targetV = new Vec3();
const _lambertV = new Vec3();
const _rHat = new Vec3();
const _nHat = new Vec3();
const _tHat = new Vec3();
const _dv = new Vec3();

function stumpff(z: number): { c: number; s: number } {
  if (z > 1e-6) {
    const root = Math.sqrt(z);
    return {
      c: (1 - Math.cos(root)) / z,
      s: (root - Math.sin(root)) / (root * root * root),
    };
  }
  if (z < -1e-6) {
    const root = Math.sqrt(-z);
    return {
      c: (Math.cosh(root) - 1) / -z,
      s: (Math.sinh(root) - root) / (root * root * root),
    };
  }
  return {
    c: 1 / 2 - z / 24 + z * z / 720,
    s: 1 / 6 - z / 120 + z * z / 5040,
  };
}

/** Zero-revolution Lambert departure velocity for a prograde 3D transfer. */
export function solveLambertDeparture(
  mu: number,
  departurePosition: Readonly<Vec3>,
  arrivalPosition: Readonly<Vec3>,
  timeOfFlight: number,
  progradeNormal: Readonly<Vec3>,
  out: Vec3,
): Vec3 | null {
  const r1 = departurePosition.length();
  const r2 = arrivalPosition.length();
  if (!(mu > 0 && r1 > 0 && r2 > 0 && timeOfFlight > 0)) return null;

  const cosine = Math.max(-1, Math.min(1, Vec3.dot(departurePosition, arrivalPosition) / (r1 * r2)));
  const cross = Vec3.cross(departurePosition, arrivalPosition, new Vec3());
  const sineMagnitude = Math.sqrt(Math.max(0, 1 - cosine * cosine));
  const sine = Vec3.dot(cross, progradeNormal) >= 0 ? sineMagnitude : -sineMagnitude;
  const denominator = 1 - cosine;
  if (denominator < 1e-12 || Math.abs(sine) < 1e-12) return null;
  const a = sine * Math.sqrt((r1 * r2) / denominator);
  if (Math.abs(a) < 1e-9) return null;

  const transferTimeAt = (z: number): { time: number; y: number } | null => {
    const { c, s } = stumpff(z);
    if (!(c > 0)) return null;
    const y = r1 + r2 + a * (z * s - 1) / Math.sqrt(c);
    if (!(y > 0)) return null;
    const x = Math.sqrt(y / c);
    const transferTime = (x * x * x * s + a * Math.sqrt(y)) / Math.sqrt(mu);
    return Number.isFinite(transferTime) ? { time: transferTime, y } : null;
  };

  const target = timeOfFlight;
  let lowerZ: number | null = null;
  let upperZ: number | null = null;
  let previousZ: number | null = null;
  let previousTime = 0;
  const zMin = -4 * Math.PI * Math.PI;
  const zMax = 4 * Math.PI * Math.PI;
  for (let index = 0; index <= 800; index++) {
    const z = zMin + (zMax - zMin) * index / 800;
    const sample = transferTimeAt(z);
    if (!sample) continue;
    if (previousZ !== null && previousTime <= target && sample.time >= target) {
      lowerZ = previousZ;
      upperZ = z;
      break;
    }
    previousZ = z;
    previousTime = sample.time;
  }
  if (lowerZ === null || upperZ === null) return null;

  let lo: number = lowerZ;
  let hi: number = upperZ;
  for (let iteration = 0; iteration < 64; iteration++) {
    const middle: number = (lo + hi) / 2;
    const sample = transferTimeAt(middle);
    if (!sample || sample.time < target) lo = middle;
    else hi = middle;
  }
  const solution = transferTimeAt((lo + hi) / 2);
  if (!solution) return null;
  const f = 1 - solution.y / r1;
  const g = a * Math.sqrt(solution.y / mu);
  if (Math.abs(g) < 1e-9) return null;
  out.set(
    (arrivalPosition.x - f * departurePosition.x) / g,
    (arrivalPosition.y - f * departurePosition.y) / g,
    (arrivalPosition.z - f * departurePosition.z) / g,
  );
  return out.isFinite() ? out : null;
}

function lambertMoonNode(
  universe: Universe,
  from: Body,
  moon: Body,
  reference: ReturnType<typeof stateToElements>,
  burnTime: number,
  transferTime: number,
): ManeuverNode | null {
  elementsAtTime(reference, burnTime, _r, _v);
  universe.localPosition(moon, burnTime + transferTime, _targetR, _targetV);
  Vec3.cross(_r, _v, _nHat).normalize();
  const departureVelocity = solveLambertDeparture(
    from.mu,
    _r,
    _targetR,
    transferTime,
    _nHat,
    _lambertV,
  );
  if (!departureVelocity) return null;
  _rHat.copy(_r).normalize();
  Vec3.cross(_nHat, _rHat, _tHat).normalize();
  _dv.copy(departureVelocity).sub(_v);
  return {
    time: burnTime,
    prograde: Vec3.dot(_dv, _tHat),
    normal: Vec3.dot(_dv, _nHat),
    radial: Vec3.dot(_dv, _rHat),
  };
}

export function refineLambertMoonTransfer(
  universe: Universe,
  from: Body,
  moon: Body,
  reference: ReturnType<typeof stateToElements>,
  time: number,
  parkingPeriod: number,
  nominalTransferTime: number,
  targetAltitude: number,
): { node: ManeuverNode; approachAltitude: number; transferTime: number } | null {
  type LambertCandidate = {
    node: ManeuverNode;
    transferTime: number;
    deltaV: number;
  };
  const earliest = time + 5;
  const latest = time + parkingPeriod;
  let best: LambertCandidate | null = null;
  const alternates: LambertCandidate[] = [];
  const consider = (burnTime: number, transferTime: number): void => {
    const node = lambertMoonNode(universe, from, moon, reference, burnTime, transferTime);
    if (!node) return;
    const deltaV = Math.hypot(node.prograde, node.normal, node.radial);
    if (!Number.isFinite(deltaV) || deltaV <= 0) return;
    const candidate = { node, transferTime, deltaV };
    if (!best || deltaV < best.deltaV) best = candidate;
    alternates.push(candidate);
    if (alternates.length > 96) {
      alternates.sort((a, b) => a.deltaV - b.deltaV);
      alternates.length = 64;
    }
  };

  // A real inclined lunar orbit does not generally share the textbook
  // coplanar Hohmann window. Search the next parking-orbit revolution and a
  // compact family of practical coast times, then refine the cheapest route.
  for (let coastIndex = 0; coastIndex <= 14; coastIndex++) {
    const transferTime = nominalTransferTime * (0.3 + coastIndex * 0.05);
    for (let burnIndex = 0; burnIndex <= 32; burnIndex++) {
      consider(earliest + (latest - earliest) * burnIndex / 32, transferTime);
    }
  }
  if (!best) return null;

  let burnHalfWidth = parkingPeriod / 32;
  let coastHalfWidth = nominalTransferTime * 0.05;
  for (let pass = 0; pass < 4; pass++) {
    const center = best as LambertCandidate;
    for (let coastStep = -3; coastStep <= 3; coastStep++) {
      const transferTime = Math.max(60, center.transferTime + coastHalfWidth * coastStep / 3);
      for (let burnStep = -3; burnStep <= 3; burnStep++) {
        const burnTime = Math.max(
          earliest,
          Math.min(latest, center.node.time + burnHalfWidth * burnStep / 3),
        );
        consider(burnTime, transferTime);
      }
    }
    burnHalfWidth /= 3;
    coastHalfWidth /= 3;
  }

  alternates.sort((a, b) => a.deltaV - b.deltaV);
  let resolved: LambertCandidate | null = null;
  let resolvedApproach: { altitude: number; score: number } | null = null;
  const evaluateApproach = (
    node: ManeuverNode,
    transferTime: number,
  ): { altitude: number; score: number } | null => {
    const postBurn = orbitAfterNode(reference, node);
    const encounter = predictTrajectory(universe, from, postBurn, node.time, transferTime * 1.65).encounter;
    if (!encounter || encounter.bodyId !== moon.id) return null;
    return {
      altitude: encounter.periapsisAltitude,
      score: Math.abs(encounter.periapsisAltitude - targetAltitude),
    };
  };

  // The cheapest Lambert solution is not necessarily the useful lunar
  // approach once the patched-conic encounter is evaluated. Compare a bounded
  // set of the lowest-dV candidates and choose the one closest to the requested
  // periapsis instead of accepting the first Moon encounter, which can be a
  // high flyby that the capture tutorial cannot complete.
  for (const candidate of alternates.slice(0, 32)) {
    const candidateApproach = evaluateApproach(candidate.node, candidate.transferTime);
    if (!candidateApproach) continue;
    if (
      !resolved
      || !resolvedApproach
      || candidateApproach.score < resolvedApproach.score
      || (candidateApproach.score === resolvedApproach.score && candidate.deltaV < resolved.deltaV)
    ) {
      resolved = candidate;
      resolvedApproach = candidateApproach;
    }
  }
  if (!resolved || !resolvedApproach) return null;

  let node = { ...resolved.node };
  let approach = resolvedApproach;
  let componentStep = Math.max(25, resolved.deltaV * 0.025);
  for (let pass = 0; pass < 9 && approach.score > 2_000; pass++) {
    let improved = false;
    for (const component of ['prograde', 'normal', 'radial'] as const) {
      for (const direction of [-1, 1]) {
        const candidateNode = { ...node, [component]: node[component] + direction * componentStep };
        const candidateApproach = evaluateApproach(candidateNode, resolved.transferTime);
        if (candidateApproach && candidateApproach.score < approach.score) {
          node = candidateNode;
          approach = candidateApproach;
          improved = true;
        }
      }
    }
    componentStep *= improved ? 0.65 : 0.5;
  }
  return { node, approachAltitude: approach.altitude, transferTime: resolved.transferTime };
}

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
): { node: ManeuverNode; approachAltitude: number; transferTime: number } | null {
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
  if (best) {
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
    if (best.score <= Math.max(100_000, moon.radius * 0.25)) {
      return { node: best.node, approachAltitude: best.approachAltitude, transferTime };
    }
  }
  return refineLambertMoonTransfer(
    universe,
    from,
    moon,
    reference,
    time,
    parkingPeriod,
    transferTime,
    targetAltitude,
  ) ?? (best ? { node: best.node, approachAltitude: best.approachAltitude, transferTime } : null);
}

/**
 * Plan a bounded post-departure correction from the live Earth-centered state.
 * Long tutorial burns cannot exactly reproduce an impulsive node; this small
 * follow-up burn restores the intended low lunar approach from the achieved
 * trajectory instead of leaving the player on an unreachable high flyby.
 */
export function planMoonCourseCorrection(
  universe: Universe,
  time: number,
  from: Body,
  moon: Body,
  vesselPosition: Readonly<Vec3>,
  vesselVelocity: Readonly<Vec3>,
  targetAltitude = Math.max(50_000, moon.radius * 0.15),
): MoonCourseCorrection | null {
  if (moon.parent !== from) return null;
  const reference = stateToElements(from.mu, vesselPosition, vesselVelocity, time);
  const correctionTime = time + 30;
  const horizon = Math.max(172_800, moon.orbitalPeriod * 0.15);
  type Candidate = MoonCourseCorrection & { score: number; deltaV: number };
  const evaluate = (node: ManeuverNode): Candidate | null => {
    const encounter = predictTrajectory(
      universe,
      from,
      orbitAfterNode(reference, node),
      node.time,
      horizon,
    ).encounter;
    if (!encounter || encounter.bodyId !== moon.id) return null;
    return {
      node,
      approachAltitude: encounter.periapsisAltitude,
      score: Math.abs(encounter.periapsisAltitude - targetAltitude),
      deltaV: Math.hypot(node.prograde, node.normal, node.radial),
    };
  };

  let best = evaluate({ time: correctionTime, prograde: 0, normal: 0, radial: 0 });
  if (!best) return null;
  if (best.approachAltitude >= 30_000 && best.approachAltitude <= 500_000) return null;
  let componentStep = 25;
  for (let pass = 0; pass < 14 && best.score > 5_000; pass++) {
    let improved = false;
    for (const component of ['prograde', 'normal', 'radial'] as const) {
      for (const direction of [-1, 1]) {
        const candidate = evaluate({
          ...best.node,
          [component]: best.node[component] + direction * componentStep,
        });
        if (
          candidate
          && (candidate.score < best.score
            || (candidate.score === best.score && candidate.deltaV < best.deltaV))
        ) {
          best = candidate;
          improved = true;
        }
      }
    }
    componentStep *= improved ? 0.7 : 0.5;
  }
  return best.approachAltitude <= 500_000 ? {
    node: best.node,
    approachAltitude: best.approachAltitude,
  } : null;
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
  const plannedTransferTime = refined?.transferTime ?? tT;
  const plannedWindowTime = refined ? suggestedNode.time : windowTime;
  const plannedTimeToWindow = Math.max(0, plannedWindowTime - time);
  const vesselAngleAtBurn = vesselAngle + n1 * plannedTimeToWindow;
  const plannedPhaseNeeded = refined
    ? norm2pi(angleOf(universe, moon, plannedWindowTime) - vesselAngleAtBurn)
    : phaseNeeded;
  return {
    fromId: from.id,
    targetId: moon.id,
    targetName: moon.name,
    kind: 'moon',
    phaseNow,
    phaseNeeded: plannedPhaseNeeded,
    timeToWindow: plannedTimeToWindow,
    windowTime: plannedWindowTime,
    burnTime: suggestedNode.time,
    transferTime: plannedTransferTime,
    departureDv: Math.hypot(suggestedNode.prograde, suggestedNode.normal, suggestedNode.radial),
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
