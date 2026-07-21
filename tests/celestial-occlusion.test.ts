import { describe, expect, it } from 'vitest';
import { celestialOcclusion } from '../src/render/celestialOcclusion';

describe('celestial occultation', () => {
  it('reports disjoint, partial, annular, and total disk coverage', () => {
    const source = { direction: { x: 1, y: 0, z: 0 }, angularRadius: 0.01 };
    expect(celestialOcclusion(source, {
      direction: { x: Math.cos(0.03), y: Math.sin(0.03), z: 0 },
      angularRadius: 0.01,
    })).toMatchObject({ intersects: false, sourceVisibleFraction: 1 });

    const partial = celestialOcclusion(source, {
      direction: { x: Math.cos(0.01), y: Math.sin(0.01), z: 0 },
      angularRadius: 0.01,
    });
    expect(partial.intersects).toBe(true);
    expect(partial.sourceVisibleFraction).toBeGreaterThan(0);
    expect(partial.sourceVisibleFraction).toBeLessThan(1);

    const annular = celestialOcclusion(source, {
      direction: { x: 1, y: 0, z: 0 }, angularRadius: 0.005,
    });
    expect(annular.sourceVisibleFraction).toBeCloseTo(0.75, 8);
    expect(annular.total).toBe(false);

    expect(celestialOcclusion(source, {
      direction: { x: 1, y: 0, z: 0 }, angularRadius: 0.02,
    })).toMatchObject({ total: true, sourceVisibleFraction: 0 });
  });
});
