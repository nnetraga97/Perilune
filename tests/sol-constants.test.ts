import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  CHECKED_SOL_CONSTANTS,
  SOL_CONSTANTS_SOURCE_SHA256,
} from '../src/generated/checked-sol-constants';

describe('checked Sol constants', () => {
  it('matches the checked source artifact byte-for-byte', async () => {
    const source = await readFile(new URL('../assets/sol/constants-source.json', import.meta.url));
    expect(createHash('sha256').update(source).digest('hex')).toBe(SOL_CONSTANTS_SOURCE_SHA256);
  });

  it('preserves SI units and source landmarks', () => {
    expect(CHECKED_SOL_CONSTANTS.astronomicalUnitMeters).toBe(149_597_870_700);
    expect(CHECKED_SOL_CONSTANTS.bodies.sun.meanRadiusMeters).toBe(695_700_000);
    expect(CHECKED_SOL_CONSTANTS.bodies.mercury.meanRadiusMeters).toBeCloseTo(2_439_773.3333, 4);
    expect(CHECKED_SOL_CONSTANTS.bodies.venus.meanRadiusMeters).toBe(6_051_800);
    expect(CHECKED_SOL_CONSTANTS.bodies.earth.meanRadiusMeters).toBeCloseTo(6_371_008.3667, 4);
    expect(CHECKED_SOL_CONSTANTS.bodies.moon.meanRadiusMeters).toBe(1_737_400);
    expect(CHECKED_SOL_CONSTANTS.bodies.mars.meanRadiusMeters).toBeCloseTo(3_389_526.6667, 4);
    expect(CHECKED_SOL_CONSTANTS.bodies.jupiter.meanRadiusMeters).toBe(69_946_000);
    expect(CHECKED_SOL_CONSTANTS.bodies.jupiter.equatorialRadiusMeters).toBe(71_492_000);
    expect(CHECKED_SOL_CONSTANTS.bodies.jupiter.polarRadiusMeters).toBe(66_854_000);
    expect(CHECKED_SOL_CONSTANTS.bodies.callisto.meanRadiusMeters).toBe(2_410_300);
    expect(CHECKED_SOL_CONSTANTS.bodies.earth.gmMeters3PerSecond2).toBeGreaterThan(3.98e14);
    expect(CHECKED_SOL_CONSTANTS.bodies.moon.gmMeters3PerSecond2).toBeGreaterThan(4.9e12);
    expect(CHECKED_SOL_CONSTANTS.bodies.mars.gmMeters3PerSecond2).toBeGreaterThan(4.28e13);
    expect(CHECKED_SOL_CONSTANTS.bodies.mercury.gmMeters3PerSecond2).toBeCloseTo(2.20318685514e13, 2);
    expect(CHECKED_SOL_CONSTANTS.bodies.venus.gmMeters3PerSecond2).toBe(324_858_592_000_000);
    expect(CHECKED_SOL_CONSTANTS.bodies.jupiter.gmMeters3PerSecond2).toBeGreaterThan(1.266e17);
    expect(CHECKED_SOL_CONSTANTS.bodies.callisto.gmMeters3PerSecond2).toBeGreaterThan(7.17e12);
    expect(CHECKED_SOL_CONSTANTS.bodies.mercury.orbit.semiMajorAxisMeters).toBe(57_909_226_541.52439);
    expect(CHECKED_SOL_CONSTANTS.bodies.mercury.orbit.eccentricity).toBeCloseTo(0.20563593, 8);
    expect(CHECKED_SOL_CONSTANTS.bodies.venus.orbit.semiMajorAxisMeters).toBe(108_209_474_537.37917);
    expect(CHECKED_SOL_CONSTANTS.bodies.venus.orbit.eccentricity).toBeCloseTo(0.00677672, 8);
    expect(CHECKED_SOL_CONSTANTS.bodies.mars.orbit.semiMajorAxisMeters).toBeGreaterThan(2.27e11);
    expect(CHECKED_SOL_CONSTANTS.bodies.mars.orbit.eccentricity).toBeCloseTo(0.0933941, 7);
    expect(CHECKED_SOL_CONSTANTS.bodies.jupiter.orbit.semiMajorAxisMeters).toBe(778_557_615_696.1257);
    expect(CHECKED_SOL_CONSTANTS.bodies.callisto.orbit.semiMajorAxisMeters).toBe(1_882_772_953.875105);
  });
});
