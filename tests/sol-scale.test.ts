import { describe, expect, it } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { CHECKED_SOL_CONSTANTS } from '../src/generated/checked-sol-constants';
import { angularRadius } from '../src/render/celestialProjection';
import { Universe } from '../src/sim/universe';

describe('physical Sol scale', () => {
  const universe = new Universe([...SOL_SYSTEM], 'earth');

  it('uses checked physical body radii and orbital spacing', () => {
    expect(universe.get('sun').radius).toBe(CHECKED_SOL_CONSTANTS.bodies.sun.meanRadiusMeters);
    expect(universe.get('mercury').radius).toBe(CHECKED_SOL_CONSTANTS.bodies.mercury.meanRadiusMeters);
    expect(universe.get('venus').radius).toBe(CHECKED_SOL_CONSTANTS.bodies.venus.meanRadiusMeters);
    expect(universe.get('earth').radius).toBe(CHECKED_SOL_CONSTANTS.bodies.earth.meanRadiusMeters);
    expect(universe.get('moon').radius).toBe(CHECKED_SOL_CONSTANTS.bodies.moon.meanRadiusMeters);
    expect(universe.get('mars').radius).toBe(CHECKED_SOL_CONSTANTS.bodies.mars.meanRadiusMeters);
    expect(universe.get('earth').orbit?.a).toBe(CHECKED_SOL_CONSTANTS.bodies.earth.orbit.semiMajorAxisMeters);
    expect(universe.get('mercury').orbit?.a).toBe(CHECKED_SOL_CONSTANTS.bodies.mercury.orbit.semiMajorAxisMeters);
    expect(universe.get('venus').orbit?.a).toBe(CHECKED_SOL_CONSTANTS.bodies.venus.orbit.semiMajorAxisMeters);
    expect(universe.get('moon').orbit?.a).toBe(CHECKED_SOL_CONSTANTS.bodies.moon.orbit.semiMajorAxisMeters);
    expect(universe.get('mars').orbit?.a).toBe(CHECKED_SOL_CONSTANTS.bodies.mars.orbit.semiMajorAxisMeters);
    expect(universe.get('mars').orbit!.a * (1 - universe.get('mars').orbit!.e))
      .toBeGreaterThan(universe.get('earth').orbit!.a * (1 + universe.get('earth').orbit!.e));
    expect(universe.get('mercury').orbit!.a * (1 + universe.get('mercury').orbit!.e))
      .toBeLessThan(universe.get('venus').orbit!.a * (1 - universe.get('venus').orbit!.e));
    expect(universe.get('venus').orbit!.a * (1 + universe.get('venus').orbit!.e))
      .toBeLessThan(universe.get('earth').orbit!.a * (1 - universe.get('earth').orbit!.e));
  });

  it('keeps the solar disk near half a degree at Earth distance', () => {
    const diameterDegrees = angularRadius(
      universe.get('sun').radius,
      CHECKED_SOL_CONSTANTS.astronomicalUnitMeters,
    ) * 2 * 180 / Math.PI;
    expect(diameterDegrees).toBeGreaterThan(0.52);
    expect(diameterDegrees).toBeLessThan(0.54);
  });

  it('fits Moon apogee and body margins inside the fixed physical far plane', () => {
    const moon = universe.get('moon');
    const earth = universe.get('earth');
    const maximumEnvelope = moon.orbit!.a * (1 + moon.orbit!.e) + moon.radius + earth.radius;
    expect(maximumEnvelope).toBeLessThan(6e8);
    expect(6e8 - maximumEnvelope).toBeGreaterThan(1.8e8);
  });
});
