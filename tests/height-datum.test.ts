import { describe, expect, it } from 'vitest';
import {
  KSC_NAVD88_TO_EGM2008,
  kscNavd88ToEgm2008Correction,
} from '../src/render/planetDetail/heightDatum';

describe('KSC NAVD88 to EGM2008 shading datum', () => {
  it('uses the pinned spatial VDatum grid rather than a constant offset', () => {
    expect(KSC_NAVD88_TO_EGM2008.source).toContain('VDatum 4.8');
    expect(kscNavd88ToEgm2008Correction(-80.75, 28.5)).toBeCloseTo(-0.03, 6);
    expect(kscNavd88ToEgm2008Correction(-80.5, 28.75)).toBeCloseTo(-0.079, 6);
    expect(kscNavd88ToEgm2008Correction(-80.625, 28.625)).toBeCloseTo(-0.07, 6);
    expect(new Set(KSC_NAVD88_TO_EGM2008.correctionsMeters).size).toBeGreaterThan(1);
  });

  it('fails closed outside the pinned KSC conversion coverage', () => {
    expect(() => kscNavd88ToEgm2008Correction(-90, 28.6)).toThrow(/outside/i);
  });
});
