import { describe, expect, it } from 'vitest';
import { adaptExposure, environmentLighting } from '../src/render/exposurePolicy';

describe('Sol exposure policy', () => {
  it('keeps atmospheric daylight brighter than night without blue ambient on the Moon', () => {
    const day = environmentLighting('terrestrial', 100_000, 0, 1, 1, false);
    const night = environmentLighting('terrestrial', 100_000, 0, 0, 1, false);
    const moon = environmentLighting('airless', 0, 0, 1, 1, false);
    expect(day.intensity).toBeGreaterThan(night.intensity);
    expect(moon.intensity).toBeLessThan(0.03);
    expect(day.exposure).toBeGreaterThanOrEqual(0.6);
  });

  it('adapts by wall time and clamps pathological targets', () => {
    expect(adaptExposure(1, 0.6, 0)).toBe(1);
    expect(adaptExposure(1, 0.6, 1 / 60)).toBeLessThan(1);
    expect(adaptExposure(1, 100, 10)).toBeLessThanOrEqual(1.35);
  });
});
