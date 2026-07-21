import { describe, expect, it } from 'vitest';
import { generateAirlessGlobalMaps, stabilizeAirlessPolarAlbedo, stabilizeAirlessPoleRows } from '../scripts/lib/airless-global-maps';

describe('airless global maps', () => {
  it('keeps packed material data opaque and preserves regolith roughness', () => {
    const width = 8;
    const height = 4;
    const maps = generateAirlessGlobalMaps({
      width,
      height,
      radius: 220_000,
      albedo: new Uint8Array(width * height * 3).fill(180),
      heights: new Float32Array(width * height),
    });

    for (let offset = 0; offset < maps.material.length; offset += 4) {
      expect(maps.material[offset]).toBeGreaterThanOrEqual(184);
      expect(maps.material[offset]).toBeLessThanOrEqual(230);
      expect(maps.material[offset + 1]).toBeGreaterThanOrEqual(204);
      expect(maps.material[offset + 1]).toBeLessThanOrEqual(245);
      expect(maps.material[offset + 2]).toBe(0);
      expect(maps.material[offset + 3]).toBe(255);
    }
  });

  it('encodes a flat sphere as neutral tangent slopes', () => {
    const width = 16;
    const height = 8;
    const maps = generateAirlessGlobalMaps({
      width,
      height,
      radius: 1_737_400,
      albedo: new Uint8Array(width * height * 3).fill(128),
      heights: new Float32Array(width * height),
    });
    for (const value of maps.normal) expect(value).toBe(128);
  });

  it('makes each equirectangular pole row single-valued without mutating the source', () => {
    const source = Float32Array.from([1, 3, 5, 7, 10, 20, 30, 40, -4, -2, 0, 2]);
    const stable = stabilizeAirlessPoleRows(source, 4, 3);
    expect([...stable.slice(0, 4)]).toEqual([4, 4, 4, 4]);
    expect([...stable.slice(4, 8)]).toEqual([10, 20, 30, 40]);
    expect([...stable.slice(8, 12)]).toEqual([-1, -1, -1, -1]);
    expect(source[0]).toBe(1);
  });

  it('makes the polar albedo endpoint single-valued without altering equatorial identity', () => {
    const width = 360;
    const height = 180;
    const source = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) source[(y * width + x) * 3] = x % 256;
    }
    const stable = stabilizeAirlessPolarAlbedo(source, width, height);
    expect(new Set(Array.from({ length: width }, (_, x) => stable[x * 3])).size).toBe(1);
    const equator = Math.floor(height / 2) * width * 3;
    expect(stable.slice(equator, equator + width * 3)).toEqual(source.slice(equator, equator + width * 3));
    expect(source[3]).toBe(1);
  });
});
