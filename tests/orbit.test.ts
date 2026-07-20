import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Vec3 } from '../src/core/vec3';
import {
  elementsAtTime,
  elementsToState,
  meanToTrue,
  periodOf,
  propagateUniversal,
  specificEnergy,
  stateToElements,
  trueToMean,
} from '../src/core/orbit';
import { Universe } from '../src/sim/universe';
import { LEGACY_AUREN_SYSTEM as AUREN_SYSTEM } from './fixtures/legacyAurenSystem';

const MU_VEYRA = 9.42e12;

function makeState(rMag: number, vMag: number, flightPathDeg = 0) {
  const r = new Vec3(rMag, 0, 0);
  const fpa = (flightPathDeg * Math.PI) / 180;
  const v = new Vec3(vMag * Math.sin(fpa), vMag * Math.cos(fpa), 0);
  return { r, v };
}

describe('state ↔ elements round trip', () => {
  it('recovers state from elements for a generic elliptic orbit', () => {
    const r = new Vec3(1.2e6, 3.4e5, 2.2e5);
    const v = new Vec3(-800, 2600, 400);
    const el = stateToElements(MU_VEYRA, r, v, 0);
    expect(el.e).toBeLessThan(1);
    const nu = meanToTrue(el.meanAnomaly0, el.e);
    const r2 = new Vec3();
    const v2 = new Vec3();
    elementsToState(el, nu, r2, v2);
    expect(r2.distanceTo(r) / r.length()).toBeLessThan(1e-9);
    expect(v2.distanceTo(v) / v.length()).toBeLessThan(1e-9);
  });

  it('recovers state for hyperbolic orbits', () => {
    const { r, v } = makeState(1.1e6, 5200, 10); // above escape velocity
    const el = stateToElements(MU_VEYRA, r, v, 0);
    expect(el.e).toBeGreaterThan(1);
    expect(el.a).toBeLessThan(0);
    const nu = meanToTrue(el.meanAnomaly0, el.e);
    const r2 = new Vec3();
    const v2 = new Vec3();
    elementsToState(el, nu, r2, v2);
    expect(r2.distanceTo(r) / r.length()).toBeLessThan(1e-8);
    expect(v2.distanceTo(v) / v.length()).toBeLessThan(1e-8);
  });

  it('handles circular equatorial orbits', () => {
    const rMag = 1.08e6;
    const vCirc = Math.sqrt(MU_VEYRA / rMag);
    const { r, v } = makeState(rMag, vCirc);
    const el = stateToElements(MU_VEYRA, r, v, 0);
    expect(el.e).toBeLessThan(1e-8);
    const r2 = new Vec3();
    const v2 = new Vec3();
    elementsAtTime(el, 0, r2, v2);
    expect(r2.distanceTo(r) / rMag).toBeLessThan(1e-7);
  });

  it('round trips randomized bound orbits (property test)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1.05e6, max: 5e7, noNaN: true }),
        fc.double({ min: 100, max: 3400, noNaN: true }),
        fc.double({ min: -60, max: 60, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        (rMag, vMag, fpaDeg, vz) => {
          const { r, v } = makeState(rMag, vMag, fpaDeg);
          v.z = vz;
          const energy = specificEnergy(MU_VEYRA, r, v);
          fc.pre(energy < -1e4); // clearly bound
          const el = stateToElements(MU_VEYRA, r, v, 0);
          // Bound eccentricity: above ~0.95 the nu→r conversion is
          // ill-conditioned near apoapsis (denominator 1+e·cosν → 1−e) and
          // relative tolerances stop being meaningful.
          fc.pre(el.e > 1e-9 && el.e < 0.95);
          const nu = meanToTrue(el.meanAnomaly0, el.e);
          const r2 = new Vec3();
          const v2 = new Vec3();
          elementsToState(el, nu, r2, v2);
          return (
            r2.distanceTo(r) / r.length() < 1e-7 &&
            v2.distanceTo(v) / v.length() < 1e-7
          );
        },
      ),
      { numRuns: 300, seed: 20260710 },
    );
  });
});

describe('analytic propagation', () => {
  it('returns to the same state after exactly one period', () => {
    const r = new Vec3(1.3e6, 1e5, 3e5);
    const v = new Vec3(-500, 2500, 300);
    const el = stateToElements(MU_VEYRA, r, v, 0);
    const T = periodOf(el);
    const r2 = new Vec3();
    const v2 = new Vec3();
    elementsAtTime(el, T, r2, v2);
    expect(r2.distanceTo(r)).toBeLessThan(1); // < 1 meter after a full orbit
    expect(v2.distanceTo(v)).toBeLessThan(0.001);
  });

  it('conserves energy over 1000 orbits', () => {
    const r = new Vec3(1.5e6, 0, 2e5);
    const v = new Vec3(200, 2400, -100);
    const el = stateToElements(MU_VEYRA, r, v, 0);
    const e0 = specificEnergy(MU_VEYRA, r, v);
    const T = periodOf(el);
    const r2 = new Vec3();
    const v2 = new Vec3();
    for (const k of [1, 10, 100, 1000]) {
      elementsAtTime(el, T * k + 12345.678, r2, v2);
      const e1 = specificEnergy(MU_VEYRA, r2, v2);
      expect(Math.abs((e1 - e0) / e0)).toBeLessThan(1e-9);
    }
  });
});

