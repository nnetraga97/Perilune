import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { adaptExposure, environmentLighting, landingVisibilityAid } from '../src/render/exposurePolicy';
import { SPACE_BACKGROUND } from '../src/render/spaceBackground';

describe('Sol exposure policy', () => {
  it('keeps atmospheric daylight brighter than night without blue ambient on the Moon', () => {
    const day = environmentLighting('terrestrial', 100_000, 0, 1, 1, false);
    const night = environmentLighting('terrestrial', 100_000, 0, 0, 1, false);
    const moon = environmentLighting('airless', 0, 0, 1, 1, false);
    expect(day.intensity).toBeGreaterThan(night.intensity);
    expect(moon.intensity).toBeLessThan(0.03);
    expect(day.exposure).toBeGreaterThanOrEqual(0.6);
  });

  it('keeps one sRGB-defined neutral space background across bodies and altitude', () => {
    const expected = new THREE.Color(SPACE_BACKGROUND);
    const earthSurfaceDay = environmentLighting('terrestrial', 100_000, 0, 1, 1, false);
    const earthOrbitNight = environmentLighting('terrestrial', 100_000, 500_000, 0, 1, false);
    const moon = environmentLighting('airless', 0, 10_000, 1, 1, false);
    const fallback = environmentLighting(undefined, 0, 0, 0, 1, false);

    for (const environment of [earthSurfaceDay, earthOrbitNight, moon, fallback]) {
      expect(environment.background.equals(expected)).toBe(true);
      expect(environment.background.getHexString(THREE.SRGBColorSpace)).toBe('020304');
    }
    expect(earthSurfaceDay.sky.equals(earthOrbitNight.sky)).toBe(false);
  });

  it('adapts by wall time and clamps pathological targets', () => {
    expect(adaptExposure(1, 0.6, 0)).toBe(1);
    expect(adaptExposure(1, 0.6, 1 / 60)).toBeLessThan(1);
    expect(adaptExposure(1, 100, 10)).toBeLessThanOrEqual(1.35);
  });

  it('adds local landing visibility only for dark, low solid-body approaches', () => {
    const moonNight = landingVisibilityAid('solid', 5_000, -1, 1);
    expect(moonNight.intensity).toBeGreaterThan(2);
    expect(moonNight.distance).toBeGreaterThan(5_000);

    expect(landingVisibilityAid('solid', 5_000, 1, 1).intensity).toBe(0);
    expect(landingVisibilityAid('solid', 150_000, -1, 1).intensity).toBe(0);
    expect(landingVisibilityAid('gas', 5_000, -1, 1).intensity).toBe(0);
    expect(landingVisibilityAid('star', 5_000, -1, 1).intensity).toBe(0);
  });

  it('treats a solar eclipse as darkness for landing visibility', () => {
    expect(landingVisibilityAid('solid', 10_000, 1, 0).intensity).toBeGreaterThan(0);
  });
});
