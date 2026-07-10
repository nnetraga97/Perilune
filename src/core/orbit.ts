/**
 * Two-body orbital mechanics: classical elements, Kepler solvers for all
 * conic regimes, and universal-variable propagation.
 *
 * Conventions:
 *  - Units are SI (meters, seconds, radians).
 *  - Right-handed frame, +Z is the reference "north" pole of the parent body.
 *  - mu is the gravitational parameter (G*M) of the parent body.
 */
import { Vec3 } from './vec3';

export const TWO_PI = Math.PI * 2;

export interface OrbitalElements {
  /** Semi-major axis (m). Negative for hyperbolic, Infinity for parabolic. */
  a: number;
  /** Eccentricity. */
  e: number;
  /** Inclination (rad, 0..pi). */
  i: number;
  /** Right ascension / longitude of ascending node (rad). */
  raan: number;
  /** Argument of periapsis (rad). */
  argPe: number;
  /** Mean anomaly at epoch (rad). For hyperbolic, hyperbolic mean anomaly. */
  meanAnomaly0: number;
  /** Epoch (simulation seconds) at which meanAnomaly0 applies. */
  epoch: number;
  /** Gravitational parameter of the parent (m^3/s^2). */
  mu: number;
}

export function periapsisOf(el: OrbitalElements): number {
  return el.a * (1 - el.e);
}

export function apoapsisOf(el: OrbitalElements): number {
  // Negative/meaningless for open orbits; callers must check e < 1.
  return el.a * (1 + el.e);
}

export function periodOf(el: OrbitalElements): number {
  if (el.e >= 1) return Infinity;
  return TWO_PI * Math.sqrt((el.a * el.a * el.a) / el.mu);
}

export function meanMotionOf(el: OrbitalElements): number {
  const absA = Math.abs(el.a);
  return Math.sqrt(el.mu / (absA * absA * absA));
}

/** Specific orbital energy from state (m^2/s^2). */
export function specificEnergy(mu: number, r: Readonly<Vec3>, v: Readonly<Vec3>): number {
  return v.lengthSq() / 2 - mu / r.length();
}

const _h = new Vec3();
const _n = new Vec3();
const _ev = new Vec3();
const _tmp = new Vec3();

/** Convert Cartesian state to classical orbital elements. */
export function stateToElements(
  mu: number,
  r: Readonly<Vec3>,
  v: Readonly<Vec3>,
  epoch: number,
): OrbitalElements {
  const rLen = r.length();
  const vSq = v.lengthSq();

  const h = Vec3.cross(r, v, _h); // specific angular momentum
  const hLen = h.length();

  // Node vector n = k × h
  const n = _n.set(-h.y, h.x, 0);
  const nLen = n.length();

  // Eccentricity vector
  const rv = Vec3.dot(r, v);
  const ev = _ev.set(
    ((vSq - mu / rLen) * r.x - rv * v.x) / mu,
    ((vSq - mu / rLen) * r.y - rv * v.y) / mu,
    ((vSq - mu / rLen) * r.z - rv * v.z) / mu,
  );
  const e = ev.length();

  const energy = vSq / 2 - mu / rLen;
  const parabolic = Math.abs(e - 1) < 1e-10;
  const a = parabolic ? Infinity : -mu / (2 * energy);

  const i = Math.acos(clamp(h.z / hLen, -1, 1));

  const equatorial = nLen < 1e-11 * hLen;
  let raan: number;
  if (equatorial) {
    raan = 0;
  } else {
    raan = Math.acos(clamp(n.x / nLen, -1, 1));
    if (n.y < 0) raan = TWO_PI - raan;
  }

  const circular = e < 1e-11;
  let argPe: number;
  let nu: number; // true anomaly
  if (circular && equatorial) {
    argPe = 0;
    nu = Math.acos(clamp(r.x / rLen, -1, 1));
    if (r.y < 0) nu = TWO_PI - nu;
  } else if (circular) {
    argPe = 0;
    nu = Math.acos(clamp(Vec3.dot(n, r) / (nLen * rLen), -1, 1));
    if (r.z < 0) nu = TWO_PI - nu;
  } else if (equatorial) {
    argPe = Math.atan2(ev.y, ev.x);
    if (h.z < 0) argPe = TWO_PI - argPe; // retrograde equatorial
    if (argPe < 0) argPe += TWO_PI;
    nu = trueAnomalyFrom(ev, e, r, rLen, v);
  } else {
    argPe = Math.acos(clamp(Vec3.dot(n, ev) / (nLen * e), -1, 1));
    if (ev.z < 0) argPe = TWO_PI - argPe;
    nu = trueAnomalyFrom(ev, e, r, rLen, v);
  }

  const meanAnomaly0 = trueToMean(nu, e);

  return { a, e, i, raan, argPe, meanAnomaly0, epoch, mu };
}

