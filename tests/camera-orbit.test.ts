import { describe, expect, it } from 'vitest';
import { wrapOrbitAngle } from '../src/core/cameraOrbit';

describe('wrapOrbitAngle', () => {
  it('allows pitch to pass through both camera poles', () => {
    expect(wrapOrbitAngle(Math.PI / 2 + 0.1)).toBeCloseTo(Math.PI / 2 + 0.1);
    expect(wrapOrbitAngle(-Math.PI / 2 - 0.1)).toBeCloseTo(-Math.PI / 2 - 0.1);
  });

  it('wraps complete revolutions without clamping', () => {
    expect(wrapOrbitAngle(Math.PI * 2 + 0.35)).toBeCloseTo(0.35);
    expect(wrapOrbitAngle(-Math.PI * 2 - 0.35)).toBeCloseTo(-0.35);
  });
});
