import { describe, expect, it } from 'vitest';
import { KSC_3DEP_HEIGHT, MOON_LOLA_HEIGHT } from '../src/render/planetDetail/heightSourceAdapter';
import { decodeFloat32Tiff } from '../src/render/planetDetail/numericTiff';

function floatStripTiff(width: number, height: number, values: readonly number[], compression = 1): ArrayBuffer {
  const entries: ReadonlyArray<readonly [number, number, number]> = [
    [256, 4, width], [257, 4, height], [258, 3, 32], [259, 3, compression], [262, 3, 1],
    [273, 4, 134], [277, 3, 1], [278, 4, height], [279, 4, width * height * 4], [339, 3, 3],
  ];
  const buffer = new ArrayBuffer(134 + width * height * 4);
  const view = new DataView(buffer);
  view.setUint8(0, 0x49); view.setUint8(1, 0x49); view.setUint16(2, 42, true); view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, value], index) => {
    const offset = 10 + index * 12;
    view.setUint16(offset, tag, true); view.setUint16(offset + 2, type, true); view.setUint32(offset + 4, 1, true);
    if (type === 3) view.setUint16(offset + 8, value, true); else view.setUint32(offset + 8, value, true);
  });
  view.setUint32(130, 0, true);
  values.forEach((value, index) => view.setFloat32(134 + index * 4, value, true));
  return buffer;
}

function floatTileTiff(): ArrayBuffer {
  const dataOffset = 158;
  const entries: ReadonlyArray<readonly [number, number, number]> = [
    [256, 4, 2], [257, 4, 2], [258, 3, 32], [259, 3, 1], [262, 3, 1], [277, 3, 1],
    [284, 3, 1], [322, 4, 4], [323, 4, 4], [324, 4, dataOffset], [325, 4, 64], [339, 3, 3],
  ];
  const buffer = new ArrayBuffer(dataOffset + 64);
  const view = new DataView(buffer);
  view.setUint8(0, 0x49); view.setUint8(1, 0x49); view.setUint16(2, 42, true); view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, value], index) => {
    const offset = 10 + index * 12;
    view.setUint16(offset, tag, true); view.setUint16(offset + 2, type, true); view.setUint32(offset + 4, 1, true);
    if (type === 3) view.setUint16(offset + 8, value, true); else view.setUint32(offset + 8, value, true);
  });
  const tile = [1, 2, 99, 99, 3, 4, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
  tile.forEach((value, index) => view.setFloat32(dataOffset + index * 4, value, true));
  return buffer;
}

describe('numeric TIFF source boundary', () => {
  it('decodes only bounded uncompressed single-channel Float32 data', () => {
    const decoded = decodeFloat32Tiff(floatStripTiff(3, 2, [-4.5, 0, 8.25, 12, 16.5, 32]));
    expect(decoded).toMatchObject({ width: 3, height: 2 });
    expect(Array.from(decoded.values)).toEqual([-4.5, 0, 8.25, 12, 16.5, 32]);
    expect(Array.from(decodeFloat32Tiff(floatTileTiff()).values)).toEqual([1, 2, 3, 4]);
    expect(() => decodeFloat32Tiff(floatStripTiff(1, 1, [0]), 0)).toThrow(/dimensions exceed/);
    expect(() => decodeFloat32Tiff(floatStripTiff(1, 1, [0], 5))).toThrow(/uncompressed/);
  });

  it('keeps sparse ArcGIS tile handling behind the authoring-only option', () => {
    const sparse = floatTileTiff();
    const view = new DataView(sparse);
    view.setUint32(10 + 9 * 12 + 8, 0, true);
    view.setUint32(10 + 10 * 12 + 8, 0, true);
    expect(() => decodeFloat32Tiff(sparse)).toThrow(/payload is truncated/);
    expect(Array.from(decodeFloat32Tiff(sparse, 16, { allowSparseTiles: true }).values)
      .every(Number.isNaN)).toBe(true);
  });

  it('constructs locked 3DEP and LOLA numeric exports without caller-controlled operations', () => {
    const earth = KSC_3DEP_HEIGHT.request([-80.621, 28.6271, -80.6208, 28.6273], 258, 258);
    const earthUrl = new URL(earth.url);
    expect(earthUrl.hostname).toBe('elevation.nationalmap.gov');
    expect(earthUrl.searchParams.get('mosaicRule')).toContain('86037');
    expect(earthUrl.searchParams.get('pixelType')).toBe('F32');
    expect(earth.verticalDatum).toBe('NAVD88/GEOID18');
    expect(earth.engineDatum).toContain('EGM2008');
    const moon = MOON_LOLA_HEIGHT.request([-0.1, -0.1, 0.1, 0.1], 258, 258);
    expect(new URL(moon.url).hostname).toBe('trek.nasa.gov');
    expect(moon.verticalDatum).toContain('1737400');
    expect(() => KSC_3DEP_HEIGHT.request([-1, -1, 1, 1], 1024, 1024)).toThrow(/size/);
  });
});
