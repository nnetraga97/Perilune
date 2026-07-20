import { describe, expect, it } from 'vitest';
import { bodyFixedUv } from '../src/render/terrestrial/globalCoordinates';

function direction(latitudeDegrees: number, longitudeDegrees: number) {
  const latitude = latitudeDegrees * Math.PI / 180;
  const longitude = longitudeDegrees * Math.PI / 180;
  return {
    x: Math.cos(latitude) * Math.cos(longitude),
    y: Math.cos(latitude) * Math.sin(longitude),
    z: Math.sin(latitude),
  };
}

describe('Sol authored-map landmark convention', () => {
  it('places Greenwich at the texture center and north at row zero', () => {
    expect(bodyFixedUv(direction(0, 0))).toEqual({ u: 0.5, v: 0.5 });
    expect(bodyFixedUv(direction(90, 0)).v).toBeCloseTo(0, 12);
    expect(bodyFixedUv(direction(-90, 0)).v).toBeCloseTo(1, 12);
  });

  it('wraps the antimeridian without moving east-positive landmarks', () => {
    const west = bodyFixedUv(direction(10, -179.999));
    const east = bodyFixedUv(direction(10, 180.001));
    expect(Math.abs(west.u - east.u)).toBeLessThan(1e-10);
    expect(bodyFixedUv(direction(30, 31)).u).toBeGreaterThan(0.5); // North Africa
  });
});
