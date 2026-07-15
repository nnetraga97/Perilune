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
  _tHat.copy(_v).normalize(); // prograde along velocity
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
  _tHat.copy(_v).normalize();
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
}

const _bp = new Vec3();
const _bv = new Vec3();
const _rel = new Vec3();
const _relV = new Vec3();

/**
 * Scan an orbit around `primary` for the first SOI encounter with one of its
 * moons (or SOI escape) within `lookahead` seconds from `startTime`.
 *
 * Adaptive sampling + bisection refinement. The cadence is derived from the
 * smallest child SOI transit time and fastest relevant orbit so small moon
 * encounters cannot fall wholly between two fixed multi-minute samples.
 */
export function predictTrajectory(
  universe: Universe,
  primary: Body,
  elements: OrbitalElements,
  startTime: number,
  lookahead?: number,
): TrajectoryPrediction {
  const period = periodOf(elements);
  const span = lookahead ?? Math.min(Number.isFinite(period) ? period * 3 : 3e6, 3e6);
  const result: TrajectoryPrediction = { elements, encounter: null, escape: null };

  const children = primary.children.filter((c) => c.soiRadius > 0);
  const periapsis = Math.max(1, elements.a * (1 - elements.e));
  const vesselSpeed = Math.sqrt(Math.max(0, elements.mu * (2 / periapsis - 1 / elements.a)));
  let fastestRelativeSpeed = vesselSpeed;
  let shortestPeriod = Number.isFinite(period) ? period : Infinity;
  let smallestSoi = Infinity;
  for (const child of children) {
    smallestSoi = Math.min(smallestSoi, child.soiRadius);
    shortestPeriod = Math.min(shortestPeriod, child.orbitalPeriod);
    if (child.orbit) {
      const childPeriapsis = Math.max(1, child.orbit.a * (1 - child.orbit.e));
      fastestRelativeSpeed += Math.sqrt(Math.max(
        0,
        child.orbit.mu * (2 / childPeriapsis - 1 / child.orbit.a),
      ));
    }
  }
  const transitStep = Number.isFinite(smallestSoi) && fastestRelativeSpeed > 0
    ? smallestSoi / fastestRelativeSpeed / 4
    : Infinity;
  const angularStep = Number.isFinite(shortestPeriod) ? shortestPeriod / 4096 : Infinity;
  const targetStep = Math.max(1, Math.min(3_750, transitStep, angularStep));
  const steps = Math.max(800, Math.min(50_000, Math.ceil(span / targetStep)));
  const dt = span / steps;

  for (let i = 0; i <= steps; i++) {
    const t = startTime + i * dt;
    elementsAtTime(elements, t, _r, _v);
    const rLen = _r.length();

    // Escape check.
    if (primary.soiRadius !== Infinity && rLen > primary.soiRadius && primary.parent) {
      const exitTime = refineCrossing(
        (tt) => {
          elementsAtTime(elements, tt, _r, _v);
          return _r.length() - primary.soiRadius;
        },
        Math.max(startTime, t - dt),
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
    for (const moon of children) {
      universe.localPosition(moon, t, _bp, _bv);
      Vec3.sub(_r, _bp, _rel);
      const d = _rel.length();
      if (d < moon.soiRadius) {
        const entryTime = refineCrossing(
          (tt) => {
            elementsAtTime(elements, tt, _mr, _mv);
            universe.localPosition(moon, tt, _bp, _bv);
            return Vec3.sub(_mr, _bp, _rel).length() - moon.soiRadius;
          },
          Math.max(startTime, t - dt),
          t,
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
    }
  }
  return result;
}

/** Bisection on a sign change of f between t0 (outside) and t1 (inside). */
function refineCrossing(f: (t: number) => number, t0: number, t1: number): number {
  let lo = t0;
  let hi = t1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
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