describe('universal-variable propagation', () => {
  it('matches analytic elliptic propagation', () => {
    const r0 = new Vec3(1.2e6, 2e5, -1e5);
    const v0 = new Vec3(300, 2700, 500);
    const el = stateToElements(MU_VEYRA, r0, v0, 0);
    const rA = new Vec3();
    const vA = new Vec3();
    const rU = new Vec3();
    const vU = new Vec3();
    for (const dt of [10, 1000, 50_000, periodOf(el) * 2.3]) {
      elementsAtTime(el, dt, rA, vA);
      const ok = propagateUniversal(MU_VEYRA, r0, v0, dt, rU, vU);
      expect(ok).toBe(true);
      expect(rU.distanceTo(rA) / rA.length()).toBeLessThan(1e-6);
      expect(vU.distanceTo(vA) / vA.length()).toBeLessThan(1e-6);
    }
  });

  it('propagates hyperbolic flyby without NaN and conserves energy', () => {
    const { r, v } = makeState(1.1e6, 5600, 20);
    const e0 = specificEnergy(MU_VEYRA, r, v);
    const r2 = new Vec3();
    const v2 = new Vec3();
    for (const dt of [100, 10_000, 500_000, -10_000]) {
      const ok = propagateUniversal(MU_VEYRA, r, v, dt, r2, v2);
      expect(ok).toBe(true);
      expect(r2.isFinite()).toBe(true);
      const e1 = specificEnergy(MU_VEYRA, r2, v2);
      expect(Math.abs((e1 - e0) / e0)).toBeLessThan(1e-7);
    }
  });

  it('propagates backwards and returns to start (property test)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1.05e6, max: 2e7, noNaN: true }),
        fc.double({ min: 500, max: 5000, noNaN: true }),
        fc.double({ min: -80, max: 80, noNaN: true }),
        fc.double({ min: 1, max: 100_000, noNaN: true }),
        (rMag, vMag, fpaDeg, dt) => {
          const { r, v } = makeState(rMag, vMag, fpaDeg);
          const rF = new Vec3();
          const vF = new Vec3();
          if (!propagateUniversal(MU_VEYRA, r, v, dt, rF, vF)) return true; // solver bail is allowed, not wrong
          // Skip states that fell inside the body (suborbital impact regime)
          if (rF.length() < 1.02e6) return true;
          const rB = new Vec3();
          const vB = new Vec3();
          if (!propagateUniversal(MU_VEYRA, rF, vF, -dt, rB, vB)) return true;
          return rB.distanceTo(r) / r.length() < 1e-5;
        },
      ),
      { numRuns: 300, seed: 20260710 },
    );
  });
});

describe('anomaly conversions', () => {
  it('mean ↔ true round trip across eccentricities', () => {
    for (const e of [0, 0.001, 0.3, 0.7, 0.95]) {
      for (let nu = 0.05; nu < Math.PI * 2; nu += 0.37) {
        const M = trueToMean(nu, e);
        const nu2 = meanToTrue(M, e);
        const diff = Math.abs(((nu2 - nu + Math.PI) % (2 * Math.PI)) - Math.PI);
        expect(diff).toBeLessThan(1e-9);
      }
    }
  });
});

describe('universe hierarchy', () => {
  const universe = new Universe(AUREN_SYSTEM);

  it('builds the full body tree', () => {
    expect(universe.bodies.size).toBe(AUREN_SYSTEM.length);
    expect(universe.get('palla').parent?.id).toBe('veyra');
    expect(universe.get('veyra').parent?.id).toBe('auren');
  });

  it('computes sane SOI radii', () => {
    const veyra = universe.get('veyra');
    const palla = universe.get('palla');
    // Veyra SOI must contain both moons but not reach the star.
    expect(veyra.soiRadius).toBeGreaterThan(universe.get('wisp').orbit!.a);
    expect(veyra.soiRadius).toBeLessThan(0.1 * veyra.orbit!.a);
    // Palla SOI is well inside Veyra's SOI and bigger than Palla itself.
    expect(palla.soiRadius).toBeGreaterThan(palla.radius * 4);
    expect(palla.soiRadius).toBeLessThan(veyra.soiRadius / 4);
  });

  it('keeps double precision at full system scale', () => {
    // Farfall aphelion is ~1.4e11 m from the star. A vessel 2 m from its
    // surface must still resolve: check f64 ulp at that scale is < 0.1 mm.
    const farfall = universe.get('farfall');
    const t = 1e7;
    const pos = new Vec3();
    universe.absolutePosition(farfall, t, pos);
    const scale = pos.length();
    expect(scale).toBeGreaterThan(5e10);
    const ulp = Math.pow(2, Math.ceil(Math.log2(scale)) - 52);
    expect(ulp).toBeLessThan(1e-4); // sub-0.1mm absolute resolution even at max range
  });

  it('moon positions stay periodic and bounded', () => {
    const palla = universe.get('palla');
    const r = new Vec3();
    for (let k = 0; k < 40; k++) {
      universe.localPosition(palla, k * 97_531, r);
      const d = r.length();
      expect(d).toBeGreaterThan(palla.orbit!.a * 0.99);
      expect(d).toBeLessThan(palla.orbit!.a * 1.01);
    }
  });

  it('atmosphere model is monotonic and terminates', () => {
    const veyra = universe.get('veyra');
    let prev = Infinity;
    for (let alt = 0; alt <= 90_000; alt += 5_000) {
      const p = veyra.pressureAt(alt);
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
    expect(veyra.pressureAt(90_000)).toBe(0);
    expect(veyra.pressureAt(0)).toBeCloseTo(101_325, 0);
  });
});
