import { describe, expect, it } from 'vitest';
import {
  ENTRY_FLUX_REFERENCE,
  rawEntryStrength,
  stepReentrySignal,
  transonicStrength,
} from '../src/render/reentrySignal';

describe('reentry signal', () => {
  it('maps heat flux into a bounded strength and responds smoothly', () => {
    expect(rawEntryStrength(-1)).toBe(0);
    expect(rawEntryStrength(ENTRY_FLUX_REFERENCE)).toBe(1);
    expect(rawEntryStrength(ENTRY_FLUX_REFERENCE * 4)).toBe(1);
    const next = stepReentrySignal(
      { strength: 0, transonic: 0 },
      { heatFlux: ENTRY_FLUX_REFERENCE, mach: 6, dynamicPressure: 20_000 },
      1 / 60,
    );
    expect(next.strength).toBeGreaterThan(0);
    expect(next.strength).toBeLessThan(1);
  });

  it('is a pressure-gated transonic band rather than a supersonic ramp', () => {
    expect(transonicStrength(0.5, 10_000, 0)).toBe(0);
    expect(transonicStrength(1.05, 10_000, 0)).toBeGreaterThan(0.8);
    expect(transonicStrength(2.5, 10_000, 0)).toBe(0);
    expect(transonicStrength(1.05, 1, 0)).toBe(0);
    expect(transonicStrength(1.05, 10_000, 1)).toBe(0);
  });
});
