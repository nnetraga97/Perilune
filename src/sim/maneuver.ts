/**
 * Maneuver nodes and patched-conic trajectory prediction.
 *
 * A node is a Δv in the RTN (radial / tangential-prograde / normal) frame at
 * a future time on the current orbit. Prediction chains conics: the post-burn
 * orbit is scanned for SOI encounters with the parent's moons (or escape to
 * the parent's parent), producing the "Palla periapsis 42 km" readouts that
 * make transfer planning possible.
 */
import { Vec3 } from '../core/vec3';
import {
  OrbitalElements,
  elementsAtTime,
  periodOf,
  stateToElements,
} from '../core/orbit';
import type { Body, Universe } from './universe';

export interface ManeuverNode {
  /** Absolute sim time of the burn (impulsive approximation). */
  time: number;
  prograde: number; // m/s
  normal: number;
  radial: number;
}

export function nodeDeltaV(node: ManeuverNode): number {
  return Math.hypot(node.prograde, node.normal, node.radial);
}

const _r = new Vec3();
const _v = new Vec3();
const _rHat = new Vec3();
const _nHat = new Vec3();
const _tHat = new Vec3();
const _mr = new Vec3();
const _mv = new Vec3();
const _midR = new Vec3();
const _midV = new Vec3();

/**
 * Orbit after executing the node impulsively.
 * @param elements current orbit around `body`
 */
export function orbitAfterNode(
  elements: OrbitalElements,
  node: ManeuverNode,
): OrbitalElements {
  elementsAtTime(elements, node.time, _r, _v);
  // RTN basis at burn point.
  _rHat.copy(_r).normalize();
  Vec3.cross(_r, _v, _nHat).normalize();
  Vec3.cross(_nHat, _rHat, _tHat).normalize(); // transverse, orthogonal to radial
  _v.addScaled(_tHat, node.prograde);
  _v.addScaled(_rHat, node.radial);
  _v.addScaled(_nHat, node.normal);
  return stateToElements(elements.mu, _r, _v, node.time);
}

/** World-frame burn direction for the node (for SAS alignment). */
export function nodeBurnDirection(
  elements: OrbitalElements,
  node: ManeuverNode,
  out: Vec3,
): Vec3 {
  nodeBurnVector(elements, node, out);
  return out.lengthSq() > 0 ? out.normalize() : out.set(1, 0, 0);
}

/** World-frame delta-v vector represented by a node's signed RTN components. */
export function nodeBurnVector(
  elements: OrbitalElements,
  node: ManeuverNode,
  out: Vec3,
): Vec3 {
  elementsAtTime(elements, node.time, _r, _v);
  _rHat.copy(_r).normalize();
  Vec3.cross(_r, _v, _nHat).normalize();
  Vec3.cross(_nHat, _rHat, _tHat).normalize();
  out.set(0, 0, 0);
  out.addScaled(_tHat, node.prograde);
  out.addScaled(_rHat, node.radial);
  out.addScaled(_nHat, node.normal);
  return out;
}

export interface EncounterPrediction {
  bodyId: string;
  /** Time of SOI entry. */
  entryTime: number;
  /** Elements inside the encountered body's SOI. */
  elements: OrbitalElements;
  /** Periapsis altitude above the body surface (m); negative = impact. */
  periapsisAltitude: number;
}

export interface EscapePrediction {
  /** Time of SOI exit into the parent's parent. */
  exitTime: number;
  elements: OrbitalElements;
}

export interface TrajectoryPrediction {
  /** Orbit around the current primary (post-node if a node given). */
  elements: OrbitalElements;
  encounter: EncounterPrediction | null;
  escape: EscapePrediction | null;
  /** Absolute interval covered by the encounter scan. */
  startTime: number;
  endTime: number;
}

const _bp = new Vec3();
const _bv = new Vec3();
const _rel = new Vec3();
const _relV = new Vec3();

const LOCAL_LOOKAHEAD = 3_000_000;
const STAR_LOOKAHEAD = 60_000_000;

