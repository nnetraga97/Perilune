/**
 * Milestone 0 numerical benchmarks. These decide the stack ADR:
 * if TypeScript hits budget with big margins, we skip a Rust/WASM sidecar.
 *
 * Budgets (per 60 FPS frame = 16.7 ms, simulation share ≤ 5 ms):
 *  - Analytic propagation of 200 background vessels: ≤ 0.5 ms
 *  - Structural pass on a 500-part vessel: ≤ 2 ms
 *  - Universal propagation for a 400-step trajectory prediction: ≤ 2 ms
 *  - Mass properties of a 500-part vessel: ≤ 1 ms
 */
import { bench, describe } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import {
  elementsAtTime,
  propagateUniversal,
  stateToElements,
} from '../src/core/orbit';
import { analyzeCraft, computeMassProperties } from '../src/sim/vessel';
import { evaluateStructure } from '../src/sim/structure';
import { buildStressVessel, buildTwoStageRocket } from '../tests/vessel.test';

const MU = 9.42e12;
const r0 = new Vec3(1.2e6, 3e5, -8e4);
const v0 = new Vec3(150, 2650, 420);
const el = stateToElements(MU, r0, v0, 0);
const outR = new Vec3();
const outV = new Vec3();

describe('orbital propagation', () => {
  bench('analytic elementsAtTime ×200 (background fleet tick)', () => {
    for (let i = 0; i < 200; i++) {
      elementsAtTime(el, i * 173.3 + 1e5, outR, outV);
    }
  });

  bench('universal propagation ×400 (trajectory prediction sweep)', () => {
    for (let i = 0; i < 400; i++) {
      propagateUniversal(MU, r0, v0, i * 30, outR, outV);
    }
  });

  bench('stateToElements ×1000', () => {
    for (let i = 0; i < 1000; i++) {
      stateToElements(MU, r0, v0, i);
    }
  });
});

const craft150 = buildStressVessel(150);
const craft500 = buildStressVessel(500);
const small = buildTwoStageRocket();
const accel = new Vec3(0, 28, 0);

describe('vessel analysis', () => {
  bench('structural pass, 150 parts', () => {
    evaluateStructure(craft150, accel, 15_000, 0.12);
  });

  bench('structural pass, 500 parts', () => {
    evaluateStructure(craft500, accel, 15_000, 0.12);
  });

  bench('mass properties, 500 parts', () => {
    computeMassProperties(craft500);
  });

  bench('full staging analysis (editor readout), 150 parts', () => {
    analyzeCraft(craft150);
  });

  bench('full staging analysis, small craft', () => {
    analyzeCraft(small);
  });
});
