import { describe, expect, it } from 'vitest';
import { generateAirlessGlobalMaps } from '../scripts/lib/airless-global-maps';

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
});