function trueAnomalyFrom(
  ev: Readonly<Vec3>,
  e: number,
  r: Readonly<Vec3>,
  rLen: number,
  v: Readonly<Vec3>,
): number {
  let nu = Math.acos(clamp(Vec3.dot(ev, r) / (e * rLen), -1, 1));
  if (Vec3.dot(r, v) < 0) nu = TWO_PI - nu;
  return nu;
}

/** True anomaly → mean anomaly (elliptic or hyperbolic). */
export function trueToMean(nu: number, e: number): number {
  if (e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    let M = E - e * Math.sin(E);
    if (M < 0) M += TWO_PI;
    return M % TWO_PI;
  }
  // Hyperbolic: nu is in (-nuInf, nuInf); map from acos-range if needed.
  let f = nu;
  if (f > Math.PI) f -= TWO_PI;
  const coshH = (e + Math.cos(f)) / (1 + e * Math.cos(f));
  let H = Math.acosh(Math.max(1, coshH));
  if (f < 0) H = -H;
  return e * Math.sinh(H) - H;
}

/** Mean anomaly → true anomaly (elliptic or hyperbolic). */
export function meanToTrue(M: number, e: number): number {
  if (e < 1) {
    const E = solveKeplerElliptic(M, e);
    let nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    if (nu < 0) nu += TWO_PI;
    return nu;
  }
  const H = solveKeplerHyperbolic(M, e);
  return 2 * Math.atan2(Math.sqrt(e + 1) * Math.sinh(H / 2), Math.sqrt(e - 1) * Math.cosh(H / 2));
}

/** Solve M = E - e sinE by Newton iteration. */
export function solveKeplerElliptic(M: number, e: number): number {
  M = M % TWO_PI;
  if (M < 0) M += TWO_PI;
  let E = e < 0.8 ? M : Math.PI;
  for (let iter = 0; iter < 32; iter++) {
    const f = E - e * Math.sin(E) - M;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < 1e-14) break;
  }
  return E;
}

/** Solve M = e sinhH - H by Newton iteration. */
export function solveKeplerHyperbolic(M: number, e: number): number {
  let H = Math.sign(M) * Math.log((2 * Math.abs(M)) / e + 1.8);
  for (let iter = 0; iter < 64; iter++) {
    const f = e * Math.sinh(H) - H - M;
    const fp = e * Math.cosh(H) - 1;
    const dH = f / fp;
    H -= dH;
    if (Math.abs(dH) < 1e-13) break;
  }
  return H;
}

/**
 * Evaluate elements at a given true anomaly, writing position/velocity in the
 * parent-centered inertial frame.
 */
export function elementsToState(
  el: OrbitalElements,
  nu: number,
  outR: Vec3,
  outV: Vec3,
): void {
  const { a, e, i, raan, argPe, mu } = el;
  const p = e === 1 ? 2 * el.a : a * (1 - e * e); // semi-latus rectum
  const cosNu = Math.cos(nu);
  const sinNu = Math.sin(nu);
  const rLen = p / (1 + e * cosNu);

  // Perifocal frame
  const rPx = rLen * cosNu;
  const rPy = rLen * sinNu;
  const vScale = Math.sqrt(mu / p);
  const vPx = -vScale * sinNu;
  const vPy = vScale * (e + cosNu);

  // Rotate perifocal → inertial: Rz(raan) Rx(i) Rz(argPe)
  const cO = Math.cos(raan), sO = Math.sin(raan);
  const ci = Math.cos(i), si = Math.sin(i);
  const cw = Math.cos(argPe), sw = Math.sin(argPe);

  const m00 = cO * cw - sO * sw * ci;
  const m01 = -cO * sw - sO * cw * ci;
  const m10 = sO * cw + cO * sw * ci;
  const m11 = -sO * sw + cO * cw * ci;
  const m20 = sw * si;
  const m21 = cw * si;

  outR.set(m00 * rPx + m01 * rPy, m10 * rPx + m11 * rPy, m20 * rPx + m21 * rPy);
  outV.set(m00 * vPx + m01 * vPy, m10 * vPx + m11 * vPy, m20 * vPx + m21 * vPy);
}

/** Evaluate elements at absolute time t (analytic propagation — the background regime). */
export function elementsAtTime(el: OrbitalElements, t: number, outR: Vec3, outV: Vec3): void {
  const n = meanMotionOf(el);
  let M = el.meanAnomaly0 + n * (t - el.epoch);
  const nu = meanToTrue(M, el.e);
  elementsToState(el, nu, outR, outV);
}

