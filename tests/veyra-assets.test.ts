import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState } from '../src/sim/state';
import { solidHeight } from '../src/sim/terrain';
import * as veyraMaps from '../scripts/lib/veyra-global-maps';

describe('Veyra authored asset contracts', () => {
  it('uses a direction-space source sampler with exact seam and pole identity', () => {
    const sampler = (veyraMaps as typeof veyraMaps & {
      sampleVeyraSourceDetail?: (
        source: veyraMaps.RawRaster,
        direction: Readonly<Vec3>,
      ) => number;
    }).sampleVeyraSourceDetail;
    expect(typeof sampler).toBe('function');
    if (!sampler) return;
    const sourceData = new Uint8Array(64 * 32 * 3);
    for (let index = 0; index < sourceData.length; index++) sourceData[index] = (index * 31 + 7) & 0xff;
    const source: veyraMaps.RawRaster = { data: sourceData, width: 64, height: 32, channels: 3 };
    const seamAbove = new Vec3(-1, 1e-12, 0).normalize();
    const seamBelow = new Vec3(-1, -1e-12, 0).normalize();
    expect(Math.abs(sampler(source, seamAbove) - sampler(source, seamBelow))).toBeLessThanOrEqual(2);
    const northA = new Vec3(1e-12, 0, 1).normalize();
    const northB = new Vec3(0, -1e-12, 1).normalize();
    const southA = new Vec3(-1e-12, 0, -1).normalize();
    const southB = new Vec3(0, 1e-12, -1).normalize();
    expect(Math.abs(sampler(source, northA) - sampler(source, northB))).toBeLessThanOrEqual(2);
    expect(Math.abs(sampler(source, southA) - sampler(source, southB))).toBeLessThanOrEqual(2);
  });

  it('encodes a graded one-texel shoreline while preserving the authoritative sign', () => {
    const width = 144;
    const height = 72;
    const veyra = new GameState().universe.get('veyra');
    const source = new Uint8Array(width * height * 3).fill(128);
    const maps = veyraMaps.generateVeyraCanonicalMaps({
      width,
      height,
      source: { data: source, width, height, channels: 3 },
      radius: veyra.radius,
      heightAt: (direction) => {
        const result = solidHeight(veyra, direction);
        if (result.kind !== 'solid') throw new Error('expected solid Veyra terrain');
        return result.height;
      },
      seed: veyra.def.terrain.seed,
    });
    const masks = Array.from({ length: width * height }, (_, pixel) => maps.material[pixel * 4 + 3]);
    expect(masks.some((mask) => mask > 0 && mask < 255)).toBe(true);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const direction = veyraMaps.directionFromEquirectUv((x + 0.5) / width, (y + 0.5) / height);
        const surface = solidHeight(veyra, direction);
        if (surface.kind !== 'solid' || Math.abs(surface.height) <= maps.texelHeightRange) continue;
        expect(maps.material[(y * width + x) * 4 + 3] > 127).toBe(surface.height < 0);
      }
    }
  });

});