function defaultLookahead(primary: Body, elements: OrbitalElements): number {
  const cap = primary.def.isStar ? STAR_LOOKAHEAD : LOCAL_LOOKAHEAD;
  const period = periodOf(elements);
  return Math.min(Number.isFinite(period) ? period * 3 : cap, cap);
}

function lineSegmentDistanceSqToOrigin(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq === 0) return a.lengthSq();
  const u = Math.max(0, Math.min(1, -(a.x * dx + a.y * dy + a.z * dz) / lengthSq));
  const x = a.x + dx * u;
  const y = a.y + dy * u;
  const z = a.z + dz * u;
  return x * x + y * y + z * z;
}

function relativeDistance(
  universe: Universe,
  elements: OrbitalElements,
  moon: Body,
  time: number,
): number {
  elementsAtTime(elements, time, _mr, _mv);
  universe.localPosition(moon, time, _bp, _bv);
  return Vec3.sub(_mr, _bp, _rel).length();
}

/** Find the minimum of a smooth distance function over a short scan interval. */
function minimumDistanceTime(f: (time: number) => number, t0: number, t1: number): number {
  let lo = t0;
  let hi = t1;
  for (let i = 0; i < 24; i++) {
    const third = (hi - lo) / 3;
    const left = lo + third;
    const right = hi - third;
    if (f(left) <= f(right)) hi = right;
    else lo = left;
  }
  return (lo + hi) / 2;
}

/**
 * Scan an orbit around `primary` for the first SOI encounter with one of its
 * moons (or SOI escape) within `lookahead` seconds from `startTime`.
 *
 * Adaptive sampling + bisection refinement. Midpoint-relative-motion chords
 * screen each interval for short SOI transits, then suspected crossings are
 * minimized and refined without making the entire long coast use a tiny step.
 */
