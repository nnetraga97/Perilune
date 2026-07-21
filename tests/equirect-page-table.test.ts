import { describe, expect, it } from 'vitest';
import { selectEquirectPages } from '../src/render/planetDetail/equirectPageTable';
import { EARTH_GIBS_DETAIL } from '../src/render/planetDetail/sourceRegistry';

describe('equirectangular detail page selection', () => {
  it('selects a complete 3x3 group around the camera-facing direction', () => {
    const selection = selectEquirectPages(EARTH_GIBS_DETAIL, 7, { x: 1, y: 0, z: 0 })!;
    expect(selection.gridWidth).toBe(3);
    expect(selection.gridHeight).toBe(3);
    expect(selection.centerColumn).toBe(80);
    expect(selection.centerRow).toBe(40);
    expect(selection.startColumn).toBe(79);
    expect(selection.startRow).toBe(39);
  });

  it('retains an unwrapped atlas start across the antimeridian', () => {
    const west = selectEquirectPages(EARTH_GIBS_DETAIL, 7, { x: -1, y: -1e-8, z: 0 })!;
    expect(west.centerColumn).toBe(0);
    expect(west.startColumn).toBe(-1);
    expect(EARTH_GIBS_DETAIL.address(7, west.startRow, west.startColumn).column).toBe(159);
  });

  it('clamps page rows at both poles', () => {
    expect(selectEquirectPages(EARTH_GIBS_DETAIL, 7, { x: 0, y: 0, z: 1 })!.startRow).toBe(0);
    expect(selectEquirectPages(EARTH_GIBS_DETAIL, 7, { x: 0, y: 0, z: -1 })!.startRow).toBe(77);
  });
});
