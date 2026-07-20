import { describe, expect, it } from 'vitest';
import {
  reprojectEquirectAtlasToCubePage,
  reprojectHeightAtlasToCubeNormalPage,
} from '../src/render/planetDetail/cubePageReprojector';
import { createTerrainTileId } from '../src/render/terrain/tile';

function globalAtlas(width = 720, height = 360) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    pixels[offset] = Math.round(x / (width - 1) * 255);
    pixels[offset + 1] = Math.round(y / (height - 1) * 255);
    pixels[offset + 2] = 127;
    pixels[offset + 3] = 255;
  }
  return { pixels, width, height, matrixWidth: 1, matrixHeight: 1, startColumn: 0, startRow: 0, gridWidth: 1, gridHeight: 1 };
}

describe('cube page reprojection', () => {
  it('builds a complete page with a real neighbor gutter', () => {
    const page = reprojectEquirectAtlasToCubePage(globalAtlas(), createTerrainTileId(0, 0, 0, 0), 32, 2);
    expect(page.width).toBe(36);
    expect(page.height).toBe(36);
    expect(page.pixels.length).toBe(36 * 36 * 4);
    for (let index = 3; index < page.pixels.length; index += 4) expect(page.pixels[index]).toBe(255);
    const gutterPixel = Array.from(page.pixels.slice(0, 4));
    const edgePixel = Array.from(page.pixels.slice((2 * 36 + 2) * 4, (2 * 36 + 2) * 4 + 4));
    expect(gutterPixel).not.toEqual(edgePixel);
  });

  it('keeps adjacent cube faces continuous within one source texel', () => {
    const atlas = globalAtlas(1440, 720);
    const size = 64;
    const gutter = 2;
    const face0 = reprojectEquirectAtlasToCubePage(atlas, createTerrainTileId(0, 0, 0, 0), size, gutter);
    const face2 = reprojectEquirectAtlasToCubePage(atlas, createTerrainTileId(2, 0, 0, 0), size, gutter);
    for (let along = 4; along < size - 4; along++) {
      const a = ((gutter + along) * face0.width + gutter + size - 1) * 4;
      const b = ((gutter + size - 1) * face2.width + gutter + along) * 4;
      expect(Math.abs(face0.pixels[a] - face2.pixels[b])).toBeLessThanOrEqual(2);
      expect(Math.abs(face0.pixels[a + 1] - face2.pixels[b + 1])).toBeLessThanOrEqual(2);
    }
  });

  it('retains a zero-alpha validity mask outside a bounded source atlas', () => {
    const pixels = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    const page = reprojectEquirectAtlasToCubePage({
      pixels,
      width: 64,
      height: 64,
      matrixWidth: 4,
      matrixHeight: 2,
      startColumn: 2,
      startRow: 0,
      gridWidth: 1,
      gridHeight: 1,
    }, createTerrainTileId(0, 0, 0, 0), 32, 2);
    const alpha = Array.from({ length: page.width * page.height }, (_, index) => page.pixels[index * 4 + 3]);
    expect(alpha).toContain(0);
    expect(alpha).toContain(255);
  });

  it('derives outward shading normals directly from scalar metre samples', () => {
    const width = 361;
    const height = 181;
    const values = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      values[y * width + x] = x * 20;
    }
    const page = reprojectHeightAtlasToCubeNormalPage({
      values, width, height, boundsDegrees: [-180, -90, 180, 90],
    }, createTerrainTileId(0, 2, 1, 1), 6_378_137, 32, 2);
    expect(page.validFraction).toBeGreaterThan(0.9);
    expect(page.maximumHeightMeters).toBeGreaterThan(page.minimumHeightMeters);
    expect(page.sourceCellMeters).toBeGreaterThan(0);
    const center = ((Math.floor(page.height / 2) * page.width) + Math.floor(page.width / 2)) * 4;
    expect(page.pixels[center + 3]).toBe(255);
    // Face 0 radial points mostly +X. An eastward scalar slope must create a
    // measurable tangent component instead of reproducing the radial normal.
    expect(page.pixels[center + 1]).not.toBe(128);
  });
});
