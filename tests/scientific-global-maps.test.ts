import { describe, expect, it } from 'vitest';
import {
  decodeMacroHeight,
  encodeMacroHeight,
  generateEarthGlobalMaps,
} from '../scripts/lib/scientific-global-maps';

describe('scientific global map derivation', () => {
  it('round-trips the full supported signed macro-height range', () => {
    const source = new Float32Array([-12_000, -4_000, 0, 8_848, 12_000]);
    const encoded = encodeMacroHeight(source);
    source.forEach((height, index) => {
      expect(decodeMacroHeight(encoded[index * 2], encoded[index * 2 + 1])).toBeCloseTo(height, 0);
    });
  });

  it('derives ocean and grounded-ice masks from ETOPO values, not color', () => {
    const maps = generateEarthGlobalMaps({
      width: 2,
      height: 1,
      radius: 6_371_008.4,
      albedo: new Uint8Array([10, 20, 30, 10, 20, 30]),
      surfaceHeights: new Float32Array([-100, 1_000]),
      bedrockHeights: new Float32Array([-100, 500]),
      cloudLuminance: new Uint8Array([0, 255]),
      nightColor: new Uint8Array([0, 0, 0, 255, 180, 100]),
    });
    expect(maps.material[2]).toBe(255);
    expect(maps.material[3]).toBe(0);
    expect(maps.material[6]).toBe(0);
    expect(maps.material[7]).toBeGreaterThan(240);
    expect(maps.clouds).toEqual(new Uint8Array([0, 0, 255, 255]));
    expect(maps.emissive?.[3]).toBeGreaterThan(0);
  });
});
