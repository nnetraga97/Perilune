import { describe, expect, it } from 'vitest';
import baseline from '../docs/performance/reference/sol-source-authority-baseline-2026-07.json';

function control(id: string) {
  const point = baseline.controls.find((candidate) => candidate.id === id);
  if (!point) throw new Error(`Missing source-height control ${id}`);
  return point;
}

describe('pre-correction Sol height oracles', () => {
  it('records raw source, every resident derivative, CPU authority, and contact separately', () => {
    for (const point of baseline.controls) {
      expect(point.source.heightMeters).toBeTypeOf('number');
      expect(point.tiers).toHaveProperty('low.heightMeters');
      expect(point.tiers).toHaveProperty('medium.heightMeters');
      expect(point.tiers).toHaveProperty('high.heightMeters');
      expect(point.cpuMacroHeightMeters).toBeTypeOf('number');
      expect(point.recipeContactHeightMeters).toBeTypeOf('number');
    }
  });

  it('reproduces the KSC sign disagreement before changing authority', () => {
    const ksc = control('earth-ksc-diagnostic');
    expect(ksc.source.heightMeters).toBeGreaterThan(0);
    expect(ksc.tiers.medium.heightMeters).toBeLessThan(0);
    expect(ksc.tiers.high.heightMeters).toBeGreaterThan(0);
    expect(ksc.cpuMacroHeightMeters).toBeLessThan(0);
  });

  it('records the lunar south-pole downsample error independently', () => {
    const pole = control('moon-south-polar-reference');
    expect(Math.abs(pole.cpuMacroHeightMeters - pole.source.heightMeters)).toBeGreaterThan(500);
  });

  it('contains every required authority transect', () => {
    expect(baseline.transects.map((transect) => transect.id)).toEqual([
      'earth-ksc-coast', 'moon-equatorial-relief', 'moon-south-pole-relief',
    ]);
    expect(baseline.transects.every((transect) => transect.points.length >= 7)).toBe(true);
  });
});
