import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import oracles from '../assets/planets/classification/surface-class-oracles.json';
import {
  SurfaceClass,
  configureSurfaceClassTexture,
  surfaceClassOwnsOcean,
  surfaceClassPermitsEarthScatter,
} from '../src/render/terrestrial/surfaceClass';
import { sampleEarthSurfaceClass } from '../src/render/terrestrial/surfaceClassAuthority';
import { classifyNwiAttribute, overlayNwiGeoJson } from '../scripts/lib/surface-classification.mjs';

function direction(longitudeDegrees: number, latitudeDegrees: number): [number, number, number] {
  const longitude = THREE.MathUtils.degToRad(longitudeDegrees);
  const latitude = THREE.MathUtils.degToRad(latitudeDegrees);
  const cosLatitude = Math.cos(latitude);
  return [cosLatitude * Math.cos(longitude), cosLatitude * Math.sin(longitude), Math.sin(latitude)];
}

describe('categorical surface classification', () => {
  it('maps Cowardin systems without consulting height or color', () => {
    expect(classifyNwiAttribute('E1UBL')).toBe(SurfaceClass.EstuarineDeepwater);
    expect(classifyNwiAttribute('M1UBL')).toBe(SurfaceClass.OpenOcean);
    expect(classifyNwiAttribute('E2USM')).toBe(SurfaceClass.Intertidal);
    expect(classifyNwiAttribute('M2USP')).toBe(SurfaceClass.Intertidal);
    expect(classifyNwiAttribute('L1UBVh')).toBe(SurfaceClass.InlandWater);
    expect(classifyNwiAttribute('R2UBHx')).toBe(SurfaceClass.InlandWater);
    expect(classifyNwiAttribute('PSS1C')).toBe(SurfaceClass.Wetland);
  });

  it('resolves every stable checked KSC source oracle from the shipped CPU authority', () => {
    for (const point of oracles.points.filter((entry) => !entry.id.includes('fixture'))) {
      const value = sampleEarthSurfaceClass(...direction(point.longitude, point.latitude));
      expect(value, point.id).toBe(point.expectedCode);
    }
  });

  it('uses exact ocean and Earth-scatter ownership sets', () => {
    expect([0, 1, 2, 3, 4, 5, 6].filter(surfaceClassOwnsOcean)).toEqual([2, 3]);
    expect([0, 1, 2, 3, 4, 5, 6].filter(surfaceClassPermitsEarthScatter)).toEqual([1]);
  });

  it('forces nearest filtering and disables mip generation', () => {
    const texture = new THREE.Texture();
    configureSurfaceClassTexture(texture);
    expect(texture.minFilter).toBe(THREE.NearestFilter);
    expect(texture.magFilter).toBe(THREE.NearestFilter);
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.colorSpace).toBe(THREE.NoColorSpace);
  });

  it('rasterizes sample centers with smaller overlapping NWI features taking precedence', () => {
    const raster = { width: 4, height: 4, bounds: [0, 0, 4, 4] as [number, number, number, number], pixels: new Uint8Array(16) };
    const polygon = (attribute: string, acres: number, min: number, max: number, objectId: number) => ({
      type: 'Feature', properties: { attribute, acres, objectId },
      geometry: { type: 'Polygon', coordinates: [[[min, min], [max, min], [max, max], [min, max], [min, min]]] },
    });
    overlayNwiGeoJson(raster, {
      features: [polygon('E1UBL', 100, 0, 4, 1), polygon('PSS1C', 1, 1, 3, 2)],
    });
    expect([...raster.pixels]).toEqual([
      3, 3, 3, 3,
      3, 6, 6, 3,
      3, 6, 6, 3,
      3, 3, 3, 3,
    ]);
  });
});
