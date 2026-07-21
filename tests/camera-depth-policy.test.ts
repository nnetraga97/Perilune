import { describe, expect, it } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { Universe } from '../src/sim/universe';

describe('Earth-Moon fixed camera depth envelope', () => {
  it('keeps every physical Earth-Moon extent below 600,000 km', () => {
    const universe = new Universe([...SOL_SYSTEM], 'earth');
    const earth = universe.get('earth');
    const moon = universe.get('moon');
    const apogee = moon.orbit!.a * (1 + moon.orbit!.e);
    const fullExtent = apogee + moon.radius + earth.radius;
    expect(fullExtent).toBeLessThan(600_000_000);
  });
});
