/**
 * Transfer-window planner: Hohmann phase-angle windows for moon transfers
 * (target orbits the vessel's SOI body) and interplanetary transfers
 * (target is a sibling of the vessel's SOI body).
 *
 * Circular–coplanar estimates seed each search. When a live vessel state is
 * available, lunar and interplanetary routes are refined into patched-conic
 * SOI encounters before being presented as verified intercepts.
 */
import { Vec3 } from '../core/vec3';
import { elementsAtTime, periodOf, stateToElements } from '../core/orbit';
import {
  orbitAfterNode,
  predictTrajectory,
  type EncounterPrediction,
  type ManeuverNode,
} from './maneuver';
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
  /** Capture/circularization burn at the planned target periapsis (m/s). */
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

interface RefinedMoonTransfer {
  node: ManeuverNode;
  approachAltitude: number;
  transferTime: number;
  arrivalDv: number;
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

function captureDeltaV(body: Body, encounter: EncounterPrediction): number {
  const periapsisRadius = body.radius + encounter.periapsisAltitude;
  if (!(periapsisRadius > body.radius) || !Number.isFinite(encounter.elements.a)) return Infinity;
  const periapsisSpeedSquared = body.mu * (2 / periapsisRadius - 1 / encounter.elements.a);
  if (!(periapsisSpeedSquared > 0)) return Infinity;
  return Math.abs(
    Math.sqrt(periapsisSpeedSquared) - Math.sqrt(body.mu / periapsisRadius),
  );
}

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
): RefinedMoonTransfer | null {
  type LambertCandidate = {
    node: ManeuverNode;
    transferTime: number;
    deltaV: number;
  };
  const earliest = time + 5;
  const nearTermLatest = time + parkingPeriod;
  const latest = time + Math.min(
    moon.orbitalPeriod,
    Math.max(parkingPeriod * 48, nominalTransferTime * 2),
  );
  let best: LambertCandidate | null = null;
  const alternates: LambertCandidate[] = [];
  const nearTermAlternates: LambertCandidate[] = [];
  const shortCoastAlternates: LambertCandidate[] = [];
  const consider = (burnTime: number, transferTime: number): void => {
    const node = lambertMoonNode(universe, from, moon, reference, burnTime, transferTime);
    if (!node) return;
    const deltaV = Math.hypot(node.prograde, node.normal, node.radial);
    if (!Number.isFinite(deltaV) || deltaV <= 0) return;
    const candidate = { node, transferTime, deltaV };
    if (!best || deltaV < best.deltaV) best = candidate;
    alternates.push(candidate);
    if (burnTime <= nearTermLatest) nearTermAlternates.push(candidate);
    if (burnTime <= nearTermLatest && transferTime <= nominalTransferTime * 1.001) {
      shortCoastAlternates.push(candidate);
    }
    if (alternates.length > 256) {
      alternates.sort((a, b) => a.deltaV - b.deltaV);
      alternates.length = 192;
    }
  };

  // A real inclined lunar orbit does not generally share the textbook
  // coplanar Hohmann window. Search a broad time-of-flight family and multiple
  // future parking-orbit passes. This is intentionally worker-side and may
  // take longer: minimum total maneuver cost matters more than earliest arrival.
  for (let coastIndex = 0; coastIndex <= 34; coastIndex++) {
    const transferTime = nominalTransferTime * (0.3 + coastIndex * 0.05);
    for (let burnIndex = 0; burnIndex <= 32; burnIndex++) {
      consider(earliest + (nearTermLatest - earliest) * burnIndex / 32, transferTime);
    }
    for (let burnIndex = 0; burnIndex <= 128; burnIndex++) {
      consider(earliest + (latest - earliest) * burnIndex / 128, transferTime);
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
  type MoonApproach = {
    altitude: number;
    score: number;
    arrivalDv: number;
    totalDv: number;
  };
  const evaluateApproach = (
    node: ManeuverNode,
    transferTime: number,
  ): MoonApproach | null => {
    const postBurn = orbitAfterNode(reference, node);
    const encounter = predictTrajectory(universe, from, postBurn, node.time, transferTime * 1.65).encounter;
    if (!encounter || encounter.bodyId !== moon.id) return null;
    const arrivalDv = captureDeltaV(moon, encounter);
    const departureDv = Math.hypot(node.prograde, node.normal, node.radial);
    return {
      altitude: encounter.periapsisAltitude,
      score: Math.abs(encounter.periapsisAltitude - targetAltitude),
      arrivalDv,
      totalDv: departureDv + arrivalDv,
    };
  };

  const maximumUsefulAltitude = Math.max(100_000, Math.min(500_000, moon.radius * 0.5));
  const evaluated: Array<{ candidate: LambertCandidate; approach: MoonApproach }> = [];
  nearTermAlternates.sort((a, b) => a.deltaV - b.deltaV);
  shortCoastAlternates.sort((a, b) => a.deltaV - b.deltaV);
  const candidatesToEvaluate = [
    ...shortCoastAlternates.slice(0, 96),
    ...nearTermAlternates.slice(0, 96),
    ...alternates,
  ];
  for (const candidate of candidatesToEvaluate) {
    const candidateApproach = evaluateApproach(candidate.node, candidate.transferTime);
    if (candidateApproach) evaluated.push({ candidate, approach: candidateApproach });
  }
  if (!evaluated.length) return null;

  const useful = (approach: MoonApproach): boolean =>
    approach.altitude >= 0
    && approach.altitude <= maximumUsefulAltitude
    && Number.isFinite(approach.totalDv);
  const closest = [...evaluated].sort((a, b) =>
    a.approach.score - b.approach.score || a.candidate.deltaV - b.candidate.deltaV,
  );
  const shortCoastSet = new Set(shortCoastAlternates);
  const shortCoastClosest = evaluated.filter((item) => shortCoastSet.has(item.candidate)).sort((a, b) =>
    a.approach.score - b.approach.score || a.candidate.deltaV - b.candidate.deltaV,
  );
  const shortCoastLowCostApproaches = evaluated
    .filter((item) => shortCoastSet.has(item.candidate))
    .sort((a, b) => a.candidate.deltaV - b.candidate.deltaV)
    .slice(0, 64)
    .sort((a, b) => a.approach.score - b.approach.score);
  const globalLowCostApproaches = [...evaluated]
    .sort((a, b) => a.candidate.deltaV - b.candidate.deltaV)
    .slice(0, 96)
    .sort((a, b) => a.approach.score - b.approach.score);
  const cheapestUseful = evaluated.filter((item) => useful(item.approach)).sort((a, b) =>
    a.approach.totalDv - b.approach.totalDv || a.approach.score - b.approach.score,
  );
  const seeds = [...closest.slice(0, 16)];
  for (const seed of shortCoastClosest.slice(0, 16)) {
    if (!seeds.includes(seed)) seeds.push(seed);
  }
  for (const seed of shortCoastLowCostApproaches.slice(0, 32)) {
    if (!seeds.includes(seed)) seeds.push(seed);
  }
  for (const seed of globalLowCostApproaches.slice(0, 32)) {
    if (!seeds.includes(seed)) seeds.push(seed);
  }
  for (const seed of cheapestUseful.slice(0, 16)) {
    if (!seeds.includes(seed)) seeds.push(seed);
  }
  const resolved: Array<{ candidate: LambertCandidate; approach: MoonApproach }> = [];
  const targetingTolerance = Math.max(25_000, targetAltitude * 0.1);
  for (const seed of seeds) {
    let node = { ...seed.candidate.node };
    let approach = seed.approach;
    let componentStep = Math.max(25, seed.candidate.deltaV * 0.025);
    for (let pass = 0; pass < 12; pass++) {
      let passNode = node;
      let passApproach = approach;
      for (const component of ['prograde', 'normal', 'radial'] as const) {
        for (const direction of [-1, 1]) {
          const candidateNode = {
            ...node,
            [component]: node[component] + direction * componentStep,
          };
          const candidateApproach = evaluateApproach(candidateNode, seed.candidate.transferTime);
          if (!candidateApproach) continue;
          const currentUseful = useful(passApproach);
          const candidateUseful = useful(candidateApproach);
          const improves = !currentUseful
            ? candidateUseful || candidateApproach.score < passApproach.score
            : candidateUseful && (
              passApproach.score > targetingTolerance
                ? candidateApproach.score < passApproach.score
                : candidateApproach.score <= targetingTolerance
                  && candidateApproach.totalDv < passApproach.totalDv
            );
          if (improves) {
            passNode = candidateNode;
            passApproach = candidateApproach;
          }
        }
      }
      const improved = passNode !== node;
      node = passNode;
      approach = passApproach;
      componentStep *= improved ? 0.65 : 0.5;
    }
    if (useful(approach)) {
      resolved.push({
        candidate: { ...seed.candidate, node, deltaV: Math.hypot(node.prograde, node.normal, node.radial) },
        approach,
      });
    }
  }
  resolved.sort((a, b) =>
    a.approach.totalDv - b.approach.totalDv || a.approach.score - b.approach.score,
  );
  const bestResolved = resolved[0];
  if (!bestResolved) return null;
  return {
    node: bestResolved.candidate.node,
    approachAltitude: bestResolved.approach.altitude,
    transferTime: bestResolved.candidate.transferTime,
    arrivalDv: bestResolved.approach.arrivalDv,
  };
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
): RefinedMoonTransfer | null {
  type InterceptCandidate = {
    node: ManeuverNode;
    approachAltitude: number;
    score: number;
    arrivalDv: number;
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
    const arrivalDv = captureDeltaV(moon, encounter);
    if (!Number.isFinite(arrivalDv)) return null;
    return {
      node,
      approachAltitude: encounter.periapsisAltitude,
      score: Math.abs(encounter.periapsisAltitude - targetAltitude),
      arrivalDv,
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
  }
  const lambert = refineLambertMoonTransfer(
    universe,
    from,
    moon,
    reference,
    time,
    parkingPeriod,
    transferTime,
    targetAltitude,
  );
  const nominal = best && best.approachAltitude >= 0
    && best.score <= Math.max(500_000, moon.radius * 0.5)
    ? { ...best, transferTime }
    : null;
  if (!lambert) return nominal;
  if (!nominal) return lambert;
  const nominalTotal = Math.hypot(
    nominal.node.prograde,
    nominal.node.normal,
    nominal.node.radial,
  ) + nominal.arrivalDv;
  const lambertTotal = Math.hypot(
    lambert.node.prograde,
    lambert.node.normal,
    lambert.node.radial,
  ) + lambert.arrivalDv;
  return lambertTotal < nominalTotal ? lambert : nominal;
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

interface InterplanetaryCandidate {
  node: ManeuverNode;
  coastTime: number;
  alignmentError: number;
  deltaV: number;
}

interface InterplanetaryApproach {
  distance: number;
  time: number;
  score: number;
  relativeSpeed: number;
}

interface RefinedInterplanetaryTransfer {
  node: ManeuverNode;
  approachAltitude: number;
  transferTime: number;
  arrivalDv: number;
}

/**
 * Convert a heliocentric Lambert departure into a local hyperbolic ejection.
 *
 * The outgoing asymptote and the vessel position define the hyperbola plane.
 * At periapsis the velocity is perpendicular to the radius, so the resulting
 * inertial delta-v can be decomposed exactly into the node's live RTN frame.
 */
function lambertEjectionCandidate(
  universe: Universe,
  from: Body,
  target: Body,
  reference: ReturnType<typeof stateToElements>,
  burnTime: number,
  coastTime: number,
): InterplanetaryCandidate | null {
  const parent = from.parent;
  if (!parent) return null;
  universe.localPosition(from, burnTime, _targetR, _targetV);
  const targetPosition = new Vec3();
  const targetVelocity = new Vec3();
  universe.localPosition(target, burnTime + coastTime, targetPosition, targetVelocity);
  const transferNormal = Vec3.cross(_targetR, _targetV, new Vec3()).normalize();
  const departureVelocity = solveLambertDeparture(
    parent.mu,
    _targetR,
    targetPosition,
    coastTime,
    transferNormal,
    _lambertV,
  );
  if (!departureVelocity) return null;

  const excessVelocity = new Vec3().copy(departureVelocity).sub(_targetV);
  const excessSpeed = excessVelocity.length();
  if (!(excessSpeed > 0) || !Number.isFinite(excessSpeed)) return null;
  const asymptoteDirection = excessVelocity.scale(1 / excessSpeed);

  elementsAtTime(reference, burnTime, _r, _v);
  const radius = _r.length();
  if (!(radius > from.radius)) return null;
  const radial = new Vec3().copy(_r).scale(1 / radius);
  const currentNormal = Vec3.cross(_r, _v, new Vec3()).normalize();
  const currentTransverse = Vec3.cross(currentNormal, radial, new Vec3()).normalize();
  const hyperbolaNormal = Vec3.cross(radial, asymptoteDirection, new Vec3());
  if (hyperbolaNormal.lengthSq() < 1e-12) return null;
  hyperbolaNormal.normalize();
  const departureDirection = Vec3.cross(hyperbolaNormal, radial, new Vec3()).normalize();
  // Reject the opposite, retrograde hyperbola branch. A retrograde parking
  // orbit still works because currentTransverse follows the live orbit plane.
  if (Vec3.dot(departureDirection, currentTransverse) <= 0) return null;

  const eccentricity = 1 + radius * excessSpeed * excessSpeed / from.mu;
  const requiredAsymptoteDot = -1 / eccentricity;
  const alignmentError = Math.abs(Vec3.dot(radial, asymptoteDirection) - requiredAsymptoteDot);
  const departureSpeed = Math.sqrt(excessSpeed * excessSpeed + 2 * from.mu / radius);
  const burn = departureDirection.scale(departureSpeed).sub(_v);
  const node: ManeuverNode = {
    time: burnTime,
    prograde: Vec3.dot(burn, currentTransverse),
    normal: Vec3.dot(burn, currentNormal),
    radial: Vec3.dot(burn, radial),
  };
  const deltaV = Math.hypot(node.prograde, node.normal, node.radial);
  return Number.isFinite(deltaV)
    ? { node, coastTime, alignmentError, deltaV }
    : null;
}

function closestInterplanetaryApproach(
  universe: Universe,
  from: Body,
  target: Body,
  reference: ReturnType<typeof stateToElements>,
  node: ManeuverNode,
  coastTime: number,
  desiredDistance: number,
): InterplanetaryApproach | null {
  const localPrediction = predictTrajectory(
    universe,
    from,
    orbitAfterNode(reference, node),
    node.time,
  );
  if (!localPrediction.escape) return null;

  const craftPosition = new Vec3();
  const craftVelocity = new Vec3();
  const targetPosition = new Vec3();
  const targetVelocity = new Vec3();
  const distanceAt = (sampleTime: number): number => {
    elementsAtTime(localPrediction.escape!.elements, sampleTime, craftPosition, craftVelocity);
    universe.localPosition(target, sampleTime, targetPosition, targetVelocity);
    return craftPosition.distanceTo(targetPosition);
  };

  let lo = node.time + coastTime * 0.8;
  let hi = node.time + coastTime * 1.2;
  for (let pass = 0; pass < 7; pass++) {
    const width = (hi - lo) / 8;
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index <= 8; index++) {
      const distance = distanceAt(lo + width * index);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    const center = lo + width * bestIndex;
    lo = center - width;
    hi = center + width;
  }
  const approachTime = (lo + hi) / 2;
  const distance = distanceAt(approachTime);
  const relativeSpeed = craftVelocity.distanceTo(targetVelocity);
  return {
    distance,
    time: approachTime,
    score: Math.abs(distance - desiredDistance),
    relativeSpeed,
  };
}

function refineInterplanetaryIntercept(
  universe: Universe,
  time: number,
  from: Body,
  target: Body,
  opts: TransferOptions,
  windowTime: number,
  nominalTransferTime: number,
  nominalDepartureDv: number,
  nominalArrivalExcessSpeed: number,
): RefinedInterplanetaryTransfer | null {
  if (!opts.vesselPosition || !opts.vesselVelocity || !from.parent) return null;
  const reference = stateToElements(from.mu, opts.vesselPosition, opts.vesselVelocity, time);
  const parkingPeriod = periodOf(reference);
  if (!Number.isFinite(parkingPeriod) || reference.e >= 1) return null;

  const candidates: InterplanetaryCandidate[] = [];
  const earliest = Math.max(time + 5, windowTime - parkingPeriod / 2);
  const latest = Math.max(earliest + 1, windowTime + parkingPeriod / 2);
  // Lambert supplies the true 3D heliocentric route. The Hohmann duration is
  // only its seed; varying the coast handles eccentric and inclined planets.
  for (let coastIndex = 0; coastIndex <= 30; coastIndex++) {
    const coastTime = nominalTransferTime * (0.5 + coastIndex * 0.05);
    let best: InterplanetaryCandidate | null = null;
    let bestIndex = 0;
    const burnSteps = 64;
    for (let burnIndex = 0; burnIndex <= burnSteps; burnIndex++) {
      const burnTime = earliest + (latest - earliest) * burnIndex / burnSteps;
      const candidate = lambertEjectionCandidate(
        universe,
        from,
        target,
        reference,
        burnTime,
        coastTime,
      );
      if (
        candidate
        && (!best
          || candidate.alignmentError < best.alignmentError
          || (candidate.alignmentError === best.alignmentError && candidate.deltaV < best.deltaV))
      ) {
        best = candidate;
        bestIndex = burnIndex;
      }
    }
    if (!best) continue;
    let refinedBest: InterplanetaryCandidate = best;
    let lo = earliest + (latest - earliest) * Math.max(0, bestIndex - 1) / burnSteps;
    let hi = earliest + (latest - earliest) * Math.min(burnSteps, bestIndex + 1) / burnSteps;
    for (let pass = 0; pass < 5; pass++) {
      let passBest: InterplanetaryCandidate = refinedBest;
      let passIndex = 0;
      for (let index = 0; index <= 8; index++) {
        const candidate = lambertEjectionCandidate(
          universe,
          from,
          target,
          reference,
          lo + (hi - lo) * index / 8,
          coastTime,
        );
        if (
          candidate
          && (candidate.alignmentError < passBest.alignmentError
            || (candidate.alignmentError === passBest.alignmentError && candidate.deltaV < passBest.deltaV))
        ) {
          passBest = candidate;
          passIndex = index;
        }
      }
      refinedBest = passBest;
      const width = (hi - lo) / 8;
      const center = lo + width * passIndex;
      lo = Math.max(earliest, center - width);
      hi = Math.min(latest, center + width);
    }
    candidates.push(refinedBest);
  }
  if (!candidates.length) return null;

  const targetAltitude = Math.max(100_000, target.radius * 0.15);
  const desiredPeriapsisRadius = target.radius + targetAltitude;
  // The heliocentric miss distance is a B-plane impact parameter, not the
  // eventual target-relative periapsis. Account for gravitational focusing so
  // a low Mars/Venus flyby does not get optimized into an impact trajectory.
  const focusing = nominalArrivalExcessSpeed > 0
    ? Math.sqrt(1 + 2 * target.mu /
      (desiredPeriapsisRadius * nominalArrivalExcessSpeed ** 2))
    : 1;
  const desiredDistance = desiredPeriapsisRadius * focusing;
  const practicalDeltaVLimit = Math.max(
    nominalDepartureDv + 5_000,
    nominalDepartureDv * 2.5,
  );
  const evaluated: Array<{
    candidate: InterplanetaryCandidate;
    approach: InterplanetaryApproach;
  }> = [];
  // Alignment is only a cheap seed. Score the best candidates using the
  // actual departure SOI handoff and moving target before selecting one.
  for (const candidate of candidates) {
    if (candidate.deltaV > practicalDeltaVLimit) continue;
    const candidateApproach = closestInterplanetaryApproach(
      universe,
      from,
      target,
      reference,
      candidate.node,
      candidate.coastTime,
      desiredDistance,
    );
    if (candidateApproach) evaluated.push({ candidate, approach: candidateApproach });
  }
  if (!evaluated.length) return null;
  const broadInterceptBand = target.soiRadius * 20;
  const estimatedTotalDv = (item: typeof evaluated[number]): number => {
    const arrivalDv = Math.sqrt(
      item.approach.relativeSpeed ** 2 + 2 * target.mu / desiredPeriapsisRadius,
    ) - Math.sqrt(target.mu / desiredPeriapsisRadius);
    return item.candidate.deltaV + arrivalDv;
  };
  const practicalSeeds = [...evaluated].sort((a, b) => {
    const aNear = a.approach.score <= broadInterceptBand;
    const bNear = b.approach.score <= broadInterceptBand;
    if (aNear !== bNear) return aNear ? -1 : 1;
    return aNear
      ? estimatedTotalDv(a) - estimatedTotalDv(b) || a.approach.score - b.approach.score
      : a.approach.score - b.approach.score || a.candidate.deltaV - b.candidate.deltaV;
  });
  const closestSeeds = [...evaluated].sort((a, b) =>
    a.approach.score - b.approach.score || a.candidate.deltaV - b.candidate.deltaV,
  );
  const cheapestDepartureSeeds = [...evaluated].sort((a, b) =>
    a.candidate.deltaV - b.candidate.deltaV || a.approach.score - b.approach.score,
  );
  const seeds = [...practicalSeeds.slice(0, 4)];
  for (const seed of closestSeeds.slice(0, 2)) {
    if (!seeds.includes(seed)) seeds.push(seed);
  }
  for (const seed of cheapestDepartureSeeds.slice(0, 2)) {
    if (!seeds.includes(seed)) seeds.push(seed);
  }

  const resolved: Array<RefinedInterplanetaryTransfer & { deltaV: number }> = [];
  for (const seed of seeds) {
    let node = { ...seed.candidate.node };
    const coastTime = seed.candidate.coastTime;
    const seedFocusing = seed.approach.relativeSpeed > 0
      ? Math.sqrt(1 + 2 * target.mu /
        (desiredPeriapsisRadius * seed.approach.relativeSpeed ** 2))
      : focusing;
    const seedDesiredDistance = desiredPeriapsisRadius * seedFocusing;
    let approach = {
      ...seed.approach,
      score: Math.abs(seed.approach.distance - seedDesiredDistance),
    };
    const seedDeltaV = Math.hypot(node.prograde, node.normal, node.radial);
    let steps = {
      time: parkingPeriod / 64,
      prograde: Math.max(25, seedDeltaV * 0.008),
      normal: Math.max(25, seedDeltaV * 0.008),
      radial: Math.max(25, seedDeltaV * 0.008),
    };
    for (let pass = 0; pass < 56 && approach.score > 10_000; pass++) {
      let passNode = node;
      let passApproach = approach;
      const offsets: Array<Partial<Record<'time' | 'prograde' | 'normal' | 'radial', number>>> = [];
      for (const component of ['time', 'prograde', 'normal', 'radial'] as const) {
        offsets.push({ [component]: -steps[component] }, { [component]: steps[component] });
      }
      // Planetary targeting is a narrow 3D valley: changing one burn axis at
      // a time can make the miss worse even when a coupled plane/energy trim
      // is much better. Include paired and triple burn-vector moves.
      const burnComponents = ['prograde', 'normal', 'radial'] as const;
      for (let first = 0; first < burnComponents.length; first++) {
        for (let second = first + 1; second < burnComponents.length; second++) {
          for (const firstDirection of [-1, 1]) {
            for (const secondDirection of [-1, 1]) {
              offsets.push({
                [burnComponents[first]]: firstDirection * steps[burnComponents[first]],
                [burnComponents[second]]: secondDirection * steps[burnComponents[second]],
              });
            }
          }
        }
      }
      for (const progradeDirection of [-1, 1]) {
        for (const normalDirection of [-1, 1]) {
          for (const radialDirection of [-1, 1]) {
            offsets.push({
              prograde: progradeDirection * steps.prograde,
              normal: normalDirection * steps.normal,
              radial: radialDirection * steps.radial,
            });
          }
        }
      }
      for (const offset of offsets) {
        const candidateNode = {
          time: node.time + (offset.time ?? 0),
          prograde: node.prograde + (offset.prograde ?? 0),
          normal: node.normal + (offset.normal ?? 0),
          radial: node.radial + (offset.radial ?? 0),
        };
        if (candidateNode.time <= time + 1) continue;
        const candidateApproach = closestInterplanetaryApproach(
          universe,
          from,
          target,
            reference,
            candidateNode,
            coastTime,
            seedDesiredDistance,
        );
        if (candidateApproach && candidateApproach.score < passApproach.score) {
          passNode = candidateNode;
          passApproach = candidateApproach;
        }
      }
      const improved = passApproach.score < approach.score;
      if (improved) {
        node = passNode;
        approach = passApproach;
      }
      const scale = improved ? 0.9 : 0.5;
      steps = {
        time: steps.time * scale,
        prograde: steps.prograde * scale,
        normal: steps.normal * scale,
        radial: steps.radial * scale,
      };
    }

    const deltaV = Math.hypot(node.prograde, node.normal, node.radial);
    if (deltaV > practicalDeltaVLimit) continue;
    const localPrediction = predictTrajectory(
      universe,
      from,
      orbitAfterNode(reference, node),
      node.time,
    );
    if (!localPrediction.escape) continue;
    const parentPrediction = predictTrajectory(
      universe,
      from.parent,
      localPrediction.escape.elements,
      localPrediction.escape.exitTime,
      coastTime * 1.5,
    );
    const encounter = parentPrediction.encounter;
    const maximumApproachAltitude = target.def.surfaceKind === 'gas'
      ? target.visualRadius * 2
      : Math.max(4_000_000, target.radius);
    if (
      !encounter
      || encounter.bodyId !== target.id
      || encounter.periapsisAltitude < 0
      || encounter.periapsisAltitude > maximumApproachAltitude
    ) continue;

    const arrivalDv = captureDeltaV(target, encounter);
    if (!Number.isFinite(arrivalDv)) continue;
    resolved.push({
      node,
      approachAltitude: encounter.periapsisAltitude,
      transferTime: encounter.entryTime - node.time,
      arrivalDv,
      deltaV,
    });
  }
  resolved.sort((a, b) =>
    (a.deltaV + a.arrivalDv) - (b.deltaV + b.arrivalDv)
    || a.deltaV - b.deltaV
    || a.transferTime - b.transferTime,
  );
  return resolved[0] ?? null;
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
    arrivalDv: refined?.arrivalDv ?? arrivalDv,
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

  const nominalNode: ManeuverNode = {
    time: burnTime,
    // The parking-orbit burn always raises local orbital energy. Inward vs.
    // outward heliocentric motion is selected by the ejection point/asymptote,
    // not by reversing the local escape burn.
    prograde: departureDv,
    normal: 0,
    radial: 0,
  };
  const refined = refineInterplanetaryIntercept(
    universe,
    time,
    from,
    target,
    opts,
    windowTime,
    tT,
    departureDv,
    vInfArr,
  );
  const suggestedNode = refined?.node ?? nominalNode;
  const plannedBurnTime = suggestedNode.time;
  return {
    fromId: from.id,
    targetId: target.id,
    targetName: target.name,
    kind: 'interplanetary',
    phaseNow,
    phaseNeeded,
    timeToWindow: Math.max(0, plannedBurnTime - time),
    windowTime: plannedBurnTime,
    burnTime: plannedBurnTime,
    ejectionAngle,
    transferTime: refined?.transferTime ?? tT,
    departureDv: Math.hypot(suggestedNode.prograde, suggestedNode.normal, suggestedNode.radial),
    arrivalDv: refined?.arrivalDv ?? arrivalDv,
    suggestedNode,
    approachAltitude: refined?.approachAltitude,
    accuracy: refined ? 'refined-intercept' : 'phase-estimate',
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
