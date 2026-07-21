import { describe, expect, it } from 'vitest';
import { EARTH_GIBS_DETAIL, EARTH_KSC_NAIP_DETAIL, MOON_WAC_DETAIL } from '../src/render/planetDetail/sourceRegistry';

describe('checked planet visual-detail source adapters', () => {
  it('uses the official non-power-of-two GIBS EPSG:4326 matrix dimensions', () => {
    expect(EARTH_GIBS_DETAIL.matrix(0)).toEqual({ width: 2, height: 1 });
    expect(EARTH_GIBS_DETAIL.matrix(2)).toEqual({ width: 5, height: 3 });
    expect(EARTH_GIBS_DETAIL.matrix(7)).toEqual({ width: 160, height: 80 });
    expect(EARTH_GIBS_DETAIL.address(0, 0, 0).url).toBe(
      'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/0/0/0.jpeg',
    );
    expect(EARTH_GIBS_DETAIL.address(7, 5, -1).column).toBe(159);
  });

  it('constructs only same-origin, locked NAIP tile coordinates', () => {
    const address = EARTH_KSC_NAIP_DETAIL.address(18, 89381, 144731);
    expect(address.url).toContain('/api/planet-data?datasetId=usda-naip-ksc-2025-29992');
    expect(address.url).not.toContain('apps.geo.fpac.usda.gov');
    expect(address.cacheKey).toContain('OBJECTID-29992');
    expect(() => EARTH_KSC_NAIP_DETAIL.address(18, -1, 0)).toThrow();
  });

  it('uses Moon Trek 2:1 equirectangular matrices with locked WAC identity', () => {
    expect(MOON_WAC_DETAIL.matrix(0)).toEqual({ width: 2, height: 1 });
    expect(MOON_WAC_DETAIL.matrix(8)).toEqual({ width: 512, height: 256 });
    expect(MOON_WAC_DETAIL.address(8, 255, 511).url).toContain(
      '/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/8/255/511.jpg',
    );
  });

  it('rejects rows outside a declared source matrix', () => {
    expect(() => EARTH_GIBS_DETAIL.address(7, 80, 0)).toThrow(/invalid.*row/i);
    expect(() => MOON_WAC_DETAIL.address(9, 0, 0)).toThrow(/does not define level/i);
  });

  it('selects detail from projected texel footprint rather than altitude labels', () => {
    const radius = 6_378_137;
    expect(EARTH_GIBS_DETAIL.levelForProjectedFootprint(radius, 0, 20_000)).toBeLessThan(7);
    expect(EARTH_GIBS_DETAIL.levelForProjectedFootprint(radius, 0, 300)).toBe(7);
  });
});
