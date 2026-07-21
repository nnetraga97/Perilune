import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  adaptExposure,
  environmentLighting,
  localShadowPolicy,
  snapShadowCenter,
} from '../src/render/lightingPolicy';

describe('flight lighting policy', () => {
  it('disables real-time shadows on Low and scales Medium/High maps locally', () => {
    expect(localShadowPolicy('low', 20, 0).enabled).toBe(false);
    expect(localShadowPolicy('medium', 20, 0)).toMatchObject({ enabled: true, mapSize: 1024 });
    expect(localShadowPolicy('high', 20, 0)).toMatchObject({ enabled: true, mapSize: 2048 });
    expect(localShadowPolicy('high', 20, 1e9).extent).toBe(18_000);
  });

  it('snaps only the light-plane coordinates to stable texels', () => {
    const direction = new THREE.Vector3(1, 0, 0);
    const center = new THREE.Vector3(3.25, 1.11, 2.26);
    const snapped = snapShadowCenter(center, direction, 100, 100);
    expect(snapped.x).toBeCloseTo(center.x);
    expect(snapped.y % 2).toBeCloseTo(0);
    expect(snapped.z % 2).toBeCloseTo(0);
  });

  it('uses atmospheric fill for Earth but near-black fill for the Moon', () => {
    const earthDay = environmentLighting('terrestrial', 100_000, 0, 1, 1, false);
    const earthNight = environmentLighting('terrestrial', 100_000, 0, 0, 1, false);
    const moon = environmentLighting('airless', 0, 0, 1, 1, false);
    expect(earthDay.intensity).toBeGreaterThan(earthNight.intensity);
    expect(earthNight.intensity).toBeLessThan(0.1);
    expect(moon.intensity).toBeLessThan(0.05);
    expect(moon.exposure).toBeGreaterThan(earthDay.exposure);
  });

  it('adapts from wall-clock delta and clamps display exposure', () => {
    expect(adaptExposure(1, 0.6, 0)).toBe(1);
    expect(adaptExposure(1, 0.6, 1 / 60)).toBeLessThan(1);
    expect(adaptExposure(1, 100, 10)).toBeLessThanOrEqual(1.35);
  });
});
