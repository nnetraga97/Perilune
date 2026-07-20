import { describe, expect, it } from 'vitest';
import baseline from '../docs/performance/reference/sol-source-authority-baseline-2026-07.json';
import oracles from '../assets/planets/classification/surface-class-oracles.json';

describe('pre-correction Earth surface-class oracle', () => {
  it('pins source-backed land, ocean, estuary, intertidal, inland-water, and wetland controls', () => {
    expect(oracles.codes).toEqual({
      unknown: 0,
      land: 1,
      openOcean: 2,
      estuarineDeepwater: 3,
      intertidal: 4,
      inlandWater: 5,
      wetland: 6,
    });
    const sourceControls = oracles.points.filter((point) => !point.id.includes('fixture'));
    expect(new Set(sourceControls.map((point) => point.expectedCode))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(sourceControls.find((point) => point.id === 'lc39b-pad')?.expectedCode).toBe(1);
    expect(sourceControls.find((point) => point.id === 'atlantic-open-ocean')?.expectedCode).toBe(2);
  });

  it('records tier-dependent legacy mask evidence without accepting it as class', () => {
    const earth = baseline.controls.filter((point) => point.bodyId === 'earth');
    expect(earth.length).toBeGreaterThan(0);
    for (const point of earth) {
      for (const tier of ['low', 'medium', 'high'] as const) {
        expect(point.tiers[tier].legacyOceanByte).toBeGreaterThanOrEqual(0);
        expect(point.tiers[tier].legacyOceanByte).toBeLessThanOrEqual(255);
      }
    }
    const ksc = earth.find((point) => point.id === 'earth-ksc-diagnostic')!;
    expect(ksc.source.heightMeters).toBeGreaterThan(0);
    expect(new Set([
      ksc.tiers.low.legacyOceanByte,
      ksc.tiers.medium.legacyOceanByte,
      ksc.tiers.high.legacyOceanByte,
    ]).size).toBeGreaterThan(1);
  });
});
