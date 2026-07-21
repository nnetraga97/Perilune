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
    expect(CHECKED_SOL_CONSTANTS.bodies.earth.meanRadiusMeters).toBeCloseTo(6_371_008.3667, 4);
    expect(CHECKED_SOL_CONSTANTS.bodies.moon.meanRadiusMeters).toBe(1_737_400);
    expect(CHECKED_SOL_CONSTANTS.bodies.earth.gmMeters3PerSecond2).toBeGreaterThan(3.98e14);
    expect(CHECKED_SOL_CONSTANTS.bodies.moon.gmMeters3PerSecond2).toBeGreaterThan(4.9e12);
  });
});