/** Time until reaching the given true anomaly from current mean anomaly (elliptic only). */
export function timeToTrueAnomaly(el: OrbitalElements, tNow: number, nuTarget: number): number {
  const n = meanMotionOf(el);
  const MTarget = trueToMean(nuTarget, el.e);
  const MNow = (el.meanAnomaly0 + n * (tNow - el.epoch)) % TWO_PI;
  let dM = MTarget - (MNow < 0 ? MNow + TWO_PI : MNow);
  if (el.e < 1) {
    while (dM < 0) dM += TWO_PI;
    return dM / n;
  }
  return dM / n; // hyperbolic: may be negative (already passed)
}

// ---------------------------------------------------------------------------
// Universal-variable propagation (handles elliptic/parabolic/hyperbolic
// uniformly). Used for propagating arbitrary states, e.g. trajectory
// prediction and maneuver planning.
// ---------------------------------------------------------------------------

function stumpff(psi: number): { c2: number; c3: number } {
  if (psi > 1e-6) {
    const sq = Math.sqrt(psi);
    return { c2: (1 - Math.cos(sq)) / psi, c3: (sq - Math.sin(sq)) / (sq * psi) };
  }
  if (psi < -1e-6) {
    const sq = Math.sqrt(-psi);
    return { c2: (1 - Math.cosh(sq)) / psi, c3: (Math.sinh(sq) - sq) / (sq * -psi) };
  }
  // Series expansion near zero
  return {
    c2: 1 / 2 - psi / 24 + (psi * psi) / 720,
    c3: 1 / 6 - psi / 120 + (psi * psi) / 5040,
  };
}

/**
 * Propagate a state vector by dt seconds under two-body gravity.
 * Returns false if the solver failed to converge (caller should fall back).
 */
export function propagateUniversal(
  mu: number,
  r0: Readonly<Vec3>,
  v0: Readonly<Vec3>,
  dt: number,
  outR: Vec3,
  outV: Vec3,
): boolean {
  if (dt === 0) {
    outR.copy(r0);
    outV.copy(v0);
    return true;
  }
  const r0Len = r0.length();
  const v0Sq = v0.lengthSq();
  const sqrtMu = Math.sqrt(mu);
  const rv0 = Vec3.dot(r0, v0);
  const alpha = 2 / r0Len - v0Sq / mu; // 1/a

  // Initial guess for universal anomaly chi
  let chi: number;
  if (alpha > 1e-12) {
    chi = sqrtMu * dt * alpha;
  } else if (alpha < -1e-12) {
    const a = 1 / alpha;
    chi =
      Math.sign(dt) *
      Math.sqrt(-a) *
      Math.log(
        (-2 * mu * alpha * dt) /
          (rv0 + Math.sign(dt) * Math.sqrt(-mu * a) * (1 - r0Len * alpha)),
      );
    if (!Number.isFinite(chi)) chi = Math.sign(dt) * Math.sqrt(-a);
  } else {
    // Near-parabolic
    const h = Vec3.cross(r0, v0, _tmp).length();
    const p = (h * h) / mu;
    const s = 0.5 * (Math.PI / 2 - Math.atan(3 * Math.sqrt(mu / (p * p * p)) * dt));
    const w = Math.atan(Math.cbrt(Math.tan(s)));
    chi = (Math.sqrt(p) * 2) / Math.tan(2 * w);
    if (!Number.isFinite(chi)) chi = sqrtMu * dt / r0Len;
  }

  let rLen = r0Len;
  let psi = 0;
  let c2 = 0.5;
  let c3 = 1 / 6;
  let converged = false;
  for (let iter = 0; iter < 60; iter++) {
    psi = chi * chi * alpha;
    const st = stumpff(psi);
    c2 = st.c2;
    c3 = st.c3;
    rLen =
      chi * chi * c2 +
      (rv0 / sqrtMu) * chi * (1 - psi * c3) +
      r0Len * (1 - psi * c2);
    const F =
      sqrtMu * dt -
      chi * chi * chi * c3 -
      (rv0 / sqrtMu) * chi * chi * c2 -
      r0Len * chi * (1 - psi * c3);
    const dChi = F / rLen;
    chi += dChi;
    if (Math.abs(dChi) < 1e-10 * Math.max(1, Math.abs(chi))) {
      converged = true;
      break;
    }
  }
  if (!converged || !Number.isFinite(chi)) return false;

  const f = 1 - (chi * chi / r0Len) * c2;
  const g = dt - (chi * chi * chi / sqrtMu) * c3;
  outR.set(
    f * r0.x + g * v0.x,
    f * r0.y + g * v0.y,
    f * r0.z + g * v0.z,
  );
  const rNew = outR.length();
  const fdot = (sqrtMu / (rNew * r0Len)) * chi * (psi * c3 - 1);
  const gdot = 1 - (chi * chi / rNew) * c2;
  outV.set(
    fdot * r0.x + gdot * v0.x,
    fdot * r0.y + gdot * v0.y,
    fdot * r0.z + gdot * v0.z,
  );
  return outR.isFinite() && outV.isFinite();
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