export function predictTrajectory(
  universe: Universe,
  primary: Body,
  elements: OrbitalElements,
  startTime: number,
  lookahead?: number,
): TrajectoryPrediction {
  const span = lookahead ?? defaultLookahead(primary, elements);
  const result: TrajectoryPrediction = {
    elements,
    encounter: null,
    escape: null,
    startTime,
    endTime: startTime + span,
  };

  const children = primary.children.filter((c) => c.soiRadius > 0);
  const periapsis = Math.max(1, elements.a * (1 - elements.e));
  const vesselSpeed = Math.sqrt(Math.max(0, elements.mu * (2 / periapsis - 1 / elements.a)));
  let fastestRelativeSpeed = vesselSpeed;
  const vesselPeriod = periodOf(elements);
  let shortestPeriod = Number.isFinite(vesselPeriod) ? vesselPeriod : Infinity;
  for (const child of children) {
    shortestPeriod = Math.min(shortestPeriod, child.orbitalPeriod);
    if (child.orbit) {
      const childPeriapsis = Math.max(1, child.orbit.a * (1 - child.orbit.e));
      const childSpeed = Math.sqrt(Math.max(
        0,
        child.orbit.mu * (2 / childPeriapsis - 1 / child.orbit.a),
      ));
      fastestRelativeSpeed = Math.max(fastestRelativeSpeed, vesselSpeed + childSpeed);
    }
  }
  // Coarse samples are joined by relative-motion chords. The midpoint chord
  // check below catches short SOI transits that would otherwise fit entirely
  // between samples, without forcing a tiny global step across a long coast.
  const angularStep = Number.isFinite(shortestPeriod) ? shortestPeriod / 512 : Infinity;
  const targetStep = Math.max(1, Math.min(3_750, angularStep));
  const steps = Math.max(1, Math.ceil(span / targetStep));
  const dt = span / steps;

  const previousRelative = children.map(() => new Vec3());
  const midpointRelative = children.map(() => new Vec3());
  const currentRelative = children.map(() => new Vec3());
  elementsAtTime(elements, startTime, _r, _v);
  for (let childIndex = 0; childIndex < children.length; childIndex++) {
    universe.localPosition(children[childIndex], startTime, _bp, _bv);
    Vec3.sub(_r, _bp, previousRelative[childIndex]);
  }

  for (let i = 1; i <= steps; i++) {
    const t = startTime + i * dt;
    const previousTime = t - dt;
    const midpoint = previousTime + dt / 2;
    elementsAtTime(elements, t, _r, _v);
    const rLen = _r.length();

    // Escape check.
    if (primary.soiRadius !== Infinity && rLen > primary.soiRadius && primary.parent) {
      const exitTime = refineCrossing(
        (tt) => {
          elementsAtTime(elements, tt, _r, _v);
          return _r.length() - primary.soiRadius;
        },
        previousTime,
        t,
      );
      elementsAtTime(elements, exitTime, _r, _v);
      universe.localPosition(primary, exitTime, _bp, _bv);
      _r.add(_bp);
      _v.add(_bv);
      result.escape = {
        exitTime,
        elements: stateToElements(primary.parent.mu, _r, _v, exitTime),
      };
      return result;
    }

    // Moon encounter check.
    elementsAtTime(elements, midpoint, _midR, _midV);
    for (let childIndex = 0; childIndex < children.length; childIndex++) {
      const moon = children[childIndex];
      universe.localPosition(moon, t, _bp, _bv);
      Vec3.sub(_r, _bp, currentRelative[childIndex]);
      universe.localPosition(moon, midpoint, _bp, _bv);
      Vec3.sub(_midR, _bp, midpointRelative[childIndex]);
      const chordPadding = Math.min(moon.soiRadius * 0.05, fastestRelativeSpeed * dt / 512);
      const screeningRadiusSq = (moon.soiRadius + chordPadding) ** 2;
      const soiSq = moon.soiRadius ** 2;
      const chordMayCross =
        lineSegmentDistanceSqToOrigin(previousRelative[childIndex], midpointRelative[childIndex]) <= screeningRadiusSq ||
        lineSegmentDistanceSqToOrigin(midpointRelative[childIndex], currentRelative[childIndex]) <= screeningRadiusSq;
      const sampledInside =
        currentRelative[childIndex].lengthSq() <= soiSq || midpointRelative[childIndex].lengthSq() <= soiSq;
      let insideTime: number | null = null;
      if (sampledInside) {
        insideTime = midpointRelative[childIndex].lengthSq() <= soiSq ? midpoint : t;
      } else if (chordMayCross) {
        const candidate = minimumDistanceTime(
          (tt) => relativeDistance(universe, elements, moon, tt),
          previousTime,
          t,
        );
        if (relativeDistance(universe, elements, moon, candidate) <= moon.soiRadius) {
          insideTime = candidate;
        }
      }

      if (insideTime !== null) {
        const entryTime = refineCrossing(
          (tt) => {
            elementsAtTime(elements, tt, _mr, _mv);
            universe.localPosition(moon, tt, _bp, _bv);
            return Vec3.sub(_mr, _bp, _rel).length() - moon.soiRadius;
          },
          previousTime,
          insideTime,
        );
        elementsAtTime(elements, entryTime, _mr, _mv);
        universe.localPosition(moon, entryTime, _bp, _bv);
        Vec3.sub(_mr, _bp, _rel);
        Vec3.sub(_mv, _bv, _relV);
        const moonElements = stateToElements(moon.mu, _rel, _relV, entryTime);
        const peri = moonElements.a * (1 - moonElements.e);
        result.encounter = {
          bodyId: moon.id,
          entryTime,
          elements: moonElements,
          periapsisAltitude: peri - moon.radius,
        };
        return result;
      }
      previousRelative[childIndex].copy(currentRelative[childIndex]);
    }
  }
  return result;
}

/** Bisection on a sign change of f, independent of crossing direction. */
function refineCrossing(f: (t: number) => number, t0: number, t1: number): number {
  let lo = t0;
  let hi = t1;
  const loPositive = f(lo) > 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if ((f(mid) > 0) === loPositive) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Estimate burn duration for a node given available thrust and mass
 * (Tsiolkovsky-aware enough for the burn timer UI).
 */
export function estimateBurnTime(
  deltaV: number,
  thrust: number,
  mass: number,
  isp: number,
): number {
  if (thrust <= 0 || deltaV <= 0) return Infinity;
  const g0 = 9.80665;
  const flow = thrust / (isp * g0);
  const m1 = mass * Math.exp(-deltaV / (isp * g0));
  return (mass - m1) / flow;
}
