import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import {
  addPart,
  analyzeCraft,
  computeMassProperties,
  Craft,
  createCraft,
  crossfeedComponent,
  G0,
  partitionStages,
  removeSubtree,
} from '../src/sim/vessel';
import { evaluateStructure, splitAtJoint } from '../src/sim/structure';
import { PARTS, partById } from '../src/content/parts';

/** Build a classic two-stage rocket: pod / chute / tank / engine / dec / tank / tank / engine. */
export function buildTwoStageRocket(): Craft {
  const craft = createCraft('Test Sparrow');
  const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 6.0, z: 0 });
  addPart(craft, 'chute-main', pod.key, 'stack-top', { x: 0, y: 6.7, z: 0 });
  const tankU = addPart(craft, 'tank-s2', pod.key, 'stack-bottom', { x: 0, y: 4.8, z: 0 });
  const engU = addPart(craft, 'eng-ember', tankU.key, 'stack-bottom', { x: 0, y: 3.5, z: 0 });
  const dec = addPart(craft, 'dec-s', engU.key, 'stack-bottom', { x: 0, y: 3.0, z: 0 });
  const tankL1 = addPart(craft, 'tank-s4', dec.key, 'stack-bottom', { x: 0, y: 1.2, z: 0 });
  const engL = addPart(craft, 'eng-pike', tankL1.key, 'stack-bottom', { x: 0, y: -0.8, z: 0 });
  // Stage 0: light lower engine. Stage 1: fire decoupler + light upper engine.
  craft.stages = [
    { partKeys: [engL.key] },
    { partKeys: [dec.key, engU.key] },
  ];
  return craft;
}

/** Procedurally build a big test vessel of ~n parts (stacks + radial boosters). */
export function buildStressVessel(n: number): Craft {
  const craft = createCraft(`Stress-${n}`);
  const pod = addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
  let prev = pod;
  let y = 0;
  let count = craft.parts.length;
  let radialToggle = 0;
  while (count < n) {
    y -= 1.8;
    const tank = addPart(craft, 'tank-s2', prev.key, 'stack-bottom', { x: 0, y, z: 0 });
    count++;
    // Radial clutter: fins, batteries, sidecar tanks
    const radials = ['fin-swift', 'batt-s', 'tank-radial', 'solar-flat'] as const;
    for (let i = 0; i < 4 && count < n; i++) {
      const angle = (i / 4) * Math.PI * 2;
      addPart(
        craft,
        radials[(radialToggle + i) % radials.length],
        tank.key,
        'surface',
        { x: Math.cos(angle) * 0.7, y, z: Math.sin(angle) * 0.7 },
      );
      count++;
    }
    radialToggle++;
    prev = tank;
  }
  const eng = addPart(craft, 'eng-pike', prev.key, 'stack-bottom', { x: 0, y: y - 1.4, z: 0 });
  craft.stages = [{ partKeys: [eng.key] }];
  return craft;
}

describe('craft graph', () => {
  it('partitions and compacts stages without mutating the source plan', () => {
    const stages = [
      { partKeys: [1, 2] },
      { partKeys: [3] },
      { partKeys: [] },
    ];

    expect(partitionStages(stages, 1, new Set([2, 3]))).toEqual({
      retained: {
        stages: [{ partKeys: [1] }],
        currentStage: 1,
      },
      detached: {
        stages: [{ partKeys: [2] }, { partKeys: [3] }],
        currentStage: 1,
      },
    });
    expect(stages).toEqual([
      { partKeys: [1, 2] },
      { partKeys: [3] },
      { partKeys: [] },
    ]);
  });

  it('computes mass properties for a two-stage rocket', () => {
    const craft = buildTwoStageRocket();
    const props = computeMassProperties(craft);
    // Hand-checked wet mass: pod 840+40*4(mono), chute 90, tank-s2 255+1800,
    // ember 470, dec 45, tank-s4 500+3600, pike 1350
    expect(props.mass).toBeCloseTo(840 + 160 + 90 + 255 + 1800 + 470 + 45 + 500 + 3600 + 1350, 0);
    expect(props.dryMass).toBeLessThan(props.mass);
    // CoM should sit somewhere inside the stack span
    expect(props.com.y).toBeGreaterThan(-0.8);
    expect(props.com.y).toBeLessThan(6.7);
    expect(props.inertia.x).toBeGreaterThan(0);
  });

  it('respects decoupler crossfeed boundaries', () => {
    const craft = buildTwoStageRocket();
    const engU = craft.parts.find((p) => p.defId === 'eng-ember')!;
    const pool = crossfeedComponent(craft, engU.key);
    const tankLower = craft.parts.find((p) => p.defId === 'tank-s4')!;
    const tankUpper = craft.parts.find((p) => p.defId === 'tank-s2')!;
    expect(pool.has(tankUpper.key)).toBe(true);
    expect(pool.has(tankLower.key)).toBe(false); // blocked by decoupler
  });

  it('computes two-stage delta-v consistent with the rocket equation', () => {
    const craft = buildTwoStageRocket();
    const analysis = analyzeCraft(craft, 9.42, 0); // vacuum numbers
    expect(analysis.stages.length).toBe(2);
    const s0 = analysis.stages[0];
    const s1 = analysis.stages[1];
    // Stage 0: pike burns lower tank (3600 kg prop reachable... upper tank is
    // behind a decoupler so NOT reachable).
    const m0 = analysis.mass;
    const expected0 = 320 * G0 * Math.log(m0 / (m0 - 3600));
    expect(s0.deltaV).toBeCloseTo(expected0, 0);
    expect(s0.twrStart).toBeGreaterThan(1);
    // Stage 1 drops lower stack then burns upper tank.
    const m1 = s1.massStart;
    const expected1 = 348 * G0 * Math.log(m1 / (m1 - 1800));
    expect(s1.deltaV).toBeCloseTo(expected1, 0);
    expect(analysis.totalDeltaV).toBeGreaterThan(3000); // enough to matter
    expect(analysis.crewCapacity).toBe(1);
    expect(analysis.warnings).toEqual([]);
  });

  it('warns when no control source exists', () => {
    const craft = createCraft('Headless');
    const tank = addPart(craft, 'tank-s1', null, 'root', { x: 0, y: 0, z: 0 });
    addPart(craft, 'eng-colt', tank.key, 'stack-bottom', { x: 0, y: -1, z: 0 });
    const analysis = analyzeCraft(craft);
    expect(analysis.warnings.some((w) => w.includes('control'))).toBe(true);
  });

  it('removes subtrees cleanly including staging references', () => {
    const craft = buildTwoStageRocket();
    const dec = craft.parts.find((p) => p.defId === 'dec-s')!;
    const before = craft.parts.length;
    const removed = removeSubtree(craft, dec.key);
    expect(removed.length).toBe(3); // dec + lower tank + lower engine
    expect(craft.parts.length).toBe(before - 3);
    for (const stage of craft.stages) {
      for (const key of stage.partKeys) {
        expect(craft.parts.some((p) => p.key === key)).toBe(true);
      }
    }
  });
});

