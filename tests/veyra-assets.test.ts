import { createLegacyGameState } from './fixtures/legacyGameState';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState } from '../src/sim/state';
import { solidHeight } from '../src/sim/terrain';
import * as veyraMaps from '../scripts/lib/veyra-global-maps';
import { expandLogicalRgToRgb, resizeLogicalRg } from '../scripts/lib/rg-image';

describe('Veyra authored asset contracts', () => {
  it('resizes logical RG channels independently and expands a true RGB fallback', async () => {
    const width = 8;
    const height = 4;
    const logicalRg = new Uint8Array(width * height * 2);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixel = y * width + x;
        logicalRg[pixel * 2] = y * 60;
        logicalRg[pixel * 2 + 1] = x * 30;
      }
    }
    const resized = await resizeLogicalRg(logicalRg, width, height, 13, 7);
    for (let y = 0; y < 7; y++) {
      const rowRed = resized[(y * 13) * 2];
      for (let x = 0; x < 13; x++) expect(resized[(y * 13 + x) * 2]).toBe(rowRed);
    }
    for (let x = 0; x < 13; x++) {
      const columnGreen = resized[x * 2 + 1];
      for (let y = 0; y < 7; y++) expect(resized[(y * 13 + x) * 2 + 1]).toBe(columnGreen);
    }
    expect(resized[(6 * 13) * 2]).toBeGreaterThan(resized[0]);
    expect(resized[(13 - 1) * 2 + 1]).toBeGreaterThan(resized[1]);
    const rgb = expandLogicalRgToRgb(resized, 13, 7);
    for (let pixel = 0; pixel < 13 * 7; pixel++) {
      expect(rgb[pixel * 3]).toBe(resized[pixel * 2]);
      expect(rgb[pixel * 3 + 1]).toBe(resized[pixel * 2 + 1]);
      expect(rgb[pixel * 3 + 2]).toBe(0);
    }
  });

  it('ships the cloud fallback as truecolor logical RG data', async () => {
    const cloudPath = resolve('assets/planets/generated/veyra/low/clouds.png');
    const metadata = await sharp(cloudPath).metadata();
    expect(metadata.channels).toBe(3);
    expect(metadata.isPalette).toBe(false);
    const sample = await sharp(readFileSync(cloudPath)).extract({ left: 0, top: 0, width: 64, height: 32 }).raw().toBuffer();
    for (let pixel = 0; pixel < 64 * 32; pixel++) expect(sample[pixel * 3 + 2]).toBe(0);
  });

  it('ships cloud fields without scanline-biased channel corruption', async () => {
    const { data, info } = await sharp(resolve('assets/planets/generated/veyra/low/clouds.png'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (const channel of [0, 1]) {
      let horizontalVariation = 0;
      let verticalVariation = 0;
      let horizontalSamples = 0;
      let verticalSamples = 0;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          const offset = (y * info.width + x) * info.channels + channel;
          if (x > 0) {
            horizontalVariation += Math.abs(data[offset] - data[offset - info.channels]);
            horizontalSamples++;
          }
          if (y > 0) {
            verticalVariation += Math.abs(data[offset] - data[offset - info.width * info.channels]);
            verticalSamples++;
          }
        }
      }
      const axisVariationRatio = (verticalVariation / verticalSamples) / (horizontalVariation / horizontalSamples);
      expect(axisVariationRatio).toBeLessThan(4);
    }
  });

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

  it('preserves authored RGB separation instead of collapsing the source to luminance', () => {
    const width = 16;
    const height = 8;
    const sourceData = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3;
        const redHalf = x < width / 2;
        sourceData[offset] = redHalf ? 230 : 20;
        sourceData[offset + 1] = 30;
        sourceData[offset + 2] = redHalf ? 20 : 230;
      }
    }
    const source: veyraMaps.RawRaster = { data: sourceData, width, height, channels: 3 };
    const red = veyraMaps.sampleVeyraSourceColor(source, new Vec3(0, 0, -1));
    const blue = veyraMaps.sampleVeyraSourceColor(source, new Vec3(0, 0, 1));
    expect(red.r).toBeGreaterThan(red.b * 4);
    expect(blue.b).toBeGreaterThan(blue.r * 4);
  });

  it('carries source chroma through the generated land albedo', () => {
    const width = 32;
    const height = 16;
    const generate = (rgb: readonly [number, number, number]) => {
      const source = new Uint8Array(width * height * 3);
      for (let offset = 0; offset < source.length; offset += 3) source.set(rgb, offset);
      return veyraMaps.generateVeyraCanonicalMaps({
        width,
        height,
        source: { data: source, width, height, channels: 3 },
        radius: 600_000,
        heightAt: () => 1_000,
        seed: 42,
      }).albedo;
    };
    const redSource = generate([220, 50, 50]);
    const blueSource = generate([50, 50, 220]);
    const channelMean = (pixels: Uint8Array, channel: 0 | 1 | 2) => {
      let total = 0;
      for (let offset = channel; offset < pixels.length; offset += 3) total += pixels[offset];
      return total / (pixels.length / 3);
    };
    const redRatio = channelMean(redSource, 0) / channelMean(redSource, 2);
    const blueRatio = channelMean(blueSource, 0) / channelMean(blueSource, 2);
    expect(redRatio).toBeGreaterThan(blueRatio * 1.2);
  });

  it('encodes a graded one-texel shoreline while preserving the authoritative sign', () => {
    const width = 144;
    const height = 72;
    const veyra = createLegacyGameState().universe.get('veyra');
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