describe('structural analysis', () => {
  it('reports low utilization under gentle thrust', () => {
    const craft = buildTwoStageRocket();
    const report = evaluateStructure(craft, new Vec3(0, 20, 0), 0, 0);
    expect(report.failures.length).toBe(0);
    expect(report.maxUtilization).toBeLessThan(0.5);
    expect(report.joints.length).toBe(craft.parts.length - 1);
  });

  it('fails joints under absurd acceleration and reports which one', () => {
    const craft = buildTwoStageRocket();
    const report = evaluateStructure(craft, new Vec3(0, 4000, 0), 0, 0);
    expect(report.failures.length).toBeGreaterThan(0);
    const worst = report.failures[0];
    expect(worst.axialForce).toBeGreaterThan(worst.axialLimit);
  });

  it('adds bending load with dynamic pressure at angle of attack', () => {
    const craft = buildTwoStageRocket();
    const calm = evaluateStructure(craft, new Vec3(0, 30, 0), 0, 0);
    const rough = evaluateStructure(craft, new Vec3(0, 30, 0), 40_000, 0.5);
    expect(rough.maxUtilization).toBeGreaterThan(calm.maxUtilization);
  });

  it('splits at a joint yielding a consistent partition', () => {
    const craft = buildTwoStageRocket();
    const dec = craft.parts.find((p) => p.defId === 'dec-s')!;
    const detached = splitAtJoint(craft, dec.key);
    expect(detached.length).toBe(3);
    // Everything detached must be below the decoupler
    for (const key of detached) {
      const p = craft.parts.find((q) => q.key === key)!;
      expect(p.position.y).toBeLessThanOrEqual(3.0);
    }
  });

  it('handles a 150-part vessel and a 500-part vessel without failure artifacts', () => {
    for (const n of [150, 500]) {
      const craft = buildStressVessel(n);
      expect(craft.parts.length).toBeGreaterThanOrEqual(n);
      const report = evaluateStructure(craft, new Vec3(0, 25, 0), 12_000, 0.1);
      expect(report.joints.length).toBe(craft.parts.length - 1);
      expect(Number.isFinite(report.maxUtilization)).toBe(true);
      const analysis = analyzeCraft(craft);
      expect(Number.isFinite(analysis.totalDeltaV)).toBe(true);
      expect(analysis.mass).toBeGreaterThan(0);
    }
  });

  it('parts catalog has at least 35 valid entries with sane data', () => {
    expect(PARTS.length).toBeGreaterThanOrEqual(35);
    for (const def of PARTS) {
      expect(def.massDry).toBeGreaterThan(0);
      expect(def.maxTemp).toBeGreaterThan(500);
      expect(def.shape.height).toBeGreaterThan(0);
      expect(partById(def.id)).toBe(def);
      if (def.engine) {
        expect(def.engine.ispVac).toBeGreaterThan(0);
        expect(def.engine.thrustVac).toBeGreaterThan(0);
      }
    }
  });
});
